import { getAgentDir, getPackageDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { fetchUsage } from "../lib/usage.js";
import { readActivity } from "../lib/activity.js";
import { createCommandPanel } from "../ui/command-panel.js";
import { usageLines, activityLines } from "../ui/command-views.js";
import { createUiTheme } from "../ui/theme.js";
import { createHeader } from "../ui/chrome.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PanelOptions, Period } from "../ui/command-panel.js";
import type { Palette } from "../ui/types.js";
import { errorMessage } from "../lib/errors.js";
import { readContextReport } from "../lib/context.js";
import { contextLines } from "../ui/context-view.js";
import { readStatus } from "../lib/status.js";
import { statusLines } from "../ui/status-view.js";

interface CommandDefinition<T> {
  name: string; title: string; description: string; periods?: Period[];
  renderBody: PanelOptions<T>["renderBody"];
  load(ctx: ExtensionCommandContext, signal?: AbortSignal, tuiMode?: string): T | Promise<T>;
}

export default function commands(pi: ExtensionAPI) {
  function register<T>(definition: CommandDefinition<T>) {
    pi.registerCommand(definition.name, {
      description: definition.description,
      handler: async (_args, ctx) => {
        if (ctx.mode === "tui") {
          await ctx.ui.custom((tui, _theme, _keybindings, done) => {
            const theme = createUiTheme();
            const header = createHeader({ mode: "regular" }, theme, { truncateToWidth }, {
              version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
            });
            const footer = tui.children.at(-1);
            return createCommandPanel({
              title: definition.title, tui, theme, done, periods: definition.periods,
              measure: { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi },
              load: (signal) => definition.load(ctx, signal, tui.mode), renderBody: definition.renderBody,
              renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width),
            });
          }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
          return;
        }
        try {
          const data = await definition.load(ctx, ctx.signal);
          const plainTheme: Palette = { fg: (_color, value) => value, bold: (value) => value };
          const output = [definition.title, ...definition.renderBody(data, 72, plainTheme, { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi }, { period: "all" })].join("\n");
          if (ctx.hasUI) ctx.ui.notify(output, "info");
          else console.error(output);
        } catch (error) {
          if (ctx.hasUI) ctx.ui.notify(errorMessage(error), "error");
          else console.error(errorMessage(error));
        }
      },
    });
  }
  register({ name: "usage", title: "Usage", description: "Show usage limits for the active provider", renderBody: usageLines,
    load: (ctx, signal) => fetchUsage(ctx, { signal }) });
  register({ name: "stats", title: "Statistics", description: "Show your local Pi activity calendar", renderBody: activityLines, periods: ["all", "week", "month"],
    load: (ctx, signal) => readActivity({ agentDir: getAgentDir(), sessionManager: ctx.sessionManager, signal }) });
  register({ name: "status", title: "Status", description: "Show Pi version, session, login, model, MCP servers, and tools", renderBody: statusLines,
    load: (ctx) => readStatus(ctx, pi, { version: VERSION, agentDir: getAgentDir(), packageDir: getPackageDir() }) });
  register({ name: "context", title: "Context", description: "Show context usage, loaded instructions, skills, and tools", renderBody: contextLines,
    load: (ctx) => {
      const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
      return readContextReport(ctx, pi, settings);
    } });
}
