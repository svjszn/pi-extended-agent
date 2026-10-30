import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/** Trust our storage tools by their extension origin, never just a convenient tool name. */
export function isWorkspaceTool(name: string, tools: readonly Pick<ToolInfo, "name" | "sourceInfo">[]) {
  if (name !== "project_memory" && name !== "update_plan") return false;
  const source = tools.find((tool) => tool.name === name)?.sourceInfo?.path;
  if (!source) return false;
  return ["workspace.js", "workspace.ts"].some((file) => resolve(source) === resolve(fileURLToPath(new URL(`../extensions/${file}`, import.meta.url))));
}
export function isWorkspaceBookkeeping(name: string, input: unknown, tools: readonly Pick<ToolInfo, "name" | "sourceInfo">[]) {
  return isWorkspaceTool(name, tools) && (name === "update_plan" || ["list", "read"].includes(String((input as { action?: unknown })?.action)));
}
