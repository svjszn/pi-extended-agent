import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Context, ToolCall } from "@earendil-works/pi-ai";
import { assistantFixture, present } from "./helpers.ts";

const { CODE_MODE_ENTRY, readCodeMode, codeModeBuiltin } = await import(new URL("../dist/lib/code-mode.js", import.meta.url).href) as typeof import("../lib/code-mode.js");
const { PLAN_ENTRY, PLAN_TOGGLE } = await import(new URL("../dist/lib/plan.js", import.meta.url).href) as typeof import("../lib/plan.js");
const { readPermissionMode } = await import(new URL("../dist/lib/permissions.js", import.meta.url).href) as typeof import("../lib/permissions.js");
const { createFooter } = await import(new URL("../dist/ui/chrome.js", import.meta.url).href) as typeof import("../ui/chrome.js");
const { createUiTheme } = await import(new URL("../dist/ui/theme.js", import.meta.url).href) as typeof import("../ui/theme.js");
const { getAppearance, setAppearance } = await import(new URL("../dist/lib/appearance.js", import.meta.url).href) as typeof import("../lib/appearance.js");
import { createRequire, findPackageJSON } from "node:module";
const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");

async function fixture(t: TestContext, excludeTools?: string[], initiallyActive = false, builtinEnabled = true) {
  const base = resolve(".local/code-mode-tests"); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "case-")), agentDir = join(cwd, "profile");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const sessions: AgentSession[] = [];
  t.after(() => {
    for (const session of sessions) session.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(resolve(cwd).startsWith(base + sep)); rmSync(cwd, { recursive: true, force: true });
  });
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} },
  });
  const aiManifest = present(findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(dirname(aiManifest), "dist/compat.js")).href) as typeof import("@earendil-works/pi-ai");
  let pending: { name: string; args: ToolCall["arguments"] } | undefined;
  let beforeReply: (() => Promise<void>) | undefined;
  const requests: Context[] = [];
  runtime.registerProvider("code-fixture", { api: "code-fixture-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      requests.push(context);
      const next = pending; pending = undefined;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const before = beforeReply; beforeReply = undefined; await before?.();
        const message = assistantFixture(next ? [{ type: "toolCall", id: `fixture-${requests.length}`, name: next.name, arguments: next.args }] : [{ type: "text", text: "Fixture complete" }],
          { api: model.api, provider: model.provider, model: model.id, stopReason: next ? "toolUse" : "stop" });
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: next ? "toolUse" : "stop", message }); stream.end();
      });
      return stream;
    },
  });
  t.after(() => runtime.unregisterProvider("code-fixture"));
  // The wrapper's code mode must keep direct declarations even if preferences
  // request the engine's only variant.
  const settings = SettingsManager.inMemory({ codemode: { mode: "only" },
    extensions: builtinEnabled ? [] : ["-builtin:codemode"],
    ...(initiallyActive ? { defaultTools: ["+codemode"] } : {}),
  });
  let current!: AgentSession;
  let toggle!: () => void;
  const create = async (manager = SessionManager.inMemory(cwd)) => {
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
      noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../dist/extensions/workspace.js", import.meta.url)), fileURLToPath(new URL("../dist/extensions/permissions.js", import.meta.url))],
      extensionFactories: [codeModeBuiltin(createCodemodeExtension), (pi) => {
        toggle = () => pi.events.emit(PLAN_TOGGLE, undefined);
        pi.registerTool({ name: "revoke_access", label: "Revoke access", description: "Fixture only", parameters: { type: "object", properties: {} },
          async execute() { await current.prompt("/permissions read-only"); return { content: [{ type: "text", text: "Permissions changed" }], details: {} }; },
        });
      }],
    });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    assert.deepEqual(loader.getExtensions().warnings ?? [], []);
    assert.deepEqual(loader.getExtensions().extensions.filter((extension) => extension.tools.has("codemode"))
      .map((extension) => extension.path), builtinEnabled ? ["builtin:codemode"] : []);
    const { session } = await createAgentSession({ cwd, agentDir, settingsManager: settings, modelRuntime: runtime,
      resourceLoader: loader, sessionManager: manager, excludeTools, model: runtime.getModel("code-fixture", "fixture"),
    });
    current = session; sessions.push(session); await session.bindExtensions({ mode: "print" });
    return session;
  };
  const session = await create();
  const mode = () => readCodeMode(session.sessionManager.getEntries());
  const plan = () => session.sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === PLAN_ENTRY);
  const runTool = async (name: string, args: ToolCall["arguments"]) => {
    let outcome: { result: AgentToolResult<unknown>; isError: boolean } | undefined;
    const stop = session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === name) outcome = { result: event.result, isError: event.isError };
    });
    pending = { name, args };
    try { await session.prompt("Run the local fixture tool."); await session.waitForIdle(); return present(outcome); }
    finally { stop(); }
  };
  return { cwd, agentDir, session, settings, create, mode, plan, runTool, requests,
    beforeReply: (callback: () => Promise<void>) => { beforeReply = callback; },
    runCode: (code: string) => runTool("codemode", { code }), toggle: () => toggle() };
}

test("code mode enables the engine's on variant, retains direct tools, and runs sandboxed tool batches", async (t) => {
  const f = await fixture(t), before = f.session.getActiveToolNames();
  assert.equal(before.includes("codemode"), false);
  await f.session.prompt("/mode code");
  assert.equal(f.mode().enabled, true);
  for (const name of before) assert.ok(f.session.getActiveToolNames().includes(name));
  assert.ok(f.session.systemPrompt.includes("read"), "on mode preserves native direct-tool instructions");
  assert.equal(readPermissionMode(f.session.sessionManager.getEntries()), "full");
  writeFileSync(join(f.cwd, "a.txt"), "alpha"); writeFileSync(join(f.cwd, "b.txt"), "beta");
  const result = await f.runCode('const results = await Promise.allSettled([tools.read({path:"a.txt"}), tools.read({path:"b.txt"})]); text(results.map(r => r.status === "fulfilled" ? r.value : "failed"));');
  assert.equal(result.isError, false, JSON.stringify(result));
  const declarations = f.requests[0].messages.filter((message) => message.role === "system").flatMap((message) => message.toolsAdded ?? []).map((tool) => tool.name);
  assert.ok(declarations.includes("read") && declarations.includes("codemode"), "the selected on mode must declare both ordinary tools and codemode");
  assert.match(JSON.stringify(result.result.content), /alpha/); assert.match(JSON.stringify(result.result.content), /beta/);
  const noNode = await f.runCode('text(typeof process); text(typeof require);');
  assert.equal(noNode.isError, false); assert.doesNotMatch(JSON.stringify(noNode.result.content), /function/);
  await f.session.prompt("/mode auto");
  assert.equal(f.mode().enabled, false); assert.deepEqual(f.session.getActiveToolNames(), before);
});

test("disabling the built-in prevents workspace from registering a replacement codemode", async (t) => {
  const f = await fixture(t, undefined, false, false);
  assert.equal(f.session.getAllTools().some((tool) => tool.name === "codemode"), false);
  const before = f.session.getActiveToolNames();
  await f.session.prompt("/mode code");
  assert.equal(f.mode().enabled, false);
  assert.deepEqual(f.session.getActiveToolNames(), before);
  f.toggle(); f.toggle();
  assert.equal(f.mode().enabled, false, "the mode shortcut skips unavailable codemode");
});

test("Shift+Tab cycles auto, plan, code, auto while preserving the draft and requiring explicit execution", async (t) => {
  const f = await fixture(t);
  const toggle = f.toggle;
  toggle();
  const proposal = await f.runTool("update_plan", {
    goal: "Preserve this draft", steps: [{ text: "Inspect files", status: "pending" }],
  });
  assert.equal(proposal.isError, false, JSON.stringify(proposal));
  const messages = f.session.messages.length;
  assert.equal(f.mode().enabled, false);
  toggle(); assert.equal(f.mode().enabled, true);
  const plan = present(f.plan()); assert.equal(plan.type, "custom");
  if (plan.type === "custom") assert.equal((plan.data as { status: string }).status, "paused");
  toggle(); assert.equal(f.mode().enabled, false);
  toggle(); assert.equal(f.mode().enabled, false);
  const restored = present(f.plan()); if (restored.type === "custom") {
    assert.equal((restored.data as { status: string }).status, "ready");
    assert.equal((restored.data as { goal: string }).goal, "Preserve this draft");
  }
  assert.equal(f.session.messages.length, messages, "switching modes must not submit a model prompt");
});

test("nested codemode calls still obey a permission change during the script", async (t) => {
  const f = await fixture(t); await f.session.prompt("/mode code");
  writeFileSync(join(f.cwd, "safe.txt"), "original");
  const result = await f.runCode('await tools.revoke_access({}); await tools.write({path:"safe.txt", content:"forbidden"});');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(readFileSync(join(f.cwd, "safe.txt"), "utf8"), "original");
  assert.match(JSON.stringify(result.result.content), /Permissions|blocked/);
  assert.equal(readPermissionMode(f.session.sessionManager.getEntries()), "read-only");
  const blocked = await f.runCode('await tools.write({path:"other.txt",content:"blocked"});');
  assert.equal(blocked.isError, true); assert.equal(existsSync(join(f.cwd, "other.txt")), false);
});

test("entering planning from code mode suspends codemode and retains the plan barrier", async (t) => {
  const f = await fixture(t), before = f.session.getActiveToolNames();
  await f.session.prompt("/mode code"); await f.session.prompt("/plan start");
  assert.equal(f.mode().enabled, false); assert.equal(f.session.getActiveToolNames().includes("codemode"), false);
  const result = await f.runCode('await tools.write({path:"blocked.txt",content:"blocked"});');
  assert.equal(result.isError, true); assert.equal(existsSync(join(f.cwd, "blocked.txt")), false);
  await f.session.prompt("/plan cancel");
  assert.deepEqual(f.session.getActiveToolNames(), before, "leaving the plan must not restore codemode owned by the previous mode");
});

test("code mode survives reload and resume, starts off for a new session, and respects excluded tools", async (t) => {
  const f = await fixture(t); await f.session.prompt("/mode code");
  await f.session.reload(); assert.equal(f.mode().enabled, true); assert.ok(f.session.getActiveToolNames().includes("codemode"));
  const resumed = await f.create(f.session.sessionManager);
  assert.equal(readCodeMode(resumed.sessionManager.getEntries()).enabled, true);
  await resumed.prompt("/mode auto"); assert.equal(resumed.getActiveToolNames().includes("codemode"), false);
  const fresh = await f.create(); assert.equal(readCodeMode(fresh.sessionManager.getEntries()).enabled, false);
  assert.equal(fresh.getActiveToolNames().includes("codemode"), false);
  await t.test("excluded codemode", async (t) => {
    const f = await fixture(t, ["codemode"]), before = f.session.getActiveToolNames();
    await f.session.prompt("/mode code"); assert.equal(f.mode().enabled, false); assert.deepEqual(f.session.getActiveToolNames(), before);
  });
});

test("leaving code mode preserves codemode that was enabled in the user's original loadout", async (t) => {
  const f = await fixture(t, undefined, true);
  assert.ok(f.session.getActiveToolNames().includes("codemode"));
  await f.session.prompt("/mode code"); assert.equal(f.mode().added, false);
  await f.session.prompt("/mode auto"); assert.ok(f.session.getActiveToolNames().includes("codemode"));
  const result = await f.runCode('text("User preference restored");'); assert.equal(result.isError, false);
  const declarations = f.requests[0].messages.filter((message) => message.role === "system").flatMap((message) => message.toolsAdded ?? []).map((tool) => tool.name);
  assert.ok(declarations.includes("codemode")); assert.equal(declarations.includes("read"), false, "auto mode must restore the user's native only preference");
});

test("mode changes during a run leave code mode and the tool selection unchanged", async (t) => {
  const f = await fixture(t); await f.session.prompt("/mode code");
  const before = f.session.getActiveToolNames();
  f.beforeReply(async () => {
    await f.session.prompt("/mode auto"); await f.session.prompt("/mode plan");
    assert.equal(f.mode().enabled, true); assert.deepEqual(f.session.getActiveToolNames(), before);
  });
  const result = await f.runCode('text("Still in code mode");');
  assert.equal(result.isError, false); assert.equal(f.plan(), undefined);
});

test("failed mode persistence rolls back the native loadout and mode metadata", async (t) => {
  const f = await fixture(t), before = f.session.getActiveToolNames();
  const append = f.session.sessionManager.appendCustomEntry.bind(f.session.sessionManager);
  t.mock.method(f.session.sessionManager, "appendCustomEntry", <T>(type: string, data: T) => {
    if (type === CODE_MODE_ENTRY) throw new Error("Fixture session write failed");
    return append(type, data);
  });
  await f.session.prompt("/mode code");
  assert.equal(f.mode().enabled, false); assert.deepEqual(f.session.getActiveToolNames(), before);
});

test("the code mode footer uses the exact high-effort blue and remains bounded", (t) => {
  const previous = getAppearance(); t.after(() => setAppearance(previous));
  for (const mode of ["dark", "light"] as const) {
    setAppearance({ mode, color: "green" });
    const footer = createFooter({}, {}, createUiTheme(), {}, measure, undefined, () => "full", () => false, () => true);
    assert.equal(measure.stripTerminalSequences(footer.render(80)[0]), "  code mode");
    assert.match(footer.render(80)[0], /38;2;177;185;249mcode mode/);
    for (const width of [1, 8, 24, 80]) assert.ok(footer.render(width).every((line) => measure.visibleWidth(line) <= width));
  }
  assert.deepEqual(readCodeMode([{ type: "custom", customType: CODE_MODE_ENTRY, data: { enabled: "yes", added: 1 } }]), { enabled: false, added: false });
});
