import type { Palette } from "../ui/types.js";

// Shared by the bundled host and extensions loaded through jiti.
export const CONFIG_PREFERENCES = Symbol.for("pi-extended-agent.config-preferences");
export interface ConfigPreferences {
  render(width: number, rows: number, theme: Palette): string[];
  handleInput(data: string): void;
  readonly cancelled: boolean;
  readonly hasPendingChange: boolean;
  applyPendingChange(): void;
  dispose(): void;
}
export interface ConfigPreferencesUI {
  [CONFIG_PREFERENCES]?: () => ConfigPreferences;
}
