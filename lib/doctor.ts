import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizePermissionMode, PERMISSIONS_ENTRY, readPermissionMode } from "./permissions.js";
import { isPlanning, PLAN_ENTRY, PlanStore } from "./plan.js";
import type { Plan } from "./plan.js";
import { projectFiles } from "./project-state.js";
import { hasModel } from "./startup.js";

export interface DoctorCheck {
  id: string;
  title: string;
  status: "ok" | "warn" | "error";
  message: string;
  action?: string;
}
export interface DoctorReport {
  schemaVersion: 1;
  platform: string;
  architecture: string;
  locations: { package: string; profile: string; runtime: string };
  checks: DoctorCheck[];
  summary: { ok: number; warnings: number; errors: number };
}

/** Session metadata only: no provider calls, credential resolution or transcript reads. */
export function sessionDoctorChecks(ctx: ExtensionContext, agentDir: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push(hasModel(ctx.model)
    ? { id: "session.model", title: "Model", status: "ok", message: "A model is selected. Provider connectivity and credentials were not checked." }
    : { id: "session.model", title: "Model", status: "warn", message: "No model is selected.", action: "Use /login to connect a provider, then /model to choose a model." });
  checks.push({ id: "session.trust", title: "Project trust", status: "ok", message: ctx.isProjectTrusted() ? "Project resources are trusted." : "Project resources are untrusted and remain restricted." });
  try {
    const entries = ctx.sessionManager.getEntries();
    const permission = entries.findLast(entry => entry.type === "custom" && entry.customType === PERMISSIONS_ENTRY);
    const mode = permission?.type === "custom" ? (permission.data as { mode?: unknown } | undefined)?.mode : undefined;
    checks.push(permission && !normalizePermissionMode(mode)
      ? { id: "session.permissions", title: "Permissions", status: "error", message: "The saved permission mode is invalid.", action: "Select a mode explicitly with /permissions before continuing." }
      : { id: "session.permissions", title: "Permissions", status: "ok", message: `Current mode: ${readPermissionMode(entries)}.` });
    const marker = entries.findLast(entry => entry.type === "custom" && entry.customType === PLAN_ENTRY);
    if (marker?.type === "custom") {
      const plan = new PlanStore(projectFiles(ctx.cwd, agentDir), ctx.sessionManager.getSessionId()).read();
      const active = isPlanning(marker.data as Plan | undefined) || (marker.data as Plan | undefined)?.status === "executing";
      checks.push(!plan && active
        ? { id: "session.plan", title: "Plan state", status: "error", message: "The active plan file is missing.", action: "Use /plan cancel or start a new plan; execution still needs explicit approval." }
        : { id: "session.plan", title: "Plan state", status: "ok", message: plan ? `Saved plan: ${plan.status}.` : "No active plan." });
    } else checks.push({ id: "session.plan", title: "Plan state", status: "ok", message: "No active plan." });
  } catch {
    checks.push({ id: "session.state", title: "Session state", status: "error", message: "Session policy or plan state could not be read.", action: "Inspect the active profile and /permissions; do not assume an earlier plan was approved." });
  }
  return checks;
}

export function doctorText(report: DoctorReport): string[] {
  return ["Pi Extended Agent doctor", `${report.platform} / ${report.architecture}`, "",
    ...report.checks.flatMap(check => [`[${check.status.toUpperCase()}] ${check.title}: ${check.message}`, ...(check.action ? [`  Next: ${check.action}`] : []), ""]),
    `Summary: ${report.summary.ok} OK, ${report.summary.warnings} warnings, ${report.summary.errors} errors.`, "",
    `Package: ${report.locations.package}`, `Profile: ${report.locations.profile}`, `Runtime: ${report.locations.runtime}`, "",
    "Local checks only. No files changed, credentials read, provider requests or engine code execution."];
}
