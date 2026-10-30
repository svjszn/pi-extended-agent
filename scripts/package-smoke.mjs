// Run only against the npm artifact installed by release-check.mjs, never the checkout's modules.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installed, temp] = process.argv.slice(2);
assert.ok(installed && temp);
const { bundledRuntime } = await import(pathToFileURL(join(installed, "dist/bin/runtime.js")));
const runtime = bundledRuntime();
const api = await import(pathToFileURL(runtime.entry));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = api;
const { verifyRuntime } = await import(pathToFileURL(join(installed, "dist/bin/verify-runtime.js")));
await verifyRuntime(bundledRuntime(), installed);

const cwd = join(temp, "project"), agentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(agentDir, { recursive: true });
const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
  credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
const settingsManager = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
  noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [installed] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const manager = SessionManager.create(cwd, join(temp, "sessions"));
// A normal conversation entry causes Pi to persist setup/custom session metadata.
manager.appendMessage({ role: "user", content: "Local release smoke check", timestamp: Date.now() });
const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: manager });
let resumed;
try {
  await session.bindExtensions({ mode: "print" });
  const required = ["config", "model", "effort", "permissions", "memory", "plan", "prompt", "theme", "color"];
  const commands = session._extensionRunner.getRegisteredCommands().map((command) => command.name);
  for (const name of required.filter((name) => name !== "model")) assert.ok(commands.includes(name), `Missing /${name}`);
  session.agent.state.messages.push({ role: "assistant", content: [{ type: "toolCall", id: "release-smoke", name: "codemode", arguments: {} }],
    api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } });
  const tools = session._extensionRunner.createToolContext("release-smoke");
  const call = (name, args) => tools.executeTool(name, args);
  const note = { action: "save", id: "release-test", title: "Release check", summary: "Isolated installation works", content: "A fixture note created by the package smoke check." };
  assert.equal((await call("project_memory", note)).isError, false);
  assert.match(JSON.stringify(await call("project_memory", { action: "read", id: note.id })), /fixture note/);
  await session.prompt("/prompt session Keep answers short.");
  await session.prompt("/theme light");
  await session.prompt("/color green");
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "pi-extended", "appearance.json"), "utf8")), { mode: "light", color: "green" });
  writeFileSync(join(cwd, "sample.txt"), "original");
  await session.prompt("/plan start");
  assert.equal((await call("write", { path: "sample.txt", content: "blocked" })).isError, true);
  assert.equal((await call("read", { path: "sample.txt" })).isError, false);
  const planResult = await call("update_plan", { goal: "Check release", steps: [{ text: "Verify artifact", status: "pending" }], areas: ["package"], checks: ["Smoke check"] });
  assert.equal(planResult.isError, false, JSON.stringify(planResult));
  manager.appendCompaction("Fixture summary", null, 10000);
  const prompt = await session._extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "Continue" }, session._baseSystemPromptOptions);
  assert.match(prompt.systemPromptOptions.sections.pi_extended_memory, /release-test/);
  assert.match(prompt.systemPromptOptions.sections.pi_extended_plan, /Check release/);
  assert.match(prompt.systemPromptOptions.sections.pi_extended_prompt, /Keep answers short/);
  assert.equal(settingsManager.getCompactionSettings().enabled, true);
  const sessionFile = manager.getSessionFile(); assert.ok(existsSync(sessionFile));
  session.dispose();
  // A restarted Pi loads fresh extension factories; disposed SDK contexts cannot be reused.
  await loader.reload();
  const reopened = SessionManager.open(sessionFile);
  ({ session: resumed } = await createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: reopened }));
  await resumed.bindExtensions({ mode: "print" });
  const restored = await resumed._extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "Continue" }, resumed._baseSystemPromptOptions);
  assert.match(restored.systemPromptOptions.sections.pi_extended_plan, /Check release/);
  assert.match(restored.systemPromptOptions.sections.pi_extended_prompt, /Keep answers short/);
  assert.match(restored.systemPromptOptions.sections.pi_extended_memory, /release-test/);
  await resumed.prompt("/plan cancel");
  await resumed.prompt("/permissions read-only");
  assert.ok(reopened.getEntries().some((entry) => entry.customType === "pi-extended-permissions" && entry.data.mode === "read-only"));
  assert.equal(readFileSync(join(cwd, "sample.txt"), "utf8"), "original");
  console.log("Installed package: commands, memory, plan barrier, compaction and disk resume passed.");
} finally { session.dispose(); resumed?.dispose(); }
