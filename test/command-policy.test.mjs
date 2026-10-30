import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { bundledRuntime } from "../dist/bin/runtime.js";
import { installCommandPolicy, captureConfigPreferences } from "../dist/bin/command-policy.js";
import { createConfigScreen } from "../dist/ui/config-screen.js";
import { createUiTheme } from "../dist/ui/theme.js";
import { createRequire } from "node:module";
import { CONFIG_PREFERENCES } from "../dist/lib/config-preferences.js";
import { REMOVED_COMMANDS, removedCommand } from "../dist/lib/command-policy.js";

// Exercise the same bundled classes that the executable uses, without a terminal,
// credentials, provider calls, or writing settings to the real profile.
const runtime = bundledRuntime();
const api = await import(pathToFileURL(join(runtime.packageDir, "dist/bundle/index.js")));
const require = createRequire(pathToFileURL(runtime.entry));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
installCommandPolicy(api);

function interactiveHost() {
  const view = Object.create(api.InteractiveMode.prototype);
  view.defaultEditor = {};
  view.editor = { setText(text) { view.draft = text; } };
  view.showStatus = (text) => { view.notice = text; };
  view.showSettingsSelector = () => { view.settingsOpened = true; };
  view.runtimeHost = { session: {} };
  return view;
}

test("every removed command is rejected by native submit without reaching the model", async () => {
  const view = interactiveHost();
  view.setupEditorSubmitHandler();
  for (const name of REMOVED_COMMANDS) {
    for (const text of [`/${name}`, `  /${name} argument  `]) {
      view.draft = text;
      await view.defaultEditor.onSubmit(text);
      assert.equal(view.draft, "");
      assert.match(view.notice, /not available/);
    }
    await assert.rejects(api.AgentSession.prototype.prompt.call({}, `/${name} argument`), /not available/);
  }
  assert.equal(view.settingsOpened, undefined);
});

test("config and config info both reach the custom screen without opening the native menu", async () => {
  const view = interactiveHost();
  view.setupEditorSubmitHandler();
  view.flushPendingBashComponents = () => {};
  let submitted;
  view.onInputCallback = (text) => { submitted = text; };
  await view.defaultEditor.onSubmit("/config");
  assert.equal(submitted, "/config");
  assert.equal(view.settingsOpened, undefined);
  await view.defaultEditor.onSubmit("/config info");
  assert.equal(submitted, "/config info");
});

test("native autocomplete removes disabled commands while retaining commands and file completion", () => {
  const view = interactiveHost();
  // Native session is a getter backed by runtimeHost.
  view.runtimeHost = { session: {
    scopedModels: [], promptTemplates: [],
    extensionRunner: { getRegisteredCommands: () => [
      { name: "mcp", invocationName: "mcp" }, { name: "llama", invocationName: "builtin:llama" },
      { name: "effort", invocationName: "effort" }, { name: "config", invocationName: "config" },
    ] }, resourceLoader: { getSkills: () => ({ skills: [] }) },
    settingsManager: { getEnableSkillCommands: () => false },
    sessionManager: { getCwd: () => process.cwd() },
  } };
  view.skillCommands = new Map();
  const provider = view.createBaseAutocompleteProvider();
  assert.ok(provider.commands.length > 0);
  assert.ok(provider.commands.every((command) => !removedCommand(command.name)));
  for (const name of ["model", "login", "logout", "new", "compact", "resume", "reload", "quit", "effort", "config"]) {
    assert.ok(provider.commands.some((command) => command.name === name), name);
  }
  assert.equal(typeof provider.shouldTriggerFileCompletion, "function");
});

test("embedded preferences retain native save callbacks without mounting the native menu", async () => {
  api.initTheme("dark", false);
  const settings = api.SettingsManager.inMemory();
  const view = interactiveHost();
  view.showSettingsSelector = api.InteractiveMode.prototype.showSettingsSelector;
  view.runtimeHost.session = {
    settingsManager: settings, autoCompactionEnabled: true,
    modelRuntime: { getAvailableSnapshot: () => [] }, steeringMode: "all", followUpMode: "all", agent: {},
  };
  view.themeController = { getThemeSelection: () => "dark", getTerminalTheme: () => "dark" };
  view.chatContainer = { children: [] };
  view.statusContainer = { clear() {} };
  view.ui = { mode: "fullscreen", requestRender() {} };
  view.showSelector = () => assert.fail("the native menu must not be mounted");
  const context = view.createExtensionUIContext();
  assert.equal(typeof context[CONFIG_PREFERENCES], "function");
  const preferences = context[CONFIG_PREFERENCES]();
  const output = measure.stripTerminalSequences(preferences.render(120, 100, createUiTheme()).join("\n"));
  for (const label of ["Theme", "Transport", "Hide thinking", "TUI mode", "Default project trust"]) assert.ok(output.includes(label), label);
  const previous = settings.getTransport();
  preferences.handleInput("transport");
  preferences.handleInput("\r");
  assert.notEqual(settings.getTransport(), previous);
  assert.equal(view.runtimeHost.session.agent.transport, settings.getTransport());
  preferences.handleInput("\x1b");
  assert.equal(preferences.cancelled, true);
  preferences.dispose();
  // Renderer changes must be applied only after the custom overlay is dismissed.
  let switched;
  view.switchTuiMode = (mode) => { switched = mode; return true; };
  const rendererPreferences = captureConfigPreferences(view);
  rendererPreferences.handleInput("TUI mode");
  rendererPreferences.handleInput("\r");
  assert.equal(rendererPreferences.hasPendingChange, true);
  assert.equal(switched, undefined);
  rendererPreferences.dispose();
  rendererPreferences.applyPendingChange();
  assert.equal(switched, "regular");
  assert.equal(settings.getTuiMode(), "regular");
});

test("configuration keeps the overview layout and integrates preferences in its shared frame", async () => {
  let closed = false, cancelled = false, disposed = 0;
  const tui = { terminal: { rows: 30 }, requestRender() {} };
  const sections = [{ title: "Current session", rows: [["Pi", "1.4.0"], ["Model", "sample"]] },
    { title: "Saved preferences", rows: [["Transport", "auto"]] }, { title: "Files", rows: [["Profile", "/profile"]] }];
  const screen = createConfigScreen({ tui, theme: createUiTheme(), measure, done: () => { closed = true; }, readSections: () => sections,
    renderHeader: () => ["  Pi header"], renderFooter: () => ["  auto mode"],
    createPreferences: () => ({ render: () => ["Transport    auto", "Theme        dark"],
      handleInput(data) { if (data === "\x1b") cancelled = true; }, get cancelled() { return cancelled; },
      hasPendingChange: false, applyPendingChange() {}, dispose() { disposed++; } }),
  });
  await screen.ready;
  const text = () => measure.stripTerminalSequences(screen.render(80).join("\n"));
  assert.match(text(), /Current session/); assert.match(text(), /Saved preferences/); assert.match(text(), /Files/);
  assert.doesNotMatch(text(), /Theme\s+dark/);
  screen.handleInput("\t");
  assert.match(text(), /Theme\s+dark/);
  assert.match(text(), /Pi header/); assert.match(text(), /auto mode/);
  assert.equal(closed, false);
  for (const [width, height] of [[80, 24], [24, 12], [8, 8], [1, 4]]) {
    tui.terminal.rows = height;
    const lines = screen.render(width); assert.equal(lines.length, height);
    assert.ok(lines.every((line) => measure.visibleWidth(line) <= width));
  }
  tui.terminal.rows = 30;
  screen.handleInput("\x1b");
  assert.match(text(), /Current session/); assert.equal(closed, false); assert.equal(disposed, 1);
  for (const [width, height] of [[80, 24], [24, 12], [8, 8], [1, 4]]) {
    tui.terminal.rows = height;
    const lines = screen.render(width); assert.equal(lines.length, height);
    assert.ok(lines.every((line) => measure.visibleWidth(line) <= width));
  }
  screen.handleInput("\x1b"); assert.equal(closed, true);
});

test("removed extension commands disappear from command metadata and lookup", () => {
  const runner = Object.create(api.ExtensionRunner.prototype);
  runner.resolveRegisteredCommands = () => [
    { name: "mcp", invocationName: "builtin:mcp" },
    { name: "about-agent", invocationName: "about-agent" },
    { name: "config", invocationName: "config" }, { name: "effort", invocationName: "effort" },
  ];
  assert.deepEqual(runner.getRegisteredCommands().map((command) => command.name), ["config", "effort"]);
  assert.equal(runner.getCommand("builtin:mcp"), undefined);
  assert.equal(runner.getCommand("about-agent"), undefined);
  assert.equal(runner.getCommand("effort").name, "effort");
});
