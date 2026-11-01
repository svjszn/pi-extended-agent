import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundledRuntime } from "../dist/bin/runtime.js";
import { installAuthInterface } from "../dist/bin/auth-interface.js";
import { createUiTheme } from "../dist/ui/theme.js";

const runtime = bundledRuntime();
const api = await import(pathToFileURL(join(runtime.packageDir, "dist/bundle/index.js")));
const require = createRequire(pathToFileURL(runtime.entry));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", pathToFileURL(runtime.entry)));
measure.setKeybindings(new KeybindingsManager());
api.initTheme("dark", false);
installAuthInterface(api, measure, runtime.version);

function fixture() {
  const host = Object.create(api.InteractiveMode.prototype);
  const state = { panels: [], removed: [], messages: [] };
  const editor = { render: () => [], invalidate() {} };
  const editorContainer = { children: [editor], clear() { this.children = []; }, addChild(child) { this.children.push(child); } };
  const providers = [
    { id: "fixture-oauth", name: "Example Account", authType: "oauth", status: undefined },
    { id: "fixture-key", name: "Example Key", authType: "api_key", status: { type: "api_key", source: "stored credential" } },
  ];
  const modelRuntime = { async logout(id) { state.removed.push(id); }, async listCredentials() { return []; } };
  host.runtimeHost = { session: { model: undefined, thinkingLevel: "medium", modelRuntime, sessionManager: { getCwd: () => process.cwd() } } };
  host.editor = editor;
  host.editorContainer = editorContainer;
  host.ui = { mode: "fullscreen", setFocus() {}, requestRender() {}, terminal: { rows: 24 } };
  host.footerContainer = { render: () => ["  auto mode"] };
  host.showStatus = (message) => state.messages.push(message);
  host.showError = (message) => { throw new Error(message); };
  host.updateAvailableProviderCount = async () => {};
  host.getLoginProviderOptions = (type) => providers.filter((provider) => !type || provider.authType === type);
  host.getLogoutProviderOptions = async () => providers.slice(1);
  host.startProviderLogin = async (option) => { state.started = option.id; };
  host.createExtensionUIContext = () => ({ custom(create, options) {
    assert.equal(options.overlay, true);
    const tui = { children: [], terminal: { rows: 24 }, requestRender() {} };
    let panel;
    const complete = new Promise((resolve) => {
      panel = create(tui, createUiTheme(), {}, () => { panel.dispose(); resolve(); });
    });
    state.panels.push({ panel, tui, complete });
    return complete;
  } });
  const latest = () => state.panels.at(-1);
  const plain = (width = 80) => measure.stripTerminalSequences(latest().panel.render(width).join("\n"));
  return { host, state, latest, plain, providers, modelRuntime };
}

test("login method and searchable provider choices use the shared full-screen frame and native callbacks", async () => {
  const { host, state, latest, plain } = fixture();
  host.showLoginAuthTypeSelector();
  await latest().panel.ready;
  assert.match(plain(), /pi coding agent v1\.4\.0/);
  assert.match(plain(), /Login/);
  assert.doesNotMatch(plain(), /╭|╰/);
  latest().panel.handleInput("\r");
  assert.equal(state.panels.length, 2);
  await latest().panel.ready;
  assert.match(plain(), /Example Account/);
  assert.doesNotMatch(plain(), /Example Key/);
  latest().panel.handleInput("Example");
  assert.match(plain(), /Example Account/);
  latest().panel.handleInput("\r");
  await new Promise(setImmediate);
  assert.equal(state.started, "fixture-oauth");
  for (const entry of state.panels) await entry.complete;
  assert.equal(host.activeSelectorToken, undefined);
});

test("logout lists stored credentials and delegates removal to Pi only on selection", async () => {
  const { host, state, latest, plain, modelRuntime } = fixture();
  await host.showOAuthSelector("logout");
  await latest().panel.ready;
  assert.match(plain(), /Logout/);
  assert.match(plain(), /Example Key/);
  assert.deepEqual(state.removed, []);
  latest().panel.handleInput("\x1b");
  await latest().complete;
  assert.deepEqual(state.removed, []);
  await host.showOAuthSelector("logout");
  latest().panel.handleInput("\r");
  await new Promise(setImmediate);
  assert.deepEqual(state.removed, ["fixture-key"]);
  assert.match(state.messages.at(-1), /Removed stored API key/);
  assert.equal(host.activeSelectorToken, undefined);
  modelRuntime.logout = () => { throw new Error("logout failed"); };
});

test("login dialog keeps Pi's input and cancellation while hiding submitted text in the shared frame", async () => {
  const { host, state, latest, plain, modelRuntime } = fixture();
  host.programStatus = { setBlocked() {} };
  host.runtimeHost.session.settingsManager = { getOrCreateDeviceId: () => "fixture-device" };
  modelRuntime.login = async (_provider, _method, { signal, prompt }) => {
    await prompt({ type: "text", message: "Enter test value" });
    if (signal.aborted) throw new Error("Login cancelled");
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true }));
  };
  const pending = host.showApiKeyLoginDialog("fixture-key", "Example Key");
  assert.equal(state.panels.length, 1);
  await latest().panel.ready;
  assert.match(plain(), /Login · Example Key/);
  assert.match(plain(), /Enter test value/);
  latest().panel.handleInput("example-input");
  assert.doesNotMatch(plain(), /example-input/);
  assert.match(plain(), /•/);
  latest().panel.handleInput("\r");
  assert.doesNotMatch(plain(), /example-input/);
  latest().panel.handleInput("\x1b");
  await pending;
  await latest().complete;
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
    if (signal.aborted) throw new Error("Login cancelled");
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true }));
  };
  const pending = host.showLoginDialog("fixture-oauth", "Example Account");
  await latest().panel.ready;
  assert.match(plain(), /First method/);
  latest().panel.handleInput("\x1b[B");
  latest().panel.handleInput("\r");
  await new Promise(setImmediate);
  assert.equal(state.choice, "second");
  latest().panel.handleInput("\x1b");
  await pending;
  await latest().complete;
  assert.equal(host.editorContainer.children.at(-1), host.editor);
});

test("ambient login information can close without leaving an overlay", async () => {
  const { host, latest, plain } = fixture();
  host.showAmbientAuthDialog({ id: "fixture-external", name: "External auth", method: { name: "External setup" } });
  await latest().panel.ready;
  assert.match(plain(), /External setup/);
  latest().panel.handleInput("\x1b");
  await latest().complete;
  assert.equal(host.editorContainer.children.at(-1), host.editor);
});

test("auth selectors stay bounded in narrow terminals and cancelling restores the native editor", async () => {
  const { host, state, latest, plain } = fixture();
  host.showLoginProviderSelector("api_key");
  await latest().panel.ready;
  for (const [width, rows] of [[80, 24], [24, 12], [8, 8], [1, 4]]) {
    latest().tui.terminal.rows = rows;
    const lines = latest().panel.render(width);
    assert.equal(lines.length, rows);
    assert.ok(lines.every((line) => measure.visibleWidth(line) <= width));
  }
  latest().tui.terminal.rows = 24;
  assert.match(plain(), /Example Key/);
  latest().panel.handleInput("\x1b");
  assert.equal(state.panels.length, 2, "native Back returns to the login methods");
  latest().panel.handleInput("\x1b");
  for (const entry of state.panels) await entry.complete;
  assert.equal(host.editorContainer.children.at(-1), host.editor);
});
