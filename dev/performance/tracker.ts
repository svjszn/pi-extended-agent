import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { StateFiles } from "../../lib/project-state.js";

export const PERFORMANCE_VERSION = 1;
export const PERFORMANCE_MAX_BYTES = 4_000_000;
export type TimeCategory = "model" | "tools" | "compaction" | "approval" | "other";
type Interval = { start: number; end: number; kind: Exclude<TimeCategory, "other"> };
export interface RequestSample {
  startMs: number; durationMs: number; firstOutputMs: number | null; firstTextMs: number | null;
  kind: "assistant" | "compaction";
  stopReason: "pending" | "stop" | "toolUse" | "length" | "aborted" | "error" | "unpaired" | "compaction";
  httpStatus: number | null; toolCalls: number | null; tokens: PerformanceRun["tokens"] | null;
}
export interface PerformanceRun {
  version: 1; id: string; startedAt: string; outcome: "running" | "completed" | "error" | "aborted" | "interrupted";
  model: string; provider: string; effort: string; configurationChanges: number;
  elapsedMs: number; times: Record<TimeCategory, number>;
  turns: number; requests: number; failedResponses: number; httpErrors: number;
  requestMs: number[];
  requestDetails?: RequestSample[];
  firstOutputMs: number | null; firstChangeMs: number | null;
  tools: number; nestedTools: number; toolErrors: number; repeatedReads: number; repeatedShells: number;
  compactions: number; compactionErrors: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  toolKinds: Record<string, number>;
  incomplete: boolean;
}
const categories: TimeCategory[] = ["approval", "compaction", "tools", "model", "other"];
const clean = (value: unknown) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 160) : "unknown";
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Exclusive wall-clock categories. Nested calls and simultaneous tools never add time twice. */
export function partitionTime(elapsedMs: number, intervals: readonly Interval[]): Record<TimeCategory, number> {
  const times = { model: 0, tools: 0, compaction: 0, approval: 0, other: 0 };
  const events: { time: number; kind: Exclude<TimeCategory, "other">; delta: number }[] = [];
  for (const interval of intervals) {
    const start = Math.max(0, Math.min(elapsedMs, interval.start)), end = Math.max(start, Math.min(elapsedMs, interval.end));
    if (end > start) events.push({ time: start, kind: interval.kind, delta: 1 }, { time: end, kind: interval.kind, delta: -1 });
  }
  events.sort((a, b) => a.time - b.time);
  const active = { model: 0, tools: 0, compaction: 0, approval: 0, other: 1 };
  let previous = 0;
  for (const event of events) {
    const kind = categories.find((key) => active[key] > 0)!;
    times[kind] += event.time - previous; active[event.kind] += event.delta; previous = event.time;
  }
  times[categories.find((key) => active[key] > 0)!] += Math.max(0, elapsedMs - previous);
  return times;
}

export class PerformanceTracker {
  private run?: PerformanceRun;
  private start = 0;
  private intervals: Interval[] = [];
  private open = new Map<string, { kind: Exclude<TimeCategory, "other">; start: number }>();
  private toolInfo = new Map<string, { name: string; mutation: boolean; nested: boolean }>();
  private seenReads = new Set<string>();
  private seenShells = new Set<string>();
  private measuredOutput = false;
  private approvalDepth = 0;
  private currentRequest?: Omit<RequestSample, "durationMs">;
  constructor(private readonly clock = () => performance.now(), private readonly wallClock = () => new Date()) {}
  get active() { return this.run !== undefined; }
  begin(model: string, provider: string, effort: string) {
    if (this.run) return;
    this.start = this.clock(); this.intervals = []; this.open.clear(); this.toolInfo.clear(); this.seenReads.clear(); this.seenShells.clear(); this.measuredOutput = false; this.approvalDepth = 0; this.currentRequest = undefined;
    this.run = { version: 1, id: randomUUID(), startedAt: this.wallClock().toISOString(), outcome: "running",
      model: clean(model), provider: clean(provider), effort: clean(effort), configurationChanges: 0,
      elapsedMs: 0, times: { model: 0, tools: 0, compaction: 0, approval: 0, other: 0 },
      turns: 0, requests: 0, failedResponses: 0, httpErrors: 0, requestMs: [], requestDetails: [], firstOutputMs: null, firstChangeMs: null,
      tools: 0, nestedTools: 0, toolErrors: 0, repeatedReads: 0, repeatedShells: 0, compactions: 0, compactionErrors: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolKinds: {}, incomplete: false };
  }
  private elapsed() { return Math.max(0, this.clock() - this.start); }
  private beginInterval(key: string, kind: Exclude<TimeCategory, "other">) {
    if (!this.run) return;
    this.endInterval(key); this.open.set(key, { kind, start: this.elapsed() });
  }
  private endInterval(key: string) {
    const interval = this.open.get(key); if (!interval) return;
    this.open.delete(key);
    const end = this.elapsed();
    if (key === "request" && this.run) {
      if (this.run.requestMs.length < 256) this.run.requestMs.push(end - interval.start);
      else this.run.incomplete = true;
      if (this.currentRequest && this.run.requestDetails!.length < 256) {
        this.run.requestDetails!.push({ ...this.currentRequest, durationMs: end - interval.start });
      }
      this.currentRequest = undefined;
    }
    if (this.intervals.length < 20_000) this.intervals.push({ ...interval, end });
    else if (this.run) this.run.incomplete = true;
  }
  turn() { if (this.run) this.run.turns++; }
  configurationChanged() { if (this.run) this.run.configurationChanges++; }
  request() {
    if (!this.run) return;
    this.run.requests++;
    // These hooks carry no request id. Overlapping calls cannot be paired reliably.
    if (this.open.has("request")) {
      this.run.incomplete = true;
      if (this.currentRequest) this.currentRequest.stopReason = "unpaired";
    }
    this.beginInterval("request", "model");
    this.currentRequest = { startMs: this.open.get("request")!.start, firstOutputMs: null, firstTextMs: null,
      kind: this.open.has("compaction") ? "compaction" : "assistant", stopReason: "pending", httpStatus: null, toolCalls: null, tokens: null };
  }
  response(status: number) {
    if (this.run && status >= 400) this.run.httpErrors++;
    if (this.currentRequest && Number.isInteger(status) && status >= 100 && status <= 599) this.currentRequest.httpStatus = status;
  }
  output(kind: "text" | "thinking" | "toolcall" = "text") {
    if (this.run && !this.measuredOutput) { this.run.firstOutputMs = this.elapsed(); this.measuredOutput = true; }
    if (this.currentRequest) {
      const offset = Math.max(0, this.elapsed() - this.currentRequest.startMs);
      this.currentRequest.firstOutputMs ??= offset;
      if (kind === "text") this.currentRequest.firstTextMs ??= offset;
    }
  }
  assistantEnd(usage: unknown, stopReason: string, toolCalls = 0) {
    if (!this.run) return;
    if (this.currentRequest) {
      this.currentRequest.stopReason = ["stop", "toolUse", "length", "aborted", "error"].includes(stopReason) ? stopReason as RequestSample["stopReason"] : "unpaired";
      this.currentRequest.toolCalls = Math.floor(numeric(toolCalls));
      this.currentRequest.tokens = tokenCounts(usage);
    }
    this.endInterval("request"); this.usage(usage);
    if (stopReason === "error") this.run.failedResponses++;
  }
  usage(value: unknown) {
    if (!this.run || !value || typeof value !== "object") return;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) this.run.tokens[key] += numeric((value as Record<string, unknown>)[key]);
  }
  toolStart(id: string, name: string, args: unknown, builtin: boolean, cwd: string, parent?: string) {
    if (!this.run) return;
    const nested = parent !== undefined;
    this.run.tools++; if (nested) this.run.nestedTools++;
    const label = Object.hasOwn(this.run.toolKinds, name) || Object.keys(this.run.toolKinds).length < 64 ? clean(name) : "other";
    Object.defineProperty(this.run.toolKinds, label, { value: (Object.hasOwn(this.run.toolKinds, label) ? this.run.toolKinds[label] : 0) + 1, enumerable: true, configurable: true, writable: true });
    if (this.toolInfo.size >= 2048) { this.run.incomplete = true; return; }
    this.toolInfo.set(id, { name, mutation: builtin && (name === "write" || name === "edit"), nested });
    this.beginInterval(`tool:${id}`, "tools");
    const input = args as Record<string, unknown> | undefined;
    if (builtin && name === "read" && typeof input?.path === "string") {
      const hash = digest(resolve(cwd, input.path));
      if (this.seenReads.has(hash)) this.run.repeatedReads++;
      else if (this.seenReads.size < 2048) this.seenReads.add(hash);
      else this.run.incomplete = true;
    }
    if (builtin && (name === "bash" || name === "powershell") && typeof input?.command === "string") {
      const hash = digest(input.command);
      if (this.seenShells.has(hash)) this.run.repeatedShells++;
      else if (this.seenShells.size < 2048) this.seenShells.add(hash);
      else this.run.incomplete = true;
    }
  }
  toolEnd(id: string, error: boolean, executed: boolean, usage?: unknown) {
    if (!this.run) return;
    const info = this.toolInfo.get(id);
    this.endInterval(`tool:${id}`); this.toolInfo.delete(id);
    if (error) this.run.toolErrors++;
    if (info?.mutation && !error && executed && this.run.firstChangeMs === null) this.run.firstChangeMs = this.elapsed();
    // A parent result already includes nested tool usage. Count only root results.
    if (info && !info.nested) this.usage(usage);
  }
  approvalStart() { if (this.run && this.approvalDepth++ === 0) this.beginInterval("approval", "approval"); }
  approvalEnd() { if (this.approvalDepth > 0 && --this.approvalDepth === 0) this.endInterval("approval"); }
  compactStart() { if (this.run) { this.run.compactions++; this.beginInterval("compaction", "compaction"); } }
  compactEnd(error: boolean, usage?: unknown) {
    if (!this.run) return;
    if (this.currentRequest) {
      this.currentRequest.stopReason = error ? "error" : "compaction";
      this.currentRequest.tokens = tokenCounts(usage);
    }
    this.endInterval("compaction"); this.endInterval("request");
    if (error) this.run.compactionErrors++; this.usage(usage);
  }
  snapshot(): PerformanceRun | undefined {
    if (!this.run) return;
    const elapsedMs = this.elapsed();
    const intervals = [...this.intervals, ...[...this.open.values()].map((interval) => ({ ...interval, end: elapsedMs }))];
    const details = [...(this.run.requestDetails ?? [])];
    if (this.currentRequest && details.length < 256) details.push({ ...this.currentRequest, durationMs: Math.max(0, elapsedMs - this.currentRequest.startMs) });
    return { ...this.run, elapsedMs, times: partitionTime(elapsedMs, intervals), tokens: { ...this.run.tokens }, toolKinds: { ...this.run.toolKinds }, requestMs: [...this.run.requestMs],
      requestDetails: details.map((sample) => ({ ...sample, tokens: sample.tokens ? { ...sample.tokens } : null })) };
  }
  finish(outcome: Exclude<PerformanceRun["outcome"], "running">) {
    const run = this.snapshot();
    if (!run) return;
    run.outcome = outcome;
    run.incomplete ||= this.open.size > 0;
    this.run = undefined; this.open.clear(); this.toolInfo.clear(); this.intervals = []; this.seenReads.clear(); this.seenShells.clear(); this.currentRequest = undefined;
    return run;
  }
}

export class PerformanceStore {
  readonly name: string;
  constructor(private readonly files: StateFiles, sessionId: string) { this.name = `performance/${digest(sessionId).slice(0, 32)}.json`; }
  read(): PerformanceRun[] {
    const text = this.files.read(this.name, PERFORMANCE_MAX_BYTES); if (!text) return [];
    const data = JSON.parse(text);
    if (data.version !== PERFORMANCE_VERSION || !Array.isArray(data.runs) || data.runs.length > 30) throw new Error("Invalid performance history.");
    return data.runs.map(parseRun);
  }
  save(run: PerformanceRun) {
    const runs = [...this.read().filter((old) => old.id !== run.id), parseRun(run)].slice(-30);
    this.files.write(this.name, JSON.stringify({ version: PERFORMANCE_VERSION, runs }));
  }
}

const counters = ["configurationChanges", "elapsedMs", "turns", "requests", "failedResponses", "httpErrors", "tools", "nestedTools",
  "toolErrors", "repeatedReads", "repeatedShells", "compactions", "compactionErrors"] as const;
function parseRun(value: unknown): PerformanceRun {
  const run = value as PerformanceRun;
  const number = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
  const text = (s: unknown) => typeof s === "string" && s.length <= 160 && s === clean(s);
  if (!run || run.version !== 1 || !text(run.id) || !text(run.startedAt) || !Number.isFinite(Date.parse(run.startedAt))
    || !text(run.model) || !text(run.provider) || !text(run.effort) || !["completed", "error", "aborted", "interrupted"].includes(run.outcome)
    || counters.some((key) => !number(run[key])) || typeof run.incomplete !== "boolean"
    || !run.times || categories.some((key) => !number(run.times[key]))
    || !run.tokens || ["input", "output", "cacheRead", "cacheWrite"].some((key) => !number(run.tokens[key as keyof typeof run.tokens]))
    || ![run.firstOutputMs, run.firstChangeMs].every((n) => n === null || number(n))
    || !Array.isArray(run.requestMs) || run.requestMs.length > 256 || !run.requestMs.every(number)
    || !run.toolKinds || typeof run.toolKinds !== "object" || Array.isArray(run.toolKinds) || Object.keys(run.toolKinds).length > 65
    || Object.entries(run.toolKinds).some(([key, count]) => !text(key) || !number(count))) throw new Error("Invalid performance run.");
  // Read only known fields. A modified notebook cannot inject extra content into JSON export.
  return { version: 1, id: run.id, startedAt: run.startedAt, outcome: run.outcome,
    model: run.model, provider: run.provider, effort: run.effort,
    ...Object.fromEntries(counters.map((key) => [key, run[key]])) as Pick<PerformanceRun, typeof counters[number]>,
    times: Object.fromEntries(categories.map((key) => [key, run.times[key]])) as PerformanceRun["times"],
    tokens: { input: run.tokens.input, output: run.tokens.output, cacheRead: run.tokens.cacheRead, cacheWrite: run.tokens.cacheWrite },
    firstOutputMs: run.firstOutputMs, firstChangeMs: run.firstChangeMs, requestMs: [...run.requestMs],
    toolKinds: Object.fromEntries(Object.entries(run.toolKinds)), incomplete: run.incomplete,
    ...(run.requestDetails !== undefined ? { requestDetails: parseRequestDetails(run.requestDetails) } : {}) };
}

function tokenCounts(value: unknown): PerformanceRun["tokens"] | null {
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map((key) => [key, numeric((value as Record<string, unknown>)[key])])) as PerformanceRun["tokens"];
}

function parseRequestDetails(value: unknown): RequestSample[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("Invalid request timing samples.");
  const number = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
  const optionalNumber = (n: unknown) => n === null || number(n);
  return value.map((sample: RequestSample) => {
    if (!sample || !number(sample.startMs) || !number(sample.durationMs) || !optionalNumber(sample.firstOutputMs) || !optionalNumber(sample.firstTextMs)
      || !["assistant", "compaction"].includes(sample.kind)
      || !["pending", "stop", "toolUse", "length", "aborted", "error", "unpaired", "compaction"].includes(sample.stopReason)
      || !(sample.httpStatus === null || (Number.isInteger(sample.httpStatus) && sample.httpStatus >= 100 && sample.httpStatus <= 599))
      || !(sample.toolCalls === null || (number(sample.toolCalls) && Number.isInteger(sample.toolCalls)))
      || !(sample.tokens === null || (typeof sample.tokens === "object" && ["input", "output", "cacheRead", "cacheWrite"].every((key) => number(sample.tokens![key as keyof typeof sample.tokens]))))) {
      throw new Error("Invalid request timing sample.");
    }
    return { startMs: sample.startMs, durationMs: sample.durationMs, firstOutputMs: sample.firstOutputMs, firstTextMs: sample.firstTextMs,
      kind: sample.kind, stopReason: sample.stopReason, httpStatus: sample.httpStatus, toolCalls: sample.toolCalls, tokens: sample.tokens ? tokenCounts(sample.tokens) : null };
  });
}
