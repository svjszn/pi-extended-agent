import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

type Tools = readonly Pick<ToolInfo, "name" | "sourceInfo">[];

/** Trust our own tools by their extension origin, never just a convenient tool name. */
function fromExtension(name: string, tools: Tools, extension: string) {
  const source = tools.find((tool) => tool.name === name)?.sourceInfo?.path;
  if (!source) return false;
  return [`${extension}.js`, `${extension}.ts`].some((file) =>
    resolve(source) === resolve(fileURLToPath(new URL(`../extensions/${file}`, import.meta.url))));
}
export function isWorkspaceTool(name: string, tools: Tools) {
  if (name !== "project_memory" && name !== "update_plan") return false;
  return fromExtension(name, tools, "workspace");
}
export function isWorkspaceBookkeeping(name: string, input: unknown, tools: Tools) {
  return isWorkspaceTool(name, tools) && (name === "update_plan" || ["list", "read"].includes(String((input as { action?: unknown })?.action)));
}
/**
 * Delegation passes the parent's plan and deny barriers because the subagent
 * carries them itself: its own guard clamps it to read and search tools, and any
 * call beyond that is blocked inside the subagent rather than at this boundary.
 */
export function isDelegationTool(name: string, tools: Tools) {
  return name === "task" && fromExtension(name, tools, "agents");
}

/** Asking collects information only; it never grants permissions or approves a plan. */
export function isUserQuestionTool(name: string, tools: Tools) {
  return name === "ask_user" && fromExtension(name, tools, "ask-user");
}
