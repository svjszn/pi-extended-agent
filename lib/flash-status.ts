// Transient terminal notices, such as the copy-on-select confirmation. Shared
// through globalThis because the native host and the jiti-loaded extensions
// hold separate module instances, like the update and appearance state.
const key = Symbol.for("pi-extended-agent.flash-status");
interface FlashState { message: string; expiresAt: number; listeners: Set<() => void> }
const globals = globalThis as typeof globalThis & { [key]?: FlashState };
const state = globals[key] ??= { message: "", expiresAt: 0, listeners: new Set() };

export const DEFAULT_FLASH_MS = 1_500;

/** Replace any notice still showing: the newest action is the one to report. */
export function showFlash(message: string, durationMs = DEFAULT_FLASH_MS, now = Date.now()) {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text) return;
  state.message = text;
  state.expiresAt = now + Math.max(0, durationMs);
  for (const listener of state.listeners) listener();
}

export function clearFlash() {
  state.message = ""; state.expiresAt = 0;
  for (const listener of state.listeners) listener();
}

/** The notice while it lasts, trimmed to the space the caller can give it. */
export function visibleFlash(width = Infinity, now = Date.now()): string | undefined {
  if (!state.message || now >= state.expiresAt) return undefined;
  return state.message.length <= width ? state.message : undefined;
}

export function flashExpiry(): number {
  return state.message ? state.expiresAt : 0;
}

export function onFlashChange(listener: () => void) {
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}
