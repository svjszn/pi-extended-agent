export const CODE_MODE_ENTRY = "pi-extended-code-mode";
export const CODE_MODE_CHANGED = "pi-extended:code-mode-changed";
export type WorkMode = "auto" | "plan" | "code";
export interface CodeModeState { enabled: boolean; added: boolean }

/** Session metadata stores only our activation, never a permission grant. */
export function readCodeMode(entries: readonly { type: string; customType?: string; data?: unknown }[]): CodeModeState {
  const entry = entries.findLast((entry) => entry.type === "custom" && entry.customType === CODE_MODE_ENTRY);
  const value = entry?.data as Partial<CodeModeState> | undefined;
  return { enabled: value?.enabled === true, added: value?.added === true };
}
