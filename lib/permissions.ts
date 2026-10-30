import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const PERMISSION_MODES = ["full", "ask", "read-only"] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
export const PERMISSIONS_ENTRY = "pi-extended-permissions";
export const PERMISSIONS_CHANGED = "pi-extended:permissions-changed";
export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  full: "Full access", ask: "Ask before actions", "read-only": "Read only",
};
export const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  full: "Run agent tools without permission prompts.",
  ask: "Read and search freely. Confirm shell commands, changes, and external tools.",
  "read-only": "Allow built-in read, find, grep, and ls. Block changes, shell, and external tools.",
};
export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode === value);
}
export function readPermissionMode(entries: readonly { type: string; customType?: string; data?: unknown }[]): PermissionMode {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== PERMISSIONS_ENTRY) continue;
    const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
    if (isPermissionMode(mode)) return mode;
  }
  return "full";
}
export function permissionDecision(mode: PermissionMode, name: string, tools: readonly Pick<ToolInfo, "name" | "sourceInfo">[]): "allow" | "confirm" | "block" {
  if (mode === "full") return "allow";
  const tool = tools.find((candidate) => candidate.name === name);
  const readOnly = ["read", "find", "grep", "ls"].includes(name)
    && tool?.sourceInfo?.source === "builtin" && tool.sourceInfo.path === `builtin:${name}`;
  if (readOnly) return "allow";
  return mode === "ask" ? "confirm" : "block";
}
export function permissionFooter(mode: PermissionMode): string {
  return mode === "full" ? "auto mode" : mode === "ask" ? "ask mode" : "read only";
}
export function permissionRequest(name: string, input: unknown, cwd: string): string[] {
  const clean = (value: string) => value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  return [`Tool: ${clean(name)}`, `Working directory: ${clean(cwd)}`, "", ...clean(JSON.stringify(input, null, 2) ?? "{}").split("\n")];
}
