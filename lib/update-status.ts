import type { ReleaseUpdate } from "./update-notice.js";

const key = Symbol.for("pi-extended-agent.update-status");
const globals = globalThis as typeof globalThis & { [key]?: { updates: readonly ReleaseUpdate[]; showUpdate: boolean } };
const state = globals[key] ??= { updates: [], showUpdate: false };

export function setAvailableUpdates(updates: readonly ReleaseUpdate[]) {
  state.updates = [...updates];
  state.showUpdate = false;
}
export function setUpdateNoticeVisible(visible: boolean) { state.showUpdate = visible; }
export function visibleUpdateLabel(width = Infinity): string | undefined {
  return state.showUpdate ? availableUpdateLabel(width) : undefined;
}
export function visibleUpdateVersion(): string | undefined {
  return state.showUpdate ? (state.updates.find((item) => item.kind === "agent") ?? state.updates[0])?.version : undefined;
}
export function availableUpdateLabel(width = Infinity): string | undefined {
  const update = state.updates.find((item) => item.kind === "agent") ?? state.updates[0];
  if (!update || width < 1) return;
  const label = `${update.kind === "agent" ? "Update" : "Pi update"} ${update.version} · ${update.command}`;
  if (label.length <= width) return label;
  const compact = `↑ ${update.version}`;
  return compact.length <= width ? compact : "↑ update";
}
