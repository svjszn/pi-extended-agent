import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundledRuntime } from "../dist/bin/runtime.js";
import { installModelInterface } from "../dist/bin/model-interface.js";
import { createUiTheme } from "../dist/ui/theme.js";

const runtime = bundledRuntime();
const api = await import(pathToFileURL(join(runtime.packageDir, "dist/bundle/index.js")));
const require = createRequire(pathToFileURL(runtime.entry));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
const sourceApi = await import(pathToFileURL(runtime.entry));
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", pathToFileURL(runtime.entry)));
measure.setKeybindings(new KeybindingsManager());
api.initTheme("dark", false);
sourceApi.initTheme("dark", false);
installModelInterface(api, measure, runtime.version);
installModelInterface(sourceApi, measure, runtime.version);
const models = Array.from({ length: 25 }, (_, i) => ({ provider: "example", id: `model-${String(i).padStart(2, "0")}`, name: `Model ${i}` }));

function fixture({ scoped = [], refresh, engine = api } = {}) {
  const host = Object.create(engine.InteractiveMode.prototype);
  const state = { selected: [], closed: false, aborted: false };
  const settingsManager = api.SettingsManager.inMemory();
  const modelRuntime = {
    getAvailableSnapshot: () => models, getModel: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    getError: () => undefined,
    refresh: ({ signal }) => {
      signal.addEventListener("abort", () => { state.aborted = true; });
      return refresh ? refresh(signal) : Promise.resolve({ errors: new Map(), aborted: false });
    },
  };
  host.runtimeHost = { session: { model: models[0], modelRuntime, settingsManager, scopedModels: scoped, thinkingLevel: "medium",
    sessionManager: { getCwd: () => process.cwd() },
    async setModel(model, options) { this.model = model; state.selected.push({ model, persist: options.persist }); },
  } };
  host.ui = { requestRender() {}, terminal: { rows: 30 } };
  host.footerContainer = { render: () => ["  auto mode"] };
  host.footer = { invalidate() {} };
  host.updateAvailableProviderCount = () => {};
  host.updateEditorBorderColor = () => {};
  host.maybeWarnAboutAnthropicSubscriptionAuth = async () => {};
  host.showStatus = (message) => { state.message = message; };
  host.showError = (message) => { state.error = message; };
  host.showSelector = () => assert.fail("native selector must not mount outside the shared frame");
  const tui = { children: [], terminal: { rows: 30 }, requestRender() {} };
  host.createExtensionUIContext = () => ({ custom(create, options) {
    assert.equal(options.overlay, true);
    return new Promise((resolve) => {
      state.panel = create(tui, createUiTheme(), {}, () => {
        state.closed = true; state.panel?.dispose(); resolve();
      });
    });
  } });
  return { host, state, tui };
}

test("model selector uses the shared frame, filters models, and preserves native apply/default callbacks", async () => {
  // The source API shares pi-tui's configured app keybindings. The bundled
  // host normally configures its bindings in the real InteractiveMode constructor.
  for (const [persist, engine] of [[false, api], [true, sourceApi]]) {
    const { host, state, tui } = fixture({ engine });
    host.showModelSelector();
    const panel = state.panel;
    await panel.ready;
    const plain = () => measure.stripTerminalSequences(panel.render(100).join("\n"));
    assert.match(plain(), /pi coding agent v1\.4\.0/);
    assert.match(plain(), /● model-00 \[example\] current/);
    assert.match(plain(), /auto mode/);
    panel.handleInput("model-24");
    assert.match(plain(), /model-24/); assert.doesNotMatch(plain(), /model-01 \[example\]/);
    assert.equal(state.selected.length, 0);
    for (const [width, rows] of [[100, 30], [24, 12], [8, 8], [1, 4]]) {
      tui.terminal.rows = rows;
      const lines = panel.render(width); assert.equal(lines.length, rows);
      assert.ok(lines.every((line) => measure.visibleWidth(line) <= width));
    }
    panel.handleInput(persist ? "\x13" : "\r");
    await new Promise(setImmediate);
    assert.equal(state.selected.length, 1);
    assert.equal(state.selected[0].model.id, "model-24");
    assert.equal(state.selected[0].persist, persist);
    assert.equal(state.closed, true);
    assert.equal(state.error, undefined);
  }
});

test("model scope switching and initial queries keep native behavior", async () => {
  const { host, state } = fixture({ scoped: [{ model: models[0] }] });
  host.showModelSelector("model-");
  await state.panel.ready;
  let plain = measure.stripTerminalSequences(state.panel.render(100).join("\n"));
  assert.match(plain, /Scope: scoped/); assert.doesNotMatch(plain, /model-24 \[example\]/);
  state.panel.handleInput("\t");
  plain = measure.stripTerminalSequences(state.panel.render(100).join("\n"));
  assert.match(plain, /Scope: all/);
  state.panel.handleInput("\x1b");
  assert.equal(state.closed, true); assert.equal(state.selected.length, 0);
});

test("closing the model screen cancels refresh and releases the active native selector", async () => {
  const { host, state } = fixture({ refresh: () => new Promise(() => {}) });
  host.showModelSelector(); await state.panel.ready;
  assert.ok(host.activeSelectorToken);
  host.disposeActiveSelector();
  await new Promise(setImmediate);
  assert.equal(state.closed, true); assert.equal(state.aborted, true);
  assert.equal(host.activeSelectorToken, undefined);
  assert.equal(state.selected.length, 0);
});

test("model selection remains visible while navigating long lists and wrapped rows", async () => {
  const { host, state, tui } = fixture(); host.showModelSelector();
  await state.panel.ready;
  tui.terminal.rows = 12;
  state.panel.render(24);
  for (let i = 0; i < 24; i++) { state.panel.handleInput("\x1b[B"); state.panel.render(24); }
  assert.match(measure.stripTerminalSequences(state.panel.render(24).join("\n")), /model-24/);
  state.panel.handleInput("\x1b");
});
