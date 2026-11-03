import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startWebServer } from "./web-server.js";
import { AGENT_VERSION } from "../lib/package.js";

export const uiHelp = "Usage: pi ui [--port 0..65535] [--no-open]\nOpen a local chat dashboard in your browser. Uses the active Pi profile.\nThe server runs on 127.0.0.1 until you press Ctrl+C. --no-open prints the URL without launching a browser.";
export function parseUiArgs(args: string[]) {
  let port = 0, open = true, help = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") help = true;
    else if (args[i] === "--no-open") open = false;
    else if (args[i] === "--port" && /^\d{1,5}$/.test(args[i + 1] ?? "")) { port = Number(args[++i]); if (port > 65535) throw new Error(uiHelp); }
    else throw new Error(uiHelp);
  }
  return { port, open, help };
}
export function openDashboard(url: string): Promise<void> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#[-_A-Za-z0-9]+$/.test(url)) return Promise.reject(new Error("Invalid local dashboard URL."));
  const [executable, args] = process.platform === "win32"
    ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url]] as const
    : process.platform === "darwin" ? ["open", [url]] as const : ["xdg-open", [url]] as const;
  return new Promise<void>((accept, reject) => {
    const child = spawn(executable, [...args], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.unref(); reject(new Error("Open the printed URL in your browser.")); }, 5000); timer.unref();
    child.once("error", () => { clearTimeout(timer); reject(new Error("Open the printed URL in your browser.")); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error("Open the printed URL in your browser.")); });
  });
}
export async function runUi(args: string[]) {
  let parsed;
  try { parsed = parseUiArgs(args); } catch (error) { console.error(error instanceof Error ? error.message : uiHelp); process.exitCode = 2; return; }
  if (parsed.help) { console.log(uiHelp); return; }
  const expand = (path: string) => resolve(path.replace(/^~(?=$|[\\/])/, () => homedir()));
  const agentDir = process.env.PI_CODING_AGENT_DIR ? expand(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
  try {
    const server = await startWebServer({ cwd: process.cwd(), agentDir, version: AGENT_VERSION, port: parsed.port,
      sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR ? expand(process.env.PI_CODING_AGENT_SESSION_DIR) : undefined,
      launcher: fileURLToPath(new URL("../../bin/pi.mjs", import.meta.url)) });
    console.log(`Pi UI\n${server.url}\nPress Ctrl+C to stop the dashboard.`);
    let stopped!: () => void;
    const completion = new Promise<void>(accept => { stopped = accept; });
    const shutdown = () => {
      process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown);
      void server.close().then(stopped, () => { process.exitCode = 1; stopped(); });
    };
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    if (parsed.open) await openDashboard(server.url).catch(error => console.error(error.message));
    await completion;
  } catch (error) { console.error(`Pi UI could not start: ${error instanceof Error ? error.message : "unknown error"}`); process.exitCode = 1; }
}
