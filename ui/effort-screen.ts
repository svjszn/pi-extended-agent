import { createCommandPanel } from "./command-panel.js";
import type { PanelOptions } from "./command-panel.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

export type EffortLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
interface EffortOptions extends Pick<PanelOptions<EffortLevel[]>, "tui" | "theme" | "measure" | "done" | "renderHeader" | "renderFooter"> {
  levels: EffortLevel[];
  current: EffortLevel;
  onSelect(level: EffortLevel): void;
}

export function createEffortScreen({ levels, current, onSelect, ...options }: EffortOptions) {
  let selected = Math.max(0, levels.indexOf(current));
  const { theme, measure, tui } = options;
  return createCommandPanel({ ...options, title: "Effort", load: () => levels,
    renderBody() {
      return [theme.fg("muted", "Choose a reasoning effort for this session."), "",
        ...levels.map((level, index) => {
          const text = `${level === current ? "●" : "○"} ${level}${level === current ? " current" : ""}`;
          return index === selected ? theme.fg("primary", theme.bold(text)) : theme.fg("muted", text);
        })];
    },
    renderInput: (_width, focused) => (focused ? measure.CURSOR_MARKER || "" : "")
      + theme.fg("muted", "↑↓ choose · enter apply · esc cancel"),
    onInput(data, controls) {
      const key = (name: KeyId) => measure.matchesKey(data, name);
      if (key("escape") || key("ctrl+c")) { controls.close(false); return true; }
      if (key("enter")) {
        if (levels[selected]) { onSelect(levels[selected]); controls.close(true); }
        return true;
      }
      if (key("up") || key("shift+tab")) selected = Math.max(0, selected - 1);
      else if (key("down") || key("tab")) selected = Math.min(levels.length - 1, selected + 1);
      else if (key("home")) selected = 0;
      else if (key("end")) selected = levels.length - 1;
      else return false;
      controls.reveal(2 + selected);
      tui.requestRender();
      return true;
    },
  });
}
