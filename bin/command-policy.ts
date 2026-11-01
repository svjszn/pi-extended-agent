import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { commandName, removedCommand, removedCommandMessage } from "../lib/command-policy.js";
import type { Runtime } from "./runtime.js";
import { CONFIG_PREFERENCES } from "../lib/config-preferences.js";
import type { ConfigPreferences, ConfigPreferencesUI } from "../lib/config-preferences.js";
import type { SettingsListTheme } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { installModelInterface } from "./model-interface.js";
import { installAuthInterface } from "./auth-interface.js";
import type { AuthInterfaceApi } from "./auth-interface.js";
import type { ModelInterfaceApi } from "./model-interface.js";
import type { Measure } from "../ui/types.js";

type Submit = (text: string) => unknown;
interface Command { name: string; invocationName?: string }
interface CommandHost {
  defaultEditor: { onSubmit?: Submit };
  editor: { setText(text: string): void };
  createBaseAutocompleteProvider(): { commands: Command[] };
  setupEditorSubmitHandler(): void;
  showSettingsSelector(): void;
  showStatus(text: string): void;
  createExtensionUIContext(): ConfigPreferencesUI;
  showSelector(create: (done: () => void) => { component: { getSettingsList(): NativeSettingsList } }): void;
}
interface NativeSettingsList {
  render(width: number): string[];
  handleInput(data: string): void;
  maxVisible: number;
  theme: SettingsListTheme;
  submenuComponent?: unknown;
  onChange(id: string, value: string): void;
}
interface CommandRunner {
  getRegisteredCommands(): Command[];
  getCommand(name: string): Command | undefined;
}
interface PromptHost { prompt(text: string, options?: unknown): Promise<unknown> }
export interface CommandRuntimeApi {
  InteractiveMode: { prototype: CommandHost };
  ExtensionRunner: { prototype: CommandRunner };
  AgentSession: { prototype: PromptHost };
  SettingsManager: { inMemory(): unknown };
  initTheme(name: string, watch: boolean): void;
}

const installed = new WeakSet<object>();

/** Runtime-only adapters: never edit upstream files or duplicate its settings callbacks. */
export function installCommandPolicy(api: CommandRuntimeApi) {
  const ui = api.InteractiveMode?.prototype;
  const runner = api.ExtensionRunner?.prototype;
  const session = api.AgentSession?.prototype;
  for (const method of [ui?.createBaseAutocompleteProvider, ui?.setupEditorSubmitHandler, ui?.showSettingsSelector, ui?.createExtensionUIContext,
    runner?.getRegisteredCommands, runner?.getCommand, session?.prompt]) {
    if (typeof method !== "function") throw new Error("This Pi engine does not support the command-menu adapter.");
  }
  if (installed.has(ui)) return;
  const autocomplete = ui.createBaseAutocompleteProvider;
  ui.createBaseAutocompleteProvider = function () {
    const provider = autocomplete.call(this);
    if (!Array.isArray(provider.commands)) throw new Error("Pi command autocomplete has changed.");
    provider.commands = provider.commands.filter((command) => !removedCommand(command.name));
    return provider;
  };
  const setupSubmit = ui.setupEditorSubmitHandler;
  ui.setupEditorSubmitHandler = function () {
    setupSubmit.call(this);
    const submit = this.defaultEditor.onSubmit;
    if (!submit) throw new Error("Pi command submission has changed.");
    this.defaultEditor.onSubmit = (text) => {
      const name = commandName(text);
      if (name && removedCommand(name)) {
        this.editor.setText("");
        this.showStatus(removedCommandMessage(name));
        return;
      }
      return submit(text);
    };
  };
  const commands = runner.getRegisteredCommands;
  runner.getRegisteredCommands = function () {
    return commands.call(this).filter((command) => !removedCommand(command.name)
      && !removedCommand(command.invocationName ?? command.name));
  };
  const getCommand = runner.getCommand;
  runner.getCommand = function (name) {
    if (removedCommand(name)) return undefined;
    const command = getCommand.call(this, name);
    return command && !removedCommand(command.name) ? command : undefined;
  };
  const prompt = session.prompt;
  session.prompt = function (text, options) {
    const name = commandName(text);
    if (name && removedCommand(name)) return Promise.reject(new Error(removedCommandMessage(name)));
    return prompt.call(this, text, options);
  };
  const createUI = ui.createExtensionUIContext;
  ui.createExtensionUIContext = function () {
    const context = createUI.call(this);
    context[CONFIG_PREFERENCES] = () => captureConfigPreferences(this);
    return context;
  };
  installed.add(ui);
}

/** Reuse every native item and save callback, without mounting the native menu. */
export function captureConfigPreferences(host: CommandHost): ConfigPreferences {
  let list: NativeSettingsList | undefined, cancelled = false, pending: (() => void) | undefined;
  const originalSelector = host.showSelector;
  try {
    host.showSelector = (create) => { list = create(() => { cancelled = true; }).component.getSettingsList(); };
    host.showSettingsSelector();
  } finally { host.showSelector = originalSelector; }
  if (!list || typeof list.render !== "function" || typeof list.onChange !== "function") {
    throw new Error("Pi preferences are incompatible with the configuration screen.");
  }
  const settings = list;
  const change = settings.onChange;
  settings.onChange = (id, value) => {
    // Changing renderers requires the overlay to close before invoking Pi's callback.
    if (id === "tui-mode") pending = () => change(id, value);
    else change(id, value);
  };
  return {
    get cancelled() { return cancelled; },
    get hasPendingChange() { return Boolean(pending); },
    applyPendingChange() { const apply = pending; pending = undefined; apply?.(); },
    handleInput: (data) => settings.handleInput(data),
    render(width, rows, theme) {
      settings.maxVisible = Math.max(1, rows - 7);
      settings.theme = {
        label: (text, selected) => theme.fg(selected ? "primary" : "muted", text),
        value: (text) => theme.fg("text", text), description: (text) => theme.fg("dim", text),
        cursor: theme.fg("primary", "› "), hint: (text) => theme.fg("dim", text),
      };
      // Native menus assume a minimum label width; the shared panel clips tiny terminals.
      const lines = settings.render(Math.max(40, width));
      // Submenus obtain their own native theme. Keep them monochrome as well.
      return settings.submenuComponent
        ? lines.map((line) => theme.fg("text", line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")))
        : lines;
    },
    dispose() {
      // Cancel nested theme previews before leaving the preferences tab.
      for (let i = 0; settings.submenuComponent && i < 10; i++) settings.handleInput("\x1b");
    },
  };
}

export async function prepareRuntimeCommands(runtime: Runtime) {
  // The executable and bundle index share classes. Patching dist/index.js alone
  // would leave the actual bundled CLI's menu and submit handler unchanged.
  const bundle = join(runtime.packageDir, "dist", "bundle", "index.js");
  if (!existsSync(bundle)) throw new Error("Pi engine is missing its bundled command API.");
  const api = await import(pathToFileURL(bundle).href) as CommandRuntimeApi;
  installCommandPolicy(api);
  const require = createRequire(pathToFileURL(runtime.entry));
  const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as Measure;
  installModelInterface(api as unknown as ModelInterfaceApi, measure, runtime.version);
  installAuthInterface(api as unknown as AuthInterfaceApi, measure, runtime.version);
  return api;
}

/** Probe private adapter surfaces without creating a session or accessing a profile. */
export async function verifyCommandPolicy(api: CommandRuntimeApi) {
  const host = Object.create(api.InteractiveMode.prototype) as CommandHost;
  Object.defineProperties(host, {
    session: { configurable: true, value: { scopedModels: [], promptTemplates: [],
      extensionRunner: { getRegisteredCommands: () => [{ name: "config", invocationName: "config" }] },
      resourceLoader: { getSkills: () => ({ skills: [] }) } } },
    sessionManager: { value: { getCwd: () => process.cwd() } },
    settingsManager: { configurable: true, value: { getEnableSkillCommands: () => false } },
    skillCommands: { value: new Map() },
  });
  const provider = host.createBaseAutocompleteProvider();
  if (provider.commands.some((command) => removedCommand(command.name))
    || !provider.commands.some((command) => command.name === "config")
    || !provider.commands.some((command) => command.name === "model")) {
    throw new Error("Pi command-menu filtering is incompatible.");
  }
  let settingsOpened = false, removedNotice = false, submitted = "";
  host.defaultEditor = {};
  host.editor = { setText() {} };
  host.showStatus = () => { removedNotice = true; };
  host.showSettingsSelector = () => { settingsOpened = true; };
  host.setupEditorSubmitHandler();
  await host.defaultEditor.onSubmit!("/settings");
  if (!removedNotice || settingsOpened) throw new Error("Pi still executes removed commands.");
  // /config must reach our extension rather than mount the native settings menu.
  Object.assign(host, { flushPendingBashComponents() {}, onInputCallback: (text: string) => { submitted = text; } });
  await host.defaultEditor.onSubmit!("/config");
  if (settingsOpened || submitted !== "/config") throw new Error("Pi bypasses the custom configuration screen.");
  // Probe the settings-data bridge as well as command submission. Native data
  // and callbacks can change even when the old menu method still exists.
  api.initTheme("dark", false);
  const engineSettings = api.SettingsManager.inMemory();
  Object.defineProperty(host, "settingsManager", { value: engineSettings });
  Object.defineProperty(host, "session", { configurable: true, value: {
    settingsManager: engineSettings, autoCompactionEnabled: true,
    modelRuntime: { getAvailableSnapshot: () => [] }, steeringMode: "all", followUpMode: "all",
  } });
  Object.assign(host, {
    showSettingsSelector: api.InteractiveMode.prototype.showSettingsSelector,
    themeController: { getThemeSelection: () => "dark", getTerminalTheme: () => "dark" },
    ui: { mode: "fullscreen" }, chatContainer: { children: [] },
  });
  const preferences = captureConfigPreferences(host);
  try {
    if (!preferences.render(80, 24, { fg: (_role, text) => text, bold: (text) => text }).length) {
      throw new Error("Pi configuration preferences are empty.");
    }
  } finally { preferences.dispose(); }
  // Verify the controller fields consumed by our model renderer against the
  // candidate executable, without authentication or a catalog network request.
  const model = { provider: "compat", id: "compat-model", name: "Compatibility model" };
  Object.defineProperty(host, "session", { value: {
    model, thinkingLevel: "medium", settingsManager: engineSettings, scopedModels: [],
    modelRuntime: { getAvailableSnapshot: () => [model], getModel: () => model, getError: () => undefined,
      refresh: async () => ({ errors: new Map(), aborted: false }) },
  } });
  const tui = { children: [], terminal: { rows: 24, columns: 80 }, requestRender() {} };
  let modelScreen: Promise<void> | undefined;
  interface ProbePanel { ready?: Promise<unknown>; render(width: number): string[]; handleInput(data: string): void; dispose(): void }
  Object.assign(host, {
    ui: tui, footerContainer: { render: () => [] },
    showError: (message: string) => { throw new Error(message); },
    createExtensionUIContext: () => ({ custom: (create: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => ProbePanel) => {
      modelScreen = Promise.resolve().then(async () => {
        const panel = create(tui, {}, {}, () => panel.dispose());
        try {
          await panel.ready;
          if (!panel.render(80).some((line) => line.includes("compat-model"))) throw new Error("Pi model selection has changed.");
          panel.handleInput("\x1b");
        } finally { panel.dispose(); }
      });
      return modelScreen;
    } }),
  });
  (host as unknown as { showModelSelector(query: string): void }).showModelSelector("compat-model");
  if (!modelScreen) throw new Error("Pi bypasses the styled model screen.");
  await modelScreen;
}
