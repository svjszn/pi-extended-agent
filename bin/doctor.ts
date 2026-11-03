import { accessSync, constants, existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AGENT_PACKAGE } from "../lib/package.js";
import type { DoctorCheck, DoctorReport } from "../lib/doctor.js";
import { describeRuntime, cachedRuntime, compareVersions, PI_PACKAGE, readRuntimeState, runtimeDirectory, validVersion } from "./runtime.js";
import type { Runtime, RuntimeState } from "./runtime.js";

const MAX_JSON_BYTES = 256_000;
interface DoctorOptions {
  packageRoot: string;
  cwd: string;
  agentDir: string;
  runtimeDir?: string;
  nodeVersion?: string;
  home?: string;
  projectTrusted?: boolean;
  sessionChecks?: DoctorCheck[];
  runningEngineVersion?: string;
  signal?: AbortSignal;
}

/** Never follow JSON file links: a settings/pointer link must not read credentials. */
function checkJsonFile(file: string, optional = false) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES || basename(file).toLowerCase() === "auth.json") throw new Error("Unsupported diagnostic file");
    return true;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function readObject(file: string): Record<string, unknown> {
  checkJsonFile(file);
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid JSON object");
  return value as Record<string, unknown>;
}
function dependencyDirectory(root: string) {
  for (let directory = resolve(root); ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", PI_PACKAGE);
    if (existsSync(candidate)) return candidate;
    if (dirname(directory) === directory) throw new Error("Bundled dependency missing");
  }
}
function engineFiles(runtime: Runtime) {
  for (const file of ["dist/bundle/index.js", "dist/cli/setup.js"]) {
    if (!statSync(join(runtime.packageDir, file)).isFile()) throw new Error("Missing engine helper");
  }
  return runtime;
}
function safeLocation(file: string, home: string) {
  const location = resolve(file), rel = relative(resolve(home), location);
  const value = !rel ? "~" : rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? `~/${rel.split(sep).join("/")}` : location;
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function doctorAgentDir() {
  const directory = process.env.PI_CODING_AGENT_DIR;
  return directory ? resolve(directory.replace(/^~(?=$|[\\/])/, () => homedir())) : join(homedir(), ".pi", "agent");
}

/** Standalone, bounded filesystem checks. Deliberately imports no Pi SDK or provider. */
export function readDoctorReport(options: DoctorOptions): DoctorReport {
  const root = resolve(options.packageRoot), runtimeDir = resolve(options.runtimeDir ?? runtimeDirectory());
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck) => { options.signal?.throwIfAborted(); checks.push(check); };
  options.signal?.throwIfAborted();
  const source = existsSync(join(root, ".git"));
  const reinstall = source ? "Run npm ci --ignore-scripts and npm run build in the source checkout." : "Reinstall with npm install -g pi-extended-agent.";
  let manifest: Record<string, unknown> | undefined;
  try {
    manifest = readObject(join(root, "package.json"));
    if (manifest.name !== AGENT_PACKAGE || !validVersion(manifest.version)) throw new Error("Invalid wrapper manifest");
    add({ id: "agent.package", title: "Agent installation", status: "ok", message: `${AGENT_PACKAGE} ${manifest.version} (${source ? "source checkout" : "installed package"}).`,
      ...(source ? { action: "Update this checkout with git pull, npm ci --ignore-scripts, and npm run build. pi update preserves linked checkouts." } : {}) });
  } catch { add({ id: "agent.package", title: "Agent installation", status: "error", message: "The wrapper package manifest is missing, unreadable or invalid.", action: reinstall }); }
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeRequirement = (manifest?.engines as { node?: string } | undefined)?.node;
  const minimumNode = typeof nodeRequirement === "string" ? nodeRequirement.match(/^>=(\d+\.\d+\.\d+)$/)?.[1] ?? "22.19.0" : "22.19.0";
  const supportedNode = validVersion(nodeVersion) && compareVersions(nodeVersion, minimumNode) >= 0;
  add({ id: "node", title: "Node.js", status: supportedNode ? "ok" : "error",
    message: validVersion(nodeVersion) ? `v${nodeVersion}; requires ${minimumNode} or newer.` : "Could not determine a supported Node.js version.",
    ...(!supportedNode ? { action: `Install Node.js ${minimumNode} or newer, then restart your terminal.` } : {}) });
  if (manifest) {
    try {
      const extensions = (manifest.pi as { extensions?: unknown } | undefined)?.extensions;
      if (!Array.isArray(extensions) || !extensions.length || !extensions.every(file => typeof file === "string" && /^\.\/dist\/extensions\/[a-z0-9-]+\.js$/.test(file))) throw new Error("Invalid extension list");
      for (const file of ["bin/pi.mjs", "dist/bin/main.js", "dist/bin/doctor.js", "dist/bin/verify-runtime.js", ...extensions]) {
        if (!statSync(join(root, file)).isFile()) throw new Error("Missing production file");
      }
      add({ id: "agent.build", title: "Agent files", status: "ok", message: "Launcher, production extensions and runtime adapters are present." });
    } catch { add({ id: "agent.build", title: "Agent files", status: "error", message: "The build is incomplete or the production extension list is invalid.", action: reinstall }); }
  }
  let bundled: Runtime | undefined;
  try {
    const directory = dependencyDirectory(root); checkJsonFile(join(directory, "package.json"));
    bundled = engineFiles(describeRuntime(directory));
    add({ id: "engine.bundled", title: "Bundled Pi", status: "ok", message: `Pi ${bundled.version}; required engine files are present.` });
  } catch { add({ id: "engine.bundled", title: "Bundled Pi", status: "error", message: "The bundled engine is missing, incomplete or has invalid paths.", action: reinstall }); }
  let state: RuntimeState | undefined;
  try {
    checkJsonFile(join(runtimeDir, "active.json"), true);
    state = readRuntimeState(runtimeDir);
    add({ id: "engine.selection", title: "Engine selection", status: "ok", message: state.version ? `Managed Pi ${state.version} is selected.` : "Using the bundled engine; no managed override." });
  } catch { add({ id: "engine.selection", title: "Engine selection", status: "error", message: "active.json is invalid, unreadable, oversized or a file link.", action: "Inspect active.json in the runtime directory and restore a valid selection. No engine was activated." }); }
  if (state?.version) {
    let rollbackAvailable = false;
    try {
      if (state.previous) checkJsonFile(join(runtimeDir, "releases", state.previous, "node_modules", PI_PACKAGE, "package.json"));
      const previous = state.previous ? engineFiles(cachedRuntime(runtimeDir, state.previous)) : bundled;
      if (!previous) throw new Error("No recovery target");
      rollbackAvailable = true;
      add({ id: "engine.rollback", title: "Rollback files", status: "ok", message: `Pi ${previous.version} is available for rollback; activation still requires its compatibility check.` });
    } catch { add({ id: "engine.rollback", title: "Rollback files", status: "warn", message: "The previous engine is unavailable for rollback.", action: reinstall }); }
    try {
      checkJsonFile(join(runtimeDir, "releases", state.version, "node_modules", PI_PACKAGE, "package.json"));
      engineFiles(cachedRuntime(runtimeDir, state.version));
      add({ id: "engine.active", title: "Active engine files", status: "ok", message: `Managed Pi ${state.version}; required files are present. This is not a runtime compatibility test.` });
    } catch { add({ id: "engine.active", title: "Active engine files", status: "error", message: "The selected engine is missing, incomplete or has invalid paths.", action: rollbackAvailable ? "Run pi update --engine --rollback, then restart Pi." : "Restore an intact engine and valid active.json selection. " + reinstall }); }
  }
  if (options.runningEngineVersion) {
    const selected = state?.version ?? bundled?.version;
    const differs = selected && selected !== options.runningEngineVersion;
    add({ id: "engine.running", title: "Running session", status: differs ? "warn" : "ok",
      message: `This session uses Pi ${options.runningEngineVersion}.${differs ? ` Pi ${selected} is selected for the next launch.` : ""}`,
      ...(differs ? { action: "Restart Pi to use the selected engine." } : {}) });
  }
  if (existsSync(join(runtimeDir, "update.lock"))) add({ id: "engine.lock", title: "Engine updater", status: "warn", message: "An update lock is present; an updater may still be running.", action: "Wait for it to finish. Remove update.lock only after confirming no updater is running." });
  else add({ id: "engine.lock", title: "Engine updater", status: "ok", message: "No update lock is present." });
  try {
    if (!existsSync(options.agentDir)) add({ id: "profile", title: "Profile", status: "warn", message: "The profile directory has not been created yet. No directory was created by doctor." });
    else {
      if (!statSync(options.agentDir).isDirectory()) throw new Error("Not a directory");
      accessSync(options.agentDir, constants.R_OK | constants.W_OK);
      add({ id: "profile", title: "Profile", status: "ok", message: "The OS reports read/write access. No write was attempted." });
    }
  } catch { add({ id: "profile", title: "Profile", status: "error", message: "The profile path is not an accessible read/write directory.", action: "Check the selected profile directory and its filesystem permissions." }); }
  const settings = (file: string, id: string, title: string) => {
    try {
      if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
        add({ id, title, status: "warn", message: "Settings are a file link; content validation was skipped.", action: "Inspect the linked settings locally." }); return;
      }
      if (!checkJsonFile(file, true)) { add({ id, title, status: "ok", message: "No settings file; defaults apply." }); return; }
      readObject(file); add({ id, title, status: "ok", message: "Valid JSON object. Setting values were not included in the report." });
    } catch { add({ id, title, status: "error", message: "Settings are invalid, unreadable, oversized or a file link.", action: "Inspect the settings file locally; no settings were changed." }); }
  };
  settings(join(options.agentDir, "settings.json"), "settings.global", "Profile settings");
  if (options.projectTrusted) settings(join(options.cwd, ".pi", "settings.json"), "settings.project", "Project settings");
  checks.push(...options.sessionChecks ?? []);
  const summary = { ok: 0, warnings: 0, errors: 0 };
  for (const check of checks) summary[check.status === "ok" ? "ok" : check.status === "warn" ? "warnings" : "errors"]++;
  const home = options.home ?? homedir();
  return { schemaVersion: 1, platform: process.platform, architecture: process.arch,
    locations: { package: safeLocation(root, home), profile: safeLocation(options.agentDir, home), runtime: safeLocation(runtimeDir, home) }, checks, summary };
}
