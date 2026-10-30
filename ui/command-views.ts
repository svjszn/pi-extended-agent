import { homedir } from "node:os";
import type { UsageReport } from "../lib/usage.js";
import type { ActivityReport, ActivityStats } from "../lib/activity.js";
import type { ConfigSection } from "../lib/config.js";
import type { Palette, Measure } from "./types.js";
import type { Period } from "./command-panel.js";

const text = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
const number = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
const shortDate = (date: Date) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
const configValue = (value: unknown) => {
  const raw = text(value), home = homedir();
  return raw === home || raw.startsWith(`${home}/`) || raw.startsWith(`${home}\\`) ? `~${raw.slice(home.length)}` : raw;
};

function alignPair(left: string, right: string, width: number, measure?: Measure) {
  const length = (value: string) => measure ? measure.visibleWidth(value) : value.length;
  const gap = width - length(left) - length(right);
  return gap >= 2 ? [left + " ".repeat(gap) + right] : [left, right];
}

export function usageLines(data: UsageReport, width: number, theme: Palette, measure?: Measure) {
  const lines = [theme.fg("muted", text(data.provider || "Provider usage")), ""];
  if (data.unavailable) return [...lines, data.unavailable];
  for (const limit of data.limits || []) {
    const size = Math.max(1, width);
    const filled = Math.round(size * limit.remaining / 100);
    const date = new Date(limit.resetsAt ?? NaN);
    const reset = limit.resetsAt !== null && !Number.isNaN(date.getTime())
      ? `Resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date)}`
      : "Reset time unavailable";
    lines.push(...alignPair(theme.fg("text", theme.bold(text(limit.name))),
      theme.fg("primary", `${number(limit.remaining)}% left`), width, measure),
      theme.fg("primary", "█".repeat(filled)) + theme.fg("track", "░".repeat(size - filled)),
      theme.fg("muted", reset), "");
  }
  lines.push(theme.fg("dim", "Reset times are shown in your local time."));
  return lines;
}

const compact = (value?: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0).toLowerCase();
const duration = (milliseconds = 0) => {
  const minutes = Math.floor(milliseconds / 60000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", rest ? `${rest}m` : ""].filter(Boolean).join(" ");
};
const modelName = (id?: string | null) => {
  if (!id) return "—";
  if (id.startsWith("gpt-")) return id.split("-").map((part, i) => i ? part[0].toUpperCase() + part.slice(1) : "GPT").join("-");
  return id.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2").split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
};

export function activityLines(data: ActivityReport, width: number, theme: Palette, measure?: Measure, { period = "all" }: { period?: Period } = {}) {
  const values = data.days.map((day) => day.tokens || day.count);
  const counts = new Map<string, number>(data.days.map((day, i) => [day.key, values[i]]));
  const peak = Math.max(1, ...values);
  const last = data.days[data.days.length - 1].key;
  const today = new Date(`${last}T12:00:00Z`);
  const sunday = new Date(today);
  sunday.setUTCDate(today.getUTCDate() - today.getUTCDay());
  const weeks = Math.max(1, Math.min(53, width - 4));
  const start = new Date(sunday);
  start.setUTCDate(sunday.getUTCDate() - (weeks - 1) * 7);
  const key = (date: Date) => date.toISOString().slice(0, 10);
  const level = (count: number) => count === 0 ? 0 : Math.max(1, Math.ceil(count / peak * 4));
  const lines: string[] = [];
  const months: string[] = Array(weeks).fill(" ");
  let previousMonth: number | undefined;
  for (let week = 0; week < weeks; week++) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + week * 7);
    if (date.getUTCMonth() !== previousMonth) {
      const name = date.toLocaleString("en", { month: "short", timeZone: "UTC" });
      if (!(week === 0 && date.getUTCDate() > 7) && week + name.length <= months.length) months.splice(week, name.length, ...name);
      previousMonth = date.getUTCMonth();
    }
  }
  lines.push(theme.fg("muted", `    ${months.join("")}`));
  for (let day = 0; day < 7; day++) {
    let row = theme.fg("muted", ["    ", "Mon ", "    ", "Wed ", "    ", "Fri ", "    "][day]);
    for (let week = 0; week < weeks; week++) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + week * 7 + day);
      const dateKey = key(date);
      const count = counts.get(dateKey);
      row += count === undefined ? " " : theme.fg(count ? `activity${level(count)}` : "dim", count ? "█" : "·");
    }
    lines.push(row);
  }
  const legend = theme.fg("muted", "    Less ") + [1, 2, 3, 4].map((step) => theme.fg(`activity${step}`, "█ ")).join("") + theme.fg("muted", "More");
  lines.push("", legend, "", [["all", "All time"], ["week", "Last 7 days"], ["month", "Last 30 days"]]
    .map(([id, label]) => id === period ? theme.fg("primary", theme.bold(label)) : theme.fg("dim", label)).join(theme.fg("dim", " · ")), "");
  const stats: Partial<ActivityStats> = data.periods?.[period] || { activeDays: data.activeDays, dayCount: 365, streak: data.streak, longestStreak: data.streak };
  const metric = (label: string, value: unknown) => theme.fg("muted", `${label}: `) + theme.fg("primary", text(value));
  const daysText = (count = 0) => `${count} ${count === 1 ? "day" : "days"}`;
  const left = [metric("Favorite model", modelName(stats.favoriteModel)), "", metric("Sessions", number(stats.sessions || 0)),
    metric("Active days", `${stats.activeDays}/${stats.dayCount}`), metric("Most active day", stats.mostActiveDay ? shortDate(new Date(`${stats.mostActiveDay}T12:00:00`)) : "—")];
  const right = [metric("Total tokens", stats.hasUsage ? compact(stats.totalTokens) : "Not recorded"), "",
    metric("Longest session", stats.sessions ? duration(stats.longestSession) : "—"), metric("Longest streak", daysText(stats.longestStreak)), metric("Current streak", daysText(stats.streak))];
  const visible = (value: string) => measure ? measure.visibleWidth(value) : value.length;
  const widestLeft = Math.max(...left.map(visible)), widestRight = Math.max(...right.map(visible));
  if (width >= 60 && widestLeft + widestRight + 3 <= width) {
    const column = Math.max(widestLeft + 3, Math.min(Math.floor(width / 2), width - widestRight));
    for (let i = 0; i < left.length; i++) lines.push(left[i] + " ".repeat(Math.max(0, column - visible(left[i]))) + right[i]);
  } else lines.push(...left, "", ...right);
  lines.push(stats.hasUsage ? theme.fg("dim", `Input ${compact(stats.input)}  Output ${compact(stats.output)}  Cache read ${compact(stats.cacheRead)}  Cache write ${compact(stats.cacheWrite)}`)
    : theme.fg("dim", "Token usage has not been recorded yet."));
  if (data.skipped) lines.push(theme.fg("warning", `${data.skipped} unreadable session file(s) skipped.`));
  return lines;
}

export function configLines(sections: ConfigSection[], width: number, theme: Palette, measure?: Measure) {
  const lines = [theme.fg("muted", "Your agent preferences"), ""];
  const labelWidth = Math.max(...sections.flatMap((section) => section.rows.map(([label]) => label.length)));
  for (const section of sections) {
    lines.push(theme.fg("primary", theme.bold(section.title)));
    for (const [label, value] of section.rows) {
      if (width < 40) {
        lines.push(theme.fg("muted", label), theme.fg("text", `  ${configValue(value)}`));
        continue;
      }
      const prefix = labelWidth + 2;
      const values = measure ? measure.wrapTextWithAnsi(configValue(value), Math.max(1, width - prefix)) : [configValue(value)];
      for (const [index, part] of values.entries()) {
        lines.push(theme.fg("muted", (index === 0 ? label : "").padEnd(prefix)) + theme.fg("text", part));
      }
    }
    lines.push("");
  }
  lines.push(theme.fg("dim", "Tab to edit preferences · /model to choose a model · /effort to change effort"));
  return lines;
}
