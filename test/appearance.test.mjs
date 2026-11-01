import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import appearanceCommands from "../dist/extensions/appearance.js";
import { AppearanceStore, DEFAULT_APPEARANCE, getAppearance, setAppearance } from "../dist/lib/appearance.js";
import { createUiTheme } from "../dist/ui/theme.js";
import { mountAppearanceTerminal, nativeAppearanceTheme } from "../dist/ui/appearance.js";
import { createAppearanceScreen } from "../dist/ui/appearance-screen.js";
import { createChatStyle } from "../dist/ui/chat.js";
import { createHeader } from "../dist/ui/chrome.js";
import { createEscapeExitEditor } from "../dist/ui/escape-exit.js";
import { activityLines } from "../dist/ui/command-views.js";
import { activitySummary, dayKey } from "../dist/lib/activity.js";

const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const req = createRequire(entry);
const measure = await import(pathToFileURL(req.resolve("@earendil-works/pi-tui")).href);
const { initTheme, getThemeByName } = await import(new URL("./modes/interactive/theme/theme.js", entry).href);
const { CustomEditor } = await import(new URL("./modes/interactive/components/custom-editor.js", entry).href);
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", entry).href);
const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", entry).href);
const { BashExecutionComponent } = await import(new URL("./modes/interactive/components/bash-execution.js", entry).href);
const { SkillInvocationMessageComponent } = await import(new URL("./modes/interactive/components/skill-invocation-message.js", entry).href);
const { UserMessageComponent } = await import(new URL("./modes/interactive/components/user-message.js", entry).href);
const { AssistantMessageComponent } = await import(new URL("./modes/interactive/components/assistant-message.js", entry).href);
const root = resolve(fileURLToPath(new URL("../.local/appearance-tests", import.meta.url)));
function fixture(t) {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "case-"));
  setAppearance(DEFAULT_APPEARANCE); initTheme("dark", false);
  t.after(() => { setAppearance(DEFAULT_APPEARANCE); assert.ok(resolve(directory).startsWith(root + sep)); rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

test("appearance commands persist validated choices, restore on restart, and roll back failed saves", async (t) => {
  const directory = fixture(t), store = new AppearanceStore(directory), handlers = new Map(), commands = new Map(), notices = [];
  const pi = { on: (name, fn) => handlers.set(name, fn), registerCommand: (name, command) => commands.set(name, command) };
  let native = getThemeByName("dark");
  const ctx = { mode: "tui", hasUI: true, ui: { getTheme: getThemeByName, get theme() { return native; },
    setTheme(value) { native = value; return { success: true }; }, notify: (text) => notices.push(text) } };
  appearanceCommands(pi, store);
  handlers.get("session_start")({}, ctx);
  await commands.get("theme").handler("light", ctx);
  await commands.get("color").handler("green", ctx);
  assert.deepEqual(store.read(), { mode: "light", color: "green" });
  assert.equal(native.appearance, "light");
  setAppearance(DEFAULT_APPEARANCE);
  handlers.get("session_start")({}, ctx);
  assert.deepEqual(getAppearance(), { mode: "light", color: "green" });
  const colorCommand = commands.get("color");
  assert.deepEqual(colorCommand.getArgumentCompletions("").map((item) => item.value), ["default", "yellow", "green", "blue", "purple"]);
  assert.deepEqual(colorCommand.getArgumentCompletions("b").map((item) => item.value), ["blue"]);
  const theme = createUiTheme();
  for (const mode of ["dark", "light"]) {
    await commands.get("theme").handler(mode, ctx);
    for (const [color, rgb] of [["yellow", "255;193;7"], ["green", "78;186;101"], ["blue", "177;185;249"], ["purple", "175;135;255"]]) {
      await colorCommand.handler(color, ctx);
      assert.deepEqual(new AppearanceStore(directory).read(), { mode, color });
      setAppearance(DEFAULT_APPEARANCE);
      handlers.get("session_start")({}, ctx);
      assert.deepEqual(getAppearance(), { mode, color }, "new colors must survive a restart");
      for (const role of ["inputBorder", "logo", "activity4"]) assert.ok(theme.fg(role, "x").includes(`38;2;${rgb}m`));
      assert.ok(theme.fg("text", "text").includes(mode === "dark" ? "237;237;237" : "23;23;23"));
    }
  }
  await commands.get("theme").handler("light", ctx);
  await colorCommand.handler("green", ctx);
  await commands.get("color").handler("red", ctx);
  assert.deepEqual(store.read(), { mode: "light", color: "green" });
  assert.match(notices.at(-1), /Available colors/);
  const before = native;
  appearanceCommands(pi, { read: () => store.read(), write() { throw Error("read-only profile"); } });
  await commands.get("theme").handler("dark", ctx);
  assert.equal(native, before);
  assert.deepEqual(getAppearance(), { mode: "light", color: "green" });
  assert.match(notices.at(-1), /read-only profile/);
});

test("green accents input borders and the Pi logo while text stays neutral in both themes", (t) => {
  fixture(t);
  const theme = createUiTheme(), muted = theme.fg("muted", "text"), primary = theme.fg("primary", "text");
  const header = createHeader({ mode: "regular" }, measure,
    { version: "1.4.0", getModel: () => ({ id: "test-model" }), getThinkingLevel: () => "medium" });
  t.after(() => header.dispose());
  setAppearance({ mode: "dark", color: "green" });
  assert.equal(theme.fg("muted", "text"), muted);
  assert.equal(theme.fg("primary", "text"), primary);
  assert.match(theme.fg("inputBorder", "─"), /38;2;78;186;101/);
  const tui = { children: [], terminal: { columns: 80, rows: 24 }, requestRender() {} };
  const Editor = createEscapeExitEditor(CustomEditor, measure.matchesKey, { isIdle: () => true, hasPendingMessages: () => false });
  const input = new Editor(tui, { borderColor: (text) => text, selectList: {} }, new KeybindingsManager());
  input.setText("hello");
  const lines = input.render(80);
  assert.match(lines[0], /38;2;78;186;101/);
  assert.ok(!lines[1].includes("38;2;78;186;101"), "typed text must stay neutral");
  setAppearance({ mode: "light", color: "green" });
  assert.match(theme.fg("primary", "text"), /38;2;23;23;23/);
  assert.match(theme.bg("userMessage", "text"), /48;2;234;247;237/);
  assert.match(theme.fg("inputBorder", "─"), /38;2;78;186;101/);
  assert.match(header.render(80)[1], /38;2;82;82;82/);
  assert.match(header.render(80)[0], /38;2;78;186;101m██████/);
  const native = nativeAppearanceTheme({ getTheme: getThemeByName }, getAppearance());
  assert.equal(native.appearance, "light");
  assert.equal(measure.colorToHex(native.colors.text), "#171717");
});

test("accent changes repaint existing Markdown messages and activity charts without coloring assistant text", (t) => {
  fixture(t);
  const theme = createUiTheme();
  const user = new UserMessageComponent("Hello **Pi**\n\n```js\nconst x = 1;\n```"),
    assistant = new AssistantMessageComponent({ content: [{ type: "text", text: "An answer" }] });
  const style = createChatStyle(); t.after(() => style.dispose());
  const chat = { children: [user, assistant] };
  const today = new Date(2026, 9, 30, 12), data = activitySummary(new Map([[dayKey(today), 4]]), today);
  style.apply(chat, 80); user.render(80); // Cache the original neutral Markdown.
  const neutral = activityLines(data, 76, theme, measure).join("\n");
  for (const [mode, background] of [["dark", "9;22;12"], ["light", "234;247;237"]]) {
    setAppearance({ mode, color: "green" });
    style.apply(chat, 80);
    const messages = user.render(80).join("\n");
    assert.ok(messages.includes(`\x1b[48;2;${background}m`));
    assert.ok(!messages.includes("\x1b[48;2;32;32;32m"), "cached neutral background must be replaced");
    assert.ok(!assistant.render(80).join("").includes(`48;2;${background}`));
    const chart = activityLines(data, 76, theme, measure).join("\n");
    assert.notEqual(chart, neutral);
    assert.ok(chart.includes(theme.fg("activity4", "█")));
    assert.match(chart, /38;2;78;186;101m█/);
    const native = nativeAppearanceTheme({ getTheme: getThemeByName }, { mode, color: "green" });
    assert.equal(measure.colorToHex(native.colors.userMessageBg), mode === "dark" ? "#09160c" : "#eaf7ed");
  }
  setAppearance({ mode: "dark", color: "default" });
  style.apply(chat, 80);
  assert.ok(user.render(80).join("").includes("\x1b[48;2;32;32;32m"));
  assert.equal(activityLines(data, 76, theme, measure).join("\n"), neutral);
});

test("native appearance preserves exact palette colors and the terminal's RGB or 256-color encoding", (t) => {
  fixture(t);
  const capabilities = measure.getCapabilities();
  t.after(() => measure.setCapabilities(capabilities));
  for (const trueColor of [false, true]) {
    measure.setCapabilities({ ...capabilities, trueColor });
    for (const mode of ["dark", "light"]) {
      const theme = nativeAppearanceTheme({ getTheme: getThemeByName }, { mode, color: "green" });
      assert.equal(theme.getColorMode(), trueColor ? "truecolor" : "256color");
      // The palette stays exact; ANSI output is quantized only when necessary.
      assert.equal(measure.colorToHex(theme.colors.text), mode === "dark" ? "#ffffff" : "#171717");
      assert.equal(measure.colorToHex(theme.colors.userMessageBg), mode === "dark" ? "#09160c" : "#eaf7ed");
      const foreground = theme.fg("text", "Hello"), background = theme.bg("userMessageBg", "Hello");
      assert.match(foreground, trueColor ? /^\x1b\[38;2;/ : /^\x1b\[38;5;/);
      assert.match(background, trueColor ? /^\x1b\[48;2;/ : /^\x1b\[48;5;/);
      assert.equal(measure.stripTerminalSequences(foreground), "Hello");
      assert.equal(measure.stripTerminalSequences(background), "Hello");
    }
  }
});

test("terminal appearance sets the actual canvas and restores original colors even after theme changes", async (t) => {
  fixture(t);
  const writes = [], tui = { terminal: { write: (value) => writes.push(value) }, requestRender() {},
    queryTerminalColors: async () => ({ foreground: { r: 220, g: 221, b: 222 }, background: { r: 18, g: 19, b: 20 } }) };
  const mount = mountAppearanceTerminal(tui); t.after(() => mount.dispose());
  await mount.ready;
  assert.ok(writes.at(-1).includes("\x1b]11;#000000\x07"));
  setAppearance({ mode: "light", color: "default" }); await new Promise(setImmediate);
  assert.ok(writes.at(-1).includes("\x1b]11;#ffffff\x07"));
  mount.dispose();
  assert.equal(writes.at(-1), "\x1b]10;#dcddde\x07\x1b]11;#121314\x07");
  const count = writes.length; setAppearance(DEFAULT_APPEARANCE); await new Promise(setImmediate);
  assert.equal(writes.length, count);
});

test("theme instances are accepted by the actual CLI bundle, whose constructor differs from the SDK", async (t) => {
  fixture(t);
  const cli = await import(new URL("./bundle/index.js", entry).href);
  cli.initTheme("dark", false);
  let selected;
  const host = Object.create(cli.InteractiveMode.prototype);
  Object.defineProperty(host, "settingsManager", { value: { getTheme: () => "dark" } });
  Object.assign(host, { ui: { mode: "fullscreen" },
    themeController: {
      setThemeInstance(theme) { selected = theme; return { success: true }; },
      setThemeName(name) { throw Error(`A theme object was misinterpreted as a name: ${name}`); },
    },
  });
  const ui = host.createExtensionUIContext();
  const theme = nativeAppearanceTheme(ui, { mode: "light", color: "default" });
  assert.ok(theme instanceof cli.Theme);
  assert.equal(ui.setTheme(theme).success, true);
  assert.equal(selected.appearance, "light");
});

test("closing before a terminal color query completes never changes the shell colors", async (t) => {
  fixture(t);
  const writes = []; let finish;
  const mount = mountAppearanceTerminal({ terminal: { write: (value) => writes.push(value) }, requestRender() {},
    queryTerminalColors: () => new Promise((resolve) => { finish = resolve; }) });
  await Promise.resolve(); mount.dispose(); finish({}); await mount.ready;
  assert.deepEqual(writes, []);
});

test("appearance selector applies only on Enter, cancels on Escape, and fits narrow screens", async (t) => {
  fixture(t);
  for (const apply of [true, false]) {
    const selected = [], closed = [];
    const panel = createAppearanceScreen({ title: "Theme", tui: { terminal: { rows: 24 }, requestRender() {} },
      theme: createUiTheme(), measure, done: (value) => closed.push(value), current: "dark",
      choices: [{ value: "dark", label: "Dark", description: "Black background." }, { value: "light", label: "Light", description: "White background." }],
      onSelect: (value) => selected.push(value) });
    await panel.ready;
    for (const width of [8, 24, 80]) assert.ok(panel.render(width).every((line) => measure.visibleWidth(line) <= width));
    panel.handleInput("\x1b[B"); assert.deepEqual(selected, []);
    panel.handleInput(apply ? "\r" : "\x1b");
    assert.deepEqual(selected, apply ? ["light"] : []);
    assert.equal(closed.length, 1);
  }
});

test("color picker shows all swatches and hex values, marks the current color, and keeps selection visible", async (t) => {
  const store = new AppearanceStore(fixture(t)), commands = new Map();
  appearanceCommands({ on() {}, registerCommand: (name, command) => commands.set(name, command), getThinkingLevel: () => "medium" }, store);
  const ctx = { mode: "tui", hasUI: true, cwd: process.cwd(), ui: { getTheme: getThemeByName,
    theme: getThemeByName("dark"), setTheme: () => ({ success: true }), notify() {},
    async custom(create) {
      const tui = { children: [], terminal: { rows: 24 }, requestRender() {} };
      const panel = create(tui, {}, {}, () => {}); t.after(() => panel.dispose());
      await panel.ready;
      const frame = panel.render(80), text = frame.map(measure.stripTerminalSequences).join("\n");
      for (const [label, hex, rgb] of [["Yellow", "#FFC107", "255;193;7"], ["Green", "#4EBA65", "78;186;101"],
        ["Blue", "#B1B9F9", "177;185;249"], ["Purple", "#AF87FF", "175;135;255"]]) {
        assert.ok(frame.some((line) => line.includes(`\x1b[38;2;${rgb}m●`)));
        assert.ok(text.includes(label) && text.includes(hex));
      }
      assert.match(text, /● Default\s+Neutral\s+✓/);
      for (const width of [1, 8, 24, 80]) assert.ok(panel.render(width).every((line) => measure.visibleWidth(line) <= width));
      tui.terminal.rows = 12;
      for (let step = 0; step < 4; step++) { panel.render(24); panel.handleInput("\x1b[B"); }
      assert.match(panel.render(24).map(measure.stripTerminalSequences).join("\n"), /Purple/);
      assert.deepEqual(getAppearance(), DEFAULT_APPEARANCE, "preview must not apply the pending color");
      panel.handleInput("\r");
    },
  } };
  await commands.get("color").handler("", ctx);
  assert.deepEqual(store.read(), { mode: "dark", color: "purple" });
});

test("native tool, shell, and skill calls collapse, expand by click or native controls, and keep errors visible", (t) => {
  const cwd = fixture(t), ui = { requestRender() {} };
  const tool = new ToolExecutionComponent("read", "call-1", { path: "src/main.ts" }, { showImages: false }, undefined, ui, cwd);
  tool.updateResult({ content: [{ type: "text", text: "Private output\nSecond line" }], isError: false });
  const shell = new BashExecutionComponent("npm test", ui); shell.appendOutput("Tests passed"); shell.setComplete(0, false);
  const skill = new SkillInvocationMessageComponent({ name: "frontend-design", content: "Full skill instructions" });
  const chat = new measure.Container(); for (const c of [tool, shell, skill]) chat.addChild(c);
  const nativeRender = tool.render, style = createChatStyle(); t.after(() => style.dispose());
  style.apply(chat, 80);
  for (const component of [tool, shell, skill]) {
    assert.equal(component.render(80).length, 1);
    assert.ok(measure.stripTerminalSequences(component.render(80)[0]).startsWith("  ▸"));
    for (const width of [8, 24, 80]) assert.ok(component.render(width).every((line) => measure.visibleWidth(line) <= width));
  }
  assert.ok(!tool.render(80).join("").includes("Private output"));
  tool.handleMouse({ type: "click", button: "left", x: 3, y: 0, width: 80, height: 1 });
  assert.ok(tool.render(80).join("\n").includes("Private output"));
  tool.setExpanded(false); assert.equal(tool.render(80).length, 1);
  tool.updateResult({ content: [{ type: "text", text: "Access denied" }], isError: true });
  assert.match(measure.stripTerminalSequences(tool.render(80).join("\n")), /failed.*\n.*Access denied/);
  shell.setExpanded(true); assert.ok(shell.render(80).join("\n").includes("Tests passed"));
  skill.setExpanded(true); assert.ok(skill.render(80).join("\n").includes("Full skill instructions"));
  style.dispose(); assert.equal(tool.render, nativeRender);
});
