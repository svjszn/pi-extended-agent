import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, SessionShutdownEvent, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import type { SubagentRequest, SubagentResult } from "../lib/subagent.js";

const { default: agents } = await import(new URL("../dist/extensions/agents.js", import.meta.url).href) as typeof import("../extensions/agents.js");
const { AgentStore } = await import(new URL("../dist/lib/agents.js", import.meta.url).href) as typeof import("../lib/agents.js");
const { PERMISSIONS_CHANGED, PERMISSIONS_ENTRY } = await import(new URL("../dist/lib/permissions.js", import.meta.url).href) as typeof import("../lib/permissions.js");
const { PLAN_CHANGED } = await import(new URL("../dist/lib/plan.js", import.meta.url).href) as typeof import("../lib/plan.js");

function fixture(t: TestContext, runner: typeof import("../lib/subagent.js").runSubagent, mode: "rpc" | "tui" = "rpc") {
  const base = resolve(".local/agents-extension-tests"); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "case-")), agentDir = join(cwd, "profile");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
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
  } as unknown as ExtensionAPI, runner);
  const entries: { type: string; customType: string; data: { mode: string } }[] = [];
  const notices: string[] = [];
  const noticeTypes: string[] = [];
  const ctx = {
    cwd, mode, hasUI: true, signal: undefined,
    sessionManager: { getEntries: () => entries }, isProjectTrusted: () => true,
    ui: { notify: (text: string, type: string) => { notices.push(text); noticeTypes.push(type); }, confirm: async () => true,
      onTerminalInput(handler: TerminalInputHandler) { input = handler; return () => { input = undefined; }; },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, events, entries, notices, noticeTypes, listeners,
    task: () => task.execute("task-fixture", { agent: "researcher", task: "inspect" }, undefined, undefined, ctx as unknown as ExtensionToolContext),
    input: (data: string) => input?.(data), hasInput: () => input !== undefined,
    run: (args = "run researcher inspect") => commands.get("agents")!.handler(args, ctx),
    shutdown: (reason: SessionShutdownEvent["reason"]) => shutdown({ type: "session_shutdown", reason }),
  };
}

const cancelled: SubagentResult = { report: "", toolCalls: 0, blocked: [], aborted: true };

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
    assert.equal(host.listeners.get(PERMISSIONS_CHANGED)!.size, 0);
  });
});

test("manual subagents stop on Esc and Ctrl+C without exiting or changing the editor draft", async (t) => {
  for (const key of ["\x1b", "\x1b[27u", "\x03"]) await t.test(JSON.stringify(key), async (t) => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const host = fixture(t, async (request) => {
      started(); await new Promise<void>((resolve) => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return cancelled;
    }, "tui");
    const pending = host.run(); await ready;
    assert.equal(host.input("ordinary typing"), undefined);
    assert.deepEqual(host.input(key), { consume: true });
    await pending;
    assert.equal(host.hasInput(), false);
    assert.ok(host.notices.some((text) => /cancelled/.test(text)));
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
  assert.ok(!host.notices.some((text) => /finished|No report\./.test(text)));
  assert.equal(host.listeners.get(PERMISSIONS_CHANGED)!.size, 0);
});
