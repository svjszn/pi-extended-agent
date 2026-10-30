import { homedir } from "node:os";
import { allocateTokens } from "../lib/context.js";
import type { ContextReport, ContextCategoryId } from "../lib/context.js";
import type { Measure, Palette } from "./types.js";
import { contextTokens, contextPercent } from "./context-format.js";

const symbols: Record<ContextCategoryId, string> = {
  system: "■", tools: "▣", instructions: "▤", skills: "▥", messages: "▦", results: "▧", other: "▪",
};
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

export function contextLines(data: ContextReport, width: number, theme: Palette, measure: Measure): string[] {
  const muted = (value: string) => theme.fg("muted", value);
  const label = (value: string) => theme.fg("primary", theme.bold(value));
  const capacity = data.contextWindow;
  const used = data.tokens;
  const total = used === null ? "Context usage unavailable" : `~${contextTokens(used)}${capacity ? ` / ${contextTokens(capacity)}` : ""} tokens${data.percent !== null ? ` · ${contextPercent(data.percent)} used` : ""}`;
  const lines = [label(total), ""];
  if (used === null) lines.push(muted(data.afterCompaction ? "Waiting for the first response after compaction." : "Usage will appear when the model reports its context."), "");
  const remaining = capacity !== null && used !== null ? Math.max(0, capacity - used) : null;
  const buffer = remaining !== null && data.autoCompact ? Math.min(data.reserveTokens, remaining) : 0;
  const items = data.categories.map((item) => ({ ...item, symbol: symbols[item.id], role: "primary" }));
  if (remaining !== null) {
    items.push({ id: "other", name: "Free space", tokens: remaining - buffer, symbol: "·", role: "dim" });
    if (data.autoCompact) items.push({ id: "other", name: "Compaction buffer", tokens: buffer, symbol: "░", role: "dim" });
  }
  const legendWidth = width >= 76 ? width - 36 : width;
  const legend = items.map((item) => {
    const name = `${item.symbol} ${item.name}`;
    const amount = `${item.role === "primary" ? "~" : ""}${contextTokens(item.tokens)}${capacity ? ` · ${contextPercent(item.tokens / capacity * 100)}` : ""}`;
    const gap = legendWidth - measure.visibleWidth(name) - amount.length;
    return gap >= 2 ? theme.fg(item.role, name) + " ".repeat(gap) + theme.fg(item.role, amount)
      : theme.fg(item.role, `${name}  ${amount}`);
  });
  if (capacity && used !== null && width >= 76) {
    const cells = allocateTokens(96, items.map((item) => item.tokens));
    const grid = items.flatMap((item, index) => Array<string>(cells[index]).fill(theme.fg(item.role, item.symbol + " ")));
    for (let row = 0; row < Math.max(6, legend.length); row++) {
      const left = grid.slice(row * 16, (row + 1) * 16).join("");
      lines.push(left + " ".repeat(Math.max(0, 36 - measure.visibleWidth(left))) + (legend[row] || ""));
    }
  } else {
    if (capacity && used !== null) {
      const size = Math.max(1, Math.min(50, width));
      const filled = Math.min(size, Math.round(Math.min(1, used / capacity) * size));
      lines.push(theme.fg("primary", "█".repeat(filled)) + theme.fg("dim", "░".repeat(size - filled)), "");
    }
    lines.push(...legend);
  }
  lines.push("", muted(used === null ? "Estimated content sizes · total not yet available." : "Estimated breakdown · categories are reconciled to the total."));
  lines.push(muted(data.source === "pi" ? "Total uses Pi's latest usage plus estimates for newer messages." : data.source === "estimate"
    ? "Before the first response, sizes use Pi's character-based estimate." : "Category sizes are estimates; the total is not yet available."));
  lines.push("", label("Session"));
  lines.push(muted(`${data.messageCount} messages in context · ${data.compactions} compactions on this branch`));
  const threshold = capacity ? Math.max(0, capacity - data.reserveTokens) : null;
  lines.push(muted(data.autoCompact ? `Auto compact on${threshold !== null ? ` · threshold ${contextTokens(threshold)} tokens (${contextPercent(threshold / capacity! * 100)})` : ""}` : "Auto compact off"));
  lines.push(muted("Use /compact to summarize this session, or /new to start fresh."));
  const detail = (title: string, entries: { name: string; tokens: number }[]) => {
    if (!entries.length) return;
    lines.push("", label(title));
    for (const item of entries) {
      const home = homedir();
      const safe = clean(item.name);
      const name = safe === home || safe.startsWith(home + "/") || safe.startsWith(home + "\\") ? "~" + safe.slice(home.length) : safe;
      const amount = `~${contextTokens(item.tokens)}`;
      const nameWidth = Math.max(1, width - amount.length - 2);
      const clipped = measure.truncateToWidth(name, nameWidth);
      lines.push(muted(clipped + " ".repeat(Math.max(2, width - measure.visibleWidth(clipped) - amount.length)) + amount));
    }
  };
  detail("Loaded instructions · raw estimates", data.files);
  detail("Skill descriptions · raw estimates", data.skills);
  detail("Active tools · raw estimates", data.tools);
  return lines;
}
