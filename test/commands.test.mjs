import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { parseUsage, parseClaudeUsage, fetchUsage } from "../dist/lib/usage.js";
import { readActivity, activitySummary, dayKey } from "../dist/lib/activity.js";
import { configSections } from "../dist/lib/config.js";
import { createCommandPanel } from "../dist/ui/command-panel.js";
import { usageLines, activityLines, configLines } from "../dist/ui/command-views.js";
import { createUiTheme } from "../dist/ui/theme.js";
import { readStatus } from "../dist/lib/status.js";
import { statusLines } from "../dist/ui/status-view.js";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
const theme = { bold: (s) => s, fg: (_color, s) => s };
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
  assert.equal(weeklyOnly.limits.length, 1);
  assert.equal(weeklyOnly.limits[0].name, "Weekly limit");
  assert.throws(() => parseUsage({ rate_limit: { primary_window: {} } }), /did not return usage windows/);
  assert.throws(() => parseUsage(null), /invalid response/);
});

test("usage requests the account endpoint with host-resolved auth and no redirects", async () => {
  const data = await fetchUsage(usageContext(), { async fetchImpl(url, options) {
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.headers["chatgpt-account-id"], "test-account");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, async json() { return quota; } };
  } });
  assert.equal(data.limits[0].remaining, 75);
  assert.ok(!JSON.stringify(data).includes(token));
});

test("unsupported auth does not fetch quotas and failures never expose credentials", async () => {
  const context = usageContext();
  context.model.provider = "openai";
  context.modelRegistry.getApiKeyAndHeaders = () => assert.fail("must not resolve auth for unsupported providers");
  const data = await fetchUsage(context, { fetchImpl: () => assert.fail("must not fetch unsupported quotas") });
  assert.match(data.unavailable, /not available/);
  await assert.rejects(fetchUsage(usageContext(), { fetchImpl: async () => ({ ok: false, status: 401 }) }), /sign-in expired/);
  await assert.rejects(fetchUsage(usageContext(), { fetchImpl: async () => { throw new TypeError(token); } }),
    (error) => /Check your connection/.test(error.message) && !error.message.includes(token));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchUsage(usageContext(), { signal: controller.signal, fetchImpl: async (_url, { signal }) => {
    signal.throwIfAborted();
  } }), /cancelled or timed out/);
});

const fixtureRoot = resolve(fileURLToPath(new URL("../.local/command-tests", import.meta.url)));
function fixture(t) {
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(join(fixtureRoot, "profile-"));
  t.after(() => {
    assert.ok(resolve(directory).startsWith(fixtureRoot + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const prompt = (id, date, role = "user") => ({ type: "message", id, timestamp: date.toISOString(), message: { role, content: "test", timestamp: date.getTime() } });

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
  const contents = original.map(JSON.stringify).join("\n") + '\n{"partial"';
  writeFileSync(file, contents);
  writeFileSync(join(sessionDir, "fork.jsonl"), original.map(JSON.stringify).join("\n"));
  writeFileSync(join(custom, "custom.jsonl"), JSON.stringify(prompt("custom", now)));
  const data = await readActivity({ agentDir: directory, now, sessionManager: {
    getSessionDir: () => custom, getEntries: () => [prompt("one", now), prompt("unflushed", now)],
  } });
  assert.equal(data.total, 4);
  assert.equal(data.activeDays, 2);
  assert.equal(data.streak, 2);
  assert.equal(data.days.at(-1).count, 3);
  assert.equal(data.days.at(-1).key, dayKey(now));
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
  const sections = configSections({
    model: { provider: "openai-codex", id: "live-model" }, ui: { theme: { name: "light" } },
    isProjectTrusted: () => false, sessionManager: { getSessionFile: () => undefined },
  }, { getThinkingLevel: () => "high", getActiveTools: () => ["read", "edit"] }, SettingsManager.inMemory({
    defaultModel: "saved-model", theme: "dark", apiKey: "secret-key", custom: "private-config", compaction: { enabled: false },
  }), { agentDir: "profile", globalPath: "global.json", projectPath: "project.json", tuiMode: "fullscreen", version: "1.4.0" });
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
  const views = [[usageLines, parseUsage(quota)], [activityLines, activitySummary(new Map([[dayKey(now), 12]]), now)],
    [configLines, [{ title: "Settings", rows: Array.from({ length: 30 }, (_, i) => [`Row ${i}`, "Long setting value with spaces and a path /some/project/folder"]) }]]];
  for (const [renderBody, data] of views) {
    const tui = { terminal: { rows: 24 }, requestRender() {} };
    let closed = 0;
    const panel = createCommandPanel({ title: "View", tui, theme: createUiTheme(), measure, done: () => closed++, load: async () => data, renderBody });
    await panel.ready;
    for (const [width, rows] of [[72, 24], [24, 12], [12, 9], [1, 4], [80, 30]]) {
      tui.terminal.rows = rows;
      const lines = panel.render(width);
      assert.equal(lines.length, rows);
      assert.ok(lines.every((line) => measure.visibleWidth(line) <= width));
      assert.doesNotMatch(lines.join("\n"), /[╭╮╰╯│]/);
      if (width >= 24 && rows >= 8) {
        assert.match(measure.stripTerminalSequences(lines.at(-3)), /^❯ esc to close/);
        assert.equal(measure.stripTerminalSequences(lines.at(-4)), "─".repeat(width));
      }
    }
    panel.handleInput("\x1b[F"); // End
    if (renderBody === configLines) assert.match(panel.render(80).join("\n"), /Row 29/);
    panel.handleInput("\x1b");
    panel.handleInput("\x1b");
    assert.equal(closed, 1);
    panel.dispose();
  }
});

test("closing a loading panel cancels its request without waiting for the network", async () => {
  let signal, closed = 0;
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
  assert.deepEqual(parseClaudeUsage(raw).limits.map((limit) => limit.remaining), [90, 25, 100]);
  assert.equal(parseClaudeUsage(raw).limits[2].resetsAt, null);
  assert.throws(() => parseClaudeUsage({}), /did not return usage windows/);
  const ctx = usageContext();
  ctx.model.provider = "anthropic";
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-claude-oauth" });
  const data = await fetchUsage(ctx, { async fetchImpl(url, options) {
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(options.headers.authorization, "Bearer test-claude-oauth");
    assert.equal(options.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(options.headers["chatgpt-account-id"], undefined);
    return { ok: true, async json() { return raw; } };
  } });
  assert.equal(data.provider, "Claude");
  assert.doesNotMatch(usageLines(data, 76, theme, measure).join("\n"), /ChatGPT/);
  ctx.modelRegistry.isUsingOAuth = () => false;
  const apiKeyData = await fetchUsage(ctx, { fetchImpl: () => assert.fail("API keys must not call OAuth usage") });
  assert.match(apiKeyData.unavailable, /API billing/);
  assert.equal(apiKeyData.provider, "Claude");
});

test("activity periods aggregate recorded tokens and session spans without counting copied history twice", async (t) => {
  const directory = fixture(t);
  const sessionDir = join(directory, "sessions", "project");
  mkdirSync(sessionDir, { recursive: true });
  const now = new Date(2026, 9, 29, 20);
  const old = new Date(2026, 8, 10, 12), recent = new Date(2026, 9, 28, 12), today = new Date(2026, 9, 29, 12);
  const response = (id, date, model, input, output, cacheRead) => ({ ...prompt(id, date, "assistant"), message: {
    role: "assistant", timestamp: date.getTime() + 60000, model,
    usage: { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, reasoning: 7 },
  } });
  const entries = [prompt("old", old), response("old-reply", old, "claude-sonnet-5", 10, 20, 30),
    prompt("recent", recent), response("recent-reply", recent, "gpt-6.1-sol", 100, 25, 1000),
    prompt("today", today), response("today-reply", today, "gpt-6.1-sol", 100, 50, 200),
    { type: "compaction", id: "summary", timestamp: today.toISOString(), usage: { input: 5, output: 1, totalTokens: 6 } }];
  writeFileSync(join(sessionDir, "a.jsonl"), [{ type: "session", id: "source", timestamp: new Date(2026, 8, 1).toISOString() }, ...entries].map(JSON.stringify).join("\n"));
  writeFileSync(join(sessionDir, "fork.jsonl"), [{ type: "session", id: "fork", timestamp: new Date(2026, 9, 29, 18).toISOString() }, ...entries].map(JSON.stringify).join("\n"));
  const data = await readActivity({ agentDir: directory, now });
  assert.equal(data.periods.all.prompts, 3);
  assert.equal(data.periods.all.totalTokens, 1541);
  assert.equal(data.periods.week.totalTokens, 1481);
  assert.equal(data.periods.month.totalTokens, 1481);
  assert.equal(data.periods.all.output, 96);
  assert.equal(data.periods.all.sessions, 1);
  assert.equal(data.periods.all.favoriteModel, "gpt-6.1-sol");
  assert.equal(data.periods.all.mostActiveDay, "2026-10-28");
  assert.equal(data.periods.all.longestStreak, 2);
  assert.equal(data.periods.all.streak, 2);
  assert.ok(data.periods.all.longestSession > 40 * 86400000);
});

test("activity period keys update the screen and the close hint stays in the input row", async () => {
  const selected = [];
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
  const ctx = { cwd: "/project", model: { provider: "openai-codex", id: "gpt-6.1-sol" },
    sessionManager: { getSessionId: () => "session-123" }, isProjectTrusted: () => false,
    modelRegistry: { getProviderDisplayName: () => "ChatGPT", getProviderAuthStatus: () => ({ configured: true, label: "secret-key" }),
      isUsingOAuth: () => true, getApiKeyAndHeaders: () => assert.fail("status must not resolve credentials") } };
  const pi = { getThinkingLevel: () => "medium", getActiveTools: () => ["read", "edit"], getAllTools: () => [], getMcpServers: () => [] };
  const options = { version: "1.4.0", agentDir: "/profile", packageDir: "/engine" };
  return { ctx, pi, options };
}

test("status reports engine, session, login method, model, and tools without resolving secrets", async () => {
  const { ctx, pi, options } = statusFixture();
  const data = await readStatus(ctx, pi, options, { loadMcpConfig: async () => ({ servers: [] }) });
  assert.equal(data.version, "1.4.0");
  assert.equal(data.sessionId, "session-123");
  assert.equal(data.login, "ChatGPT · OAuth configured");
  assert.equal(data.model, "gpt-6.1-sol");
  assert.deepEqual(data.tools, ["read", "edit"]);
  const output = statusLines(data, 76, createUiTheme({ color: false }), measure).join("\n");
  for (const label of ["Version:", "Session ID:", "Login:", "Model:", "MCP Servers:", "Tools:"]) assert.ok(output.includes(label));
  assert.doesNotMatch(output, /secret-key/);
  assert.match(output, /Login:[^\n]*\n\nModel:/);
  assert.doesNotMatch(output, /medium effort|openai-codex/);
  ctx.modelRegistry.isUsingOAuth = () => false;
  assert.match((await readStatus(ctx, pi, options, { loadMcpConfig: async () => undefined })).login, /API credentials configured/);
  ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: false });
  assert.match((await readStatus(ctx, pi, options, { loadMcpConfig: async () => undefined })).login, /not configured/);
});

test("status combines MCP metadata and registered namespaces without claiming a live connection", async () => {
  const { ctx, pi, options } = statusFixture();
  pi.getMcpServers = () => [{ name: "docs", config: { enabled: true } }, { name: "custom", config: {} }];
  pi.getAllTools = () => [
    { name: "mcp__docs__lookup" },
    { name: "mcp__my_server__search", namespace: { name: "mcp__my_server", aliases: ["my-server"] } },
    { name: "read" },
  ];
  const data = await readStatus(ctx, pi, options, { loadMcpConfig: async (input) => {
    assert.equal(input.projectTrusted, false);
    return { servers: [{ name: "docs", config: { enabled: false } }, { name: "my-server", config: {} }] };
  } });
  assert.deepEqual(data.mcp, [{ name: "custom", enabled: true, tools: 0 }, { name: "docs", enabled: false, tools: 1 }, { name: "my-server", enabled: true, tools: 1 }]);
  const output = statusLines(data, 80, theme, measure).join("\n");
  assert.match(output, /docs \(disabled\)/);
  assert.match(output, /my-server \(1 tool\s+registered\)/);
  assert.doesNotMatch(output, /connected/);
  const failed = await readStatus(ctx, pi, options, { loadMcpConfig: async () => { throw new Error("secret-config"); } });
  assert.equal(failed.mcpConfigError, true);
  assert.doesNotMatch(statusLines(failed, 80, theme, measure).join("\n"), /secret-config/);
});

test("status handles no selected model and remains usable on narrow terminals", async () => {
  const { ctx, pi, options } = statusFixture();
  ctx.model = undefined;
  const data = await readStatus(ctx, pi, options, { loadMcpConfig: async () => undefined });
  assert.equal(data.login, "No model selected");
  assert.equal(data.mcpConfigKnown, false);
  const panel = createCommandPanel({ title: "Status", tui: { terminal: { rows: 24 }, requestRender() {} }, theme, measure,
    done() {}, load: () => data, renderBody: statusLines });
  await panel.ready;
  for (const width of [1, 8, 24, 40, 80, 140]) assert.ok(panel.render(width).every((line) => measure.visibleWidth(line) <= width));
  panel.dispose();
});

test("statistics and session status register as separate commands", async () => {
  const { createJiti } = await import(pathToFileURL(require.resolve("jiti")));
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    "@earendil-works/pi-coding-agent": fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  } });
  const factory = await jiti.import(fileURLToPath(new URL("../dist/extensions/commands.js", import.meta.url)), { default: true });
  const commands = new Map();
  factory({ registerCommand: (name, command) => commands.set(name, command) });
  assert.match(commands.get("stats").description, /activity calendar/);
  assert.match(commands.get("status").description, /version, session, login, model/);
});
