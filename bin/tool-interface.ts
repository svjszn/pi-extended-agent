import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import type { TreeComponent } from "../ui/types.js";
import { createUiTheme } from "../ui/theme.js";

interface Activity extends TreeComponent {
  expanded: boolean;
  setExpanded(value: boolean): void;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: { isError?: boolean; content?: { type: string; text?: string }[] };
  isPartial?: boolean;
  status?: string;
  exitCode?: number;
  getCommand?(): string;
  skillBlock?: { name: string };
  hideComponent?: boolean;
}
const clean = (value: string) => stripTerminalSequences(value.slice(0, 512)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
const nativeStyle = /\x1b\[[0-9;:]*m/g;

export function isActivity(component: TreeComponent): component is Activity {
  return ["ToolExecutionComponent", "BashExecutionComponent", "SkillInvocationMessageComponent"].includes(component.constructor.name)
    && "setExpanded" in component && typeof component.setExpanded === "function" && "expanded" in component;
}

/** Presentation only: retain the native execution, results, and expansion state. */
export function styleToolCall(component: Activity, repaint: () => void) {
  const render = component.render;
  const mouse = component.handleMouse;
  const theme = createUiTheme();
  component.render = function (width) {
    if (width < 1 || component.hideComponent) return [];
    const inset = Math.min(2, Math.floor((width - 1) / 2));
    const inner = Math.max(1, width - inset);
    const pad = " ".repeat(inset);
    const command = component.getCommand?.();
    const name = component.skillBlock ? "skill" : command !== undefined ? "bash" : component.toolName ?? "tool";
    const args = component.args;
    const target = component.skillBlock?.name ?? command ?? ["command", "path", "file_path", "filePath", "pattern", "query", "url"]
      .map((key) => args?.[key]).find((value): value is string => typeof value === "string") ?? "";
    const failed = component.result?.isError || component.status === "error";
    const running = component.toolName ? component.isPartial !== false : component.status === "running";
    const status = failed ? "failed" : component.status === "cancelled" ? "cancelled" : running ? "running" : "";
    const summary = `${component.expanded ? "▾" : "▸"} ${clean(name)}${target ? ` ${clean(target)}` : ""}`;
    const suffix = status ? ` · ${status}${failed && component.exitCode !== undefined ? ` (${component.exitCode})` : ""}` : "";
    const label = truncateToWidth(summary, Math.max(1, inner - visibleWidth(suffix))) + suffix;
    const lines = [pad + theme.fg(failed ? "text" : "muted", truncateToWidth(label, inner))];
    if (component.expanded) {
      // Preserve native Markdown, diffs, images, and output limits. Remove the
      // colored cards; the disclosure header supplies the framing and click target.
      lines.push(...render.call(component, inner).map((line) => pad + theme.fg("muted", line.replace(nativeStyle, ""))));
    } else if (failed) {
      const reason = component.result?.content?.find((part) => part.type === "text" && part.text)?.text;
      if (reason) lines.push(pad + theme.fg("dim", truncateToWidth(clean(reason), inner)));
    }
    return lines;
  };
  component.handleMouse = function (event: TuiMouseEvent) {
    if (event.y === 0 && event.type === "click" && event.button === "left") {
      component.setExpanded(!component.expanded);
      repaint();
      return { handled: true };
    }
    if (!component.expanded || event.y < 1) return undefined;
    const inset = Math.min(2, Math.floor(Math.max(0, event.width - 1) / 2));
    return mouse?.call(component, { ...event, x: event.x - inset, y: event.y - 1, width: Math.max(1, event.width - inset), height: Math.max(0, event.height - 1) });
  };
  return () => { component.render = render; component.handleMouse = mouse; };
}
