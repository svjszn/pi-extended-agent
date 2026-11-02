import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assistantFixture } from "./helpers.ts";
import type { Panel, PanelFactory } from "./helpers.ts";
const { bundledRuntime } = await import(new URL("../dist/bin/runtime.js", import.meta.url).href) as typeof import("../bin/runtime.js");
const { installSessionInterface, rewriteResumeHint } = await import(new URL("../dist/bin/session-interface.js", import.meta.url).href) as typeof import("../bin/session-interface.js");
const { createSessionScreen } = await import(new URL("../dist/ui/session-screen.js", import.meta.url).href) as typeof import("../ui/session-screen.js");
const { createUiTheme } = await import(new URL("../dist/ui/theme.js", import.meta.url).href) as typeof import("../ui/theme.js");
const runtime = bundledRuntime();
const api = await import(pathToFileURL(join(runtime.packageDir, "dist/bundle/index.js")).href);
const source = await import(pathToFileURL(runtime.entry).href);
const require = createRequire(pathToFileURL(runtime.entry));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", pathToFileURL(runtime.entry)).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");
const keys = new KeybindingsManager(); measure.setKeybindings(keys);
api.initTheme("dark", false); source.initTheme("dark", false);
installSessionInterface(api, measure, runtime.version); installSessionInterface(source as unknown as Parameters<typeof installSessionInterface>[0], measure, runtime.version);
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function profile(t: TestContext) {
  const base = resolve(".local/session-screen-tests"); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "case-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(resolve(directory).startsWith(base + sep)); rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
function sessions(count = 12): SessionInfo[] {
  return Array.from({ length: count }, (_, i) => ({ path: `/fixture/session-${i}.jsonl`, id: `session-${i}`, cwd: "/fixture/project",
    name: `Chat ${i}`, firstMessage: `Original task ${i}`, allMessagesText: i === 8 ? "A hidden phrase in a later message" : `Original task ${i}`,
    created: new Date(2026, 10, 1), modified: new Date(2026, 10, 2, 12, 60 - i), messageCount: i + 2 }));
}
function selector(engine = api, current = async () => sessions(), all = async () => [...sessions(), { ...sessions(1)[0], id: "other", path: "/fixture/other.jsonl", name: "Other project", cwd: "/fixture/other" }]) {
  const state = { selected: "", cancelled: false, exited: false };
  const native = new engine.SessionSelectorComponent(current, all, (path: string) => { state.selected = path; },
    () => { state.cancelled = true; }, () => { state.exited = true; }, () => {}, { keybindings: keys });
  return { native, state };
}

test("the native -r/--resume picker uses the shared screen and searches all message text", async (t) => {
  profile(t);
  for (const engine of [api, source]) {
    const { native, state } = selector(engine); native.getSessionList().focused = true;
    native.render(90); await settle();
    const plain = () => measure.stripTerminalSequences(native.render(90).join("\n"));
    assert.match(plain(), /Resume chat/); assert.match(plain(), /Current project/); assert.match(plain(), /Chat 0/);
    native.getSessionList().handleInput('"hidden phrase"');
    assert.match(plain(), /Chat 8/); assert.doesNotMatch(plain(), /Chat 0/);
    native.getSessionList().handleInput("\r");
    assert.equal(state.selected, "/fixture/session-8.jsonl"); assert.equal(state.cancelled, false);
  }
});

test("session search switches project scope, shows empty results, and cancels without selecting", async (t) => {
  profile(t);
  const { native, state } = selector(); native.render(90); await settle();
  native.handleInput("\t"); await settle();
  native.handleInput("Other");
  let text = measure.stripTerminalSequences(native.render(90).join("\n"));
  assert.match(text, /All projects/); assert.match(text, /Other project/); assert.match(text, /fixture\/other/);
  native.handleInput("does-not-exist"); text = measure.stripTerminalSequences(native.render(90).join("\n"));
  assert.match(text, /No matching chats/);
  native.handleInput("\x1b"); assert.equal(state.cancelled, true); assert.equal(state.selected, "");
});

test("session navigation and resizing keep the selected chat visible and every line bounded", async (t) => {
  profile(t);
  const { native } = selector(); await settle();
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  const panel = createSessionScreen({ selector: native, tui, theme: createUiTheme(), measure, done() {} });
  await panel.ready;
  for (const [width, rows] of [[90, 24], [24, 12], [8, 8], [1, 4]]) {
    tui.terminal.rows = rows;
    const lines = panel.render(width); assert.equal(lines.length, rows); assert.ok(lines.every((line) => measure.visibleWidth(line) <= width));
  }
  tui.terminal.rows = 24; panel.render(90);
  for (let i = 0; i < 10; i++) panel.handleInput("\x1b[B");
  assert.match(measure.stripTerminalSequences(panel.render(90).join("\n")), /› Chat 10/);
  panel.handleInput("\x1b"); panel.dispose();
});

test("cancelling the startup picker aborts unfinished history loading", async (t) => {
  profile(t);
  let aborted = false;
  const native = new api.SessionSelectorComponent((_progress: unknown, signal: AbortSignal) => new Promise(() => {
    signal.addEventListener("abort", () => { aborted = true; });
  }), async () => [], () => {}, () => {}, () => {}, () => {}, { keybindings: keys });
  native.render(80); native.getSessionList().handleInput("\x1b");
  assert.equal(aborted, true);
});

test("/resume opens the shared overlay and delegates selection to Pi's resume handler", async (t) => {
  profile(t);
  t.mock.method(api.SessionManager, "list", async () => sessions());
  t.mock.method(api.SessionManager, "listAll", async () => sessions());
  const host = Object.create(api.InteractiveMode.prototype), state = { selected: "", closed: false, panel: undefined as unknown as Panel };
  host.runtimeHost = { session: { model: undefined, thinkingLevel: "medium", sessionManager: {
    getCwd: () => "/fixture/project", getSessionDir: () => "/fixture/sessions", usesDefaultSessionDir: () => false, getSessionFile: () => undefined } } };
  host.keybindings = keys; host.ui = { requestRender() {} };
  host.handleResumeSession = async (path: string) => { state.selected = path; };
  host.showError = (message: string) => assert.fail(message);
  host.createExtensionUIContext = () => ({ custom: (create: PanelFactory) => new Promise<void>((resolve) => {
    state.panel = create({ terminal: { rows: 24 }, requestRender() {} }, createUiTheme(), {}, () => { state.closed = true; state.panel.dispose(); resolve(); });
  }) });
  host.showSessionSelector(); await state.panel.ready; await settle();
  state.panel.handleInput("hidden phrase"); state.panel.handleInput("\r");
  await settle(); assert.equal(state.selected, "/fixture/session-8.jsonl"); assert.equal(state.closed, true);
});

test("exit hints advertise both resume aliases and preserve custom session-directory quoting", () => {
  const id = "01a19ad3-4da7-77e7-8133-e1e207f81fd7";
  assert.equal(rewriteResumeHint(`To resume this session: pi --session ${id}\n`), `To resume this session: pi --resume ${id} (or pi -r ${id})\n`);
  assert.equal(rewriteResumeHint(`\x1b[2mTo resume this session:\x1b[22m pi --session-dir 'custom sessions' --session ${id}\n`),
    `\x1b[2mTo resume this session:\x1b[22m pi --session-dir 'custom sessions' --resume ${id} (or pi --session-dir 'custom sessions' -r ${id})\n`);
  assert.equal(rewriteResumeHint("To resume this session: pi --session custom.id_1\n"), "To resume this session: pi --resume custom.id_1 (or pi -r custom.id_1)\n");
  for (const text of ["Ordinary output\n", `Example: pi --session ${id}\n`, "To resume this session: pi --session invalid/id\n"]) {
    assert.equal(rewriteResumeHint(text), text);
  }
});

test("native shutdown keeps its cleanup and signal behavior while replacing the exit hint", async (t) => {
  const directory = profile(t);
  const manager = api.SessionManager.create(directory, join(directory, "custom sessions"));
  manager.appendMessage({ role: "user", content: "Fixture conversation", timestamp: Date.now() });
  manager.appendMessage(assistantFixture([{ type: "text", text: "Fixture reply" }]));
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const exited = new Error("Fixture exit");
  const exit = t.mock.method(process, "exit", (() => { throw exited; }) as typeof process.exit);
  try {
    for (const fromSignal of [false, true]) {
      const writes: string[] = [], calls: string[] = [];
      const originalWrite = process.stdout.write;
      const write = t.mock.method(process.stdout, "write", function (this: typeof process.stdout, chunk: unknown, ...args: unknown[]) {
        if (typeof chunk === "string" && chunk.includes("To resume")) { writes.push(chunk); return true; }
        return Reflect.apply(originalWrite, this, [chunk, ...args]);
      } as typeof process.stdout.write);
      const host = Object.create(api.InteractiveMode.prototype);
      host.runtimeHost = { session: { sessionManager: manager }, dispose: async () => { calls.push("dispose"); } };
      host.themeController = { disableAutoSync: () => { calls.push("theme"); } };
      host.ui = { terminal: { drainInput: async () => { calls.push("drain"); } } };
      host.stop = () => { calls.push("stop"); };
      try {
        await assert.rejects(() => host.shutdown({ fromSignal }), (error) => error === exited);
        assert.equal(process.stdout.write, write, "the stdout adapter must be released on exit");
        assert.deepEqual(calls, fromSignal ? ["dispose", "theme", "drain", "stop"] : ["theme", "drain", "stop", "dispose"]);
        const output = measure.stripTerminalSequences(writes.join(""));
        if (fromSignal) assert.equal(output, "");
        else { assert.ok(output.includes(` --resume ${manager.getSessionId()}`)); assert.ok(output.includes(` -r ${manager.getSessionId()}`)); assert.doesNotMatch(output, / --session /); assert.ok(output.includes("--session-dir")); }
      } finally { write.mock.restore(); }
    }
  } finally {
    exit.mock.restore();
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty); else Reflect.deleteProperty(process.stdout, "isTTY");
  }
});
