export interface WebPart {
  type: "text" | "thinking" | "tool" | "image";
  text?: string; id?: string; name?: string; input?: string;
}
export interface WebMessage { id: string; role: string; parts: WebPart[]; error?: boolean }
export interface WebChat {
  id: string; sessionId: string; title: string; preview: string; cwd: string;
  modified: number; count: number;
}
export interface WebHistory { chat: WebChat; messages: WebMessage[]; permissions: string; workMode: string }
export interface WebModel { id: string; provider: string; name: string }
export interface WebDialog {
  id: string; method: "confirm" | "select" | "input" | "editor";
  title: string; message?: string; options?: string[]; prefill?: string; placeholder?: string;
}
export interface WebTool { id: string; name: string; input: string; output: string; status: "running" | "done" | "error" }
export interface WebState {
  engineId: string; chat: WebChat; busy: boolean; model?: WebModel; thinking: string;
  messages: WebMessage[]; tools: WebTool[]; dialogs: WebDialog[]; permissions: string; workMode: string;
}
export interface WebEvent { type: string; engineId?: string; data?: unknown }
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const string = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;

export function browserMessage(message: WebMessage): WebMessage {
  let budget = 512_000, shortened = false;
  const parts: WebPart[] = [];
  for (const part of message.parts) {
    if (!part) continue;
    const size = (part.text?.length ?? 0) + (part.input?.length ?? 0);
    if (size > budget) { shortened = true; break; }
    parts.push(part); budget -= size;
  }
  if (shortened) parts.push({ type: "text", text: "[Further content omitted in the browser. The complete message remains in the Pi session.]" });
  return { ...message, parts };
}
export function browserHistory(messages: WebMessage[]) {
  let size = 0, first = messages.length;
  while (first > 0 && messages.length - first < 2000) {
    const next = messages[first - 1].parts.reduce((sum, part) => sum + (part?.text?.length ?? 0) + (part?.input?.length ?? 0), 0);
    if (size + next > 2 * 1024 * 1024) break;
    size += next; first--;
  }
  return first === 0 ? messages : [{ id: "browser-history-limit", role: "system", parts: [{ type: "text" as const, text: "Earlier messages are omitted from the browser view. The complete conversation remains in the Pi session." }] }, ...messages.slice(first)];
}
