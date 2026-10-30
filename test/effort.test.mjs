import assert from "node:assert/strict";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createUiTheme } from "../dist/ui/theme.js";

const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const require = createRequire(entry);
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")));
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": fileURLToPath(entry),
  "@earendil-works/pi-ai": join(dirname(findPackageJSON("@earendil-works/pi-ai", entry)), "dist", "compat.js"),
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
} });
const factory = await jiti.import(fileURLToPath(new URL("../dist/extensions/effort.js", import.meta.url)), { default: true });
const editorFactory = await jiti.import(fileURLToPath(new URL("../dist/extensions/escape-exit.js", import.meta.url)), { default: true });
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", entry));

function fixture() {
  const state = { level: "medium", changes: [], notices: [] };
  const events = new Map();
  let command;
  const pi = { on: (event, callback) => events.set(event, callback), registerCommand: (_name, value) => { command = value; },
    getThinkingLevel: () => state.level, setThinkingLevel: (value) => { state.level = value; state.changes.push(value); } };
  factory(pi);
  const ctx = { mode: "print", hasUI: true, cwd: process.cwd(), model: { id: "test-model", reasoning: true, thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: null } },
    ui: { notify: (message, type) => state.notices.push({ message, type }) } };
  events.get("session_start")({}, ctx);
  return { state, ctx, command, events, pi };
}

test("Shift+arrows adjust supported effort through the real editor, clamp at bounds and preserve input", () => {
  const { state, ctx, events, pi } = fixture();
  let editor, renders = 0;
  ctx.mode = "tui";
  ctx.ui.setEditorComponent = (create) => { editor = create({ children: [], terminal: { rows: 24, columns: 80 }, requestRender() { renders++; } },
    { borderColor: (s) => s, selectList: {} }, new KeybindingsManager()); };
  editorFactory(pi); events.get("session_start")({}, ctx);
  editor.setText("Keep this draft");
  editor.handleInput("\x1b[1;2C"); assert.equal(state.level, "high");
  editor.handleInput("\x1b[1;2C"); assert.equal(state.level, "xhigh");
  editor.handleInput("\x1b[1;2C"); assert.equal(state.level, "xhigh");
  for (let i = 0; i < 4; i++) editor.handleInput("\x1b[1;2D");
  assert.equal(state.level, "low");
  assert.deepEqual(state.changes, ["high", "xhigh", "high", "medium", "low"]);
  assert.equal(editor.getText(), "Keep this draft"); assert.ok(renders > 0);
  // Read the current model on each key press, including models without reasoning.
  ctx.model = { id: "simple-model", reasoning: false }; state.level = "off";
  const count = state.changes.length;
  editor.handleInput("\x1b[1;2C"); editor.handleInput("\x1b[1;2D");
  assert.equal(state.changes.length, count);
  ctx.model = undefined; editor.handleInput("\x1b[1;2C");
  assert.match(state.notices.at(-1).message, /Select a model/);
  assert.equal(state.changes.length, count);
});

test("effort applies supported levels, completes model-specific choices, and rejects unsupported input", async () => {
  const { state, ctx, command, events } = fixture();
  assert.deepEqual(command.getArgumentCompletions("").map((item) => item.value), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(command.getArgumentCompletions("hi").map((item) => item.value), ["high"]);
  await command.handler(" HIGH ", ctx);
  assert.equal(state.level, "high");
  assert.equal(state.notices.at(-1).message, "Effort: high");
  await command.handler("max", ctx);
  assert.deepEqual(state.changes, ["high"]);
  assert.equal(state.notices.at(-1).type, "error");
  ctx.model = { id: "simple-model", reasoning: false };
  events.get("model_select")({}, ctx);
  assert.deepEqual(command.getArgumentCompletions("").map((item) => item.value), ["off"]);
  await command.handler("high", ctx);
  assert.equal(state.level, "high");
  await command.handler("off", ctx);
  assert.equal(state.level, "off");
});

test("effort without a terminal reports the current level and handles no selected model", async () => {
  const { state, ctx, command } = fixture();
  await command.handler("", ctx);
  assert.match(state.notices.at(-1).message, /Effort: medium\nAvailable: low, medium, high, xhigh/);
  assert.equal(state.changes.length, 0);
  ctx.model = undefined;
  await command.handler("high", ctx);
  assert.match(state.notices.at(-1).message, /Select a model/);
  assert.equal(state.changes.length, 0);
});

test("effort selector previews supported levels, fits narrow terminals, applies on Enter, and cancels on Escape", async () => {
  for (const cancel of [false, true]) {
    const { state, ctx, command } = fixture();
    ctx.mode = "tui";
    ctx.ui.custom = async (create) => {
      let result;
      const tui = { children: [], terminal: { rows: 24 }, requestRender() {} };
      const panel = create(tui, createUiTheme(), {}, (value) => { result = value; });
      await panel.ready;
      for (const width of [1, 8, 24, 80, 140]) assert.ok(panel.render(width).every((line) => measure.visibleWidth(line) <= width));
      assert.match(measure.stripTerminalSequences(panel.render(80).join("\n")), /● medium current/);
      panel.handleInput("\x1b[B"); // Down from medium to high.
      assert.equal(state.changes.length, 0);
      panel.handleInput(cancel ? "\x1b" : "\r");
      panel.dispose();
      return result;
    };
    await command.handler("", ctx);
    assert.equal(state.level, cancel ? "medium" : "high");
    assert.deepEqual(state.changes, cancel ? [] : ["high"]);
  }
});
