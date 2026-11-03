import type { CustomUi, Panel } from "./helpers.ts";
import type { ExtensionCommandContext, ExtensionUIContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { present } from "./helpers.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const { default: permissions } = await import(new URL("../dist/extensions/permissions.js", import.meta.url).href) as typeof import("../extensions/permissions.js");
const { permissionDecision, permissionRequest, readPermissionMode, normalizePermissionMode, isPermissionMode, PERMISSION_MODES, PERMISSIONS_ENTRY } = await import(new URL("../dist/lib/permissions.js", import.meta.url).href) as typeof import("../lib/permissions.js");
const { createPermissionApprovalScreen } = await import(new URL("../dist/ui/permissions-screen.js", import.meta.url).href) as typeof import("../ui/permissions-screen.js");
const { createUiTheme } = await import(new URL("../dist/ui/theme.js", import.meta.url).href) as typeof import("../ui/theme.js");
const { createFooter } = await import(new URL("../dist/ui/chrome.js", import.meta.url).href) as typeof import("../ui/chrome.js");
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
const tools: Pick<ToolInfo, "name" | "sourceInfo">[] = ["read", "find", "grep", "ls", "edit", "write", "bash", "powershell"].map((name) => ({
  name, sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "user", origin: "top-level" },
}));
const event = (name: string) => ({ type: "tool_call", toolName: name, toolCallId: "test", input: { path: "sample.txt" } });
function fixture(entries: {type: string; customType: string; data: unknown}[] = []) {
  const handlers = new Map(), notices: {message:string;type?:string}[] = [], stored = [...entries], bus: {name:string;data:unknown}[] = [];
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const pi = {
    on: ((name, handler) => { handlers.set(name, handler); return () => {}; }) satisfies ExtensionAPI["on"], registerCommand: ((_name, handler) => { command = handler; }) satisfies ExtensionAPI["registerCommand"],
    getAllTools: () => tools, getThinkingLevel: () => "medium",
    appendEntry: (customType: string, data: unknown) => stored.push({ type: "custom", customType, data }),
    events: { emit: (name: string, data: unknown) => bus.push({ name, data }) },
  };
  permissions((pi as unknown as Parameters<typeof permissions>[0]));
  const ctx = { signal: undefined as AbortSignal | undefined, mode: "print", cwd: "/project", hasUI: false, sessionManager: { getEntries: () => stored },
    ui: { notify: (message: string, type?: string) => notices.push({ message, type }), custom: undefined as CustomUi | undefined, confirm: (async () => false) as ExtensionUIContext["confirm"] } };
  handlers.get("session_start")({}, ctx);
  const set = async (mode: string) => { ctx.hasUI = true; await command.handler(mode, ctx as unknown as ExtensionCommandContext); };
  return { pi, ctx, handlers, command, stored, notices, bus, set, call: (name: string, input: unknown = { path: "sample.txt" }) => handlers.get("tool_call")({ ...event(name), input }, ctx) };
}

test("permissions allow only known built-in readers, never shell strings or unverified read-only hints", () => {
  for (const name of ["read", "find", "grep", "ls"]) assert.equal(permissionDecision("deny", name, tools), "allow");
  for (const name of ["edit", "write", "bash", "powershell", "mcp__fs__read", "codemode", "unknown"]) {
    assert.equal(permissionDecision("deny", name, tools), "block");
    assert.equal(permissionDecision("ask", name, tools), "confirm");
    assert.equal(permissionDecision("allow", name, tools), "allow");
  }
  const shadow = [{ name: "read", sourceInfo: { source: "local", scope: "project" as const, origin: "top-level" as const, path: "/extension.js" }, annotations: { readOnlyHint: true } }];
  assert.equal(permissionDecision("deny", "read", shadow), "block");
});

test("mode changes persist only session metadata, restore on resume, and reject invalid arguments", async () => {
  const f = fixture();
  assert.equal(await f.call("write"), undefined);
  await f.set("deny");
  assert.equal((await f.call("write")).block, true);
  assert.equal(await f.call("read"), undefined);
  assert.equal(readPermissionMode(f.stored), "deny");
  assert.deepEqual(f.stored[0], { type: "custom", customType: PERMISSIONS_ENTRY, data: { mode: "deny" } });
  const resumed = fixture(f.stored);
  assert.equal((await resumed.call("bash")).block, true);
  await f.set("invalid");
  assert.equal(present(f.notices.at(-1)).type, "error");
  assert.equal(f.stored.length, 1);
  assert.equal(readPermissionMode([]), "allow");
  assert.equal(fixture().stored.length, 0);
});

test("legacy session modes restore the same policy without rewriting history", async () => {
  for (const [saved, expected] of [["full", "allow"], ["read-only", "deny"], ["allow", "allow"], ["ask", "ask"], ["deny", "deny"]] as const) {
    const entries = [{ type: "custom", customType: PERMISSIONS_ENTRY, data: { mode: saved } }];
    const f = fixture(entries);
    assert.equal(readPermissionMode(f.stored), expected);
    assert.equal(normalizePermissionMode(saved), expected);
    assert.equal(isPermissionMode(saved), PERMISSION_MODES.some(mode => mode === saved));
    assert.equal((await f.call("write"))?.block ?? false, expected !== "allow");
    assert.equal(await f.call("read"), undefined);
    assert.deepEqual(f.stored, entries, "restoring does not rewrite the legacy marker");
    assert.deepEqual(f.bus.at(-1)?.data, { mode: expected });
  }
  const entries = ["deny", "full", "read-only", "invalid"].map(mode => ({ type: "custom", customType: PERMISSIONS_ENTRY, data: { mode } }));
  assert.equal(readPermissionMode(entries), "deny", "the latest valid legacy marker wins over older canonical markers");
  entries.push({ type: "custom", customType: PERMISSIONS_ENTRY, data: { mode: "ask" } });
  assert.equal(readPermissionMode(entries), "ask");
  for (const invalid of [undefined, null, {}, "invalid"]) assert.equal(normalizePermissionMode(invalid), undefined);
});

test("commands offer canonical modes and save legacy aliases using their new names", async () => {
  const f = fixture();
  assert.deepEqual((await f.command.getArgumentCompletions?.(""))?.map(item => item.value), ["allow", "ask", "deny"]);
  assert.deepEqual((await f.command.getArgumentCompletions?.("d"))?.map(item => item.value), ["deny"]);
  for (const [command, expected] of [["read-only", "deny"], ["full", "allow"], [" ASK ", "ask"], ["DENY", "deny"], ["allow", "allow"]]) {
    await f.set(command);
    assert.deepEqual(f.stored.at(-1)?.data, { mode: expected });
    assert.deepEqual(f.bus.at(-1)?.data, { mode: expected });
    assert.equal((await f.call("write"))?.block ?? false, expected !== "allow");
  }
});

test("a failed policy read blocks tools until permissions initialize successfully", async () => {
  const f = fixture();
  const read = f.ctx.sessionManager.getEntries;
  f.ctx.sessionManager.getEntries = () => { throw new Error("Fixture policy read failed"); };
  assert.throws(() => f.handlers.get("session_start")({}, f.ctx), /Fixture policy read failed/);
  for (const name of ["read", "write", "bash"]) {
    const result = await f.call(name); assert.equal(result.block, true);
    assert.match(result.reason, /permissions.*initialized/i);
  }
  f.ctx.sessionManager.getEntries = read;
  f.handlers.get("session_start")({}, f.ctx);
  assert.equal(await f.call("write"), undefined);
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
  const pending: ((arg0: boolean) => void)[] = [];
  f.ctx.ui.confirm = (_title, _body, options) => new Promise<boolean>((resolve) => {
    pending.push(resolve); present(options?.signal).addEventListener("abort", () => resolve(false), { once: true });
  });
  const first = f.call("write"), second = f.call("edit");
  await new Promise(setImmediate); assert.equal(pending.length, 1);
  pending[0](true); assert.equal(await first, undefined);
  await new Promise(setImmediate); assert.equal(pending.length, 2);
  await f.set("deny");
  assert.equal((await second).block, true);
  assert.equal((await f.call("write")).block, true);
});

test("session shutdown cancels a pending TUI approval without letting the tool execute", async () => {
  const f = fixture(); await f.set("ask"); f.ctx.mode = "tui";
  let panel!: Panel;
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
      else if (cancel === "mode") void f.set("deny");
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
      assert.match(measure.stripTerminalSequences(panel.render(100).join("\n")), /Allow.*current/);
      panel.handleInput("\x1b[B");
      assert.equal(f.stored.length, 0);
      for (const [width, rows] of [[100, 30], [24, 12], [8, 8], [1, 4]]) {
        tui.terminal.rows = rows;
        const lines = panel.render(width); assert.equal(lines.length, rows);
        assert.ok(lines.every((line: string) => measure.visibleWidth(line) <= width));
      }
      panel.handleInput(cancel ? "\x1b" : "\r"); panel.dispose(); return result;
    };
    await present(f.command).handler("", f.ctx as unknown as ExtensionCommandContext);
    assert.equal(readPermissionMode(f.stored), cancel ? "allow" : "ask");
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

test("approval pages retain complete input, including long values, later fields and Unicode", () => {
  const long = "a".repeat(5_000);
  const input = { path: "src/app.ts", content: long, nested: { note: long }, unicode: "😀".repeat(5_000), tail: "FINAL_FIELD" };
  const request = permissionRequest("write", input, "/work");
  assert.equal(request.error, undefined);
  assert.deepEqual(request.header, ["Tool: write", "Working directory: /work"]);
  assert.ok(request.pages.length > 1);
  assert.ok(request.pages.every(page => page.length <= 4_000 && !/[\uD800-\uDBFF]$/.test(page)));
  assert.deepEqual(JSON.parse(request.pages.join("")), input);
  const bulk = { ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, "b".repeat(500)])), tail: "FINAL_FIELD" };
  assert.deepEqual(JSON.parse(permissionRequest("write", bulk, "/work").pages.join("")), bulk);
  assert.deepEqual(JSON.parse(permissionRequest("bash", { command: "ls -la" }, "/work").pages.join("")), { command: "ls -la" });
});

test("unreviewable inputs are denied before opening any approval UI", async () => {
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  for (const mode of ["print", "tui"]) for (const input of [{ content: "x".repeat(300_000) }, { content: "\n".repeat(150_000) }, cyclic]) {
    const f = fixture(); await f.set("ask"); f.ctx.mode = mode;
    f.ctx.ui.confirm = async () => assert.fail("Unreviewable input cannot be approved");
    f.ctx.ui.custom = async () => assert.fail("Unreviewable input cannot be approved");
    assert.equal((await f.call("write", input)).block, true);
    assert.match(present(f.notices.at(-1)).message, /Cannot review the complete tool input/);
    assert.equal(permissionRequest("write", input, "/work").pages.length, 0);
  }
});

test("RPC approvals receive complete input rather than a shortened command", async () => {
  const f = fixture(); await f.set("ask");
  const command = "echo safe " + "x".repeat(9_000) + "; echo REVIEW_TAIL";
  f.ctx.ui.confirm = async (_title, text) => {
    assert.match(text, /REVIEW_TAIL/);
    assert.equal(JSON.parse(text.slice(text.indexOf("{"))).command, command);
    return true;
  };
  assert.equal(await f.call("bash", { command }), undefined);
});

test("the actual approval dialog exposes command tails across bounded pages and preserves explicit consent", async () => {
  for (const allow of [false, true]) {
    const f = fixture(); await f.set("ask"); f.ctx.mode = "tui";
    const command = "echo safe " + "x".repeat(9_000) + "; echo REVIEW_TAIL";
    f.ctx.ui.custom = async create => {
      let result;
      const tui = { children: [], terminal: { rows: 24 }, requestRender() {} };
      const panel = create(tui, createUiTheme(), {}, value => { result = value; });
      try {
        await panel.ready;
        const text = () => measure.stripTerminalSequences(panel.render(80).join("\n"));
        assert.match(text(), /page 1\/3/);
        panel.handleInput("\x1b[6~"); assert.match(text(), /page 2\/3/);
        panel.handleInput("\x1b[5~"); assert.match(text(), /page 1\/3/);
        panel.handleInput("\x1b[F"); assert.match(text(), /REVIEW_TAIL/);
        for (const [width, rows] of [[80, 24], [24, 12], [8, 8], [1, 4]]) {
          tui.terminal.rows = rows;
          const lines = panel.render(width);
          assert.equal(lines.length, rows); assert.ok(lines.every(line => measure.visibleWidth(line) <= width));
        }
        if (allow) panel.handleInput("\x1b[C");
        panel.handleInput("\r"); return result;
      } finally { panel.dispose(); }
    };
    const result = await f.call("powershell", { command });
    assert.equal(!result?.block, allow);
  }
});

test("footer reflects the permission mode and keeps context aligned", () => {
  let mode = "allow";
  const footer = createFooter({}, {}, createUiTheme(), {}, measure,
    () => ({ tokens: 24000, contextWindow: 200000, percent: 12, source: "pi", afterCompaction: false }), () => mode as import("../lib/permissions.js").PermissionMode);
  for (const [value, label] of [["allow", "allow mode"], ["ask", "ask mode"], ["deny", "deny mode"]]) {
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
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input:0,output:0,cacheRead:0,cacheWrite:0,total:0} } });
  const run = session.extensionRunner.createToolContext("permissions-test", undefined);
  const call = (name: string, args: { path?: string; content?: string; oldText?: string; newText?: string; command?: string; }) => run.executeTool(name, args);
  const written = await call("write", { path: "sample.txt", content: "original" });
  assert.equal(written.isError, false, JSON.stringify(written));
  await session.prompt("/permissions deny");
  const read = await call("read", { path: "sample.txt" });
  assert.equal(read.isError, false, JSON.stringify(read));
  assert.equal((await call("write", { path: "sample.txt", content: "changed" })).isError, true);
  assert.equal((await call("edit", { path: "sample.txt", oldText: "original", newText: "changed" })).isError, true);
  assert.equal(readFileSync(join(cwd, "sample.txt"), "utf8"), "original");
  const shell = await call("bash", { command: "echo blocked > marker.txt" });
  assert.equal(shell.isError, true); assert.match(JSON.stringify(shell), /blocked in Deny/);
  const powerShell = await call("powershell", { command: "Set-Content marker.txt blocked" });
  assert.equal(powerShell.isError, true); assert.match(JSON.stringify(powerShell), /blocked in Deny/);
  assert.equal(existsSync(join(cwd, "marker.txt")), false);
  await session.prompt("/permissions ask");
  assert.equal((await call("write", { path: "sample.txt", content: "changed" })).isError, true);
  await session.prompt("/permissions allow");
  assert.equal((await call("write", { path: "sample.txt", content: "allowed" })).isError, false);
  assert.equal(readFileSync(join(cwd, "sample.txt"), "utf8"), "allowed");
});
