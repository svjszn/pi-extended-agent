import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export interface Runtime {
  version: string;
  packageDir: string;
  entry: string;
  cli: string;
}
export interface RuntimeState { version: string | null; previous: string | null }

export function validVersion(version: unknown): version is string {
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}
export function runtimeDirectory() {
  return resolve(process.env.PI_EXTENDED_RUNTIME_DIR || join(homedir(), ".pi", "pi-extended-agent"));
}
export function describeRuntime(packageDir: string): Runtime {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (manifest.name !== PI_PACKAGE || !validVersion(manifest.version)) throw new Error("Invalid Pi runtime package.");
  const entry = resolve(packageDir, manifest.main);
  const cli = resolve(packageDir, manifest.bin.pi);
  if (!existsSync(entry) || !existsSync(cli)) throw new Error(`Pi ${manifest.version} is incomplete.`);
  return { version: manifest.version, packageDir, entry, cli };
}
export function bundledRuntime() {
  return describeRuntime(resolve(dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE))), ".."));
}
export function readRuntimeState(directory: string): RuntimeState {
  const file = join(directory, "active.json");
  if (!existsSync(file)) return { version: null, previous: null };
  const state = JSON.parse(readFileSync(file, "utf8"));
  if ((state.version !== null && !validVersion(state.version)) || (state.previous != null && !validVersion(state.previous))) {
    throw new Error("Invalid runtime state. Inspect active.json in the managed runtime directory.");
  }
  return { version: state.version, previous: state.previous ?? null };
}
export function releaseDirectory(directory: string, version: string) {
  if (!validVersion(version)) throw new Error(`Invalid Pi version: ${version}`);
  return join(directory, "releases", version);
}
export function cachedRuntime(directory: string, version: string) {
  const runtime = describeRuntime(join(releaseDirectory(directory, version), "node_modules", PI_PACKAGE));
  if (runtime.version !== version) throw new Error("Cached Pi version does not match its release directory.");
  return runtime;
}
export function selectedRuntime(directory = runtimeDirectory()) {
  const state = readRuntimeState(directory);
  return state.version === null ? bundledRuntime() : cachedRuntime(directory, state.version);
}
export function writeRuntimeState(directory: string, state: RuntimeState) {
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `active.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, join(directory, "active.json"));
}
export function compareVersions(left: string, right: string) {
  const [a, apre] = left.split("-");
  const [b, bpre] = right.split("-");
  for (let i = 0; i < 3; i++) {
    const diff = Number(a.split(".")[i]) - Number(b.split(".")[i]);
    if (diff) return diff;
  }
  if (!apre || !bpre) return apre === bpre ? 0 : apre ? -1 : 1;
  return apre.localeCompare(bpre, undefined, { numeric: true });
}
export function cachedVersions(directory: string) {
  const releases = join(directory, "releases");
  if (!existsSync(releases)) return [];
  return readdirSync(releases).filter((version) => {
    if (!validVersion(version)) return false;
    try { cachedRuntime(directory, version); return true; } catch { return false; }
  }).sort(compareVersions);
}
