import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionToolContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import type { PanelFactory } from "./helpers.ts";
import type { AskUserResult, UserAnswer } from "../lib/ask-user.js";
import { assistantFixture, present } from "./helpers.ts";

const { parseUserQuestions, collectUserAnswers } = await import(new URL("../dist/lib/ask-user.js", import.meta.url).href) as typeof import("../lib/ask-user.js");
const { createAskUserScreen } = await import(new URL("../dist/ui/ask-user-screen.js", import.meta.url).href) as typeof import("../ui/ask-user-screen.js");
const { default: askUser } = await import(new URL("../dist/extensions/ask-user.js", import.meta.url).href) as typeof import("../extensions/ask-user.js");
const { createUiTheme } = await import(new URL("../dist/ui/theme.js", import.meta.url).href) as typeof import("../ui/theme.js");
const { createHeader } = await import(new URL("../dist/ui/chrome.js", import.meta.url).href) as typeof import("../ui/chrome.js");
const { serializeApproval } = await import(new URL("../dist/lib/approval-queue.js", import.meta.url).href) as typeof import("../lib/approval-queue.js");
const { isUserQuestionTool } = await import(new URL("../dist/lib/workspace-tools.js", import.meta.url).href) as typeof import("../lib/workspace-tools.js");
const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");

const request = { questions: [{ id: "storage", title: "Storage", question: "Where should settings be saved?", options: [
  { id: "profile", label: "Profile", description: "Available in every project.", recommended: true },
  { id: "project", label: "Project", description: "Shared with this repository." },
] }] };
const mouse = (x: number, y: number): TuiMouseEvent => ({ type: "click", button: "left", x, y, width: 100, height: 30,
  screenX: x, screenY: y, shift: false, alt: false, ctrl: false });
function screen(input: unknown = request, renderHeader?: (width: number) => string[]) {
  let answers: UserAnswer[] | undefined, closed: boolean | undefined;
  const tui = { terminal: { rows: 30 }, requestRender() {} };
  const panel = createAskUserScreen({ questions: parseUserQuestions(input), tui, theme: createUiTheme(), measure,
    renderHeader, done: value => { closed = value; }, onSubmit: value => { answers = value; } });
  panel.focused = true;
  return { panel, tui, answers: () => answers, closed: () => closed,
    lines: (width = 100) => panel.render(width).map(measure.stripTerminalSequences) };
}

test("questions validate IDs and bounds, sanitize terminal controls, and always allow written answers", () => {
  const questions = parseUserQuestions(request);
  assert.equal(questions[0].options[0].recommended, true);
  assert.throws(() => parseUserQuestions({ questions: [] }), /one and four/);
  assert.throws(() => parseUserQuestions({ questions: [...request.questions, ...request.questions] }), /Duplicate question/);
  assert.throws(() => parseUserQuestions({ questions: [{ ...request.questions[0], options: [{ id: "one", label: "Only" }] }] }), /two to six/);
  assert.throws(() => parseUserQuestions({ questions: [{ ...request.questions[0], options: [request.questions[0].options[0], request.questions[0].options[0]] }] }), /Duplicate option/);
  assert.throws(() => parseUserQuestions({ questions: [{ ...request.questions[0], question: "x".repeat(2001) }] }), /exceeds/);
  assert.throws(() => parseUserQuestions({ questions: [{ ...request.questions[0], multiSelect: "true" }] }), /true or false/);
  assert.equal(parseUserQuestions({ questions: [{ id: "text", title: "Твой ответ", question: "Write an answer." }] })[0].options.length, 0);
  const clean = parseUserQuestions({ questions: [{ id: "text", title: "Title", question: "\x1b[31mQuestion\x1b[0m" }] });
  assert.equal(clean[0].question, "Question");
  assert.throws(() => collectUserAnswers(questions, [{ selected: new Set(), text: "" }]), /before sending/);
  assert.throws(() => collectUserAnswers(questions, [{ selected: new Set(["invented"]), text: "" }]), /Invalid answer/);
});

test("a recommended option is never sent without explicit selection and review confirmation", async t => {
  const view = screen(); t.after(() => view.panel.dispose()); await view.panel.ready;
  assert.match(view.lines().join("\n"), /Recommended/);
  assert.doesNotMatch(view.lines().join("\n"), /● Profile/);
  assert.equal(view.answers(), undefined);
  view.panel.handleInput("\r");
  assert.match(view.lines().join("\n"), /Review your answers/);
  assert.equal(view.answers(), undefined);
  view.panel.handleInput("\r");
  assert.equal(view.closed(), true);
  assert.deepEqual(view.answers()?.[0].selected, [{ id: "profile", label: "Profile" }]);
  view.panel.handleInput("\r"); // A disposed overlay must ignore late terminal input.
  assert.equal(view.answers()?.length, 1);
});

test("multiple questions retain multi-select and Unicode text while navigating back before sending", async t => {
  const view = screen({ questions: [...request.questions,
    { id: "features", title: "Features", question: "Which features?", multiSelect: true, options: [
      { id: "search", label: "Search" }, { id: "export", label: "Export" }, { id: "sync", label: "Sync" }] },
    { id: "note", title: "Details", question: "Anything else?" }] });
  t.after(() => view.panel.dispose()); await view.panel.ready;
  view.panel.handleInput("2"); view.panel.handleInput("\r");
  view.panel.handleInput(" "); view.panel.handleInput("2");
  assert.match(view.lines().join("\n"), /Which features/);
  view.panel.handleInput("\r");
  view.panel.handleInput("Привет 👋");
  view.panel.handleInput("\x1b[Z"); // Shift+Tab returns to the prior question without losing text.
  assert.match(view.lines().join("\n"), /\[✓\] Search/);
  assert.match(view.lines().join("\n"), /\[✓\] Export/);
  view.panel.handleInput("\t"); view.panel.handleInput("\r");
  assert.match(view.lines().join("\n"), /Привет 👋/);
  view.panel.handleInput("\r");
  assert.deepEqual(view.answers()?.map(answer => [answer.id, answer.selected.map(option => option.id), answer.text]),
    [["storage", ["project"], ""], ["features", ["search", "export"], ""], ["note", [], "Привет 👋"]]);
});

test("multi-select needs an explicit answer, free text can add details, and Escape sends nothing", async t => {
  const view = screen({ questions: [{ ...request.questions[0], multiSelect: true }] });
  t.after(() => view.panel.dispose()); await view.panel.ready;
  view.panel.handleInput("\r");
  assert.match(view.lines().join("\n"), /Choose an option or write your answer/);
  view.panel.handleInput("1"); view.panel.handleInput("Additional context");
  view.panel.handleInput("\r");
  assert.match(view.lines().join("\n"), /Additional context/);
  view.panel.handleInput("\x1b");
  assert.equal(view.closed(), false); assert.equal(view.answers(), undefined);
});

test("paste stays literal and bounded, preserves the previous answer on overflow, and strips terminal escapes", async t => {
  const view = screen({ questions: [{ id: "text", title: "Answer", question: "Your answer?" }] });
  t.after(() => view.panel.dispose()); await view.panel.ready;
  view.panel.handleInput("\x1b[200~1\n\t"); view.panel.handleInput("Привет\x1b[201~");
  assert.equal(view.closed(), undefined);
  view.panel.handleInput("\x1b[200~" + "x".repeat(1500));
  view.panel.handleInput("x".repeat(1500) + "\x1b[201~");
  assert.match(view.lines().join("\n"), /under 2000 bytes/);
  view.panel.handleInput("\r"); view.panel.handleInput("\r");
  assert.match(view.answers()?.[0].text ?? "", /^1\s+Привет$/);
});

test("mouse selection and editing use rendered rows, and every layout stays within narrow terminal bounds", async t => {
  const view = screen(); t.after(() => view.panel.dispose()); await view.panel.ready;
  const optionRow = view.lines().findIndex(line => line.includes("2. ○ Project"));
  assert.ok(optionRow >= 0);
  assert.equal(view.panel.handleMouse(mouse(8, optionRow)).handled, true);
  assert.match(view.lines().join("\n"), /● Project/);
  for (const [width, rows] of [[100, 30], [40, 18], [24, 12], [8, 8], [1, 4]]) {
    view.tui.terminal.rows = rows;
    const lines = view.panel.render(width);
    assert.equal(lines.length, rows); assert.ok(lines.every(line => measure.visibleWidth(line) <= width));
  }
  view.tui.terminal.rows = 30; view.lines();
  view.panel.handleInput("\r");
  const editRow = view.lines().findIndex(line => line.trim() === "1. Storage");
  view.panel.handleMouse(mouse(6, editRow));
  assert.match(view.lines().join("\n"), /Where should settings/);
  view.panel.handleInput("1"); view.panel.handleInput("\r");
  const sendRow = view.lines().findIndex(line => line.includes("› Send answers"));
  view.panel.handleMouse(mouse(6, sendRow));
  assert.equal(view.answers()?.[0].selected[0].id, "profile");
});

test("the common two-option question fits a 24-row terminal together with the shared Pi header", async t => {
  const header = createHeader({ mode: "regular" }, measure, { version: "fixture", getModel: () => undefined,
    getThinkingLevel: () => "off", getCwd: () => "fixture-project" });
  const view = screen(request, width => header.render(width));
  t.after(() => { view.panel.dispose(); header.dispose(); }); await view.panel.ready;
  view.tui.terminal.rows = 24;
  const lines = view.lines(80);
  assert.equal(lines.length, 24);
  assert.match(lines.join("\n"), /Where should settings/);
  assert.match(lines.join("\n"), /○ Profile/);
  assert.match(lines.join("\n"), /○ Project/);
  assert.match(lines.join("\n"), /Your answer/);
});

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
function host(custom?: (create: PanelFactory) => Promise<unknown>) {
  const hooks = new Map<string, () => void>(); let tool!: Tool;
  askUser({ on(name: string, handler: () => void) { hooks.set(name, handler); }, registerTool(value: Tool) { tool = value; },
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI);
  const ctx = { cwd: process.cwd(), mode: "tui", hasUI: true, ui: { custom } } as unknown as ExtensionToolContext;
  return { hooks, ctx, call: async (signal?: AbortSignal) => (await tool.execute("question", request, signal, undefined, ctx)).details as AskUserResult };
}
async function show(create: PanelFactory, keys: string[] = ["\r", "\r"]) {
  let submitted: unknown;
  const panel = create({ children: [], terminal: { rows: 30 }, requestRender() {} }, createUiTheme(), {}, value => { submitted = value; });
  try { await panel.ready; panel.render(100); for (const key of keys) { panel.handleInput(key); panel.render(100); } return submitted; }
  finally { panel.dispose(); }
}

test("the question tool returns structured answers, reports unavailable UI, and never invents a cancelled answer", async () => {
  const view = host(create => show(create));
  assert.equal((await view.call()).status, "answered");
  view.ctx.mode = "print"; view.ctx.hasUI = false;
  assert.deepEqual(await view.call(), { status: "unavailable", answers: [] });
  const cancelled = host(create => show(create, ["\x1b"]));
  assert.deepEqual(await cancelled.call(), { status: "cancelled", answers: [] });
  const broken = host(async () => { throw new Error("Fixture view unavailable"); });
  assert.deepEqual(await broken.call(), { status: "unavailable", answers: [] });
  assert.equal((await host(create => show(create)).call()).status, "answered");
});

test("cancellation while queued never opens a stale question and releases the shared approval queue", async () => {
  let unlock!: () => void, started!: () => void, opens = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const blocking = serializeApproval(async () => { started(); await new Promise<void>(resolve => { unlock = resolve; }); return true; }, false);
  await ready;
  const view = host(async create => { opens++; return show(create); });
  const controller = new AbortController(), pending = view.call(controller.signal);
  controller.abort(); unlock(); await blocking;
  assert.deepEqual(await pending, { status: "cancelled", answers: [] }); assert.equal(opens, 0);
  assert.equal((await view.call()).status, "answered");
});

test("shutdown and tool cancellation close an active question without returning late answers", async () => {
  for (const shutdown of [false, true]) {
    let opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    let panel!: ReturnType<typeof createAskUserScreen>;
    const view = host(create => new Promise(resolve => {
      panel = create({ children: [], terminal: { rows: 30 }, requestRender() {} }, createUiTheme(), {}, resolve);
      opened();
    }));
    const controller = new AbortController(), pending = view.call(controller.signal);
    await ready;
    if (shutdown) present(view.hooks.get("session_shutdown"))(); else controller.abort();
    panel.handleInput("\r"); panel.handleInput("\r");
    assert.deepEqual(await pending, { status: "cancelled", answers: [] });
  }
});

test("only the origin-verified question tool can pass read-only and planning guards", async t => {
  const base = resolve(".local/ask-user-tests"); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "case-")), agentDir = join(cwd, "profile");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(resolve(cwd).startsWith(base + sep)); rmSync(cwd, { recursive: true, force: true });
  });
  assert.equal(isUserQuestionTool("ask_user", [{ name: "ask_user", sourceInfo: { path: "/untrusted/ask-user.js", source: "local", scope: "project", origin: "top-level" } }]), false);
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    additionalExtensionPaths: ["ask-user", "permissions", "workspace"].map(name => fileURLToPath(new URL(`../dist/extensions/${name}.js`, import.meta.url))) });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager: settings, modelRuntime: runtime,
    resourceLoader: loader, sessionManager: manager });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, async custom(create: PanelFactory) { return show(create); } } as unknown as ExtensionUIContext });
  session.agent.state.messages.push(assistantFixture([{ type: "toolCall", id: "ask-fixture", name: "codemode", arguments: {} }], { stopReason: "toolUse" }));
  const tools = session.extensionRunner.createToolContext("ask-fixture", undefined);
  writeFileSync(join(cwd, "sample.txt"), "original");
  for (const mode of ["full", "ask", "read-only"]) {
    await session.prompt(`/permissions ${mode}`);
    for (const planning of [false, true]) {
      if (planning) await session.prompt("/plan start");
      const answer = await tools.executeTool("ask_user", request);
      assert.equal(answer.isError, false, JSON.stringify(answer));
      const payload = JSON.parse(answer.result.content.map(part => part.type === "text" ? part.text : "").join("")) as AskUserResult;
      assert.equal(payload.status, "answered");
      if (planning || mode === "read-only") {
        assert.equal((await tools.executeTool("write", { path: "sample.txt", content: "must stay blocked" })).isError, true);
        assert.equal(readFileSync(join(cwd, "sample.txt"), "utf8"), "original");
      }
      if (planning) await session.prompt("/plan cancel");
    }
  }
});
