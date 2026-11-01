import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureCommand } from "../scripts/capture-command.mjs";

// A fresh process is essential: other tests deliberately import these views.
// Observe the actual CLI-bundle loader, not a hand-built Jiti configuration.
async function probe(root, directory, failApproval, bound = true) {
  const loadedModules = new Set(), prefix = pathToFileURL(join(root, "dist") + "/").href;
  const nativeLoads = new Set();
  let binding;
  const hooks = registerHooks({ load(url, context, nextLoad) {
    nativeLoads.add(url);
    if (url.startsWith(prefix)) {
      const name = url.slice(prefix.length);
      if (failApproval && name === "ui/permissions-screen.js") throw new Error("Fixture: approval module unavailable");
      loadedModules.add(name);
    }
    return nextLoad(url, context);
  } });
  globalThis.fetch = () => assert.fail("Command loading must not make network requests");
  try {
    const { bundledRuntime } = await import(pathToFileURL(join(root, "dist/bin/runtime.js")));
    const runtime = bundledRuntime();
    process.env.PI_PACKAGE_DIR = runtime.packageDir;
    const api = await import(pathToFileURL(join(runtime.packageDir, "dist/bundle/index.js")));
    if (bound) {
      const { bindCompiledExtensionImports } = await import(pathToFileURL(join(root, "dist/bin/extension-runtime.js")));
      binding = bindCompiledExtensionImports(runtime, root);
    }
    api.initTheme("dark", false);
    const loader = new api.DefaultResourceLoader({ cwd: directory, agentDir: process.env.PI_CODING_AGENT_DIR,
      settingsManager: api.SettingsManager.inMemory(), noExtensions: true, noSkills: true, noThemes: true,
      noPromptTemplates: true, noContextFiles: true, additionalExtensionPaths: [root] });
    const selectors = ["appearance", "config", "effort", "permissions", "skills", "workspace"].map(name => `ui/${name}-screen.js`);
    const deferred = [...selectors, "ui/command-views.js", "ui/context-view.js", "ui/status-view.js",
      "lib/activity.js", "lib/config.js", "lib/skills.js", "lib/status.js", "lib/usage.js", "bin/update.js", "bin/verify-runtime.js"];
    let views = 0;
    for (let round = 0; round < (failApproval ? 1 : 2); round++) {
      await loader.reload();
      const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pi.extensions.length);
      const commands = new Map(loaded.extensions.flatMap(extension => [...extension.commands]));
      for (const name of ["usage", "stats", "status", "context", "config", "skills", "effort", "permissions", "memory", "plan", "prompt", "theme", "color"]) {
        assert.ok(commands.has(name), `Missing /${name} before opening any screen`);
      }
      assert.equal(commands.has("perf"), false);
      assert.equal(nativeLoads.has(pathToFileURL(runtime.entry).href), !bound, "Compiled imports must use the selected host, not a duplicate SDK");
      const workspace = loaded.extensions.find(extension => extension.tools.has("project_memory"));
      assert.equal(workspace.sourceInfo.path, join(root, "dist/extensions/workspace.js"), "Tool provenance must stay unchanged");
      if (!round) for (const name of deferred) assert.equal(loadedModules.has(name), false, `Eager module: ${name}`);
      const manager = api.SessionManager.inMemory(directory), notices = [];
      const tools = [{ name: "read", description: "Read", parameters: {}, sourceInfo: { source: "builtin", path: "builtin:read" } }];
      let level = "medium";
      Object.assign(loaded.runtime, { getThinkingLevel: () => level, setThinkingLevel: value => { level = value; },
        getActiveTools: () => ["read"], getAllTools: () => tools,
        appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) });
      let expected;
      const ctx = { mode: "print", hasUI: true, cwd: directory, model: undefined, sessionManager: manager,
        isProjectTrusted: () => false, isIdle: () => true, hasPendingMessages: () => false,
        getSystemPromptOptions: () => ({ cwd: directory, skills: [], contextFiles: [], sections: {} }),
        getSystemPrompt: () => "Fixture prompt", getContextUsage: () => undefined,
        ui: { theme: { name: "dark" }, notify: (message, type) => notices.push({ message, type }),
          async custom(create) {
            assert.equal(failApproval, false, "An unavailable approval view must not grant access");
            let closed = false;
            const tui = { mode: "fullscreen", children: [], terminal: { rows: 30, columns: 100 }, requestRender() {} };
            const panel = create(tui, {}, {}, () => { closed = true; });
            try {
              await panel.ready;
              assert.match(panel.render(100).join("\n"), expected);
              views++; panel.handleInput("\x1b"); assert.equal(closed, true);
              return false;
            } finally { panel.dispose(); }
          },
        },
      };
      if (failApproval) {
        ctx.mode = "tui";
        await commands.get("permissions").handler("ask", ctx);
        const extension = loaded.extensions.find(extension => extension.commands.has("permissions"));
        const call = name => extension.handlers.get("tool_call")[0]({ toolName: name, input: { path: "sample.txt" } }, ctx);
        assert.equal((await call("write")).block, true);
        assert.equal(await call("read"), undefined);
        assert.equal(views, 0);
        continue;
      }
      for (const name of ["stats", "status", "context", "config", "skills", "permissions"]) {
        await commands.get(name).handler("", ctx);
        assert.notEqual(notices.at(-1)?.type, "error", `${name}: ${notices.at(-1)?.message}`);
      }
      if (!round) for (const name of selectors) assert.equal(loadedModules.has(name), false, `Headless command loaded ${name}`);
      ctx.mode = "tui";
      for (const [name, title, args = ""] of [["skills", /Skills/], ["stats", /Statistics/], ["usage", /Usage/], ["status", /Status/],
        ["context", /Context/], ["config", /Configuration/], ["permissions", /Permissions/], ["theme", /Theme/],
        ["color", /Color/], ["memory", /Memory/], ["plan", /Plan/], ["prompt", /System prompt/],
        ["prompt", /Prompt/, "session"], ["effort", /Effort/]]) {
        expected = title;
        ctx.model = name === "effort" ? { id: "fixture", reasoning: true, thinkingLevelMap: { high: "high", max: null } } : undefined;
        const before = views;
        await commands.get(name).handler(args, ctx);
        assert.equal(views, before + 1, `/${name} did not open after ${round ? "reload" : "cold load"}: ${notices.at(-1)?.message}`);
      }
      assert.equal(level, "medium", "Cancelling selectors must not change reasoning effort");
      for (const name of selectors) assert.ok(loadedModules.has(name), `Unexercised module: ${name}`);
    }
    if (bound && !failApproval) {
      const loaded = loader.getExtensions();
      const escape = loaded.extensions.find(extension => extension.path.endsWith("escape-exit.js"));
      const { KeybindingsManager } = await import(new URL("./core/keybindings.js", pathToFileURL(runtime.entry)));
      let editor;
      try {
        escape.handlers.get("session_start")[0]({}, { mode: "tui", isIdle: () => true, hasPendingMessages: () => false,
          ui: { setEditorComponent(create) {
            editor = create({ children: [], terminal: { rows: 24, columns: 80 }, requestRender() {} },
              { borderColor: text => text, selectList: {} }, new KeybindingsManager());
          } } });
        assert.ok(editor instanceof api.CustomEditor, "The editor must inherit from the selected CLI's actual class");
        editor.focused = true; editor.setText("Keep this draft");
        for (const [level, rgb] of [["high", "177;185;249"], ["xhigh", "175;135;255"]]) {
          loaded.runtime.setThinkingLevel(level);
          assert.ok(editor.render(80)[0].includes(`\x1b[38;2;${rgb}m${level}\x1b[39m`));
          assert.equal(editor.getText(), "Keep this draft");
        }
      } finally { escape.handlers.get("session_shutdown")[0](); loaded.runtime.setThinkingLevel("medium"); }
      const modelRuntime = await api.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
        credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
      const { session } = await api.createAgentSession({ cwd: directory, agentDir: process.env.PI_CODING_AGENT_DIR,
        settingsManager: api.SettingsManager.inMemory(), modelRuntime, resourceLoader: loader,
        sessionManager: api.SessionManager.inMemory(directory) });
      try {
        await session.bindExtensions({ mode: "print" });
        session.agent.state.messages.push({ role: "assistant", content: [{ type: "toolCall", id: "binding-test", name: "codemode", arguments: {} }],
          api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } });
        const context = session._extensionRunner.createToolContext("binding-test");
        const call = (name, args) => context.executeTool(name, args);
        assert.equal((await call("write", { path: "binding.txt", content: "original" })).isError, false);
        await session.prompt("/plan start");
        assert.equal((await call("write", { path: "binding.txt", content: "blocked" })).isError, true);
        assert.equal((await call("read", { path: "binding.txt" })).isError, false);
        const planResult = await call("update_plan", { goal: "Fixture plan", steps: [{ text: "Read", status: "pending" }] });
        assert.equal(planResult.isError, false, `The registered workspace tool must retain its trusted provenance: ${JSON.stringify(planResult)}`);
        await session.prompt("/plan cancel");
        await session.prompt("/permissions ask");
        assert.equal((await call("write", { path: "binding.txt", content: "blocked" })).isError, true);
        await session.prompt("/permissions read-only");
        assert.equal((await call("read", { path: "binding.txt" })).isError, false);
        assert.equal((await call("write", { path: "binding.txt", content: "blocked" })).isError, true);
        assert.equal(readFileSync(join(directory, "binding.txt"), "utf8"), "original");
      } finally { session.dispose(); }
    }
    console.log(JSON.stringify({ views, failApproval, bound }));
  } finally { binding?.deregister(); hooks.deregister(); }
}

if (process.argv[2] === "--probe") {
  await probe(process.argv[3], process.argv[4], process.argv[5] === "fail", process.argv[5] !== "unbound");
} else {
  for (const mode of ["bound", "unbound", "fail"]) test(mode === "fail" ? "missing lazy approval modules fail closed" : `${mode} commands defer services and views, open cold, and work after reload`, t => {
    const failure = mode === "fail";
    const root = fileURLToPath(new URL("../", import.meta.url)), base = join(root, ".local/command-loading-tests");
    mkdirSync(base, { recursive: true });
    const directory = mkdtempSync(join(base, "case-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const result = captureCommand(process.execPath, [fileURLToPath(import.meta.url), "--probe", root, directory, mode], {
      cwd: directory, encoding: "utf8", timeout: 30000,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "profile"), PI_EXTENDED_RUNTIME_DIR: join(directory, "runtimes"), PI_OFFLINE: "1" },
    });
    assert.equal(result.status, 0, result.stderr.slice(-4000));
    assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), { views: failure ? 0 : 28, failApproval: failure, bound: mode !== "unbound" });
  });
}
