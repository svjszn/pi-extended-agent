import { createChatStyle } from "./chat.js";
import type { HeaderTui, Palette, TreeComponent } from "./types.js";
import type { Terminal, truncateToWidth as truncate } from "@earendil-works/pi-tui";
import type { ContextSummary } from "../lib/context.js";
import { contextTokens, contextPercent } from "./context-format.js";
import { permissionFooter } from "../lib/permissions.js";
import type { PermissionMode } from "../lib/permissions.js";
import { createUiTheme } from "./theme.js";

interface HeaderInfo {
  version: string;
  getModel(): { id: string; name?: string } | undefined;
  getThinkingLevel(): string;
  getCwd?(): string;
  getAuthNotice?(): string | undefined;
}
type HeaderMeasure = { truncateToWidth: typeof truncate };

export function pinTerminalTitle(terminal: Pick<Terminal, "setTitle">) {
  const original = terminal.setTitle;
  const setTitle = () => original.call(terminal, "Pi Coding Agent");
  terminal.setTitle = setTitle;
  setTitle();
  return () => { if (terminal.setTitle === setTitle) terminal.setTitle = original; };
}

export function createHeader(tui: HeaderTui, theme: Palette, { truncateToWidth }: HeaderMeasure, info: HeaderInfo) {
  let hiddenResources: { document: TreeComponent & { children: TreeComponent[] }; component: TreeComponent; index: number } | undefined;
  const palette = createUiTheme();
  const ink = (text: string) => palette.fg("primary", text);
  const chatStyle = createChatStyle(() => tui.requestRender?.());
  const header = {
    invalidate() {},
    dispose() {
      chatStyle.dispose();
      if (!hiddenResources) return;
      const { document, component, index } = hiddenResources;
      if (!document.children.includes(component)) document.children.splice(index, 0, component);
      hiddenResources = undefined;
    },
    render(width: number): string[] {
      // Official pi.dev mark, normalized to its 4×4 square grid.
      // Two terminal columns per pixel preserve square proportions.
      // The original SVG geometry is kept alongside this file in pi-logo.svg.
      const logo = ["██████  ", "██  ██  ", "████  ██", "██    ██"];
      const model = info.getModel();
      const modelName = model?.id?.startsWith("gpt-")
        ? model.id.split("-").map((part, index) => index === 0 ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1)).join("-")
        : model?.name ?? model?.id ?? "No model selected";
      const title = ink(palette.bold(`pi coding agent v${info.version}`));
      const subtitle = palette.fg("muted", `${modelName} with ${info.getThinkingLevel()} effort`);
      const cwd = String(info.getCwd?.() ?? process.cwd()).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
      const labels = [title, subtitle, palette.fg("dim", cwd)];
      const content = width >= 32
        ? logo.map((row, index) => `  ${palette.fg("logo", row)}   ${labels[index] ?? ""}`)
        : [...logo.map((row) => `  ${palette.fg("logo", row)}`), ...labels.map((label) => `  ${label}`)];
      const lines = content.map((line) => truncateToWidth(line, width));
      const authNotice = info.getAuthNotice?.();
      if (authNotice) lines.push(truncateToWidth(`  ${palette.fg("muted", authNotice)}`, width));
      // Command overlays reuse the header without mounting a chat document.
      if (!Array.isArray(tui.children)) return lines;
      // The public TUI tree contains the document and input dock. Measure the
      // other components to give short conversations flexible space above them.
      // When the transcript fills the viewport, this space naturally reaches 0.
      const document = tui.children.find((component) =>
        component.children?.some((child) => child.children?.includes(header)),
      );
      if (!document?.children) return lines;
      const headerContainer = document.children.find((child) => child.children?.includes(header));
      const chat = document.children.at(-1);
      if (chat !== headerContainer && Array.isArray(chat?.children)) chatStyle.apply({ children: chat.children }, width);
      if (tui.mode !== "fullscreen" || !tui.terminal) return lines;
      // Supported Pi versions mount header, startup resource list, and chat in this order.
      // Hide only the startup list; the skills and extensions still load normally.
      if (!hiddenResources && document.children.length === 3 && document.children[0] === headerContainer) {
        hiddenResources = { document: document as TreeComponent & { children: TreeComponent[] }, component: document.children[1], index: 1 };
        document.removeChild?.(hiddenResources.component);
      }
      let occupied = 0;
      for (const component of tui.children) {
        if (component !== document) occupied += component.render(tui.terminal.columns).length;
      }
      for (const component of document.children) {
        if (component !== headerContainer) occupied += component.render(width).length;
      }
      for (const component of headerContainer?.children || []) {
        if (component !== header) occupied += component.render(width).length;
      }
      const gap = Math.max(0, tui.terminal.rows - occupied - lines.length);
      return [...lines, ...Array(gap).fill("")];
    },
  };
  return header;
}

export function createFooter(_ctx: unknown, _tui: unknown, theme: Palette, _footerData: unknown, { truncateToWidth }: HeaderMeasure,
  getContext?: () => ContextSummary | undefined, getPermissions?: () => PermissionMode, getPlanning?: () => boolean) {
  const palette = createUiTheme();
  return {
    invalidate() {},
    dispose() {},
    render(width: number) {
      if (width < 1) return [];
      const planning = getPlanning?.() === true;
      const permissions = getPermissions?.() ?? "full";
      const modeLabel = planning ? "plan mode" : permissionFooter(permissions);
      const modeColor = planning ? "effortMedium" : permissions === "full" ? "effortLow" : "dim";
      const left = `  ${palette.fg(modeColor, modeLabel)}`;
      const usage = getContext?.();
      if (!usage) return [truncateToWidth(left, width)];
      const percent = usage.percent === null ? "—" : contextPercent(usage.percent);
      const used = usage.tokens === null ? "—" : `~${contextTokens(usage.tokens)}`;
      const full = usage.tokens === null
        ? usage.contextWindow ? `— / ${contextTokens(usage.contextWindow)} context` : "context —"
        : `${used}${usage.contextWindow ? ` / ${contextTokens(usage.contextWindow)}` : ""}${usage.percent !== null ? ` · ${percent}` : ""} context`;
      for (const right of [full, `${percent} context`, `${percent} ctx`]) {
        const gap = width - (modeLabel.length + 2) - right.length - 2;
        if (gap >= 2) return [left + " ".repeat(gap) + theme.fg("dim", right) + "  "];
      }
      return [truncateToWidth(left, width)];
    },
  };
}
