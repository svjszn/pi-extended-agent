import { modelFixture } from "./helpers.ts";
import { present } from "./helpers.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const { parseUsage, parseClaudeUsage, fetchUsage } = await import(new URL("../dist/lib/usage.js", import.meta.url).href) as typeof import("../lib/usage.js");
const { readActivity, activitySummary, dayKey } = await import(new URL("../dist/lib/activity.js", import.meta.url).href) as typeof import("../lib/activity.js");
const { configSections } = await import(new URL("../dist/lib/config.js", import.meta.url).href) as typeof import("../lib/config.js");
const { createCommandPanel } = await import(new URL("../dist/ui/command-panel.js", import.meta.url).href) as typeof import("../ui/command-panel.js");
const { usageLines, activityLines, configLines } = await import(new URL("../dist/ui/command-views.js", import.meta.url).href) as typeof import("../ui/command-views.js");
const { createUiTheme } = await import(new URL("../dist/ui/theme.js", import.meta.url).href) as typeof import("../ui/theme.js");
const { readStatus } = await import(new URL("../dist/lib/status.js", import.meta.url).href) as typeof import("../lib/status.js");
const { statusLines } = await import(new URL("../dist/ui/status-view.js", import.meta.url).href) as typeof import("../ui/status-view.js");

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
const theme: import("../ui/types.js").Palette = { bold: (s) => s, fg: (_color, s) => s };
const quota = { plan_type: "plus", rate_limit: {
  primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
  secondary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 120 },
} };
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
function usageContext() {
  return { model: { provider: "openai-codex", id: "test-model" }, modelRegistry: {
    isUsingOAuth: () => true, async getApiKeyAndHeaders() { return { ok: true, apiKey: token }; },
  } };
}

test("usage shows remaining percentages, actual windows, and missing data honestly", () => {
  const data = parseUsage(quota, 10_000);
  assert.deepEqual(data.limits, [
    { name: "5-hour limit", remaining: 75, resetsAt: 1_800_000_000_000 },
    { name: "Weekly limit", remaining: 0, resetsAt: 130_000 },
  ]);
  const weeklyOnly = parseUsage({ rate_limit: { primary_window: quota.rate_limit.secondary_window } });
  assert.equal(present(weeklyOnly.limits).length, 1);
  assert.equal(present(weeklyOnly.limits)[0].name, "Weekly limit");
  assert.throws(() => parseUsage({ rate_limit: { primary_window: {} } }), /did not return usage windows/);
  assert.throws(() => parseUsage(null), /invalid response/);
});

test("usage requests the account endpoint with host-resolved auth and no redirects", async () => {
  const data = await fetchUsage((usageContext() as unknown as Parameters<typeof fetchUsage>[0]), { async fetchImpl(url, options) {
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`);
    assert.equal((new Headers(options?.headers).get("chatgpt-account-id") ?? undefined), "test-account");
    assert.equal(present(options).redirect, "error");
    assert.ok(present(options).signal instanceof AbortSignal);
    return Response.json(quota);
  } });
  assert.equal(present(data.limits)[0].remaining, 75);
  assert.ok(!JSON.stringify(data).includes(token));
});

test("unsupported auth does not fetch quotas and failures never expose credentials", async () => {
  const context = usageContext();
  context.model.provider = "openai";
  context.modelRegistry.getApiKeyAndHeaders = () => assert.fail("must not resolve auth for unsupported providers");
  const data = await fetchUsage((context as unknown as Parameters<typeof fetchUsage>[0]), { fetchImpl: () => assert.fail("must not fetch unsupported quotas") });
  assert.match(present(data.unavailable), /not available/);
  await assert.rejects(fetchUsage((usageContext() as unknown as Parameters<typeof fetchUsage>[0]), { fetchImpl: async () => new Response(null, {status: 401}) }), /sign-in expired/);
  await assert.rejects(fetchUsage((usageContext() as unknown as Parameters<typeof fetchUsage>[0]), { fetchImpl: async () => { throw new TypeError(token); } }),
    (error) => error instanceof Error && /Check your connection/.test(error.message) && !error.message.includes(token));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchUsage((usageContext() as unknown as Parameters<typeof fetchUsage>[0]), { signal: controller.signal, fetchImpl: async (_url, init) => {
    present(init?.signal).throwIfAborted();
    throw new Error("Expected cancellation");
  } }), /cancelled or timed out/);
});

const fixtureRoot = resolve(fileURLToPath(new URL("../.local/command-tests", import.meta.url)));
function fixture(t: TestContext) {
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(join(fixtureRoot, "profile-"));
  t.after(() => {
    assert.ok(resolve(directory).startsWith(fixtureRoot + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const prompt = (id: string, date: Date, role: "user" | "assistant" | "toolResult" = "user") => ({ type: "message" as const, id, parentId: null, timestamp: date.toISOString(), message: role === "assistant" ? {role: "assistant" as const,content:[{type:"text" as const,text:"test"}],timestamp:date.getTime(),api:"openai-responses",provider:"fixture",model:"fixture",stopReason:"stop" as const,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}} : role === "user" ? {role: "user" as const, content: "test", timestamp: date.getTime()} : {role: "toolResult" as const, content: [{type:"text" as const,text:"test"}],timestamp:date.getTime(),toolName:"read",toolCallId:"fixture",isError:false} });

test("activity counts local prompts once across forks, custom directories, and unflushed entries", async (t) => {
  const directory = fixture(t);
  const now = new Date(2026, 9, 29, 12), yesterday = new Date(2026, 9, 28, 12);
  const old = new Date(2025, 9, 29, 12), future = new Date(2026, 9, 30, 12);
  const sessionDir = join(directory, "sessions", "project");
  const custom = join(directory, "custom");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(custom);
  const original = [prompt("one", now), prompt("yesterday", yesterday), prompt("old", old), prompt("future", future), prompt("tool", now, "toolResult")];
  const file = join(sessionDir, "original.jsonl");
  const contents = original.map((value) => JSON.stringify(value)).join("\n") + '\n{"partial"';
  writeFileSync(file, contents);
  writeFileSync(join(sessionDir, "fork.jsonl"), original.map((value) => JSON.stringify(value)).join("\n"));
  writeFileSync(join(custom, "custom.jsonl"), JSON.stringify(prompt("custom", now)));
  const data = await readActivity({ agentDir: directory, now, sessionManager: {
    getSessionDir: () => custom, getEntries: () => [prompt("one", now), prompt("unflushed", now)],
  } as unknown as NonNullable<Parameters<typeof readActivity>[0]["sessionManager"]> });
  assert.equal(data.total, 4);
  assert.equal(data.activeDays, 2);
  assert.equal(data.streak, 2);
  assert.equal(present(data.days.at(-1)).count, 3);
  assert.equal(present(data.days.at(-1)).key, dayKey(now));
  assert.equal(data.days.length, 365);
  assert.equal(readFileSync(file, "utf8"), contents);
});

test("activity handles an empty profile, yesterday's streak, and cancellation", async (t) => {
  const directory = fixture(t);
  const now = new Date(2026, 9, 29, 12);
  const data = await readActivity({ agentDir: directory, now });
  assert.equal(data.total, 0);
  assert.equal(data.streak, 0);
  assert.equal(activitySummary(new Map([["2026-10-28", 1]]), now).streak, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readActivity({ agentDir: directory, signal: controller.signal }), { name: "AbortError" });
});

test("config distinguishes live choices from saved preferences and excludes secret fields", () => {
  const context = { model: { provider: "openai-codex", id: "live-model" }, ui: { theme: { name: "light" } },
    isProjectTrusted: () => false, sessionManager: { getSessionFile: () => undefined } };
  const preferences = { defaultModel: "saved-model", theme: "dark", apiKey: "secret-key", custom: "private-config", compaction: { enabled: false } };
  const sections = configSections(context as unknown as Parameters<typeof configSections>[0],
    { getThinkingLevel: () => "high", getActiveTools: () => ["read", "edit"] } as unknown as Parameters<typeof configSections>[1],
    SettingsManager.inMemory(preferences), { agentDir: "profile", globalPath: "global.json", projectPath: "project.json", tuiMode: "fullscreen", version: "1.4.0" });
  const output = configLines(sections, 72, theme).join("\n");
  assert.match(output, /openai-codex\/live-model/);
  assert.match(output, /Effort\s+high/);
  assert.match(output, /Theme\s+light/);
  assert.match(output, /Auto compact\s+Off/);
  assert.match(output, /untrusted; ignored/);
  assert.doesNotMatch(output, /secret-key|private-config|saved-model/);
});

test("command panels fit resized terminals, scroll with native keys, and close on Escape", async () => {
  const now = new Date(2026, 9, 29, 12);
  type Shared = Pick<Parameters<typeof createCommandPanel>[0], "title" | "tui" | "theme" | "measure" | "done">;
  const view = <T>(renderBody: Parameters<typeof createCommandPanel<T>>[0]["renderBody"], data: T, config = false) => ({ config,
    create: (options: Shared) => createCommandPanel({ ...options, load: async () => data, renderBody }),
  });
  const views = [view(usageLines, parseUsage(quota)), view(activityLines, activitySummary(new Map([[dayKey(now), 12]]), now)),
    view(configLines, [{ title: "Settings", rows: Array.from({ length: 30 }, (_, i): [string,string] => [`Row ${i}`, "Long setting value with spaces and a path /some/project/folder"]) }], true)];
  for (const item of views) {
    const tui = { terminal: { rows: 24 }, requestRender() {} };
    let closed = 0;
    const panel = item.create({ title: "View", tui, theme: createUiTheme(), measure, done: () => closed++ });
    await panel.ready;
    for (const [width, rows] of [[72, 24], [24, 12], [12, 9], [1, 4], [80, 30]]) {
      tui.terminal.rows = rows;
      const lines = panel.render(width);
      assert.equal(lines.length, rows);
      assert.ok(lines.every((line) => measure.visibleWidth(line) <= width));
      assert.doesNotMatch(lines.join("\n"), /[╭╮╰╯│]/);
      if (width >= 24 && rows >= 8) {
        assert.match(measure.stripTerminalSequences(present(lines.at(-3))), /^❯ esc to close/);
        assert.equal(measure.stripTerminalSequences(present(lines.at(-4))), "─".repeat(width));
      }
    }
    panel.handleInput("\x1b[F"); // End
    if (item.config) assert.match(panel.render(80).join("\n"), /Row 29/);
    panel.handleInput("\x1b");
    panel.handleInput("\x1b");
    assert.equal(closed, 1);
    panel.dispose();
  }
});

test("closing a loading panel cancels its request without waiting for the network", async () => {
  let signal!: AbortSignal, closed = 0;
  const panel = createCommandPanel({ title: "Usage", tui: { terminal: { rows: 24 }, requestRender() {} }, theme, measure,
    done: () => closed++, renderBody: () => ["Loaded"], load: (value) => {
      signal = value;
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true }));
    },
  });
  assert.match(panel.render(72).join("\n"), /Loading/);
  await Promise.resolve();
  panel.handleInput("\x1b");
  assert.equal(signal.aborted, true);
  assert.equal(closed, 1);
  await panel.ready;
});

test("Claude usage uses Anthropic OAuth only, without ChatGPT headers or labels", async () => {
  const raw = { five_hour: { utilization: 10, resets_at: "2026-11-01T12:00:00Z" },
    seven_day: { utilization: 75, resets_at: null }, seven_day_sonnet: { utilization: 0, resets_at: "invalid" } };
  assert.deepEqual(present(parseClaudeUsage(raw).limits).map((limit) => limit.remaining), [90, 25, 100]);
  assert.equal(present(parseClaudeUsage(raw).limits)[2].resetsAt, null);
  assert.throws(() => parseClaudeUsage({}), /did not return usage windows/);
  const ctx = usageContext();
  ctx.model.provider = "anthropic";
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-claude-oauth" });
  const data = await fetchUsage((ctx as unknown as Parameters<typeof fetchUsage>[0]), { async fetchImpl(url, options) {
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test-claude-oauth");
    assert.equal(new Headers(options?.headers).get("anthropic-beta"), "oauth-2025-04-20");
    assert.equal((new Headers(options?.headers).get("chatgpt-account-id") ?? undefined), undefined);
    return Response.json(raw);
  } });
  assert.equal(data.provider, "Claude");
  assert.doesNotMatch(usageLines(data, 76, theme, measure).join("\n"), /ChatGPT/);
  ctx.modelRegistry.isUsingOAuth = () => false;
  const apiKeyData = await fetchUsage((ctx as unknown as Parameters<typeof fetchUsage>[0]), { fetchImpl: () => assert.fail("API keys must not call OAuth usage") });
  assert.match(present(apiKeyData.unavailable), /API billing/);
  assert.equal(apiKeyData.provider, "Claude");
});

test("activity periods aggregate recorded tokens and session spans without counting copied history twice", async (t) => {
  const directory = fixture(t);
  const sessionDir = join(directory, "sessions", "project");
  mkdirSync(sessionDir, { recursive: true });
  const now = new Date(2026, 9, 29, 20);
  const old = new Date(2026, 8, 10, 12), recent = new Date(2026, 9, 28, 12), today = new Date(2026, 9, 29, 12);
  const response = (id: string, date: Date, model: string, input: number, output: number, cacheRead: number) => ({ ...prompt(id, date, "assistant"), message: {
    role: "assistant", timestamp: date.getTime() + 60000, model,
    usage: { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, reasoning: 7 },
  } });
  const entries = [prompt("old", old), response("old-reply", old, "claude-sonnet-5", 10, 20, 30),
    prompt("recent", recent), response("recent-reply", recent, "gpt-6.1-sol", 100, 25, 1000),
    prompt("today", today), response("today-reply", today, "gpt-6.1-sol", 100, 50, 200),
    { type: "compaction", id: "summary", timestamp: today.toISOString(), usage: { input: 5, output: 1, totalTokens: 6 } }];
  writeFileSync(join(sessionDir, "a.jsonl"), [{ type: "session", id: "source", timestamp: new Date(2026, 8, 1).toISOString() }, ...entries].map((value) => JSON.stringify(value)).join("\n"));
  writeFileSync(join(sessionDir, "fork.jsonl"), [{ type: "session", id: "fork", timestamp: new Date(2026, 9, 29, 18).toISOString() }, ...entries].map((value) => JSON.stringify(value)).join("\n"));
  const data = await readActivity({ agentDir: directory, now });
  assert.equal(present(data.periods).all.prompts, 3);
  assert.equal(present(data.periods).all.totalTokens, 1541);
  assert.equal(present(data.periods).week.totalTokens, 1481);
  assert.equal(present(data.periods).month.totalTokens, 1481);
  assert.equal(present(data.periods).all.output, 96);
  assert.equal(present(data.periods).all.sessions, 1);
  assert.equal(present(data.periods).all.favoriteModel, "gpt-6.1-sol");
  assert.equal(present(data.periods).all.mostActiveDay, "2026-10-28");
  assert.equal(present(data.periods).all.longestStreak, 2);
  assert.equal(present(data.periods).all.streak, 2);
  assert.ok(present(data.periods).all.longestSession > 40 * 86400000);
});

test("activity period keys update the screen and the close hint stays in the input row", async () => {
  const selected: string[] = [];
  const panel = createCommandPanel({ title: "Activity", tui: { terminal: { rows: 24 }, requestRender() {} }, theme, measure,
    done() {}, periods: ["all", "week", "month"], load: () => ({}),
    renderHeader: () => ["  Pi logo", "  Model"], renderBody: (_data, _width, _theme, _measure, { period }) => {
      selected.push(period);
      return ["Body content"];
    },
  });
  await panel.ready;
  let lines = panel.render(80);
  assert.equal(lines[1].trim(), "Pi logo");
  assert.equal(lines[4].trim(), "Activity");
  assert.equal(lines[6].indexOf("Body content"), 2);
  assert.equal(lines[21].trim(), "❯ esc to close");
  panel.handleInput("\t"); panel.render(80);
  panel.handleInput("\x1b[D"); panel.render(80);
  panel.handleInput("\x1b[Z"); panel.render(80);
  assert.deepEqual(selected, ["all", "week", "all", "month"]);
  panel.dispose();
});

function statusFixture() {
  const sessionManager = SessionManager.inMemory("/project");
  sessionManager.getSessionId = () => "session-123"; sessionManager.appendSessionInfo("Status test");
  const ctx = { cwd: "/project", model: modelFixture({provider:"openai-codex",id:"gpt-6.1-sol"}) as import("@earendil-works/pi-ai").Model<"openai-responses"> | undefined,
    sessionManager, isProjectTrusted: () => false,
    modelRegistry: { getProviderDisplayName: () => "ChatGPT", getProviderAuthStatus: (): {configured:boolean;label?:string} => ({ configured: true, label: "secret-key" }),
      isUsingOAuth: () => true, getApiKeyAndHeaders: () => assert.fail("status must not resolve credentials") } };
  const pi = { getThinkingLevel: () => "medium", getActiveTools: () => ["read", "edit"], getAllTools: (): {name:string;namespace?:{name:string;aliases:string[]}}[] => [], getMcpServers: (): {name:string;config:{enabled?:boolean}}[] => [] };
  const options = { version: "1.4.0", agentDir: "/profile", packageDir: "/engine" };
  return { ctx, pi: pi as unknown as Parameters<typeof readStatus>[1], options };
}

test("status reports engine, session, login method, model, and tools without resolving secrets", async () => {
  const { ctx, pi, options } = statusFixture();
  const data = await readStatus((ctx as unknown as Parameters<typeof readStatus>[0]), pi, options, { loadMcpConfig: async () => ({ servers: [] }) });
  assert.equal(data.version, "1.4.0");
  assert.equal(data.sessionId, "session-123");
  assert.equal(data.sessionName, "Status test");
  assert.equal(data.login, "ChatGPT · OAuth configured");
  assert.equal(data.model, "gpt-6.1-sol");
  assert.deepEqual(data.tools, ["read", "edit"]);
  const output = statusLines(data, 76, createUiTheme({ color: false }), measure).join("\n");
  for (const label of ["Version:", "Session ID:", "Session name:", "Login:", "Model:", "MCP Servers:", "Tools:"]) assert.ok(output.includes(label));
  assert.match(output, /Session ID:[^\n]*\nSession name:\s+Status test\nLogin:/);
  assert.doesNotMatch(output, /secret-key/);
  assert.match(output, /Login:[^\n]*\n\nModel:/);
  assert.doesNotMatch(output, /medium effort|openai-codex/);
  ctx.modelRegistry.isUsingOAuth = () => false;
  assert.match((await readStatus((ctx as unknown as Parameters<typeof readStatus>[0]), pi, options, { loadMcpConfig: async () => undefined })).login, /API credentials configured/);
  ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: false });
  assert.match((await readStatus((ctx as unknown as Parameters<typeof readStatus>[0]), pi, options, { loadMcpConfig: async () => undefined })).login, /not configured/);
});

test("status reads the current native session name after naming and renaming, with an unnamed fallback", async () => {
  const { ctx, pi, options } = statusFixture();
  ctx.sessionManager = SessionManager.inMemory(process.cwd());
  const services = { loadMcpConfig: async () => undefined };
  const unnamed = await readStatus((ctx as unknown as Parameters<typeof readStatus>[0]), pi, options, services);
  assert.equal(unnamed.sessionName, "Not set");
  assert.match(statusLines(unnamed, 80, theme, measure).join("\n"), /Session name:\s+Not set/);
  for (const name of ["Первый чат", "Renamed chat", "Long session name ".repeat(15).trim()]) {
    ctx.sessionManager.appendSessionInfo(name);
    const data = await readStatus((ctx as unknown as Parameters<typeof readStatus>[0]), pi, options, services);
    assert.equal(data.sessionName, name);
    for (const width of [24, 40, 80]) {
      const lines = statusLines(data, width, theme, measure);
      assert.ok(lines.every((line) => measure.visibleWidth(line) <= width));
      const id = lines.findIndex((line) => line.startsWith("Session ID:"));
      const sessionName = lines.findIndex((line) => line.startsWith("Session name:"));
      const login = lines.findIndex((line) => line.startsWith("Login:"));
      assert.ok(id < sessionName && sessionName < login);
    }
  }
});

test("status combines MCP metadata and registered namespaces without claiming a live connection", async () => {
  const { ctx, pi, options } = statusFixture();
  pi.getMcpServers = () => [{ name: "docs", config: { enabled: true } }, { name: "custom", config: {} }];
  pi.getAllTools = () => [
    { name: "mcp__docs__lookup", description:"Fixture",parameters:{},exposure:"direct",sourceInfo:{source:"local",scope:"user",origin:"top-level",path:"fixture"} },
    { name: "mcp__my_server__search", description:"Fixture",parameters:{},exposure:"direct",sourceInfo:{source:"local",scope:"user",origin:"top-level",path:"fixture"}, namespace: { name: "mcp__my_server", aliases: ["my-server"] } },
    { name: "read", description:"Fixture",parameters:{},exposure:"direct",sourceInfo:{source:"builtin",scope:"user",origin:"top-level",path:"builtin:read"} },
  ];
  const data = await readStatus((ctx as unknown as Parameters<typeof readStatus>[0]), pi, options, { loadMcpConfig: async (input) => {
    assert.equal(input.projectTrusted, false);
    return { servers: [{ name: "docs", config: { enabled: false } }, { name: "my-server", config: {} }] };
  } });
  assert.deepEqual(data.mcp, [{ name: "custom", enabled: true, tools: 0 }, { name: "docs", enabled: false, tools: 1 }, { name: "my-server", enabled: true, tools: 1 }]);
  const output = statusLines(data, 80, theme, measure).join("\n");
  assert.match(output, /docs \(disabled\)/);
  assert.match(output, /my-server \(1 tool\s+registered\)/);
  assert.doesNotMatch(output, /connected/);
  const failed = await readStatus((ctx as unknown as Parameters<typeof readStatus>[0]), pi, options, { loadMcpConfig: async () => { throw new Error("secret-config"); } });
  assert.equal(failed.mcpConfigError, true);
  assert.doesNotMatch(statusLines(failed, 80, theme, measure).join("\n"), /secret-config/);
});

test("status handles no selected model and remains usable on narrow terminals", async () => {
  const { ctx, pi, options } = statusFixture();
  ctx.model = undefined;
  const data = await readStatus((ctx as unknown as Parameters<typeof readStatus>[0]), pi, options, { loadMcpConfig: async () => undefined });
  assert.equal(data.login, "No model selected");
  assert.equal(data.mcpConfigKnown, false);
  const panel = createCommandPanel({ title: "Status", tui: { terminal: { rows: 24 }, requestRender() {} }, theme, measure,
    done() {}, load: () => data, renderBody: statusLines });
  await panel.ready;
  for (const width of [1, 8, 24, 40, 80, 140]) assert.ok(panel.render(width).every((line) => measure.visibleWidth(line) <= width));
  panel.dispose();
});

test("statistics and session status register as separate commands", async () => {
  const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    "@earendil-works/pi-coding-agent": fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  } });
  const factory = await jiti.import(fileURLToPath(new URL("../dist/extensions/commands.js", import.meta.url)), { default: true });
  const commands = new Map();
  factory({ registerCommand: ((name, command) => commands.set(name, command)) satisfies ExtensionAPI["registerCommand"] });
  assert.match(commands.get("stats").description, /activity calendar/);
  assert.match(commands.get("status").description, /version, session, login, model/);
});
