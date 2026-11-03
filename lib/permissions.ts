import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const PERMISSION_MODES = ["allow", "ask", "deny"] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
export const PERMISSIONS_ENTRY = "pi-extended-permissions";
export const PERMISSIONS_CHANGED = "pi-extended:permissions-changed";
export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  allow: "Allow", ask: "Ask", deny: "Deny",
};
export const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  allow: "Run agent tools without permission prompts.",
  ask: "Read and search freely. Confirm shell commands, changes, and external tools.",
  deny: "Allow built-in read, find, grep, and ls. Block changes, shell, and external tools.",
};
export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode === value);
}
/** Read legacy session values and command aliases without rewriting saved history. */
export function normalizePermissionMode(value: unknown): PermissionMode | undefined {
  if (isPermissionMode(value)) return value;
  if (value === "full") return "allow";
  if (value === "read-only") return "deny";
  return undefined;
}
export function readPermissionMode(entries: readonly { type: string; customType?: string; data?: unknown }[]): PermissionMode {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== PERMISSIONS_ENTRY) continue;
    const mode = normalizePermissionMode((entry.data as { mode?: unknown } | undefined)?.mode);
    if (mode) return mode;
  }
  return "allow";
}
export function permissionDecision(mode: PermissionMode, name: string, tools: readonly Pick<ToolInfo, "name" | "sourceInfo">[]): "allow" | "confirm" | "block" {
  if (mode === "allow") return "allow";
  const tool = tools.find((candidate) => candidate.name === name);
  const readOnly = ["read", "find", "grep", "ls"].includes(name)
    && tool?.sourceInfo?.source === "builtin" && tool.sourceInfo.path === `builtin:${name}`;
  if (readOnly) return "allow";
  return mode === "ask" ? "confirm" : "block";
}
export function permissionFooter(mode: PermissionMode): string {
  return `${mode} mode`;
}
// Review complete input in bounded pages. Never approve an undisplayable tail.
const MAX_REQUEST_TEXT = 256_000;
const REQUEST_PAGE_SIZE = 4_000;
export interface PermissionRequest {
  header: string[];
  pages: string[];
  error?: string;
}
export function permissionRequest(name: string, input: unknown, cwd: string): PermissionRequest {
  const clean = (value: string) => value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  const header = [`Tool: ${clean(name)}`, `Working directory: ${clean(cwd)}`];
  let remaining = MAX_REQUEST_TEXT;
  try {
    const text = JSON.stringify(input, (key, value: unknown) => {
      remaining -= key.length + (typeof value === "string" ? value.length : 1);
      if (remaining < 0) throw new Error("Input exceeds the review limit");
      return value;
    }, 2) ?? "{}";
    if (text.length > MAX_REQUEST_TEXT) throw new Error("Encoded input exceeds the review limit");
    const pages: string[] = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + REQUEST_PAGE_SIZE, text.length);
      // Keep a Unicode surrogate pair on the same page.
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      pages.push(text.slice(start, end)); start = end;
    }
    return { header, pages };
  } catch {
    return { header, pages: [], error: `Cannot review the complete tool input (limit ${MAX_REQUEST_TEXT.toLocaleString("en-US")} characters). The action is denied; request a smaller, JSON-serializable tool call.` };
  }
}
