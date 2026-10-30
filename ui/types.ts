import type { Component, Terminal, TUI, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface Palette {
  fg(role: string, value: string): string;
  bold(value: string): string;
}
export interface Measure {
  matchesKey: typeof matchesKey;
  truncateToWidth: typeof truncateToWidth;
  visibleWidth: typeof visibleWidth;
  wrapTextWithAnsi: typeof wrapTextWithAnsi;
  CURSOR_MARKER?: string;
}
export interface TreeComponent extends Component {
  children?: TreeComponent[];
  addChild?(component: TreeComponent): void;
  removeChild?(component: TreeComponent): void;
  dispose?(): void;
}
export interface HeaderTui {
  mode: string;
  children?: TreeComponent[];
  terminal?: Pick<Terminal, "rows" | "columns">;
}
export type PanelTui = Pick<TUI, "requestRender"> & { terminal: Pick<Terminal, "rows"> };
