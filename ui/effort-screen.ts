import { createCommandPanel } from "./command-panel.js";
import type { PanelOptions } from "./command-panel.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KeyId, TuiMouseEvent } from "@earendil-works/pi-tui";
import { animatedEffort, effortGlow } from "./effort-style.js";

export type EffortLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
interface EffortOptions extends Pick<PanelOptions<EffortLevel[]>, "tui" | "theme" | "measure" | "done" | "renderHeader" | "renderFooter" | "onDispose"> {
  levels: EffortLevel[];
  current: EffortLevel;
  onSelect(level: EffortLevel): void;
  now?(): number;
}

export function createEffortScreen({ levels, current, onSelect, now = Date.now, ...options }: EffortOptions) {
  let selected = Math.max(0, levels.indexOf(current));
  const { theme, measure, tui } = options;
  let timer: ReturnType<typeof setInterval> | undefined, disposed = false, dragging = false;
  let bodyTop = 0, pageRows = 1, trackY = 1, start = 0, cellWidth = 1, innerWidth = 1;
  const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
  const animate = () => {
    if (timer || disposed) return;
    timer = setInterval(() => {
      if (!animatedEffort(levels[selected])) { stop(); return; }
      tui.requestRender();
    }, 50);
    timer.unref?.();
  };
  const choose = (index: number) => {
    const next = Math.max(0, Math.min(levels.length - 1, index));
    if (next === selected || !levels.length) return;
    selected = next;
    if (animatedEffort(levels[selected])) animate(); else stop();
    tui.requestRender();
  };
  const panel = createCommandPanel({ ...options, title: "Effort", load: () => levels,
    renderBody(_data, width) {
      innerWidth = width;
      if (!levels.length) return [theme.fg("muted", "No effort levels available.")];
      const count = Math.max(1, Math.min(levels.length, Math.floor(width / 9)));
      start = Math.max(0, Math.min(levels.length - count, selected - Math.floor(count / 2)));
      cellWidth = Math.max(1, Math.floor(width / count));
      const span = Math.min(width, count * cellWidth);
      const seconds = now() / 1000;
      const labels = levels.slice(start, start + count).map((level, index) => {
        const text = measure.truncateToWidth(level, cellWidth, "");
        const before = Math.floor((cellWidth - measure.visibleWidth(text)) / 2);
        const active = index + start === selected;
        const colored = level === "low" ? theme.fg("effortLow", text) : level === "medium" ? theme.fg("effortMedium", text)
          : active ? (animatedEffort(level) ? effortGlow(level, text, seconds) : theme.fg("primary", text))
          : theme.fg(level === "high" ? "effortHigh" : level === "xhigh" ? "effortXhigh" : "muted", text);
        return " ".repeat(before) + (active ? theme.bold(colored) : colored)
          + " ".repeat(cellWidth - before - measure.visibleWidth(text));
      }).join("");
      const thumb = Math.max(0, Math.min(span - 1, (selected - start) * cellWidth + Math.floor(cellWidth / 2)));
      const track = Array.from({ length: span }, (_value, column) => {
        const node = column % cellWidth === Math.floor(cellWidth / 2);
        const glyph = column === thumb ? "●" : node ? "○" : "─";
        return theme.fg(column === thumb ? "primary" : "dim", glyph);
      }).join("");
      const intro = pageRows >= 4 && width >= 15 ? [theme.fg("dim", "faster") + " ".repeat(width - 13) + theme.fg("dim", "smarter"), ""] : [];
      trackY = bodyTop + intro.length + 1;
      if (animatedEffort(levels[selected])) animate();
      return [...intro, labels, track];
    },
    renderInput: (_width, focused) => (focused ? measure.CURSOR_MARKER || "" : "")
      + theme.fg("muted", "←→ adjust · enter apply · esc cancel"),
    onInput(data, controls) {
      const key = (name: KeyId) => measure.matchesKey(data, name);
      if (key("escape") || key("ctrl+c")) { controls.close(false); return true; }
      if (key("enter")) {
        if (levels[selected]) { onSelect(levels[selected]); controls.close(true); }
        return true;
      }
      if (key("left") || key("up") || key("shift+tab")) choose(selected - 1);
      else if (key("right") || key("down") || key("tab")) choose(selected + 1);
      else if (key("home")) choose(0);
      else if (key("end")) choose(levels.length - 1);
      else return false;
      return true;
    },
    onDispose() { disposed = true; dragging = false; stop(); options.onDispose?.(); },
  });
  return {
    ...panel,
    render(width: number) {
      const height = tui.terminal.rows;
      const headerRows = height >= 18 && options.renderHeader ? options.renderHeader(width).length + 2 : 0;
      bodyTop = headerRows + (height >= 8 ? 2 : 0);
      pageRows = Math.max(0, height - bodyTop - (height >= 6 ? 4 : Math.min(2, height)));
      return panel.render(width);
    },
    handleMouse(event: TuiMouseEvent) {
      if (event.type === "release" && dragging) { dragging = false; return { handled: true }; }
      const onTrack = event.y === trackY || event.y === trackY - 1;
      if ((event.button === "left" && onTrack && ["press", "click"].includes(event.type)) || (dragging && event.type === "drag")) {
        const inset = Math.min(2, Math.floor(Math.max(0, event.width - 1) / 2));
        const x = Math.max(0, Math.min(innerWidth - 1, event.x - inset));
        choose(start + Math.floor(x / cellWidth));
        dragging = event.type === "press" || event.type === "drag";
        return { handled: true, capture: dragging };
      }
      return panel.handleMouse(event);
    },
  };
}
