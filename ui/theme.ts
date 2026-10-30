// The primary color is shared by the command screens. A future /theme command
// can supply a different primary without changing their layout or renderers.
export const UI_COLORS = Object.freeze({
  primary: "#ffffff",
  text: "#ededed",
  muted: "#a3a3a3",
  dim: "#737373",
  border: "#737373",
  track: "#3d3d3d",
  userMessage: "#202020",
});

export function createUiTheme({ primary = UI_COLORS.primary, color = true }: { primary?: string; color?: boolean } = {}) {
  if (!/^#[0-9a-f]{6}$/i.test(primary)) primary = UI_COLORS.primary;
  const rgb = (hex: string) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const tint = (amount: number) => rgb(primary).map((channel) => Math.round(channel * amount));
  const colors: Record<string, number[]> = {
    ...Object.fromEntries(Object.entries(UI_COLORS).map(([name, hex]) => [name, rgb(hex)])),
    primary: rgb(primary), accent: rgb(primary), warning: rgb(primary),
    activity1: tint(0.4), activity2: tint(0.6), activity3: tint(0.8), activity4: tint(1),
  };
  return {
    fg(role: string, value: string) {
      if (!color || !value) return value;
      return `\x1b[38;2;${(colors[role] || colors.text).join(";")}m${value}\x1b[39m`;
    },
    bg(role: string, value: string) {
      if (!color || !value) return value;
      return `\x1b[48;2;${(colors[role] || colors.userMessage).join(";")}m${value}\x1b[49m`;
    },
    bold: (value: string) => color ? `\x1b[1m${value}\x1b[22m` : value,
  };
}
