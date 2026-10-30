import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createEscapeExitEditor } from "../dist/ui/escape-exit.js";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const require = createRequire(piEntry);
const { matchesKey, visibleWidth, stripTerminalSequences } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
const { CustomEditor } = await import(new URL("./modes/interactive/components/custom-editor.js", piEntry).href);
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", piEntry).href);

function editorState(showEffort = false) {
  const state = { idle: true, pending: false, exits: 0, cancels: 0, effort: "medium", modeSwitches: 0 };
  const tui = { children: [], requestRender() {}, terminal: { columns: 80, rows: 24 } };
  const Editor = createEscapeExitEditor(CustomEditor, matchesKey, {
    isIdle: () => state.idle, hasPendingMessages: () => state.pending,
  }, showEffort ? { getLevel: () => state.effort } : undefined, () => { state.modeSwitches++; });
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

test("inset editor keeps text wrapping, cursor clicks, and native border updates aligned", () => {
  const { editor } = editorState();
  editor.setText("hello");
  editor.borderColor = (value) => `\x1b[34m${value}\x1b[39m`;
  const lines = editor.render(80);
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  assert.equal(stripTerminalSequences(lines[0]), "  " + "─".repeat(76) + "  ");
  assert.ok(!lines.join("").includes("\x1b[34m"));
  editor.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 80, height: 3 });
  editor.handleInput("X");
  assert.equal(editor.getText(), "Xhello");
  for (const width of [1, 2, 8, 24]) {
    assert.ok(editor.render(width).every((line) => visibleWidth(line) <= width));
  }
});

test("effort updates above the input and mouse coordinates follow the added row", () => {
  const { editor, state } = editorState(true);
  assert.equal(stripTerminalSequences(editor.render(80)[0]), " ".repeat(72) + "medium  ");
  assert.equal(stripTerminalSequences(editor.render(80)[1]), "  " + "─".repeat(76) + "  ");
  state.effort = "high";
  assert.ok(stripTerminalSequences(editor.render(80)[0]).endsWith("high  "));
  editor.setText("hello");
  editor.render(80);
  editor.handleMouse({ type: "click", button: "left", x: 2, y: 2, width: 80, height: 4 });
  editor.handleInput("X");
  assert.equal(editor.getText(), "Xhello");
  editor.setWorkingStatusIndicator({ renderInBorder: () => "Working…", renderSpinnerInBorder: () => "*" });
  let border = stripTerminalSequences(editor.render(80)[1]);
  assert.match(border, /Working…/);
  assert.doesNotMatch(border, /high/);
  editor.setText(Array.from({ length: 30 }, (_, i) => `Line ${i}`).join("\n"));
  border = stripTerminalSequences(editor.render(80)[1]);
  assert.match(border, /more/);
  editor.setText("");
  for (const width of [1, 2, 8, 16, 24, 80]) assert.ok(editor.render(width).every((line) => visibleWidth(line) <= width), JSON.stringify({ width, lines: editor.render(width).map(stripTerminalSequences) }));
});
