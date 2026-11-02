import { DEFAULT_FLASH_MS, clearFlash, showFlash } from "../lib/flash-status.js";

/** The alternate screen owns `flash`; it is not part of Pi's public TUI type. */
export interface FlashHost { flash?(message: string, durationMs?: number): void }

/**
 * Pi confirms a copy-on-select in the alternate screen's own flash stack, in the
 * top right corner. Route those notices to the input corner instead, where this
 * interface already shows effort and update information, and leave the rest of
 * the renderer untouched. Nothing is suppressed when the corner cannot show it.
 */
export function captureFlashes(host: FlashHost, onChange?: () => void) {
  const native = host.flash;
  if (typeof native !== "function") return undefined;
  const own = Object.getOwnPropertyDescriptor(host, "flash");
  const relocated = (message: string, durationMs = DEFAULT_FLASH_MS) => {
    showFlash(message, durationMs);
    onChange?.();
  };
  host.flash = relocated;
  return () => {
    clearFlash();
    if (host.flash !== relocated) return;
    if (own) Object.defineProperty(host, "flash", own);
    else Reflect.deleteProperty(host, "flash");
  };
}
