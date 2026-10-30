import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readContextSummary, readContextReport } from "../dist/lib/context.js";
import { contextLines } from "../dist/ui/context-view.js";
import { createUiTheme } from "../dist/ui/theme.js";
import { createFooter, createHeader } from "../dist/ui/chrome.js";
import { createCommandPanel } from "../dist/ui/command-panel.js";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const settings = SettingsManager.inMemory();
const assistant = (totalTokens = 24000) => ({ role: "assistant", content: [{ type: "text", text: "Response" }],
  usage: { input: totalTokens - 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens }, stopReason: "stop", timestamp: Date.now() });
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

function fixture() {
  const session = SessionManager.inMemory(process.cwd());
  const state = { usage: { tokens: 24000, contextWindow: 200000, percent: 12 } };
  const options = { cwd: process.cwd(), selectedTools: ["read"],
    contextFiles: [{ path: "/project/AGENTS.md", content: "PRIVATE_INSTRUCTIONS\n" + "Rules. ".repeat(70) }],
    skills: [{ name: "sample", description: "A useful skill", filePath: "/profile/skills/sample/SKILL.md", disableModelInvocation: false }],
  };
  const pi = { getActiveTools: () => ["read"], getAllTools: () => [
    { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    { name: "inactive", description: "Not in context".repeat(10000), parameters: {} },
  ] };
  const ctx = { model: { contextWindow: 200000 }, sessionManager: session,
    getSystemPromptOptions: () => options, getSystemPrompt: () => buildSystemPrompt(options), getContextUsage: () => state.usage };
  session.appendMessage(user("Hello"));
  session.appendMessage(assistant());
  return { session, state, options, ctx, pi };
}

test("context total follows Pi's active-window estimate instead of cumulative billing", () => {
  const { ctx, session, pi } = fixture();
  session.appendMessage(assistant(100000));
  const summary = readContextSummary(ctx, pi);
  assert.equal(summary.tokens, 24000);
  assert.equal(summary.percent, 12);
  assert.equal(summary.source, "pi");
});

test("new sessions include prompt and active schemas while unknown usage stays unknown", () => {
  const { ctx, state, pi } = fixture();
  ctx.sessionManager = SessionManager.inMemory();
  state.usage = { tokens: 0, contextWindow: 200000, percent: 0 };
  const summary = readContextSummary(ctx, pi);
  assert.ok(summary.tokens > 0 && summary.tokens < 10000);
  assert.equal(summary.source, "estimate");
  for (const usage of [undefined, { tokens: null, contextWindow: 200000, percent: null }, { tokens: NaN, contextWindow: 0, percent: NaN }]) {
    state.usage = usage;
    const unknown = readContextSummary(ctx, pi);
    assert.equal(unknown.tokens, null);
    assert.equal(unknown.percent, null);
  }
});

test("breakdown includes loaded instructions, skill metadata, and active schemas without exposing content", () => {
  const { ctx, pi } = fixture();
  const report = readContextReport(ctx, pi, settings);
  assert.equal(report.categories.reduce((sum, item) => sum + item.tokens, 0), report.tokens);
  assert.ok(report.categories.find((item) => item.id === "instructions").tokens > 0);
  assert.ok(report.categories.find((item) => item.id === "skills").tokens > 0);
  assert.deepEqual(report.tools.map((item) => item.name), ["read"]);
  assert.deepEqual(report.skills.map((item) => item.name), ["sample"]);
  assert.deepEqual(report.files.map((item) => item.name), ["/project/AGENTS.md"]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_INSTRUCTIONS|Rules\.|Not in context/);
  ctx.getSystemPrompt = () => "A replacement prompt";
  const replacement = readContextReport(ctx, pi, settings);
  assert.equal(replacement.files.length, 0);
  assert.equal(replacement.skills.length, 0);
});

test("compaction and branching exclude discarded history and never reuse pre-compaction totals", () => {
  const { ctx, session, state, pi } = fixture();
  session.appendMessage(user("Discard this old message".repeat(10000)));
  const kept = session.appendMessage(user("Keep this message"));
  session.appendCompaction("A concise summary", kept, 190000);
  state.usage = { tokens: null, contextWindow: 200000, percent: null };
  const compacted = readContextReport(ctx, pi, settings);
  assert.equal(compacted.tokens, null);
  assert.equal(compacted.compactions, 1);
  assert.equal(compacted.messageCount, 2); // Summary and kept user message.
  assert.ok(compacted.categories.find((item) => item.id === "messages").tokens < 1000);
  assert.match(contextLines(compacted, 80, createUiTheme({ color: false }), measure).join("\n"), /Waiting for the first response/);
  session.appendMessage(user("This other branch is large".repeat(10000)));
  session.branch(kept);
  state.usage = { tokens: 12, contextWindow: 200000, percent: 0.006 };
  assert.equal(readContextReport(ctx, pi, settings).compactions, 0);
});

test("footer aligns context at the right, refreshes values, and fits narrow screens", () => {
  const { ctx, state, pi } = fixture();
  const footer = createFooter({}, {}, createUiTheme(), {}, measure, () => readContextSummary(ctx, pi));
  let line = measure.stripTerminalSequences(footer.render(80)[0]);
  assert.ok(line.startsWith("  auto mode"));
  assert.ok(line.endsWith("~24k / 200k · 12% context  "));
  assert.equal(measure.visibleWidth(line), 80);
  state.usage = { tokens: 40000, contextWindow: 100000, percent: 40 };
  assert.match(measure.stripTerminalSequences(footer.render(80)[0]), /~40k \/ 100k · 40% context/);
  state.usage.tokens = null;
  line = measure.stripTerminalSequences(footer.render(80)[0]);
  assert.match(line, /— \/ 100k/);
  assert.doesNotMatch(line, /40%|0%/);
  for (const width of [1, 8, 24, 32, 80, 140]) assert.ok(footer.render(width).every((row) => measure.visibleWidth(row) <= width));
});

test("context screen renders its header, scrolls details, and closes on Escape across terminal sizes", async () => {
  const { ctx, pi } = fixture();
  const report = readContextReport(ctx, pi, settings);
  const theme = createUiTheme();
  const header = createHeader({ mode: "regular" }, theme, measure, {
    version: "test", getModel: () => ({ id: "test-model" }), getThinkingLevel: () => "medium",
  });
  const tui = { terminal: { rows: 30 }, requestRender() {} };
  let closed = false;
  const panel = createCommandPanel({ title: "Context", tui, theme, measure, done: () => { closed = true; },
    load: () => report, renderBody: contextLines, renderHeader: (width) => header.render(width) });
  await panel.ready;
  for (const [width, height] of [[100, 30], [80, 24], [24, 12], [8, 8], [1, 4]]) {
    tui.terminal.rows = height;
    const lines = panel.render(width);
    assert.equal(lines.length, height);
    assert.ok(lines.every((line) => measure.visibleWidth(line) <= width));
  }
  tui.terminal.rows = 30;
  panel.render(100);
  panel.handleInput("\x1b[F");
  assert.match(measure.stripTerminalSequences(panel.render(100).join("\n")), /Active tools/);
  panel.handleInput("\x1b");
  assert.equal(closed, true);
  panel.dispose(); header.dispose();
});

test("over-capacity context remains visible and estimated categories reconcile even with a tiny total", () => {
  const { ctx, state, pi } = fixture();
  state.usage = { tokens: 220000, contextWindow: 200000, percent: 110 };
  const output = contextLines(readContextReport(ctx, pi, settings), 100, createUiTheme({ color: false }), measure).join("\n");
  assert.match(output, /110% used/);
  assert.doesNotMatch(output, /NaN|Infinity|-[\d.]+k/);
  state.usage.tokens = 2;
  assert.equal(readContextReport(ctx, pi, settings).categories.reduce((sum, item) => sum + item.tokens, 0), 2);
});

test("live footer refreshes on Pi events without recounting tokens during rendering", async () => {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { createJiti } = await import(pathToFileURL(require.resolve("jiti")));
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    "@earendil-works/pi-coding-agent": fileURLToPath(entry),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  } });
  const factory = await jiti.import(fileURLToPath(new URL("../dist/extensions/pi-interface.js", import.meta.url)), { default: true });
  const { ctx, pi, state } = fixture();
  const handlers = new Map();
  let footer, header, calls = 0, configured = false;
  const notices = [];
  ctx.mode = "tui";
  ctx.model.provider = "openai-codex";
  ctx.modelRegistry = { getProviderAuthStatus: () => ({ configured }) };
  ctx.ui = {
    setHeader(create) { header = create({ mode: "regular", terminal: { setTitle() {} }, requestRender() {} }, createUiTheme()); },
    setFooter(create) { footer = create({}, createUiTheme(), {}); },
    notify(message, type) { notices.push({ message, type }); },
  };
  ctx.getContextUsage = () => { calls++; return state.usage; };
  factory({ ...pi, on: (event, handler) => handlers.set(event, handler), getThinkingLevel: () => "medium" });
  handlers.get("session_start")({}, ctx);
  assert.equal(notices[0].type, "warning");
  assert.match(notices[0].message, /\/login openai-codex/);
  assert.match(measure.stripTerminalSequences(header.render(100).join("\n")), /\/login openai-codex/);
  for (const width of [24, 40, 80]) assert.ok(header.render(width).every((line) => measure.visibleWidth(line) <= width));
  configured = true;
  assert.doesNotMatch(measure.stripTerminalSequences(header.render(100).join("\n")), /\/login/);
  for (let i = 0; i < 20; i++) footer.render(80);
  assert.equal(calls, 1);
  state.usage = { tokens: 40000, contextWindow: 200000, percent: 20 };
  handlers.get("message_end")({}, ctx);
  assert.match(measure.stripTerminalSequences(footer.render(80)[0]), /20% context/);
  state.usage = { tokens: null, contextWindow: 200000, percent: null };
  handlers.get("session_compact")({}, ctx);
  assert.match(measure.stripTerminalSequences(footer.render(80)[0]), /— \/ 200k/);
  handlers.get("session_shutdown")({}, ctx);
});
