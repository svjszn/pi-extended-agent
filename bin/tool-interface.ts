import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import type { TreeComponent } from "../ui/types.js";
import { createUiTheme } from "../ui/theme.js";
import { isAbsolute, relative, sep } from "node:path";

export interface Activity extends TreeComponent {
  expanded: boolean;
  setExpanded(value: boolean): void;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: { isError?: boolean; content?: { type: string; text?: string }[]; details?: { diff?: unknown } };
  isPartial?: boolean;
  status?: string;
  exitCode?: number;
  getCommand?(): string;
  skillBlock?: { name: string };
  hideComponent?: boolean;
  outputLines?: string[];
  cwd?: string;
}
export interface ToolGroup { members: Activity[]; open: boolean; expanded: boolean }
export interface ToolPresentation { group?: ToolGroup; gap?: boolean }

/** Native tool-only assistant messages occupy no rows between research calls. */
export function isToolOnlyMessage(component: TreeComponent) {
  const message = component as TreeComponent & { lastMessage?: { content?: { type: string; text?: string }[] } };
  return component.constructor.name === "AssistantMessageComponent"
    && message.lastMessage?.content?.every(part => part.type === "toolCall" || part.type === "text" && !part.text?.trim()) === true;
}

const clean = (value: string) => stripTerminalSequences(value.slice(0, 512)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
const nativeStyle = /\x1b\[[0-9;:]*m/g;
const backgrounds = /\x1b\[(?:48;(?:2;\d+;\d+;\d+|5;\d+)|49)m/g;
const actions: Record<string, string> = { read: "Read", find: "Find", grep: "Search", ls: "List", bash: "Bash", edit: "Update", write: "Write", task: "Task", skill: "Skill" };

/** Only settled, successful research may disappear into a summary. */
export function isResearchActivity(component: TreeComponent): component is Activity {
  return isActivity(component) && ["read", "find", "grep", "ls"].includes(component.toolName ?? "")
    && !component.hideComponent && component.status !== "cancelled" && component.status !== "error"
    && component.isPartial === false && Boolean(component.result) && !component.result?.isError;
}

function researchSummary(group: ToolGroup) {
  const reads = group.members.filter(member => member.toolName === "read");
  const files = new Set(reads.map(member => member.args?.path ?? member.args?.file_path ?? member));
  const searches = group.members.filter(member => member.toolName === "grep" || member.toolName === "find").length;
  const lists = group.members.filter(member => member.toolName === "ls").length;
  return "Explored " + [files.size ? `${files.size} ${files.size === 1 ? "file" : "files"}` : "",
    searches ? `${searches} ${searches === 1 ? "search" : "searches"}` : "",
    lists ? `${lists} ${lists === 1 ? "directory listing" : "directory listings"}` : ""].filter(Boolean).join(" · ");
}

function preview(component: Activity) {
  const text = component.result?.content?.find(part => part.type === "text" && part.text)?.text;
  const lines = component.outputLines?.slice(-3) ?? text?.slice(-8192).split(/\r?\n/).slice(-3) ?? [];
  return lines.map(clean).filter(Boolean).at(-1);
}

function pathLabel(path: string, cwd?: string) {
  if (!cwd || !isAbsolute(path)) return clean(path);
  const local = relative(cwd, path);
  return clean(local && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local) ? local : path);
}

function editSummary(component: Activity) {
  const diff = component.result?.details?.diff;
  if (typeof diff !== "string" || diff.length > 512_000) return undefined;
  let added = 0, removed = 0;
  // Pi's applied diff uses +123/-123 line prefixes. Count only confirmed edits.
  for (const line of diff.split("\n")) {
    if (/^\+\s*\d+ /.test(line)) added++;
    else if (/^-\s*\d+ /.test(line)) removed++;
  }
  return [added ? `Added ${added} ${added === 1 ? "line" : "lines"}` : "",
    removed ? `${added ? "removed" : "Removed"} ${removed} ${removed === 1 ? "line" : "lines"}` : ""].filter(Boolean).join(", ") || undefined;
}

export function isActivity(component: TreeComponent): component is Activity {
  return ["ToolExecutionComponent", "BashExecutionComponent", "SkillInvocationMessageComponent"].includes(component.constructor.name)
    && "setExpanded" in component && typeof component.setExpanded === "function" && "expanded" in component;
}

/** Presentation only: retain the native execution, results, and expansion state. */
export function styleToolCall(component: Activity, repaint: () => void, presentation: ToolPresentation = {}) {
  const render = component.render;
  const mouse = component.handleMouse;
  const theme = createUiTheme();
  let nativeTop = 0, nativeHeaderRows = 1, nativeHeight = 0, nativeInset = 0, groupRow = -1, toolRow = 0;
  const currentGroup = () => presentation.group && isResearchActivity(component) ? presentation.group : undefined;
  component.render = function (width) {
    if (width < 1 || component.hideComponent) return [];
    const group = currentGroup(), leader = group?.members[0] === component;
    if (leader) group!.expanded = group!.open || group!.members.some(member => member.expanded);
    const groupExpanded = group ? group.expanded || component.expanded : false;
    if (group && !leader && !groupExpanded) return [];
    const inset = Math.min(2, Math.floor((width - 1) / 2));
    const inner = Math.max(1, width - inset);
    const pad = " ".repeat(inset);
    const command = component.getCommand?.();
    const name = component.skillBlock ? "skill" : command !== undefined ? "bash" : component.toolName ?? "tool";
    const args = component.args;
    const keys = ["grep", "find"].includes(name) ? ["pattern", "query", "path"] : ["command", "path", "file_path", "filePath", "agent", "pattern", "query", "url"];
    const target = component.skillBlock?.name ?? command ?? keys
      .map((key) => args?.[key]).find((value): value is string => typeof value === "string") ?? "";
    const failed = component.result?.isError || component.status === "error";
    const running = component.toolName ? component.isPartial !== false : component.status === "running";
    const cancelled = component.status === "cancelled";
    const pathTarget = ["read", "edit", "write", "ls"].includes(name);
    const scope = ["grep", "find"].includes(name) && args?.path ? ` in ${pathLabel(String(args.path), component.cwd)}` : "";
    const argument = (pathTarget ? pathLabel(target, component.cwd) : clean(target)) + scope;
    const bullet = theme.fg(failed ? "diffRemoved" : cancelled || running ? "dim" : "diffAdded", cancelled ? "○" : "●");
    const title = theme.fg("text", theme.bold(actions[name] ?? clean(name))) + (argument ? theme.fg("muted", `(${argument})`) : "");
    const lines: string[] = presentation.gap ? [""] : [];
    groupRow = -1;
    if (leader) {
      groupRow = lines.length;
      const caption = researchSummary(group!);
      lines.push(pad + truncateToWidth(`${bullet} ${theme.fg("text", theme.bold("Explored"))}${theme.fg("muted", caption.slice("Explored".length))}`, inner));
      if (!groupExpanded) return lines;
    }
    toolRow = lines.length;
    const prefix = group ? theme.fg("dim", leader ? "  ⎿ " : "    ") : `${bullet} `;
    lines.push(pad + truncateToWidth(prefix + title, inner));
    nativeHeaderRows = lines.length;
    const resultPrefix = group ? "      ⎿ " : "  ⎿ ";
    nativeInset = Math.min(visibleWidth(resultPrefix), inner - 1);
    const firstPrefix = nativeInset === visibleWidth(resultPrefix) ? resultPrefix : " ".repeat(nativeInset);
    const continuation = " ".repeat(nativeInset);
    const resultLine = (text: string, role = "muted") => pad + theme.fg("dim", firstPrefix)
      + theme.fg(role, truncateToWidth(text, Math.max(1, inner - nativeInset)));
    if (component.expanded) {
      // Keep native syntax, diffs, images, limits and mouse regions. Only remove
      // card backgrounds and blank edge padding; details sit below a quiet header.
      const details = render.call(component, Math.max(1, inner - nativeInset));
      nativeHeight = details.length;
      const blank = (line: string) => line.replace(nativeStyle, "").trim() === "";
      nativeTop = 0;
      while (nativeTop < details.length && blank(details[nativeTop])) nativeTop++;
      // The summary already contains a one-line call heading. Keep multiline
      // arguments and distinct native headings, but avoid printing an exact duplicate.
      const heading = stripTerminalSequences(details[nativeTop] ?? "").trim();
      if ([name, `${name} ${target}`, `${actions[name]} ${target}`, `${name[0]?.toUpperCase()}${name.slice(1)} ${target}`, command === undefined ? "" : `$ ${command}`].includes(heading)) {
        nativeTop++;
        while (nativeTop < details.length && blank(details[nativeTop])) nativeTop++;
      }
      let end = details.length;
      while (end > nativeTop && blank(details[end - 1])) end--;
      lines.push(...details.slice(nativeTop, end).map((line, index) => pad + theme.fg("dim", index === 0 ? firstPrefix : continuation) + line.replace(backgrounds, "")));
    } else if (failed) {
      const reason = component.result?.content?.find((part) => part.type === "text" && part.text)?.text;
      const reasonText = reason ? clean(reason) : preview(component);
      const code = component.exitCode === undefined ? "" : ` (exit ${component.exitCode})`;
      lines.push(resultLine(`Error${code}${reasonText ? `: ${reasonText}` : ""}`, "diffRemoved"));
    } else if (cancelled) {
      lines.push(resultLine("Cancelled"));
    } else if (name === "bash") {
      const text = preview(component); if (text) lines.push(resultLine(text));
    } else if (name === "edit" && !running) {
      const text = editSummary(component); if (text) lines.push(resultLine(text));
    }
    return lines;
  };
  component.handleMouse = function (event: TuiMouseEvent) {
    const group = currentGroup(), leader = group?.members[0] === component;
    if (group && !leader && !group.expanded && !component.expanded) return undefined;
    if (leader && event.y === groupRow && event.type === "click" && event.button === "left") {
      group!.open = !group!.expanded;
      if (!group!.open) for (const member of group!.members) member.setExpanded(false);
      group!.expanded = group!.open;
      repaint();
      return { handled: true };
    }
    if (event.y === toolRow && event.type === "click" && event.button === "left") {
      component.setExpanded(!component.expanded); repaint(); return { handled: true };
    }
    if (!component.expanded || event.y < nativeHeaderRows) return undefined;
    const inset = Math.min(2, Math.floor(Math.max(0, event.width - 1) / 2));
    return mouse?.call(component, { ...event, x: event.x - inset - nativeInset, y: event.y - nativeHeaderRows + nativeTop,
      width: Math.max(1, event.width - inset - nativeInset), height: nativeHeight });
  };
  const styledRender = component.render, styledMouse = component.handleMouse;
  return () => {
    if (component.render === styledRender) component.render = render;
    if (component.handleMouse === styledMouse) component.handleMouse = mouse;
  };
}
