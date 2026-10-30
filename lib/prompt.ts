import { join } from "node:path";
import { boundedText, StateFiles } from "./project-state.js";

export const PROMPT_ENTRY = "pi-extended-prompt";
export const PROMPT_SCOPES = ["session", "project", "global"] as const;
export type PromptScope = typeof PROMPT_SCOPES[number];
export function isPromptScope(value: string): value is PromptScope { return PROMPT_SCOPES.some((scope) => scope === value); }
export function sessionPrompt(entries: readonly { type: string; customType?: string; data?: unknown }[]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === PROMPT_ENTRY) return boundedText((entry.data as { text: unknown }).text, "Session prompt", 12_000);
  }
  return "";
}
export class PromptStore {
  constructor(readonly project: StateFiles, readonly agentDir: string) {}
  read(scope: "project" | "global") {
    return boundedText(this.files(scope).read("prompt.md", 12_000) ?? "", "Prompt additions", 12_000);
  }
  write(scope: "project" | "global", value: string) { this.files(scope).write("prompt.md", boundedText(value, "Prompt additions", 12_000)); }
  private files(scope: "project" | "global") { return scope === "project" ? this.project : new StateFiles(join(this.agentDir, "pi-extended")); }
}

export function promptAdditions(global: string, project: string, session: string) {
  return [["Global additions", global], ["Project additions", project], ["Session additions", session]]
    .filter(([, text]) => text.trim()).map(([label, text]) => `${label}:\n${text}`).join("\n\n");
}
