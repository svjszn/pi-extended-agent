import { createHash } from "node:crypto";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { boundedText, StateFiles } from "./project-state.js";
import { permissionDecision } from "./permissions.js";

export const PLAN_CHANGED = "pi-extended:plan-changed";
export const PLAN_ENTRY = "pi-extended-plan";
export const PLAN_TOGGLE = "pi-extended:toggle-plan-mode";
export const PLAN_EXECUTION_GUIDANCE = "Execute the user-approved plan under the current permissions. Treat its goal, steps, affected areas, and checks as the agreed scope. Start implementation after only the investigation needed for the next step; reuse the planning findings instead of restarting a general architecture review. Batch independent reads and searches when the available tools support it. Avoid unrelated features, refactors, and audits unless requested or new evidence makes them necessary. Run focused checks while implementing, then every required repository and plan check. Repeat passing checks when code changed, a failure or new evidence warrants it, or the user requires it. Once the requirements are met and required checks pass, finish with the result and validation; do not expand the task to keep improving it. If a real blocker invalidates the approved scope, explain it and request a revised plan. Use update_plan to track step statuses, keeping only one in progress. Never mark a step complete before verifying it or hide a failed or unavailable check.";
export type StepStatus = "pending" | "in_progress" | "completed";
export interface PlanStep { text: string; status: StepStatus }
export interface Plan {
  version: 1; status: "planning" | "ready" | "paused" | "executing" | "completed" | "cancelled";
  goal: string; steps: PlanStep[]; areas: string[]; checks: string[]; updatedAt: string;
  toolsBefore?: string[];
}
export function validatePlan(value: unknown): Plan {
  const plan = value as Plan;
  if (!plan || plan.version !== 1 || !["planning", "ready", "paused", "executing", "completed", "cancelled"].includes(plan.status)) throw new Error("Invalid saved plan.");
  const result: Plan = { version: 1, status: plan.status, goal: boundedText(plan.goal, "Goal", 4_000),
    steps: [], areas: [], checks: [], updatedAt: String(plan.updatedAt) };
  if (!Array.isArray(plan.steps) || plan.steps.length > 30) throw new Error("A plan may have at most 30 steps.");
  result.steps = plan.steps.map((step) => {
    if (!["pending", "in_progress", "completed"].includes(step.status)) throw new Error("Invalid step status.");
    const text = boundedText(step.text, "Step", 600);
    if (!text) throw new Error("Plan steps cannot be empty.");
    return { text, status: step.status };
  });
  if (result.steps.filter((step) => step.status === "in_progress").length > 1) throw new Error("Only one step can be in progress.");
  for (const name of ["areas", "checks"] as const) {
    if (!Array.isArray(plan[name]) || plan[name].length > 30) throw new Error(`Invalid ${name}.`);
    result[name] = plan[name].map((text) => boundedText(text, name, 600));
  }
  if (plan.toolsBefore !== undefined) {
    if (!Array.isArray(plan.toolsBefore) || plan.toolsBefore.length > 1000) throw new Error("Invalid saved tool selection.");
    result.toolsBefore = plan.toolsBefore.map((name) => boundedText(name, "Tool name", 200));
  }
  return result;
}
export class PlanStore {
  readonly name: string;
  constructor(readonly files: StateFiles, sessionId: string) {
    this.name = `plans/${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`;
  }
  read(): Plan | undefined {
    const text = this.files.read(this.name, 256_000);
    return text ? validatePlan(JSON.parse(text)) : undefined;
  }
  save(plan: Plan) { const value = validatePlan({ ...plan, updatedAt: new Date().toISOString() }); this.files.write(this.name, JSON.stringify(value, null, 2)); return value; }
}
export function isPlanning(plan?: Plan) { return plan?.status === "planning" || plan?.status === "ready"; }
export function canPlanRead(name: string, tools: readonly Pick<ToolInfo, "name" | "sourceInfo">[]) {
  return permissionDecision("read-only", name, tools) === "allow";
}
export function renderPlan(plan: Plan) {
  const marks = { pending: " ", in_progress: "~", completed: "x" };
  return `# Goal\n${plan.goal}\n\n# Steps\n${plan.steps.map((s) => `- [${marks[s.status]}] ${s.text}`).join("\n")}\n\n# Affected areas\n${plan.areas.map((s) => `- ${s}`).join("\n")}\n\n# Checks\n${plan.checks.map((s) => `- ${s}`).join("\n")}\n`;
}
export function parsePlan(text: string, previous: Plan): Plan {
  let section = ""; const goal: string[] = [], steps: PlanStep[] = [], areas: string[] = [], checks: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^# /.test(line)) { section = line.slice(2).trim().toLowerCase(); continue; }
    if (section === "goal") goal.push(line);
    else if (section === "steps" && line.trim()) {
      const match = line.match(/^- \[([ xX~])\] (.+)$/);
      if (!match) throw new Error("Use - [ ] step, - [~] in progress, or - [x] completed in Steps.");
      steps.push({ text: match[2], status: match[1] === "~" ? "in_progress" : /x/i.test(match[1]) ? "completed" : "pending" });
    } else if (section === "affected areas" && line.trim()) areas.push(line.replace(/^-\s*/, ""));
    else if (section === "checks" && line.trim()) checks.push(line.replace(/^-\s*/, ""));
  }
  return validatePlan({ ...previous, goal: goal.join("\n").trim(), steps, areas, checks, status: steps.length ? "ready" : "planning" });
}
