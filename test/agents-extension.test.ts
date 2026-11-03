import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, SessionShutdownEvent, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import type { SubagentRequest, SubagentResult } from "../lib/subagent.js";
import { assistantFixture, present } from "./helpers.ts";

const { default: agents } = await import(new URL("../dist/extensions/agents.js", import.meta.url).href) as typeof import("../extensions/agents.js");
const { AgentStore } = await import(new URL("../dist/lib/agents.js", import.meta.url).href) as typeof import("../lib/agents.js");
const { PERMISSIONS_CHANGED, PERMISSIONS_ENTRY } = await import(new URL("../dist/lib/permissions.js", import.meta.url).href) as typeof import("../lib/permissions.js");
const { PLAN_CHANGED, PLAN_ENTRY } = await import(new URL("../dist/lib/plan.js", import.meta.url).href) as typeof import("../lib/plan.js");
const { activeSubagentStatus } = await import(new URL("../dist/lib/subagent-status.js", import.meta.url).href) as typeof import("../lib/subagent-status.js");
const { SUBAGENT_REPORT_TYPE, subagentReportMessage } = await import(new URL("../dist/lib/subagent-report.js", import.meta.url).href) as typeof import("../lib/subagent-report.js");
const { default: permissions } = await import(new URL("../dist/extensions/permissions.js", import.meta.url).href) as typeof import("../extensions/permissions.js");
const { default: workspace } = await import(new URL("../dist/extensions/workspace.js", import.meta.url).href) as typeof import("../extensions/workspace.js");
const { readPermissionMode } = await import(new URL("../dist/lib/permissions.js", import.meta.url).href) as typeof import("../lib/permissions.js");

/** Exercise native parent delivery and persistence without a model or user profile. */
async function parentFixture(t: TestContext, beforeReply?: (index: number) => Promise<void>) {
  const base = resolve(".local/agent-handoff-tests"); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "case-")), agentDir = join(cwd, "profile");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(resolve(cwd).startsWith(base + sep)); rmSync(cwd, { recursive: true, force: true });
  });
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
  const aiManifest = present(findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(dirname(aiManifest), "dist/compat.js")).href) as typeof import("@earendil-works/pi-ai");
  const seen: string[] = [], requests: SubagentRequest[] = [];
  runtime.registerProvider("handoff-fixture", { api: "handoff-fixture-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const index = seen.push(JSON.stringify(context.messages)) - 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        await beforeReply?.(index);
        const message = assistantFixture([{ type: "text", text: "**Итоги:** P2 — `src/example.ts:12`. Проверки не запускались." }],
          { api: model.api, provider: model.provider, model: model.id });
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message }); stream.end();
      });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [permissions, workspace, pi => agents(pi, async request => {
      requests.push(request);
      return { report: "P2 — src/example.ts:12: HANDOFF_FINDING. Checks: not run. Open question: caller behavior.",
        toolCalls: 3, blocked: [], aborted: false, model: "fixture" };
    })] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
  sessionManager.appendMessage({ role: "user", content: "Проверь изменения. MAIN_CONTEXT_SENTINEL", timestamp: Date.now() });
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime: runtime,
    model: present(runtime.getModel("handoff-fixture", "fixture")), resourceLoader: loader, sessionManager, tools: [] });
  t.after(() => { session.dispose(); runtime.unregisterProvider("handoff-fixture"); });
  const unused = async (): Promise<never> => { assert.fail("Unexpected session navigation in a report handoff"); };
  await session.bindExtensions({ mode: "print", commandContextActions: {
    waitForIdle: () => session.waitForIdle(), newSession: unused, fork: unused,
    navigateTree: unused, switchSession: unused, reload: unused,
  } });
  return { session, seen, requests };
}

test("manual reports reach the native parent context, produce normal replies, and survive resume with barriers intact", async t => {
  const { session, seen, requests } = await parentFixture(t);
  await session.prompt("/permissions read-only");
  await session.prompt("/plan start");
  await session.prompt("/lens");
  // A one-shot command must wait for the parent's reply before returning.
  assert.equal(seen.length, 1);
  assert.match(seen[0], /MAIN_CONTEXT_SENTINEL/);
  assert.match(seen[0], /HANDOFF_FINDING/);
  assert.match(seen[0], /caller behavior/);
  assert.equal(requests[0].mode, "read-only"); assert.equal(requests[0].planning, true);
  const entries = session.sessionManager.getEntries();
  assert.equal(readPermissionMode(entries), "read-only");
  const plan = entries.filter(entry => entry.type === "custom" && entry.customType === PLAN_ENTRY).at(-1);
  assert.equal((plan as { data?: { status: string } })?.data?.status, "planning");
  const reports = entries.filter(entry => entry.type === "custom_message" && entry.customType === SUBAGENT_REPORT_TYPE);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].type === "custom_message" && reports[0].display, false);
  const answers = session.agent.state.messages.filter(message => message.role === "assistant");
  assert.equal(answers.length, 1); assert.match(JSON.stringify(answers[0]), /Итоги/);
  const resumed = SessionManager.open(present(session.sessionManager.getSessionFile()));
  assert.equal(resumed.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === SUBAGENT_REPORT_TYPE).length, 1);
  assert.match(JSON.stringify(resumed.buildSessionProjection().messages), /HANDOFF_FINDING/);
});

test("a manual report queues a native follow-up while the parent is busy without interrupting its turn", async t => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { session, seen } = await parentFixture(t, async index => { if (!index) { started(); await gate; } });
  const working = session.prompt("Continue the main task. BUSY_PARENT_SENTINEL");
  try {
    await ready;
    await session.prompt("/lens");
    assert.equal(seen.length, 1, "the report must wait for the current response");
    release(); await working; await session.waitForIdle();
    assert.equal(seen.length, 2);
    assert.match(seen[1], /BUSY_PARENT_SENTINEL/); assert.match(seen[1], /HANDOFF_FINDING/);
    assert.equal(session.agent.state.messages.filter(message => message.role === "assistant").length, 2);
    assert.equal(session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === SUBAGENT_REPORT_TYPE).length, 1);
  } finally { release(); await working; }
});

function fixture(t: TestContext, runner: typeof import("../lib/subagent.js").runSubagent, mode: "rpc" | "tui" = "rpc") {
  const base = resolve(".local/agents-extension-tests"); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "case-")), agentDir = join(cwd, "profile");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    await shutdown({ type: "session_shutdown", reason: "quit" });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(resolve(cwd).startsWith(base + sep)); rmSync(cwd, { recursive: true, force: true });
  });
  new AgentStore({ cwd, agentDir, projectTrusted: true }).save("global", {
    name: "researcher", description: "Fixture", prompt: "Report findings.",
  });
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  let task!: Parameters<ExtensionAPI["registerTool"]>[0];
  let shutdown!: (event: SessionShutdownEvent) => Promise<void>;
  let input: TerminalInputHandler | undefined;
  let sessionId = "parent-fixture";
  const handoffs: { message: Parameters<ExtensionAPI["sendMessage"]>[0]; options: Parameters<ExtensionAPI["sendMessage"]>[1] }[] = [];
  const events = {
    on(name: string, listener: (data: unknown) => void) {
      const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(listener);
      return () => { set.delete(listener); };
    },
    emit(name: string, data: unknown) { for (const listener of listeners.get(name) ?? []) listener(data); },
  };
  agents({
    on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, command),
    registerTool(tool: typeof task) { task = tool; }, events, getThinkingLevel: () => "high",
    sendMessage: ((message, options) => { assert.equal(input, undefined, "the parent must own input before its summary starts");
      handoffs.push({ message, options }); }) satisfies ExtensionAPI["sendMessage"],
  } as unknown as ExtensionAPI, runner);
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const notices: string[] = [];
  const noticeTypes: string[] = [];
  const ctx = {
    cwd, mode, hasUI: true, signal: undefined,
    isIdle: () => true, waitForIdle: async () => {},
    sessionManager: { getEntries: () => entries, getSessionId: () => sessionId }, isProjectTrusted: () => true,
    ui: { notify: (text: string, type: string) => { notices.push(text); noticeTypes.push(type); }, confirm: async () => true,
      onTerminalInput(handler: TerminalInputHandler) { input = handler; return () => { input = undefined; }; },
      setWidget() { assert.fail("Subagent progress belongs in the existing Working slot"); },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, events, entries, notices, noticeTypes, listeners, handoffs,
    setSessionId: (value: string) => { sessionId = value; },
    task: (agent = "researcher") => task.execute("task-fixture", { agent, task: "inspect" }, undefined, undefined, ctx as unknown as ExtensionToolContext),
    input: (data: string) => input?.(data), hasInput: () => input !== undefined,
    run: (args = "run researcher inspect") => commands.get("agents")!.handler(args, ctx),
    shortcut: (name: "scout" | "lens", args = "") => commands.get(name)!.handler(args, ctx),
    shutdown: (reason: SessionShutdownEvent["reason"]) => shutdown({ type: "session_shutdown", reason }),
  };
}

const cancelled: SubagentResult = { report: "", toolCalls: 0, blocked: [], aborted: true };

test("concurrent agents share the Working slot without one run clearing or updating another's status", async (t) => {
  const started = new Map<string, () => void>(), finish = new Map<string, () => void>();
  const requests = new Map<string, SubagentRequest>();
  const scoutReady = new Promise<void>(resolve => started.set("scout", resolve));
  const lensReady = new Promise<void>(resolve => started.set("lens", resolve));
  const host = fixture(t, async (request) => {
    const name = request.definition.name;
    requests.set(name, request);
    request.onProgress?.("Using read", { toolCalls: 2 });
    started.get(name)!();
    await new Promise<void>(resolve => finish.set(name, resolve));
    return { ...cancelled, aborted: false, report: "Findings" };
  }, "tui");
  const scout = host.shortcut("scout", "Find callers"), lens = host.shortcut("lens");
  try {
    await Promise.all([scoutReady, lensReady]);
    assert.equal(activeSubagentStatus()?.name, "lens");
    assert.equal(activeSubagentStatus()?.additionalRuns, 1);
    assert.equal(activeSubagentStatus()?.toolCalls, 2);
    assert.ok(!host.notices.some(text => text.startsWith("Running ")));
    finish.get("scout")!(); await scout;
    assert.equal(activeSubagentStatus()?.additionalRuns, 0);
    requests.get("scout")!.onProgress?.("Late progress", { toolCalls: 99 });
    assert.equal(activeSubagentStatus()?.name, "lens");
    assert.equal(activeSubagentStatus()?.note, "Using read");
    assert.equal(activeSubagentStatus()?.toolCalls, 2);
    finish.get("lens")!(); await lens;
    assert.equal(activeSubagentStatus(), undefined);
  } finally { finish.get("scout")?.(); finish.get("lens")?.(); await Promise.allSettled([scout, lens]); }
});

test("subagent activity is cleared on errors and before a replaced session finishes shutting down", async (t) => {
  await t.test("failure", async (t) => {
    const failed = fixture(t, async () => { throw new Error("Fixture failure"); }, "tui");
    await failed.shortcut("lens");
    assert.equal(activeSubagentStatus(), undefined);
    assert.match(failed.notices.at(-1)!, /Fixture failure/);
  });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const host = fixture(t, async request => {
    started();
    await new Promise<void>(resolve => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
    return cancelled;
  }, "tui");
  const pending = host.shortcut("lens"); await ready;
  assert.equal(activeSubagentStatus()?.name, "lens");
  await host.shutdown("new");
  assert.equal(activeSubagentStatus(), undefined);
  await pending;
});

test("a cancelled parent never starts a child or shows a stale status", async (t) => {
  const host = fixture(t, async () => { assert.fail("An aborted initialization must not start the child"); }, "tui");
  host.ctx.signal = AbortSignal.abort();
  const running = host.shortcut("lens");
  await running;
  assert.equal(activeSubagentStatus(), undefined);
  assert.match(host.notices.at(-1)!, /cancelled/);
});

test("bundled agents are listed and run through the task tool and manual command", async (t) => {
  const requests: SubagentRequest[] = [];
  const host = fixture(t, async (request) => {
    requests.push(request); return { ...cancelled, aborted: false, report: "Concise findings only." };
  });
  await host.run("list");
  assert.match(host.notices.at(-1)!, /scout \(builtin\)/);
  assert.match(host.notices.at(-1)!, /lens \(builtin\)/);
  const report = await host.task("scout");
  assert.match(JSON.stringify(report), /Concise findings only/);
  assert.equal(host.handoffs.length, 0, "a task tool already returns its report through the parent loop");
  await host.run("run lens review the current changes");
  assert.equal(host.handoffs.length, 1);
  assert.equal(host.handoffs[0].message.customType, SUBAGENT_REPORT_TYPE);
  assert.equal(host.handoffs[0].message.display, false);
  assert.match(String(host.handoffs[0].message.content), /Concise findings only/);
  assert.deepEqual(host.handoffs[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.deepEqual(requests.map((request) => request.definition.name), ["scout", "lens"]);
  assert.ok(requests.every((request) => request.definition.scope === "builtin"));
  assert.ok(requests.every((request) => request.thinkingLevel === "high"));
});

test("deleting a bundled agent leaves it available and removing an override announces the fallback", async (t) => {
  const host = fixture(t, async () => ({ ...cancelled, aborted: false, report: "Findings" }));
  await host.run("delete scout");
  assert.match(host.notices.at(-1)!, /built-in scout agent cannot be deleted/);
  const store = new AgentStore({ cwd: host.ctx.cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, projectTrusted: true });
  assert.equal(store.find("scout")!.scope, "builtin");
  store.save("global", { ...store.find("scout")!, prompt: "Personal instructions" });
  await host.run("delete scout");
  assert.match(host.notices.at(-1)!, /builtin definition is now active/);
  assert.equal(store.find("scout")!.scope, "builtin");
});

test("direct commands require a scout task and default lens to the current working-tree changes", async (t) => {
  const requests: SubagentRequest[] = [];
  const host = fixture(t, async (request) => {
    requests.push(request); return { ...cancelled, aborted: false, report: "Concise findings." };
  });
  await host.shortcut("scout");
  assert.match(host.notices.at(-1)!, /Use \/scout TASK/);
  assert.equal(requests.length, 0);
  await host.shortcut("scout", "  Trace callers\nand the permission checks.  ");
  await host.shortcut("lens");
  await host.shortcut("lens", "Review commit abc123");
  assert.deepEqual(requests.map((request) => request.definition.name), ["scout", "lens", "lens"]);
  assert.equal(requests[0].task, "Trace callers\nand the permission checks.");
  assert.match(requests[1].task, /current working-tree changes, including staged, unstaged, and untracked files/);
  assert.equal(requests[2].task, "Review commit abc123");
  assert.equal(host.handoffs.length, 3);
  assert.ok(!host.notices.some((text) => text.endsWith("Concise findings.")), "raw report Markdown must not be printed as a notification");
  await host.shortcut("scout", "x".repeat(12_001));
  assert.equal(requests.length, 3);
  assert.match(host.notices.at(-1)!, /Task exceeds/);
});

test("manual handoffs preserve all findings and mark bounded, missing, or limited reports honestly", () => {
  const message = subagentReportMessage({ name: "lens" }, "Review src/example.ts", {
    report: "### P1 — First finding\nsrc/example.ts:12\n\n### P2 — Second finding\nsrc/example.ts:84\nChecks: tests not run.",
    toolCalls: 70, blocked: [], aborted: false, model: "fixture",
  });
  assert.equal(message.display, false);
  assert.match(message.content, /First finding[\s\S]*Second finding[\s\S]*tests not run/);
  assert.match(message.content, /not implementation or another delegation/);
  const limited = subagentReportMessage({ name: "scout" }, "Inspect", {
    report: "x".repeat(30_000), toolCalls: 100, blocked: ["bash: blocked"], aborted: false,
  });
  assert.match(limited.content, /"status": "limited"/);
  assert.match(limited.content, /report truncated/);
  assert.ok(limited.content.length < 26_000);
  const empty = subagentReportMessage({ name: "lens" }, "Review", { ...cancelled, aborted: false });
  assert.match(empty.content, /"status": "incomplete"/);
  assert.match(empty.content, /"report": null/);
});

test("reports are never handed to a different session or after a cancelled policy", async (t) => {
  for (const reason of ["session", "policy"] as const) await t.test(reason, async (t) => {
    let ready!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const done = new Promise<void>(resolve => { finish = resolve; });
    const host = fixture(t, async () => {
      ready(); await done;
      // Deliberately return a late successful result despite cancellation.
      return { ...cancelled, aborted: false, report: "Late findings" };
    });
    const running = host.shortcut("lens"); await started;
    if (reason === "session") host.setSessionId("replacement-session");
    else host.events.emit(PERMISSIONS_CHANGED, { mode: "read-only" });
    finish(); await running;
    assert.equal(host.handoffs.length, 0);
  });
});

test("direct commands use current overrides and pass the session's permission and planning limits", async (t) => {
  const requests: SubagentRequest[] = [];
  const host = fixture(t, async (request) => {
    requests.push(request); return { ...cancelled, aborted: false, report: "Findings" };
  });
  const store = new AgentStore({ cwd: host.ctx.cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, projectTrusted: true });
  store.save("global", { ...store.find("scout")!, tools: [], prompt: "Personal scout" });
  store.save("project", { ...store.find("lens")!, tools: ["read"], prompt: "Project reviewer" });
  host.entries.push({ type: "custom", customType: PERMISSIONS_ENTRY, data: { mode: "read-only" } });
  host.entries.push({ type: "custom", customType: PLAN_ENTRY, data: { status: "planning" } });
  await host.shortcut("scout", "Inspect the module");
  await host.shortcut("lens");
  assert.deepEqual(requests.map((request) => request.definition.scope), ["global", "project"]);
  assert.deepEqual(requests.map((request) => request.definition.tools), [[], ["read"]]);
  assert.deepEqual(requests.map((request) => request.definition.prompt), ["Personal scout", "Project reviewer"]);
  assert.ok(requests.every((request) => request.mode === "read-only" && request.planning && request.thinkingLevel === "high"));
});

test("a permission or planning change revokes an active subagent and releases policy listeners", async (t) => {
  for (const event of [PERMISSIONS_CHANGED, PLAN_CHANGED]) {
    await t.test(event, async (t) => {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      let request!: SubagentRequest;
      const host = fixture(t, async (value) => {
        request = value; started();
        await new Promise<void>((resolve) => value.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return cancelled;
      });
      const pending = host.run(); await ready;
      host.entries.push({ type: "custom", customType: PERMISSIONS_ENTRY, data: { mode: "read-only" } });
      host.events.emit(event, event === PERMISSIONS_CHANGED ? { mode: "read-only" } : { planning: true });
      assert.equal(request.signal!.aborted, true);
      await pending;
      assert.ok(host.notices.some((text) => /cancelled/.test(text)));
      assert.equal(host.listeners.get(PERMISSIONS_CHANGED)!.size, 0);
      assert.equal(host.listeners.get(PLAN_CHANGED)!.size, 0);
    });
  }
});

test("a completed run releases policy listeners without revoking a later run", async (t) => {
  let signal: AbortSignal | undefined;
  const host = fixture(t, async (request) => { signal = request.signal; return { ...cancelled, aborted: false, report: "Done" }; });
  await host.run(); host.events.emit(PERMISSIONS_CHANGED, { mode: "ask" });
  assert.equal(signal!.aborted, false);
  assert.equal(host.listeners.get(PERMISSIONS_CHANGED)!.size, 0);
});

test("shutdown cancels idle slash-command children and waits for their cleanup before replacement", async (t) => {
  const reasons: SessionShutdownEvent["reason"][] = ["new", "reload", "resume", "fork", "quit"];
  for (const reason of reasons) await t.test(reason, async (t) => {
    let started!: () => void, finishCleanup!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    let signal!: AbortSignal;
    const host = fixture(t, async (request) => {
      signal = request.signal!; started();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      await cleanup;
      return cancelled;
    });
    assert.equal(host.ctx.signal, undefined, "an idle parent supplies no streaming signal");
    const running = host.run(); await ready;
    let replaced = false;
    const closing = host.shutdown(reason).then(() => { replaced = true; });
    assert.equal(signal.aborted, true);
    await Promise.resolve(); assert.equal(replaced, false, "replacement must wait for the child to finish");
    finishCleanup(); await Promise.all([running, closing]);
    assert.equal(replaced, true);
    assert.equal(host.notices.length, 1, "no notices may use the outgoing session after shutdown");
    assert.equal(host.handoffs.length, 0);
    assert.equal(host.listeners.get(PERMISSIONS_CHANGED)!.size, 0);
  });
});

test("manual subagents stop on Esc and Ctrl+C without exiting or changing the editor draft", async (t) => {
  for (const command of ["agents", "scout", "lens"] as const) for (const key of ["\x1b", "\x1b[27u", "\x03"]) await t.test(`${command} ${JSON.stringify(key)}`, async (t) => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const host = fixture(t, async (request) => {
      started(); await new Promise<void>((resolve) => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return cancelled;
    }, "tui");
    const pending = command === "agents" ? host.run() : host.shortcut(command, "Inspect the module"); await ready;
    assert.equal(host.input("ordinary typing"), undefined);
    assert.deepEqual(host.input(key), { consume: true });
    await pending;
    assert.equal(host.hasInput(), false);
    assert.ok(host.notices.some((text) => /cancelled/.test(text)));
    assert.equal(host.handoffs.length, 0);
  });
});

test("/agents stop cancels active runs and is harmless when none are running", async (t) => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const host = fixture(t, async (request) => {
    started(); await new Promise<void>((resolve) => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
    return cancelled;
  });
  const running = host.run(); await ready;
  await host.run("stop"); await running;
  assert.ok(host.notices.includes("Subagent runs stopped."));
  await host.run("stop");
  assert.equal(host.notices.at(-1), "No subagent is running.");
});

test("a tool's parent cancellation still reaches its child", async (t) => {
  const parent = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const host = fixture(t, async (request) => {
    started(); await new Promise<void>((resolve) => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
    return cancelled;
  });
  host.ctx.signal = parent.signal;
  const running = host.run(); await ready; parent.abort(); await running;
  assert.ok(host.notices.some((text) => /cancelled/.test(text)));
});

test("provider failures reach the task tool as errors and the manual command as an error notice", async (t) => {
  const host = fixture(t, async () => { throw new Error("Subagent researcher failed: fixture provider failure"); });
  await assert.rejects(host.task(), /fixture provider failure/);
  await host.run();
  assert.match(host.notices.at(-1)!, /fixture provider failure/);
  assert.equal(host.noticeTypes.at(-1), "error");
  assert.equal(host.handoffs.length, 0);
  assert.ok(!host.notices.some((text) => /finished|No report\./.test(text)));
  assert.equal(host.listeners.get(PERMISSIONS_CHANGED)!.size, 0);
});
