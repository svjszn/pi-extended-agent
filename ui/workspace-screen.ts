import { createCommandPanel } from "./command-panel.js";
import type { PanelOptions } from "./command-panel.js";
import { Editor } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

export interface WorkspacePage { label: string; lines(): string[] }
interface Options extends Omit<PanelOptions<boolean>, "load" | "renderBody" | "onInput" | "renderInput"> {
  pages: WorkspacePage[];
  initial?: number;
  hint: string;
  actions?: Record<string, string>;
  onAction(action: string, page: number): void;
}
/** A small shared viewer: Tab changes pages, arrows scroll, actions return to the command. */
export function createWorkspaceScreen(options: Options) {
  let page = Math.min(options.initial ?? 0, Math.max(0, options.pages.length - 1));
  return createCommandPanel({ ...options, load: () => true,
    renderBody: (_data, width, theme) => [
      options.pages.length > 6 ? theme.bold(options.measure.truncateToWidth(`${options.pages[page].label} (${page + 1}/${options.pages.length})`, width))
        : options.pages.map((item, i) => i === page ? theme.bold(item.label) : theme.fg("muted", item.label)).join("   "), "",
      ...(options.pages[page]?.lines() ?? ["Nothing here yet."]),
    ],
    renderInput: (width) => options.measure.truncateToWidth(options.theme.fg("muted", options.hint), width),
    onInput: (input, controls) => {
      if (options.measure.matchesKey(input, "tab") || options.measure.matchesKey(input, "shift+tab")) {
        const direction = options.measure.matchesKey(input, "shift+tab") ? -1 : 1;
        page = (page + direction + options.pages.length) % options.pages.length;
        controls.resetScroll(); options.tui.requestRender(); return true;
      }
      const action = options.actions?.[input];
      if (action) { options.onAction(action, page); controls.close(); return true; }
      return false;
    },
  });
}

export function createWorkspaceEditor(options: Omit<PanelOptions<boolean>, "load" | "renderBody" | "onInput" | "renderInput"> & {
  text: string; onSave(text: string): void;
}) {
  const gray = (text: string) => options.theme.fg("muted", text);
  const editor = new Editor(options.tui as TUI, { borderColor: gray, selectList: {
    selectedPrefix: gray, selectedText: gray, description: gray, scrollInfo: gray, noMatch: gray,
  } });
  editor.setText(options.text); editor.focused = true; editor.disableSubmit = true;
  return createCommandPanel({ ...options, load: () => true,
    renderBody: (_data, width) => {
      const height = options.tui.terminal.rows;
      const header = height >= 18 && options.renderHeader ? options.renderHeader(width).length + 2 : 0;
      const space = Math.max(0, height - header - (height >= 8 ? 2 : 0) - (height >= 6 ? 4 : Math.min(2, height)));
      const lines = editor.render(width);
      const cursor = lines.findIndex((line) => line.includes(options.measure.CURSOR_MARKER ?? "\u001b_pi:c\u0007"));
      const start = Math.max(0, cursor - space + 1);
      return lines.slice(start, start + space);
    },
    renderInput: (width) => options.measure.truncateToWidth(gray("ctrl+s save · esc cancel"), width),
    onInput: (input, controls) => {
      if (options.measure.matchesKey(input, "escape") || options.measure.matchesKey(input, "ctrl+c")) { controls.close(); return true; }
      if (options.measure.matchesKey(input, "ctrl+s")) { options.onSave(editor.getExpandedText()); controls.close(true); return true; }
      // A document editor uses Enter for a newline; Pi's chat editor uses Shift+Enter.
      editor.handleInput(options.measure.matchesKey(input, "enter") ? "\x1b\r" : input);
      options.tui.requestRender(); return true;
    },
  });
}
