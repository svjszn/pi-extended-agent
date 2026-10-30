import assert from "node:assert/strict";
import test from "node:test";
import { bundledRuntime } from "../dist/bin/runtime.js";
import { verifyRuntime } from "../dist/bin/verify-runtime.js";
import { fileURLToPath } from "node:url";
import { startupAuthNotice } from "../dist/lib/startup.js";
import { captureCommand } from "../scripts/capture-command.mjs";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
    export class InteractiveMode { createBaseAutocompleteProvider() {} setupEditorSubmitHandler() {} showSettingsSelector() {} createExtensionUIContext() {} showModelSelector() {} disposeActiveSelector() {} }
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
