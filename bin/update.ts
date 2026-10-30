import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, unlinkSync, writeFileSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import {
  PI_PACKAGE, validVersion, runtimeDirectory, bundledRuntime, cachedRuntime,
  cachedVersions, compareVersions, readRuntimeState, releaseDirectory, writeRuntimeState,
} from "./runtime.js";
import { verifyRuntime } from "./verify-runtime.js";
import type { Runtime } from "./runtime.js";
import type { SpawnOptions } from "node:child_process";
import { errorMessage, hasErrorCode } from "../lib/errors.js";

export interface UpdateOptions {
  version?: string;
  rollback?: boolean;
  checkOnly?: boolean;
  offline?: boolean;
  extensionArgs?: string[];
}
export type UpdatePlan = { type: "upstream"; args: string[] } | { type: "help" }
  | { type: "package"; checkOnly: boolean }
  | ({ type: "engine" } & UpdateOptions);
interface UpdateServices {
  directory?: string;
  log?: (message: string) => void;
  install?: typeof installEngine;
  verify?: (runtime: Runtime, packageRoot: string) => Promise<void>;
  latest?: () => Promise<string>;
}
type CommandRunner = (executable: string, args: string[], options: SpawnOptions) => Promise<{ stdout: string }>;
type CommandError = Error & { killed?: boolean; stderr?: string };

export function planUpdate(args: string[]): UpdatePlan {
  if (args[0] !== "update") return { type: "upstream", args };
  const rest = args.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) return { type: "help" };
  const packageOptions = new Set(["self", "--self", "--check"]);
  if (rest.every((arg) => packageOptions.has(arg))) return { type: "package", checkOnly: rest.includes("--check") };
  if (rest.includes("self") || rest.includes("--self")) throw new Error("Use pi update [--check] for the agent, or pi update --engine for the Pi engine.");
  const selectors = rest.filter((_arg, i) => !["--extension", "--to"].includes(rest[i - 1]));
  const self = selectors.some((arg) => ["pi", "--engine", "--all", "--to", "--rollback", "--check"].includes(arg));
  const resource = selectors.some((arg) => ["--models", "--extensions", "--extension"].includes(arg)
    || (!arg.startsWith("-") && arg !== "pi"));
  if (resource && !self) return { type: "upstream", args };
  let version;
  const allowed = new Set(["pi", "--engine", "--all", "--extensions", "--offline", "--rollback", "--check", "--approve", "-a", "--no-approve", "-na"]);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--to") {
      if (version || !validVersion(rest[i + 1])) throw new Error("--to requires one exact Pi version, e.g. 1.4.0.");
      version = rest[++i];
    } else if (!allowed.has(rest[i])) throw new Error(`Unsupported update option: ${rest[i]}. Use pi update --help.`);
  }
  const all = rest.includes("--all") || rest.includes("--extensions");
  const rollback = rest.includes("--rollback"), checkOnly = rest.includes("--check");
  if (rollback && (version || all || checkOnly)) throw new Error("--rollback cannot be combined with --to, --all, --extensions, or --check.");
  const trust = rest.filter((arg) => ["--approve", "-a", "--no-approve", "-na"].includes(arg));
  return { type: "engine", version, rollback, checkOnly, offline: rest.includes("--offline"),
    extensionArgs: all && !checkOnly ? ["update", "--extensions", ...trust] : undefined };
}

export const updateHelp = `Update Pi Extended Agent or its managed Pi engine.

  pi update                 Update pi-extended-agent through npm
  pi update --check         Show the installed and latest agent versions
  pi update --engine        Install the latest compatible Pi engine
  pi update --engine --check
                            Show the active and latest engine versions
  pi update --to VERSION    Install an exact engine version
  pi update --offline       Use the newest complete engine cached on this computer
  pi update --rollback      Restore the previous engine (or the bundled version)
  pi update --all           Update the engine, then configured extension packages
  pi update --models        Refresh model catalogs through Pi
  pi update --extensions    Update extension packages through Pi
  pi update --extension SOURCE
                            Update one extension package through Pi

The global pi command stays owned by pi-extended-agent. Git is not required.
The new engine is activated only after compatibility checks pass.
Linked source checkouts are never replaced by a global package update.`;

export function npmCliPath() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")];
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    candidates.push(join(directory, "node_modules/npm/bin/npm-cli.js"));
    const executable = join(directory, "npm");
    try { candidates.push(realpathSync(executable)); } catch { /* Not an npm executable directory. */ }
  }
  const cli = candidates.find((file) => file && file.endsWith("npm-cli.js") && existsSync(file));
  if (!cli) throw new Error("Could not locate npm-cli.js. Install Node.js with npm and retry.");
  return cli;
}

export async function installEngine(version: string, directory: string, { offline = false }: { offline?: boolean } = {}) {
  const prefix = releaseDirectory(directory, version);
  mkdirSync(prefix, { recursive: true });
  if (!existsSync(join(prefix, "package.json"))) {
    writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "pi-extended-runtime", private: true }));
  }
  const args = [npmCliPath(), "install", "--prefix", prefix, "--global=false", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"];
  if (offline) args.push("--offline");
  args.push(`${PI_PACKAGE}@${version}`);
  await new Promise<void>((resolve, reject) => {
    // Invoke npm through Node, with no shell interpolation of paths or arguments.
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", (error) => reject(new Error(`Could not start npm: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`npm installation failed (exit ${code}).`)));
  });
}

export const captureCommand: CommandRunner = async (executable, args, options) => {
  // Files also work in Windows environments that restrict child-process pipes.
  const directory = mkdtempSync(join(tmpdir(), "pi-version-"));
  const output = join(directory, "stdout"), errors = join(directory, "stderr");
  const handles: number[] = [];
  try {
    handles.push(openSync(output, "w"));
    handles.push(openSync(errors, "w"));
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, args, { ...options, stdio: ["ignore", ...handles] });
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve() : reject(Object.assign(
          new Error(`npm exited with code ${code}.`), { killed: child.killed },
        )));
      });
    } catch (error) {
      const failure: CommandError = error instanceof Error ? error : new Error(String(error));
      failure.stderr = readFileSync(errors, "utf8");
      throw failure;
    }
    return { stdout: readFileSync(output, "utf8") };
  } finally {
    for (const handle of handles) closeSync(handle);
    for (const file of [output, errors]) if (existsSync(file)) unlinkSync(file);
    rmdirSync(directory);
  }
}

export async function latestPackageVersion(packageName: string, run: CommandRunner = captureCommand, options: { signal?: AbortSignal; background?: boolean } = {}) {
  let stdout;
  try {
    // Use the same registry, proxy, and certificate settings as installation.
    // A slow or unreachable pi.dev website must not block npm engine updates.
    ({ stdout } = await run(process.execPath, [npmCliPath(), "view", `${packageName}@latest`, "version", "--json", "--prefer-online",
      `--fetch-retries=${options.background ? 0 : 1}`, "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=2000",
      `--fetch-timeout=${options.background ? 5000 : 30000}`], {
      timeout: options.background ? 6000 : 75_000, windowsHide: true, signal: options.signal,
    }));
  } catch (error) {
    const failure = error as CommandError;
    const reason = failure.killed ? "npm timed out" : failure.stderr?.trim() || errorMessage(error);
    throw new Error(`Could not check the latest ${packageName} release through npm: ${reason}.${packageName === PI_PACKAGE ? " Retry pi update --engine, or use pi update --to VERSION to skip the version lookup." : " Retry pi update later."}`);
  }
  let version;
  try { version = JSON.parse(stdout); } catch { /* Report invalid metadata below. */ }
  if (!validVersion(version)) throw new Error(`npm returned an invalid ${packageName === PI_PACKAGE ? "Pi" : "agent"} version. No update was activated.`);
  return version;
}

export const latestVersion = (run?: CommandRunner, options?: { signal?: AbortSignal; background?: boolean }) => latestPackageVersion(PI_PACKAGE, run, options);

export async function updateEngine(packageRoot: string, options: UpdateOptions = {}, services: UpdateServices = {}) {
  const directory = services.directory || runtimeDirectory();
  const log = services.log || console.log;
  const install = services.install || installEngine;
  const verify = services.verify || verifyRuntime;
  const getLatest = services.latest || latestVersion;
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, "update.lock");
  let descriptor;
  try { descriptor = openSync(lock, "wx"); }
  catch (error) {
    if (hasErrorCode(error, "EEXIST")) throw new Error(`An engine update is already locked. If no updater is running, remove ${lock} and retry.`);
    throw error;
  }
  try {
    const state = readRuntimeState(directory);
    const current = state.version ? cachedRuntime(directory, state.version) : bundledRuntime();
    log(`pi-extended-agent — active Pi ${current.version}`);
    if (options.rollback) {
      if (state.version === null) { log("The bundled Pi is already active."); return; }
      const previous = state.previous ? cachedRuntime(directory, state.previous) : bundledRuntime();
      await verify(previous, packageRoot);
      writeRuntimeState(directory, { version: state.previous, previous: state.version });
      log(`Restored Pi ${previous.version}. Restart pi to use it.`);
      return;
    }
    const offline = options.offline || Boolean(process.env.PI_OFFLINE);
    let target = options.version;
    if (!target && offline) {
      target = [...cachedVersions(directory), current.version].sort(compareVersions).at(-1);
    }
    if (!target) {
      log("Checking the latest Pi release in npm…");
      target = await getLatest();
    }
    if (!validVersion(target)) throw new Error("Invalid target engine version.");
    if (options.checkOnly) { log(`${offline ? "Newest cached" : "Latest"} Pi: ${target}`); return; }
    if (target === current.version) { log(`The managed Pi engine is up to date (v${current.version}).`); return; }
    let candidate;
    try { candidate = cachedRuntime(directory, target); } catch { /* Install an absent or incomplete release below. */ }
    if (!candidate) {
      log(`Installing Pi ${target} into the managed runtime…`);
      await install(target, directory, { offline });
      candidate = cachedRuntime(directory, target);
    }
    log(`Checking Pi ${target} with this agent's extensions and interface…`);
    await verify(candidate, packageRoot);
    writeRuntimeState(directory, { version: target, previous: state.version });
    log(`Pi updated: ${current.version} → ${target}. Restart pi to use it.`);
  } catch (error) {
    throw new Error(`${errorMessage(error)} The active engine was not changed.`);
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}
