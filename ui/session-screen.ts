import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { createCommandPanel } from "./command-panel.js";
import type { PanelOptions } from "./command-panel.js";
import { cleanText } from "../lib/project-state.js";

interface SearchInput { focused: boolean; render(width: number): string[]; getValue(): string }
interface SessionList {
  filteredSessions: { session: SessionInfo; depth: number }[];
  selectedIndex: number;
  focused: boolean;
  maxVisible: number;
  searchInput: SearchInput;
  confirmingDeletePath: string | null;
  showPath: boolean;
  setSortMode(mode: string): void;
  onSelect?: (path: string) => void;
  onCancel?: () => void;
  onExit: () => void;
}
export interface NativeSessionSelector {
  focused: boolean;
  scope: string;
  sortMode: string;
  nameFilter: string;
  mode: string;
  renameInput: SearchInput;
  header: { loading: boolean; statusMessage: { message: string } | null; setStatusMessage(value: null): void };
  getSessionList(): SessionList;
  handleInput(data: string): void;
}
type Options = Pick<PanelOptions<boolean>, "tui" | "theme" | "measure" | "done" | "renderHeader" | "renderFooter" | "onDispose">;
const plain = (value: string) => cleanText(value).replace(/\s+/g, " ");

/** Keep Pi's search, scope switching and resume callbacks; replace its framing only. */
export function createSessionScreen({ selector, ...options }: Options & { selector: NativeSessionSelector }) {
  const list = selector.getSessionList();
  if (!Array.isArray(list.filteredSessions) || typeof list.searchInput?.getValue !== "function"
    || typeof list.setSortMode !== "function" || !selector.header || !selector.renameInput) {
    throw new Error("Pi session selection is incompatible with this interface.");
  }
  selector.sortMode = "recent";
  list.setSortMode("recent");
  const { theme, measure, tui } = options;
  const date = new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  return createCommandPanel({ ...options, title: "Resume chat", load: () => true,
    renderBody: (_data, width) => {
      const lines: string[] = [];
      const clip = (text: string) => measure.truncateToWidth(text, width);
      if (tui.terminal.rows >= 12) {
        const scope = selector.scope === "all" ? "All projects" : "Current project";
        lines.push(theme.fg("muted", clip(`${scope} · ${list.filteredSessions.length} chats · ${selector.sortMode}${selector.nameFilter === "named" ? " · named only" : ""}`)), "");
      }
      const status = selector.header.statusMessage?.message;
      if (status) lines.push(theme.fg("warning", clip(plain(status))));
      if (list.confirmingDeletePath) lines.push(theme.fg("warning", clip("Delete selected chat? Enter to confirm · Esc to cancel")));
      else if (selector.mode === "rename") lines.push(theme.fg("muted", clip("Rename chat · Enter to save · Esc to cancel")));
      if (selector.header.loading) lines.push(theme.fg("dim", "Loading chats…"));
      if (!list.filteredSessions.length && !selector.header.loading) {
        lines.push(theme.fg("muted", clip(list.searchInput.getValue() ? "No matching chats. Try another search."
          : selector.scope === "current" ? "No chats in this project. Press Tab to view all projects." : "No saved chats.")));
      }
      list.maxVisible = Math.max(1, Math.floor((tui.terminal.rows - (tui.terminal.rows >= 18 ? 14 : 8) - (status ? 1 : 0)) / 3));
      const start = Math.max(0, Math.min(list.selectedIndex - Math.floor(list.maxVisible / 2), list.filteredSessions.length - list.maxVisible));
      for (let index = start; index < Math.min(start + list.maxVisible, list.filteredSessions.length); index++) {
        const { session, depth } = list.filteredSessions[index];
        const selected = index === list.selectedIndex;
        const title = plain(session.name || session.firstMessage || "Untitled chat");
        const prefix = selector.sortMode === "threaded" ? "  ".repeat(Math.min(depth, 4)) : "";
        const text = clip(`${selected ? "›" : " "} ${prefix}${title}`);
        lines.push(selected ? theme.fg("primary", theme.bold(text)) : theme.fg("muted", text));
        const modified = Number.isFinite(session.modified.getTime()) ? date.format(session.modified) : "Unknown date";
        lines.push(theme.fg("dim", clip(`  ${modified} · ${session.messageCount} messages${selector.scope === "all" && session.cwd ? ` · ${plain(session.cwd)}` : ""}${list.showPath ? ` · ${plain(session.path)}` : ""}`)), "");
      }
      return lines;
    },
    renderInput(width, focused) {
      selector.focused = focused;
      const input = selector.mode === "rename" ? selector.renameInput : list.searchInput;
      const value = input.render(width)[0] ?? "";
      return value || theme.fg("muted", "Search chats…");
    },
    renderFooter: options.renderFooter ?? ((width) => [theme.fg("dim", measure.truncateToWidth("  Type to search · ↑↓ choose · Enter resume · Tab projects · Esc cancel", width))]),
    onInput(data) { selector.handleInput(data); tui.requestRender(); return true; },
  });
}
