import { createCommandPanel } from "./command-panel.js";
import { configLines } from "./command-views.js";
import type { ConfigSection } from "../lib/config.js";
import type { ConfigPreferences } from "../lib/config-preferences.js";
import type { Measure, Palette, PanelTui } from "./types.js";

interface ConfigScreenOptions {
  tui: PanelTui;
  theme: Palette;
  measure: Measure;
  done(reopen?: boolean): void;
  readSections(): ConfigSection[];
  createPreferences?: () => ConfigPreferences;
  initialTab?: "overview" | "preferences";
  renderHeader?(width: number): string[];
  renderFooter?(width: number): string[] | undefined;
  onDispose?(): void;
}

export function createConfigScreen(options: ConfigScreenOptions) {
  const { theme, measure, tui } = options;
  let tab = options.initialTab ?? "overview";
  let preferences: ConfigPreferences | undefined;
  let sections: ConfigSection[] = [];
  let notice = "";
  let pageRows = 10;
  const leavePreferences = () => { preferences?.dispose(); preferences = undefined; };
  const openPreferences = () => {
    try {
      preferences = options.createPreferences?.();
      notice = preferences ? "" : "Preferences are unavailable in this engine.";
    } catch (error) { notice = error instanceof Error ? error.message : String(error); }
  };
  if (tab === "preferences") openPreferences();
  const panel = createCommandPanel({
    ...options, title: "Configuration",
    load: () => { sections = options.readSections(); return true; },
    renderBody: (_data, width) => {
      const tabs = ["overview", "preferences"].map((id) => {
        const label = id === "overview" ? "Overview" : "Preferences";
        return theme.fg(tab === id ? "primary" : "dim", tab === id ? theme.bold(label) : label);
      }).join(theme.fg("dim", " · "));
      if (tab === "overview") return [tabs, "", ...configLines(sections, width, theme, measure)];
      const raw = preferences?.render(width, pageRows - 2, theme) ?? [notice];
      return [tabs, "", ...raw];
    },
    onInput: (data, controls) => {
      const key = (name: Parameters<Measure["matchesKey"]>[1]) => measure.matchesKey(data, name);
      if (key("tab") || key("shift+tab")) {
        if (tab === "overview") { tab = "preferences"; openPreferences(); }
        else { leavePreferences(); tab = "overview"; sections = options.readSections(); }
        controls.resetScroll(); tui.requestRender(); return true;
      }
      if (tab === "overview") return false;
      if (key("ctrl+c")) { controls.close(); return true; }
      preferences?.handleInput(data);
      if (preferences?.hasPendingChange) { controls.close(true); return true; }
      if (!preferences || preferences.cancelled) {
        leavePreferences(); tab = "overview"; sections = options.readSections();
      }
      controls.resetScroll(); tui.requestRender(); return true;
    },
    renderInput: () => theme.fg("muted", tab === "overview" ? "tab preferences · esc to close" : "type to filter · enter edit · tab overview · esc back"),
    onDispose: () => { leavePreferences(); options.onDispose?.(); },
  });
  return {
    ...panel,
    render(width: number) {
      // Match the shared panel's body budget, including header, title, and input dock.
      const headerRows = tui.terminal.rows >= 18 && options.renderHeader ? options.renderHeader(width).length + 2 : 0;
      pageRows = Math.max(1, tui.terminal.rows - headerRows - (tui.terminal.rows >= 8 ? 2 : 0) - 4);
      return panel.render(width);
    },
  };
}
