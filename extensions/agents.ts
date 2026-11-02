import { getAgentDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { AgentStore, agentsPrompt } from "../lib/agents.js";
import type { AgentCatalog, AgentDefinition } from "../lib/agents.js";
import { runSubagent } from "../lib/subagent.js";
import type { ApprovalDecision } from "../lib/subagent.js";
import { serializeApproval } from "../lib/approval-queue.js";
import { readPermissionMode, permissionRequest, PERMISSIONS_CHANGED } from "../lib/permissions.js";
import { PLAN_ENTRY, PLAN_CHANGED, isPlanning } from "../lib/plan.js";
import type { Plan } from "../lib/plan.js";
import { boundedText } from "../lib/project-state.js";
import { errorMessage } from "../lib/errors.js";
import type { WorkspacePage } from "../ui/workspace-screen.js";

const taskSchema = { type: "object", properties: {
  agent: { type: "string", description: "Name of the subagent to run." },
  task: { type: "string", description: "Self-contained instructions. The subagent sees only this text." },
}, required: ["agent", "task"], additionalProperties: false };

function notify(ctx: ExtensionContext, text: string, error = false) {
  if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info"); else console.error(text);
}
const measure = () => ({ CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi });

export default function agents(pi: ExtensionAPI, runner = runSubagent) {
  let store: AgentStore | undefined;
  let catalog: AgentCatalog = { agents: [], unreadable: [] };
  let lifetime = new AbortController();
  const runs = new Map<AbortController, Promise<void>>();
  const paths = (ctx: ExtensionContext) => ({ cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() });
  const refresh = (ctx: ExtensionContext) => {
    store = new AgentStore(paths(ctx));
    catalog = store.list();
    return store;
  };
  const required = (ctx: ExtensionContext) => store ?? refresh(ctx);
  pi.on("session_start", (_event, ctx) => {
    if (lifetime.signal.aborted) lifetime = new AbortController();
    refresh(ctx);
  });
  pi.on("session_shutdown", async () => {
    const pending = [...runs.values()];
    lifetime.abort(new Error("The parent session was closed or replaced."));
    // A replacement must not invalidate the context while a child still works.
    await Promise.allSettled(pending);
    store = undefined; catalog = { agents: [], unreadable: [] };
  });

  // The model only learns which agents exist; instructions load when one runs.
  pi.on("before_agent_start", (event, ctx) => {
    refresh(ctx);
    const text = agentsPrompt(catalog);
    if (!text) return;
    if (event.systemPromptOptions?.forceSystemPrompt !== undefined || !event.systemPromptOptions) {
      return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
    }
    event.systemPromptOptions.sections.pi_extended_agents = text;
  });

  const planning = (ctx: ExtensionContext) => {
    const marker = ctx.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === PLAN_ENTRY).at(-1);
    return isPlanning((marker as { data?: Plan } | undefined)?.data);
  };

  /** Subagent approvals open the parent's own screen, sharing its dialog queue. */
  const approver = (ctx: ExtensionContext, agent: string, signal?: AbortSignal) =>
    async (toolName: string, input: unknown): Promise<ApprovalDecision> => serializeApproval(async () => {
      if (!ctx.hasUI || signal?.aborted) return "deny";
      const lines = [`Subagent: ${agent}`, ...permissionRequest(toolName, input, ctx.cwd)];
      if (ctx.mode !== "tui") {
        return await ctx.ui.confirm(`Allow ${toolName} for subagent ${agent}?`, lines.join("\n"), { signal }) ? "once" : "deny";
      }
      const [{ createPermissionApprovalScreen }, { createHeader }, { createUiTheme }] = await Promise.all([
        import("../ui/permissions-screen.js"), import("../ui/chrome.js"), import("../ui/theme.js"),
      ]);
      if (signal?.aborted) return "deny";
      let choice: ApprovalDecision = "deny";
      await ctx.ui.custom<boolean>((tui, _theme, _keys, done) => {
        const theme = createUiTheme();
        const header = createHeader({ mode: "regular" }, measure(), {
          version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
        });
        const footer = tui.children.at(-1);
        const abort = () => { panel.dispose(); done(false); };
        const panel = createPermissionApprovalScreen({ tui, theme, measure: measure(), done, lines,
          runLabel: `Allow for this ${agent} run`,
          onChoice: (value) => { choice = value; },
          renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width),
          onDispose: () => { signal?.removeEventListener("abort", abort); header.dispose(); },
        });
        signal?.addEventListener("abort", abort, { once: true });
        return panel;
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
      return signal?.aborted ? "deny" : choice;
    }, "deny");

  const run = async (definition: AgentDefinition, task: string, ctx: ExtensionContext, signal?: AbortSignal,
    onProgress?: (note: string) => void) => {
    // A grant is scoped to the policy under which it was given. Revoke the
    // whole run on a policy change, including queued approvals and tool work.
    const policy = new AbortController();
    let settled!: () => void;
    runs.set(policy, new Promise<void>((resolve) => { settled = resolve; }));
    const revoke = () => policy.abort(new Error("The parent permission or plan mode changed."));
    const stopPermissions = pi.events.on(PERMISSIONS_CHANGED, revoke);
    const stopPlan = pi.events.on(PLAN_CHANGED, revoke);
    const runSignal = AbortSignal.any([lifetime.signal, policy.signal, ...(signal ? [signal] : [])]);
    try {
      return await runner({
        definition, task, cwd: ctx.cwd, agentDir: getAgentDir(),
        mode: readPermissionMode(ctx.sessionManager.getEntries()),
        planning: planning(ctx),
        model: ctx.model, thinkingLevel: pi.getThinkingLevel(),
        settingsManager: SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }),
        signal: runSignal, onProgress, requestApproval: approver(ctx, definition.name, runSignal),
      });
    } finally { stopPermissions(); stopPlan(); runs.delete(policy); settled(); }
  };

  pi.registerTool({
    name: "task", label: "Subagent", parameters: taskSchema,
    description: "Delegate a self-contained task to a configured subagent. It runs in its own context with its own tool selection and returns a single report. Use /agents to see available agents. A subagent cannot ask the user questions and inherits the current permission mode.",
    promptSnippet: "Delegate self-contained work to a configured subagent",
    async execute(_id, params, signal, onUpdate, ctx) {
      const args = params as unknown as { agent: string; task: string };
      const definition = required(ctx).find(args.agent);
      if (!definition) {
        const names = catalog.agents.map((agent) => agent.name).join(", ") || "none configured";
        throw new Error(`Unknown subagent: ${args.agent}. Available: ${names}.`);
      }
      const task = boundedText(args.task, "Task", 12_000);
      if (!task) throw new Error("Describe the task for the subagent.");
      const result = await run(definition, task, ctx, signal, (note) => onUpdate?.({ content: [{ type: "text", text: note }], details: {} }));
      if (result.aborted) throw new Error(`Subagent ${definition.name} was cancelled.`);
      const notes = [`Subagent ${definition.name} finished after ${result.toolCalls} tool call(s).`];
      if (result.blocked.length) notes.push(`Blocked during the run: ${result.blocked.slice(0, 10).join("; ")}`);
      const text = result.report || "The subagent returned no report.";
      return { content: [{ type: "text" as const, text: `${notes.join("\n")}\n\n${text}` }], details: {} };
    },
  });

  const pages = (): WorkspacePage[] => {
    const overview: WorkspacePage = { label: "Overview", lines: () => {
      const lines = ["Subagents run in their own context and return one report.", ""];
      if (!catalog.agents.length) lines.push("No agents configured. Press n to create one.");
      else for (const agent of catalog.agents) lines.push(`${agent.name} · ${agent.scope}${agent.model ? ` · ${agent.model}` : ""}`, `  ${agent.description}`);
      if (catalog.unreadable.length) lines.push("", "Unreadable definitions:", ...catalog.unreadable.map((entry) => `  ${entry}`));
      lines.push("", "The model delegates with the task tool; you can also run /agents run NAME TASK.");
      return lines;
    } };
    return [overview, ...catalog.agents.map((agent) => ({ label: agent.name, lines: () => [
      `${agent.name} · ${agent.scope}`, agent.description, "",
      `Tools: ${agent.tools ? (agent.tools.join(", ") || "none") : "engine default"}`,
      `Model: ${agent.model ?? "inherits the current model"}`,
      `File: ${agent.filePath}`, "", ...agent.prompt.split("\n"),
    ] }))];
  };

  pi.registerCommand("agents", {
    description: "Browse, create, and run subagents that work in their own context",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trim().toLowerCase();
      return ["run", "stop", "new", "list"].filter((action) => action.startsWith(value)).map((action) => ({ value: action, label: action }));
    },
    handler: async (args, ctx) => {
      const sessionLifetime = lifetime;
      try {
        if (args.trim() === "stop") {
          const pending = [...runs.values()];
          for (const controller of runs.keys()) controller.abort(new Error("The user stopped the subagent run."));
          await Promise.allSettled(pending);
          if (!sessionLifetime.signal.aborted) notify(ctx, pending.length ? "Subagent runs stopped." : "No subagent is running.");
          return;
        }
        const agentStore = refresh(ctx);
        const match = args.trim().match(/^(run|new|list|delete)(?:\s+([\s\S]*))?$/);
        const action = match?.[1], rest = (match?.[2] ?? "").trim();
        if (action === "run") {
          const [name, ...task] = rest.split(/\s+/);
          const definition = name ? agentStore.find(name) : undefined;
          if (!definition) throw new Error(`Use /agents run NAME TASK. Available: ${catalog.agents.map((a) => a.name).join(", ") || "none configured"}.`);
          const text = boundedText(task.join(" "), "Task", 12_000);
          if (!text) throw new Error("Describe the task after the agent name.");
          notify(ctx, `Running ${definition.name}. Press Esc to cancel, or use /agents stop.`);
          const controller = new AbortController();
          const signal = AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
          const stopInput = ctx.mode === "tui" ? ctx.ui.onTerminalInput((data) => {
            if (!matchesKey(data, "escape") && !matchesKey(data, "ctrl+c")) return;
            controller.abort(); return { consume: true };
          }) : undefined;
          try {
            const result = await run(definition, text, ctx, signal);
            if (!sessionLifetime.signal.aborted) notify(ctx, result.aborted ? `Subagent ${definition.name} was cancelled.`
              : `${definition.name} (${result.toolCalls} tool call(s)):\n\n${result.report || "No report."}`);
          } finally { stopInput?.(); }
          return;
        }
        if (action === "delete") {
          const definition = rest ? agentStore.find(rest) : undefined;
          if (!definition) throw new Error("Use /agents delete NAME.");
          if (!ctx.hasUI || await ctx.ui.confirm("Delete agent?", `${definition.name} (${definition.scope})`)) {
            agentStore.delete(definition.scope, definition.name);
            refresh(ctx); notify(ctx, `Deleted ${definition.name}.`);
          }
          return;
        }
        if (action === "list" || ctx.mode !== "tui") {
          const lines = catalog.agents.map((agent) => `${agent.name} (${agent.scope}) — ${agent.description}`);
          notify(ctx, ["Subagents", ...(lines.length ? lines : ["No agents configured."]),
            ...catalog.unreadable.map((entry) => `Unreadable: ${entry}`)].join("\n"));
          return;
        }
        const { openAgentEditor } = await import("../ui/agents-screen.js");
        const edit = async (existing?: AgentDefinition) => {
          const saved = await openAgentEditor({ pi, ctx, existing, measure: measure() });
          if (saved) { agentStore.save(saved.scope, saved.draft); refresh(ctx); notify(ctx, `Saved ${saved.draft.name}.`); }
        };
        if (action === "new") { await edit(); return; }
        const { openAgentsScreen } = await import("../ui/agents-screen.js");
        let page = 0;
        for (;;) {
          const selected = await openAgentsScreen({ pi, ctx, pages: pages(), initial: page, measure: measure() });
          if (!selected) break;
          page = selected.page;
          const definition = catalog.agents[selected.page - 1];
          if (selected.action === "new") await edit();
          else if (selected.action === "edit" && definition) await edit(definition);
          else if (selected.action === "delete" && definition
            && await ctx.ui.confirm("Delete agent?", `${definition.name} (${definition.scope})`)) {
            agentStore.delete(definition.scope, definition.name); refresh(ctx);
          }
        }
      } catch (error) { if (!sessionLifetime.signal.aborted) notify(ctx, errorMessage(error), true); }
    },
  });

}
