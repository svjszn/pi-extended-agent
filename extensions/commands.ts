import { getAgentDir, getPackageDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PanelOptions, Period } from "../ui/command-panel.js";
import type { Palette } from "../ui/types.js";
import { errorMessage } from "../lib/errors.js";

interface CommandDefinition<T> {
  title: string; periods?: Period[];
  renderBody: PanelOptions<T>["renderBody"];
  load(ctx: ExtensionCommandContext, signal?: AbortSignal, tuiMode?: string): T | Promise<T>;
}

export default function commands(pi: ExtensionAPI) {
  function register<T>(name: string, description: string, loadDefinition: () => Promise<CommandDefinition<T>>) {
    pi.registerCommand(name, {
      description,
      handler: async (_args, ctx) => {
        const definition = await loadDefinition();
        if (ctx.mode === "tui") {
          const [{ createCommandPanel }, { createUiTheme }, { createHeader }] = await Promise.all([
            import("../ui/command-panel.js"), import("../ui/theme.js"), import("../ui/chrome.js"),
          ]);
          await ctx.ui.custom((tui, _theme, _keybindings, done) => {
            const theme = createUiTheme();
            const header = createHeader({ mode: "regular" }, { truncateToWidth }, {
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
  register("usage", "Show usage limits for the active provider", async () => {
    const [{ fetchUsage }, { usageLines }] = await Promise.all([import("../lib/usage.js"), import("../ui/command-views.js")]);
    return { title: "Usage", renderBody: usageLines, load: (ctx, signal) => fetchUsage(ctx, { signal }) };
  });
  register("stats", "Show your local Pi activity calendar", async () => {
    const [{ readActivity }, { activityLines }] = await Promise.all([import("../lib/activity.js"), import("../ui/command-views.js")]);
    return { title: "Statistics", renderBody: activityLines, periods: ["all", "week", "month"],
      load: (ctx, signal) => readActivity({ agentDir: getAgentDir(), sessionManager: ctx.sessionManager, signal }) };
  });
  register("status", "Show Pi version, session, login, model, MCP servers, and tools", async () => {
    const [{ readStatus }, { statusLines }] = await Promise.all([import("../lib/status.js"), import("../ui/status-view.js")]);
    return { title: "Status", renderBody: statusLines,
      load: (ctx) => readStatus(ctx, pi, { version: VERSION, agentDir: getAgentDir(), packageDir: getPackageDir() }) };
  });
  register("context", "Show context usage, loaded instructions, skills, and tools", async () => {
    const [{ readContextReport }, { contextLines }] = await Promise.all([import("../lib/context.js"), import("../ui/context-view.js")]);
    return { title: "Context", renderBody: contextLines, load: (ctx) => {
      const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
      return readContextReport(ctx, pi, settings);
    } };
  });
}
