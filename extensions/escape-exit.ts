import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { createEscapeExitEditor } from "../ui/escape-exit.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLAN_TOGGLE } from "../lib/plan.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export default function escapeExit(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const EscapeExitEditor = createEscapeExitEditor(CustomEditor, matchesKey, ctx, {
      getLevel: () => pi.getThinkingLevel(),
      step: (direction) => {
        if (!ctx.model) { ctx.ui.notify("Select a model with /model first.", "info"); return; }
        const levels = getSupportedThinkingLevels(ctx.model);
        const current = pi.getThinkingLevel();
        const index = levels.indexOf(current);
        const next = levels[index < 0 ? 0 : Math.max(0, Math.min(levels.length - 1, index + direction))];
        if (next && next !== current) pi.setThinkingLevel(next);
      },
    }, () => pi.events.emit(PLAN_TOGGLE, undefined));
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new EscapeExitEditor(tui, theme, keybindings, { embedWorkingStatus: true }),
    );
  });
}
