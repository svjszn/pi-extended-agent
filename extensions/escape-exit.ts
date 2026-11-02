import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { createEscapeExitEditor } from "../ui/escape-exit.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLAN_TOGGLE } from "../lib/plan.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { hasModel } from "../lib/startup.js";
import { isSessionReplaced, lastKnown } from "../lib/session-replacement.js";
import { RunProgressTracker } from "../lib/run-progress.js";

const key = Symbol.for("pi-extended-agent.session-editor");
const globals = globalThis as typeof globalThis & { [key]?: WeakMap<object, { dispose(): void }> };
const editors = globals[key] ??= new WeakMap();

export default function escapeExit(pi: ExtensionAPI) {
  let editor: { dispose(): void; refreshRunProgress(): void } | undefined;
  const progress = new RunProgressTracker();
  const refresh = () => editor?.refreshRunProgress();
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode === "tui") { progress.begin(); refresh(); }
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") progress.startMessage();
  });
  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    const update = event.assistantMessageEvent;
    const delta = update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta" ? update.delta : "";
    progress.update(delta, event.message.usage.output);
    refresh();
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") { progress.endMessage(event.message); refresh(); }
  });
  pi.on("session_compact", (event) => { progress.addUsage(event.compactionEntry.usage); refresh(); });
  pi.on("agent_settled", () => { progress.reset(); refresh(); });
  pi.on("session_start", (_event, ctx) => {
    progress.reset();
    if (ctx.mode !== "tui") return;
    // The input stays mounted while the next session loads, and the context
    // that created it throws on every read once it is replaced.
    const session = {
      isIdle: lastKnown(() => ctx.isIdle(), true),
      hasPendingMessages: lastKnown(() => ctx.hasPendingMessages(), false),
      getRunProgress: () => progress.snapshot(),
    };
    const EscapeExitEditor = createEscapeExitEditor(CustomEditor, matchesKey, session, {
      // Pi reports "off" for its placeholder model; show nothing instead.
      getLevel: lastKnown(() => hasModel(ctx.model) ? pi.getThinkingLevel() : "", ""),
      step: (direction) => {
        if (!ctx.model) { ctx.ui.notify("Select a model with /model first.", "info"); return; }
        const levels = getSupportedThinkingLevels(ctx.model);
        const current = pi.getThinkingLevel();
        const index = levels.indexOf(current);
        const next = levels[index < 0 ? 0 : Math.max(0, Math.min(levels.length - 1, index + direction))];
        if (next && next !== current) pi.setThinkingLevel(next);
      },
    }, () => pi.events.emit(PLAN_TOGGLE, undefined));
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      editor?.dispose();
      editors.get(tui)?.dispose();
      const next = new EscapeExitEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      editors.set(tui, next);
      editor = next;
      return next;
    });
  });
  // A replacement keeps this input on screen until the next session mounts its
  // own: disposing it here would hand the gap back to Pi's own editor.
  pi.on("session_shutdown", (event) => {
    progress.reset(); refresh();
    if (isSessionReplaced(event)) return;
    editor?.dispose(); editor = undefined;
  });
}
