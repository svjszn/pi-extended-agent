import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createEscapeExitEditor } from "../dist/ui/escape-exit.js";
import { setAvailableUpdates, setUpdateNoticeVisible } from "../dist/lib/update-status.js";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const require = createRequire(piEntry);
const { matchesKey, visibleWidth, stripTerminalSequences } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
const { CustomEditor } = await import(new URL("./modes/interactive/components/custom-editor.js", piEntry).href);
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", piEntry).href);

function editorState(showEffort = false, now = Date.now) {
  const state = { idle: true, pending: false, exits: 0, cancels: 0, effort: "medium", modeSwitches: 0 };
  const tui = { children: [], requestRender() {}, terminal: { columns: 80, rows: 24 } };
  const Editor = createEscapeExitEditor(CustomEditor, matchesKey, {
    isIdle: () => state.idle, hasPendingMessages: () => state.pending,
  }, showEffort ? { getLevel: () => state.effort } : undefined, () => { state.modeSwitches++; }, now);
  const theme = { borderColor: (text) => text, selectList: {} };
  const editor = new Editor(tui, theme, new KeybindingsManager(), { embedWorkingStatus: true });
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
  tui.children.push({ children: [shell] });
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
  editor.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 80, height: 3 });
  editor.handleInput("X");
  assert.equal(editor.getText(), "Xhello");
  editor.handleMouse({ type: "click", button: "left", x: 5, y: 1, width: 80, height: 3 });
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
  editor.handleMouse({ type: "click", button: "left", x: 2, y: 2, width: 80, height: 4 });
  editor.handleInput("X");
  assert.equal(editor.getText(), "Xhello");
  editor.setWorkingStatusIndicator({ renderInBorder: () => "Working…", renderSpinnerInBorder: () => "*" });
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
  for (const width of [1, 2, 8, 16, 24, 80]) assert.ok(editor.render(width).every((line) => visibleWidth(line) <= width), JSON.stringify({ width, lines: editor.render(width).map(stripTerminalSequences) }));
  setUpdateNoticeVisible(false);
  assert.ok(stripTerminalSequences(editor.render(80)[0]).endsWith("high  "));
  state.effort = "xhigh";
  assert.match(editor.render(80)[0], /38;2;\d+;\d+;\d+mx/);
  for (const width of [1, 2, 8, 16, 24, 80]) assert.ok(editor.render(width).every((line) => visibleWidth(line) <= width));
});

test("high, xhigh and max animate in the input corner, pausing for updates and stopping on blur or disposal", async (t) => {
  let time = 0, renders = 0;
  // Node 22's experimental MockTimers requeues intervals cleared inside their
  // own callback. Exercise actual timer cancellation for this lifecycle check.
  const tick = async (duration = 160) => {
    time += duration;
    await new Promise((resolve) => setTimeout(resolve, duration));
  };
  const { editor, state, tui } = editorState(true, () => time);
  tui.requestRender = () => { renders++; };
  editor.focused = true;
  t.after(() => { editor.dispose(); setAvailableUpdates([]); });
  for (const level of ["high", "xhigh", "max"]) {
    state.effort = level;
    const first = editor.render(80);
    const before = renders;
    await tick();
    assert.ok(renders > before, `${level} must request idle repaints`);
    const next = editor.render(80);
    assert.notEqual(first[0], next[0]);
    assert.equal(stripTerminalSequences(first[0]).trim(), level);
    assert.deepEqual(first.slice(1), next.slice(1), "only the corner label animates");
    const channels = [...next[0].matchAll(/38;2;(\d+;\d+;\d+)m/g)].map((match) => match[1]);
    assert.ok(new Set(channels).size > 1, `${level} must use visible per-letter color changes`);
  }
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
  editor.dispose();
  const stopped = renders; await tick(); assert.equal(renders, stopped);
});
