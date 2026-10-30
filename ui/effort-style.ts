import { getAppearance } from "../lib/appearance.js";
import { EFFORT_COLORS } from "./theme.js";

export const animatedEffort = (level: string) => ["high", "xhigh", "max"].includes(level);

/** Terminal glow: vary color, never glyph widths or the surrounding layout. */
export function effortGlow(level: string, text: string, seconds: number, offset = 0) {
  if (!animatedEffort(level)) return text;
  const light = getAppearance().mode === "light";
  const rgb = (hue: number, saturation: number, luminance: number) => {
    const chroma = (1 - Math.abs(2 * luminance - 1)) * saturation;
    const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
    const values = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x]
      : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
    return values.map((value) => Math.round((value + luminance - chroma / 2) * 255));
  };
  return Array.from(text).map((character, index) => {
    const position = index + offset;
    const pulse = (Math.sin(seconds * 3 - position * 0.55) + 1) / 2;
    const hex = level === "xhigh" ? EFFORT_COLORS.effortXhigh : EFFORT_COLORS.effortHigh;
    const wave = Math.sin(seconds * 3 - position * 1.15);
    const color = level === "max"
      ? rgb(((seconds * 65 + position * 38) % 360 + 360) % 360, 0.8, light ? 0.22 + pulse * 0.04 : 0.68 + pulse * 0.16)
      : [1, 3, 5].map((offset) => {
        const base = Number.parseInt(hex.slice(offset, offset + 2), 16);
        return Math.round(wave < 0 ? base * (1 + wave * 0.35) : base + (255 - base) * wave * 0.8);
      });
    return `\x1b[38;2;${color.join(";")}m${character}\x1b[39m`;
  }).join("");
}
