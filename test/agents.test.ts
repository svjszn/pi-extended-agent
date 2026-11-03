import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import type { AgentDefinition, AgentScope } from "../lib/agents.js";
import type { SubagentRequest, SubagentProgress, ApprovalDecision, GuardState } from "../lib/subagent.js";
import type { ExtensionAPI, ExtensionCommandContext, ToolInfo, BeforeAgentStartEvent, BeforeAgentStartEventResult, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { PanelFactory } from "./helpers.ts";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
const { AgentStore, agentsPrompt, parseAgent, renderAgent, validAgentName } = await import(new URL("../dist/lib/agents.js", import.meta.url).href) as typeof import("../lib/agents.js");
const { createSubagentGuard, readReport, runSubagent } = await import(new URL("../dist/lib/subagent.js", import.meta.url).href) as typeof import("../lib/subagent.js");
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
const { serializeApproval } = await import(new URL("../dist/lib/approval-queue.js", import.meta.url).href) as typeof import("../lib/approval-queue.js");
const { isDelegationTool } = await import(new URL("../dist/lib/workspace-tools.js", import.meta.url).href) as typeof import("../lib/workspace-tools.js");
const { createPermissionApprovalScreen } = await import(new URL("../dist/ui/permissions-screen.js", import.meta.url).href) as typeof import("../ui/permissions-screen.js");
const { createUiTheme } = await import(new URL("../dist/ui/theme.js", import.meta.url).href) as typeof import("../ui/theme.js");
const { openAgentEditor } = await import(new URL("../dist/ui/agents-screen.js", import.meta.url).href) as typeof import("../ui/agents-screen.js");
import { createRequire, findPackageJSON } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");

function directory(t: TestContext) {
  const base = resolve(".local/agents-tests"); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "project-"));
  t.after(() => { const path = resolve(cwd); assert.ok(path.startsWith(base + sep)); rmSync(path, { recursive: true, force: true }); });
  return cwd;
}
function paths(t: TestContext, { projectTrusted = true } = {}) {
  const cwd = directory(t);
  return { cwd, agentDir: join(cwd, "profile"), projectTrusted };
}
type Paths = ReturnType<typeof paths>;
function writeAgent(root: Paths, scope: AgentScope, name: string, content: string) {
  const directory = scope === "project" ? join(root.cwd, ".pi", "agents") : join(root.agentDir, "agents");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), content);
}
const definition: AgentDefinition = { scope: "global", filePath: "fixture", name: "researcher", description: "Reads code and reports findings", prompt: "Investigate and report." };
const builtin: Pick<ToolInfo, "name" | "sourceInfo">[] = ["read", "find", "grep", "ls", "write", "edit", "bash"].map((name) => ({ name, sourceInfo: { source: "builtin", scope: "user", origin: "top-level", path: `builtin:${name}` } }));

/** Drive the guard the way the engine does, without a model or a real session. */
type StartHandler = (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult | void;
type CallHandler = (event: ToolCallEvent) => Promise<ToolCallEventResult | void>;
function guard(request: Partial<SubagentRequest>, { tools = builtin, onAllowed = () => {} } = {}) {
  const state: GuardState = { toolCalls: 0, blocked: [] };
  let start!: StartHandler, call!: CallHandler;
  const inline = createSubagentGuard({ definition, task: "t", cwd: ".", agentDir: ".", mode: "allow", planning: false, ...request }, state, onAllowed);
  assert.ok(typeof inline !== "function");
  inline.factory({
    on(name: string, handler: unknown) {
      if (name === "before_agent_start") start = handler as StartHandler;
      if (name === "tool_call") call = handler as CallHandler;
    }, getAllTools: () => tools,
  } as unknown as ExtensionAPI);
  return { state,
    call: (toolName: string, input: Record<string, unknown> = {}) => call({ type: "tool_call", toolCallId: "fixture", toolName, input } as ToolCallEvent),
    start: (event: BeforeAgentStartEvent) => start(event),
  };
}

test("a fresh profile has scout and lens without writing definitions or loading their prompts into the parent", (t) => {
  const root = paths(t, { projectTrusted: false });
  const store = new AgentStore(root);
  const catalog = store.list();
  assert.deepEqual(catalog.agents.map((agent) => agent.name), ["lens", "scout"]);
  assert.deepEqual(catalog.unreadable, []);
  for (const agent of catalog.agents) {
    assert.equal(agent.scope, "builtin");
    assert.equal(agent.filePath, undefined);
    assert.equal(agent.model, undefined);
    assert.match(agent.prompt, new RegExp(`You are ${agent.name}`));
    assert.match(agentsPrompt(catalog)!, new RegExp(`${agent.name}:`));
    assert.ok(!agentsPrompt(catalog)!.includes(agent.prompt));
  }
  assert.deepEqual(store.find("scout")!.tools, ["read", "find", "grep", "ls"]);
  assert.deepEqual(store.find("lens")!.tools, ["read", "find", "grep", "ls", "bash"]);
  assert.equal(existsSync(root.agentDir), false);
  assert.equal(existsSync(join(root.cwd, ".pi")), false);
  store.find("scout")!.tools!.push("write");
  assert.equal(store.find("scout")!.tools!.includes("write"), false);
  assert.throws(() => store.delete("builtin" as AgentScope, "scout"), /built-in agents cannot be changed directly/);
  assert.equal(existsSync(root.agentDir), false);
});

test("user overrides take precedence over bundled agents and deleting them restores the lower scope", (t) => {
  const root = paths(t), store = new AgentStore(root);
  const scout = store.find("scout")!;
  store.save("global", { ...scout, description: "Personal scout", tools: [] });
  store.save("project", { ...scout, description: "Project scout", tools: ["read"] });
  assert.equal(store.find("scout")!.scope, "project");
  assert.deepEqual(store.find("scout")!.tools, ["read"]);
  const untrusted = new AgentStore({ ...root, projectTrusted: false });
  assert.equal(untrusted.find("scout")!.scope, "global");
  assert.deepEqual(untrusted.find("scout")!.tools, []);
  store.delete("project", "scout");
  assert.equal(store.find("scout")!.description, "Personal scout");
  assert.deepEqual(store.find("scout")!.tools, []);
  store.delete("global", "scout");
  assert.deepEqual(store.find("scout"), scout);
  assert.equal(store.list().agents.filter((agent) => agent.name === "scout").length, 1);
});

test("a damaged override reports its error while retaining the bundled agent", (t) => {
  const root = paths(t), store = new AgentStore(root);
  writeAgent(root, "global", "lens", "invalid definition");
  writeAgent(root, "project", "scout", "invalid definition");
  const catalog = store.list();
  assert.deepEqual(catalog.agents.map((agent) => [agent.name, agent.scope]), [["lens", "builtin"], ["scout", "builtin"]]);
  assert.equal(catalog.unreadable.length, 2);
  assert.match(catalog.unreadable[0], /^lens \(global\)/);
  assert.match(catalog.unreadable[1], /^scout \(project\)/);
});

test("agent definitions parse the stored format and reject unusable ones", () => {
  const parsed = parseAgent(renderAgent({ ...definition, tools: ["read", "grep"], model: "gpt-6.1-sol" }),
    { name: "researcher", scope: "global", filePath: "x" });
  assert.equal(parsed.description, definition.description);
  assert.deepEqual(parsed.tools, ["read", "grep"]);
  assert.equal(parsed.model, "gpt-6.1-sol");
  assert.equal(parsed.prompt, "Investigate and report.");
  // A comma-separated string is the format Claude-style definitions use.
  assert.deepEqual(parseAgent("---\ndescription: d\ntools: read, grep\n---\nbody", { name: "a", scope: "global", filePath: "x" }).tools, ["read", "grep"]);
  // A missing or empty tools key inherits the engine default; `tools: []` means none.
  for (const header of ["description: d", "description: d\ntools:"]) {
    assert.equal(parseAgent(`---\n${header}\n---\nbody`, { name: "a", scope: "global", filePath: "x" }).tools, undefined);
  }
  assert.deepEqual(parseAgent("---\ndescription: d\ntools: []\n---\nbody", { name: "a", scope: "global", filePath: "x" }).tools, []);
  assert.throws(() => parseAgent("---\nname: other\ndescription: d\n---\nbody", { name: "a", scope: "global", filePath: "x" }), /does not match its filename/);
  assert.throws(() => parseAgent("---\n---\nbody", { name: "a", scope: "global", filePath: "x" }), /needs a description/);
  assert.throws(() => parseAgent("---\ndescription: d\n---\n", { name: "a", scope: "global", filePath: "x" }), /needs instructions/);
  for (const name of ["Agent", "a b", "../escape", "a--b", "nul", ""]) assert.equal(validAgentName(name), false);
  for (const name of ["researcher", "test-runner", "a1"]) assert.equal(validAgentName(name), true);
});

test("definition serialization preserves tool restrictions and YAML-sensitive values", () => {
  for (const tools of [undefined, [], ["*"], ["read", "grep"]]) {
    for (const description of ["Explain: details # keep this", "true", "[a, b]", 'Quoted "text"']) {
      const draft = { ...definition, tools, description };
      const parsed = parseAgent(renderAgent(draft), { name: draft.name, scope: "global", filePath: "fixture" });
      assert.deepEqual(parsed.tools, tools);
      assert.equal(parsed.description, description);
    }
  }
  for (const invalid of [false, 7, {}, ["read", false]]) {
    assert.throws(() => parseAgent(`---\ndescription: d\ntools: ${JSON.stringify(invalid)}\n---\nbody`,
      { name: "a", scope: "global", filePath: "fixture" }), /Tools must be a list/);
  }
});

test("project definitions shadow global ones and a damaged file never hides the others", (t) => {
  const root = paths(t);
  const store = new AgentStore(root);
  writeAgent(root, "global", "researcher", renderAgent({ ...definition, description: "global version" }));
  writeAgent(root, "global", "reviewer", renderAgent({ ...definition, name: "reviewer", description: "reviews diffs" }));
  writeAgent(root, "project", "researcher", renderAgent({ ...definition, description: "project version" }));
  writeAgent(root, "project", "broken", "no frontmatter at all");
  const catalog = store.list();
  assert.deepEqual(catalog.agents.map((agent) => agent.name), ["lens", "researcher", "reviewer", "scout"]);
  assert.equal(store.find("researcher")!.description, "project version");
  assert.equal(store.find("researcher")!.scope, "project");
  assert.equal(catalog.unreadable.length, 1);
  assert.match(catalog.unreadable[0], /^broken \(project\)/);
  assert.match(agentsPrompt(catalog)!, /researcher: project version/);
  assert.doesNotMatch(agentsPrompt(catalog)!, /broken/);
});

test("an untrusted project contributes no instructions, tools, or saves", (t) => {
  const root = paths(t, { projectTrusted: false });
  const store = new AgentStore(root);
  writeAgent(root, "project", "researcher", renderAgent({ ...definition, description: "untrusted" }));
  writeAgent(root, "global", "reviewer", renderAgent({ ...definition, name: "reviewer" }));
  assert.deepEqual(store.list().agents.map((agent) => agent.name), ["lens", "reviewer", "scout"]);
  assert.throws(() => store.save("project", definition), /trusted project/);
});

test("agents are saved, replaced and deleted per scope", (t) => {
  const root = paths(t);
  const store = new AgentStore(root);
  store.save("global", definition);
  assert.equal(store.find("researcher")!.description, definition.description);
  store.save("global", { ...definition, description: "updated" });
  assert.equal(store.find("researcher")!.description, "updated");
  assert.equal(store.list().agents.length, 3);
  store.save("project", { ...definition, description: "project copy" });
  assert.equal(store.find("researcher")!.scope, "project");
  store.delete("project", "researcher");
  assert.equal(store.find("researcher")!.scope, "global");
  store.delete("global", "researcher");
  assert.equal(store.find("researcher"), undefined);
  assert.throws(() => store.delete("global", "researcher"), /not found/);
  assert.throws(() => store.save("global", { ...definition, name: "../escape" }), /agent name/);
});

test("deny mode blocks every subagent mutation without asking", async () => {
  const run = guard({ mode: "deny", requestApproval: () => assert.fail("deny must not ask") });
  for (const tool of ["read", "grep", "find", "ls"]) assert.equal(await run.call(tool), undefined);
  for (const tool of ["write", "edit", "bash"]) {
    const result = await run.call(tool, { path: "a" });
    assert.ok(result);
    assert.equal(result.block, true);
    assert.equal(result.terminate, true);
    assert.match(result.reason!, /blocked for subagents/);
  }
  assert.equal(run.state.toolCalls, 4);
  assert.equal(run.state.blocked.length, 3);
});

test("plan mode lets a subagent research and blocks everything else", async () => {
  const run = guard({ mode: "allow", planning: true, requestApproval: () => assert.fail("plan mode must not ask") });
  for (const tool of ["read", "grep", "find", "ls"]) assert.equal(await run.call(tool), undefined);
  for (const tool of ["write", "edit", "bash"]) {
    assert.match((await run.call(tool))!.reason!, /Plan mode.*research only/);
  }
});

test("ask mode approves each subagent call, and a run-wide grant is honoured once given", async () => {
  const asked: [string, unknown][] = [];
  let decision: ApprovalDecision = "once";
  const run = guard({ mode: "ask", requestApproval: async (tool, input) => { asked.push([tool, input]); return decision; } });
  assert.equal(await run.call("read"), undefined, "reads never prompt");
  assert.equal(asked.length, 0);
  assert.equal(await run.call("write", { path: "a" }), undefined);
  assert.equal(await run.call("write", { path: "b" }), undefined);
  assert.deepEqual(asked.map(([tool]) => tool), ["write", "write"], "each call is approved separately");
  decision = "deny";
  assert.match((await run.call("bash"))!.reason!, /Permission was not granted/);
  decision = "run";
  assert.equal(await run.call("edit"), undefined);
  const before = asked.length;
  assert.equal(await run.call("edit"), undefined);
  assert.equal(await run.call("bash"), undefined);
  assert.equal(asked.length, before, "a run-wide grant stops further prompts");
});

test("a subagent cannot act when approval is impossible or the run is cancelled", async () => {
  const headless = guard({ mode: "ask" });
  assert.match((await headless.call("write"))!.reason!, /could not be requested/);
  const thrown = guard({ mode: "ask", requestApproval: async () => { throw new Error("ui gone"); } });
  assert.match((await thrown.call("write"))!.reason!, /Permission was not granted/);
  const controller = new AbortController();
  controller.abort();
  const cancelled = guard({ mode: "allow", signal: controller.signal });
  assert.match((await cancelled.call("read"))!.reason!, /cancelled/);
});

test("the subagent tool budget is bounded", async () => {
  const run = guard({ mode: "allow", maxToolCalls: 2 });
  assert.equal(await run.call("read"), undefined);
  assert.equal(await run.call("read"), undefined);
  assert.match((await run.call("read"))!.reason!, /budget of 2 calls/);
});

test("revoking a run while approval is pending cannot authorize its tool", async () => {
  const controller = new AbortController();
  let grant!: (choice: ApprovalDecision) => void;
  const run = guard({ mode: "ask", signal: controller.signal,
    requestApproval: () => new Promise((resolve) => { grant = resolve; }),
  });
  const pending = run.call("write", { path: "blocked.txt" });
  controller.abort(); grant("run");
  assert.match((await pending)!.reason!, /cancelled/);
  assert.equal(run.state.toolCalls, 0);
});

test("cancellation triggered while reporting an admitted call still blocks tool execution", async () => {
  const controller = new AbortController();
  const run = guard({ signal: controller.signal }, { onAllowed: () => controller.abort() });
  assert.match((await run.call("read"))!.reason!, /cancelled/);
});

test("the guard tells the subagent its report is the only output", async () => {
  const run = guard({ mode: "allow" });
  const event = { systemPrompt: "Native", systemPromptOptions: { sections: {} as Record<string, string> } } as BeforeAgentStartEvent;
  run.start(event);
  assert.match(event.systemPromptOptions!.sections.pi_extended_subagent, /Report back in your final message/);
  const forced = { systemPrompt: "Native", systemPromptOptions: { forceSystemPrompt: "Forced", sections: {} } };
  assert.match(run.start(forced as BeforeAgentStartEvent)!.systemPrompt!, /Native[\s\S]*Report back/);
});

test("only the subagent's own answer is reported back, bounded and cleaned", () => {
  assert.equal(readReport([
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "toolResult", content: [{ type: "text", text: "tool noise" }] },
    { role: "assistant", content: [{ type: "text", text: "final [31mreport[0m" }] },
  ]), "final report");
  assert.equal(readReport([{ role: "assistant", content: "plain string" }]), "plain string");
  assert.equal(readReport([{ role: "user", content: [{ type: "text", text: "task" }] }]), "");
  assert.equal(readReport([]), "");
  // An empty trailing answer falls back to the last one that had text.
  assert.equal(readReport([
    { role: "assistant", content: [{ type: "text", text: "earlier" }] },
    { role: "assistant", content: [] },
  ]), "earlier");
  const long = readReport([{ role: "assistant", content: [{ type: "text", text: "x".repeat(30_000) }] }]);
  assert.ok(long.length < 24_100, `report stayed ${long.length} characters`);
  assert.match(long, /… report truncated$/);
});

test("approvals are serialized so two dialogs never compete for the terminal", async () => {
  const order: string[] = [];
  const open = (id: string, delay: number) => serializeApproval(async () => {
    order.push(`open ${id}`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    order.push(`close ${id}`);
    return id;
  }, "fallback");
  const results = await Promise.all([open("a", 20), open("b", 1), open("c", 1)]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(order, ["open a", "close a", "open b", "close b", "open c", "close c"]);
  // A failing request resolves to its fallback and never stalls the queue.
  const failed = await serializeApproval(async () => { throw new Error("no ui"); }, "denied");
  assert.equal(failed, "denied");
  assert.equal(await open("d", 1), "d");
});

test("delegation passes the parent barriers only for our own origin-verified tool", () => {
  const ours = (file: string): Pick<ToolInfo, "name" | "sourceInfo">[] => [{ name: "task", sourceInfo: { source: "local", scope: "project", origin: "top-level", path: fileURLToPath(new URL(`../dist/extensions/${file}`, import.meta.url)) } }];
  assert.equal(isDelegationTool("task", ours("agents.js")), true);
  // A same-named tool from anywhere else must never inherit the exemption.
  assert.equal(isDelegationTool("task", ours("workspace.js")), false);
  assert.equal(isDelegationTool("task", [{ name: "task", sourceInfo: { source: "builtin", scope: "user", origin: "top-level", path: "builtin:task" } }]), false);
  assert.equal(isDelegationTool("task", [{ name: "task" }] as unknown as Pick<ToolInfo, "name" | "sourceInfo">[]), false);
  assert.equal(isDelegationTool("bash", ours("agents.js")), false);
});

/** A fixture provider answers without a network call or a real model. */
interface FixtureReply { stopReason: "stop" | "error" | "aborted" | "toolUse"; text?: string; errorMessage?: string;
  tool?: Pick<Extract<AssistantMessage["content"][number], { type: "toolCall" }>, "name" | "arguments"> }
async function fixtureRuntime(t: TestContext, reply = "Findings: the module is unused.", responses?: FixtureReply[]) {
  const aiManifest = findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(dirname(aiManifest!), "dist/compat.js")).href) as typeof import("@earendil-works/pi-ai");
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
  const seen: Context[] = [];
  runtime.registerProvider("agent-fixture", { api: "agent-fixture-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      seen.push(context);
      const response = responses?.[seen.length - 1] ?? { stopReason: "stop", text: reply };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        await options?.onResponse?.({ status: 200, headers: {} }, model);
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [...(response.text ? [{ type: "text" as const, text: response.text }] : []),
            ...(response.tool ? [{ type: "toolCall" as const, id: "fixture-call", ...response.tool }] : [])], stopReason: response.stopReason,
          errorMessage: response.errorMessage, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message });
        if (response.stopReason === "stop" || response.stopReason === "toolUse") stream.push({ type: "done", reason: response.stopReason, message });
        else stream.push({ type: "error", reason: response.stopReason, error: message });
        stream.end();
      });
      return stream;
    },
  });
  t.after(() => runtime.unregisterProvider("agent-fixture"));
  return { runtime, seen, model: runtime.getModel("agent-fixture", "fixture")! };
}
function profile(t: TestContext, root: Paths) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root.agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
}
/** The engine declares the run's selection on the system message it sends. */
const declaredTools = (context: Context) => (context.messages.find((message) => message.role === "system")?.toolsAdded ?? []).map((tool) => tool.name);

test("a real subagent run carries the agent's instructions, reports back, and leaves no session file", async (t) => {
  const root = paths(t);
  profile(t, root);
  const { runtime, seen, model } = await fixtureRuntime(t);
  const result = await runSubagent({
    definition: { ...definition, scope: "global", filePath: "x", prompt: "AGENT_RULE: always answer with Findings." },
    task: "SUBAGENT_TASK: inspect the module", cwd: root.cwd, agentDir: root.agentDir,
    mode: "allow", planning: false, modelRuntime: runtime, model, settingsManager: SettingsManager.inMemory(),
  });
  assert.equal(result.report, "Findings: the module is unused.");
  assert.equal(result.aborted, false);
  assert.equal(result.toolCalls, 0);
  assert.equal(result.model, "fixture");
  // The definition reaches the model on top of Pi's own baseline, not instead of it.
  const system = JSON.stringify(seen[0].messages.find((message) => message.role === "system"));
  assert.match(system, /AGENT_RULE: always answer with Findings/);
  assert.match(system, /the researcher subagent/);
  assert.match(JSON.stringify(seen[0].messages), /SUBAGENT_TASK: inspect the module/);
  // A subagent writes no transcript: nothing lands in the profile's sessions.
  assert.equal(existsSync(join(root.agentDir, "sessions")), false);
});

test("subagent progress follows real SDK tool events without exposing arguments, results, or report text", async (t) => {
  const root = paths(t); profile(t, root);
  const file = "private-path-sentinel.txt";
  writeFileSync(join(root.cwd, file), "private-result-sentinel");
  const { runtime, model } = await fixtureRuntime(t, "", [
    { stopReason: "toolUse", tool: { name: "read", arguments: { path: file } } },
    { stopReason: "stop", text: "private-report-sentinel" },
  ]);
  const progress: { note: string; details?: SubagentProgress }[] = [];
  const result = await runSubagent({ definition: { ...definition, tools: ["read"] }, task: "private-task-sentinel",
    cwd: root.cwd, agentDir: root.agentDir, mode: "allow", planning: false, modelRuntime: runtime, model,
    settingsManager: SettingsManager.inMemory(), onProgress: (note, details) => { progress.push({ note, details }); } });
  assert.equal(result.toolCalls, 1);
  assert.equal(result.report, "private-report-sentinel");
  assert.equal(progress[0].note, "Starting");
  assert.ok(progress.some(item => item.note === "Using read" && item.details?.toolCalls === 1));
  assert.ok(progress.some(item => item.note === "Thinking" && item.details?.toolCalls === 1));
  assert.doesNotMatch(JSON.stringify(progress), /private-(?:path|result|report|task)-sentinel/);
});

test("bundled agents run with their own instructions and tool limits while inheriting the parent model", async (t) => {
  const root = paths(t); profile(t, root);
  const store = new AgentStore(root);
  const { runtime, seen, model } = await fixtureRuntime(t);
  for (const name of ["scout", "lens"]) {
    const agent = store.find(name)!;
    for (const restrictions of [{ mode: "allow" as const, planning: false },
      { mode: "deny" as const, planning: false }, { mode: "allow" as const, planning: true }]) {
      const before = seen.length;
      const result = await runSubagent({ definition: agent, task: "Inspect the requested code and report findings.",
        cwd: root.cwd, agentDir: root.agentDir, modelRuntime: runtime, model,
        settingsManager: SettingsManager.inMemory(), ...restrictions });
      assert.equal(result.aborted, false);
      assert.equal(result.model, model.id);
      assert.equal(result.report, "Findings: the module is unused.");
      const expected = restrictions.planning || restrictions.mode === "deny"
        ? ["read", "find", "grep", "ls"] : agent.tools!;
      assert.deepEqual(declaredTools(seen[before]).sort(), [...expected].sort());
      const system = JSON.stringify(seen[before].messages.find((message) => message.role === "system"));
      assert.match(system, new RegExp(`You are ${name}`));
      assert.doesNotMatch(system, new RegExp(`You are ${name === "scout" ? "lens" : "scout"}`));
    }
  }
  assert.equal(existsSync(join(root.agentDir, "agents")), false);
  assert.equal(existsSync(join(root.agentDir, "sessions")), false);
});

test("editing a bundled agent saves a user override and leaves the bundled instructions intact", async (t) => {
  const root = paths(t), store = new AgentStore(root), existing = store.find("scout")!;
  const ctx = { cwd: root.cwd, ui: { async custom(create: PanelFactory) {
    const tui = { children: [], terminal: { rows: 24, columns: 80 }, requestRender() {} };
    const panel = create(tui, createUiTheme(), {}, () => {});
    try { await panel.ready; panel.render(80); panel.handleInput("\x13"); } finally { panel.dispose(); }
  } } } as unknown as ExtensionCommandContext;
  const saved = await openAgentEditor({ pi: { getThinkingLevel: () => "off" } as ExtensionAPI, ctx, existing, measure });
  assert.ok(saved);
  assert.equal(saved.scope, "global");
  assert.deepEqual(saved.draft.tools, existing.tools);
  assert.equal(saved.draft.prompt, existing.prompt);
  assert.equal(store.find("scout")!.scope, "builtin");
  store.save(saved.scope, saved.draft);
  assert.equal(store.find("scout")!.scope, "global");
  store.delete("global", "scout");
  assert.deepEqual(store.find("scout"), existing);
});

test("saving and editing a no-tools agent never restores the engine defaults", async (t) => {
  const root = paths(t); profile(t, root);
  const store = new AgentStore(root);
  store.save("global", { ...definition, tools: [] });
  const loaded = store.find(definition.name)!;
  assert.deepEqual(loaded.tools, []);
  store.save("global", { ...loaded, description: "Edited: still no tools # explicit" });
  const edited = new AgentStore(root).find(definition.name)!;
  assert.deepEqual(edited.tools, []);
  const { runtime, seen, model } = await fixtureRuntime(t);
  await runSubagent({ definition: edited, task: "Report only", cwd: root.cwd, agentDir: root.agentDir,
    mode: "allow", planning: false, modelRuntime: runtime, model, settingsManager: SettingsManager.inMemory() });
  assert.deepEqual(declaredTools(seen[0]), []);
});

test("the agent editor saves explicit tool restrictions and cancels without changing the definition", async (t) => {
  const root = paths(t);
  const store = new AgentStore(root);
  store.save("global", { ...definition, description: "Read: report # findings", tools: [], model: "fixture" });
  const existing = store.find(definition.name)!;
  for (const key of ["\x13", "\x1b"]) {
    const ctx = { cwd: root.cwd, ui: {
      async custom(create: PanelFactory) {
        let closed = false;
        const tui = { children: [], terminal: { rows: 30, columns: 100 }, requestRender() {} };
        const panel = create(tui, createUiTheme(), {}, () => { closed = true; });
        try {
          await panel.ready;
          for (const [width, rows] of [[100, 30], [24, 12], [8, 8]]) {
            tui.terminal.rows = rows;
            const lines = panel.render(width);
            assert.equal(lines.length, rows);
            assert.ok(lines.every(line => measure.visibleWidth(line) <= width));
          }
          panel.handleInput(key);
          assert.equal(closed, true);
        } finally { panel.dispose(); }
      },
    } } as unknown as ExtensionCommandContext;
    const saved = await openAgentEditor({ pi: { getThinkingLevel: () => "off" } as ExtensionAPI, ctx, existing, measure });
    if (key === "\x13") {
      assert.deepEqual(saved, { scope: "global", draft: {
        name: existing.name, description: existing.description, prompt: existing.prompt, tools: [], model: "fixture",
      } });
    } else assert.equal(saved, undefined);
    assert.deepEqual(store.find(definition.name), existing);
  }
});

test("a resolved Pi prompt with a provider error fails the subagent instead of returning a report", async (t) => {
  const root = paths(t); profile(t, root);
  const { runtime, seen, model } = await fixtureRuntime(t, "", [{ stopReason: "error", text: "I will investigate", errorMessage: "Fixture provider rejected the request" }]);
  const settings = SettingsManager.inMemory({ retry: { enabled: false } });
  await assert.rejects(runSubagent({ definition, task: "Inspect", cwd: root.cwd, agentDir: root.agentDir,
    mode: "allow", planning: false, modelRuntime: runtime, model, settingsManager: settings,
  }), /Subagent researcher failed: Fixture provider rejected the request/);
  assert.equal(seen.length, 1);
  assert.equal(existsSync(join(root.agentDir, "sessions")), false);
});

test("a provider-side abort without an external abort signal is reported as cancelled", async (t) => {
  const root = paths(t); profile(t, root);
  const { runtime, model } = await fixtureRuntime(t, "", [{ stopReason: "aborted", text: "Partial response" }]);
  const result = await runSubagent({ definition, task: "Inspect", cwd: root.cwd, agentDir: root.agentDir,
    mode: "allow", planning: false, modelRuntime: runtime, model, settingsManager: SettingsManager.inMemory(),
  });
  assert.equal(result.aborted, true);
  assert.equal(result.report, "");
});

test("a provider error recovered by Pi retries still returns the final successful report", async (t) => {
  const root = paths(t); profile(t, root);
  const { runtime, seen, model } = await fixtureRuntime(t, "", [
    { stopReason: "error", errorMessage: "429 rate limit exceeded" },
    { stopReason: "stop", text: "Recovered findings" },
  ]);
  const result = await runSubagent({ definition, task: "Inspect", cwd: root.cwd, agentDir: root.agentDir,
    mode: "allow", planning: false, modelRuntime: runtime, model,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 2 } }),
  });
  assert.equal(seen.length, 2);
  assert.equal(result.aborted, false);
  assert.equal(result.report, "Recovered findings");
});

test("cancellation before prompting never sends a provider request", async (t) => {
  const root = paths(t); profile(t, root);
  const { runtime, seen, model } = await fixtureRuntime(t);
  const controller = new AbortController();
  const result = await runSubagent({ definition, task: "Do not run", cwd: root.cwd, agentDir: root.agentDir,
    mode: "allow", planning: false, modelRuntime: runtime, model, settingsManager: SettingsManager.inMemory(),
    signal: controller.signal, onProgress: () => controller.abort(),
  });
  assert.equal(result.aborted, true);
  assert.equal(seen.length, 0);
  const preAborted = await runSubagent({ definition, task: "Do not initialize", cwd: root.cwd, agentDir: root.agentDir,
    mode: "allow", planning: false, signal: controller.signal,
  });
  assert.equal(preAborted.aborted, true);
  assert.equal(existsSync(join(root.agentDir, "sessions")), false);
});

test("restricted modes narrow what the subagent is actually offered, never wider than its definition", async (t) => {
  const root = paths(t);
  profile(t, root);
  const { runtime, seen, model } = await fixtureRuntime(t);
  const run = (overrides: Partial<SubagentRequest>, tools: string[] | undefined) => runSubagent({
    definition: { ...definition, scope: "global", filePath: "x", ...(tools !== undefined ? { tools } : {}) },
    task: "t", cwd: root.cwd, agentDir: root.agentDir, mode: "allow", planning: false,
    modelRuntime: runtime, model, settingsManager: SettingsManager.inMemory(), ...overrides,
  });
  const selections: [Partial<SubagentRequest>, string[] | undefined, string[]][] = [
    [{}, ["read", "bash"], ["read", "bash"]],
    [{ planning: true }, undefined, ["read", "find", "grep", "ls"]],
    [{ mode: "deny" }, undefined, ["read", "find", "grep", "ls"]],
    [{ planning: true }, ["read"], ["read"]],
    // A definition that only asks for mutating tools is offered nothing at all.
    [{ mode: "deny" }, ["bash", "write"], []],
  ];
  for (const [overrides, tools, expected] of selections) {
    const before = seen.length;
    await run(overrides, tools);
    assert.deepEqual(declaredTools(seen[before]).sort(), [...expected].sort(),
      `selection for ${JSON.stringify({ ...overrides, tools })}`);
  }
});

test("the approval screen offers a run-wide grant only when asked, never preselected", async () => {
  const choices: [string[], ApprovalDecision][] = [[[], "deny"], [["\x1b[C"], "once"], [["\x1b[C", "\x1b[C"], "run"],
    [["\x1b[C", "\x1b[C", "\x1b[C"], "run"], [["\x1b[C", "\x1b[C", "\x1b[D"], "once"]];
  for (const [keys, expected] of choices) {
    let choice: ApprovalDecision | undefined, closed: boolean | undefined;
    const panel = createPermissionApprovalScreen({
      tui: { terminal: { rows: 24 }, requestRender() {} }, theme: createUiTheme(), measure,
      done: (value) => { closed = value; }, lines: ["Tool: write"], runLabel: "Allow for this researcher run",
      onChoice: (value) => { choice = value; },
    });
    await panel.ready; panel.render(80);
    assert.match(measure.stripTerminalSequences(panel.render(80).join("\n")), /Allow for this researcher run/);
    for (const key of keys) panel.handleInput(key);
    panel.handleInput("\r");
    assert.equal(choice, expected);
    assert.equal(closed, expected !== "deny");
  }
  // Without runLabel the screen keeps exactly the two original choices.
  let choice: ApprovalDecision | undefined;
  const plain = createPermissionApprovalScreen({
    tui: { terminal: { rows: 24 }, requestRender() {} }, theme: createUiTheme(), measure,
    done: () => {}, lines: ["Tool: write"], onChoice: (value) => { choice = value; },
  });
  await plain.ready; plain.render(80);
  assert.doesNotMatch(measure.stripTerminalSequences(plain.render(80).join("\n")), /for this/);
  plain.handleInput("\x1b[C"); plain.handleInput("\x1b[C"); plain.handleInput("\r");
  assert.equal(choice, "once");
});
