import { tuiFixture } from "./helpers.ts";
import { present } from "./helpers.ts";
import assert from "node:assert/strict";
import test from "node:test";
const { bundledRuntime } = await import(new URL("../dist/bin/runtime.js", import.meta.url).href) as typeof import("../bin/runtime.js");
const { verifyRuntime } = await import(new URL("../dist/bin/verify-runtime.js", import.meta.url).href) as typeof import("../bin/verify-runtime.js");
import { fileURLToPath, pathToFileURL } from "node:url";
const { hasModel, startupAuthNotice } = await import(new URL("../dist/lib/startup.js", import.meta.url).href) as typeof import("../lib/startup.js");
import { captureCommand } from "../scripts/capture-command.mjs";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";

test("launcher delegates model selection to the active engine and forwards explicit choices", (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const fixtureRoot = resolve(root, ".local/startup-tests");
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(join(fixtureRoot, "runtime-"));
  t.after(() => {
    const target = resolve(directory);
    assert.ok(target.startsWith(fixtureRoot + sep));
    rmSync(target, { recursive: true, force: true });
  });
  const packageDir = join(directory, "releases/1.4.0/node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(directory, "active.json"), JSON.stringify({ version: "1.4.0", previous: null }));
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent", version: "1.4.0", type: "module", main: "cli.js", bin: { pi: "cli.js" },
  }));
  writeFileSync(join(packageDir, "cli.js"), "console.log(JSON.stringify(process.argv.slice(2)));");
  const bundleDir = join(packageDir, "dist/bundle");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "index.js"), `
    export class InteractiveMode { createBaseAutocompleteProvider() {} setupEditorSubmitHandler() {} showSettingsSelector() {} createExtensionUIContext() {} showWarning() {} showModelSelector() {} disposeActiveSelector() {} showSelector() {} showLoginDialog() {} showApiKeyLoginDialog() {} showAmbientAuthDialog() {} resetExtensionUI() {} setExtensionHeader() {} setExtensionFooter() {} setCustomEditorComponent() {} }
    export class ExtensionRunner { getRegisteredCommands() {} getCommand() {} }
    export class AgentSession { async prompt() {} }
  `);
  for (const args of [[], ["Fix the login"], ["--", "--model"],
    ["--model", "openai-codex/gpt-6.1-sol"], ["--model", "custom-id"],
    ["--provider", "anthropic"], ["--models", "openai-codex/*"],
    ["--continue"], ["-c"], ["--resume"], ["--session", "session.jsonl"], ["--fork", "session.jsonl"],
  ]) {
    const result = captureCommand(process.execPath, [join(root, "bin/pi.mjs"), ...args], {
      cwd: root, encoding: "utf8", timeout: 10_000, env: { ...process.env, PI_EXTENDED_RUNTIME_DIR: directory },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["--extension", root, "--tui-mode", "fullscreen", ...args]);
  }
});

test("version and offline update checks do not initialize the interface or compatibility verifier", t => {
  const root = fileURLToPath(new URL("../", import.meta.url)), base = join(root, ".local/startup-tests");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "lazy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const guard = join(directory, "guard.mjs"), prefix = pathToFileURL(join(root, "dist") + "/").href;
  writeFileSync(guard, `import { registerHooks } from "node:module";
    const prefix = ${JSON.stringify(prefix)};
    registerHooks({ load(url, context, nextLoad) {
      if (url.startsWith(prefix)) {
        const name = url.slice(prefix.length);
        if (name.startsWith("ui/") || ["bin/command-policy.js", "bin/verify-runtime.js", "bin/self-update.js"].includes(name)) {
          throw new Error("Unexpected eager dependency: " + name);
        }
      }
      return nextLoad(url, context);
    } });`);
  for (const args of [["--version"], ["update", "--help"], ["update", "--engine", "--check", "--offline"]]) {
    const result = captureCommand(process.execPath, ["--import", pathToFileURL(guard).href, join(root, "bin/pi.mjs"), ...args], {
      cwd: directory, encoding: "utf8", timeout: 10000,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "profile"), PI_EXTENDED_RUNTIME_DIR: join(directory, "runtime"), PI_OFFLINE: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Pi|engine/i);
  }
});

test("the actual launcher loads compiled extensions without importing a second SDK", t => {
  const root = fileURLToPath(new URL("../", import.meta.url)), base = join(root, ".local/startup-tests");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "binding-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = bundledRuntime(), guard = join(directory, "guard.mjs"), duplicate = join(directory, "duplicate-sdk");
  writeFileSync(guard, `import { registerHooks } from "node:module";
    import { writeFileSync } from "node:fs";
    registerHooks({ load(url, context, nextLoad) {
      if (url === ${JSON.stringify(pathToFileURL(runtime.entry).href)}) writeFileSync(${JSON.stringify(duplicate)}, "loaded");
      return nextLoad(url, context);
    } });`);
  const result = captureCommand(process.execPath, ["--import", pathToFileURL(guard).href, join(root, "bin/pi.mjs"),
    "--help", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"], {
    cwd: directory, encoding: "utf8", timeout: 30000,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "profile"), PI_EXTENDED_RUNTIME_DIR: join(directory, "runtime"),
      PI_PACKAGE_DIR: runtime.packageDir, PI_OFFLINE: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage|Options|coding agent/i);
  assert.doesNotMatch(result.stderr, /Failed to load extension/);
  assert.equal(existsSync(duplicate), false, "Launcher bypassed the selected bundle binding");
});

test("startup reports missing provider auth without reading or refreshing credentials", () => {
  let configured = false;
  const ctx = { model: { provider: "openai-codex" } as { provider: string; id?: string; name?: string; api?: string; contextWindow?: number } | undefined, modelRegistry: {
    getProviderAuthStatus: () => ({ configured }),
    getProviderDisplayName: (id: string) => id,
    getApiKeyAndHeaders() { assert.fail("startup must not resolve credentials"); },
  } };
  assert.match(startupAuthNotice((ctx as unknown as Parameters<typeof startupAuthNotice>[0]))!, /\/login openai-codex.*ChatGPT/);
  configured = true;
  assert.equal(startupAuthNotice((ctx as unknown as Parameters<typeof startupAuthNotice>[0])), undefined);
  configured = false;
  ctx.model!.provider = "anthropic";
  assert.match(startupAuthNotice((ctx as unknown as Parameters<typeof startupAuthNotice>[0]))!, /\/login anthropic.*Claude/);
  // An unauthenticated session has no model, or Pi's placeholder one. Both read
  // the same way, and neither exposes the placeholder's "unknown" fields.
  for (const model of [undefined, { id: "unknown", name: "unknown", api: "unknown", provider: "unknown", contextWindow: 0 }]) {
    ctx.model = model;
    assert.match(startupAuthNotice((ctx as unknown as Parameters<typeof startupAuthNotice>[0]))!, /No models available.*\/login/);
    assert.equal(hasModel(model), false);
  }
  assert.equal(hasModel({ provider: "anthropic", api: "anthropic-messages" }), true);
  // A stub without provider metadata still counts as a selected model.
  assert.equal(hasModel({ id: "gpt-6.1-sol" } as Parameters<typeof hasModel>[0]), true);
});

test("an unauthenticated start shows one plain notice, without effort, context, or a duplicate warning", async () => {
  const { createHeader, createFooter } = await import(new URL("../dist/ui/chrome.js", import.meta.url).href) as typeof import("../ui/chrome.js");
  const { createEscapeExitEditor } = await import(new URL("../dist/ui/escape-exit.js", import.meta.url).href) as typeof import("../ui/escape-exit.js");
  const { createUiTheme } = await import(new URL("../dist/ui/theme.js", import.meta.url).href) as typeof import("../ui/theme.js");
  const measure = await import(pathToFileURL(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))
    .resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
  const placeholder = { id: "unknown", name: "unknown", api: "unknown", provider: "unknown", contextWindow: 0 };
  const ctx = { model: placeholder, modelRegistry: { getProviderAuthStatus: () => ({ configured: false }), getProviderDisplayName: (id: string) => id } };
  // The header reports the state once, and never as "unknown with off effort".
  const header = createHeader({ mode: "regular" }, measure, { version: "1.4.0", getModel: () => placeholder,
    getThinkingLevel: () => "off", getCwd: () => ".", getAuthNotice: () => startupAuthNotice((ctx as unknown as Parameters<typeof startupAuthNotice>[0])) });
  const rendered = measure.stripTerminalSequences(header.render(80).join("\n"));
  header.dispose();
  assert.match(rendered, /No model selected/);
  assert.doesNotMatch(rendered, /unknown/);
  assert.doesNotMatch(rendered, /off effort/);
  assert.equal(rendered.match(/No models available/g)!.length, 1);
  // The footer drops the context readout when there is no window to report.
  const footer = createFooter({}, {}, createUiTheme(), {}, measure, () => undefined, () => "full");
  assert.doesNotMatch(measure.stripTerminalSequences(footer.render(80).join("\n")), /context/);
  assert.match(measure.stripTerminalSequences(footer.render(80).join("\n")), /auto mode/);
  // The input corner keeps no row for an effort level that does not exist.
  class Base {
    focused = false;
    setPaddingX() {}
    render(width: number) { return ["─".repeat(width), "> ", "─".repeat(width)]; }
    handleInput() {}
    renderTopBorder() { return ""; }
    setWorkingStatusIndicator() {}
  }
  const idle = { isIdle: () => true, hasPendingMessages: () => false };
  const Editor = createEscapeExitEditor(Base as unknown as Parameters<typeof createEscapeExitEditor>[0], measure.matchesKey, idle, { getLevel: () => "", step() {} }, () => {});
  const editor = new Editor(tuiFixture({ requestRender() {} }), {} as import("@earendil-works/pi-tui").EditorTheme, {} as import("@earendil-works/pi-coding-agent").KeybindingsManager);
  (editor as unknown as { tui: object }).tui = { requestRender() {} };
  assert.equal(editor.render(80).length, 3, "no blank row above the input without an effort level");
  const WithEffort = createEscapeExitEditor(Base as unknown as Parameters<typeof createEscapeExitEditor>[0], measure.matchesKey, idle, { getLevel: () => "medium", step() {} }, () => {});
  const withEffort = new WithEffort(tuiFixture({ requestRender() {} }), {} as import("@earendil-works/pi-tui").EditorTheme, {} as import("@earendil-works/pi-coding-agent").KeybindingsManager);
  (withEffort as unknown as { tui: object }).tui = { requestRender() {} };
  assert.equal(withEffort.render(80).length, 4);
  assert.match(measure.stripTerminalSequences(withEffort.render(80)[0]), /medium/);
});

test("built extensions and interface load against the bundled Pi engine", async () => {
  await verifyRuntime(bundledRuntime(), fileURLToPath(new URL("../", import.meta.url)));
});
