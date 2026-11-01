import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import permissions from "../dist/extensions/permissions.js";
import { permissionDecision, permissionRequest, readPermissionMode, PERMISSIONS_ENTRY } from "../dist/lib/permissions.js";
import { createPermissionApprovalScreen } from "../dist/ui/permissions-screen.js";
import { createUiTheme } from "../dist/ui/theme.js";
import { createFooter } from "../dist/ui/chrome.js";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
const tools = ["read", "find", "grep", "ls", "edit", "write", "bash", "powershell"].map((name) => ({
  name, sourceInfo: { path: `builtin:${name}`, source: "builtin" },
}));
const event = (name) => ({ type: "tool_call", toolName: name, toolCallId: "test", input: { path: "sample.txt" } });
function fixture(entries = []) {
  const handlers = new Map(), notices = [], stored = [...entries], bus = [];
  let command;
  const pi = {
    on: (name, handler) => handlers.set(name, handler), registerCommand: (_name, handler) => { command = handler; },
    getAllTools: () => tools, getThinkingLevel: () => "medium",
    appendEntry: (customType, data) => stored.push({ type: "custom", customType, data }),
    events: { emit: (name, data) => bus.push({ name, data }) },
  };
  permissions(pi);
  const ctx = { mode: "print", cwd: "/project", hasUI: false, sessionManager: { getEntries: () => stored },
    ui: { notify: (message, type) => notices.push({ message, type }), confirm: async () => false } };
  handlers.get("session_start")({}, ctx);
  const set = async (mode) => { ctx.hasUI = true; await command.handler(mode, ctx); };
  return { pi, ctx, handlers, command, stored, notices, bus, set, call: (name) => handlers.get("tool_call")(event(name), ctx) };
}

test("permissions allow only known built-in readers, never shell strings or unverified read-only hints", () => {
  for (const name of ["read", "find", "grep", "ls"]) assert.equal(permissionDecision("read-only", name, tools), "allow");
  for (const name of ["edit", "write", "bash", "powershell", "mcp__fs__read", "codemode", "unknown"]) {
    assert.equal(permissionDecision("read-only", name, tools), "block");
    assert.equal(permissionDecision("ask", name, tools), "confirm");
    assert.equal(permissionDecision("full", name, tools), "allow");
  }
  const shadow = [{ name: "read", sourceInfo: { source: "local", path: "/extension.js" }, annotations: { readOnlyHint: true } }];
  assert.equal(permissionDecision("read-only", "read", shadow), "block");
});

test("mode changes persist only session metadata, restore on resume, and reject invalid arguments", async () => {
  const f = fixture();
  assert.equal(await f.call("write"), undefined);
  await f.set("read-only");
  assert.equal((await f.call("write")).block, true);
  assert.equal(await f.call("read"), undefined);
  assert.equal(readPermissionMode(f.stored), "read-only");
  assert.deepEqual(f.stored[0], { type: "custom", customType: PERMISSIONS_ENTRY, data: { mode: "read-only" } });
  const resumed = fixture(f.stored);
  assert.equal((await resumed.call("bash")).block, true);
  await f.set("invalid");
  assert.equal(f.notices.at(-1).type, "error");
  assert.equal(f.stored.length, 1);
  assert.equal(readPermissionMode([]), "full");
  assert.equal(fixture().stored.length, 0);
});

test("ask mode gates mutations, fails closed without UI, and does not reuse one approval", async () => {
  const f = fixture(); await f.set("ask");
  let calls = 0, allow = true;
  f.ctx.ui.confirm = async () => { calls++; return allow; };
  assert.equal(await f.call("read"), undefined); assert.equal(calls, 0);
  assert.equal(await f.call("write"), undefined); assert.equal(calls, 1);
  allow = false;
  assert.equal((await f.call("write")).block, true); assert.equal(calls, 2);
  f.ctx.hasUI = false;
  assert.equal((await f.call("bash")).block, true); assert.equal(calls, 2);
});

test("concurrent calls are approved in order and a mode change cancels stale approvals", async () => {
  const f = fixture(); await f.set("ask");
  const pending = [];
  f.ctx.ui.confirm = (_title, _body, { signal }) => new Promise((resolve) => {
    pending.push(resolve); signal.addEventListener("abort", () => resolve(false), { once: true });
  });
  const first = f.call("write"), second = f.call("edit");
  await new Promise(setImmediate); assert.equal(pending.length, 1);
  pending[0](true); assert.equal(await first, undefined);
  await new Promise(setImmediate); assert.equal(pending.length, 2);
  await f.set("read-only");
  assert.equal((await second).block, true);
  assert.equal((await f.call("write")).block, true);
});

test("session shutdown cancels a pending TUI approval without letting the tool execute", async () => {
  const f = fixture(); await f.set("ask"); f.ctx.mode = "tui";
  let panel;
  f.ctx.ui.custom = (create) => new Promise((resolve) => {
    panel = create({ children: [], terminal: { rows: 24 }, requestRender() {} }, createUiTheme(), {}, resolve);
  });
  const task = f.call("write");
  await new Promise(setImmediate);
  assert.ok(panel); await panel.ready;
  assert.match(measure.stripTerminalSequences(panel.render(80).join("\n")), /Tool: write/);
  f.handlers.get("session_shutdown")();
  assert.equal((await task).block, true);
});

test("cancellation during lazy approval loading never opens a stale dialog", async () => {
  for (const cancel of ["shutdown", "mode", "tool"]) {
    const f = fixture(); await f.set("ask"); f.ctx.mode = "tui";
    const controller = new AbortController(); f.ctx.signal = controller.signal;
    let opened = 0;
    f.ctx.ui.custom = async () => { opened++; return true; };
    const task = f.call("write");
    // approve() begins in the queue's first microtask; cancel while imports await.
    queueMicrotask(() => {
      if (cancel === "shutdown") f.handlers.get("session_shutdown")();
      else if (cancel === "mode") void f.set("read-only");
      else controller.abort();
    });
    assert.equal((await task).block, true);
    assert.equal(opened, 0, cancel);
  }
});

test("permissions selector keeps changes pending until Enter and uses the shared screen layout", async () => {
  for (const cancel of [false, true]) {
    const f = fixture(); f.ctx.mode = "tui"; f.ctx.hasUI = true;
    f.ctx.ui.custom = async (create) => {
      let result;
      const tui = { children: [], terminal: { rows: 30 }, requestRender() {} };
      const panel = create(tui, createUiTheme(), {}, (value) => { result = value; });
      await panel.ready;
      assert.match(measure.stripTerminalSequences(panel.render(100).join("\n")), /Full access.*current/);
      panel.handleInput("\x1b[B");
      assert.equal(f.stored.length, 0);
      for (const [width, rows] of [[100, 30], [24, 12], [8, 8], [1, 4]]) {
        tui.terminal.rows = rows;
        const lines = panel.render(width); assert.equal(lines.length, rows);
        assert.ok(lines.every((line) => measure.visibleWidth(line) <= width));
      }
      panel.handleInput(cancel ? "\x1b" : "\r"); panel.dispose(); return result;
    };
    await f.command.handler("", f.ctx);
    assert.equal(readPermissionMode(f.stored), cancel ? "full" : "ask");
  }
});

test("approval screen defaults to denial, scrolls full input, and requires an explicit allow choice", async () => {
  for (const allow of [false, true]) {
    let result;
    const tui = { terminal: { rows: 24 }, requestRender() {} };
    const panel = createPermissionApprovalScreen({ tui, theme: createUiTheme(), measure,
      done: (value) => { result = value; }, lines: Array.from({ length: 60 }, (_, i) => `Line ${i}`) });
    await panel.ready; panel.render(80);
    panel.handleInput("\x1b[F");
    assert.match(measure.stripTerminalSequences(panel.render(80).join("\n")), /Line 59/);
    if (allow) panel.handleInput("\x1b[C");
    panel.handleInput("\r"); assert.equal(result, allow);
  }
});

test("approval text bounds a large tool input, keeps its fields visible, and states every truncation", () => {
  const long = "a".repeat(5_000);
  const text = permissionRequest("write", { path: "src/app.ts", content: long, nested: { note: long } }, "/work").join("\n");
  assert.match(text, /Tool: write/);
  assert.match(text, /Working directory: \/work/);
  assert.match(text, /"path": "src\/app\.ts"/);
  assert.match(text, /"nested": \{/);
  assert.ok(!text.includes("a".repeat(601)), "long values must be shortened");
  assert.match(text, /… \(5000 characters in total\)/);
  assert.ok(text.length < 4_300, `approval text stayed ${text.length} characters`);
  // Many medium fields hit the overall cap instead of the per-value one.
  const bulk = permissionRequest("write", Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, "b".repeat(500)])), "/work").join("\n");
  assert.ok(bulk.length < 4_300, `bulk approval text stayed ${bulk.length} characters`);
  assert.match(bulk, /… input truncated for display$/);
  // A small input is still shown exactly as the tool receives it.
  assert.match(permissionRequest("bash", { command: "ls -la" }, "/work").join("\n"), /"command": "ls -la"/);
});

test("footer reflects the permission mode and keeps context aligned", () => {
  let mode = "full";
  const footer = createFooter({}, {}, createUiTheme(), {}, measure,
    () => ({ tokens: 24000, contextWindow: 200000, percent: 12 }), () => mode);
  for (const [value, label] of [["full", "auto mode"], ["ask", "ask mode"], ["read-only", "read only"]]) {
    mode = value;
    for (const width of [8, 24, 80]) assert.ok(footer.render(width).every((line) => measure.visibleWidth(line) <= width));
    assert.match(measure.stripTerminalSequences(footer.render(80).join("\n")), new RegExp(label));
    assert.match(measure.stripTerminalSequences(footer.render(80).join("\n")), /12% context/);
  }
});

test("real Pi tool execution enforces permissions before file writes, shell, and nested calls", async (t) => {
  const base = resolve(".local/permission-tests"); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "project-"));
  t.after(() => { const target = resolve(cwd); assert.ok(target.startsWith(base + sep)); rmSync(target, { recursive: true, force: true }); });
  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "profile"), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [permissions],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "profile"), settingsManager, modelRuntime,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: ["read", "write", "edit", "bash", "powershell"] });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "print" });
  // Supply the parent tool-call message normally produced by a model, without
  // making a provider request. Pi requires it for the nested execution pipeline.
  session.agent.state.messages.push({ role: "assistant", content: [{ type: "toolCall", id: "permissions-test", name: "codemode", arguments: {} }],
    api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } });
  const run = session._extensionRunner.createToolContext("permissions-test");
  const call = (name, args) => run.executeTool(name, args);
  const written = await call("write", { path: "sample.txt", content: "original" });
  assert.equal(written.isError, false, JSON.stringify(written));
  await session.prompt("/permissions read-only");
  const read = await call("read", { path: "sample.txt" });
  assert.equal(read.isError, false, JSON.stringify(read));
  assert.equal((await call("write", { path: "sample.txt", content: "changed" })).isError, true);
  assert.equal((await call("edit", { path: "sample.txt", oldText: "original", newText: "changed" })).isError, true);
  assert.equal(readFileSync(join(cwd, "sample.txt"), "utf8"), "original");
  const shell = await call("bash", { command: "echo blocked > marker.txt" });
  assert.equal(shell.isError, true); assert.match(JSON.stringify(shell), /blocked in Read only/);
  const powerShell = await call("powershell", { command: "Set-Content marker.txt blocked" });
  assert.equal(powerShell.isError, true); assert.match(JSON.stringify(powerShell), /blocked in Read only/);
  assert.equal(existsSync(join(cwd, "marker.txt")), false);
  await session.prompt("/permissions ask");
  assert.equal((await call("write", { path: "sample.txt", content: "changed" })).isError, true);
  await session.prompt("/permissions full");
  assert.equal((await call("write", { path: "sample.txt", content: "allowed" })).isError, false);
  assert.equal(readFileSync(join(cwd, "sample.txt"), "utf8"), "allowed");
});
