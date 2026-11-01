import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ACCENT_COLORS, AppearanceStore, getAppearance, setAppearance } from "../lib/appearance.js";
import type { Appearance } from "../lib/appearance.js";
import { nativeAppearanceTheme } from "../ui/appearance.js";

export default function appearanceCommands(pi: ExtensionAPI, store = new AppearanceStore(getAgentDir())) {
  const notify = (ctx: ExtensionContext, message: string, type: "info" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, type); else console.error(message);
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      const value = store.read();
      const result = ctx.ui.setTheme(nativeAppearanceTheme(ctx.ui, value));
      if (!result.success) throw new Error(result.error ?? "Could not apply appearance.");
      setAppearance(value);
    } catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), "error"); }
  });
  const choices = {
    theme: [{ value: "dark", label: "Dark", description: "Black background with light text." },
      { value: "light", label: "Light", description: "White background with dark text." }],
    color: [{ value: "default", label: "Default", description: "Neutral", swatch: "primary" },
      ...Object.entries(ACCENT_COLORS).map(([value, description]) => ({
        value, label: value[0].toUpperCase() + value.slice(1), description, swatch: value,
      }))],
  };
  for (const command of ["theme", "color"] as const) {
    pi.registerCommand(command, {
      description: command === "theme" ? "Choose a dark or light theme" : "Choose the interface accent color",
      getArgumentCompletions: (prefix) => choices[command].filter((choice) => choice.value.startsWith(prefix.trim().toLowerCase()))
        .map(({ value, label }) => ({ value, label })),
      handler: async (args, ctx) => {
        const field = command === "theme" ? "mode" : "color";
        let value = args.trim().toLowerCase();
        if (!value && ctx.mode === "tui") {
          const [{ createAppearanceScreen }, { createUiTheme }, { createHeader }] = await Promise.all([
            import("../ui/appearance-screen.js"), import("../ui/theme.js"), import("../ui/chrome.js"),
          ]);
          await ctx.ui.custom((tui, _nativeTheme, _keys, done) => {
            const theme = createUiTheme(), measure = { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi };
            const header = createHeader({ mode: "regular" }, measure, {
              version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
            });
            const footer = tui.children.at(-1);
            return createAppearanceScreen({ title: command === "theme" ? "Theme" : "Color", tui, theme, measure, done,
              choices: choices[command], current: getAppearance()[field], onSelect: (choice) => { value = choice; },
              renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width), onDispose: () => header.dispose(),
            });
          }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
          if (!value) return;
        }
        if (!value) { notify(ctx, `${command === "theme" ? "Theme" : "Color"}: ${getAppearance()[field]}`); return; }
        if (!choices[command].some((choice) => choice.value === value)) {
          notify(ctx, `Available ${command === "theme" ? "themes" : "colors"}: ${choices[command].map((choice) => choice.value).join(", ")}.`, "error"); return;
        }
        const next = { ...getAppearance(), [field]: value } as Appearance;
        const previousTheme = ctx.ui.theme;
        try {
          if (ctx.mode === "tui") {
            const result = ctx.ui.setTheme(nativeAppearanceTheme(ctx.ui, next));
            if (!result.success) throw new Error(result.error ?? "Could not apply appearance.");
          }
          store.write(next);
          setAppearance(next);
          notify(ctx, `${command === "theme" ? "Theme" : "Color"}: ${value}`);
        } catch (error) {
          if (ctx.mode === "tui") ctx.ui.setTheme(previousTheme);
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  }
}
