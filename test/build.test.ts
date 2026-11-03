import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, outputFiles } from "../scripts/build.ts";
import { assertPackageFiles, assertProductionOutput, productionExtensions } from "../scripts/artifact-policy.ts";
import { captureCommand } from "../scripts/capture-command.ts";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const repository = fileURLToPath(new URL("../", import.meta.url));
const manifest = { type: "module", pi: { extensions: ["./dist/extensions/current.js"] } };
function fixture(t: TestContext) {
  const base = join(repository, ".local/build-tests"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "case-"));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(base) + sep)); rmSync(root, { recursive: true, force: true }); });
  const write = (name: string, text: string|NodeJS.ArrayBufferView<ArrayBufferLike>) => { mkdirSync(join(root, name, ".."), { recursive: true }); writeFileSync(join(root, name), text); };
  write("package.json", JSON.stringify(manifest));
  write("tsconfig.json", JSON.stringify({ compilerOptions: {
    target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", rootDir: ".", outDir: "dist",
    types: [], strict: true, noEmitOnError: true, skipLibCheck: true, sourceMap: true,
  }, include: ["bin/**/*.ts", "extensions/**/*.ts", "lib/**/*.ts"] }));
  write("extensions/current.ts", "export default function current() {}\n");
  write("bin/main.ts", "export const current = true;\n");
  write("bin/pi.ts", "#!/usr/bin/env node\nconst entry: URL = new URL('../dist/bin/main.js', import.meta.url);\nawait import(entry.href);\n");
  const run: import("../scripts/build.ts").BuildRunner = (executable, args, options) => captureCommand(executable, args, { ...options, encoding: "utf8" });
  return { root, write, compile: (options = {}) => build({ root, run, ...options }) };
}

test("clean builds remove deleted source output and retired diagnostics, including source maps", (t) => {
  const f = fixture(t);
  f.write("lib/retired.ts", "export const old = true;\n"); f.compile();
  assert.ok(existsSync(join(f.root, "dist/lib/retired.js")));
  rmSync(join(f.root, "lib/retired.ts"));
  f.write("dist/extensions/performance.js", "throw new Error('retired');\n");
  f.write("dist/extensions/performance.js.map", "{}"); f.write("dist/lib/performance.js", "export {};\n");
  f.compile();
  for (const name of ["lib/retired.js", "lib/retired.js.map", "extensions/performance.js", "extensions/performance.js.map", "lib/performance.js"]) {
    assert.equal(existsSync(join(f.root, "dist", name)), false, name);
  }
  assert.ok(existsSync(join(f.root, "dist/extensions/current.js")));
  assertProductionOutput(outputFiles(f.root), manifest);
});

test("the TypeScript launcher builds at the stable npm path and runs without type stripping", (t) => {
  const f = fixture(t); f.compile();
  const launcher = readFileSync(join(f.root, "bin/pi.mjs"), "utf8");
  assert.ok(launcher.startsWith("#!/usr/bin/env node\n"));
  assert.equal(launcher.includes(": URL"), false);
  const result = captureCommand(process.execPath, ["--no-experimental-strip-types", join(f.root, "bin/pi.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("command capture preserves buffer and text output, including failed commands", () => {
  const args = ["-e", "process.stdout.write('captured'); process.stderr.write('failure'); process.exitCode = 3;"];
  const raw = captureCommand(process.execPath, args);
  assert.equal(raw.status, 3);
  assert.ok(Buffer.isBuffer(raw.stdout));
  assert.ok(Buffer.isBuffer(raw.stderr));
  assert.equal(raw.stdout.toString(), "captured");
  assert.equal(raw.stderr.toString(), "failure");
  const text = captureCommand(process.execPath, args, { encoding: "utf8" });
  assert.equal(text.status, 3);
  assert.equal(text.stdout, "captured");
  assert.equal(text.stderr, "failure");
});

test("a failed compiler cannot leave a previous runnable build", (t) => {
  const f = fixture(t); f.compile();
  f.write("bin/main.ts", "export const invalid: string = 42;\n");
  assert.throws(() => f.compile(), /TypeScript build failed/);
  assert.equal(existsSync(join(f.root, "dist")), false);
});

test("a newly compiled but unlisted extension fails the build and removes its output", (t) => {
  const f = fixture(t); f.write("extensions/unreviewed.ts", "export default function debug() {}\n");
  assert.throws(() => f.compile(), /Unexpected production extension/);
  assert.equal(existsSync(join(f.root, "dist")), false);
});

test("development diagnostics build outside dist without modifying production files", (t) => {
  const f = fixture(t); f.compile();
  const before = readFileSync(join(f.root, "dist/bin/main.js"), "utf8");
  f.write("tsconfig.dev.json", JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { outDir: ".local/dev-dist" }, include: ["dev/**/*.ts"] }));
  f.write("dev/performance/extension.ts", "export default function diagnostic() {}\n");
  f.compile({ development: true });
  assert.ok(existsSync(join(f.root, ".local/dev-dist/dev/performance/extension.js")));
  assert.equal(readFileSync(join(f.root, "dist/bin/main.js"), "utf8"), before);
  assert.equal(existsSync(join(f.root, "dist/dev")), false);
});

test("build cleanup refuses redirected output directories", (t) => {
  const f = fixture(t), outside = fixture(t);
  outside.write("keep.txt", "must survive");
  try { symlinkSync(outside.root, join(f.root, "dist"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Symlink creation is unavailable"); return; } throw error; }
  assert.throws(() => f.compile(), /Refusing redirected/);
  assert.equal(readFileSync(join(outside.root, "keep.txt"), "utf8"), "must survive");
});

test("launcher generation refuses a redirected bin directory", (t) => {
  const f = fixture(t), outside = fixture(t);
  outside.write("pi.mjs", "must survive");
  renameSync(join(f.root, "bin"), join(f.root, "saved-bin"));
  try { symlinkSync(outside.root, join(f.root, "bin"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Symlink creation is unavailable"); return; } throw error; }
  assert.throws(() => f.compile(), /Refusing redirected build output: bin/);
  assert.equal(readFileSync(join(outside.root, "pi.mjs"), "utf8"), "must survive");
});

test("artifact policy requires an explicit extension list and rejects stale or development files", () => {
  for (const entry of ["./dist/extensions", "./dist/extensions/*.js", "../outside.js"]) {
    assert.throws(() => productionExtensions({ pi: { extensions: [entry] } }), /explicit/);
  }
  assert.throws(() => productionExtensions({ pi: { extensions: [manifest.pi.extensions[0], manifest.pi.extensions[0]] } }), /Duplicate/);
  const files = ["bin/pi.mjs", "dist/bin/main.js", "dist/bin/verify-runtime.js", "dist/extensions/current.js", "dist/extensions/current.js.map", "README.md", "CHANGELOG.md", "LICENSE"];
  assert.doesNotThrow(() => assertPackageFiles(files, manifest));
  for (const name of ["dist/extensions/retired.js", "dist/extensions/retired.js.map", "dist/lib/performance.js", "dist/ui/performance-view.js", "dist/dev/performance/extension.js", "dev/performance/README.md", ".local/dev-dist/extension.js", "auth.json", "docs/out/index.html"]) {
    assert.throws(() => assertPackageFiles([...files, name], manifest), /./, name);
  }
  assert.throws(() => assertPackageFiles(files.filter((name) => name !== "dist/extensions/current.js"), manifest), /Missing production extension/);
});

test("the production package registers only allowlisted extensions, without diagnostics", async (t) => {
  const f = fixture(t), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(f.root, "profile");
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const shipped = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  assertProductionOutput(outputFiles(repository), shipped);
  const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noThemes: true,
    noPromptTemplates: true, noContextFiles: true, additionalExtensionPaths: [repository] });
  await loader.reload();
  const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, productionExtensions(shipped).length);
  assert.equal(loaded.extensions.some((extension) => extension.commands.has("perf")), false);
});
