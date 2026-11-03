import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI, InlineExtension, SettingsManager, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./agents.js";
import { permissionDecision } from "./permissions.js";
import type { PermissionMode } from "./permissions.js";
import { canPlanRead } from "./plan.js";
import { cleanText } from "./project-state.js";
import { errorMessage } from "./errors.js";

export type ApprovalDecision = "once" | "run" | "deny";
export interface SubagentProgress { toolCalls: number }
export interface SubagentRequest {
  definition: AgentDefinition;
  task: string;
  cwd: string;
  agentDir: string;
  /** The parent's permission mode. A subagent never gets a wider selection. */
  mode: PermissionMode;
  /** Plan mode allows research only, matching the parent's barrier. */
  planning: boolean;
  model?: Parameters<typeof createAgentSessionFromServices>[0]["model"];
  thinkingLevel?: Parameters<typeof createAgentSessionFromServices>[0]["thinkingLevel"];
  settingsManager?: SettingsManager;
  /** Reuse an existing model runtime instead of loading the profile again. */
  modelRuntime?: Parameters<typeof createAgentSessionServices>[0]["modelRuntime"];
  signal?: AbortSignal;
  /** Opens the parent's approval screen; the subagent has no UI of its own. */
  requestApproval?(toolName: string, input: unknown): Promise<ApprovalDecision>;
  /** Activity metadata only; never include reasoning, tool arguments, or results. */
  onProgress?(note: string, progress?: SubagentProgress): void;
  maxToolCalls?: number;
}
export interface SubagentResult {
  report: string;
  toolCalls: number;
  blocked: string[];
  model?: string;
  aborted: boolean;
}

const MAX_TOOL_CALLS = 100;
export const READ_ONLY_TOOLS = ["read", "find", "grep", "ls"] as const;
const MAX_REPORT = 24_000;

/** Read the subagent's own answer; its transcript stays out of the parent session. */
export function readReport(messages: readonly { role?: unknown; content?: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (String(message.role) !== "assistant") continue;
    const content = message.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter((part) => (part as { type?: unknown })?.type === "text")
        .map((part) => String((part as { text?: unknown }).text ?? "")).join("\n")
      : "";
    const report = cleanText(text);
    if (report) return report.length > MAX_REPORT ? `${report.slice(0, MAX_REPORT)}\n… report truncated` : report;
  }
  return "";
}

/**
 * Mirror the parent's checks inside the subagent. The same permissionDecision and
 * plan barrier run here, so a nested call can never exceed what the parent allows.
 */
export interface GuardState { toolCalls: number; blocked: string[] }
export function createSubagentGuard(request: SubagentRequest, state: GuardState, onAllowed?: () => void): InlineExtension {
  const budget = request.maxToolCalls ?? MAX_TOOL_CALLS;
  let runGranted = false;
  return {
    name: "pi-extended-subagent-guard",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", (event) => {
        const text = `You are the ${request.definition.name} subagent. Report back in your final message: the parent conversation sees only that text, not this transcript. Write a self-contained handoff covering the requested scope, every actionable finding with supporting file/line references, checks actually performed, limitations, and unresolved questions. Keep the handoff within ${MAX_REPORT} characters and prioritize the evidence needed by the parent. Do not leave important conclusions only in tool output or earlier progress messages. You cannot ask the user questions.`;
        if (event.systemPromptOptions?.forceSystemPrompt !== undefined || !event.systemPromptOptions) {
          return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
        }
        event.systemPromptOptions.sections.pi_extended_subagent = text;
      });
      pi.on("tool_call", async (event) => {
        const block = (reason: string) => {
          state.blocked.push(`${event.toolName}: ${reason}`);
          return { block: true, terminate: true, reason };
        };
        if (request.signal?.aborted) return block("The subagent run was cancelled.");
        if (state.toolCalls >= budget) return block(`Subagent tool budget of ${budget} calls is exhausted. Report what you have.`);
        const tools = pi.getAllTools() as readonly Pick<ToolInfo, "name" | "sourceInfo">[];
        if (request.planning && !canPlanRead(event.toolName, tools)) {
          return block(`Plan mode: ${event.toolName} is blocked. A subagent may research only until the user runs /plan execute.`);
        }
        const decision = permissionDecision(request.mode, event.toolName, tools);
        if (decision === "block") return block(`Permissions: ${event.toolName} is blocked for subagents in the current mode.`);
        if (decision === "confirm" && !runGranted) {
          if (!request.requestApproval) return block(`Permission for ${event.toolName} could not be requested without an interactive parent.`);
          let approval: ApprovalDecision;
          try { approval = await request.requestApproval(event.toolName, event.input); }
          catch { return block(`Permission was not granted for ${event.toolName}.`); }
          if (request.signal?.aborted) return block("The subagent run was cancelled.");
          if (approval === "deny") return block(`Permission was not granted for ${event.toolName}.`);
          if (approval === "run") runGranted = true;
        }
        state.toolCalls++;
        // Pi announces execution before the guard runs; refresh the accepted
        // count only after all permission and planning checks have passed.
        onAllowed?.();
        if (request.signal?.aborted) return block("The subagent run was cancelled.");
        return undefined;
      });
    },
  };
}

/** One bounded run in its own in-memory session. Nothing is written to session history. */
export async function runSubagent(request: SubagentRequest): Promise<SubagentResult> {
  const { definition } = request;
  const state: GuardState = { toolCalls: 0, blocked: [] };
  let session: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  const activeTools = new Map<string, string>();
  const currentActivity = () => activeTools.size ? `Using ${[...activeTools.values()].at(-1)}` : "Thinking";
  let lastNote = "", lastCalls = -1;
  const publish = (note: string) => {
    if (request.signal?.aborted || (note === lastNote && state.toolCalls === lastCalls)) return;
    lastNote = note; lastCalls = state.toolCalls;
    request.onProgress?.(note, { toolCalls: state.toolCalls });
  };
  try {
    request.signal?.throwIfAborted();
    publish("Starting");
    request.signal?.throwIfAborted();
    const services = await createAgentSessionServices({
      cwd: request.cwd,
      agentDir: request.agentDir,
      settingsManager: request.settingsManager,
      modelRuntime: request.modelRuntime,
      modelRuntimeSignal: request.signal,
      resourceLoaderOptions: {
        // No extensions of ours load here: a subagent cannot spawn subagents,
        // and the parent's commands, memory tools and interface stay out.
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        noSkills: true,
        // Keep Pi's own baseline and add the agent's instructions to it.
        appendSystemPrompt: [definition.prompt],
        extensionFactories: [createSubagentGuard(request, state, () => publish(currentActivity()))],
      },
    });
    request.signal?.throwIfAborted();
    let model = request.model;
    if (definition.model) {
      const available = services.modelRuntime.getAvailableSnapshot();
      const selected = available.find((candidate) => candidate.id === definition.model);
      if (!selected) {
        throw new Error(`Agent ${definition.name} requests the model ${definition.model}, which is not available. Edit the agent or run /model.`);
      }
      model = selected;
    }
    // Narrow the selection before the engine ever offers a write tool, and never
    // beyond what the definition itself declares.
    const restricted = request.planning || request.mode === "read-only";
    const tools = restricted
      ? (definition.tools ? definition.tools.filter((tool) => (READ_ONLY_TOOLS as readonly string[]).includes(tool)) : [...READ_ONLY_TOOLS])
      : definition.tools;
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(request.cwd),
      model,
      thinkingLevel: request.thinkingLevel,
      ...(tools ? { tools } : {}),
    });
    session = created.session;
    unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        activeTools.set(event.toolCallId, cleanText(event.toolName).replace(/\s+/g, " ").slice(0, 64));
        publish(currentActivity());
      } else if (event.type === "tool_execution_end") {
        activeTools.delete(event.toolCallId); publish(currentActivity());
      } else if (event.type === "message_start" && event.message.role === "assistant") publish(currentActivity());
      else if (event.type === "message_update" && event.message.role === "assistant") {
        const type = event.assistantMessageEvent.type;
        if (type === "text_delta") publish(activeTools.size ? currentActivity() : "Preparing report");
        else if (type === "thinking_delta" || type === "toolcall_delta") publish(currentActivity());
      } else if (event.type === "auto_retry_start") publish("Retrying");
      else if (event.type === "compaction_start") publish("Compacting");
    });
    const abort = () => { void session?.abort(); };
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      request.signal?.throwIfAborted();
      publish("Thinking");
      request.signal?.throwIfAborted();
      await session.prompt(request.task, { expandPromptTemplates: false, source: "extension" });
      await session.waitForIdle();
    } finally {
      request.signal?.removeEventListener("abort", abort);
    }
    // Pi records failed responses in the transcript and can resolve prompt()
    // normally after retry exhaustion. An earlier progress message is not a
    // successful report for such a run.
    const assistant = session.messages.findLast((message) => message.role === "assistant");
    if (assistant?.stopReason === "error") {
      throw new Error(cleanText(assistant.errorMessage || "The provider request failed.").slice(0, 2_000));
    }
    const aborted = request.signal?.aborted === true || assistant?.stopReason === "aborted";
    const report = aborted ? "" : readReport(session.messages);
    return {
      report, toolCalls: state.toolCalls, blocked: state.blocked,
      model: session.model?.id, aborted,
    };
  } catch (error) {
    if (request.signal?.aborted) {
      return { report: "", toolCalls: state.toolCalls, blocked: state.blocked, aborted: true };
    }
    throw new Error(`Subagent ${definition.name} failed: ${errorMessage(error)}`);
  } finally {
    unsubscribe?.();
    session?.dispose();
  }
}
