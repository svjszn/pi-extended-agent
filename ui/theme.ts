import { ACCENT_COLORS, getAppearance } from "../lib/appearance.js";
import type { Appearance } from "../lib/appearance.js";

export const EFFORT_COLORS = Object.freeze({
  effortLow: ACCENT_COLORS.yellow,
  effortMedium: ACCENT_COLORS.green,
  effortHigh: ACCENT_COLORS.blue,
  effortXhigh: ACCENT_COLORS.purple,
});

export const UI_COLORS = Object.freeze({
  primary: "#ffffff",
  text: "#ededed",
  muted: "#a3a3a3",
  dim: "#737373",
  border: "#737373",
  track: "#3d3d3d",
  userMessage: "#202020",
  background: "#000000",
  ...EFFORT_COLORS,
});

export const LIGHT_COLORS = Object.freeze({
  primary: "#171717", text: "#171717", muted: "#525252", dim: "#737373",
  border: "#737373", track: "#e5e5e5", userMessage: "#f0f0f0", background: "#ffffff",
  ...EFFORT_COLORS,
});

const rgb = (hex: string) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
const blend = (ink: string, background: string, amount: number) => rgb(ink)
  .map((channel, index) => Math.round(channel * amount + rgb(background)[index] * (1 - amount)));
const hex = (channels: number[]) => "#" + channels.map((channel) => channel.toString(16).padStart(2, "0")).join("");

export function appearanceColors(mode = getAppearance().mode, color = getAppearance().color) {
  const base = mode === "light" ? LIGHT_COLORS : UI_COLORS;
  const accent = color === "default" ? base.primary : ACCENT_COLORS[color];
  return { ...base, ...ACCENT_COLORS, accent, logo: accent, inputBorder: accent,
    userMessage: color === "default" ? base.userMessage : hex(blend(accent, base.background, 0.12)) };
}

export function inputBorderColor() {
  return appearanceColors().inputBorder;
}

/** Light box-drawing rules with faint intensity, independent of text weight. */
export const faintInputRule = (value: string) => `\x1b[22;2m${value}\x1b[22m`;

export function createUiTheme({ primary, color = true }: { primary?: string; color?: boolean } = {}) {
  if (primary && !/^#[0-9a-f]{6}$/i.test(primary)) primary = undefined;
  let cachedFor: Readonly<Appearance> | undefined;
  let cachedColors: Record<string, number[]>;
  const colors = (): Record<string, number[]> => {
    const preferences = getAppearance();
    if (preferences === cachedFor) return cachedColors;
    const base = appearanceColors();
    const ink = primary ?? base.primary;
    const tint = (amount: number) => blend(primary ?? base.accent, base.background, amount);
    cachedFor = preferences;
    return cachedColors = { ...Object.fromEntries(Object.entries(base).map(([name, hex]) => [name, rgb(hex)])),
      primary: rgb(ink), warning: rgb(ink),
      activity1: tint(0.4), activity2: tint(0.6), activity3: tint(0.8), activity4: tint(1) };
  };
  return {
    fg(role: string, value: string) {
      if (!color || !value) return value;
      const palette = colors();
      return `\x1b[38;2;${(palette[role] || palette.text).join(";")}m${value}\x1b[39m`;
    },
    bg(role: string, value: string) {
      if (!color || !value) return value;
      const palette = colors();
      return `\x1b[48;2;${(palette[role] || palette.userMessage).join(";")}m${value}\x1b[49m`;
    },
    bold: (value: string) => color ? `\x1b[1m${value}\x1b[22m` : value,
  };
}
