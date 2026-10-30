import { createCommandPanel } from "./command-panel.js";
import type { PanelOptions } from "./command-panel.js";

interface ModelRef { provider: string; id: string; name?: string }
export interface NativeModelSelector {
  filteredModels: { id: string; provider: string; model: ModelRef }[];
  selectedIndex: number;
  currentModel?: ModelRef;
  defaultModel?: ModelRef;
  scopedModels: unknown[];
  scope: string;
  errorMessage?: string;
  refreshStatusMessage: string;
  focused: boolean;
  handleInput(data: string): void;
  getSearchInput(): { render(width: number): string[] };
}
type ModelScreenOptions = Pick<PanelOptions<boolean>, "tui" | "theme" | "measure" | "done" | "renderHeader" | "renderFooter" | "onDispose">;
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

/** Native controller keeps search, scopes, refresh, keybindings, and selection callbacks. */
export function createModelScreen({ selector, ...options }: ModelScreenOptions & { selector: NativeModelSelector }) {
  if (!Array.isArray(selector.filteredModels) || typeof selector.getSearchInput !== "function") {
    throw new Error("Pi model selection is incompatible with this interface.");
  }
  const { theme, measure, tui } = options;
  let bodyWidth = 72, selectedRow = 2, lastSelection = "";
  let controls: { reveal(line: number): void } | undefined;
  const renderModels = (width: number) => {
    bodyWidth = width;
    const items = selector.filteredModels;
    const lines = [theme.fg("muted", "Choose a model for this session.")];
    if (selector.scopedModels.length) lines.push(theme.fg("dim", `Scope: ${selector.scope} · tab to switch`));
    lines.push("");
    selectedRow = lines.reduce((sum, line) => sum + measure.wrapTextWithAnsi(line, width).length, 0);
    for (const [index, item] of items.entries()) {
      const current = selector.currentModel?.provider === item.provider && selector.currentModel.id === item.id;
      const saved = selector.defaultModel?.provider === item.provider && selector.defaultModel.id === item.id;
      const text = `${current ? "●" : "○"} ${clean(item.id)} [${clean(item.provider)}]${current ? " current" : ""}${saved ? " default" : ""}`;
      const line = index === selector.selectedIndex ? theme.fg("primary", theme.bold(text)) : theme.fg("muted", text);
      lines.push(line);
      if (index < selector.selectedIndex) selectedRow += measure.wrapTextWithAnsi(line, width).length;
    }
    if (!items.length) lines.push(theme.fg("muted", "No matching models. Use /login to add a provider."));
    const selected = items[selector.selectedIndex];
    if (selected?.model.name) lines.push("", theme.fg("dim", clean(selected.model.name)));
    const status = selector.errorMessage || selector.refreshStatusMessage;
    if (status) lines.push("", ...status.split("\n").map((line) => theme.fg("dim", clean(line))));
    lines.push("", theme.fg("dim", "↑↓ choose · enter apply · ctrl+s set default · esc cancel"));
    const selection = `${width}:${selector.scope}:${selector.selectedIndex}:${selected?.id}:${items.length}`;
    if (selection !== lastSelection) { controls?.reveal(selectedRow); lastSelection = selection; }
    return lines;
  };
  const panel = createCommandPanel({ ...options, title: "Model", load: () => true,
    renderBody: (_data, width) => renderModels(width),
    renderInput(width, focused) {
      selector.focused = focused;
      const line = selector.getSearchInput().render(Math.max(1, width))[0] ?? "";
      return theme.fg("text", line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
    },
    onInput(data, panelControls) {
      controls = panelControls;
      selector.handleInput(data);
      renderModels(bodyWidth);
      controls.reveal(selectedRow);
      tui.requestRender();
      return true;
    },
  });
  return panel;
}
