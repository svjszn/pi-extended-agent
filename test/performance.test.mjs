import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, findPackageJSON } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { PerformanceTracker, PerformanceStore, partitionTime, PERFORMANCE_MAX_BYTES } from "../.local/dev-dist/dev/performance/tracker.js";
import { StateFiles, projectFiles } from "../dist/lib/project-state.js";
import perf from "../.local/dev-dist/dev/performance/extension.js";
import { performanceLines } from "../.local/dev-dist/dev/performance/view.js";
import { createUiTheme } from "../dist/ui/theme.js";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
const sampleUsage = { input: 100, output: 20, cacheRead: 80, cacheWrite: 10 };
function clockFixture() {
  let time = 0;
  const tracker = new PerformanceTracker(() => time, () => new Date("2026-10-31T12:00:00Z"));
  tracker.begin("test-model", "test-provider", "high");
  return { tracker, at(value) { time = value; } };
}
function directory(t) {
  const base = resolve(".local/performance-tests"); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "project-"));
  t.after(() => { const target = resolve(cwd); assert.ok(target.startsWith(base + sep)); rmSync(target, { recursive: true, force: true }); });
  return cwd;
}
function fixture(t) {
  const cwd = directory(t), agentDir = join(cwd, "profile"), handlers = new Map(), notices = [];
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  let command;
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand: (_name, value) => { command = value; },
    getThinkingLevel: () => "high", getAllTools: () => ["read", "write", "edit", "bash"].map((name) => ({ name, sourceInfo: { source: "builtin", path: `builtin:${name}` } })) };
  const ctx = { cwd, model: { id: "test-model", provider: "test-provider" }, mode: "print", hasUI: true,
    sessionManager: { getSessionId: () => "perf-test-session" }, ui: { notify: (text, type) => notices.push({ text, type }) } };
  perf(pi);
  const emit = (name, event = {}) => handlers.get(name)(event, ctx);
  emit("session_start");
  return { cwd, agentDir, ctx, notices, handlers, emit, command, store: new PerformanceStore(projectFiles(cwd, agentDir), "perf-test-session") };
}

test("wall time partitions parallel/nested tools, provider calls, compaction and user dialogs without overlap", () => {
  const times = partitionTime(100, [
    { kind: "model", start: 0, end: 40 }, { kind: "tools", start: 20, end: 80 }, { kind: "tools", start: 30, end: 60 },
    { kind: "approval", start: 25, end: 35 }, { kind: "compaction", start: 70, end: 90 },
  ]);
  assert.deepEqual(times, { model: 20, tools: 40, approval: 10, compaction: 20, other: 10 });
  assert.equal(Object.values(times).reduce((a, b) => a + b, 0), 100);
});

test("run timing follows requests and settlement, counts partial failures without relabeling recovered runs", () => {
  const { tracker: p, at } = clockFixture();
  p.turn(); at(10); p.request(); at(30); p.output(); at(60); p.assistantEnd(sampleUsage, "error");
  at(100); p.turn(); p.request(); at(150); p.assistantEnd(sampleUsage, "stop"); at(170);
  const run = p.finish("completed");
  assert.equal(run.elapsedMs, 170); assert.equal(run.firstOutputMs, 30);
  assert.equal(run.requests, 2); assert.equal(run.turns, 2); assert.equal(run.failedResponses, 1); assert.equal(run.outcome, "completed");
  assert.deepEqual(run.requestMs, [50, 50]);
  assert.deepEqual(run.times, { model: 100, tools: 0, compaction: 0, approval: 0, other: 70 });
  assert.deepEqual(run.tokens, { input: 200, output: 40, cacheRead: 160, cacheWrite: 20 });
  assert.equal(p.active, false); assert.equal(p.finish("completed"), undefined);
});

test("per-request samples separate first reasoning/tool output from visible text and count tool batches", () => {
  const { tracker: p, at } = clockFixture();
  at(10); p.request(); p.response(200); at(30); p.output("thinking"); at(45); p.output("text"); at(60); p.assistantEnd(sampleUsage, "toolUse", 2);
  at(100); p.request(); at(107); p.output("toolcall"); at(180); p.assistantEnd(sampleUsage, "toolUse", 1);
  const run = p.finish("completed");
  assert.equal(run.firstOutputMs, 30);
  assert.deepEqual(run.requestDetails.map((sample) => [sample.durationMs, sample.firstOutputMs, sample.firstTextMs, sample.toolCalls]), [[50, 20, 35, 2], [80, 7, null, 1]]);
  assert.equal(run.requestDetails[0].httpStatus, 200); assert.deepEqual(run.requestDetails[0].tokens, sampleUsage);
  const text = performanceLines(run, createUiTheme({ color: false })).join("\n");
  assert.match(text, /Tool batches \(single \/ multi-call\): 1 \/ 1/); assert.match(text, /Per-request timeline/);
  assert.match(text, /first event 20 ms · first text 35 ms/);
});

test("tool observations distinguish successful built-in changes, nested usage and necessary repeated operations", () => {
  const { tracker: p, at } = clockFixture();
  p.toolStart("bad", "write", { path: "sample" }, true, "/project"); at(10); p.toolEnd("bad", true, false);
  assert.equal(p.snapshot().firstChangeMs, null);
  p.toolStart("external", "write", { path: "sample" }, false, "/project"); at(20); p.toolEnd("external", false, true);
  assert.equal(p.snapshot().firstChangeMs, null);
  for (let i = 0; i < 2; i++) {
    p.toolStart("read" + i, "read", { path: "sample" }, true, "/project"); at(30 + i); p.toolEnd("read" + i, false, true);
    p.toolStart("shell" + i, "bash", { command: "npm test" }, true, "/project"); p.toolEnd("shell" + i, false, true);
  }
  p.toolStart("parent", "codemode", {}, false, "/project");
  p.toolStart("child", "edit", { path: "sample" }, true, "/project", "parent");
  at(40); p.toolEnd("child", false, true, sampleUsage); at(50); p.toolEnd("parent", false, true, sampleUsage);
  const run = p.finish("completed");
  assert.equal(run.firstChangeMs, 40); assert.equal(run.repeatedReads, 1); assert.equal(run.repeatedShells, 1);
  assert.equal(run.nestedTools, 1); assert.equal(run.toolErrors, 1); assert.deepEqual(run.tokens, sampleUsage);
});

test("compaction and interrupted requests remain bounded and report their actual state", () => {
  const { tracker: p, at } = clockFixture();
  p.compactStart(); at(10); p.request(); at(40); p.compactEnd(false, sampleUsage);
  at(50); p.request(); at(80);
  const run = p.finish("aborted");
  assert.equal(run.compactions, 1); assert.equal(run.outcome, "aborted"); assert.equal(run.incomplete, true);
  assert.deepEqual(run.times, { compaction: 40, model: 30, tools: 0, approval: 0, other: 10 });
  assert.deepEqual(run.tokens, sampleUsage);
  assert.equal(run.requestDetails[0].kind, "compaction"); assert.equal(run.requestDetails[0].stopReason, "compaction");
  p.begin("another", "provider", "medium"); p.output(); assert.equal(p.snapshot().firstOutputMs, 0); assert.equal(p.snapshot().requests, 0);
});

test("nested dialogs retain the whole wait interval and concurrent provider spans are marked incomplete", () => {
  const { tracker: p, at } = clockFixture();
  p.approvalStart(); at(10); p.approvalStart(); at(20); p.approvalEnd(); at(30); p.approvalEnd();
  at(40); p.request(); at(45); p.request(); at(60); p.assistantEnd(sampleUsage, "stop");
  const run = p.finish("completed");
  assert.equal(run.times.approval, 30); assert.equal(run.times.model, 20); assert.equal(run.times.other, 10);
  assert.equal(run.incomplete, true); assert.equal(run.requests, 2);
  assert.equal(run.requestDetails[0].stopReason, "unpaired");
});

test("metadata collection does not retain prompts, paths, command contents or tool results, including odd tool names", () => {
  const { tracker: p } = clockFixture();
  p.toolStart("s", "bash", { command: "echo SENSITIVE_COMMAND" }, true, "/SENSITIVE_DIRECTORY"); p.toolEnd("s", false, true);
  p.toolStart("r", "read", { path: "SENSITIVE_FILE" }, true, "/project"); p.toolEnd("r", false, true);
  p.toolStart("x", "__proto__", {}, false, "/project"); p.toolEnd("x", false, true);
  const run = p.finish("completed");
  assert.doesNotMatch(JSON.stringify(run), /SENSITIVE_/); assert.equal(run.toolKinds.__proto__, 1);
  assert.equal(Object.getPrototypeOf(run.toolKinds), Object.prototype);
});

test("performance history keeps the most recent 30 runs, restores from disk and rejects invalid/oversized data", (t) => {
  const files = new StateFiles(join(directory(t), "state")), store = new PerformanceStore(files, "session/a");
  for (let i = 0; i < 35; i++) { const { tracker } = clockFixture(); store.save(tracker.finish("completed")); }
  const reopened = new PerformanceStore(files, "session/a"); assert.equal(reopened.read().length, 30);
  assert.equal(new PerformanceStore(files, "session/b").read().length, 0);
  const [run] = reopened.read();
  const legacyRun = { ...run }; delete legacyRun.requestDetails;
  files.write(store.name, JSON.stringify({ version: 1, runs: [legacyRun] }));
  assert.equal(reopened.read()[0].requestDetails, undefined);
  const { tracker: next } = clockFixture(); store.save(next.finish("completed"));
  assert.equal(reopened.read().length, 2); assert.equal(reopened.read()[0].requestDetails, undefined);
  assert.match(performanceLines(reopened.read()[0], createUiTheme({ color: false })).join("\n"), /earlier version/);
  const { tracker: detailedTracker } = clockFixture(); detailedTracker.request(); detailedTracker.output("thinking"); detailedTracker.assistantEnd(sampleUsage, "toolUse", 2);
  const detailed = detailedTracker.finish("completed"); store.save(detailed);
  assert.deepEqual(reopened.read().at(-1).requestDetails, detailed.requestDetails);
  const corrupted = { ...detailed, requestDetails: [{ ...detailed.requestDetails[0], durationMs: -1 }] };
  files.write(store.name, JSON.stringify({ version: 1, runs: [corrupted] })); assert.throws(() => reopened.read(), /Invalid request timing/);
  files.write(store.name, JSON.stringify({ version: 1, runs: [{ ...run, extraPayload: "DO_NOT_EXPORT" }] }));
  assert.doesNotMatch(JSON.stringify(reopened.read()), /DO_NOT_EXPORT/);
  files.write(store.name, JSON.stringify({ version: 1, runs: [{ ...run, requests: -1 }] })); assert.throws(() => reopened.read(), /Invalid/);
  files.write(store.name, '{"version":99,"runs":[]}'); assert.throws(() => store.read(), /Invalid/);
  files.write(store.name, "x".repeat(PERFORMANCE_MAX_BYTES + 1)); assert.throws(() => store.read(), /too large/);
});

test("extension records a run through native event shapes, persists only at settlement, and restores after reload", async (t) => {
  const f = fixture(t);
  f.emit("before_agent_start", { prompt: "SENSITIVE_PROMPT" }); f.emit("turn_start"); f.emit("before_provider_request", { payload: { secret: "SENSITIVE_PAYLOAD" } });
  f.emit("after_provider_response", { status: 200 });
  f.emit("message_update", { assistantMessageEvent: { type: "text_delta" } });
  f.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: sampleUsage } });
  f.emit("tool_execution_start", { toolCallId: "write", toolName: "write", args: { path: "SENSITIVE_PATH" } });
  f.emit("tool_execution_end", { toolCallId: "write", toolName: "write", isError: false, durationMs: 1, result: { content: [{ text: "SENSITIVE_OUTPUT" }] } });
  assert.equal(f.store.read().length, 0);
  f.emit("agent_before_settle", { outcome: "completed" }); f.emit("agent_settled", { aborted: false });
  const saved = f.store.read(); assert.equal(saved.length, 1); assert.equal(saved[0].requests, 1); assert.equal(saved[0].tools, 1);
  assert.doesNotMatch(JSON.stringify(saved), /SENSITIVE/);
  await f.command.handler("json", f.ctx); assert.equal(JSON.parse(f.notices.at(-1).text).id, saved[0].id);
  f.emit("session_shutdown"); f.emit("session_start");
  await f.command.handler("history", f.ctx); assert.match(f.notices.at(-1).text, /test-provider\/test-model/);
});

test("partial runs save as interrupted, collection failures do not modify model requests or throw", async (t) => {
  const f = fixture(t);
  assert.equal(f.emit("before_agent_start", {}), undefined);
  const event = { payload: { input: "unchanged" } }; assert.equal(f.emit("before_provider_request", event), undefined);
  assert.deepEqual(event.payload, { input: "unchanged" });
  f.emit("session_shutdown"); assert.equal(f.store.read()[0].outcome, "interrupted");
  const files = projectFiles(f.cwd, f.agentDir); files.write(f.store.name, "broken");
  assert.doesNotThrow(() => f.emit("session_start"));
  f.emit("before_agent_start", {}); f.emit("agent_settled", { aborted: false });
  assert.match(f.notices.at(-1).text, /Performance history/);
  await f.command.handler("last", f.ctx); assert.match(f.notices.at(-1).text, /Elapsed/);
});

test("perf viewer scrolls within the shared frame across terminal sizes and cancellation disposes it", async (t) => {
  const f = fixture(t); f.ctx.mode = "tui";
  f.emit("before_agent_start", {});
  f.ctx.ui.custom = async (create) => {
    const tui = { children: [], terminal: { rows: 30 }, requestRender() {} };
    let closed = false;
    const panel = create(tui, createUiTheme(), {}, () => { closed = true; });
    await panel.ready;
    assert.match(measure.stripTerminalSequences(panel.render(90).join("\n")), /Wall-clock breakdown/);
    for (const [width, rows] of [[90, 30], [24, 12], [8, 8], [1, 4]]) {
      tui.terminal.rows = rows;
      const lines = panel.render(width); assert.equal(lines.length, rows); assert.ok(lines.every((line) => measure.visibleWidth(line) <= width));
    }
    panel.handleInput("\x1b"); panel.dispose(); assert.equal(closed, true);
  };
  await f.command.handler("", f.ctx); f.emit("session_shutdown");
  assert.match(performanceLines(undefined, createUiTheme({ color: false })).join("\n"), /No recorded run/);
});

test("real Pi runner observes requests and settlement while preserving the provider payload and transcript", async (t) => {
  const cwd = directory(t), agentDir = join(cwd, "profile"), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, additionalExtensionPaths: [fileURLToPath(new URL("../.local/dev-dist/dev/performance/extension.js", import.meta.url))] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: manager });
  t.after(() => session.dispose()); await session.bindExtensions({ mode: "print" });
  const runner = session._extensionRunner, before = manager.getEntries().length;
  await runner.emitBeforeAgentStart({ messageType: "user", prompt: "Fixture" }, session._baseSystemPromptOptions);
  const payload = { model: "fixture", input: "DO_NOT_RECORD" };
  const transformed = await runner.emitBeforeProviderRequest(payload); assert.deepEqual(transformed, payload);
  await runner.emit({ type: "message_end", message: { role: "assistant", usage: sampleUsage, stopReason: "stop" } });
  await runner.emit({ type: "agent_settled", aborted: false });
  assert.equal(manager.getEntries().length, before);
  const store = new PerformanceStore(projectFiles(cwd, agentDir), manager.getSessionId());
  const [run] = store.read(); assert.equal(run.requests, 1); assert.deepEqual(run.tokens, sampleUsage);
  assert.doesNotMatch(readFileSync(projectFiles(cwd, agentDir).path(store.name), "utf8"), /DO_NOT_RECORD/);
});

test("a full Pi run with a fixture provider automatically records requests, output and final settlement", async (t) => {
  const cwd = directory(t), agentDir = join(cwd, "profile"), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const aiManifest = findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(dirname(aiManifest), "dist/compat.js")));
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
  let payload;
  modelRuntime.registerProvider("perf-fixture", { api: "perf-fixture-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          payload = await options.onPayload({ input: "PRIVATE_FIXTURE_PAYLOAD" }, model);
          await options.onResponse({ status: 200, headers: {} }, model);
          const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: [{ type: "text", text: "Fixture done" }], stopReason: "stop", timestamp: Date.now(),
            usage: { ...sampleUsage, totalTokens: 210, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "Fixture done", partial: message });
          stream.push({ type: "done", reason: "stop", message }); stream.end();
        } catch (error) { stream.end(); throw error; }
      });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [perf] });
  await loader.reload();
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: manager, model: modelRuntime.getModel("perf-fixture", "fixture"), tools: [] });
  t.after(() => { session.dispose(); modelRuntime.unregisterProvider("perf-fixture"); });
  await session.bindExtensions({ mode: "print" });
  await session.prompt("PRIVATE_FIXTURE_PROMPT");
  const [run] = new PerformanceStore(projectFiles(cwd, agentDir), manager.getSessionId()).read();
  assert.equal(run.outcome, "completed"); assert.equal(run.requests, 1); assert.equal(run.turns, 1);
  assert.notEqual(run.firstOutputMs, null); assert.deepEqual(run.tokens, sampleUsage);
  assert.equal(run.incomplete, false); assert.deepEqual(payload, { input: "PRIVATE_FIXTURE_PAYLOAD" });
  assert.doesNotMatch(JSON.stringify(run), /PRIVATE_FIXTURE/);
  assert.equal(manager.getEntries().filter((entry) => entry.customType?.includes("performance")).length, 0);
});
