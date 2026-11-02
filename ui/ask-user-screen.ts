import { Input, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";
import { createCommandPanel } from "./command-panel.js";
import type { PanelOptions, PanelControls } from "./command-panel.js";
import { collectUserAnswers, MAX_ANSWER_BYTES } from "../lib/ask-user.js";
import type { UserAnswer, UserQuestion } from "../lib/ask-user.js";

type Options = Pick<PanelOptions<boolean>, "tui" | "theme" | "measure" | "done" | "renderHeader" | "onDispose">;
interface Hit { start: number; end: number; kind: "option" | "text" | "edit" | "send"; index: number }

export function createAskUserScreen({ questions, onSubmit, ...options }: Options & {
  questions: UserQuestion[]; onSubmit(answers: UserAnswer[]): void;
}) {
  const { theme, measure, tui } = options;
  const drafts = questions.map(question => ({ selected: new Set<string>(),
    input: new Input({ prompt: "", placeholder: "Type your answer or add details…", placeholderStyle: value => theme.fg("muted", value) }),
    focus: 0,
  }));
  let page = 0, error = "", reveal = false;
  let paste: { page: number; value: string; overflow: boolean } | undefined;
  let hits: Hit[] = [], tabs: { start: number; end: number; page: number }[] = [];
  const written = (index: number) => drafts[index].input.getValue().trim();
  const answered = (index: number) => drafts[index].selected.size > 0 || !!written(index);
  const review = () => page === questions.length;
  const typing = () => !review() && drafts[page].focus === questions[page].options.length;
  const write = (data: string) => {
    const draft = drafts[page], previous = draft.input.getValue();
    draft.focus = questions[page].options.length; reveal = true;
    if (Buffer.byteLength(data, "utf8") > MAX_ANSWER_BYTES + 32) { error = `Keep your answer under ${MAX_ANSWER_BYTES} bytes.`; tui.requestRender(); return; }
    draft.input.handleInput(data);
    const clean = stripTerminalSequences(draft.input.getValue()).replace(/[\r\n\t]/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    if (Buffer.byteLength(clean, "utf8") > MAX_ANSWER_BYTES) { draft.input.setValue(previous); error = `Keep your answer under ${MAX_ANSWER_BYTES} bytes.`; }
    else { if (clean !== draft.input.getValue()) draft.input.setValue(clean); error = ""; }
    tui.requestRender();
  };
  const changePage = (next: number, controls: PanelControls) => {
    page = Math.max(0, Math.min(questions.length, next)); error = ""; reveal = false;
    hits = []; tabs = []; controls.resetScroll(); tui.requestRender();
  };
  const select = (index: number, toggle = true) => {
    const question = questions[page], draft = drafts[page], id = question.options[index].id;
    if (question.multiSelect) { if (draft.selected.has(id)) draft.selected.delete(id); else draft.selected.add(id); }
    else { const clear = toggle && draft.selected.has(id); draft.selected.clear(); if (!clear) draft.selected.add(id); }
    error = ""; reveal = true; tui.requestRender();
  };
  const send = (controls: PanelControls) => {
    const missing = questions.findIndex((_question, index) => !answered(index));
    if (missing >= 0) { changePage(missing, controls); error = "Choose an option or write your answer."; return; }
    try {
      const answers = collectUserAnswers(questions, drafts.map(draft => ({ selected: draft.selected, text: draft.input.getValue() })));
      onSubmit(answers); controls.close(true);
    } catch (reason) { error = reason instanceof Error ? reason.message : "Check your answers."; tui.requestRender(); }
  };
  return createCommandPanel({ ...options, title: "A question for you", load: () => true,
    renderBody: (_data, width, _theme, _measure, { controls }) => {
      const lines: string[] = []; hits = []; tabs = [];
      const add = (value: string) => { lines.push(...measure.wrapTextWithAnsi(value, width)); };
      const hit = (kind: Hit["kind"], index: number, draw: () => void) => {
        const start = lines.length; draw(); hits.push({ start, end: lines.length, kind, index });
      };
      let navigation = "";
      for (let index = 0; index <= questions.length; index++) {
        const label = index === questions.length ? "Review" : width >= 55 ? `${answered(index) ? "✓" : index + 1} ${questions[index].title}` : String(index + 1);
        const gap = width >= 55 ? "   " : " ";
        const start = measure.visibleWidth(navigation);
        navigation += (index === page ? theme.fg("primary", theme.bold(label)) : theme.fg("dim", label)) + gap;
        tabs.push({ start, end: measure.visibleWidth(navigation) - gap.length, page: index });
      }
      lines.push(measure.truncateToWidth(navigation, width, ""), "");
      if (review()) {
        add(theme.fg("primary", theme.bold("Review your answers"))); add("");
        questions.forEach((question, index) => hit("edit", index, () => {
          add(theme.fg("primary", `${index + 1}. ${question.title}`));
          const labels = question.options.filter(option => drafts[index].selected.has(option.id)).map(option => option.label);
          add(theme.fg("text", labels.join(", ") || (written(index) ? "Written answer" : "Not answered")));
          if (written(index)) add(theme.fg("muted", written(index)));
          add("");
        }));
        hit("send", 0, () => add(theme.fg("primary", theme.bold("› Send answers"))));
      } else {
        const question = questions[page], draft = drafts[page];
        for (const line of question.question.split("\n")) add(theme.fg("primary", theme.bold(line)));
        add(question.multiSelect ? theme.fg("dim", "Select all that apply.") : "");
        question.options.forEach((option, index) => hit("option", index, () => {
          const selected = draft.selected.has(option.id), focused = draft.focus === index;
          const marker = question.multiSelect ? selected ? "[✓]" : "[ ]" : selected ? "●" : "○";
          const label = `${focused ? "›" : " "} ${index + 1}. ${marker} ${option.label}${option.recommended ? " (Recommended)" : ""}`;
          add(focused ? theme.fg("primary", theme.bold(label)) : theme.fg("text", label));
          if (option.description) add(theme.fg("muted", `     ${option.description}`));
        }));
        if (question.options.length) add("");
        hit("text", question.options.length, () => {
          add(theme.fg(typing() ? "primary" : "muted", `${typing() ? "›" : " "} Your answer / additional details`));
          if (written(page) && !typing()) add(theme.fg("muted", `  ${written(page)}`));
        });
        if (reveal) {
          controls?.reveal(hits.find(item => item.index === draft.focus && (item.kind === "option" || item.kind === "text"))?.start ?? 0);
          reveal = false;
        }
      }
      return lines;
    },
    renderInput(width, focused) {
      if (review()) return theme.fg("primary", "enter send answers · tab edit · esc cancel");
      if (typing()) { drafts[page].input.focused = focused; return drafts[page].input.render(width)[0] ?? ""; }
      return theme.fg("muted", questions[page].multiSelect ? "↑↓ choose · space select · enter next · type an answer" : "↑↓ choose · enter next · type an answer");
    },
    renderFooter: width => [theme.fg(error ? "warning" : "dim", measure.truncateToWidth(error ? `  ${error}`
      : "  Tab / Shift+Tab questions · click to select · Esc cancel", width, ""))],
    onInput(data, controls) {
      const key = (name: KeyId) => measure.matchesKey(data, name);
      if (key("escape") || key("ctrl+c")) { controls.close(false); return true; }
      // Paste is literal answer text, including digits, tabs and newlines. Bound
      // the buffer before passing a complete paste to Pi's native input.
      const start = data.indexOf("\x1b[200~");
      if (paste || start >= 0) {
        if (review()) return true;
        if (!paste) { paste = { page, value: "", overflow: false }; data = data.slice(start + 6); }
        const end = data.indexOf("\x1b[201~"), chunk = end >= 0 ? data.slice(0, end) : data;
        if (!paste.overflow && Buffer.byteLength(paste.value + chunk, "utf8") <= MAX_ANSWER_BYTES) paste.value += chunk;
        else { paste.overflow = true; paste.value = ""; }
        if (end >= 0) {
          const value = paste; paste = undefined;
          if (value.overflow) { error = `Keep your answer under ${MAX_ANSWER_BYTES} bytes.`; tui.requestRender(); }
          else write(`\x1b[200~${value.value}\x1b[201~`);
        }
        return true;
      }
      if (key("tab") || key("shift+tab")) { changePage((page + (key("tab") ? 1 : questions.length)) % (questions.length + 1), controls); return true; }
      if (review()) {
        if (key("enter")) send(controls);
        else if (key("left") || key("up")) changePage(page - 1, controls);
        return true;
      }
      const draft = drafts[page], question = questions[page];
      if (key("enter")) {
        if (!question.multiSelect && !typing()) select(draft.focus, false);
        if (!answered(page)) { error = "Choose an option or write your answer."; tui.requestRender(); return true; }
        changePage(page + 1, controls); return true;
      }
      if (key("up") || key("down")) {
        draft.focus = Math.max(0, Math.min(question.options.length, draft.focus + (key("up") ? -1 : 1)));
        error = ""; reveal = true; tui.requestRender(); return true;
      }
      if (!typing()) {
        if (key("space")) { select(draft.focus); return true; }
        const number = question.options.findIndex((_option, index) => key(String(index + 1) as KeyId));
        if (number >= 0) { draft.focus = number; select(number); return true; }
        if (key("left") || key("right")) { changePage(page + (key("left") ? -1 : 1), controls); return true; }
        if (key("pageUp") || key("pageDown")) return false;
        // Native Input decodes Unicode, Kitty keys, editing shortcuts and paste.
        draft.focus = question.options.length; reveal = true;
      }
      write(data); return true;
    },
    onBodyMouse: (_event, position, controls) => {
      if (position.line === 0) {
        const tab = tabs.find(tab => position.column >= tab.start && position.column < tab.end);
        if (tab) { changePage(tab.page, controls); return true; }
      }
      const item = hits.find(item => position.line >= item.start && position.line < item.end);
      if (!item) return false;
      if (item.kind === "send") send(controls);
      else if (item.kind === "edit") changePage(item.index, controls);
      else { drafts[page].focus = item.index; if (item.kind === "option") select(item.index); else { reveal = true; tui.requestRender(); } }
      return true;
    },
    onInputMouse: event => {
      if (review()) return false;
      drafts[page].focus = questions[page].options.length; reveal = true;
      drafts[page].input.handleMouse(event); tui.requestRender(); return true;
    },
  });
}
