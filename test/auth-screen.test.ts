import type { Panel, PanelFactory } from "./helpers.ts";
import type { PanelTui } from "../ui/types.js";
import { present } from "./helpers.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { bundledRuntime } = await import(new URL("../dist/bin/runtime.js", import.meta.url).href) as typeof import("../bin/runtime.js");
const { installAuthInterface } = await import(new URL("../dist/bin/auth-interface.js", import.meta.url).href) as typeof import("../bin/auth-interface.js");
const { createUiTheme } = await import(new URL("../dist/ui/theme.js", import.meta.url).href) as typeof import("../ui/theme.js");

const runtime = bundledRuntime();
const api = await import(pathToFileURL(join(runtime.packageDir, "dist/bundle/index.js")).href);
const require = createRequire(pathToFileURL(runtime.entry));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", pathToFileURL(runtime.entry)).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");
measure.setKeybindings(new KeybindingsManager());
api.initTheme("dark", false);
installAuthInterface(api, measure, runtime.version);

function fixture() {
  const host = Object.create(api.InteractiveMode.prototype);
  const state: { panels: { panel: Panel; tui: { terminal: {rows: number}; requestRender(): void }; complete: Promise<void> }[]; removed: string[]; messages: string[]; started?: string; choice?: string } = { panels: [], removed: [], messages: [] };
  const editor = { render: () => [], invalidate() {} };
  const editorContainer = { children: [editor], clear() { this.children = []; }, addChild(child: { render: () => never[]; invalidate(): void; }) { this.children.push(child); } };
  const providers = [
    { id: "fixture-oauth", name: "Example Account", authType: "oauth", status: undefined },
    { id: "fixture-key", name: "Example Key", authType: "api_key", status: { type: "api_key", source: "stored credential" } },
  ];
  const modelRuntime: { logout(id: string): void | Promise<void>; listCredentials(): Promise<never[]>; login?: (...args: Parameters<import("@earendil-works/pi-coding-agent").ModelRuntime["login"]>) => Promise<unknown> } = { async logout(id: string) { state.removed.push(id); }, async listCredentials() { return []; } };
  host.runtimeHost = { session: { model: undefined, thinkingLevel: "medium", modelRuntime, sessionManager: { getCwd: () => process.cwd() } } };
  host.editor = editor;
  host.editorContainer = editorContainer;
  host.ui = { mode: "fullscreen", setFocus() {}, requestRender() {}, terminal: { rows: 24 } };
  host.footerContainer = { render: () => ["  auto mode"] };
  host.showStatus = (message: string) => state.messages.push(message);
  host.showError = (message: string|undefined) => { throw new Error(message); };
  host.updateAvailableProviderCount = async () => {};
  host.getLoginProviderOptions = (type: string) => providers.filter((provider) => !type || provider.authType === type);
  host.getLogoutProviderOptions = async () => providers.slice(1);
  host.startProviderLogin = async (option: { id: string }) => { state.started = option.id; };
  host.createExtensionUIContext = () => ({ custom(create: PanelFactory, options: { overlay: boolean }) {
    assert.equal(options.overlay, true);
    const tui = { children: [], terminal: { rows: 24 }, requestRender() {} };
    let panel!: Panel;
    const complete = new Promise<void>((resolve) => {
      panel = create(tui, createUiTheme(), {}, () => { panel.dispose(); resolve(); });
    });
    state.panels.push({ panel, tui, complete });
    return complete;
  } });
  const latest = () => present(state.panels.at(-1));
  const plain = (width = 80) => measure.stripTerminalSequences(present(latest()).panel.render(width).join("\n"));
  return { host, state, latest, plain, providers, modelRuntime };
}

test("login method and searchable provider choices use the shared full-screen frame and native callbacks", async () => {
  const { host, state, latest, plain } = fixture();
  host.showLoginAuthTypeSelector();
  await present(latest()).panel.ready;
  assert.ok(plain().includes(`pi coding agent v${runtime.version}`));
  assert.match(plain(), /Login/);
  assert.doesNotMatch(plain(), /╭|╰/);
  present(latest()).panel.handleInput("\r");
  assert.equal(state.panels.length, 2);
  await present(latest()).panel.ready;
  assert.match(plain(), /Example Account/);
  assert.doesNotMatch(plain(), /Example Key/);
  present(latest()).panel.handleInput("Example");
  assert.match(plain(), /Example Account/);
  present(latest()).panel.handleInput("\r");
  await new Promise(setImmediate);
  assert.equal(state.started, "fixture-oauth");
  for (const entry of state.panels) await entry.complete;
  assert.equal(host.activeSelectorToken, undefined);
});

test("logout lists stored credentials and delegates removal to Pi only on selection", async () => {
  const { host, state, latest, plain, modelRuntime } = fixture();
  await host.showOAuthSelector("logout");
  await present(latest()).panel.ready;
  assert.match(plain(), /Logout/);
  assert.match(plain(), /Example Key/);
  assert.deepEqual(state.removed, []);
  present(latest()).panel.handleInput("\x1b");
  await present(latest()).complete;
  assert.deepEqual(state.removed, []);
  await host.showOAuthSelector("logout");
  present(latest()).panel.handleInput("\r");
  await new Promise(setImmediate);
  assert.deepEqual(state.removed, ["fixture-key"]);
  assert.match(present(state.messages.at(-1)), /Removed stored API key/);
  assert.equal(host.activeSelectorToken, undefined);
  modelRuntime.logout = () => { throw new Error("logout failed"); };
});

test("login dialog keeps Pi's input and cancellation while hiding submitted text in the shared frame", async () => {
  const { host, state, latest, plain, modelRuntime } = fixture();
  host.programStatus = { setBlocked() {} };
  host.runtimeHost.session.settingsManager = { getOrCreateDeviceId: () => "fixture-device" };
  modelRuntime.login = async (_provider, _method, { signal, prompt }) => {
    await prompt({ type: "text", message: "Enter test value" });
    if (present(signal).aborted) throw new Error("Login cancelled");
    await new Promise((_, reject) => present(signal).addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true }));
  };
  const pending = host.showApiKeyLoginDialog("fixture-key", "Example Key");
  assert.equal(state.panels.length, 1);
  await present(latest()).panel.ready;
  assert.match(plain(), /Login · Example Key/);
  assert.match(plain(), /Enter test value/);
  present(latest()).panel.handleInput("example-input");
  assert.doesNotMatch(plain(), /example-input/);
  assert.match(plain(), /•/);
  present(latest()).panel.handleInput("\r");
  assert.doesNotMatch(plain(), /example-input/);
  present(latest()).panel.handleInput("\x1b");
  await pending;
  await present(latest()).complete;
  assert.equal(host.editorContainer.children.at(-1), host.editor);
});

test("native OAuth method prompts remain usable in the styled login dialog", async () => {
  const { host, state, latest, plain, modelRuntime } = fixture();
  host.programStatus = { setBlocked() {} };
  host.runtimeHost.session.settingsManager = { getOrCreateDeviceId: () => "fixture-device" };
  modelRuntime.login = async (_provider, _method, { signal, prompt }) => {
    state.choice = await prompt({ type: "select", message: "Choose method", options: [
      { id: "first", label: "First method" }, { id: "second", label: "Second method" },
    ] });
    if (present(signal).aborted) throw new Error("Login cancelled");
    await new Promise((_, reject) => present(signal).addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true }));
  };
  const pending = host.showLoginDialog("fixture-oauth", "Example Account");
  await present(latest()).panel.ready;
  assert.match(plain(), /First method/);
  present(latest()).panel.handleInput("\x1b[B");
  present(latest()).panel.handleInput("\r");
  await new Promise(setImmediate);
  assert.equal(state.choice, "second");
  present(latest()).panel.handleInput("\x1b");
  await pending;
  await present(latest()).complete;
  assert.equal(host.editorContainer.children.at(-1), host.editor);
});

test("ambient login information can close without leaving an overlay", async () => {
  const { host, latest, plain } = fixture();
  host.showAmbientAuthDialog({ id: "fixture-external", name: "External auth", method: { name: "External setup" } });
  await present(latest()).panel.ready;
  assert.match(plain(), /External setup/);
  present(latest()).panel.handleInput("\x1b");
  await present(latest()).complete;
  assert.equal(host.editorContainer.children.at(-1), host.editor);
});

test("auth selectors stay bounded in narrow terminals and cancelling restores the native editor", async () => {
  const { host, state, latest, plain } = fixture();
  host.showLoginProviderSelector("api_key");
  await present(latest()).panel.ready;
  for (const [width, rows] of [[80, 24], [24, 12], [8, 8], [1, 4]]) {
    present(latest()).tui.terminal.rows = rows;
    const lines = present(latest()).panel.render(width);
    assert.equal(lines.length, rows);
    assert.ok(lines.every((line: string) => measure.visibleWidth(line) <= width));
  }
  present(latest()).tui.terminal.rows = 24;
  assert.match(plain(), /Example Key/);
  present(latest()).panel.handleInput("\x1b");
  assert.equal(state.panels.length, 2, "native Back returns to the login methods");
  present(latest()).panel.handleInput("\x1b");
  for (const entry of state.panels) await entry.complete;
  assert.equal(host.editorContainer.children.at(-1), host.editor);
});
