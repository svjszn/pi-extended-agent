import type { Appearance } from "../lib/appearance.js";
import type { PanelFactory } from "./helpers.ts";
import { present } from "./helpers.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const { default: appearanceCommands } = await import(new URL("../dist/extensions/appearance.js", import.meta.url).href) as typeof import("../extensions/appearance.js");
const { AppearanceStore, DEFAULT_APPEARANCE, getAppearance, setAppearance } = await import(new URL("../dist/lib/appearance.js", import.meta.url).href) as typeof import("../lib/appearance.js");
const { createUiTheme } = await import(new URL("../dist/ui/theme.js", import.meta.url).href) as typeof import("../ui/theme.js");
const { mountAppearanceTerminal, nativeAppearanceTheme } = await import(new URL("../dist/ui/appearance.js", import.meta.url).href) as typeof import("../ui/appearance.js");
const { createAppearanceScreen } = await import(new URL("../dist/ui/appearance-screen.js", import.meta.url).href) as typeof import("../ui/appearance-screen.js");
const { createChatStyle } = await import(new URL("../dist/ui/chat.js", import.meta.url).href) as typeof import("../ui/chat.js");
const { createHeader } = await import(new URL("../dist/ui/chrome.js", import.meta.url).href) as typeof import("../ui/chrome.js");
const { keepAppearanceTheme } = await import(new URL("../dist/bin/command-policy.js", import.meta.url).href) as typeof import("../bin/command-policy.js");
const { forgetAppearanceTheme, rememberAppearanceTheme } = await import(new URL("../dist/lib/appearance.js", import.meta.url).href) as typeof import("../lib/appearance.js");
const { createEscapeExitEditor } = await import(new URL("../dist/ui/escape-exit.js", import.meta.url).href) as typeof import("../ui/escape-exit.js");
const { activityLines } = await import(new URL("../dist/ui/command-views.js", import.meta.url).href) as typeof import("../ui/command-views.js");
const { activitySummary, dayKey } = await import(new URL("../dist/lib/activity.js", import.meta.url).href) as typeof import("../lib/activity.js");

const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const req = createRequire(entry);
const measure = await import(pathToFileURL(req.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
const { initTheme, getThemeByName } = await import(new URL("./modes/interactive/theme/theme.js", entry).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
const { CustomEditor } = await import(new URL("./modes/interactive/components/custom-editor.js", entry).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js");
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", entry).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");
const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", entry).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js");
const { BashExecutionComponent } = await import(new URL("./modes/interactive/components/bash-execution.js", entry).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/bash-execution.js");
const { SkillInvocationMessageComponent } = await import(new URL("./modes/interactive/components/skill-invocation-message.js", entry).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/skill-invocation-message.js");
const { UserMessageComponent } = await import(new URL("./modes/interactive/components/user-message.js", entry).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js");
const { AssistantMessageComponent } = await import(new URL("./modes/interactive/components/assistant-message.js", entry).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js");
const root = resolve(fileURLToPath(new URL("../.local/appearance-tests", import.meta.url)));
function fixture(t: TestContext) {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "case-"));
  setAppearance(DEFAULT_APPEARANCE); initTheme("dark", false);
  t.after(() => { setAppearance(DEFAULT_APPEARANCE); assert.ok(resolve(directory).startsWith(root + sep)); rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

test("appearance commands persist validated choices, restore on restart, and roll back failed saves", async (t) => {
  const directory = fixture(t), store = new AppearanceStore(directory), handlers = new Map(), commands = new Map(), notices: string[] = [];
  const pi = { on: ((name, fn) => { handlers.set(name, fn); return () => {}; }) satisfies ExtensionAPI["on"], registerCommand: ((name, command) => commands.set(name, command)) satisfies ExtensionAPI["registerCommand"] };
  let native = getThemeByName("dark");
  const ctx = { mode: "tui", hasUI: true, ui: { getTheme: getThemeByName, get theme() { return native; },
    setTheme(value: import("@earendil-works/pi-coding-agent").Theme) { native = value; return { success: true }; }, notify: (text: string) => notices.push(text) } };
  appearanceCommands((pi as unknown as Parameters<typeof appearanceCommands>[0]), store);
  handlers.get("session_start")({}, ctx);
  await commands.get("theme").handler("light", ctx);
  await commands.get("color").handler("green", ctx);
  assert.deepEqual(store.read(), { mode: "light", color: "green" });
  assert.equal(present(native).appearance, "light");
  setAppearance(DEFAULT_APPEARANCE);
  handlers.get("session_start")({}, ctx);
  assert.deepEqual(getAppearance(), { mode: "light", color: "green" });
  const colorCommand = commands.get("color");
  assert.deepEqual(colorCommand.getArgumentCompletions("").map((item: {value:string}) => item.value), ["default", "yellow", "green", "blue", "purple"]);
  assert.deepEqual(colorCommand.getArgumentCompletions("b").map((item: {value:string}) => item.value), ["blue"]);
  const theme = createUiTheme();
  for (const mode of ["dark", "light"] as const) {
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
  assert.match(present(notices.at(-1)), /Available colors/);
  const before = native;
  appearanceCommands((pi as unknown as Parameters<typeof appearanceCommands>[0]), ({ read: () => store.read(), write() { throw Error("read-only profile"); } } as unknown as Parameters<typeof appearanceCommands>[1]));
  await commands.get("theme").handler("dark", ctx);
  assert.equal(native, before);
  assert.deepEqual(getAppearance(), { mode: "light", color: "green" });
  assert.match(present(notices.at(-1)), /read-only profile/);
});

test("legacy logo survives restart, preserves accent choices, and fits the shared header", async (t) => {
  const directory = fixture(t), store = new AppearanceStore(directory);
  assert.equal(store.read().legacyLogo, undefined, "existing profiles use the modern mark");
  store.write({ mode: "dark", color: "green", legacyLogo: true });
  setAppearance(store.read());
  const header = createHeader({ mode: "regular" }, measure,
    { version: "1", getModel: () => undefined, getThinkingLevel: () => "off" });
  t.after(() => header.dispose());
  const lines = header.render(80).map(measure.stripTerminalSequences);
  assert.equal(lines[0].slice(2, 10), "████████");
  assert.equal(lines[3].slice(2, 10), "███  ███");
  assert.match(header.render(80)[0], /38;2;78;186;101m████████/);
  for (const width of [1, 8, 24, 32, 80]) {
    assert.ok(header.render(width).every((line) => measure.visibleWidth(line) <= width));
  }
  const commands = new Map();
  appearanceCommands(({ on() { return () => {}; }, registerCommand: ((name, command) => commands.set(name, command)) satisfies ExtensionAPI["registerCommand"] } as unknown as ExtensionAPI), store);
  await commands.get("color").handler("purple", { mode: "print", hasUI: true, ui: { notify() {} } });
  assert.equal(store.read().legacyLogo, true, "color changes preserve the logo preference");
  store.write({ ...getAppearance(), legacyLogo: false });
  setAppearance(store.read());
  assert.equal(measure.stripTerminalSequences(header.render(80)[0]).slice(2, 10), "██████  ");
  assert.throws(() => setAppearance({ mode: "dark", color: "default", legacyLogo: "on" as unknown as boolean }), /Invalid appearance/);
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
  const input = new Editor((tui as unknown as ConstructorParameters<typeof Editor>[0]), { borderColor: (text) => text, selectList: {} } as import("@earendil-works/pi-tui").EditorTheme, new KeybindingsManager());
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
    assistant = new AssistantMessageComponent(({ content: [{ type: "text", text: "An answer" }] } as unknown as ConstructorParameters<typeof AssistantMessageComponent>[0]));
  const style = createChatStyle(); t.after(() => style.dispose());
  const chat = { children: [user, assistant] };
  const today = new Date(2026, 9, 30, 12), data = activitySummary(new Map([[dayKey(today), 4]]), today);
  style.apply(chat, 80); user.render(80); // Cache the original neutral Markdown.
  const neutral = activityLines(data, 76, theme, measure).join("\n");
  for (const [mode, background] of [["dark", "9;22;12"], ["light", "234;247;237"]] as const) {
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
    for (const mode of ["dark", "light"] as const) {
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
  const writes: string[] = [], tui = { terminal: { write: (value: string) => writes.push(value) }, requestRender() {},
    queryTerminalColors: async () => ({ foreground: { r: 220, g: 221, b: 222 }, background: { r: 18, g: 19, b: 20 } }) };
  const mount = mountAppearanceTerminal(tui); t.after(() => mount.dispose());
  await mount.ready;
  assert.ok(present(writes.at(-1)).includes("\x1b]11;#000000\x07"));
  setAppearance({ mode: "light", color: "default" }); await new Promise(setImmediate);
  assert.ok(present(writes.at(-1)).includes("\x1b]11;#ffffff\x07"));
  mount.dispose();
  assert.equal(writes.at(-1), "\x1b]10;#dcddde\x07\x1b]11;#121314\x07");
  const count = writes.length; setAppearance(DEFAULT_APPEARANCE); await new Promise(setImmediate);
  assert.equal(writes.length, count);
});

test("theme instances are accepted by the actual CLI bundle, whose constructor differs from the SDK", async (t) => {
  fixture(t);
  const cli = await import(new URL("./bundle/index.js", entry).href) as typeof import("@earendil-works/pi-coding-agent") & {InteractiveMode: {prototype: object}};
  cli.initTheme("dark", false);
  let selected: import("@earendil-works/pi-coding-agent").Theme | undefined;
  const host = Object.create(cli.InteractiveMode.prototype);
  Object.defineProperty(host, "settingsManager", { value: { getTheme: () => "dark" } });
  Object.assign(host, { ui: { mode: "fullscreen" },
    themeController: {
      setThemeInstance(theme: import("@earendil-works/pi-coding-agent").Theme) { selected = theme; return { success: true }; },
      setThemeName(name: string) { throw Error(`A theme object was misinterpreted as a name: ${name}`); },
    },
  });
  const ui = host.createExtensionUIContext();
  const theme = nativeAppearanceTheme(ui, { mode: "light", color: "default" });
  assert.ok(theme instanceof cli.Theme);
  assert.equal(ui.setTheme(theme).success, true);
  assert.equal(present(selected).appearance, "light");
});

test("closing before a terminal color query completes never changes the shell colors", async (t) => {
  fixture(t);
  const writes: string[] = []; let finish!: (value: import("@earendil-works/pi-tui").TerminalColors) => void;
  const mount = mountAppearanceTerminal({ terminal: { write: (value) => writes.push(value) }, requestRender() {},
    queryTerminalColors: () => new Promise((resolve) => { finish = resolve; }) });
  await Promise.resolve(); mount.dispose(); present(finish)({}); await mount.ready;
  assert.deepEqual(writes, []);
});

test("appearance selector applies only on Enter, cancels on Escape, and fits narrow screens", async (t) => {
  fixture(t);
  for (const apply of [true, false]) {
    const selected: string[] = [], closed = [];
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
  appearanceCommands(({ on() { return () => {}; }, registerCommand: ((name, command) => commands.set(name, command)) satisfies ExtensionAPI["registerCommand"], getThinkingLevel: () => "medium" } as unknown as ExtensionAPI), store);
  const ctx = { mode: "tui", hasUI: true, cwd: process.cwd(), ui: { getTheme: getThemeByName,
    theme: getThemeByName("dark"), setTheme: () => ({ success: true }), notify() {},
    async custom(create: PanelFactory) {
      const tui = { children: [], terminal: { rows: 24 }, requestRender() {} };
      const panel = create(tui, createUiTheme(), {}, () => {}); t.after(() => panel.dispose());
      await panel.ready;
      const frame = panel.render(80), text = frame.map(measure.stripTerminalSequences).join("\n");
      for (const [label, hex, rgb] of [["Yellow", "#FFC107", "255;193;7"], ["Green", "#4EBA65", "78;186;101"],
        ["Blue", "#B1B9F9", "177;185;249"], ["Purple", "#AF87FF", "175;135;255"]]) {
        assert.ok(frame.some((line: string|string[]) => line.includes(`\x1b[38;2;${rgb}m●`)));
        assert.ok(text.includes(label) && text.includes(hex));
      }
      assert.match(text, /● Default\s+Neutral\s+✓/);
      for (const width of [1, 8, 24, 80]) assert.ok(panel.render(width).every((line: string) => measure.visibleWidth(line) <= width));
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
  const tool = new ToolExecutionComponent("read", "call-1", { path: "src/main.ts" }, { showImages: false }, undefined, (ui as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5]), cwd);
  tool.updateResult({ content: [{ type: "text", text: "Private output\nSecond line" }], isError: false });
  const shell = new BashExecutionComponent("npm test", (ui as unknown as ConstructorParameters<typeof BashExecutionComponent>[1])); shell.appendOutput("Tests passed"); shell.setComplete(0, false);
  const skill = new SkillInvocationMessageComponent({ name: "frontend-design", content: "Full skill instructions", location: "fixture", userMessage: "" });
  const chat = new measure.Container(); for (const c of [tool, shell, skill]) chat.addChild(c);
  const nativeRender = tool.render, style = createChatStyle(); t.after(() => style.dispose());
  style.apply(chat, 80);
  for (const component of [tool, shell, skill]) {
    assert.equal(component.render(80).length, 1);
    assert.ok(measure.stripTerminalSequences(component.render(80)[0]).startsWith("  ▸"));
    for (const width of [8, 24, 80]) assert.ok(component.render(width).every((line: string) => measure.visibleWidth(line) <= width));
  }
  assert.ok(!tool.render(80).join("").includes("Private output"));
  tool.handleMouse({screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false,  type: "click", button: "left", x: 3, y: 0, width: 80, height: 1 });
  assert.ok(tool.render(80).join("\n").includes("Private output"));
  tool.setExpanded(false); assert.equal(tool.render(80).length, 1);
  tool.updateResult({ content: [{ type: "text", text: "Access denied" }], isError: true });
  assert.match(measure.stripTerminalSequences(tool.render(80).join("\n")), /failed.*\n.*Access denied/);
  shell.setExpanded(true); assert.ok(shell.render(80).join("\n").includes("Tests passed"));
  skill.setExpanded(true); assert.ok(skill.render(80).join("\n").includes("Full skill instructions"));
  style.dispose(); assert.equal(tool.render, nativeRender);
});

test("a replacement session keeps the selected appearance instead of Pi's settings theme", (t) => {
  t.after(() => forgetAppearanceTheme());
  const applied: unknown[] = [];
  const controller = {
    applyFromSettings() { applied.push("settings"); },
    setThemeInstance: (value: unknown) => applied.push(value),
  };
  const host = { themeController: controller };
  keepAppearanceTheme((host as unknown as Parameters<typeof keepAppearanceTheme>[0]));
  // Before an appearance is chosen, Pi's own theme stands untouched.
  forgetAppearanceTheme();
  controller.applyFromSettings();
  assert.deepEqual(applied, ["settings"]);
  // Once chosen, every reapplication is followed by ours.
  const chosen = { name: "chosen-appearance" };
  rememberAppearanceTheme(chosen);
  controller.applyFromSettings();
  assert.deepEqual(applied, ["settings", "settings", chosen]);
  controller.applyFromSettings();
  assert.deepEqual(applied.slice(-2), ["settings", chosen], "each replacement restores it again");
  // Installing twice must not double-apply, and a controller without the hooks is left alone.
  const before = applied.length;
  keepAppearanceTheme((host as unknown as Parameters<typeof keepAppearanceTheme>[0]));
  controller.applyFromSettings();
  assert.equal(applied.length, before + 2);
  assert.doesNotThrow(() => keepAppearanceTheme(({} as unknown as Parameters<typeof keepAppearanceTheme>[0])));
  assert.doesNotThrow(() => keepAppearanceTheme({ themeController: {} } as unknown as Parameters<typeof keepAppearanceTheme>[0]));
});
