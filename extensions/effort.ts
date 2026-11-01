import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { EffortLevel } from "../ui/effort-screen.js";

export default function effortCommand(pi: ExtensionAPI) {
  let available: EffortLevel[] = [];
  const levelsFor = (ctx: ExtensionContext) => ctx.model ? getSupportedThinkingLevels(ctx.model) : [];
  const refresh = (_event: unknown, ctx: ExtensionContext) => { available = levelsFor(ctx); };
  pi.on("session_start", refresh);
  pi.on("model_select", refresh);
  pi.registerCommand("effort", {
    description: "Choose reasoning effort, or set it with /effort high",
    getArgumentCompletions: (prefix) => available.filter((level) => level.startsWith(prefix.trim().toLowerCase()))
      .map((level) => ({ value: level, label: level })),
    handler: async (args, ctx) => {
      const notify = (message: string, type: "info" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(message, type); else console.error(message);
      };
      available = levelsFor(ctx);
      if (!ctx.model) { notify("Select a model with /model first.", "error"); return; }
      const apply = (value: string) => {
        const supported = levelsFor(ctx);
        const selected = supported.find((level) => level === value);
        if (!selected) { notify(`Available effort levels: ${supported.join(", ")}.`, "error"); return; }
        pi.setThinkingLevel(selected);
        notify(`Effort: ${pi.getThinkingLevel()}`);
      };
      const value = args.trim().toLowerCase();
      if (value) { apply(value); return; }
      if (ctx.mode !== "tui") {
        notify(`Effort: ${pi.getThinkingLevel()}\nAvailable: ${available.join(", ")}`);
        return;
      }
      const [{ createEffortScreen }, { createHeader }, { createUiTheme }] = await Promise.all([
        import("../ui/effort-screen.js"), import("../ui/chrome.js"), import("../ui/theme.js"),
      ]);
      let selected: EffortLevel | undefined;
      await ctx.ui.custom((tui, _theme, _keys, done) => {
        const theme = createUiTheme();
        const measure = { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi };
        const header = createHeader({ mode: "regular" }, measure, {
          version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
        });
        const footer = tui.children.at(-1);
        return createEffortScreen({ tui, theme, measure, done, levels: available, current: pi.getThinkingLevel(),
          onSelect: (level) => { selected = level; }, renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width),
        });
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
      if (selected) apply(selected);
    },
  });
}
