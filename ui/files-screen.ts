import { relative } from "node:path";
import { renderFakeCursor } from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";
import { createCommandPanel } from "./command-panel.js";
import type { PanelOptions } from "./command-panel.js";
import { ProjectEditor, TextBuffer, displayPath } from "../lib/project-editor.js";
import type { FileDocument, FileNode } from "../lib/project-editor.js";
import { readFileDiff, readGitChanges } from "../lib/git-diff.js";
import type { GitChanges } from "../lib/git-diff.js";

type Frame = Pick<PanelOptions<boolean>, "tui" | "theme" | "measure" | "done" | "renderHeader" | "renderFooter" | "onDispose">;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const message = (error: unknown) => displayPath(error instanceof Error ? error.message : "The operation failed.");
function bodyRows(frame: Frame, width: number) {
  const height = Math.max(1, frame.tui.terminal.rows);
  const header = height >= 18 && frame.renderHeader ? frame.renderHeader(width).length + 2 : 0;
  return Math.max(0, height - header - (height >= 8 ? 2 : 0) - (height >= 6 ? 4 : Math.min(2, height)));
}
function columns(left: string[], right: string[], width: number, frame: Frame) {
  const split = Math.min(32, Math.floor(width * .32)), clip = frame.measure.truncateToWidth;
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
    const text = clip(left[index] ?? "", split, "");
    return text + " ".repeat(Math.max(0, split - frame.measure.visibleWidth(text))) + frame.theme.fg("dim", " │ ") + clip(right[index] ?? "", Math.max(1, width - split - 3), "");
  });
}
/** Horizontal slicing by terminal cells, without splitting a Unicode code point. */
function sliceCells(text: string, offset: number, width: number, frame: Frame) {
  let col = 0, result = "";
  for (const char of text) {
    const size = frame.measure.visibleWidth(char);
    if (col >= offset && col + size <= offset + width) result += char;
    else if (col < offset && col + size > offset) result += " ".repeat(col + size - offset);
    col += size; if (col >= offset + width) break;
  }
  return result;
}

export function createNanoScreen(options: Frame & { project: ProjectEditor; initial?: string }) {
  const { project, measure, theme, tui } = options;
  let nodes: (FileNode & { depth: number })[] = [], selected = 0, treeOffset = 0;
  const expanded = new Set<string>();
  let document: FileDocument | undefined, buffer: TextBuffer | undefined, baseline = "", focus: "tree" | "file" = "tree";
  let note = "", top = 0, horizontal = 0, pending: (() => void) | undefined, paste: string | undefined, bodyWidth = 80;
  const dirty = () => buffer !== undefined && buffer.text !== baseline;
  const refresh = () => {
    const selectedPath = nodes[selected]?.path;
    const result: typeof nodes = [];
    const visit = (path: string, depth: number) => {
      if (depth > 40) throw new Error("Tree depth exceeds 40 levels. Open a narrower directory.");
      for (const node of project.list(path)) {
        result.push({ ...node, depth });
        if (result.length > 10_000) throw new Error("The expanded tree exceeds 10,000 entries. Collapse a directory or open a narrower path.");
        if (node.kind === "directory" && expanded.has(node.path)) visit(node.path, depth + 1);
      }
    };
    visit(".", 0); nodes = result;
    selected = Math.max(0, selectedPath ? nodes.findIndex(node => node.path === selectedPath) : selected);
    selected = Math.min(selected, Math.max(0, nodes.length - 1));
  };
  const protect = (action: () => void) => {
    if (dirty()) { pending = action; note = "Unsaved edits: Ctrl+S save and continue · Ctrl+D discard · Esc keep editing"; }
    else action();
  };
  const open = (path: string) => protect(() => {
    const value = project.read(path); document = value; baseline = value.text; buffer = new TextBuffer(value.text);
    top = horizontal = 0; focus = "file"; note = "";
  });
  const activate = () => {
    const node = nodes[selected]; if (!node) return;
    if (node.kind === "directory") {
      const wasExpanded = expanded.has(node.path);
      if (wasExpanded) expanded.delete(node.path); else expanded.add(node.path);
      try { refresh(); } catch (error) { if (wasExpanded) expanded.add(node.path); else expanded.delete(node.path); throw error; }
    } else if (node.kind === "file") open(node.path);
    else note = "Links and special files are shown but cannot be opened.";
  };
  const save = () => {
    if (!document || !buffer) return;
    if (dirty()) { document = project.save(document, buffer.text); baseline = buffer.text; note = `Saved ${displayPath(document.path)}`; }
    else note = "No unsaved edits";
    const action = pending; pending = undefined; action?.();
  };
  const panel = createCommandPanel({ ...options, title: "Nano", load: signal => {
    signal.throwIfAborted();
    refresh();
    if (options.initial) {
      const path = project.path(options.initial), name = relative(project.root, path);
      // The extension roots directory arguments before constructing the screen.
      if (name) {
        const parts = name.split(/[\\/]/); parts.pop();
        let parent = "";
        for (const part of parts) { parent = parent ? `${parent}/${part}` : part; expanded.add(relative(project.root, project.path(parent))); }
        refresh(); selected = Math.max(0, nodes.findIndex(node => node.path === name)); open(name);
      }
    }
    return true;
  },
  renderBody: (_data, width) => {
    bodyWidth = width;
    const outerWidth = width + Math.min(2, Math.floor(Math.max(0, width + 3) / 2)) * 2;
    const rows = bodyRows(options, outerWidth), wide = width >= 70;
    const leftWidth = wide ? Math.min(32, Math.floor(width * .32)) : width;
    const rightWidth = wide ? Math.max(1, width - leftWidth - 3) : width;
    treeOffset = Math.max(0, Math.min(treeOffset, selected));
    if (selected >= treeOffset + Math.max(1, rows - 1)) treeOffset = selected - Math.max(1, rows - 1) + 1;
    const left = [theme.bold(`${focus === "tree" ? "› " : ""}${displayPath(project.root)}`),
      ...nodes.slice(treeOffset, treeOffset + Math.max(0, rows - 1)).map((node, index) => {
        const prefix = node.kind === "directory" ? expanded.has(node.path) ? "▾ " : "▸ " : node.kind === "link" ? "↗ " : "  ";
        const text = "  ".repeat(node.depth) + prefix + displayPath(node.name);
        return index + treeOffset === selected ? theme.bold(`› ${text}`) : theme.fg(node.kind === "directory" ? "primary" : "muted", `  ${text}`);
      })];
    if (nodes.length === 0) left.push(theme.fg("muted", "Empty directory"));
    const position = buffer?.position;
    const heading = document ? `${dirty() ? "* " : ""}${displayPath(document.path)} · ${position!.line + 1}:${position!.col + 1}` : "Select a file and press Enter";
    const right = [theme.bold(heading)];
    if (buffer && position) {
      const lines = buffer.text.split("\n"), space = Math.max(0, rows - 1), gutter = String(lines.length).length + 2;
      const codeWidth = Math.max(1, rightWidth - gutter);
      top = Math.min(top, position.line); if (position.line >= top + Math.max(1, space)) top = position.line - Math.max(1, space) + 1;
      const cursorCol = measure.visibleWidth(lines[position.line].slice(0, position.col).replace(/\t/g, "    "));
      const cursorGlyph = graphemes.segment(lines[position.line].slice(position.col).replace(/\t/g, "    "))[Symbol.iterator]().next().value?.segment ?? " ";
      const cursorWidth = Math.min(codeWidth, Math.max(1, measure.visibleWidth(cursorGlyph)));
      if (cursorCol < horizontal) horizontal = cursorCol;
      if (cursorCol + cursorWidth > horizontal + codeWidth) horizontal = cursorCol + cursorWidth - codeWidth;
      for (let line = top; line < Math.min(lines.length, top + space); line++) {
        const text = lines[line].replace(/\t/g, "    "), segment = sliceCells(text, horizontal, codeWidth, options);
        let content = segment;
        if (focus === "file" && line === position.line) {
          const prefix = sliceCells(text, horizontal, Math.max(0, cursorCol - horizontal), options);
          const after = segment.slice(prefix.length);
          const glyph = graphemes.segment(after)[Symbol.iterator]().next().value?.segment ?? " ";
          const cursor = renderFakeCursor(measure.visibleWidth(glyph) > 0 ? glyph : ` ${glyph}`);
          content = prefix + (panel.focused ? measure.CURSOR_MARKER ?? "" : "") + cursor + after.slice(glyph.length);
        }
        right.push(theme.fg("dim", `${String(line + 1).padStart(gutter - 2)}  `) + content);
      }
    }
    if (wide) return columns(left.slice(0, rows), right.slice(0, rows), width, options);
    return (focus === "tree" ? left : right).slice(0, rows).map(line => measure.truncateToWidth(line, width, ""));
  },
  renderInput: width => measure.truncateToWidth(theme.fg(note || pending ? "primary" : "muted", note || (focus === "tree"
    ? "↑↓ navigate · Enter open · ←→ fold · Tab editor · Ctrl+R refresh · Esc close"
    : "Ctrl+S save · Ctrl+Z undo · Ctrl+Y redo · Shift+Tab tree · Esc back")), width),
  onBodyMouse: (_event, position) => {
    if (pending || position.line < 1) return true;
    const wide = bodyWidth >= 70, split = Math.min(32, Math.floor(bodyWidth * .32));
    if (wide ? position.column >= split + 3 : focus === "file") {
      if (!buffer) return true;
      focus = "file";
      const lines = buffer.text.split("\n"), line = Math.min(lines.length - 1, top + position.line - 1);
      const gutter = String(lines.length).length + 2;
      const column = Math.max(0, position.column - (wide ? split + 3 : 0) - gutter + horizontal);
      let cell = 0, index = 0;
      for (const char of lines[line]) {
        const width = char === "\t" ? 4 : measure.visibleWidth(char);
        if (cell + width > column) break;
        cell += width; index += char.length;
      }
      buffer.cursor = lines.slice(0, line).reduce((size, value) => size + value.length + 1, 0) + index;
      tui.requestRender(); return true;
    }
    focus = "tree";
    selected = Math.min(nodes.length - 1, treeOffset + position.line - 1);
    try { activate(); } catch (error) { note = message(error); } tui.requestRender(); return true;
  },
  onInput: (input, controls) => {
    const key = (value: KeyId) => measure.matchesKey(input, value);
    try {
      if (paste !== undefined || input.includes("\x1b[200~")) {
        const incoming = paste === undefined ? input.slice(input.indexOf("\x1b[200~") + 6) : input;
        paste = (paste ?? "") + incoming;
        if (paste.length > 2 * 1024 * 1024) { paste = undefined; throw new Error("Paste exceeds the editor limit."); }
        const end = paste.indexOf("\x1b[201~");
        if (end >= 0) { const text = paste.slice(0, end); paste = undefined; if (focus === "file" && !pending) buffer?.insert(text); }
      } else if (pending) {
        if (key("escape") || key("ctrl+c")) { pending = undefined; note = ""; }
        else if (key("ctrl+d")) { const action = pending; pending = undefined; if (buffer) buffer = new TextBuffer(baseline); note = ""; action(); }
        else if (key("ctrl+s")) save();
      } else if (key("ctrl+s")) save();
      else if (key("ctrl+c")) protect(() => controls.close());
      else if (key("escape")) {
        if (focus === "file") { focus = "tree"; note = ""; }
        else protect(() => controls.close());
      } else if (key("tab") && focus === "tree") { if (buffer) focus = "file"; }
      else if (key("shift+tab")) focus = focus === "tree" && buffer ? "file" : "tree";
      else if (focus === "tree") {
        note = "";
        if (key("up")) selected = Math.max(0, selected - 1);
        else if (key("down")) selected = Math.min(nodes.length - 1, selected + 1);
        else if (key("home")) selected = 0;
        else if (key("end")) selected = Math.max(0, nodes.length - 1);
        else if (key("pageUp")) selected = Math.max(0, selected - Math.max(1, controls.pageSize - 1));
        else if (key("pageDown")) selected = Math.min(nodes.length - 1, selected + Math.max(1, controls.pageSize - 1));
        else if (key("ctrl+r")) refresh();
        else if (key("enter") || key("right") && nodes[selected]?.kind === "directory" && !expanded.has(nodes[selected].path)) activate();
        else if (key("left")) {
          const node = nodes[selected];
          if (node?.kind === "directory" && expanded.has(node.path)) activate();
          else if (node) { for (let i = selected - 1; i >= 0; i--) if (nodes[i].depth < node.depth) { selected = i; break; } }
        }
      } else if (buffer) {
        note = "";
        const direction = (["left", "right", "up", "down", "home", "end"] as const).find(value => key(value));
        if (direction) buffer.move(direction);
        else if (key("pageUp") || key("pageDown")) for (let i = 0; i < Math.max(1, controls.pageSize - 1); i++) buffer.move(key("pageUp") ? "up" : "down");
        else if (key("ctrl+z")) buffer.history(true);
        else if (key("ctrl+y")) buffer.history(false);
        else if (key("backspace")) buffer.erase(true);
        else if (key("delete")) buffer.erase(false);
        else if (key("enter")) buffer.insert("\n");
        else if (key("tab")) buffer.insert("\t");
        else if (input && !/[\x00-\x1f\x7f-\x9f]/.test(input)) buffer.insert(input);
      }
    } catch (error) { note = message(error); }
    controls.resetScroll(); tui.requestRender(); return true;
  } });
  const mouse = panel.handleMouse.bind(panel);
  panel.handleMouse = event => {
    if (event.type !== "wheel") return mouse(event);
    const input = (event.wheelDelta ?? 0) < 0 ? "\x1b[A" : "\x1b[B";
    for (let step = 0; step < Math.min(10, Math.max(1, Math.abs(event.wheelDelta || 0))); step++) panel.handleInput(input);
    return { handled: true };
  };
  return panel;
}

export function createDiffScreen(options: Frame & { cwd: string; staged?: boolean; filter?: string }) {
  const { tui, theme, measure } = options;
  let changes: GitChanges | undefined, selected = 0, lines: string[] = [], offset = 0, fileOffset = 0;
  let staged = options.staged ?? false, focus = false, note = "", closed = false, generation = 0, horizontal = 0, bodyWidth = 80;
  let request: AbortController | undefined;
  const load = async (refresh: boolean) => {
    if (closed) return;
    if (!refresh && !changes) return;
    request?.abort(); request = new AbortController(); const signal = request.signal, run = ++generation;
    note = "Loading…"; lines = [];
    if (refresh) changes = undefined;
    try {
      const next = refresh ? await readGitChanges(options.cwd, staged, options.filter, signal) : changes;
      if (!next || closed || run !== generation) return;
      const index = Math.min(selected, Math.max(0, next.files.length - 1));
      const body = next.files[index] ? await readFileDiff(next, next.files[index], signal) : ["No changes in this view."];
      if (closed || run !== generation) return;
      changes = next; selected = index; lines = body; offset = 0; horizontal = 0; note = "";
    } catch (error) { if (!closed && run === generation) note = message(error); }
    if (!closed) tui.requestRender();
  };
  const panel = createCommandPanel({ ...options, title: "Diff", load: async () => { await load(true); return true; },
    onDispose: () => { closed = true; request?.abort(); options.onDispose?.(); },
    renderBody: (_data, width) => {
      bodyWidth = width;
      const rows = bodyRows(options, width + 4), wide = width >= 70;
      const left = [theme.bold(staged ? "1 Working tree · [2 Staged]" : "[1 Working tree] · 2 Staged")];
      fileOffset = Math.max(0, Math.min(fileOffset, selected));
      if (selected >= fileOffset + Math.max(1, rows - 1)) fileOffset = selected - Math.max(1, rows - 1) + 1;
      left.push(...(changes?.files ?? []).slice(fileOffset, fileOffset + Math.max(0, rows - 1)).map((file, index) => {
        const text = `${file.status} ${displayPath(file.path)}`;
        return index + fileOffset === selected ? theme.bold(`› ${text}`) : theme.fg("muted", `  ${text}`);
      }));
      if (!changes?.files.length) left.push("No changes in this view.");
      const right = [theme.bold(displayPath(changes?.files[selected]?.path ?? "Diff")), ...lines.slice(offset, offset + Math.max(0, rows - 1)).map(line => {
        const safe = line.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, char => displayPath(char)).replace(/\t/g, "    ");
        const available = wide ? width - Math.min(32, Math.floor(width * .32)) - 3 : width;
        return theme.fg(line.startsWith("+") ? "diffAdded" : line.startsWith("-") ? "diffRemoved" : line.startsWith("@@") ? "muted" : "text", sliceCells(safe, horizontal, Math.max(1, available), options));
      })];
      return wide ? columns(left.slice(0, rows), right.slice(0, rows), width, options) : (focus ? right : left).slice(0, rows).map(line => measure.truncateToWidth(line, width, ""));
    },
    renderInput: width => measure.truncateToWidth(theme.fg("muted", note || "1 working · 2 staged · Tab pane · ↑↓ move · PgUp/PgDn scroll · Ctrl+R refresh · Esc back"), width),
    onBodyMouse: (_event, position) => {
      if (position.line < 1 || !changes) return true;
      const split = Math.min(32, Math.floor(bodyWidth * .32));
      if (bodyWidth >= 70 ? position.column >= split + 3 : focus) focus = true;
      else { focus = false; selected = Math.min(changes.files.length - 1, fileOffset + position.line - 1); void load(false); }
      tui.requestRender(); return true;
    },
    onInput: (input, controls) => {
      const key = (value: KeyId) => measure.matchesKey(input, value);
      if (key("escape") && focus) focus = false;
      else if (key("escape") || key("ctrl+c")) { controls.close(); return true; }
      else if (input === "1" || input === "2") { staged = input === "2"; selected = 0; void load(true); }
      else if (key("ctrl+r")) void load(true);
      else if (key("left") || key("right")) horizontal = Math.max(0, horizontal + (key("left") ? -8 : 8));
      else if (key("tab") || key("shift+tab") || key("enter")) focus = !focus;
      else if (key("up") || key("down")) {
        const delta = key("up") ? -1 : 1;
        if (focus) offset = Math.max(0, Math.min(Math.max(0, lines.length - 1), offset + delta));
        else if (changes) { selected = Math.max(0, Math.min(Math.max(0, changes.files.length - 1), selected + delta)); void load(false); }
      } else if (key("pageUp") || key("pageDown")) offset = Math.max(0, Math.min(Math.max(0, lines.length - 1), offset + (key("pageUp") ? -1 : 1) * Math.max(1, controls.pageSize - 1)));
      else if (key("home")) offset = 0;
      else if (key("end")) offset = Math.max(0, lines.length - Math.max(1, controls.pageSize - 1));
      controls.resetScroll(); tui.requestRender(); return true;
    },
  });
  const mouse = panel.handleMouse.bind(panel);
  panel.handleMouse = event => {
    if (event.type !== "wheel") return mouse(event);
    offset = Math.max(0, Math.min(Math.max(0, lines.length - 1), offset + (event.wheelDelta || 0)));
    if (!closed) tui.requestRender();
    return { handled: true };
  };
  return panel;
}
