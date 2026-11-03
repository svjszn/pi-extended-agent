import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { readCodeMode } from "./code-mode.js";
import type { WorkMode } from "./code-mode.js";
import { isPlanning, PLAN_ENTRY } from "./plan.js";
import type { Plan } from "./plan.js";
import { hasModel } from "./startup.js";
import { readPermissionMode } from "./permissions.js";
import type { PermissionMode } from "./permissions.js";

export const SESSION_PREFERENCES_ENTRY = "pi-extended-session-preferences";
export interface SessionPreferences {
  model?: { provider: string; id: string };
  effort: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  mode: WorkMode;
  permissions: PermissionMode;
}

export function sessionPreferences(ctx: ExtensionContext, pi: ExtensionAPI): SessionPreferences {
  const entries = ctx.sessionManager.getEntries();
  const plan = entries.findLast((entry) => entry.type === "custom" && entry.customType === PLAN_ENTRY);
  const planning = plan?.type === "custom" && isPlanning(plan.data as Plan | undefined);
  return {
    model: hasModel(ctx.model) ? { provider: ctx.model!.provider, id: ctx.model!.id } : undefined,
    effort: pi.getThinkingLevel(), mode: planning ? "plan" : readCodeMode(entries).enabled ? "code" : "auto",
    permissions: readPermissionMode(entries),
  };
}

export function initialWorkMode(entries: readonly SessionEntry[]): WorkMode | undefined {
  const entry = entries.findLast((entry) => entry.type === "custom" && entry.customType === SESSION_PREFERENCES_ENTRY);
  const mode = entry?.type === "custom" ? (entry.data as Partial<SessionPreferences> | undefined)?.mode : undefined;
  return mode === "auto" || mode === "plan" || mode === "code" ? mode : undefined;
}

// Replacement factories can be loaded in separate jiti module instances. Keep
// the handoff in memory, scoped to the profile, cwd and outgoing session file.
const key = Symbol.for("pi-extended-agent.session-preferences");
const globals = globalThis as typeof globalThis & { [key]?: Map<string, SessionPreferences> };
const pending = globals[key] ??= new Map();
export function preferenceHandoffKey(agentDir: string, cwd: string, previousSessionFile?: string) {
  const path = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return JSON.stringify([path(agentDir), path(cwd), previousSessionFile ? path(previousSessionFile) : null]);
}
export function handoffPreferences(key: string, preferences: SessionPreferences) {
  if (pending.has(key)) throw new Error("A new session is already being created.");
  pending.set(key, preferences);
  return () => { if (pending.get(key) === preferences) pending.delete(key); };
}
export function takePreferences(key: string) {
  const value = pending.get(key);
  pending.delete(key);
  return value;
}
