import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasErrorCode } from "./errors.js";

interface SessionSpan { first: number; last: number }
const tokenFields = ["input", "output", "cacheRead", "cacheWrite"] as const;
type TokenField = typeof tokenFields[number];
type TokenCounts = Record<TokenField | "totalTokens", number>;
interface DailyActivity extends TokenCounts {
  key: string; prompts: number; hasUsage: boolean;
  models: Map<string, number>; sessions: Map<string, SessionSpan>;
}
export interface ActivityStats extends TokenCounts {
  prompts: number; hasUsage: boolean; sessions: number; activeDays: number; dayCount: number;
  longestSession: number; longestStreak: number; streak: number;
  favoriteModel: string | null; mostActiveDay: string | null;
}
export interface ActivityDay { key: string; count: number; tokens?: number }
export interface ActivityReport {
  days: ActivityDay[]; total: number; activeDays: number; streak: number; skipped?: number;
  periods?: Record<"all" | "week" | "month", ActivityStats>;
}
interface ActivityEntry {
  type?: string; id?: string; timestamp?: string;
  usage?: Partial<TokenCounts>;
  message?: { role?: string; model?: string; timestamp?: number | string; usage?: Partial<TokenCounts> };
}
interface SessionIdentity { id: string; created: number }

export function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function activitySummary(counts: Map<string, number>, now = new Date()) {
  const days: ActivityDay[] = [];
  for (let i = 364; i >= 0; i--) {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - i);
    const key = dayKey(date);
    days.push({ key, count: counts.get(key) || 0 });
  }
  let current = days.length - 1;
  if (!days[current].count) current--;
  let streak = 0;
  while (current >= 0 && days[current--].count > 0) streak++;
  return { days, total: days.reduce((sum, day) => sum + day.count, 0), activeDays: days.filter((day) => day.count > 0).length, streak };
}

async function sessionFiles(directory: string, files: Set<string>, signal?: AbortSignal, depth = 0) {
  signal?.throwIfAborted();
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (hasErrorCode(error, "ENOENT")) return; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.add(resolve(path));
    else if (entry.isDirectory() && !entry.isSymbolicLink() && depth < 1) await sessionFiles(path, files, signal, depth + 1);
  }
}

const utcDay = (key: string) => Date.parse(`${key}T12:00:00Z`);
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

function summarizeDays(daily: Map<string, DailyActivity>, now: Date, length?: number): ActivityStats {
  const last = dayKey(now);
  const cutoff = new Date(now);
  if (length) cutoff.setDate(cutoff.getDate() - length + 1);
  const first = length ? dayKey(cutoff) : [...daily.keys()].sort()[0] || last;
  const days = [...daily.values()].filter((day) => day.key >= first && day.key <= last).sort((a, b) => a.key.localeCompare(b.key));
  const stats: ActivityStats = { prompts: 0, totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, hasUsage: false,
    sessions: 0, activeDays: 0, dayCount: length || (days.length ? Math.round((utcDay(last) - utcDay(first)) / 86400000) + 1 : 0),
    longestSession: 0, longestStreak: 0, streak: 0, favoriteModel: null, mostActiveDay: null };
  const models = new Map<string, number>(), sessions = new Map<string, SessionSpan>(), active = new Set<string>();
  let previous: string | undefined, streak = 0, peak = -1;
  const hasTokens = days.some((day) => day.totalTokens > 0);
  for (const day of days) {
    stats.prompts += day.prompts;
    for (const field of ["totalTokens", ...tokenFields] as const) stats[field] += day[field];
    stats.hasUsage ||= day.hasUsage;
    for (const [model, count] of day.models) models.set(model, (models.get(model) || 0) + count);
    for (const [id, span] of day.sessions) {
      const previousSpan = sessions.get(id);
      sessions.set(id, { first: Math.min(previousSpan?.first ?? span.first, span.first), last: Math.max(previousSpan?.last ?? span.last, span.last) });
    }
    if (!day.prompts && !day.totalTokens && !day.models.size) continue;
    active.add(day.key);
    streak = previous && utcDay(day.key) - utcDay(previous) === 86400000 ? streak + 1 : 1;
    stats.longestStreak = Math.max(stats.longestStreak, streak);
    previous = day.key;
    const score = hasTokens ? day.totalTokens : day.prompts;
    if (score > peak) { peak = score; stats.mostActiveDay = day.key; }
  }
  const date = new Date(now);
  if (!active.has(last)) date.setDate(date.getDate() - 1);
  while (active.has(dayKey(date))) { stats.streak++; date.setDate(date.getDate() - 1); }
  stats.activeDays = active.size;
  stats.sessions = sessions.size;
  for (const span of sessions.values()) stats.longestSession = Math.max(stats.longestSession, span.last - span.first);
  stats.favoriteModel = [...models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
  return stats;
}

/** Aggregate local history without keeping message text. Forked entries count once. */
export async function readActivity({ agentDir, sessionManager, signal, now = new Date() }: {
  agentDir: string; sessionManager?: ExtensionContext["sessionManager"]; signal?: AbortSignal; now?: Date;
}): Promise<ActivityReport> {
  const counts = new Map<string, number>(), daily = new Map<string, DailyActivity>(), seen = new Set<string>(), files = new Set<string>();
  const days = activitySummary(counts, now).days;
  const last = days[days.length - 1].key;
  let skipped = 0;
  const visit = (entry: ActivityEntry, session: SessionIdentity) => {
    if (!entry || typeof entry !== "object") return;
    if (entry.type === "session") {
      session.id = entry.id || session.id;
      session.created = Date.parse(entry.timestamp || "");
      return;
    }
    const message = entry.type === "message" ? entry.message : undefined;
    const usage = message?.usage || (["usage", "compaction", "branch_summary"].includes(entry.type || "") ? entry.usage : undefined);
    if (!usage && !["user", "assistant"].includes(message?.role || "")) return;
    const timestamp = message?.timestamp ?? entry.timestamp;
    const date = new Date(timestamp ?? NaN);
    if (Number.isNaN(date.getTime())) return;
    const key = dayKey(date);
    if (key > last) return;
    const id = entry.id ? `${entry.type}:${entry.id}:${date.getTime()}` : createHash("sha256").update(JSON.stringify(entry)).digest("hex");
    const duplicate = seen.has(id);
    const sessionOwnEntry = Number.isFinite(session.created) ? date.getTime() >= session.created : !duplicate;
    if (duplicate && !sessionOwnEntry) return;
    if (!daily.has(key)) daily.set(key, { key, prompts: 0, totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, hasUsage: false, models: new Map(), sessions: new Map() });
    const day = daily.get(key)!;
    if (sessionOwnEntry && ["user", "assistant"].includes(message?.role || "")) {
      const span = day.sessions.get(session.id);
      day.sessions.set(session.id, { first: Math.min(span?.first ?? date.getTime(), date.getTime()), last: Math.max(span?.last ?? date.getTime(), date.getTime()) });
    }
    if (duplicate) return;
    seen.add(id);
    if (message?.role === "user") {
      counts.set(key, (counts.get(key) || 0) + 1);
      day.prompts++;
    }
    if (message?.role === "assistant" && typeof message.model === "string") day.models.set(message.model, (day.models.get(message.model) || 0) + 1);
    if (usage && typeof usage === "object") {
      day.hasUsage = true;
      for (const field of tokenFields) day[field] += numeric(usage[field]);
      day.totalTokens += Number.isFinite(usage.totalTokens) ? numeric(usage.totalTokens)
        : tokenFields.reduce((sum, field) => sum + numeric(usage[field]), 0);
    }
  };
  await sessionFiles(join(agentDir, "sessions"), files, signal);
  const currentDirectory = sessionManager?.getSessionDir();
  if (currentDirectory) await sessionFiles(currentDirectory, files, signal);
  for (const file of files) {
    signal?.throwIfAborted();
    const stream = createReadStream(file, { encoding: "utf8", signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const session = { id: file, created: NaN };
    try {
      for await (const line of lines) {
        signal?.throwIfAborted();
        try { visit(JSON.parse(line), session); } catch { /* Interrupted writes can leave one partial line. */ }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      skipped++;
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  // Include the current in-memory/unflushed session; IDs prevent double counts.
  const current = { id: sessionManager?.getSessionId?.() || sessionManager?.getSessionFile?.() || "in-memory", created: NaN };
  const header = sessionManager?.getHeader?.();
  if (header) visit(header, current);
  for (const entry of sessionManager?.getEntries() || []) visit(entry, current);
  const summary = activitySummary(counts, now);
  return { ...summary, days: summary.days.map((day) => ({ ...day, tokens: daily.get(day.key)?.totalTokens || 0 })), skipped,
    periods: { all: summarizeDays(daily, now), week: summarizeDays(daily, now, 7), month: summarizeDays(daily, now, 30) } };
}
