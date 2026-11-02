import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const { captureFlashes } = await import(new URL("../dist/bin/flash-interface.js", import.meta.url).href) as typeof import("../bin/flash-interface.js");
const { clearFlash, visibleFlash } = await import(new URL("../dist/lib/flash-status.js", import.meta.url).href) as typeof import("../lib/flash-status.js");
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
const { createEscapeExitEditor } = await import(new URL("../dist/ui/escape-exit.js", import.meta.url).href) as typeof import("../ui/escape-exit.js");
const { setAvailableUpdates, setUpdateNoticeVisible } = await import(new URL("../dist/lib/update-status.js", import.meta.url).href) as typeof import("../lib/update-status.js");
const { getAppearance, setAppearance } = await import(new URL("../dist/lib/appearance.js", import.meta.url).href) as typeof import("../lib/appearance.js");

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const require = createRequire(piEntry);
const { matchesKey, visibleWidth, stripTerminalSequences } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
const { CustomEditor } = await import(new URL("./modes/interactive/components/custom-editor.js", piEntry).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js");
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", piEntry).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");

function editorState(showEffort = false, now = Date.now) {
  const state = { idle: true, pending: false, exits: 0, cancels: 0, effort: "medium", modeSwitches: 0 };
  const tui = { children: [] as Component[], requestRender() {}, terminal: { columns: 80, rows: 24 } };
  const Editor = createEscapeExitEditor(CustomEditor, matchesKey, {
    isIdle: () => state.idle, hasPendingMessages: () => state.pending,
  }, showEffort ? { getLevel: () => state.effort } : undefined, () => { state.modeSwitches++; }, now);
  const theme = { borderColor: (text: string) => text, selectList: {} };
  const editor = new Editor((tui as unknown as ConstructorParameters<typeof Editor>[0]), theme as EditorTheme, new KeybindingsManager(), { embedWorkingStatus: true });
  editor.onCtrlD = () => { state.exits++; };
  editor.onEscape = () => { state.cancels++; };
  return { editor, state, tui };
}

test("Escape exits an idle empty editor using the native exit handler", () => {
  for (const escape of ["\x1b", "\x1b[27u"]) {
    const { editor, state } = editorState();
    editor.handleInput(escape);
    assert.equal(state.exits, 1);
    assert.equal(state.cancels, 0);
  }
});

test("Shift+Tab switches mode before Pi's thinking action and preserves the draft", () => {
  const { editor, state } = editorState(true);
  let thinkingChanges = 0;
  editor.onAction("app.thinking.cycle", () => { thinkingChanges++; });
  editor.setText("Unsent draft");
  for (const key of ["\x1b[Z", "\x1b[9;2u"]) editor.handleInput(key);
  assert.equal(state.modeSwitches, 2);
  assert.equal(thinkingChanges, 0);
  assert.equal(editor.getText(), "Unsent draft");
  assert.equal(state.effort, "medium");
});

test("Escape during work or queued input uses Pi's native cancellation", () => {
  for (const busy of [{ idle: false }, { pending: true }]) {
    const { editor, state } = editorState();
    Object.assign(state, busy);
    editor.handleInput("\x1b");
    assert.equal(state.exits, 0);
    assert.equal(state.cancels, 1);
  }
});

test("Escape preserves drafts instead of exiting", () => {
  const { editor, state } = editorState();
  editor.setText("Unsent draft");
  editor.handleInput("\x1b");
  assert.equal(state.exits, 0);
  assert.equal(editor.getText(), "Unsent draft");
});

test("Escape closes autocomplete instead of exiting", () => {
  const { editor, state } = editorState();
  editor.isShowingAutocomplete = () => true;
  editor.handleInput("\x1b");
  assert.equal(state.exits, 0);
  assert.equal(state.cancels, 0);
});

test("Escape cancels running user shell commands instead of exiting", () => {
  const { editor, state, tui } = editorState();
  const shell = { getCommand: () => "sleep 10", status: "running" };
  tui.children.push({ children: [shell] } as unknown as Component);
  editor.handleInput("\x1b");
  assert.equal(state.exits, 0);
  assert.equal(state.cancels, 1);
  shell.status = "completed";
  editor.handleInput("\x1b");
  assert.equal(state.exits, 1);
});

test("Ctrl+D and ordinary typing retain their native behavior", () => {
  const { editor, state } = editorState();
  editor.handleInput("hello");
  assert.equal(editor.getText(), "hello");
  editor.setText("");
  editor.handleInput("\x04");
  assert.equal(state.exits, 1);
});

test("full-width editor keeps its inset chevron, text wrapping, cursor clicks, and native borders aligned", () => {
  const { editor } = editorState();
  editor.setText("hello");
  editor.borderColor = (value) => `\x1b[34m${value}\x1b[39m`;
  const lines = editor.render(80);
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  assert.equal(stripTerminalSequences(lines[0]), "─".repeat(80));
  assert.match(lines[0], /\x1b\[22;2m/);
  assert.match(stripTerminalSequences(lines[1]), /^❯ hello/);
  assert.ok(!lines.join("").includes("\x1b[34m"));
  editor.handleMouse({screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false,  type: "click", button: "left", x: 2, y: 1, width: 80, height: 3 });
  editor.handleInput("X");
  assert.equal(editor.getText(), "Xhello");
  editor.handleMouse({screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false,  type: "click", button: "left", x: 5, y: 1, width: 80, height: 3 });
  editor.handleInput("Y");
  assert.equal(editor.getText(), "XheYllo");
  assert.ok(!editor.getText().includes("❯"));
  editor.setText("0123456789".repeat(12) + "\nnext line");
  for (const width of [1, 2, 8, 24]) {
    assert.ok(editor.render(width).every((line) => visibleWidth(line) <= width));
  }
  editor.setText("0123456789".repeat(12) + "\nПривет 👋\nnext line");
  for (const width of [8, 9, 12, 24, 80]) assert.ok(editor.render(width).every((line) => visibleWidth(line) <= width));
});

test("effort alternates with update status while Working and cursor clicks keep the grid", (t) => {
  t.after(() => setAvailableUpdates([]));
  const { editor, state } = editorState(true);
  t.after(() => editor.dispose());
  assert.equal(stripTerminalSequences(editor.render(80)[0]).trim(), "medium");
  assert.equal(stripTerminalSequences(editor.render(80)[1]), "─".repeat(80));
  state.effort = "high";
  assert.equal(stripTerminalSequences(editor.render(80)[0]).trim(), "high");
  assert.match(editor.render(80)[0], /38;2;\d+;\d+;\d+mh/);
  setAvailableUpdates([{ kind: "agent", version: "1.2.0", current: "1.1.0", command: "pi update", message: "Update available" }]);
  assert.equal(stripTerminalSequences(editor.render(80)[0]).trim(), "high");
  setUpdateNoticeVisible(true);
  assert.ok(stripTerminalSequences(editor.render(80)[0]).endsWith("Update 1.2.0 · pi update  "));
  assert.match(editor.render(80)[0], /38;2;255;193;7mUpdate/);
  assert.match(editor.render(80)[0], /38;2;175;135;255m1\.2\.0/);
  editor.setText("hello");
  editor.render(80);
  editor.handleMouse({screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false,  type: "click", button: "left", x: 2, y: 2, width: 80, height: 4 });
  editor.handleInput("X");
  assert.equal(editor.getText(), "Xhello");
  editor.setWorkingStatusIndicator({ renderInBorder: () => "Working…", renderSpinnerInBorder: () => "*" } as unknown as Parameters<typeof editor.setWorkingStatusIndicator>[0]);
  const status = stripTerminalSequences(editor.render(80)[0]);
  assert.ok(status.startsWith("  Working…"));
  assert.ok(status.endsWith("Update 1.2.0 · pi update  "));
  let border = stripTerminalSequences(editor.render(80)[1]);
  assert.doesNotMatch(border, /Working…/);
  assert.doesNotMatch(border, /high/);
  editor.setText(Array.from({ length: 30 }, (_, i) => `Line ${i}`).join("\n"));
  border = stripTerminalSequences(editor.render(80)[1]);
  assert.match(border, /more/);
  editor.setText("");
  for (const width of [1, 2, 8, 16, 24, 80]) assert.ok(editor.render(width).every((line) => visibleWidth(line) <= width), JSON.stringify({ width, lines: editor.render(width).map((line) => stripTerminalSequences(line)) }));
  setUpdateNoticeVisible(false);
  assert.ok(stripTerminalSequences(editor.render(80)[0]).endsWith("high  "));
  state.effort = "xhigh";
  assert.match(editor.render(80)[0], /38;2;\d+;\d+;\d+mx/);
  for (const width of [1, 2, 8, 16, 24, 80]) assert.ok(editor.render(width).every((line) => visibleWidth(line) <= width));
});

test("paused high and xhigh labels use their exact solid colors, independent of theme and accent", (t) => {
  const previous = getAppearance();
  t.after(() => setAppearance(previous));
  const { editor, state } = editorState(true);
  t.after(() => editor.dispose());
  for (const mode of ["dark", "light"] as const) for (const color of ["default", "green", "purple"] as const) {
    setAppearance({ mode, color });
    for (const [level, rgb] of [["high", "177;185;249"], ["xhigh", "175;135;255"]]) {
      state.effort = level;
      for (const [idle, focused] of [[true, true], [true, false], [false, false]]) {
        state.idle = idle; editor.focused = focused;
        const label = editor.render(80)[0];
        assert.ok(label.includes(`\x1b[38;2;${rgb}m${level}\x1b[39m`), `${mode}/${color}/${level}`);
        assert.deepEqual([...label.matchAll(/38;2;(\d+;\d+;\d+)m/g)].map(match => match[1]), [rgb]);
        assert.equal(stripTerminalSequences(label).trim(), level);
      }
    }
  }
});

test("idle effort stays static without scheduling timers or changing the draft and selected level", (t) => {
  let time = 0, scheduled = 0;
  const nativeInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback: () => void, delay?: number) => { scheduled++; return nativeInterval(callback, delay); });
  const { editor, state } = editorState(true, () => time);
  t.after(() => editor.dispose());
  editor.focused = true;
  editor.setText("Keep this draft");
  for (const level of ["high", "xhigh", "max"]) {
    state.effort = level;
    const first = editor.render(80)[0];
    time += 1000;
    assert.equal(editor.render(80)[0], first, "unrelated idle renders must not advance the glow phase");
    assert.equal(stripTerminalSequences(first).trim(), level);
    assert.equal(state.effort, level); assert.equal(editor.getText(), "Keep this draft");
  }
  assert.equal(scheduled, 0, "idle animation must not even allocate a repeating timer");
  state.idle = false;
  for (let i = 0; i < 10; i++) editor.render(80);
  assert.equal(scheduled, 1, "active renders share one animation timer");
  editor.dispose(); editor.render(80);
  assert.equal(scheduled, 1, "a disposed editor cannot restart its animation");
});

test("high, xhigh and max animate only during work, pausing for idle, updates, blur and disposal", async (t) => {
  let time = 0, renders = 0;
  // Node 22's experimental MockTimers requeues intervals cleared inside their
  // own callback. Exercise actual timer cancellation for this lifecycle check.
  const tick = async (duration = 160) => {
    time += duration;
    await new Promise((resolve) => setTimeout(resolve, duration));
  };
  const { editor, state, tui } = editorState(true, () => time);
  state.idle = false;
  tui.requestRender = () => { renders++; };
  editor.focused = true;
  t.after(() => { editor.dispose(); setAvailableUpdates([]); });
  for (const level of ["high", "xhigh", "max"]) {
    state.effort = level;
    const first = editor.render(80);
    const before = renders;
    await tick();
    assert.ok(renders > before, `${level} must request repaints during work`);
    const next = editor.render(80);
    assert.notEqual(first[0], next[0]);
    assert.equal(stripTerminalSequences(first[0]).trim(), level);
    assert.deepEqual(first.slice(1), next.slice(1), "only the corner label animates");
    const channels = [...next[0].matchAll(/38;2;(\d+;\d+;\d+)m/g)].map((match) => match[1]);
    assert.ok(new Set(channels).size > 1, `${level} must use visible per-letter color changes`);
  }
  // Settlement/cancellation may happen before another terminal frame. The
  // timer must notice the idle state without requesting one more repaint.
  state.idle = true;
  const idle = renders; await tick(); assert.equal(renders, idle);
  const frozen = editor.render(80)[0];
  await tick(); assert.equal(renders, idle); assert.equal(editor.render(80)[0], frozen);
  state.idle = false; editor.render(80);
  await tick(); assert.ok(renders > idle, "a subsequent run must restart the animation");
  setAvailableUpdates([{ kind: "agent", version: "1.2.0", current: "1.1.0", command: "pi update", message: "Fixture" }]);
  setUpdateNoticeVisible(true); editor.render(80);
  const paused = renders; await tick(); assert.equal(renders, paused);
  setUpdateNoticeVisible(false); editor.render(80);
  await tick(); assert.ok(renders > paused);
  state.effort = "medium"; editor.render(80);
  const neutral = renders; await tick(); assert.equal(renders, neutral);
  state.effort = "high"; editor.render(80);
  editor.focused = false;
  const blurred = renders; await tick(); assert.equal(renders, blurred);
  editor.focused = true; editor.render(80);
  await tick(); assert.ok(renders > blurred);
  state.idle = true;
  const cancelled = renders; await tick(); assert.equal(renders, cancelled);
  state.idle = false; editor.render(80);
  await tick(); assert.ok(renders > cancelled, "work after cancellation must animate again");
  assert.equal(state.effort, "high");
  editor.dispose();
  const stopped = renders; await tick(); assert.equal(renders, stopped);
});

test("a copy confirmation takes the input corner instead of the alternate screen", (t) => {
  t.after(() => clearFlash());
  let renders = 0;
  const host: import("../bin/flash-interface.js").FlashHost & { flash(message: string): void } = { flash() { assert.fail("the native flash stack must not be used while relocated"); } };
  const restore = captureFlashes(host, () => { renders++; });
  assert.ok(restore, "the adapter must attach to a host that flashes");
  const { editor, state } = editorState(true);
  editor.focused = true;
  // Effort holds the corner until something is copied.
  assert.match(stripTerminalSequences(editor.render(80)[0]), /medium/);
  host.flash("Copied!");
  assert.equal(renders, 1, "a notice repaints the input once");
  assert.equal(visibleFlash(80), "Copied!");
  const corner = stripTerminalSequences(editor.render(80)[0]);
  assert.match(corner, /Copied!/);
  assert.doesNotMatch(corner, /medium/, "the notice replaces the effort label while it lasts");
  assert.ok(editor.render(80)[0].endsWith("  "), "the corner keeps the shared inset");
  // The level comes back by itself once the notice expires.
  clearFlash();
  assert.match(stripTerminalSequences(editor.render(80)[0]), /medium/);
  // An unreadable corner keeps the level rather than truncating the notice.
  host.flash("Copied a very long selection to the clipboard");
  assert.doesNotMatch(stripTerminalSequences(editor.render(24)[0]), /Copied/);
  clearFlash();
  state.effort = "high";
  restore();
  assert.equal(visibleFlash(80), undefined, "restoring clears any notice still showing");
  assert.equal(typeof host.flash, "function", "the native flash stack is handed back");
  host.flash = () => {};
});

test("a replaced session keeps its input mounted and readable until the next one binds", async () => {
  let stale = false;
  const live = <T>(value: T): T => {
    if (stale) throw new Error("Extension context is no longer active: the session was replaced.");
    return value;
  };
  const handlers = new Map();
  const pi = {
    on: ((name, handler) => { handlers.set(name, handler); return () => {}; }) satisfies ExtensionAPI["on"],
    events: { emit() {} },
    getThinkingLevel: () => live("high"),
    setThinkingLevel() {},
  };
  const tui = { children: [] as Component[], requestRender() {}, terminal: { columns: 80, rows: 24 } };
  let editor!: InstanceType<ReturnType<typeof createEscapeExitEditor>>;
  const ctx = {
    mode: "tui", hasUI: true,
    isIdle: () => live(false),
    hasPendingMessages: () => live(false),
    get model() { return live({ id: "m", provider: "anthropic", api: "messages" }); },
    ui: {
      setEditorComponent: (create: NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>) => { editor = create(tui as unknown as import("@earendil-works/pi-tui").TUI, { borderColor: (text: string) => text, selectList: {} } as EditorTheme, new KeybindingsManager()) as typeof editor; },
      notify() {},
    },
  };
  const escapeExit = (await import(new URL("../dist/extensions/escape-exit.js", import.meta.url).href) as typeof import("../extensions/escape-exit.js")).default;
  escapeExit(pi as unknown as ExtensionAPI);
  handlers.get("session_start")({}, ctx);
  editor.focused = true;
  const mounted = editor.render(80).map(stripTerminalSequences);
  assert.match(mounted[0], /high/);
  // Pi keeps this input on screen while the replacement loads; the context that
  // created it throws on every read from here on.
  handlers.get("session_shutdown")({ type: "session_shutdown", reason: "new" });
  stale = true;
  assert.deepEqual(editor.render(80).map(stripTerminalSequences), mounted, "the input keeps what its session last reported");
  // Quitting still releases it.
  stale = false;
  handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
  editor.dispose();
});
