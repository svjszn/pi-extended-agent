import { createCommandPanel } from "./command-panel.js";
import { skillText } from "../lib/skills.js";
import type { CatalogSkill, InstalledSkill, SkillItem, SkillPreview, InstalledPreview, SkillScope, SkillInstallResult } from "../lib/skills.js";
import type { Measure, Palette, PanelTui } from "./types.js";
import type { PanelControls } from "./command-panel.js";
import type { Input as InputComponent, KeyId } from "@earendil-works/pi-tui";
import { errorMessage } from "../lib/errors.js";

type SkillDetail = (SkillPreview & { installed: false }) | InstalledPreview;
interface SkillsState {
  tab: "installed" | "search";
  phase: "list" | "loading" | "detail" | "installing" | "success";
  installed: InstalledSkill[]; results: CatalogSkill[]; selected: number;
  searching: boolean; activeQuery: string; searched: string; notice: string;
  detail: SkillDetail | null; scope: SkillScope; result?: SkillInstallResult;
}
interface SkillsOptions {
  tui: PanelTui; theme: Palette;
  measure: Measure & { stripTerminalSequences(text: string): string };
  Input: typeof InputComponent;
  done(result?: boolean): void;
  renderHeader?(width: number): string[];
  renderFooter?(width: number): string[] | undefined;
  initialQuery?: string; projectTrusted: boolean; projectPath: string; globalPath: string;
  services: {
    installed(): InstalledSkill[];
    search(query: string, signal: AbortSignal): Promise<CatalogSkill[]>;
    preview(item: CatalogSkill, signal: AbortSignal): Promise<SkillPreview>;
    previewInstalled(item: InstalledSkill, signal: AbortSignal): Promise<InstalledPreview>;
    install(item: SkillPreview, scope: SkillScope, signal: AbortSignal): Promise<SkillInstallResult>;
  };
}

const compact = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export function createSkillsScreen({ tui, theme, measure, Input, done, renderHeader, renderFooter, services, initialQuery = "", projectTrusted, projectPath, globalPath }: SkillsOptions) {
  const state: SkillsState = { tab: initialQuery ? "search" : "installed", phase: "list", installed: [], results: [], selected: 0,
    searching: false, activeQuery: "", searched: "", notice: "", detail: null, scope: projectTrusted ? "project" : "global" };
  const inputs = {
    installed: new Input({ prompt: "", placeholder: "Filter installed skills…", placeholderStyle: (value) => theme.fg("dim", value) }),
    search: new Input({ prompt: "", placeholder: "Search skills…", placeholderStyle: (value) => theme.fg("dim", value) }),
  };
  inputs.search.setValue(initialQuery);
  let lifetime: AbortSignal, timer: ReturnType<typeof setTimeout> | undefined;
  let searchRequest: AbortController | undefined, previewRequest: AbortController | undefined, installRequest: AbortController | undefined;
  let controls: PanelControls | undefined, closeAfterCancel = false, pending = Promise.resolve(), disposed = false;
  const repaint = () => { if (!disposed) tui.requestRender(); };
  const linked = (controller: AbortController) => AbortSignal.any([lifetime, controller.signal]);
  const existing = (item: { name: string; skillId?: string }) => state.installed.find((entry) => entry.name === (item.skillId || item.name));
  const items = (): SkillItem[] => {
    if (state.tab === "search") return state.results;
    const query = inputs.installed.getValue().trim().toLowerCase();
    return state.installed.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query));
  };
  const move = (delta: number) => {
    state.selected = Math.max(0, Math.min(items().length - 1, state.selected + delta));
    controls?.reveal(4 + state.selected * 3);
    repaint();
  };

  async function search() {
    clearTimeout(timer);
    searchRequest?.abort();
    const query = inputs.search.getValue().trim();
    if (query.length < 2) { state.results = []; state.searching = false; state.searched = ""; repaint(); return; }
    const request = searchRequest = new AbortController();
    state.searching = true;
    state.activeQuery = query;
    state.notice = "";
    repaint();
    try {
      const results = await services.search(query, linked(request));
      if (disposed || request.signal.aborted) return;
      state.results = results;
      state.searched = query;
      state.selected = 0;
      controls?.resetScroll();
    } catch (error) {
      if (!disposed && !request.signal.aborted) { state.results = []; state.notice = skillText(errorMessage(error)); }
    } finally {
      if (!disposed && !request.signal.aborted) { state.searching = false; repaint(); }
    }
  }

  async function preview() {
    const item = items()[state.selected];
    if (!item) return;
    const request = previewRequest = new AbortController();
    state.phase = "loading";
    state.notice = "";
    controls?.resetScroll();
    repaint();
    try {
      const detail: SkillDetail = item.installed ? await services.previewInstalled(item, linked(request))
        : { ...await services.preview(item, linked(request)), installed: false };
      if (disposed || request.signal.aborted) return;
      state.detail = existing(detail) ? { ...detail, installed: true } : detail;
      state.phase = "detail";
      state.scope = projectTrusted ? "project" : "global";
    } catch (error) {
      if (!disposed && !request.signal.aborted) { state.notice = skillText(errorMessage(error)); state.phase = "list"; controls?.reveal(4 + state.selected * 3); }
    }
    repaint();
  }

  async function install() {
    const detail = state.detail;
    if (!detail || detail.installed) return;
    if (state.scope === "project" && !projectTrusted) {
      state.notice = "Select All projects, or reopen Pi and approve this project before installing here.";
      repaint();
      return;
    }
    const request = installRequest = new AbortController();
    state.phase = "installing";
    state.notice = "";
    controls?.resetScroll();
    repaint();
    try {
      const result = await services.install(detail, state.scope, linked(request));
      if (disposed) return;
      state.result = result;
      state.phase = "success";
    } catch (error) {
      if (!disposed) {
        state.notice = request.signal.aborted ? "Installation cancelled." : skillText(errorMessage(error));
        state.phase = "detail";
        if (closeAfterCancel) { controls?.close(false); return; }
      }
    }
    repaint();
  }

  const label = (value: unknown) => theme.fg("primary", theme.bold(skillText(value)));
  const muted = (value: unknown) => theme.fg("muted", skillText(value));
  const rows = (_data: SkillsState, width: number): string[] => {
    if (state.phase === "loading") return [muted("Loading skill preview…")];
    if (state.phase === "success" && state.result) return [label(`Installed ${state.result.name}`), "", muted(state.result.path), "",
      "Press Enter to return to the chat and load this skill."];
    if (state.phase === "installing" && state.detail) return [label(state.detail.name), "", muted(state.notice || "Downloading skill files…"), "", muted("Esc cancels the installation.")];
    if (state.phase === "detail" && state.detail) {
      const item = state.detail;
      const description = measure.wrapTextWithAnsi(skillText(item.description), width).slice(0, 2).map(muted);
      const lines = [label(item.name), ...description, "", muted(`Source: ${item.source}`)];
      if (item.installed) lines.push(muted(`Installed${item.scope ? ` · ${item.scope}` : ""}`), muted("Enter or Esc to go back."));
      else {
        lines.push(muted(`${item.files.length} files · revision ${item.commit.slice(0, 8)}`), "",
          ["project", "global"].map((scope) => state.scope === scope ? label(scope === "project" ? "› This project" : "› All projects")
            : muted(scope === "project" ? "This project" : "All projects")).join("    "),
          muted(state.scope === "project" ? projectPath : globalPath), muted("Enter install    Tab change location    Esc back"));
      }
      if (state.notice) lines.push("", muted(state.notice));
      lines.push("", label("SKILL.md"), "");
      // Preview is terminal text only. It is never submitted as a prompt.
      const content = measure.stripTerminalSequences(item.content).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "  ");
      lines.push(...content.split(/\r?\n/));
      return lines;
    }
    const list = items();
    const tabs = ["installed", "search"].map((tab) => state.tab === tab ? label(tab === "installed" ? "Installed" : "Search")
      : muted(tab === "installed" ? "Installed" : "Search")).join("    ");
    const status = state.notice || (state.tab === "search" && state.searching ? "Searching skills.sh…" : state.tab === "installed"
      ? `${list.length} ${list.length === 1 ? "skill" : "skills"} available to this session` : `${list.length} ${list.length === 1 ? "result" : "results"} from skills.sh`);
    const lines = [tabs, "", muted(status), ""];
    if (!list.length) {
      lines.push(muted(state.tab === "installed" ? "No matching installed skills." : inputs.search.getValue().trim().length < 2
        ? "Type a name or task to search. At least 2 characters." : state.searching ? "" : "No matching GitHub skills found."));
    }
    for (const [index, item] of list.entries()) {
      const selected = index === state.selected;
      const installed = item.installed || existing(item);
      const marker = theme.fg(installed ? "primary" : "dim", installed ? "●" : "○");
      const name = skillText(item.name);
      lines.push(measure.truncateToWidth(`${marker} ${selected ? label(name) : theme.fg("text", name)}`, width),
        measure.truncateToWidth(muted(`  ${item.installed ? `${item.scope} · ${item.filePath}` : `${item.source} · ${compact(item.installs)} installs`}`), width),
        measure.truncateToWidth(muted(item.description ? `  ${item.description}` : ""), width));
    }
    return lines;
  };

  const panel = createCommandPanel({ title: "Skills", tui, theme, measure, done, renderHeader,
    renderFooter(width) {
      const lines = renderFooter?.(width) || [];
      if (!lines.length) return lines;
      const last = lines[lines.length - 1];
      const hint = state.phase === "list" ? "↑↓ select   enter preview   tab switch" : "↑↓ scroll   esc back";
      const gap = width - measure.visibleWidth(last) - measure.visibleWidth(hint) - 2;
      return gap >= 3 ? [...lines.slice(0, -1), last + " ".repeat(gap) + theme.fg("dim", hint)] : lines;
    },
    load(signal) {
      lifetime = signal;
      state.installed = services.installed();
      if (initialQuery) pending = search();
      return state;
    },
    renderBody: rows,
    renderInput(width, focused) {
      if (state.phase === "detail" && state.detail && !state.detail.installed) return (focused ? measure.CURSOR_MARKER || "" : "")
        + muted(`enter install · ${state.scope} · tab location · esc back`);
      if (state.phase !== "list") return (focused ? measure.CURSOR_MARKER || "" : "")
        + muted(state.phase === "success" ? "enter to load skill" : state.phase === "installing" ? "esc to cancel" : "esc to go back");
      const input = inputs[state.tab];
      input.focused = focused;
      return theme.fg("primary", input.render(width)[0]);
    },
    onInput(data, actions) {
      controls = actions;
      const key = (name: KeyId) => measure.matchesKey(data, name);
      if (state.phase === "installing") {
        if (key("escape") || key("ctrl+c")) {
          closeAfterCancel = key("ctrl+c"); installRequest?.abort(); state.notice = "Cancelling…"; repaint();
        }
        return true;
      }
      if (key("ctrl+c")) { actions.close(state.phase === "success"); return true; }
      if (key("escape")) {
        if (state.phase === "detail" || state.phase === "loading") {
          previewRequest?.abort(); state.phase = "list"; state.notice = ""; actions.resetScroll(); repaint();
          actions.reveal(4 + state.selected * 3);
        } else actions.close(state.phase === "success");
        return true;
      }
      if (state.phase === "success") { if (key("enter")) actions.close(true); return true; }
      if (state.phase === "loading") return true;
      if (state.phase === "detail" && state.detail) {
        if (key("enter")) {
          if (state.detail.installed) { state.phase = "list"; actions.resetScroll(); actions.reveal(4 + state.selected * 3); repaint(); }
          else pending = install();
          return true;
        }
        if (!state.detail.installed && (key("tab") || key("shift+tab") || key("left") || key("right"))) {
          state.scope = state.scope === "project" ? "global" : "project"; state.notice = ""; repaint(); return true;
        }
        return false;
      }
      if (key("tab") || key("shift+tab")) {
        state.tab = state.tab === "installed" ? "search" : "installed";
        state.selected = 0; state.notice = ""; actions.resetScroll();
        if (state.tab === "installed") { clearTimeout(timer); searchRequest?.abort(); state.searching = false; }
        else if (inputs.search.getValue().trim().length >= 2 && state.searched !== inputs.search.getValue().trim()) pending = search();
        repaint(); return true;
      }
      if (key("up") || key("down")) { move(key("up") ? -1 : 1); return true; }
      if (key("pageUp") || key("pageDown")) { move((key("pageUp") ? -1 : 1) * Math.max(1, Math.floor(actions.pageSize / 3))); return true; }
      if (key("enter")) {
        if (state.tab === "search" && state.searching && state.activeQuery === inputs.search.getValue().trim()) return true;
        if (state.tab === "search" && (state.searching || state.searched !== inputs.search.getValue().trim())) pending = search();
        else pending = preview();
        return true;
      }
      const input = inputs[state.tab], before = input.getValue();
      input.handleInput(data);
      if (input.getValue() !== before) {
        state.selected = 0; state.notice = ""; actions.resetScroll();
        if (state.tab === "search") { clearTimeout(timer); timer = setTimeout(() => { pending = search(); }, 350); }
      }
      repaint();
      return true;
    },
    onDispose() {
      disposed = true;
      clearTimeout(timer); searchRequest?.abort(); previewRequest?.abort(); installRequest?.abort();
    },
  });
  return Object.assign(panel, { whenIdle: () => pending });
}
