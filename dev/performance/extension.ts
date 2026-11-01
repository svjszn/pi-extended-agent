import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { projectFiles } from "../../lib/project-state.js";
import { PerformanceStore, PerformanceTracker } from "./tracker.js";
import type { PerformanceRun } from "./tracker.js";
import { performanceLines, duration } from "./view.js";
import { createCommandPanel } from "../../ui/command-panel.js";
import { createHeader } from "../../ui/chrome.js";
import { createUiTheme } from "../../ui/theme.js";

/** Passive telemetry: no extra tools, model messages, continuations, or per-token disk writes. */
export default function performanceExtension(pi: ExtensionAPI) {
  let tracker = new PerformanceTracker(), store: PerformanceStore | undefined;
  let history: PerformanceRun[] = [], outcome: "completed" | "error" | "aborted" = "completed";
  const warn = (ctx: ExtensionContext, error: unknown) => {
    if (ctx.hasUI) ctx.ui.notify(`Performance history: ${error instanceof Error ? error.message : String(error)}`, "warning");
  };
  const finish = (ctx: ExtensionContext, status: "completed" | "error" | "aborted" | "interrupted") => {
    const run = tracker.finish(status); if (!run) return;
    history = [...history, run].slice(-30);
    try { store?.save(run); } catch (error) { warn(ctx, error); }
  };
  pi.on("session_start", (_event, ctx) => {
    tracker = new PerformanceTracker(); history = []; store = undefined;
    try { store = new PerformanceStore(projectFiles(ctx.cwd, getAgentDir()), ctx.sessionManager.getSessionId()); history = store.read(); }
    catch (error) { warn(ctx, error); }
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (!tracker.active) { outcome = "completed"; tracker.begin(ctx.model?.id ?? "unselected", ctx.model?.provider ?? "unselected", pi.getThinkingLevel()); }
  });
  pi.on("turn_start", () => { tracker.turn(); });
  pi.on("before_provider_request", () => { tracker.request(); });
  pi.on("after_provider_response", (event) => { tracker.response(event.status); });
  pi.on("message_update", (event) => {
    const type = event.assistantMessageEvent.type;
    if (type === "text_delta") tracker.output("text");
    else if (type === "thinking_delta") tracker.output("thinking");
    else if (type === "toolcall_delta") tracker.output("toolcall");
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") tracker.assistantEnd(event.message.usage, event.message.stopReason,
      Array.isArray(event.message.content) ? event.message.content.filter((part) => part.type === "toolCall").length : 0);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    const tool = pi.getAllTools().find((tool) => tool.name === event.toolName);
    const builtin = tool?.sourceInfo?.source === "builtin" && tool.sourceInfo.path === `builtin:${event.toolName}`;
    tracker.toolStart(event.toolCallId, event.toolName, event.args, builtin, ctx.cwd, event.parentToolCallId);
  });
  pi.on("tool_execution_end", (event) => {
    tracker.toolEnd(event.toolCallId, event.isError, event.durationMs !== undefined, event.result?.usage);
  });
  pi.on("ui_prompt_start", () => { tracker.approvalStart(); });
  pi.on("ui_prompt_end", () => { tracker.approvalEnd(); });
  pi.on("session_before_compact", () => { tracker.compactStart(); });
  pi.on("session_compact", (event) => { tracker.compactEnd(false, event.compactionEntry.usage); });
  pi.on("session_compact_failed", () => { tracker.compactEnd(true); });
  pi.on("model_select", () => { tracker.configurationChanged(); });
  pi.on("thinking_level_select", () => { tracker.configurationChanged(); });
  pi.on("agent_before_settle", (event) => { outcome = event.outcome; });
  pi.on("agent_settled", (event, ctx) => { finish(ctx, event.aborted ? "aborted" : outcome); });
  pi.on("session_shutdown", (_event, ctx) => { finish(ctx, "interrupted"); store = undefined; });

  pi.registerCommand("perf", {
    description: "Inspect elapsed time, provider requests, tools, reported tokens, and recent run metrics",
    getArgumentCompletions: (prefix) => ["last", "history", "json"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (mode && !["last", "history", "json"].includes(mode)) {
        if (ctx.hasUI) ctx.ui.notify("Use /perf [last|history|json].", "error"); else console.error("Use /perf [last|history|json].");
        return;
      }
      const latest = () => tracker.snapshot() ?? history.at(-1);
      const lines = (theme: ReturnType<typeof createUiTheme>) => mode === "history"
        ? ["Recent runs in this session (newest first)", "", ...[...(tracker.snapshot() ? [...history, tracker.snapshot()!] : history)].reverse().flatMap((run) => [
          `${run.startedAt} · ${run.outcome} · ${duration(run.elapsedMs)}`,
          `${run.provider}/${run.model} · ${run.effort} · ${run.requests} requests · ${run.tools} tools`, "",
        ])]
        : mode === "json" ? JSON.stringify(latest() ?? null, null, 2).split("\n") : performanceLines(latest(), theme);
      if (ctx.mode !== "tui") {
        const output = mode === "json" ? JSON.stringify(latest() ?? null, null, 2) : ["Performance", ...lines(createUiTheme({ color: false }))].join("\n");
        if (ctx.hasUI) ctx.ui.notify(output, "info"); else console.error(output);
        return;
      }
      await ctx.ui.custom((tui, _nativeTheme, _keys, done) => {
        const theme = createUiTheme(), measure = { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi };
        const header = createHeader({ mode: "regular" }, measure, {
          version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
        });
        const footer = tui.children.at(-1);
        const timer = setInterval(() => { if (tracker.active) tui.requestRender(); }, 1000); timer.unref?.();
        return createCommandPanel({ title: "Performance", tui, theme, measure, done, load: () => true, renderBody: () => lines(theme),
          renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width),
          onDispose: () => { clearInterval(timer); header.dispose(); },
        });
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
    },
  });
}
