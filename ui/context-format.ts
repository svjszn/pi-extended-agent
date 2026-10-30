export function contextTokens(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value).toLowerCase();
}

export function contextPercent(value: number): string {
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value)}%`;
}
