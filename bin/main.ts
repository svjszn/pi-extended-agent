#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { planUpdate, updateEngine, updateHelp } from "./update.js";
import { selectedRuntime } from "./runtime.js";
import { errorMessage } from "../lib/errors.js";
import { AGENT_VERSION } from "../lib/package.js";

let args = process.argv.slice(2);
// Upstream release notices point to its global self-updater. This distribution
// owns its Pi dependency and handles updates through its own entry point.
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_EXTENDED_AGENT_VERSION = AGENT_VERSION;
if (args[0] === "doctor") {
  if (args.length > 2 || (args[1] && !["--json", "--help", "-h"].includes(args[1]))) {
    console.error("Use pi doctor [--json]."); process.exit(2);
  }
  if (args[1] === "--help" || args[1] === "-h") {
    console.log("Usage: pi doctor [--json]\nCheck this installation locally without loading the selected engine or reading credentials.\nExit status: 0 for OK/warnings, 1 for errors, 2 for invalid arguments."); process.exit(0);
  }
  const [{ readDoctorReport, doctorAgentDir }, { doctorText }] = await Promise.all([import("./doctor.js"), import("../lib/doctor.js")]);
  const report = readDoctorReport({ packageRoot: fileURLToPath(new URL("../../", import.meta.url)), cwd: process.cwd(), agentDir: doctorAgentDir() });
  console.log(args[1] === "--json" ? JSON.stringify(report, null, 2) : doctorText(report).join("\n"));
  process.exit(report.summary.errors ? 1 : 0);
}
if (args.length === 1 && args[0] === "--version") {
  console.log(`Pi Extended Agent ${AGENT_VERSION}\nPi Coding Agent ${selectedRuntime().version}`);
  process.exit(0);
}
try {
  const update = planUpdate(args);
  if (update.type === "help") {
    console.log(updateHelp);
    process.exit(0);
  }
  if (update.type === "package") {
    const { updateAgent } = await import("./self-update.js");
    await updateAgent(fileURLToPath(new URL("../../", import.meta.url)), update);
    process.exit(0);
  }
  if (update.type === "engine") {
    await updateEngine(fileURLToPath(new URL("../../", import.meta.url)), update);
    if (!update.extensionArgs) process.exit(0);
    args = update.extensionArgs;
    process.argv = [...process.argv.slice(0, 2), ...args];
  }
} catch (error) {
  console.error(`Update failed: ${errorMessage(error)}`);
  process.exit(1);
}
const managementCommands = new Set(["auth", "install", "remove", "uninstall", "update", "list", "config", "mcp"]);
const separator = args.indexOf("--");
const options = separator === -1 ? args : args.slice(0, separator);
if (!managementCommands.has(args[0]) && !options.includes("--no-extensions") && !options.includes("-ne")) {
  if (!["--tui-mode", "--print", "-p", "--mode"].some((flag) => options.includes(flag))) {
    process.argv.splice(2, 0, "--tui-mode", "fullscreen");
  }
  // Resolve from this package, so extensions load from any working directory.
  process.argv.splice(2, 0, "--extension", fileURLToPath(new URL("../../", import.meta.url)));
}

// Keep upstream configuration, auth, session handling, and agent loop.
const runtime = selectedRuntime();
process.env.PI_EXTENDED_PI_VERSION = runtime.version;
const { prepareRuntimeCommands } = await import("./command-policy.js");
await prepareRuntimeCommands(runtime);
const { bindCompiledExtensionImports } = await import("./extension-runtime.js");
bindCompiledExtensionImports(runtime);
const { runtimeCli } = await import("./runtime-cli.js");
await (await runtimeCli(runtime)).run(process.argv.slice(2));
