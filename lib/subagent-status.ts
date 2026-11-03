import type { SubagentProgress } from "./subagent.js";
import { cleanText } from "./project-state.js";

interface Activity { name: string; note: string; toolCalls: number; started: number }
export interface SubagentStatus extends Omit<Activity, "started"> { elapsedMs: number; additionalRuns: number }
const key = Symbol.for("pi-extended-agent.subagent-status");
const globals = globalThis as typeof globalThis & {
  [key]?: { runs: Map<symbol, Activity>; listeners: Set<() => void> };
};
const state = globals[key] ??= { runs: new Map(), listeners: new Set() };
const plain = (text: string) => cleanText(text).replace(/\s+/g, " ").slice(0, 100);
const changed = () => { for (const listener of state.listeners) listener(); };

/** Ephemeral metadata shared by extensions and the mounted editor, never session messages. */
export function beginSubagentStatus(agent: string, now = Date.now) {
  const id = Symbol(), activity: Activity = { name: plain(agent), note: "Starting", toolCalls: 0, started: now() };
  state.runs.set(id, activity); changed();
  return {
    update(note: string, progress?: SubagentProgress) {
      if (!state.runs.has(id)) return;
      activity.note = plain(note);
      if (progress && Number.isFinite(progress.toolCalls)) activity.toolCalls = Math.max(0, Math.floor(progress.toolCalls));
      changed();
    },
    dispose() { if (state.runs.delete(id)) changed(); },
  };
}

/** Keep one stable run in the Working slot; completing another cannot replace it. */
export function activeSubagentStatus(now = Date.now()): SubagentStatus | undefined {
  const activity = [...state.runs.values()].at(-1);
  if (!activity) return;
  return { name: activity.name, note: activity.note, toolCalls: activity.toolCalls,
    elapsedMs: Math.max(0, now - activity.started), additionalRuns: state.runs.size - 1 };
}

export function onSubagentStatusChange(listener: () => void) {
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}
