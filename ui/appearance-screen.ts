import { createCommandPanel } from "./command-panel.js";
import type { PanelOptions } from "./command-panel.js";
import type { KeyId } from "@earendil-works/pi-tui";

interface Choice { value: string; label: string; description: string; swatch?: string }
type Options = Pick<PanelOptions<boolean>, "title" | "tui" | "theme" | "measure" | "done" | "renderHeader" | "renderFooter" | "onDispose">;
export function createAppearanceScreen({ choices, current, onSelect, ...options }: Options & {
  choices: Choice[]; current: string; onSelect(value: string): void;
}) {
  let selected = Math.max(0, choices.findIndex((choice) => choice.value === current));
  let positions: number[] = [];
  const { theme, measure, tui } = options;
  return createCommandPanel({ ...options, load: () => true,
    renderBody: (_data, width) => {
      let row = 0;
      positions = [];
      return choices.flatMap((choice, index) => {
        positions.push(row);
        const label = theme.fg(index === selected ? "primary" : "muted", index === selected ? theme.bold(choice.label) : choice.label);
        const lines = choice.swatch ? [theme.fg(choice.swatch, "●") + " " + label
          + theme.fg("dim", `  ${choice.description}${choice.value === current ? "  ✓" : ""}`), ""]
          : [theme.fg(index === selected ? "primary" : "muted", `${choice.value === current ? "●" : "○"} `) + label,
            theme.fg("dim", `  ${choice.description}`), ""];
        row += lines.reduce((count, line) => count + measure.wrapTextWithAnsi(line, width).length, 0);
        return lines;
      });
    },
    renderInput: (_width, focused) => (focused ? measure.CURSOR_MARKER ?? "" : "") + theme.fg("muted", "↑↓ choose · enter apply · esc cancel"),
    onInput(data, controls) {
      const key = (name: KeyId) => measure.matchesKey(data, name);
      if (key("escape") || key("ctrl+c")) { controls.close(false); return true; }
      if (key("enter")) { onSelect(choices[selected].value); controls.close(true); return true; }
      if (key("up") || key("shift+tab")) selected = Math.max(0, selected - 1);
      else if (key("down") || key("tab")) selected = Math.min(choices.length - 1, selected + 1);
      else return false;
      controls.reveal(positions[selected] ?? 0); tui.requestRender(); return true;
    },
  });
}
