import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentStatus } from "../lib/subagent-status.js";
import { createUiTheme } from "./theme.js";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Render inside the editor's existing Working slot, with no extra row or timer. */
export function renderSubagentProgress(status: SubagentStatus, width: number, now: number, nativeStatus = "") {
  if (width < 1) return "";
  const theme = createUiTheme();
  const seconds = Math.floor(status.elapsedMs / 1000);
  const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const frame = frames[Math.floor(now / 80) % frames.length];
  const prefix = nativeStatus || `${frame} Working`;
  const name = `${status.name}${status.additionalRuns ? ` +${status.additionalRuns}` : ""}`;
  const calls = `${status.toolCalls} ${status.toolCalls === 1 ? "call" : "calls"}`;
  const labels = [`${prefix} · ${name} · ${status.note} · ${duration} · ${calls} · esc stop`,
    `${prefix} · ${name} · ${status.note} · ${duration} · ${calls}`,
    `${prefix} · ${name} · ${duration} · ${calls}`, `${prefix} · ${name} · ${duration}`, `${prefix} · ${name}`];
  return theme.fg("muted", truncateToWidth(labels.find(value => visibleWidth(value) <= width) ?? labels.at(-1)!, width, ""));
}
