import assert from "node:assert/strict";
import test from "node:test";
import { bundledRuntime } from "../dist/bin/runtime.js";
import { verifyRuntime } from "../dist/bin/verify-runtime.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startupAuthNotice } from "../dist/lib/startup.js";
import { captureCommand } from "../scripts/capture-command.mjs";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

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
    export class InteractiveMode { createBaseAutocompleteProvider() {} setupEditorSubmitHandler() {} showSettingsSelector() {} createExtensionUIContext() {} showModelSelector() {} disposeActiveSelector() {} showSelector() {} showLoginDialog() {} showApiKeyLoginDialog() {} showAmbientAuthDialog() {} }
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
  const ctx = { model: { provider: "openai-codex" }, modelRegistry: {
    getProviderAuthStatus: () => ({ configured }),
    getProviderDisplayName: (id) => id,
    getApiKeyAndHeaders() { assert.fail("startup must not resolve credentials"); },
  } };
  assert.match(startupAuthNotice(ctx), /\/login openai-codex.*ChatGPT/);
  configured = true;
  assert.equal(startupAuthNotice(ctx), undefined);
  configured = false;
  ctx.model.provider = "anthropic";
  assert.match(startupAuthNotice(ctx), /\/login anthropic.*Claude/);
  ctx.model = undefined;
  assert.match(startupAuthNotice(ctx), /No model selected.*\/login/);
});

test("built extensions and interface load against the bundled Pi engine", async () => {
  await verifyRuntime(bundledRuntime(), fileURLToPath(new URL("../", import.meta.url)));
});
