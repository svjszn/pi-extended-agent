import type { KeyId, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Measure, Palette, PanelTui } from "./types.js";
import { errorMessage } from "../lib/errors.js";

export type Period = "all" | "week" | "month";
export interface PanelControls {
  close(result?: boolean): void;
  scroll(delta: number): void;
  resetScroll(): void;
  reveal(line: number): void;
  readonly pageSize: number;
}
export interface PanelOptions<T> {
  title: string;
  tui: PanelTui;
  theme: Palette;
  measure: Measure;
  done(result?: boolean): void;
  load(signal: AbortSignal): T | Promise<T>;
  renderBody(data: T, width: number, theme: Palette, measure: Measure, options: { period: Period }): string[];
  renderHeader?(width: number): string[];
  renderFooter?(width: number): string[] | undefined;
  periods?: Period[];
  onInput?(input: string, controls: PanelControls): boolean;
  renderInput?(width: number, focused: boolean): string;
  onDispose?(): void;
}

/** Full terminal screen; the prompt is display-only while this view has focus. */
export function createCommandPanel<T>({ title, tui, theme, measure, done, load, renderBody, renderHeader, renderFooter, periods, onInput, renderInput, onDispose }: PanelOptions<T>) {
  const controller = new AbortController();
  let data: T | undefined, error: string | undefined, revealLine: number | undefined;
  let closed = false, offset = 0, maxOffset = 0, pageSize = 1, period = 0;
  const repaint = () => { if (!closed) tui.requestRender(); };
  const ready = Promise.resolve().then(() => load(controller.signal)).then((value) => {
    data = value;
  }, (reason) => {
    error = errorMessage(reason).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  }).then(repaint);
  const dispose = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    onDispose?.();
  };
  const close = (result?: boolean) => {
    if (closed) return;
    dispose();
    done(result);
  };
  const scroll = (delta: number) => { offset = Math.max(0, Math.min(maxOffset, offset + delta)); repaint(); };
  const controls: PanelControls = { close, scroll, resetScroll: () => { offset = 0; }, reveal: (line) => { revealLine = line; }, get pageSize() { return pageSize; } };
  return {
    ready, focused: false,
    invalidate() {},
    dispose,
    handleInput(input: string) {
      if (onInput?.(input, controls)) return;
      const key = (name: KeyId) => measure.matchesKey(input, name);
      if (key("escape") || key("enter") || key("ctrl+c")) { close(); return; }
      if (periods?.length && (key("tab") || key("right") || key("shift+tab") || key("left"))) {
        const direction = key("left") || key("shift+tab") ? -1 : 1;
        period = (period + direction + periods.length) % periods.length;
        repaint();
      } else if (key("up")) scroll(-1);
      else if (key("down")) scroll(1);
      else if (key("pageUp")) scroll(-pageSize);
      else if (key("pageDown")) scroll(pageSize);
      else if (key("home")) scroll(-maxOffset);
      else if (key("end")) scroll(maxOffset);
    },
    handleMouse(event: TuiMouseEvent) {
      if (event.type !== "wheel") return { handled: false };
      scroll(event.wheelDelta || 0);
      return { handled: true };
    },
    render(width: number) {
      const height = Math.max(1, tui.terminal.rows);
      const indent = Math.min(2, Math.floor(Math.max(0, width - 1) / 2));
      const inner = Math.max(1, width - indent * 2);
      const pad = " ".repeat(indent);
      const header = height >= 18 && renderHeader ? ["", ...renderHeader(width), ""] : [];
      const heading = height >= 8 ? [pad + theme.fg("primary", theme.bold(title)), ""] : [];
      const body = error ? [theme.fg("warning", error)] : data === undefined
        ? [theme.fg("muted", "Loading…")] : renderBody(data, inner, theme, measure, { period: periods?.[period] || "all" });
      const lines = body.flatMap((line) => measure.wrapTextWithAnsi(line, inner));
      const inputHeight = height >= 6 ? 4 : Math.min(2, height);
      pageSize = Math.max(0, height - header.length - heading.length - inputHeight);
      maxOffset = Math.max(0, lines.length - pageSize);
      if (revealLine !== undefined) {
        if (revealLine < offset) offset = revealLine;
        else if (revealLine >= offset + pageSize) offset = revealLine - pageSize + 1;
        revealLine = undefined;
      }
      offset = Math.max(0, offset);
      offset = Math.min(offset, maxOffset);
      const content = lines.slice(offset, offset + pageSize).map((line) => pad + line);
      while (content.length < pageSize) content.push("");
      const rule = pad + theme.fg("border", "─".repeat(inner));
      const marker = this.focused ? measure.CURSOR_MARKER || "" : "";
      const scrollHint = maxOffset > 0 && inner >= 30 ? "↑↓ scroll" : "";
      const prompt = pad + (renderInput ? renderInput(inner, this.focused)
        : marker + theme.fg("muted", "esc to close") + (scrollHint ? " ".repeat(Math.max(1, inner - 12 - scrollHint.length)) + theme.fg("dim", scrollHint) : ""));
      const footer = renderFooter?.(width)?.at(-1) || "";
      const input = inputHeight === 4 ? [rule, prompt, rule, footer] : [prompt, footer].slice(0, inputHeight);
      return [...header, ...heading, ...content, ...input].slice(0, height).map((line) => {
        const clipped = measure.truncateToWidth(line, width);
        return clipped + " ".repeat(Math.max(0, width - measure.visibleWidth(clipped)));
      });
    },
  };
}
