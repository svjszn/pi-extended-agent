import type { PerformanceRun, TimeCategory } from "./tracker.js";
import type { Palette } from "../../ui/types.js";

export function duration(ms: number | null) {
  if (ms === null) return "Not observed";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`
    : minutes ? `${minutes}m ${seconds % 60}s` : `${(ms / 1000).toFixed(1)}s`;
}
export function performanceLines(run: PerformanceRun | undefined, theme: Palette): string[] {
  if (!run) return ["No recorded run yet.", "", "Run a task, then open /perf. Recording starts with your next request.",
    "Use /perf history for recent runs or /perf json for machine-readable metrics."];
  const metric = (label: string, value: unknown) => theme.fg("muted", `${label}: `) + theme.fg("text", String(value));
  const labels: Record<TimeCategory, string> = { model: "Model / provider", tools: "Tools", compaction: "Compaction", approval: "User dialogs", other: "Other / orchestration" };
  const lines = [metric("Elapsed", duration(run.elapsedMs)), metric("Outcome", run.outcome),
    metric("Model", `${run.provider}/${run.model}`), metric("Effort", run.effort), "", theme.bold("Wall-clock breakdown")];
  for (const key of ["model", "tools", "compaction", "approval", "other"] as const) {
    lines.push(metric(labels[key], `${duration(run.times[key])} · ${run.elapsedMs ? Math.round(run.times[key] / run.elapsedMs * 100) : 0}%`));
  }
  lines.push("", metric("Provider requests observed", run.requests), metric("Agent turns", run.turns),
    metric("Time to first output event", duration(run.firstOutputMs)), metric("First successful file write/edit", duration(run.firstChangeMs)),
    metric("Tool calls", `${run.tools} (${run.nestedTools} nested)`), metric("Tool failures", run.toolErrors),
    metric("Repeated reads of the same path", run.repeatedReads), metric("Repeated shell commands", run.repeatedShells),
    metric("HTTP error responses observed", run.httpErrors), metric("Failed assistant responses", run.failedResponses),
    metric("Compactions", `${run.compactions} (${run.compactionErrors} failed)`));
  if (run.requestMs.length) {
    const sorted = [...run.requestMs].sort((a, b) => a - b);
    lines.push(metric("Request duration (median / slowest)", `${duration(sorted[Math.floor(sorted.length / 2)])} / ${duration(sorted.at(-1)!)}`));
  }
  if (run.requestDetails) {
    const batches = run.requestDetails.filter((sample) => sample.kind === "assistant" && sample.toolCalls !== null && sample.toolCalls > 0);
    lines.push(metric("Tool batches (single / multi-call)", `${batches.filter((sample) => sample.toolCalls === 1).length} / ${batches.filter((sample) => sample.toolCalls! > 1).length}`));
  }
  lines.push("", theme.bold("Reported tokens"), ...Object.entries(run.tokens).map(([key, value]) => metric(key, value.toLocaleString("en-US"))), "",
    theme.bold("Calls by tool"), ...Object.entries(run.toolKinds).sort((a, b) => b[1] - a[1]).map(([name, count]) => metric(name, count)), "",
    "Time categories are exclusive; overlapping and nested calls are not added twice.",
    "Provider time includes network and generation. Hidden client retries may not emit events.",
    "First output includes text, thinking, or tool-call deltas. File changes via shell/MCP are not detected.",
    "Repeated reads/commands can be necessary; counts do not establish wasted work.",
    "This records Pi runs only; it does not measure an external Claude Code or Codex CLI process.");
  if (run.requestDetails?.length) {
    lines.push("", theme.bold("Per-request timeline"), "First event/text are offsets from that request's start; not measurements of internal thinking.");
    run.requestDetails.forEach((sample, index) => {
      lines.push(`${index + 1}. ${duration(sample.durationMs)} · ${sample.kind} · ${sample.stopReason}`,
        `   first event ${duration(sample.firstOutputMs)} · first text ${duration(sample.firstTextMs)}`,
        `   output ${sample.tokens?.output ?? "unknown"} tokens · tool calls ${sample.toolCalls ?? "unknown"}${sample.httpStatus !== null ? ` · HTTP ${sample.httpStatus}` : ""}`);
    });
  } else if (run.requestDetails === undefined) lines.push("Detailed request timing was not collected by the earlier version of this run.");
  if (run.configurationChanges) lines.push(metric("Model/effort changes during run", run.configurationChanges));
  if (run.incomplete) lines.push("Some measurements are incomplete (interrupted events or collection limits).");
  return lines;
}
