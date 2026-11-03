import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import fs, { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { syncBuiltinESMExports, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelFixture } from "./helpers.ts";

const { readDoctorReport } = await import(new URL("../dist/bin/doctor.js", import.meta.url).href) as typeof import("../bin/doctor.js");
const { doctorText, sessionDoctorChecks } = await import(new URL("../dist/lib/doctor.js", import.meta.url).href) as typeof import("../lib/doctor.js");
const { doctorLines } = await import(new URL("../dist/ui/doctor-view.js", import.meta.url).href) as typeof import("../ui/doctor-view.js");
const { createCommandPanel } = await import(new URL("../dist/ui/command-panel.js", import.meta.url).href) as typeof import("../ui/command-panel.js");
const { projectFiles } = await import(new URL("../dist/lib/project-state.js", import.meta.url).href) as typeof import("../lib/project-state.js");
const { PlanStore, PLAN_ENTRY } = await import(new URL("../dist/lib/plan.js", import.meta.url).href) as typeof import("../lib/plan.js");
const { PERMISSIONS_ENTRY } = await import(new URL("../dist/lib/permissions.js", import.meta.url).href) as typeof import("../lib/permissions.js");
const repository = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");

function fixture(t: TestContext) {
  const base = resolve(".local/doctor-tests"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "case-")), app = join(root, "app"), profile = join(root, "profile"), runtime = join(root, "runtime"), cwd = join(root, "project");
  const write = (file: string, text: string) => { mkdirSync(resolve(file, ".."), { recursive: true }); writeFileSync(file, text); };
  const engine = join(app, "node_modules/@earendil-works/pi-coding-agent");
  for (const dir of [app, profile, runtime, cwd]) mkdirSync(dir, { recursive: true });
  write(join(app, "package.json"), JSON.stringify({ name: "pi-extended-agent", version: "1.4.1", type: "module", pi: { extensions: ["./dist/extensions/commands.js"] } }));
  for (const file of ["bin/pi.mjs", "dist/bin/main.js", "dist/bin/doctor.js", "dist/bin/verify-runtime.js", "dist/extensions/commands.js"]) write(join(app, file), "");
  write(join(engine, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.5.0", main: "dist/index.js", bin: { pi: "dist/bundle/cli.js" } }));
  for (const file of ["dist/index.js", "dist/bundle/cli.js", "dist/bundle/index.js", "dist/cli/setup.js"]) write(join(engine, file), 'throw Error("Doctor must never execute this engine");');
  write(join(profile, "settings.json"), '{"headers":{"Authorization":"PRIVATE_SETTINGS_SENTINEL"}}');
  write(join(profile, "auth.json"), "PRIVATE_AUTH_SENTINEL");
  write(join(profile, "models.json"), "PRIVATE_MODELS_SENTINEL");
  write(join(cwd, ".pi/settings.json"), "PRIVATE_PROJECT_SENTINEL");
  t.after(() => { assert.ok(resolve(root).startsWith(base + sep)); rmSync(root, { recursive: true, force: true }); });
  const options = { packageRoot: app, agentDir: profile, runtimeDir: runtime, cwd, home: root };
  return { root, app, profile, runtime, cwd, engine, write, options };
}
function snapshot(root: string): unknown[] {
  return readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map(entry => {
    const file = join(root, entry.name), info = fs.lstatSync(file);
    return [relative(root, file), info.size, info.mtimeMs, entry.isDirectory() ? snapshot(file) : null];
  });
}

test("doctor is read-only and reports local installation health without reading credentials or exposing settings", t => {
  const f = fixture(t), before = snapshot(f.root), reads: string[] = [];
  const original = fs.readFileSync;
  const spy = t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    const file = String(args[0]); reads.push(file);
    assert.ok(!["auth.json", "models.json"].includes(basename(file)), "Credential files must never be opened");
    assert.ok(!file.endsWith(join(".pi", "settings.json")), "Untrusted project settings must be skipped");
    return original(...args);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  let report;
  try { report = readDoctorReport(f.options); } finally { spy.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(report.summary.errors, 0); assert.equal(report.summary.warnings, 0);
  assert.ok(reads.length > 0);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(report.locations.profile, "~/profile");
  assert.doesNotMatch(JSON.stringify(report) + doctorText(report).join("\n"), /PRIVATE_|Doctor must never execute/);
});

test("doctor diagnoses incomplete engines, broken selection, invalid settings, locks and unsupported Node independently", t => {
  const f = fixture(t);
  f.write(join(f.runtime, "active.json"), JSON.stringify({ version: "9.0.0", previous: null }));
  f.write(join(f.runtime, "update.lock"), "PRIVATE_LOCK_SENTINEL");
  f.write(join(f.profile, "settings.json"), '{"PRIVATE_PARSE_SENTINEL":');
  const report = readDoctorReport({ ...f.options, nodeVersion: "20.0.0" });
  const check = (id: string) => report.checks.find(check => check.id === id);
  assert.equal(check("node")?.status, "error");
  assert.equal(check("engine.active")?.status, "error");
  assert.match(check("engine.active")?.action ?? "", /pi update --engine --rollback/);
  assert.equal(check("engine.rollback")?.status, "ok");
  assert.equal(check("settings.global")?.status, "error");
  assert.equal(check("engine.lock")?.status, "warn");
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/);
  f.write(join(f.runtime, "active.json"), '{"PRIVATE_BAD_POINTER":');
  const invalid = readDoctorReport(f.options);
  assert.equal(invalid.checks.find(check => check.id === "engine.selection")?.status, "error");
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_/);
  const settings = join(f.profile, "settings.json"); assert.ok(resolve(settings).startsWith(f.root + sep)); rmSync(settings);
  const missing = join(f.engine, "dist/bundle/index.js"); assert.ok(resolve(missing).startsWith(f.root + sep)); rmSync(missing);
  assert.equal(readDoctorReport(f.options).checks.find(check => check.id === "engine.bundled")?.status, "error");
});

test("absent profiles are not created and cancellation leaves storage unchanged", t => {
  const f = fixture(t), absent = join(f.root, "not-created");
  assert.equal(readDoctorReport({ ...f.options, agentDir: absent }).summary.errors, 0);
  assert.equal(existsSync(absent), false);
  const before = snapshot(f.root);
  assert.throws(() => readDoctorReport({ ...f.options, signal: AbortSignal.abort() }), /abort/i);
  assert.deepEqual(snapshot(f.root), before);
});

test("diagnostic JSON file links are not followed", t => {
  const f = fixture(t), settings = join(f.profile, "settings.json");
  assert.ok(resolve(settings).startsWith(f.root + sep)); rmSync(settings);
  try { symlinkSync(join(f.profile, "auth.json"), settings, "file"); }
  catch (error) { if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("File symlinks are unavailable"); return; } throw error; }
  const report = readDoctorReport(f.options);
  assert.equal(report.checks.find(check => check.id === "settings.global")?.status, "warn");
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_AUTH/);
});

test("doctor distinguishes the running engine from the engine selected for the next launch", t => {
  const f = fixture(t);
  const report = readDoctorReport({ ...f.options, runningEngineVersion: "1.4.0" });
  const running = report.checks.find(check => check.id === "engine.running");
  assert.equal(running?.status, "warn"); assert.match(running?.action ?? "", /Restart/);
});

test("session diagnostics preserve policy, report missing plans and omit goals and conversation content", t => {
  const f = fixture(t), entries = [{ type: "custom", customType: PERMISSIONS_ENTRY, data: { mode: "read-only" } },
    { type: "custom", customType: PLAN_ENTRY, data: { status: "planning" } }];
  const ctx = { cwd: f.cwd, model: modelFixture(), isProjectTrusted: () => false,
    sessionManager: { getEntries: () => entries, getSessionId: () => "doctor-fixture" } } as unknown as ExtensionContext;
  const before = JSON.stringify(entries), first = sessionDoctorChecks(ctx, f.profile);
  assert.equal(first.find(check => check.id === "session.plan")?.status, "error");
  assert.match(first.find(check => check.id === "session.permissions")?.message ?? "", /Current mode: deny/);
  new PlanStore(projectFiles(f.cwd, f.profile), "doctor-fixture").save({ version: 1, status: "planning", goal: "PRIVATE_GOAL_SENTINEL", steps: [], areas: [], checks: [], updatedAt: "" });
  assert.equal(sessionDoctorChecks(ctx, f.profile).find(check => check.id === "session.plan")?.status, "ok");
  assert.equal(JSON.stringify(entries), before);
  assert.doesNotMatch(JSON.stringify(sessionDoctorChecks(ctx, f.profile)), /PRIVATE_/);
});

test("the doctor panel remains bounded while scrolling and resizing", async t => {
  const f = fixture(t), report = readDoctorReport(f.options), tui = { terminal: { rows: 24 }, requestRender() {} };
  const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
  const panel = createCommandPanel({ title: "Doctor", tui, theme, measure, done() {}, load: () => report, renderBody: doctorLines });
  try {
    await panel.ready;
    for (const [width, rows] of [[100, 30], [24, 12], [8, 8], [1, 4]]) {
      tui.terminal.rows = rows;
      for (const key of ["\x1b[H", "\x1b[F"]) {
        panel.handleInput(key); const lines = panel.render(width);
        assert.equal(lines.length, rows); assert.ok(lines.every(line => measure.visibleWidth(line) <= width));
      }
    }
    assert.throws(() => readDoctorReport({ ...f.options, signal: AbortSignal.abort() }), /abort/i);
  } finally { panel.dispose(); }
});

test("pi doctor runs before engine initialization, emits valid JSON, and returns useful exit codes", t => {
  const f = fixture(t);
  for (const file of ["bin/pi.mjs", ...["bin/main", "bin/update", "bin/runtime", "bin/doctor", "lib/package", "lib/errors", "lib/doctor", "lib/permissions", "lib/plan", "lib/project-state", "lib/startup"].map(file => `dist/${file}.js`)]) {
    mkdirSync(resolve(join(f.app, file), ".."), { recursive: true }); copyFileSync(join(repository, file), join(f.app, file));
  }
  const guard = join(f.root, "no-engine.mjs");
  f.write(guard, 'import { registerHooks } from "node:module"; registerHooks({ load(url, context, next) { if (url.includes("/node_modules/")) throw Error("Doctor loaded an engine or provider"); return next(url, context); } });');
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, join(f.app, "bin/pi.mjs"), "doctor", ...args],
    { cwd: f.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: f.profile, PI_EXTENDED_RUNTIME_DIR: f.runtime, PI_OFFLINE: "1" }, encoding: "utf8", timeout: 15000, windowsHide: true });
  const healthy = run("--json"); assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).schemaVersion, 1);
  const plain = run(); assert.equal(plain.status, 0, plain.stderr); assert.match(plain.stdout, /Pi Extended Agent doctor/);
  f.write(join(f.runtime, "active.json"), JSON.stringify({ version: "9.0.0", previous: null }));
  const broken = run("--json"); assert.equal(broken.status, 1, broken.stderr);
  assert.ok(JSON.parse(broken.stdout).summary.errors > 0);
  assert.match(broken.stdout, /pi update --engine --rollback/);
  assert.equal(run("--help").status, 0); assert.equal(run("--fix").status, 2);
  assert.doesNotMatch(healthy.stdout + broken.stdout + plain.stdout, /PRIVATE_|Doctor loaded an engine/);
});

test("the real SDK routes /doctor without a model request, transcript entry or policy change", async t => {
  const f = fixture(t), previousProfile = process.env.PI_CODING_AGENT_DIR, previousRuntime = process.env.PI_EXTENDED_RUNTIME_DIR;
  process.env.PI_CODING_AGENT_DIR = f.profile; process.env.PI_EXTENDED_RUNTIME_DIR = f.runtime;
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const models = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
  models.registerProvider("doctor-fixture", { api: "doctor-fixture-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], streamSimple() { assert.fail("Doctor must not call a model"); } });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.profile, settingsManager, noExtensions: true,
    noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [join(repository, "dist/extensions/commands.js")] });
  await loader.reload();
  const manager = SessionManager.inMemory(f.cwd); manager.appendCustomEntry(PERMISSIONS_ENTRY, { mode: "read-only" });
  const { session } = await createAgentSession({ cwd: f.cwd, agentDir: f.profile, settingsManager, modelRuntime: models,
    resourceLoader: loader, model: models.getModel("doctor-fixture", "fixture")!, sessionManager: manager, tools: [] });
  t.after(() => {
    session.dispose(); models.unregisterProvider("doctor-fixture");
    if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousProfile;
    if (previousRuntime === undefined) delete process.env.PI_EXTENDED_RUNTIME_DIR; else process.env.PI_EXTENDED_RUNTIME_DIR = previousRuntime;
  });
  await session.bindExtensions({ mode: "print" });
  const before = snapshot(f.root), entries = JSON.stringify(manager.getEntries()), output: string[] = [];
  const capture = t.mock.method(console, "error", (text: unknown) => { output.push(String(text)); });
  try { await session.prompt("/doctor"); } finally { capture.mock.restore(); }
  assert.match(output.join("\n"), /Doctor/); assert.match(output.join("\n"), /Current mode: deny/);
  assert.equal(JSON.stringify(manager.getEntries()), entries); assert.equal(session.messages.length, 0);
  assert.deepEqual(snapshot(f.root), before);
});
