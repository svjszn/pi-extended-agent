import { getAgentDir, getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { projectFiles, boundedText } from "../lib/project-state.js";
import { MemoryStore, memoryPrompt } from "../lib/memory.js";
import type { MemoryNote } from "../lib/memory.js";
import { PlanStore, isPlanning, canPlanRead, renderPlan, parsePlan, validatePlan, PLAN_CHANGED, PLAN_ENTRY, PLAN_TOGGLE, PLAN_EXECUTION_GUIDANCE } from "../lib/plan.js";
import type { Plan } from "../lib/plan.js";
import { PromptStore, PROMPT_ENTRY, PROMPT_SCOPES, isPromptScope, sessionPrompt, promptAdditions } from "../lib/prompt.js";
import type { PromptScope } from "../lib/prompt.js";
import { isWorkspaceBookkeeping } from "../lib/workspace-tools.js";
import { readPermissionMode, PERMISSION_DESCRIPTIONS } from "../lib/permissions.js";
import type { WorkspacePage } from "../ui/workspace-screen.js";

const string = { type: "string" };
const TASK_WORKFLOW_GUIDANCE = "Keep work within the user's requested scope. When independent reads or searches are already known, batch them using available tools rather than spending one model round trip on each. Return relevant, bounded search results and reuse established findings; reread when edits or new evidence justify it. Preserve dependencies and serialize shared-state mutations. Run required validation, and finish when the requested result and checks are satisfied. Broaden investigation or repeat successful checks when new evidence, changed code, or explicit instructions warrant it. Never bypass permissions or conceal failed or unavailable checks to save time.";
const memorySchema = { type: "object", properties: {
  action: { type: "string", enum: ["list", "read", "save", "delete"] }, id: string, title: string, summary: string, content: string,
}, required: ["action"], additionalProperties: false };
const planSchema = { type: "object", properties: {
  goal: string,
  steps: { type: "array", maxItems: 30, items: { type: "object", properties: {
    text: string, status: { type: "string", enum: ["pending", "in_progress", "completed"] },
  }, required: ["text", "status"], additionalProperties: false } },
  areas: { type: "array", items: string, maxItems: 30 }, checks: { type: "array", items: string, maxItems: 30 },
}, additionalProperties: false };

function notify(ctx: ExtensionContext, text: string, error = false) {
  if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info"); else console.error(text);
}
function result(data: unknown) { return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }], details: {} }; }

async function screen(pi: ExtensionAPI, ctx: ExtensionCommandContext, title: string, pages: WorkspacePage[], hint: string,
  actions: Record<string, string> = {}, initial = 0): Promise<{ action: string; page: number } | undefined> {
  const [{ createWorkspaceScreen }, { createHeader }, { createUiTheme }] = await Promise.all([
    import("../ui/workspace-screen.js"), import("../ui/chrome.js"), import("../ui/theme.js"),
  ]);
  let selected: { action: string; page: number } | undefined;
  await ctx.ui.custom((tui, _theme, _keys, done) => {
    const theme = createUiTheme();
    const measure = { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi };
    const header = createHeader({ mode: "regular" }, measure, {
      version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
    });
    const footer = tui.children.at(-1);
    return createWorkspaceScreen({ title, tui, theme, measure, done, pages, hint, actions, initial,
      onAction: (action, page) => { selected = { action, page }; },
      renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width), onDispose: () => header.dispose(),
    });
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
  return selected;
}
async function edit(pi: ExtensionAPI, ctx: ExtensionCommandContext, title: string, text: string) {
  if (ctx.mode !== "tui") return ctx.hasUI ? ctx.ui.editor(title, text) : undefined;
  const [{ createWorkspaceEditor }, { createHeader }, { createUiTheme }] = await Promise.all([
    import("../ui/workspace-screen.js"), import("../ui/chrome.js"), import("../ui/theme.js"),
  ]);
  let saved: string | undefined;
  await ctx.ui.custom((tui, _theme, _keys, done) => {
    const theme = createUiTheme(), measure = { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi };
    const header = createHeader({ mode: "regular" }, measure, {
      version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
    });
    const footer = tui.children.at(-1);
    return createWorkspaceEditor({ title, text, tui, theme, measure, done, onSave: (value) => { saved = value; },
      renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width), onDispose: () => header.dispose(),
    });
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
  return saved;
}

export default function workspace(pi: ExtensionAPI) {
  let memory: MemoryStore, plans: PlanStore, prompts: PromptStore;
  let sessionAddition = "", activeSession = "", stateError: string | undefined;
  let storageReady = false;
  let plan: Plan | undefined;
  let stopModeShortcut: (() => void) | undefined;
  const announcePlan = () => pi.events.emit(PLAN_CHANGED, { planning: isPlanning(plan), status: plan?.status });
  const enablePlanReaders = () => {
    // Native defaults often expose only read/bash/edit/write. Activate actual search tools
    // while shell is blocked, without re-enabling tools excluded from the registry by the user.
    const readers = pi.getAllTools().filter((tool) => canPlanRead(tool.name, [tool])).map((tool) => tool.name);
    const active = pi.getActiveTools();
    if (readers.some((name) => !active.includes(name))) pi.setActiveTools([...new Set([...active, ...readers])]);
  };
  const initialize = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (activeSession === sessionId && !stateError) return;
    activeSession = sessionId;
    storageReady = false; plan = undefined;
    try {
      const files = projectFiles(ctx.cwd, getAgentDir());
      memory = new MemoryStore(files); plans = new PlanStore(files, sessionId); prompts = new PromptStore(files, getAgentDir()); storageReady = true;
      plan = plans.read(); sessionAddition = sessionPrompt(ctx.sessionManager.getEntries()); stateError = undefined;
      // Session metadata remains a fail-closed marker if the saved plan has gone missing.
      const entries = ctx.sessionManager.getEntries();
      const last = entries.filter((e) => e.type === "custom" && e.customType === PLAN_ENTRY).at(-1);
      if (!plan && last && isPlanning((last as { data?: Plan }).data)) throw new Error("The active plan file is missing. Use /plan cancel or start a new plan.");
      if (isPlanning(plan)) enablePlanReaders();
    } catch (error) { stateError = error instanceof Error ? error.message : String(error); }
    announcePlan();
  };
  const requireState = (ctx: ExtensionContext) => { initialize(ctx); if (stateError) throw new Error(stateError); };
  const savePlan = (value: Plan) => {
    const wasPlanning = isPlanning(plan);
    const saved = plans.save(value);
    plan = saved;
    try { pi.appendEntry(PLAN_ENTRY, saved); stateError = undefined; }
    catch (error) { stateError = `Could not persist plan session metadata: ${String(error)}`; throw error; }
    finally { announcePlan(); }
    if (isPlanning(plan)) enablePlanReaders();
    else if (wasPlanning && plan.toolsBefore) pi.setActiveTools(plan.toolsBefore);
  };
  pi.on("session_start", (_event, ctx) => {
    activeSession = ""; initialize(ctx); if (stateError) notify(ctx, stateError, true);
    stopModeShortcut?.();
    stopModeShortcut = pi.events.on(PLAN_TOGGLE, () => {
      try {
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the current run and queued messages to finish before switching modes.");
        requireState(ctx);
        if (isPlanning(plan)) savePlan({ ...plan!, status: "paused" });
        else {
          const draft = plan && !["completed", "cancelled"].includes(plan.status) ? plan : undefined;
          savePlan({ version: 1, goal: "", steps: [], areas: [], checks: [], updatedAt: "", ...draft,
            status: draft?.steps.length ? "ready" : "planning", toolsBefore: pi.getActiveTools() });
        }
      } catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), true); }
    });
  });
  pi.on("session_shutdown", () => {
    stopModeShortcut?.(); stopModeShortcut = undefined;
    activeSession = ""; plan = undefined; stateError = undefined;
  });
  pi.on("tool_call", (event, ctx) => {
    initialize(ctx);
    // A broken state must not silently disable the planning barrier.
    if (!isPlanning(plan) && !stateError) return;
    if (canPlanRead(event.toolName, pi.getAllTools())) return;
    if (!stateError && isWorkspaceBookkeeping(event.toolName, event.input, pi.getAllTools())) return;
    return { block: true, terminate: true, reason: stateError ? `Workspace state: ${stateError}`
      : `Plan mode: ${event.toolName} is blocked. Read and search only; the user must choose /plan execute before changes.` };
  });
  pi.on("user_bash", (_event, ctx) => {
    initialize(ctx);
    if (isPlanning(plan) || stateError) return { result: {
      output: "Plan mode blocks shell commands. Use /plan execute or /plan cancel first.", exitCode: 1, cancelled: false, truncated: false,
    } };
  });
  const sections = () => {
    const sections: Record<string, string> = {};
    sections.pi_extended_memory = `${memoryPrompt(memory)}\nMemory reads are allowed in every permission mode; saves/deletes require approval in Ask mode and are blocked in Read only and Plan modes.`;
    const additions = promptAdditions(prompts.read("global"), prompts.read("project"), sessionAddition);
    if (additions) sections.pi_extended_prompt = additions;
    if (!plan || ["cancelled", "completed", "paused"].includes(plan.status)) sections.pi_extended_workflow = TASK_WORKFLOW_GUIDANCE;
    if (plan && !["cancelled", "completed", "paused"].includes(plan.status)) sections.pi_extended_plan =
      `${isPlanning(plan) ? "PLANNING MODE: research and prepare a plan only. No code edits, shell commands, or external side effects. Only the user can approve execution with /plan execute. Use update_plan to persist the proposed goal, steps, affected areas and checks; then present the plan and wait for approval."
        : PLAN_EXECUTION_GUIDANCE}\n\n${renderPlan(plan)}`;
    return sections;
  };
  pi.on("before_agent_start", (event, ctx) => {
    requireState(ctx);
    Object.assign(event.systemPromptOptions.sections, sections());
    // A custom forced prompt still receives our additions without replacing its baseline.
    if (event.systemPromptOptions.forceSystemPrompt !== undefined) return {
      systemPrompt: `${event.systemPrompt}\n\n${Object.values(sections()).join("\n\n")}`,
    };
  });
  pi.registerTool({ name: "project_memory", label: "Project memory", parameters: memorySchema,
    description: "Persistent project memory. list returns a short index; read loads details by id. save upserts a topic (id, title, summary, content); delete removes obsolete facts. Never store secrets or transient task progress.",
    promptSnippet: "Read and maintain useful project memories across sessions",
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireState(ctx); if (signal?.aborted) throw new Error("Cancelled.");
      if (!memory.enabled) throw new Error("Project memory is disabled. The user can enable it with /memory on.");
      const args = params as unknown as { action: string; id: string; title: string; summary: string; content: string };
      if (args.action === "list") return result(memory.index());
      if (args.action === "read") return result(memory.read(args.id));
      if (isPlanning(plan)) throw new Error("Plan mode permits reading memory only.");
      if (args.action === "save") return result(memory.save(args));
      if (args.action === "delete") { memory.delete(args.id); return result(`Deleted ${args.id}.`); }
      throw new Error("Unknown memory action.");
    },
  });
  pi.registerTool({ name: "update_plan", label: "Update plan", parameters: planSchema,
    description: "Read the active plan with {} or update its goal, steps [{text,status}], areas and checks. Only available after the user starts /plan. Cannot approve execution. During execution only step status changes are allowed.",
    promptSnippet: "Persist an approved planning workflow and track its steps",
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireState(ctx); if (signal?.aborted) throw new Error("Cancelled.");
      if (!plan || ["cancelled", "completed", "paused"].includes(plan.status)) throw new Error("No active plan. Only the user can start /plan.");
      const patch = params as Partial<Pick<Plan, "goal" | "steps" | "areas" | "checks">>;
      if (!Object.keys(patch).length) return result(plan);
      const next = validatePlan({ ...plan, ...patch });
      if (plan.status === "executing") {
        if (next.goal !== plan.goal || JSON.stringify(next.areas) !== JSON.stringify(plan.areas) || JSON.stringify(next.checks) !== JSON.stringify(plan.checks)
          || JSON.stringify(next.steps.map((s) => s.text)) !== JSON.stringify(plan.steps.map((s) => s.text))) throw new Error("The approved plan changed. Ask the user to edit/replan before executing a different plan.");
        if (next.steps.length && next.steps.every((s) => s.status === "completed")) next.status = "completed";
      } else { next.status = next.steps.length ? "ready" : "planning"; next.steps.forEach((s) => { s.status = "pending"; }); }
      savePlan(next); return result(plan);
    },
  });

  const memoryEdit = async (ctx: ExtensionCommandContext, id?: string) => {
    const existing = id ? memory.read(id) : undefined;
    if (!id) id = await ctx.ui.input("Memory topic id", "for example: user-preferences");
    if (!id) return;
    const text = await edit(pi, ctx, `Memory · ${id}`, `Title: ${existing?.title ?? ""}\nSummary: ${existing?.summary ?? ""}\n\n${existing?.content ?? ""}`);
    if (text === undefined) return;
    const lines = text.split(/\r?\n/);
    if (!lines[0]?.startsWith("Title:") || !lines[1]?.startsWith("Summary:")) throw new Error("Keep the Title: and Summary: lines.");
    memory.save({ id, title: lines[0].slice(6).trim(), summary: lines[1].slice(8).trim(), content: lines.slice(2).join("\n").trim() });
  };
  pi.registerCommand("memory", { description: "Inspect and manage automatic project memory",
    handler: async (args, ctx) => {
      try {
        requireState(ctx);
        const [action, id] = args.trim().split(/\s+/);
        if (action === "on" || action === "off") { memory.enabled = action === "on"; notify(ctx, `Automatic memory ${action}.`); return; }
        if (action === "read" && id) { notify(ctx, memory.read(id).content); return; }
        if (action === "delete" && id) { memory.delete(id); notify(ctx, `Deleted ${id}.`); return; }
        if (action === "edit" || action === "add") { if (!ctx.hasUI) throw new Error("Memory editing requires an interactive UI."); await memoryEdit(ctx, action === "edit" ? id : undefined); return; }
        if (action && action !== "list") throw new Error("Use /memory [list|read id|edit id|delete id|add|on|off].");
        if (ctx.mode !== "tui") { notify(ctx, `${memory.enabled ? "Auto memory: on" : "Auto memory: off"}\n${memory.index()}\n${memory.files.path("memory/MEMORY.md")}`); return; }
        let page = 0;
        for (;;) {
          const notes = memory.list();
          const pages: WorkspacePage[] = [{ label: "Overview", lines: () => [
            `Automatic memory: ${memory.enabled ? "on" : "off"}`, "", ...memory.index().split("\n"), "",
            "Short summaries are loaded automatically; full notes are read on demand.", "", memory.files.path("memory/MEMORY.md"),
          ] }, ...notes.map((n: MemoryNote) => ({ label: n.id, lines: () => [n.title, n.summary, "", ...n.content.split("\n")] }))];
          const selected = await screen(pi, ctx, "Memory", pages, "tab topics · e edit · n new · d delete · t auto on/off · esc close",
            { e: "edit", n: "new", d: "delete", t: "toggle" }, page);
          if (!selected) break;
          page = selected.page;
          const note = notes[selected.page - 1];
          if (selected.action === "toggle") memory.enabled = !memory.enabled;
          if (selected.action === "new") await memoryEdit(ctx);
          if (selected.action === "edit" && note) await memoryEdit(ctx, note.id);
          if (selected.action === "delete" && note && await ctx.ui.confirm("Delete memory?", note.title)) memory.delete(note.id);
        }
      } catch (error) { notify(ctx, String(error instanceof Error ? error.message : error), true); }
    },
  });
  const planAction = async (action: string, goal: string, ctx: ExtensionCommandContext) => {
    if (!storageReady) throw new Error(stateError ?? "Project storage is unavailable.");
    if (action === "cancel") {
      if (stateError) {
        const marker = ctx.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === PLAN_ENTRY).at(-1);
        const previous = (marker as { data?: Plan } | undefined)?.data?.toolsBefore;
        savePlan({ version: 1, status: "cancelled", goal: "", steps: [], areas: [], checks: [], updatedAt: "", toolsBefore: previous });
        if (previous) pi.setActiveTools(previous);
      }
      else if (plan) savePlan({ ...plan, status: "cancelled" });
      notify(ctx, "Plan cancelled. Current permissions are unchanged."); return;
    }
    if (action !== "start") requireState(ctx);
    if (action === "execute") {
      if (!plan || !["ready", "paused", "executing"].includes(plan.status) || !plan.goal || !plan.steps.length) throw new Error("Prepare a goal and plan steps before execution.");
      savePlan({ ...plan, status: "executing" });
      pi.sendUserMessage(`Execute the approved plan. Follow its steps and current permissions.\n\n${renderPlan(plan!)}`, { deliverAs: "followUp" }); return;
    }
    if (action === "edit") {
      if (!plan) throw new Error("Start a plan first with /plan <goal>.");
      const text = await edit(pi, ctx, "Edit plan", renderPlan(plan));
      if (text !== undefined) savePlan(parsePlan(text, plan)); return;
    }
    if (action === "start") {
      const value = boundedText(goal, "Goal", 4_000);
      savePlan({ version: 1, status: "planning", goal: value, steps: [], areas: [], checks: [], updatedAt: "",
        toolsBefore: isPlanning(plan) && plan?.toolsBefore ? plan.toolsBefore : pi.getActiveTools() });
      if (value) pi.sendUserMessage(`Research and prepare a plan for this goal. Save it with update_plan, then wait for my approval.\n\n${value}`, { deliverAs: "followUp" });
      else notify(ctx, "Plan mode enabled. Describe the task; changes are blocked until /plan execute.");
    }
  };
  pi.registerCommand("plan", { description: "Plan safely, edit steps, then explicitly approve execution",
    handler: async (args, ctx) => {
      try {
        initialize(ctx);
        if (!ctx.isIdle()) throw new Error("Wait for the current run to finish before changing the plan.");
        const value = args.trim();
        if (["execute", "cancel", "edit", "start"].includes(value)) { await planAction(value, "", ctx); return; }
        if (value && value !== "show") { await planAction("start", value, ctx); return; }
        requireState(ctx);
        if (ctx.mode !== "tui") { notify(ctx, plan ? `Plan: ${plan.status}\n${renderPlan(plan)}` : "No plan. Use /plan <goal>, /plan start, /plan execute, or /plan cancel."); return; }
        for (;;) {
          const selected = await screen(pi, ctx, "Plan", [{ label: plan?.status ?? "No active plan", lines: () => plan
            ? [...renderPlan(plan).split("\n"), "", "Execution uses the current /permissions mode."]
            : ["Start plan mode, then describe the task.", "Read and search are allowed; code changes and shell commands are blocked."] }],
            "s start · e edit · x execute · c cancel · esc close", { s: "start", e: "edit", x: "execute", c: "cancel" });
          if (!selected) break;
          await planAction(selected.action, "", ctx);
          if (selected.action !== "edit") break;
        }
      } catch (error) { notify(ctx, String(error instanceof Error ? error.message : error), true); }
    },
  });
  const readAddition = (scope: PromptScope) => scope === "session" ? sessionAddition : prompts.read(scope);
  const writeAddition = (scope: PromptScope, text: string) => {
    const value = boundedText(text, "Prompt additions", 12_000);
    if (scope === "session") { pi.appendEntry(PROMPT_ENTRY, { text: value }); sessionAddition = value; }
    else prompts.write(scope, value);
  };
  pi.registerCommand("prompt", { description: "View Pi's system prompt and edit session, project, or global additions",
    handler: async (args, ctx) => {
      try {
        requireState(ctx);
        const match = args.trim().match(/^(session|project|global)(?:\s+([\s\S]*))?$/);
        if (args.trim() && !match) throw new Error("Use /prompt [session|project|global] [text].");
        if (match && isPromptScope(match[1])) {
          const scope = match[1];
          if (match[2] !== undefined) { writeAddition(scope, match[2]); notify(ctx, `Saved ${scope} prompt additions.`); return; }
          if (!ctx.hasUI) { notify(ctx, readAddition(scope) || "No additions."); return; }
          const edited = await edit(pi, ctx, `Prompt · ${scope} additions`, readAddition(scope));
          if (edited !== undefined) writeAddition(scope, edited); return;
        }
        const { buildSystemPrompt } = await import(pathToFileURL(join(getPackageDir(), "dist/core/system-prompt.js")).href) as {
          buildSystemPrompt(options: BuildSystemPromptOptions): string;
        };
        const base = ctx.getSystemPromptOptions();
        const effective = () => {
          const extra = sections();
          const mode = readPermissionMode(ctx.sessionManager.getEntries());
          if (mode !== "full") extra.pi_extended_permissions = `Agent permissions: ${PERMISSION_DESCRIPTIONS[mode]}`;
          return buildSystemPrompt(base.forceSystemPrompt !== undefined ? { ...base, forceSystemPrompt: `${base.forceSystemPrompt}\n\n${Object.values(extra).join("\n\n")}` }
            : { ...base, sections: { ...base.sections, ...extra } });
        };
        if (ctx.mode !== "tui") { notify(ctx, effective()); return; }
        let page = 0;
        for (;;) {
          const pages: WorkspacePage[] = [
            { label: "Effective", lines: () => ["Preview for the next run. Other extension hooks apply at run start.", "", ...effective().split("\n")] },
            { label: "Native Pi", lines: () => buildSystemPrompt(base).split("\n") },
            ...PROMPT_SCOPES.map((scope) => ({ label: scope, lines: () => (readAddition(scope) || "No additions. Press e to edit.").split("\n") })),
          ];
          const selected = await screen(pi, ctx, "System prompt", pages, "tab section · e edit additions · d clear additions · esc close", { e: "edit", d: "clear" }, page);
          if (!selected) break;
          page = selected.page;
          const scope = PROMPT_SCOPES[selected.page - 2];
          if (!scope) { notify(ctx, "Native Pi prompt is preserved. Select session, project, or global to add instructions."); continue; }
          if (selected.action === "clear") { if (await ctx.ui.confirm("Clear prompt additions?", scope)) writeAddition(scope, ""); }
          else { const edited = await edit(pi, ctx, `Prompt · ${scope} additions`, readAddition(scope)); if (edited !== undefined) writeAddition(scope, edited); }
        }
      } catch (error) { notify(ctx, String(error instanceof Error ? error.message : error), true); }
    },
  });
}
