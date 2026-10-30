import { StateFiles } from "./project-state.js";
import { join } from "node:path";

export const ACCENT_COLORS = Object.freeze({
  yellow: "#FFC107", green: "#4EBA65", blue: "#B1B9F9", purple: "#AF87FF",
});
export type AccentColor = "default" | keyof typeof ACCENT_COLORS;
export interface Appearance { mode: "dark" | "light"; color: AccentColor }
const isAccentColor = (value: unknown): value is AccentColor => typeof value === "string"
  && (value === "default" || Object.hasOwn(ACCENT_COLORS, value));
export const DEFAULT_APPEARANCE: Readonly<Appearance> = Object.freeze({ mode: "dark", color: "default" });
const key = Symbol.for("pi-extended-agent.appearance");
interface AppearanceState { value: Appearance; listeners: Set<() => void> }
// Native adapters and jiti-loaded extensions must see the same live palette.
const globals = globalThis as typeof globalThis & { [key]?: AppearanceState };
const state = globals[key] ??= { value: { ...DEFAULT_APPEARANCE }, listeners: new Set() };
export const getAppearance = (): Readonly<Appearance> => state.value;
export function setAppearance(value: Appearance) {
  if (!["dark", "light"].includes(value.mode) || !isAccentColor(value.color)) throw new Error("Invalid appearance.");
  state.value = { ...value };
  for (const listener of state.listeners) listener();
}
export function onAppearanceChange(listener: () => void) {
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}
export class AppearanceStore {
  private readonly files: StateFiles;
  constructor(agentDir: string) { this.files = new StateFiles(join(agentDir, "pi-extended")); }
  read(): Appearance {
    const text = this.files.read("appearance.json", 1024);
    if (!text) return { ...DEFAULT_APPEARANCE };
    const value = JSON.parse(text);
    return { mode: value?.mode === "light" ? "light" : "dark", color: isAccentColor(value?.color) ? value.color : "default" };
  }
  write(value: Appearance) { this.files.write("appearance.json", JSON.stringify(value, null, 2) + "\n"); }
}
