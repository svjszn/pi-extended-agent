import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";

export function present<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, "Expected the test fixture value to exist");
  return value;
}

/** Deterministic provider data, with no credentials or network behavior. */
export function modelFixture(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
  return { id: "fixture", name: "Fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://fixture.invalid",
    reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...overrides };
}
export function assistantFixture(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: "assistant", content, api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...overrides };
}
/** Renderer tests exercise only the terminal surface used by their component. */
export function tuiFixture(value: unknown): TUI { return value as TUI; }
export type Panel = ReturnType<typeof import("../ui/command-panel.js").createCommandPanel>;
export type PanelFactory = (tui: import("../ui/types.js").PanelTui & { children?: import("@earendil-works/pi-tui").Component[] }, theme: import("../ui/types.js").Palette,
  keys: object, done: (result?: unknown) => void) => Panel;
export type CustomUi = (create: PanelFactory, options?: { overlay?: boolean }) => Promise<unknown>;
export interface TestUi {
  notify(message: string, type?: string): void;
  custom?: CustomUi;
  setEditorComponent?: import("@earendil-works/pi-coding-agent").ExtensionUIContext["setEditorComponent"];
}
/** Invoke registered commands with deliberately partial host fixtures. */
export function commandFixture(command: Parameters<import("@earendil-works/pi-coding-agent").ExtensionAPI["registerCommand"]>[1]) {
  return { ...command, handler: (args: string, ctx: unknown) => command.handler(args,
    ctx as import("@earendil-works/pi-coding-agent").ExtensionCommandContext) };
}
