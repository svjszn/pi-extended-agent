import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, createCodemodeExtension,
  ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { modelFixture, present } from "./helpers.ts";

const { codeModeBuiltin, readCodeMode } = await import(new URL("../dist/lib/code-mode.js", import.meta.url).href) as typeof import("../lib/code-mode.js");
const { PLAN_ENTRY, PlanStore, isPlanning } = await import(new URL("../dist/lib/plan.js", import.meta.url).href) as typeof import("../lib/plan.js");
const { projectFiles } = await import(new URL("../dist/lib/project-state.js", import.meta.url).href) as typeof import("../lib/project-state.js");
const { redirectedCommand } = await import(new URL("../dist/lib/command-policy.js", import.meta.url).href) as typeof import("../lib/command-policy.js");
const { SESSION_PREFERENCES_ENTRY } = await import(new URL("../dist/lib/session-preferences.js", import.meta.url).href) as typeof import("../lib/session-preferences.js");

async function fixture(t: TestContext, persisted = false) {
  const base = resolve(".local/session-settings-tests"); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "case-")), agentDir = join(cwd, "profile");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const settings = SettingsManager.inMemory({ defaultProvider: "session-fixture", defaultModel: "default", defaultThinkingLevel: "low" });
  const models = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
  models.registerProvider("session-fixture", { api: "session-fixture-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
    models: ["default", "selected"].map((id) => ({ ...modelFixture({ id, name: id, reasoning: true }), api: "session-fixture-api" })),
    streamSimple() { assert.fail("Session replacement must never call a model"); },
  });
  let cancelNext = false;
  const errors: string[] = [];
  const create: Parameters<typeof createAgentSessionRuntime>[0] = async (options) => {
    const services = await createAgentSessionServices({ ...options, settingsManager: settings, modelRuntime: models,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: ["builtin:codemode", ...["session", "workspace", "permissions"].map((name) => fileURLToPath(new URL(`../dist/extensions/${name}.js`, import.meta.url)))],
        extensionFactories: [codeModeBuiltin(createCodemodeExtension), (pi) => {
          pi.on("session_before_switch", () => { if (cancelNext) { cancelNext = false; return { cancel: true }; } });
        }],
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const result = await createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const manager = persisted ? SessionManager.create(cwd, join(cwd, "sessions")) : SessionManager.inMemory(cwd);
  const runtime = await createAgentSessionRuntime(create, { cwd, agentDir, sessionManager: manager });
  const bind = async (session: AgentSession) => session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error),
    commandContextActions: {
      waitForIdle: () => runtime.session.waitForIdle(), newSession: (options) => runtime.newSession(options),
      fork: (id, options) => runtime.fork(id, options), switchSession: (path, options) => runtime.switchSession(path, options),
      navigateTree: async () => ({ cancelled: true }), reload: () => runtime.session.reload(),
    },
  });
  runtime.setRebindSession(bind); await bind(runtime.session);
  t.after(async () => {
    await runtime.dispose();
    models.unregisterProvider("session-fixture");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(resolve(cwd).startsWith(base + sep)); rmSync(cwd, { recursive: true, force: true });
  });
  const clear = (command: "/new" | "/clear") => runtime.session.prompt(redirectedCommand(command) ?? command);
  const planStore = () => new PlanStore(projectFiles(cwd, agentDir), runtime.session.sessionId);
  const plan = () => planStore().read();
  return { runtime, models, settings, clear, plan, planStore, errors, cancel: () => { cancelNext = true; } };
}

test("/new and /clear retain model, effort and every work mode across fresh runtime factories", async (t) => {
  for (const persisted of [false, true]) await t.test(persisted ? "disk session" : "in-memory session", async (t) => {
    const f = await fixture(t, persisted);
    for (const mode of ["auto", "code", "plan"] as const) {
      await f.runtime.session.setModel(present(f.models.getModel("session-fixture", "selected")));
      f.runtime.session.setThinkingLevel("high");
      await f.runtime.session.prompt(`/mode ${mode}`);
      for (const command of ["/new", "/clear"] as const) {
        const old = f.runtime.session, oldId = old.sessionId;
        old.sessionManager.appendMessage({ role: "user", content: "Old conversation", timestamp: Date.now() }); old.refreshContext();
        await f.clear(command);
        const fresh = f.runtime.session;
        assert.notEqual(fresh.sessionId, oldId);
        assert.equal(fresh.model?.id, "selected"); assert.equal(fresh.thinkingLevel, "high");
        assert.equal(readCodeMode(fresh.sessionManager.getEntries()).enabled, mode === "code");
        assert.equal(isPlanning(f.plan()), mode === "plan");
        assert.equal(fresh.messages.length, 0, "conversation content must be cleared");
        assert.throws(() => old.extensionRunner.createCommandContext().cwd, /stale|active|replaced/i);
      }
    }
    assert.equal(f.settings.getDefaultModel(), "default"); assert.equal(f.settings.getDefaultThinkingLevel(), "low");
    assert.deepEqual(f.errors, []);
  });
});

test("new plan mode starts with an empty plan and still blocks writes until explicit execution", async (t) => {
  const f = await fixture(t);
  t.mock.method(f.runtime.session, "sendUserMessage", async () => {});
  await f.runtime.session.prompt("/plan Previous task");
  const oldStore = f.planStore(), oldPlan = present(f.plan()); assert.equal(oldPlan.goal, "Previous task");
  await f.clear("/clear");
  const freshPlan = present(f.plan()); assert.equal(freshPlan.status, "planning");
  assert.equal(freshPlan.goal, ""); assert.deepEqual(freshPlan.steps, []);
  assert.deepEqual(oldStore.read(), oldPlan, "the previous plan stays with its original session");
  const outcome = await f.runtime.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "blocked", input: { path: "file.txt", content: "blocked" } });
  assert.equal(outcome?.block, true); assert.match(outcome?.reason ?? "", /Plan mode/);
  await f.runtime.session.prompt("/mode auto"); await f.clear("/new");
  assert.equal(isPlanning(f.plan()), false, "initial inheritance must not reactivate a mode the user left");
});

test("cancelled and failed replacements do not leak preferences into a later unrelated new session", async (t) => {
  const f = await fixture(t);
  await f.runtime.session.setModel(present(f.models.getModel("session-fixture", "selected")));
  f.runtime.session.setThinkingLevel("high"); await f.runtime.session.prompt("/mode code");
  const oldId = f.runtime.session.sessionId;
  f.cancel(); await f.clear("/clear");
  assert.equal(f.runtime.session.sessionId, oldId); assert.equal(f.runtime.session.thinkingLevel, "high");
  await f.runtime.newSession();
  assert.equal(f.runtime.session.model?.id, "default"); assert.equal(f.runtime.session.thinkingLevel, "low");
  assert.equal(f.runtime.session.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_PREFERENCES_ENTRY), false);
  await f.runtime.session.setModel(present(f.models.getModel("session-fixture", "selected")));
  f.runtime.session.setThinkingLevel("high"); await f.runtime.session.prompt("/mode code");
  const failure = t.mock.method(f.runtime, "newSession", async () => { throw new Error("Fixture replacement failed"); });
  await f.clear("/clear"); failure.mock.restore();
  await f.runtime.newSession();
  assert.equal(f.runtime.session.model?.id, "default"); assert.equal(f.runtime.session.thinkingLevel, "low");
  assert.equal(readCodeMode(f.runtime.session.sessionManager.getEntries()).enabled, false);
});

test("a missing inherited plan stays blocked on reload instead of recreating an empty draft", async (t) => {
  const f = await fixture(t);
  await f.runtime.session.prompt("/mode plan"); await f.clear("/new");
  const store = f.planStore(); rmSync(store.files.path(store.name));
  await f.runtime.session.reload();
  assert.equal(f.plan(), undefined);
  const outcome = await f.runtime.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "missing", input: { path: "file.txt", content: "blocked" } });
  assert.equal(outcome?.block, true); assert.match(outcome?.reason ?? "", /plan.*missing/i);
});
