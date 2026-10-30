import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import workspace from "../dist/extensions/workspace.js";
import permissions from "../dist/extensions/permissions.js";
import { projectIdentity, projectFiles, StateFiles } from "../dist/lib/project-state.js";
import { MemoryStore, memoryPrompt } from "../dist/lib/memory.js";
import { PlanStore, renderPlan, parsePlan, PLAN_ENTRY, PLAN_TOGGLE } from "../dist/lib/plan.js";
import { PromptStore, sessionPrompt } from "../dist/lib/prompt.js";
import { isWorkspaceBookkeeping } from "../dist/lib/workspace-tools.js";
import { readPermissionMode } from "../dist/lib/permissions.js";
import { createWorkspaceScreen, createWorkspaceEditor } from "../dist/ui/workspace-screen.js";
import { createUiTheme } from "../dist/ui/theme.js";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
function directory(t) {
  const base = resolve(".local/workspace-tests"); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "project-"));
  t.after(() => { const path = resolve(cwd); assert.ok(path.startsWith(base + sep)); rmSync(path, { recursive: true, force: true }); });
  return cwd;
}
const emptyPlan = { version: 1, status: "planning", goal: "Build feature", steps: [], areas: [], checks: [], updatedAt: "" };
const note = { id: "preferences", title: "User preferences", summary: "Use concise Russian replies", content: "The user prefers concise replies in Russian.\nDetails loaded only on demand." };
function fixture(t, options = {}) {
  const cwd = options.cwd ?? directory(t), agentDir = join(cwd, "profile");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const handlers = new Map(), commands = new Map(), tools = new Map(), entries = options.entries ?? [], sent = [], notices = [];
  const listeners = new Map();
  let active = ["read", "write", "edit", "bash", "project_memory", "update_plan"];
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool), appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: (text, options) => sent.push({ text, options }), events: {
      emit(name, data) { for (const fn of listeners.get(name) ?? []) fn(data); },
      on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
    }, getThinkingLevel: () => "medium",
    getActiveTools: () => active, setActiveTools: (names) => { active = names; },
    getAllTools: () => [
      ...["read", "find", "grep", "ls", "write", "edit", "bash"].map((name) => ({ name, sourceInfo: { source: "builtin", path: `builtin:${name}` } })),
      ...["project_memory", "update_plan"].map((name) => ({ name, sourceInfo: { source: "local", path: fileURLToPath(new URL("../dist/extensions/workspace.js", import.meta.url)) } })),
    ],
  };
  const ctx = { cwd, mode: "print", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => options.sessionId ?? "session-one", getEntries: () => entries },
    getSystemPrompt: () => "Native baseline", getSystemPromptOptions: () => ({ cwd, contextFiles: [], skills: [] }),
    ui: { notify: (text, type) => notices.push({ text, type }), editor: async (_title, text) => text },
  };
  workspace(pi); handlers.get("session_start")({}, ctx);
  return { cwd, agentDir, pi, ctx, entries, sent, notices, handlers, commands, tools,
    command: (name, args = "") => commands.get(name).handler(args, ctx),
    tool: (name, args) => tools.get(name).execute("test", args, undefined, undefined, ctx),
    call: (name, input = {}) => handlers.get("tool_call")({ toolName: name, input }, ctx),
    store: new MemoryStore(projectFiles(cwd, agentDir)),
  };
}

test("project state shares Git worktree identity while isolating repositories and ordinary directories", (t) => {
  const cwd = directory(t), repo = join(cwd, "repo"), worktree = join(cwd, "worktree");
  mkdirSync(join(repo, ".git/worktrees/branch"), { recursive: true }); mkdirSync(join(repo, "src")); mkdirSync(worktree);
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git/worktrees/branch")}\n`);
  writeFileSync(join(repo, ".git/worktrees/branch/commondir"), "../..\n");
  assert.equal(projectIdentity(repo).key, projectIdentity(worktree).key);
  assert.equal(projectIdentity(repo).key, projectIdentity(join(repo, "src")).key);
  assert.notEqual(projectIdentity(cwd).key, projectIdentity(repo).key);
  const first = new MemoryStore(projectFiles(repo, join(cwd, "profile")));
  first.save(note);
  assert.equal(new MemoryStore(projectFiles(worktree, join(cwd, "profile"))).read(note.id).content, note.content);
});

test("memory upserts persistent topics, keeps details out of the index, and disables context without deleting notes", (t) => {
  const files = new StateFiles(join(directory(t), "state")), memory = new MemoryStore(files);
  memory.save(note); memory.save({ ...note, summary: "Updated preference" });
  const resumed = new MemoryStore(files);
  assert.equal(resumed.list().length, 1); assert.equal(resumed.read(note.id).summary, "Updated preference");
  assert.match(files.read("memory/MEMORY.md"), /Updated preference/);
  assert.doesNotMatch(memoryPrompt(resumed), /Details loaded only on demand/);
  resumed.enabled = false;
  assert.doesNotMatch(memoryPrompt(resumed), /Updated preference/);
  assert.equal(resumed.list().length, 1);
  resumed.enabled = true; resumed.delete(note.id); assert.equal(resumed.list().length, 0);
});

test("memory reserves the index id without changing saved notes or the index", (t) => {
  const files = new StateFiles(join(directory(t), "state")), memory = new MemoryStore(files);
  memory.save(note);
  const index = files.read("memory/MEMORY.md");
  for (const id of ["memory", "MEMORY", "Memory"]) {
    assert.throws(() => memory.save({ ...note, id }), /reserved for the index/);
    assert.throws(() => memory.read(id), /reserved for the index/);
    assert.throws(() => memory.delete(id), /reserved for the index/);
    assert.equal(files.read("memory/MEMORY.md"), index);
    assert.equal(memory.read(note.id).content, note.content);
  }
  memory.save({ ...note, id: "project-memory" });
  assert.equal(memory.read("project-memory").content, note.content);
});

test("memory rejects traversal, secrets, oversized notes and an unbounded index", (t) => {
  const memory = new MemoryStore(new StateFiles(join(directory(t), "state")));
  for (const id of ["../escape", "a/b", "..", "MEMORY", "a\\b"]) assert.throws(() => memory.save({ ...note, id }));
  assert.throws(() => memory.save({ ...note, content: "api_key=supersecretvalue123" }), /credentials/);
  assert.throws(() => memory.save({ ...note, content: "я".repeat(7000) }), /12000 bytes/);
  for (let i = 0; i < 32; i++) memory.save({ ...note, id: `topic-${i}` });
  assert.throws(() => memory.save({ ...note, id: "overflow" }), /limit reached/);
  memory.save({ ...note, id: "topic-0", content: "Updated" });
  assert.ok(Buffer.byteLength(memory.index()) < 8000);
});

test("app state rejects symbolic link redirection into other directories", (t) => {
  const cwd = directory(t), outside = join(cwd, "outside"), state = join(cwd, "state");
  mkdirSync(outside); mkdirSync(state);
  symlinkSync(outside, join(state, "memory"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => new MemoryStore(new StateFiles(state)).save(note), /symbolic links/);
  assert.equal(existsSync(join(outside, "preferences.md")), false);
});

test("prompt scopes persist independently and compose without replacing the Pi baseline or duplicating hooks", async (t) => {
  const f = fixture(t);
  await f.command("prompt", "global Be direct."); await f.command("prompt", "project Use npm."); await f.command("prompt", "session Reply in Russian.");
  assert.equal(sessionPrompt(f.entries), "Reply in Russian.");
  const prompts = new PromptStore(projectFiles(f.cwd, f.agentDir), f.agentDir);
  assert.equal(prompts.read("global"), "Be direct."); assert.equal(prompts.read("project"), "Use npm.");
  f.store.save(note);
  for (let i = 0; i < 2; i++) {
    const event = { systemPrompt: "Native baseline", systemPromptOptions: { sections: { inherited: "Existing instructions" } } };
    const response = await f.handlers.get("before_agent_start")(event, f.ctx);
    assert.equal(response, undefined); assert.equal(event.systemPrompt, "Native baseline");
    assert.equal(event.systemPromptOptions.sections.inherited, "Existing instructions");
    assert.equal(event.systemPromptOptions.sections.pi_extended_prompt.match(/Use npm/g).length, 1);
    assert.match(event.systemPromptOptions.sections.pi_extended_memory, /preferences/);
    assert.doesNotMatch(event.systemPromptOptions.sections.pi_extended_memory, /Details loaded only on demand/);
  }
  await f.command("memory", "off");
  const event = { systemPrompt: "Native", systemPromptOptions: { sections: {} } };
  f.handlers.get("before_agent_start")(event, f.ctx);
  assert.doesNotMatch(event.systemPromptOptions.sections.pi_extended_memory, /Use concise/);
  await assert.rejects(f.tool("project_memory", { action: "read", id: note.id }), /disabled/);
});

test("plan barrier blocks every mutation and shell, persists on resume, and execution needs explicit user approval", async (t) => {
  const f = fixture(t);
  await f.command("plan", "start");
  assert.equal(await f.call("read"), undefined);
  for (const name of ["write", "edit", "bash", "external-read", "codemode"]) assert.equal((await f.call(name)).block, true);
  assert.equal(await f.call("update_plan"), undefined);
  assert.equal((await f.call("project_memory", { action: "save" })).block, true);
  assert.equal(await f.call("project_memory", { action: "read" }), undefined);
  assert.equal(f.handlers.get("user_bash")({}, f.ctx).result.exitCode, 1);
  const proposal = { goal: "Add feature", steps: [{ text: "Inspect code", status: "in_progress" }, { text: "Implement and test", status: "pending" }], areas: ["lib"], checks: ["npm test"] };
  await f.tool("update_plan", proposal);
  assert.equal(f.entries.at(-1).data.status, "ready"); assert.equal(f.entries.at(-1).data.steps[0].status, "pending");
  const store = new PlanStore(projectFiles(f.cwd, f.agentDir), "session-one");
  assert.equal(store.read().status, "ready");
  // Reload reads the plan from disk, independent of compacted messages.
  await f.handlers.get("session_start")({}, f.ctx);
  assert.equal((await f.call("write")).block, true);
  assert.equal(f.sent.length, 0);
  await f.command("plan", "execute");
  assert.equal(store.read().status, "executing"); assert.equal(await f.call("write"), undefined);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /approved plan/);
  await assert.rejects(f.tool("update_plan", { goal: "Do something else" }), /approved plan changed/);
  await f.tool("update_plan", { steps: proposal.steps.map((s) => ({ ...s, status: "completed" })) });
  assert.equal(store.read().status, "completed");
});

test("mode shortcut pauses and restores the draft without executing, changing permissions, or duplicating on reload", async (t) => {
  const f = fixture(t);
  const originalTools = [...f.pi.getActiveTools()];
  f.pi.events.emit(PLAN_TOGGLE);
  assert.equal((await f.call("write")).block, true);
  await f.tool("update_plan", { goal: "Keep this draft", steps: [{ text: "Inspect project", status: "pending" }] });
  f.pi.events.emit(PLAN_TOGGLE);
  assert.equal(f.entries.at(-1).data.status, "paused");
  assert.equal(await f.call("write"), undefined);
  assert.deepEqual(f.pi.getActiveTools(), originalTools);
  await assert.rejects(f.tool("update_plan", {}), /No active plan/);
  const event = { systemPrompt: "Native", systemPromptOptions: { sections: {} } };
  f.handlers.get("before_agent_start")(event, f.ctx);
  assert.equal(event.systemPromptOptions.sections.pi_extended_plan, undefined);
  // One key press must cause one toggle after a session reload.
  f.handlers.get("session_start")({}, f.ctx);
  f.pi.events.emit(PLAN_TOGGLE);
  assert.equal(f.entries.at(-1).data.status, "ready");
  assert.equal(f.entries.at(-1).data.goal, "Keep this draft");
  assert.equal((await f.call("write")).block, true);
  assert.equal(f.sent.length, 0);
  assert.equal(readPermissionMode(f.entries), "full");
  f.ctx.isIdle = () => false; f.pi.events.emit(PLAN_TOGGLE);
  assert.equal(f.entries.at(-1).data.status, "ready");
  f.ctx.isIdle = () => true; f.ctx.hasPendingMessages = () => true; f.pi.events.emit(PLAN_TOGGLE);
  assert.equal(f.entries.at(-1).data.status, "ready");
  f.ctx.hasPendingMessages = () => false; f.pi.events.emit(PLAN_TOGGLE);
  assert.equal(f.entries.at(-1).data.status, "paused");
  await f.command("plan", "execute");
  assert.equal(f.entries.at(-1).data.status, "executing");
  assert.equal(f.sent.length, 1);
  f.handlers.get("session_shutdown")();
  const count = f.entries.length; f.pi.events.emit(PLAN_TOGGLE); assert.equal(f.entries.length, count);
});

test("plan cannot be approved by a tool, invalid plans stay blocked, and cancellation recovers a missing plan", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.tool("update_plan", { goal: "Unrequested" }), /Only the user/);
  await f.command("plan", "start"); await f.command("plan", "execute"); assert.equal(f.sent.length, 0);
  assert.equal((await f.call("write")).block, true);
  await assert.rejects(f.tool("update_plan", { steps: [{ text: "a", status: "in_progress" }, { text: "b", status: "in_progress" }] }), /Only one/);
  const files = projectFiles(f.cwd, f.agentDir), store = new PlanStore(files, "session-one");
  files.remove(store.name); f.handlers.get("session_start")({}, f.ctx);
  assert.equal((await f.call("write")).block, true);
  await f.command("plan", "cancel");
  assert.equal(await f.call("write"), undefined); assert.equal(store.read().status, "cancelled");
  f.ctx.isIdle = () => false; await f.command("plan", "start");
  assert.equal(store.read().status, "cancelled"); assert.match(f.notices.at(-1).text, /Wait for the current run/);
});

test("plan Markdown editing preserves goals, steps, areas and checks while validating statuses", (t) => {
  const store = new PlanStore(new StateFiles(join(directory(t), "state")), "arbitrary/session/id");
  const plan = store.save({ ...emptyPlan, status: "ready", steps: [{ text: "Read", status: "pending" }], areas: ["src"], checks: ["Build"] });
  assert.deepEqual(parsePlan(renderPlan(plan), plan), plan);
  assert.equal(parsePlan(renderPlan(plan).replace("- [ ] Read", "- [~] Read"), plan).steps[0].status, "in_progress");
  assert.throws(() => parsePlan(renderPlan(plan).replace("- [ ] Read", "- [?] Read"), plan), /Use -/);
});

test("workspace viewers and editors keep the shared frame, document newlines, save and cancellation", async () => {
  const tui = { terminal: { rows: 30 }, requestRender() {} }, theme = createUiTheme();
  let action, saved;
  const options = { title: "Memory", tui, theme, measure, done() {}, renderHeader: () => ["Header"], renderFooter: () => ["auto mode"] };
  const panel = createWorkspaceScreen({ ...options, pages: [{ label: "Index", lines: () => ["First"] }, { label: "Topic", lines: () => ["Second"] }],
    hint: "tab topics · e edit · esc close", actions: { e: "edit" }, onAction: (value, page) => { action = { value, page }; } });
  await panel.ready;
  panel.handleInput("\t"); assert.match(measure.stripTerminalSequences(panel.render(80).join("\n")), /Second/);
  for (const [width, rows] of [[80, 30], [24, 12], [8, 8], [1, 4]]) {
    tui.terminal.rows = rows;
    const lines = panel.render(width); assert.equal(lines.length, rows); assert.ok(lines.every((l) => measure.visibleWidth(l) <= width));
  }
  panel.handleInput("e"); assert.deepEqual(action, { value: "edit", page: 1 });
  const editor = createWorkspaceEditor({ ...options, text: "", onSave: (text) => { saved = text; } });
  await editor.ready; editor.handleInput("a"); editor.handleInput("\r"); editor.handleInput("b"); editor.handleInput("\x13");
  assert.equal(saved, "a\nb");
  const longEditor = createWorkspaceEditor({ ...options, text: Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n"), onSave() {} });
  await longEditor.ready;
  for (const [width, rows] of [[80, 30], [24, 12], [8, 8], [1, 4]]) {
    tui.terminal.rows = rows;
    const lines = longEditor.render(width); assert.equal(lines.length, rows);
    assert.ok(lines.every((l) => measure.visibleWidth(l) <= width));
    if (width >= 8) assert.ok(lines.some((l) => l.includes(measure.CURSOR_MARKER)), `Cursor missing at ${width} x ${rows}`);
  }
  longEditor.dispose();
  saved = undefined;
  const cancelled = createWorkspaceEditor({ ...options, text: "original", onSave: (text) => { saved = text; } });
  await cancelled.ready; cancelled.handleInput("x"); cancelled.handleInput("\x1b"); assert.equal(saved, undefined);
});

test("real Pi hooks gate nested tools during planning without changing existing permissions", async (t) => {
  const cwd = directory(t), agentDir = join(cwd, "profile");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../dist/extensions/workspace.js", import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [permissions] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd), tools: ["read", "find", "grep", "ls", "write", "edit", "bash", "powershell", "project_memory", "update_plan"] });
  t.after(() => session.dispose()); await session.bindExtensions({ mode: "print" });
  assert.ok(session.getAllTools().some((tool) => tool.name === "update_plan"), JSON.stringify({ extensions: loader.getExtensions().extensions.map((e) => ({ path: e.path, tools: [...e.tools.keys()] })), tools: session.getAllTools().map((t) => t.name) }));
  const sent = []; session.sendUserMessage = async (content) => { sent.push(content); };
  session.setActiveToolsByName(["read", "write", "edit", "bash", "powershell", "project_memory", "update_plan"]);
  session.agent.state.messages.push({ role: "assistant", content: [{ type: "toolCall", id: "workspace-test", name: "codemode", arguments: {} }],
    api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } });
  const run = session._extensionRunner.createToolContext("workspace-test"), call = (name, args) => run.executeTool(name, args);
  writeFileSync(join(cwd, "sample.txt"), "original");
  for (const mode of ["full", "ask", "read-only"]) {
    await session.prompt(`/permissions ${mode}`); await session.prompt("/plan start");
    assert.ok(session.getActiveToolNames().includes("ls"));
    // Interactive and RPC shell entry points emit this hook before executeBash.
    const intercepted = await session._extensionRunner.emitUserBash({ type: "user_bash", command: "echo blocked > marker.txt", cwd, excludeFromContext: false });
    const userShell = intercepted?.result ?? await session.executeBash("echo blocked > marker.txt");
    assert.equal(userShell.exitCode, 1); assert.match(userShell.output, /Plan mode blocks shell/);
    assert.equal((await call("read", { path: "sample.txt" })).isError, false);
    for (const [name, args] of [["write", { path: "sample.txt", content: "changed" }], ["edit", { path: "sample.txt", oldText: "original", newText: "changed" }],
      ["bash", { command: "echo changed > marker.txt" }], ["powershell", { command: "Set-Content marker.txt changed" }]]) {
      const outcome = await call(name, args); assert.equal(outcome.isError, true, JSON.stringify(outcome)); assert.match(JSON.stringify(outcome), /Plan mode/);
    }
    const saved = await call("update_plan", { goal: "Make change", steps: [{ text: "Update sample", status: "pending" }], areas: ["sample.txt"], checks: ["Read result"] });
    assert.equal(saved.isError, false, JSON.stringify(saved));
    await session.prompt("/prompt session Reply in Russian.");
    session.sessionManager.appendCompaction("Compacted conversation", null, 5000);
    const injected = await session._extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "Continue" }, session._baseSystemPromptOptions);
    assert.match(injected.systemPromptOptions.sections.pi_extended_plan, /Make change/);
    assert.match(injected.systemPromptOptions.sections.pi_extended_prompt, /Reply in Russian/);
    assert.ok(injected.systemPromptOptions.sections.pi_extended_memory);
    assert.equal(session.settingsManager.getCompactionSettings().enabled, true);
    assert.equal((await call("update_plan", {})).isError, false);
    const reads = await call("project_memory", { action: "list" }); assert.equal(reads.isError, false, JSON.stringify(reads));
    await session.prompt("/plan execute");
    assert.equal(session.getActiveToolNames().includes("ls"), false);
    assert.equal(readPermissionMode(session.sessionManager.getEntries()), mode);
    const write = await call("write", { path: "allowed.txt", content: "allowed" });
    assert.equal(write.isError, mode !== "full");
    await session.prompt("/plan cancel");
  }
  assert.equal(sent.length, 3); assert.equal(existsSync(join(cwd, "marker.txt")), false);
  assert.equal(readFileSync(join(cwd, "sample.txt"), "utf8"), "original");
  await session.prompt("/permissions full");
  const saved = await call("project_memory", { action: "save", ...note }); assert.equal(saved.isError, false, JSON.stringify(saved));
  const read = await call("project_memory", { action: "read", id: note.id }); assert.equal(read.isError, false, JSON.stringify(read));
  assert.match(JSON.stringify(read), /Details loaded only on demand/);
  // /prompt uses the active engine's own renderer for the unchanged native baseline.
  const beforePreview = session.agent.state.messages.length;
  const preview = [], originalError = console.error;
  try { console.error = (message) => preview.push(String(message)); await session.prompt("/prompt"); }
  finally { console.error = originalError; }
  assert.match(preview.join("\n"), /expert coding assistant/);
  assert.match(preview.join("\n"), /Use concise Russian replies/);
  assert.equal(session.agent.state.messages.length, beforePreview);
  assert.equal(isWorkspaceBookkeeping("project_memory", { action: "read" }, [{ name: "project_memory", sourceInfo: { path: "/external.js" } }]), false);
});
