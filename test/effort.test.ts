import { commandFixture } from "./helpers.ts";
import { tuiFixture } from "./helpers.ts";
import type { TestUi } from "./helpers.ts";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { present } from "./helpers.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const { createEffortScreen } = await import(new URL("../dist/ui/effort-screen.js", import.meta.url).href) as typeof import("../ui/effort-screen.js");
const { effortGlow } = await import(new URL("../dist/ui/effort-style.js", import.meta.url).href) as typeof import("../ui/effort-style.js");
const { getAppearance, setAppearance } = await import(new URL("../dist/lib/appearance.js", import.meta.url).href) as typeof import("../lib/appearance.js");
const { createFooter } = await import(new URL("../dist/ui/chrome.js", import.meta.url).href) as typeof import("../ui/chrome.js");
const { createUiTheme } = await import(new URL("../dist/ui/theme.js", import.meta.url).href) as typeof import("../ui/theme.js");

const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const require = createRequire(entry);
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": fileURLToPath(entry),
  "@earendil-works/pi-ai": join(dirname(present(findPackageJSON("@earendil-works/pi-ai", entry))), "dist", "compat.js"),
  "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
} });
const factory = await jiti.import(fileURLToPath(new URL("../dist/extensions/effort.js", import.meta.url)), { default: true });
const editorFactory = await jiti.import(fileURLToPath(new URL("../dist/extensions/escape-exit.js", import.meta.url)), { default: true });
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", entry).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");

function fixture() {
  const state: { level: string; changes: string[]; notices: {message: string; type?: string}[] } = { level: "medium", changes: [], notices: [] };
  const events = new Map();
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const pi = { on: ((event, callback) => { events.set(event, callback); return () => {}; }) satisfies ExtensionAPI["on"], registerCommand: ((_name, value) => { command = value; }) satisfies ExtensionAPI["registerCommand"],
    getThinkingLevel: () => state.level, setThinkingLevel: (value: string) => { state.level = value; state.changes.push(value); } };
  factory(pi);
  const ctx = { mode: "print", hasUI: true, cwd: process.cwd(), model: { id: "test-model", reasoning: true, thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: null } } as { id: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null> } | undefined,
    ui: { notify: (message: string, type?: string) => state.notices.push({ message, type }) } as TestUi };
  events.get("session_start")({}, ctx);
  return { state, ctx, command: commandFixture(command), events, pi };
}

test("Shift+arrows adjust supported effort through the real editor, clamp at bounds and preserve input", () => {
  const { state, ctx, events, pi } = fixture();
  let editor!: import("@earendil-works/pi-tui").EditorComponent, renders = 0;
  ctx.mode = "tui";
  ctx.ui.setEditorComponent = (create) => { editor = present(create)(tuiFixture({ children: [], terminal: { rows: 24, columns: 80 }, requestRender() { renders++; } }),
    { borderColor: (s: string) => s, selectList: {} } as import("@earendil-works/pi-tui").EditorTheme, new KeybindingsManager()); };
  editorFactory(pi); events.get("session_start")({}, ctx);
  present(editor).setText("Keep this draft");
  present(editor).handleInput("\x1b[1;2C"); assert.equal(state.level, "high");
  present(editor).handleInput("\x1b[1;2C"); assert.equal(state.level, "xhigh");
  present(editor).handleInput("\x1b[1;2C"); assert.equal(state.level, "xhigh");
  for (let i = 0; i < 4; i++) present(editor).handleInput("\x1b[1;2D");
  assert.equal(state.level, "low");
  assert.deepEqual(state.changes, ["high", "xhigh", "high", "medium", "low"]);
  assert.equal(present(editor).getText(), "Keep this draft"); assert.ok(renders > 0);
  // Read the current model on each key press, including models without reasoning.
  ctx.model = { id: "simple-model", reasoning: false }; state.level = "off";
  const count = state.changes.length;
  present(editor).handleInput("\x1b[1;2C"); present(editor).handleInput("\x1b[1;2D");
  assert.equal(state.changes.length, count);
  ctx.model = undefined; present(editor).handleInput("\x1b[1;2C");
  assert.match(present(state.notices.at(-1)).message, /Select a model/);
  assert.equal(state.changes.length, count);
});

test("effort applies supported levels, completes model-specific choices, and rejects unsupported input", async () => {
  const { state, ctx, command, events } = fixture();
  assert.deepEqual(present(await present(present(command).getArgumentCompletions)("")).map((item) => item.value), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(present(await present(present(command).getArgumentCompletions)("hi")).map((item) => item.value), ["high"]);
  await present(command).handler(" HIGH ", ctx);
  assert.equal(state.level, "high");
  assert.equal(present(state.notices.at(-1)).message, "Effort: high");
  await present(command).handler("max", ctx);
  assert.deepEqual(state.changes, ["high"]);
  assert.equal(present(state.notices.at(-1)).type, "error");
  ctx.model = { id: "simple-model", reasoning: false };
  events.get("model_select")({}, ctx);
  assert.deepEqual(present(await present(present(command).getArgumentCompletions)("")).map((item) => item.value), ["off"]);
  await present(command).handler("high", ctx);
  assert.equal(state.level, "high");
  await present(command).handler("off", ctx);
  assert.equal(state.level, "off");
});

test("effort without a terminal reports the current level and handles no selected model", async () => {
  const { state, ctx, command } = fixture();
  await present(command).handler("", ctx);
  assert.match(present(state.notices.at(-1)).message, /Effort: medium\nAvailable: low, medium, high, xhigh/);
  assert.equal(state.changes.length, 0);
  ctx.model = undefined;
  await present(command).handler("high", ctx);
  assert.match(present(state.notices.at(-1)).message, /Select a model/);
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
      for (const width of [1, 8, 24, 80, 140]) assert.ok(panel.render(width).every((line: string) => measure.visibleWidth(line) <= width));
      const view = panel.render(80).map(measure.stripTerminalSequences).join("\n");
      assert.match(view, /faster\s+smarter/);
      assert.equal((view.slice(view.indexOf("faster")).match(/\bmedium\b/g) ?? []).length, 1);
      assert.ok(!view.includes("current"));
      panel.handleInput("\x1b[C"); // Right from medium to high.
      assert.equal(state.changes.length, 0);
      panel.handleInput(cancel ? "\x1b" : "\r");
      panel.dispose();
      return result;
    };
    await present(command).handler("", ctx);
    assert.equal(state.level, cancel ? "medium" : "high");
    assert.deepEqual(state.changes, cancel ? [] : ["high"]);
  }
});

test("horizontal effort slider supports mouse drag, purple glow, rainbow max, and pending selection", async (t) => {
  let time = 0;
  const applied: string[] = [], levels: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
  const panel = createEffortScreen({ tui: { terminal: { rows: 24 }, requestRender() {} }, theme: createUiTheme(), measure,
    done() {}, levels, current: "medium", onSelect: (level) => applied.push(level), now: () => time });
  t.after(() => panel.dispose());
  await panel.ready;
  const frame = panel.render(80).map(measure.stripTerminalSequences);
  assert.ok(frame.some((line) => /low\s+medium\s+high\s+xhigh\s+max/.test(line)));
  const row = frame.findIndex((line) => line.includes("○") && line.includes("●"));
  assert.ok(row >= 0);
  const mouse = { screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false, type: "press" as const, button: "left" as const, x: 39, y: row, width: 80, height: 24 };
  assert.equal(panel.handleMouse(mouse).capture, true);
  time += 240;
  const first = panel.render(80);
  assert.ok(first.map(measure.stripTerminalSequences).some((line) => /\bhigh\b/.test(line)));
  time += 300;
  const next = panel.render(80);
  assert.notDeepEqual(first, next, "high must animate");
  assert.deepEqual(first.map(measure.stripTerminalSequences), next.map(measure.stripTerminalSequences), "glow must not move text");
  assert.equal(first[row], next[row], "the neutral track must not animate or change color");
  assert.deepEqual(applied, []);
  panel.handleMouse({ ...mouse, type: "drag", x: 74 });
  panel.handleMouse({ ...mouse, type: "release", x: 74 });
  time += 240;
  const rainbow = panel.render(80).find((line) => /\bmax\b/.test(measure.stripTerminalSequences(line)));
  const maxLabel = effortGlow("max", "max", time / 1000);
  assert.ok(present(rainbow).includes(maxLabel));
  const channels = [...maxLabel.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)].map((match) => match.slice(1).map(Number));
  const dominant = new Set(channels.map((rgb) => rgb.indexOf(Math.max(...rgb))));
  assert.ok(dominant.size >= 2, "max must use multiple rainbow hues");
  for (const width of [1, 8, 24, 80, 140]) assert.ok(panel.render(width).every((line) => measure.visibleWidth(line) <= width));
  panel.handleInput("\r");
  assert.deepEqual(applied, ["max"]);
});

test("low/auto and medium/plan share their colors across dark and light themes", async (t) => {
  const before = getAppearance(); t.after(() => setAppearance(before));
  let planning = false;
  const theme = createUiTheme();
  const footer = createFooter({}, {}, theme, {}, measure, undefined, () => "allow", () => planning);
  for (const mode of ["dark", "light"] as const) {
    setAppearance({ mode, color: "default" });
    assert.match(theme.fg("effortLow", "low"), /38;2;255;193;7mlow/);
    assert.match(theme.fg("effortMedium", "medium"), /38;2;78;186;101mmedium/);
    const panel = createEffortScreen({ tui: { terminal: { rows: 24 }, requestRender() {} }, theme, measure,
      done() {}, levels: ["low", "medium"], current: "medium", onSelect() {} });
    t.after(() => panel.dispose()); await panel.ready;
    const labels = panel.render(80).find((line) => /low\s+medium/.test(measure.stripTerminalSequences(line)));
    assert.ok(present(labels).includes(theme.fg("effortLow", "low")));
    assert.ok(present(labels).includes(theme.fg("effortMedium", "medium")));
    planning = false;
    assert.ok(footer.render(80)[0].includes(theme.fg("effortLow", "allow mode")));
    planning = true;
    assert.ok(footer.render(80)[0].includes(theme.fg("effortMedium", "plan mode")));
    panel.dispose();
  }
});

test("effort glow stops repainting after the selector is closed", async (t) => {
  let renders = 0;
  const applied: string[] = [];
  const panel = createEffortScreen({ tui: { terminal: { rows: 24 }, requestRender() { renders++; } }, theme: createUiTheme(), measure,
    done() {}, levels: ["high", "max"], current: "high", onSelect: (level) => applied.push(level) });
  t.after(() => panel.dispose());
  await panel.ready; panel.render(80);
  const before = renders;
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.ok(renders > before);
  panel.handleInput("\x1b");
  const stopped = renders;
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(renders, stopped);
  assert.deepEqual(applied, []);
});

test("high and xhigh glow use the chosen base hex colors in both themes", (t) => {
  const before = getAppearance(); t.after(() => setAppearance(before));
  for (const mode of ["dark", "light"] as const) {
    setAppearance({ mode, color: "default" });
    for (const [level, rgb] of [["high", "177;185;249"], ["xhigh", "175;135;255"]]) {
      assert.ok(effortGlow(level, level, 0).startsWith(`\x1b[38;2;${rgb}m`));
      const first = effortGlow(level, level, 0.25), next = effortGlow(level, level, 0.55);
      assert.notEqual(first, next);
      const frames = Array.from({ length: 20 }, (_, index) => effortGlow(level, level, index / 10));
      assert.equal(new Set(frames).size, frames.length, "the glow must not freeze between highlights");
      const channels = frames.flatMap((frame) => [...frame.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)].map((match) => Number(match[1])));
      assert.ok(Math.max(...channels) - Math.min(...channels) > 60, "glow should be clearly visible");
      assert.equal(measure.stripTerminalSequences(first), level);
      assert.equal(measure.visibleWidth(first), level.length);
    }
  }
});

test("rainbow max stays readable on both black and white backgrounds", (t) => {
  const before = getAppearance(); t.after(() => setAppearance(before));
  const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  for (const mode of ["dark", "light"] as const) {
    setAppearance({ mode, color: "default" });
    for (const level of ["max"]) for (const time of [0, 0.3, 1.7, 4]) {
      for (const match of effortGlow(level, level, time).matchAll(/38;2;(\d+);(\d+);(\d+)m/g)) {
        const [r, g, b] = match.slice(1).map((value) => linear(Number(value) / 255));
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const contrast = mode === "light" ? 1.05 / (luminance + 0.05) : (luminance + 0.05) / 0.05;
        assert.ok(contrast >= 4.5, `${mode} ${level}: contrast ${contrast}`);
      }
    }
  }
});
