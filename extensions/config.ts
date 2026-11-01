import { getAgentDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { CONFIG_PREFERENCES } from "../lib/config-preferences.js";
import type { ConfigPreferences, ConfigPreferencesUI } from "../lib/config-preferences.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function configCommand(pi: ExtensionAPI) {
  pi.registerCommand("config", {
    description: "Show configuration and edit preferences in the same screen",
    handler: async (_args, ctx) => {
      const [{ configSections }, { configLines }, { createUiTheme }] = await Promise.all([
        import("../lib/config.js"), import("../ui/command-views.js"), import("../ui/theme.js"),
      ]);
      const agentDir = getAgentDir();
      const readSections = (tuiMode?: string) => configSections(ctx, pi,
        SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() }), {
          agentDir, globalPath: join(agentDir, "settings.json"), projectPath: join(ctx.cwd, ".pi", "settings.json"), tuiMode, version: VERSION,
        });
      if (ctx.mode !== "tui") {
        const theme = createUiTheme({ color: false });
        const output = ["Configuration", ...configLines(readSections(), 72, theme)].join("\n");
        if (ctx.hasUI) ctx.ui.notify(output, "info"); else console.error(output);
        return;
      }
      const [{ createConfigScreen }, { createHeader }] = await Promise.all([
        import("../ui/config-screen.js"), import("../ui/chrome.js"),
      ]);
      let initialTab: "overview" | "preferences" = "overview";
      while (true) {
        let preferences: ConfigPreferences | undefined;
        const reopen = await ctx.ui.custom<boolean>((tui, _theme, _keys, done) => {
          const theme = createUiTheme();
          const measure = { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi };
          const header = createHeader({ mode: "regular" }, measure, {
            version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
          });
          const footer = tui.children.at(-1);
          const factory = (ctx.ui as ConfigPreferencesUI)[CONFIG_PREFERENCES];
          return createConfigScreen({ tui, theme, measure, done, initialTab,
            readSections: () => readSections(tui.mode),
            createPreferences: factory ? () => (preferences = factory()) : undefined,
            renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width),
            onDispose: () => header.dispose(),
          });
        }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
        if (!reopen || !preferences?.hasPendingChange) break;
        preferences.applyPendingChange();
        initialTab = "preferences";
      }
    },
  });
}
