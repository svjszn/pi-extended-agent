import type { createCodemodeExtension, ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";

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
/** Supply Pi's built-in slot, keeping its identity and configured enable/disable rules. */
export function codeModeBuiltin(createNative: typeof createCodemodeExtension): InlineExtension {
  const factory: ExtensionFactory = (pi) => {
    let enabled = false;
    let stop: (() => void) | undefined;
    const listen = () => {
      stop ??= pi.events.on(CODE_MODE_CHANGED, (data) => {
        const next = (data as { enabled?: boolean })?.enabled === true;
        if (next === enabled) return;
        enabled = next;
        pi.setActiveTools(pi.getActiveTools());
      });
    };
    listen();
    pi.on("session_start", (_event, ctx) => {
      listen();
      enabled = readCodeMode(ctx.sessionManager.getEntries()).enabled;
    });
    pi.on("session_shutdown", () => { stop?.(); stop = undefined; enabled = false; });
    return createNative()({ ...pi, getSettings() {
      const settings = pi.getSettings();
      return enabled ? { ...settings, codemode: { ...settings.codemode, mode: "on" } } : settings;
    } });
  };
  return { name: "codemode", builtin: true, replaceable: true, factory };
}
