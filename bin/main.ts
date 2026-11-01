#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { planUpdate, updateEngine, updateHelp } from "./update.js";
import { selectedRuntime } from "./runtime.js";
import { errorMessage } from "../lib/errors.js";
import { AGENT_VERSION } from "../lib/package.js";

let args = process.argv.slice(2);
// Upstream release notices point to its global self-updater. This distribution
// owns its Pi dependency and handles updates through its own entry point.
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_EXTENDED_AGENT_VERSION = AGENT_VERSION;
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
await import(pathToFileURL(runtime.cli).href);
