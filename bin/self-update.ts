import { closeSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { AGENT_PACKAGE } from "../lib/package.js";
import { compareVersions, validVersion } from "./runtime.js";
import { captureCommand, latestPackageVersion, npmCliPath } from "./update.js";
import { hasErrorCode } from "../lib/errors.js";

interface SelfUpdateServices {
  log?: (message: string) => void;
  latest?: () => Promise<string>;
  globalRoot?: () => Promise<string>;
  install?: (version: string, prefix: string) => Promise<void>;
}

export async function installAgent(version: string, prefix: string) {
  if (!validVersion(version)) throw new Error("Invalid target agent version.");
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, [npmCliPath(), "install", "--global", "--prefix", prefix,
      "--ignore-scripts", "--no-audit", "--no-fund", `${AGENT_PACKAGE}@${version}`], { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? accept() : reject(new Error(`npm installation failed (exit ${code}).`)));
  });
}

/** Update only the global installation that owns this running launcher. */
export async function updateAgent(packageRoot: string, options: { checkOnly?: boolean } = {}, services: SelfUpdateServices = {}) {
  const log = services.log ?? console.log;
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== AGENT_PACKAGE || !validVersion(manifest.version)) throw new Error("Invalid agent package.");
  log(`Pi Extended Agent ${manifest.version}`);
  if (process.env.PI_OFFLINE !== undefined) { log("Offline mode: agent updates require access to npm."); return; }
  const target = await (services.latest ?? (() => latestPackageVersion(AGENT_PACKAGE)))();
  if (!validVersion(target)) throw new Error("Invalid target agent version.");
  log(`Latest Pi Extended Agent: ${target}`);
  if (options.checkOnly) return;
  if (compareVersions(target, manifest.version) <= 0) { log("Pi Extended Agent is up to date."); return; }
  const globalRoot = resolve(await (services.globalRoot ?? (async () => {
    const result = await captureCommand(process.execPath, [npmCliPath(), "root", "--global"], { timeout: 15_000, windowsHide: true });
    return result.stdout.trim();
  }))());
  const installed = join(globalRoot, AGENT_PACKAGE);
  // Real paths alone cannot distinguish a global npm link from a real install.
  let ownsGlobalCommand = false;
  try { ownsGlobalCommand = !lstatSync(installed).isSymbolicLink() && realpathSync(installed) === realpathSync(packageRoot); } catch { /* Local checkout or a different npm prefix. */ }
  if (!ownsGlobalCommand) throw new Error("This agent is running from a source checkout, npm link, or another npm prefix. Update that checkout with git pull, npm ci --ignore-scripts, and npm run build; or update its original npm installation. No global package was changed.");
  const prefix = process.platform === "win32" ? dirname(globalRoot) : dirname(dirname(globalRoot));
  const lock = join(globalRoot, ".pi-extended-agent-update.lock");
  let handle: number;
  try { handle = openSync(lock, "wx"); }
  catch (error) {
    if (hasErrorCode(error, "EEXIST")) throw new Error(`An agent update is already locked. If no updater is running, remove ${lock} and retry.`);
    throw error;
  }
  try {
    log(`Updating ${AGENT_PACKAGE}: ${manifest.version} → ${target}…`);
    await (services.install ?? installAgent)(target, prefix);
    const updated = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    if (updated.name !== AGENT_PACKAGE || updated.version !== target) throw new Error("npm did not install the requested agent version. Check your global npm installation.");
    log(`Pi Extended Agent updated to ${target}. Restart pi to use it.`);
  } finally {
    closeSync(handle);
    unlinkSync(lock);
  }
}
