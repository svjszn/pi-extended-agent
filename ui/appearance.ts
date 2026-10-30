import type { Theme, ThemeBg, ThemeColor, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { colorToHex } from "@earendil-works/pi-tui";
import type { Terminal, TerminalColors } from "@earendil-works/pi-tui";
import { getAppearance, onAppearanceChange } from "../lib/appearance.js";
import type { Appearance } from "../lib/appearance.js";
import { appearanceColors } from "./theme.js";

export function nativeAppearanceTheme(ui: Pick<ExtensionUIContext, "getTheme">, appearance: Appearance) {
  const base = ui.getTheme(appearance.mode);
  if (!base) throw new Error(`The Pi engine does not provide the ${appearance.mode} theme.`);
  const palette = appearanceColors(appearance.mode, appearance.color);
  const neutral = appearanceColors(appearance.mode, "default");
  const values = Object.fromEntries(Object.entries(base.colors).map(([token, color]) => {
    let value: string = palette.primary;
    if (token.endsWith("Bg")) value = /userMessage/.test(token) ? palette.userMessage
      : /selected|searchMatch/.test(token) ? neutral.userMessage : palette.background;
    else if (/muted|thinkingText|scrollbarTrack/i.test(token)) value = palette.muted;
    else if (/dim/i.test(token)) value = palette.dim;
    else if (/^syntax|^toolDiff/.test(token)) value = colorToHex(color);
    return [token, value];
  }));
  // The CLI bundle and SDK can expose distinct Theme constructors. Use the
  // host's returned theme so its setTheme(instance) check accepts this instance.
  const HostTheme = base.constructor as typeof Theme;
  return new HostTheme(values as Record<ThemeColor, string>, values as Record<ThemeBg, string>, base.getColorMode(), {
    name: appearance.mode, appearance: appearance.mode,
  });
}

interface TerminalUI {
  terminal: Pick<Terminal, "write">;
  queryTerminalColors?(options: { timeoutMs: number }): Promise<TerminalColors>;
  requestRender(force?: boolean): void;
  invalidate?(): void;
}

/** Set the actual terminal canvas, restoring the shell's colors on shutdown. */
export function mountAppearanceTerminal(tui: TerminalUI) {
  let disposed = false, applied = false, original: TerminalColors = {};
  const osc = (slot: number, value: string) => `\x1b]${slot};${value}\x07`;
  const apply = () => {
    if (disposed) return;
    const palette = appearanceColors();
    tui.terminal.write(osc(10, palette.text) + osc(11, palette.background));
    applied = true;
    tui.invalidate?.(); tui.requestRender(true);
  };
  const ready = Promise.resolve().then(() => tui.queryTerminalColors?.({ timeoutMs: 100 }) ?? {}).catch(() => ({} as TerminalColors))
    .then((colors) => { original = colors; if (!disposed) apply(); });
  const unsubscribe = onAppearanceChange(() => { void ready.then(apply); });
  const rgb = (color: { r: number; g: number; b: number }) => "#" + [color.r, color.g, color.b].map((part) => part.toString(16).padStart(2, "0")).join("");
  const dispose = () => {
    if (disposed) return;
    disposed = true; unsubscribe(); process.off("exit", dispose);
    if (applied) tui.terminal.write((original.foreground ? osc(10, rgb(original.foreground)) : "\x1b]110\x07")
      + (original.background ? osc(11, rgb(original.background)) : "\x1b]111\x07"));
  };
  process.once("exit", dispose);
  return { ready, dispose };
}
