import { present } from "./helpers.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { bundledRuntime } = await import(new URL("../dist/bin/runtime.js", import.meta.url).href) as typeof import("../bin/runtime.js");
const { installCommandPolicy, captureConfigPreferences } = await import(new URL("../dist/bin/command-policy.js", import.meta.url).href) as typeof import("../bin/command-policy.js");
const { chromeProbeHost, keepSessionChrome, nativeSessionReset } = await import(new URL("../dist/bin/chrome-interface.js", import.meta.url).href) as typeof import("../bin/chrome-interface.js");
const { createConfigScreen } = await import(new URL("../dist/ui/config-screen.js", import.meta.url).href) as typeof import("../ui/config-screen.js");
const { createUiTheme } = await import(new URL("../dist/ui/theme.js", import.meta.url).href) as typeof import("../ui/theme.js");
import { createRequire } from "node:module";
const { CONFIG_PREFERENCES } = await import(new URL("../dist/lib/config-preferences.js", import.meta.url).href) as typeof import("../lib/config-preferences.js");
const { REMOVED_COMMANDS, redirectedCommand, removedCommand } = await import(new URL("../dist/lib/command-policy.js", import.meta.url).href) as typeof import("../lib/command-policy.js");
const { default: sessionCommand } = await import(new URL("../dist/extensions/session.js", import.meta.url).href) as typeof import("../extensions/session.js");

// Exercise the same bundled classes that the executable uses, without a terminal,
// credentials, provider calls, or writing settings to the real profile.
const runtime = bundledRuntime();
const api = await import(pathToFileURL(join(runtime.packageDir, "dist/bundle/index.js")).href);
const require = createRequire(pathToFileURL(runtime.entry));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
installCommandPolicy(api);

function interactiveHost() {
  const view = Object.create(api.InteractiveMode.prototype);
  view.defaultEditor = {};
  view.editor = { setText(text: string) { view.draft = text; } };
  view.showStatus = (text: string) => { view.notice = text; };
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
  view.onInputCallback = (text: string) => { submitted = text; };
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
  assert.ok(provider.commands.every((command: { name: string; }) => !removedCommand(command.name)));
  for (const name of ["model", "login", "logout", "new", "compact", "resume", "reload", "quit", "effort", "config"]) {
    assert.ok(provider.commands.some((command: { name: string; }) => command.name === name), name);
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
  let legacy = "off";
  const preferences = context[CONFIG_PREFERENCES]({
    items: [{ id: "legacy-logo", label: "Legacy logo", currentValue: legacy, values: ["off", "on"] }],
    onChange: (_id: string, value: string) => { legacy = value; return value; },
  });
  const output = measure.stripTerminalSequences(preferences.render(120, 100, createUiTheme()).join("\n"));
  for (const label of ["Theme", "Transport", "Hide thinking", "TUI mode", "Default project trust", "Legacy logo"]) assert.ok(output.includes(label), label);
  preferences.handleInput("Legacy logo");
  preferences.handleInput("\r");
  assert.equal(legacy, "on");
  assert.match(measure.stripTerminalSequences(preferences.render(120, 100, createUiTheme()).join("\n")), /Legacy logo\s+on/);
  for (const _ of "Legacy logo") preferences.handleInput("\x7f");
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
  view.switchTuiMode = (mode: string) => { switched = mode; return true; };
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
  const sections: import("../lib/config.js").ConfigSection[] = [{ title: "Current session", rows: [["Pi", "1.4.0"], ["Model", "sample"]] },
    { title: "Saved preferences", rows: [["Transport", "auto"]] }, { title: "Files", rows: [["Profile", "/profile"]] }];
  const screen = createConfigScreen({ tui, theme: createUiTheme(), measure, done: () => { closed = true; }, readSections: () => sections,
    renderHeader: () => ["  Pi header"], renderFooter: () => ["  allow mode"],
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
  assert.match(text(), /Pi header/); assert.match(text(), /allow mode/);
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
  assert.deepEqual(runner.getRegisteredCommands().map((command: {name:string}) => command.name), ["config", "effort"]);
  assert.equal(runner.getCommand("builtin:mcp"), undefined);
  assert.equal(runner.getCommand("about-agent"), undefined);
  assert.equal(runner.getCommand("effort").name, "effort");
});

test("/new reaches this interface's /clear, with arguments and spacing preserved", async () => {
  for (const [text, expected] of [
    ["/new", "/clear"], ["  /new  ", "/clear"], ["/new keep this", "/clear keep this"],
    ["/newish", undefined], ["/clear", undefined], ["new", undefined], ["", undefined],
    ["/compact", undefined], ["Tell me about /new", undefined],
  ]) {
    assert.equal(redirectedCommand(present(text)), expected, JSON.stringify(text));
  }
  // The native submit handler receives the rewritten text, not the original.
  const view = interactiveHost();
  const submissions: string[] = [];
  view.setupEditorSubmitHandler();
  Object.assign(view, { flushPendingBashComponents() {}, onInputCallback: (text: string) => submissions.push(text) });
  await view.defaultEditor.onSubmit("/new");
  assert.deepEqual(submissions, ["/clear"], "Pi must not claim /new before this interface");
  // Another built-in still reaches Pi's own handler, which this bare host cannot run.
  await Promise.resolve(view.defaultEditor.onSubmit("/compact")).catch(() => {});
  assert.deepEqual(submissions, ["/clear"], "only /new is rewritten");
});

test("clearing starts a new session and refuses while the agent is working", async () => {
  const commands = new Map();
  sessionCommand(({ on() {}, getThinkingLevel: () => "medium", registerCommand: ((name, command) => commands.set(name, command)) satisfies ExtensionAPI["registerCommand"] } as unknown as Parameters<typeof sessionCommand>[0]));
  assert.deepEqual([...commands.keys()], ["clear"]);
  const calls: string[] = [], notices: [string,string,string][] = [];
  // Pi invalidates the context that started the replacement; a stale use throws
  // exactly as the engine does, so the handler must report through withSession.
  const ctx = (idle: boolean, result = { cancelled: false }) => {
    let stale = false;
    return {
      hasUI: true, isIdle: () => idle, cwd: process.cwd(),
      sessionManager: { getSessionFile: () => undefined, getEntries: () => [] },
      newSession: async (options: {withSession?: (ctx: unknown) => Promise<void>}) => {
        calls.push("newSession");
        if (!result.cancelled) {
          stale = true;
          await options?.withSession?.({ hasUI: true, ui: { notify: (text: string, type: string) => notices.push(["fresh", text, type]) } });
        }
        return result;
      },
      get ui() {
        if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
        return { notify: (text: string, type: string) => notices.push(["original", text, type]) };
      },
    };
  };
  await commands.get("clear").handler("", ctx(true));
  assert.deepEqual(calls, ["newSession"]);
  assert.deepEqual(present(notices.at(-1)).slice(0, 1), ["fresh"], "the replacement context reports the result");
  assert.match(present(notices.at(-1))[1], /New session started/);
  assert.equal(present(notices.at(-1))[2], "info");
  // A run in progress must not have its session replaced underneath it.
  await commands.get("clear").handler("", ctx(false));
  assert.equal(calls.length, 1);
  assert.match(present(notices.at(-1))[1], /Wait for the current run/);
  assert.equal(present(notices.at(-1))[2], "error");
  // Nothing was replaced, so a cancellation still reports on the original context.
  await commands.get("clear").handler("", ctx(true, { cancelled: true }));
  assert.deepEqual(present(notices.at(-1)).slice(0, 1), ["original"]);
  assert.match(present(notices.at(-1))[1], /cancelled/);
  assert.doesNotMatch(present(notices.at(-1))[1], /New session started/);
});

test("a session replacement keeps the interface chrome that Pi would otherwise release", () => {
  // Pi detaches extension components before it invalidates the outgoing
  // session, so its own header, footer and editor would be on screen for as
  // long as loading the replacement takes.
  const released = chromeProbeHost(api);
  nativeSessionReset(api).call(released);
  assert.deepEqual([...released.released].sort(),
    ["setCustomEditorComponent:release", "setExtensionFooter:release", "setExtensionHeader:release"]);
  keepSessionChrome(api);
  const kept = chromeProbeHost(api);
  kept.resetExtensionUI();
  assert.deepEqual(kept.released, [], "the header, footer and input stay mounted while the next session loads");
  kept.setExtensionHeader(() => ({}));
  assert.deepEqual(kept.released, ["setExtensionHeader:mount"], "the next session still takes the slots over");
});
