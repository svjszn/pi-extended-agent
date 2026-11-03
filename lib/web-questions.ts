import { collectUserAnswers } from "./ask-user.js";
import type { UserQuestion, UserAnswer } from "./ask-user.js";

export const WEB_QUESTIONS_PREFIX = "PI_WEB_QUESTIONS\n";
export function webQuestionAnswers(questions: UserQuestion[], response: string): UserAnswer[] {
  if (Buffer.byteLength(response, "utf8") > 32_000) throw new Error("Question answers are too large.");
  const values: unknown = JSON.parse(response);
  if (!Array.isArray(values) || values.length !== questions.length) throw new Error("Answer every question exactly once.");
  const drafts = questions.map((question, index) => {
    const value = values[index] as { id?: unknown; selected?: unknown; text?: unknown } | null;
    if (value?.id !== question.id || !Array.isArray(value.selected) || value.selected.some(id => typeof id !== "string") || typeof value.text !== "string") throw new Error("Invalid question answer.");
    if (new Set(value.selected).size !== value.selected.length) throw new Error("Duplicate answer selection.");
    return { selected: new Set<string>(value.selected), text: value.text };
  });
  return collectUserAnswers(questions, drafts);
}
