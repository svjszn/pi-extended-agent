import type { DoctorReport } from "../lib/doctor.js";
import type { Measure, Palette } from "./types.js";

export function doctorLines(report: DoctorReport, width: number, theme: Palette, measure: Measure): string[] {
  const lines = [`${report.summary.ok} OK · ${report.summary.warnings} warnings · ${report.summary.errors} errors`, ""];
  for (const check of report.checks) {
    const role = check.status === "ok" ? "muted" : "warning";
    lines.push(theme.fg(role, `[${check.status.toUpperCase()}] ${check.title}`));
    lines.push(...measure.wrapTextWithAnsi(check.message, Math.max(1, width)).map(line => theme.fg("text", line)));
    if (check.action) lines.push(...measure.wrapTextWithAnsi(`Next: ${check.action}`, Math.max(1, width)).map(line => theme.fg("muted", line)));
    lines.push("");
  }
  for (const [name, location] of Object.entries(report.locations)) {
    lines.push(...measure.wrapTextWithAnsi(`${name}: ${location}`, Math.max(1, width)).map(line => theme.fg("dim", line)));
  }
  lines.push("");
  lines.push(theme.fg("dim", "Local, read-only checks. Credentials and provider connectivity were not checked."),
    theme.fg("dim", "Use pi doctor --json in your terminal for a shareable report."));
  return lines;
}
