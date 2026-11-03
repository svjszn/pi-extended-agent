import { present } from "../test/helpers.ts";
// Run only against the npm artifact installed by release-check.ts, never the checkout's modules.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installed, temp] = process.argv.slice(2);
assert.ok(installed && temp);
const { bundledRuntime } = await import(pathToFileURL(join(installed, "dist/bin/runtime.js")).href) as typeof import("../bin/runtime.js");
const runtime = bundledRuntime();
const api = await import(pathToFileURL(runtime.entry).href) as typeof import("@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = api;
const { codeModeBuiltin } = await import(pathToFileURL(join(installed, "dist/lib/code-mode.js")).href) as typeof import("../lib/code-mode.js");
const { AgentStore } = await import(pathToFileURL(join(installed, "dist/lib/agents.js")).href) as typeof import("../lib/agents.js");
const { verifyRuntime } = await import(pathToFileURL(join(installed, "dist/bin/verify-runtime.js")).href) as typeof import("../bin/verify-runtime.js");
await verifyRuntime(bundledRuntime(), installed);

const cwd = join(temp, "project"), agentDir = present(process.env.PI_CODING_AGENT_DIR);
mkdirSync(agentDir, { recursive: true });
const agentStore = new AgentStore({ cwd, agentDir, projectTrusted: false });
assert.deepEqual(agentStore.list().agents.map((agent) => [agent.name, agent.scope]), [["lens", "builtin"], ["scout", "builtin"]]);
assert.equal(existsSync(join(agentDir, "agents")), false, "Bundled agents should not create profile definitions.");
assert.deepEqual(agentStore.find("scout")?.tools, ["read", "find", "grep", "ls"]);
assert.deepEqual(agentStore.find("lens")?.tools, ["read", "find", "grep", "ls", "bash"]);
agentStore.save("global", { name: "release-agent", description: "Isolated release fixture", tools: [], prompt: "Return a single report." });
assert.deepEqual(agentStore.find("release-agent")?.tools, []);
const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
  credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
const settingsManager = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
  noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [installed, "builtin:codemode"],
  extensionFactories: [codeModeBuiltin(api.createCodemodeExtension)] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const manager = SessionManager.create(cwd, join(temp, "sessions"));
// A normal conversation entry causes Pi to persist setup/custom session metadata.
manager.appendMessage({ role: "user", content: "Local release smoke check", timestamp: Date.now() });
const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: manager });
let resumed;
try {
  await session.bindExtensions({ mode: "print" });
  const required = ["agents", "scout", "lens", "config", "model", "effort", "permissions", "memory", "plan", "mode", "prompt", "theme", "color"];
  const commands = session.extensionRunner.getRegisteredCommands().map((command) => command.name);
  for (const name of required.filter((name) => name !== "model")) assert.ok(commands.includes(name), `Missing /${name}`);
  assert.equal(commands.includes("perf"), false, "Installed package registered a development command");
  assert.equal(session.extensionRunner.getCommand("perf"), undefined);
  assert.ok(loader.getExtensions().extensions.some(extension => extension.tools.has("task")));
  assert.ok(loader.getExtensions().extensions.some(extension => extension.tools.has("ask_user")));
  await session.prompt("/agents list");
  // Exercise the production CLI loader as well as the unbundled SDK path.
  const bundled = await import(pathToFileURL(join(runtime.packageDir, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
  const cliLoader = new bundled.DefaultResourceLoader({ cwd, agentDir, settingsManager: bundled.SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [installed] });
  await cliLoader.reload();
  assert.deepEqual(cliLoader.getExtensions().errors, []);
  for (const extension of cliLoader.getExtensions().extensions) assert.equal(extension.commands.has("perf"), false);
  assert.equal(cliLoader.getExtensions().extensions.length, JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).pi.extensions.length);
  assert.ok(cliLoader.getExtensions().extensions.some(extension => extension.commands.has("agents") && extension.tools.has("task")));
  assert.ok(cliLoader.getExtensions().extensions.some(extension => extension.commands.has("scout") && extension.commands.has("lens")));
  assert.ok(cliLoader.getExtensions().extensions.some(extension => extension.tools.has("ask_user")));
  session.agent.state.messages.push({ role: "assistant", content: [{ type: "toolCall", id: "release-smoke", name: "codemode", arguments: {} }],
    api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} } });
  const tools = session.extensionRunner.createToolContext("release-smoke", undefined);
  const call = (name: string, args: unknown) => tools.executeTool(name, args);
  const question = await call("ask_user", { questions: [{ id: "release", title: "Release", question: "No interactive answer in print mode." }] });
  assert.equal(question.isError, false);
  assert.match(JSON.stringify(question), /unavailable/);
  const missingAgent = await call("task", { agent: "missing-release-agent", task: "Do not contact a provider." });
  assert.equal(missingAgent.isError, true);
  assert.match(JSON.stringify(missingAgent), /Unknown subagent/);
  const note = { action: "save", id: "release-test", title: "Release check", summary: "Isolated installation works", content: "A fixture note created by the package smoke check." };
  assert.equal((await call("project_memory", note)).isError, false);
  assert.match(JSON.stringify(await call("project_memory", { action: "read", id: note.id })), /fixture note/);
  await session.prompt("/prompt session Keep answers short.");
  await session.prompt("/theme light");
  await session.prompt("/color green");
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "pi-extended", "appearance.json"), "utf8")), { mode: "light", color: "green" });
  writeFileSync(join(cwd, "sample.txt"), "original");
  await session.prompt("/mode code");
  assert.ok(session.getActiveToolNames().includes("codemode"));
  assert.ok(session.getActiveToolNames().includes("read"));
  await session.prompt("/mode auto");
  assert.equal(session.getActiveToolNames().includes("codemode"), false);
  await session.prompt("/plan start");
  assert.equal((await call("write", { path: "sample.txt", content: "blocked" })).isError, true);
  assert.equal((await call("read", { path: "sample.txt" })).isError, false);
  const planResult = await call("update_plan", { goal: "Check release", steps: [{ text: "Verify artifact", status: "pending" }], areas: ["package"], checks: ["Smoke check"] });
  assert.equal(planResult.isError, false, JSON.stringify(planResult));
  manager.appendCompaction("Fixture summary", null, 10000);
  const prompt = await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "Continue" }, session.extensionRunner.createCommandContext().getSystemPromptOptions());
  assert.match(prompt.systemPromptOptions.sections.pi_extended_memory, /release-test/);
  assert.match(prompt.systemPromptOptions.sections.pi_extended_plan, /Check release/);
  assert.match(prompt.systemPromptOptions.sections.pi_extended_prompt, /Keep answers short/);
  assert.match(prompt.systemPromptOptions.sections.pi_extended_agents, /release-agent: Isolated release fixture/);
  assert.match(prompt.systemPromptOptions.sections.pi_extended_agents, /scout:/);
  assert.match(prompt.systemPromptOptions.sections.pi_extended_agents, /lens:/);
  assert.ok(!prompt.systemPromptOptions.sections.pi_extended_agents.includes(agentStore.find("scout")!.prompt));
  assert.equal(settingsManager.getCompactionSettings().enabled, true);
  const sessionFile = present(manager.getSessionFile()); assert.ok(existsSync(sessionFile));
  session.dispose();
  // A restarted Pi loads fresh extension factories; disposed SDK contexts cannot be reused.
  await loader.reload();
  const reopened = SessionManager.open(sessionFile);
  ({ session: resumed } = await createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: reopened }));
  await resumed.bindExtensions({ mode: "print" });
  const restored = await resumed.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "Continue" }, resumed.extensionRunner.createCommandContext().getSystemPromptOptions());
  assert.match(restored.systemPromptOptions.sections.pi_extended_plan, /Check release/);
  assert.match(restored.systemPromptOptions.sections.pi_extended_prompt, /Keep answers short/);
  assert.match(restored.systemPromptOptions.sections.pi_extended_memory, /release-test/);
  assert.match(restored.systemPromptOptions.sections.pi_extended_agents, /release-agent: Isolated release fixture/);
  assert.match(restored.systemPromptOptions.sections.pi_extended_agents, /scout:/);
  assert.match(restored.systemPromptOptions.sections.pi_extended_agents, /lens:/);
  await resumed.prompt("/agents delete release-agent");
  assert.equal(agentStore.find("release-agent"), undefined);
  await resumed.prompt("/plan cancel");
  await resumed.prompt("/permissions read-only");
  assert.ok(reopened.getEntries().some((entry) => entry.type === "custom" && entry.customType === "pi-extended-permissions" && (entry.data as {mode?:string}).mode === "read-only"));
  assert.equal(readFileSync(join(cwd, "sample.txt"), "utf8"), "original");
  console.log("Installed package: commands, agents, code mode, memory, plan barrier, compaction and disk resume passed.");
} finally { session.dispose(); resumed?.dispose(); }
