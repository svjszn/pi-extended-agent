import { createChatStyle } from "./chat.js";
import { shareTranscriptFrame } from "../bin/transcript-interface.js";
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

/** Session-owned terminal chrome; never change the user's terminal settings. */
export function pinTerminalTitle(terminal: Pick<Terminal, "setTitle"> & Partial<Pick<Terminal, "setProgress">>, platform = process.platform) {
  const original = terminal.setTitle;
  const originalProgress = terminal.setProgress;
  let disposed = false;
  const refresh = () => { if (!disposed) original.call(terminal, "Pi Coding Agent"); };
  const setTitle = () => refresh();
  const quietProgress = (_active: boolean) => {};
  terminal.setTitle = setTitle;
  if (platform === "win32" && originalProgress) {
    // Stop an existing keepalive before suppressing future OSC 9;4 signals.
    originalProgress.call(terminal, false);
    terminal.setProgress = quietProgress;
  }
  refresh();
  return Object.assign(() => {
    if (disposed) return;
    disposed = true;
    if (terminal.setTitle === setTitle) terminal.setTitle = original;
    if (terminal.setProgress === quietProgress) terminal.setProgress = originalProgress;
  }, { refresh });
}

/** The header owns the shared appearance palette; it never renders with the native theme. */
export function createHeader(tui: HeaderTui, { truncateToWidth }: HeaderMeasure, info: HeaderInfo) {
  let hiddenResources: { document: TreeComponent & { children: TreeComponent[] }; component: TreeComponent; index: number } | undefined;
  const palette = createUiTheme();
  const ink = (text: string) => palette.fg("primary", text);
  const chatStyle = createChatStyle(() => tui.requestRender?.());
  // Install before the first document frame, not from inside header.render().
  // Pi mounts the document with its header container first and chat last.
  const document = tui.children?.find((component) => Array.isArray(component.children?.[0]?.children));
  const restoreFrame = tui.mode === "fullscreen" && document ? shareTranscriptFrame(document) : undefined;
  const header = {
    invalidate() {},
    dispose() {
      restoreFrame?.();
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
      // Short conversations need flexible space above them. In fullscreen the
      // document adapter shares these measurements with the real render, so
      // counting chat rows no longer renders its messages a second time.
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
