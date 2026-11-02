import { boundedText } from "./project-state.js";

export const MAX_ANSWER_BYTES = 2000;
export interface QuestionOption { id: string; label: string; description?: string; recommended?: boolean }
export interface UserQuestion { id: string; title: string; question: string; options: QuestionOption[]; multiSelect: boolean }
export interface UserAnswer { id: string; question: string; selected: { id: string; label: string }[]; text: string }
export interface AskUserResult { status: "answered" | "cancelled" | "unavailable"; answers: UserAnswer[] }

const text = (limit: number) => ({ type: "string", minLength: 1, maxLength: limit });
export const askUserSchema = { type: "object", properties: {
  questions: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", properties: {
    id: text(40), title: text(24), question: text(2000), multiSelect: { type: "boolean" },
    options: { type: "array", maxItems: 6, items: { type: "object", properties: {
      id: text(40), label: text(120), description: text(400), recommended: { type: "boolean" },
    }, required: ["id", "label"], additionalProperties: false } },
  }, required: ["id", "title", "question"], additionalProperties: false } },
}, required: ["questions"], additionalProperties: false };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Questions and options must be objects.");
  return value as Record<string, unknown>;
}
function required(value: unknown, label: string, limit: number, singleLine = false) {
  const result = boundedText(value, label, limit);
  if (!result) throw new Error(`${label} cannot be empty.`);
  return singleLine ? result.replace(/\s+/g, " ") : result;
}
function id(value: unknown) {
  const result = required(value, "ID", 40);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result)) throw new Error("IDs must use letters, digits, hyphens, or underscores.");
  return result;
}
function flag(value: unknown, label: string) {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
  return value === true;
}
export function parseUserQuestions(value: unknown): UserQuestion[] {
  const { questions } = record(value);
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) throw new Error("Ask between one and four questions at a time.");
  const ids = new Set<string>();
  return questions.map(value => {
    const question = record(value), questionId = id(question.id);
    if (ids.has(questionId)) throw new Error(`Duplicate question ID: ${questionId}.`);
    ids.add(questionId);
    const raw = question.options ?? [];
    if (!Array.isArray(raw) || raw.length === 1 || raw.length > 6) throw new Error("Provide two to six options, or omit options for a written answer.");
    const optionIds = new Set<string>();
    const options = raw.map(value => {
      const option = record(value), optionId = id(option.id);
      if (optionIds.has(optionId)) throw new Error(`Duplicate option ID: ${optionId}.`);
      optionIds.add(optionId);
      return { id: optionId, label: required(option.label, "Option label", 120, true),
        ...(option.description !== undefined ? { description: required(option.description, "Option description", 400, true) } : {}),
        recommended: flag(option.recommended, "Recommended"),
      };
    });
    const multiSelect = flag(question.multiSelect, "Multi-select");
    if (multiSelect && !options.length) throw new Error("Multi-select needs answer options.");
    if (!multiSelect && options.filter(option => option.recommended).length > 1) throw new Error("Recommend at most one option for a single-choice question.");
    return { id: questionId, title: required(question.title, "Question title", 96, true),
      question: required(question.question, "Question", 2000), options, multiSelect };
  });
}

export function collectUserAnswers(questions: readonly UserQuestion[], drafts: readonly { selected: ReadonlySet<string>; text: string }[]): UserAnswer[] {
  return questions.map((question, index) => {
    const draft = drafts[index];
    if (!draft) throw new Error("Every question needs an answer.");
    const selected = question.options.filter(option => draft.selected.has(option.id)).map(({ id, label }) => ({ id, label }));
    if (selected.length !== draft.selected.size || (!question.multiSelect && selected.length > 1)) throw new Error("Invalid answer selection.");
    const text = boundedText(draft.text, "Answer", MAX_ANSWER_BYTES);
    if (!selected.length && !text) throw new Error(`Answer “${question.title}” before sending.`);
    return { id: question.id, question: question.question, selected, text };
  });
}
