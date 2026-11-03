import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { askUserSchema, parseUserQuestions } from "../lib/ask-user.js";
import type { AskUserResult } from "../lib/ask-user.js";
import { serializeApproval } from "../lib/approval-queue.js";

const cancelled = (): AskUserResult => ({ status: "cancelled", answers: [] });
const unavailable = (): AskUserResult => ({ status: "unavailable", answers: [] });
function result(value: AskUserResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

export default function askUser(pi: ExtensionAPI) {
  let lifetime = new AbortController();
  pi.on("session_start", () => { lifetime.abort(); lifetime = new AbortController(); });
  pi.on("session_shutdown", () => { lifetime.abort(); });
  pi.registerTool({
    name: "ask_user", label: "Ask user", parameters: askUserSchema,
    description: "Ask the user one to four focused questions when a missing decision materially affects the work. The interactive screen supports single or multiple selections, written answers, and extra details. Omit options for text-only questions. Do not add an Other option; written answers are always available. Use stable question and option IDs, short titles, and concise option descriptions. Answers do not grant tool permissions or approve plan execution. If cancelled, do not repeat the same question automatically. In noninteractive modes, status is unavailable and no answer is collected.",
    promptSnippet: "Ask for a missing decision using choices or a written answer",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const questions = parseUserQuestions(params);
      const runSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), ...(ctx.signal ? [ctx.signal] : [])]);
      if (runSignal.aborted) return result(cancelled());
      const web = ctx.mode === "rpc" && process.env.PI_EXTENDED_WEB_UI === "1";
      if (!ctx.hasUI || ctx.mode !== "tui" && !web) return result(unavailable());
      const answer = await serializeApproval<AskUserResult>(async () => {
        if (runSignal.aborted) return cancelled();
        if (web) {
          const { WEB_QUESTIONS_PREFIX, webQuestionAnswers } = await import("../lib/web-questions.js");
          if (runSignal.aborted) return cancelled();
          let abort: () => void = () => {};
          const cancelledResponse = new Promise<undefined>(resolve => { abort = () => resolve(undefined); runSignal.addEventListener("abort", abort, { once: true }); });
          try {
            const response = await Promise.race([ctx.ui.editor("Questions from Pi", WEB_QUESTIONS_PREFIX + JSON.stringify(questions)), cancelledResponse]);
            if (response === undefined || runSignal.aborted) return cancelled();
            return { status: "answered", answers: webQuestionAnswers(questions, response) };
          } finally { runSignal.removeEventListener("abort", abort); }
        }
        const [{ createAskUserScreen }, { createHeader }, { createUiTheme }] = await Promise.all([
          import("../ui/ask-user-screen.js"), import("../ui/chrome.js"), import("../ui/theme.js"),
        ]);
        if (runSignal.aborted) return cancelled();
        let collected = cancelled();
        const submitted = await ctx.ui.custom<boolean>((tui, _theme, _keys, done) => {
          const theme = createUiTheme();
          const measure = { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi };
          const header = createHeader({ mode: "regular" }, measure, {
            version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
          });
          const abort = () => { panel.dispose(); done(false); };
          const panel = createAskUserScreen({ questions, tui, theme, measure, done,
            onSubmit: answers => { collected = { status: "answered", answers }; },
            renderHeader: width => header.render(width),
            onDispose: () => { runSignal.removeEventListener("abort", abort); header.dispose(); },
          });
          runSignal.addEventListener("abort", abort, { once: true });
          if (runSignal.aborted) abort();
          return panel;
        }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
        return submitted && !runSignal.aborted ? collected : cancelled();
      }, unavailable());
      return result(runSignal.aborted ? cancelled() : answer);
    },
  });
}
