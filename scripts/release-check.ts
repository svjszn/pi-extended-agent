import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { captureCommand } from "./capture-command.ts";
import { assertPackageFiles } from "./artifact-policy.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.npm_execpath;
if (!npm || !existsSync(npm)) throw new Error("Run this check with npm run release:check.");
interface RunOptions { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; accepted?: number[]; timeout?: number }
function run(executable: string, args: string[], options: RunOptions & { capture: true }): SpawnSyncReturns<string>;
function run(executable: string, args: string[], options?: RunOptions): SpawnSyncReturns<string | Buffer>;
function run(executable: string, args: string[], { cwd = root, env = process.env, capture = false, accepted = [0], timeout = 300_000 }: RunOptions = {}): SpawnSyncReturns<string | Buffer> {
  const result = capture
    ? captureCommand(executable, args, { cwd, env, encoding: "utf8", timeout, windowsHide: true })
    : spawnSync(executable, args, { cwd, env, timeout, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status === null || !accepted.includes(result.status)) throw new Error(`${executable} exited with ${result.status}. ${result.stderr ?? ""}`);
  return result;
}
function npmRun(args: string[], options: RunOptions & { capture: true }): SpawnSyncReturns<string>;
function npmRun(args: string[], options?: RunOptions): SpawnSyncReturns<string | Buffer>;
function npmRun(args: string[], options?: RunOptions): SpawnSyncReturns<string | Buffer> {
  return run(process.execPath, [npm!, ...args], options);
}

console.log("Checking types and tests...");
npmRun(["run", "check"]);
npmRun(["test"]);
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
assert.equal(manifest.private, undefined, "The release package is still private.");
assert.equal(manifest.version, lock.version); assert.equal(manifest.version, lock.packages[""].version);
assert.equal(manifest.license, lock.packages[""].license, "Package license metadata differs from the lockfile.");
const releases = join(root, ".local", "releases"); mkdirSync(releases, { recursive: true });
const [packed] = JSON.parse(npmRun(["pack", "--ignore-scripts", "--json", "--pack-destination", releases], { capture: true }).stdout);
const files = packed.files.map((file: { path: string }) => file.path);
assertPackageFiles(files, manifest);
const archive = join(releases, packed.filename);
const temp = mkdtempSync(join(root, ".local", "release-check-"));
let passed = false;
try {
  const prefix = join(temp, "prefix");
  console.log("Installing the packed artifact into an isolated global prefix...");
  npmRun(["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline",
    "--fetch-timeout=30000", "--fetch-retries=1", archive]);
  const installed = process.platform === "win32" ? join(prefix, "node_modules", manifest.name) : join(prefix, "lib", "node_modules", manifest.name);
  assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version, manifest.version);
  assert.equal(existsSync(join(installed, "test")), false);
  const project = join(temp, "project"); mkdirSync(project);
  const env = { ...process.env, PI_CODING_AGENT_DIR: join(temp, "profile"), PI_EXTENDED_RUNTIME_DIR: join(temp, "runtime"), PI_OFFLINE: "1" };
  const shim = process.platform === "win32" ? join(prefix, "pi.cmd") : join(prefix, "bin", "pi");
  assert.ok(existsSync(shim), "npm did not create the global pi command.");
  const quotePowerShell = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const launch = (args: string[]) => process.platform === "win32"
    ? run(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", `& ${[shim, ...args].map(quotePowerShell).join(" ")}\nexit $LASTEXITCODE`], { cwd: project, env, capture: true })
    : run(shim, args, { cwd: project, env, capture: true });
  const versionOutput = launch(["--version"]).stdout;
  assert.ok(versionOutput.includes(`Pi Extended Agent ${manifest.version}`));
  assert.match(versionOutput, /Pi Coding Agent 1\.4\.0/);
  assert.match(launch(["--help"]).stdout, /Usage|Options|coding agent/i);
  const auth = run(process.execPath, [join(installed, "bin", "pi.mjs"), "auth", "check", "--provider", "openai-codex", "--no-refresh", "--json"],
    { cwd: project, env, capture: true, accepted: [0, 1, 2] });
  assert.equal(JSON.parse(auth.stdout).status, "not_ready", "An empty profile unexpectedly has credentials.");
  console.log("Checking installed extensions, permissions, memory, plans, and session resume...");
  run(process.execPath, [join(root, "scripts", "package-smoke.ts"), installed, temp], { cwd: project, env });
  console.log("Opening installed command views cold and after reload, without network access...");
  run(process.execPath, [join(root, "test", "command-loading.test.ts"), "--probe", installed, project], { cwd: project, env });
  run(process.execPath, [join(root, "test", "command-loading.test.ts"), "--probe", installed, project, "fail"], { cwd: project, env });
  passed = true;
  console.log(`Release checks passed. Artifact: ${archive}`);
} finally {
  if (passed) {
    const rel = relative(join(root, ".local"), resolve(temp));
    assert.ok(rel.startsWith("release-check-") && !rel.includes(sep) && !rel.startsWith(".."));
    rmSync(temp, { recursive: true, force: true });
  } else console.error(`Failed check files retained at ${temp}`);
}
