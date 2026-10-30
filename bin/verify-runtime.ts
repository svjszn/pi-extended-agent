import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createFooter, createHeader } from "../ui/chrome.js";
import { createEscapeExitEditor } from "../ui/escape-exit.js";
import { createCommandPanel } from "../ui/command-panel.js";
import { createUiTheme } from "../ui/theme.js";
import { createChatStyle } from "../ui/chat.js";
import type { nativeAppearanceTheme as NativeAppearanceTheme } from "../ui/appearance.js";
import type { Runtime } from "./runtime.js";
import type { Palette, HeaderTui, PanelTui } from "../ui/types.js";
import type { Component, TUI, EditorTheme } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionFactory, ExtensionCommandContext, KeybindingsManager as Keys } from "@earendil-works/pi-coding-agent";
import type { readContextReport as ReadContextReport, readContextSummary as ReadContextSummary } from "../lib/context.js";
import type { readStatus as ReadStatus } from "../lib/status.js";
import { installCommandPolicy, prepareRuntimeCommands, verifyCommandPolicy } from "./command-policy.js";
import type { CommandRuntimeApi } from "./command-policy.js";

type PiApi = typeof import("@earendil-works/pi-coding-agent");
type TuiApi = typeof import("@earendil-works/pi-tui");
interface PrivateLayoutApi {
  renderLayoutFrame(root: Component, width: number, height: number, requestRender: () => void): { lines: string[] };
}
interface PrivateViewportApi {
  createChatViewport(options: Record<string, unknown>): { root: Component };
}

// No provider calls or user profile writes: probe our UI against the candidate.
export async function verifyRuntime(runtime: Runtime, packageRoot: string) {
  const entry = pathToFileURL(runtime.entry);
  const require = createRequire(entry);
  const api = await import(entry.href) as PiApi;
  installCommandPolicy(api as unknown as CommandRuntimeApi);
  await verifyCommandPolicy(await prepareRuntimeCommands(runtime));
  assert.equal(api.VERSION, runtime.version, "Runtime API version mismatch");
  assert.equal(typeof api.CustomEditor, "function", "Missing CustomEditor API");
  const tuiEntry = pathToFileURL(require.resolve("@earendil-works/pi-tui"));
  const tuiApi = await import(tuiEntry.href) as TuiApi;
  const { Container, Spacer, matchesKey, truncateToWidth, visibleWidth, stripTerminalSequences } = tuiApi;
  // These private adapters deliberately declare only the surface we exercise.
  // The candidate-runtime probe below checks their actual behavior before activation.
  const { renderLayoutFrame } = await import(new URL("./layout.js", tuiEntry).href) as PrivateLayoutApi;
  const { createChatViewport } = await import(new URL("./modes/interactive/chat-viewport.js", entry).href) as PrivateViewportApi;
  const { KeybindingsManager } = await import(new URL("./core/keybindings.js", entry).href) as { KeybindingsManager: new () => Keys };
  const { UserMessageComponent } = await import(new URL("./modes/interactive/components/user-message.js", entry).href) as { UserMessageComponent: new (text: string) => Component };
  const { AssistantMessageComponent } = await import(new URL("./modes/interactive/components/assistant-message.js", entry).href) as { AssistantMessageComponent: new (message: { content: { type: "text"; text: string }[] }) => Component };
  const { initTheme, getEditorTheme } = await import(new URL("./modes/interactive/theme/theme.js", entry).href) as {
    initTheme(name: string, watch: boolean): void; getEditorTheme(): EditorTheme;
  };
  initTheme("dark", false);
  assert.equal(typeof api.ToolExecutionComponent, "function", "Missing native tool renderer");
  const tool = new api.ToolExecutionComponent("read", "compat-tool", { path: "example.ts" }, { showImages: false }, undefined,
    { requestRender() {} } as TUI, packageRoot);
  tool.updateResult({ content: [{ type: "text", text: "Runtime tool details" }], isError: false });
  const toolStyle = createChatStyle();
  try {
    toolStyle.apply({ children: [tool] }, 80);
    assert.equal(tool.render(80).length, 1, "Runtime breaks compact tool calls");
    assert.ok(stripTerminalSequences(tool.render(80)[0]).startsWith("  ▸ read"), "Runtime breaks tool call inset");
    tool.handleMouse({ type: "click", button: "left", x: 3, y: 0, width: 80, height: 1,
      screenX: 3, screenY: 0, shift: false, alt: false, ctrl: false });
    assert.ok(tool.render(80).join("\n").includes("Runtime tool details"), "Runtime breaks tool disclosure");
  } finally { toolStyle.dispose(); }
  const theme: Palette = { bold: (s) => s, fg: (_color, s) => s };
  const component = (lines: string[]) => ({ render: () => lines, invalidate() {} });

  for (const [width, height] of [[80, 24], [24, 12]]) {
    const document = new Container();
    const headerContainer = new Container();
    document.addChild(headerContainer);
    document.addChild(component(["[Extensions]"]));
    const chat = new Container();
    const user = new UserMessageComponent("Runtime check");
    const assistant = new AssistantMessageComponent({ content: [{ type: "text", text: "Assistant reply" }] });
    chat.addChild(user);
    chat.addChild(assistant);
    document.addChild(chat);
    const tui: HeaderTui & PanelTui = { mode: "fullscreen", children: [], terminal: { rows: height, columns: width }, requestRender() {} };
    const footer = createFooter({ cwd: packageRoot }, tui, theme,
      { onBranchChange: () => () => {}, getGitBranch: () => "main" }, tuiApi);
    const pendingMessages = component([]), status = component([]), widgetsAbove = new Spacer(1);
    const editor = component(["─".repeat(width), "> ", "─".repeat(width)]), widgetsBelow = component([]);
    tui.children = [document, pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer];
    headerContainer.addChild(new Spacer(1));
    headerContainer.addChild(createHeader(tui, theme, tuiApi, {
      version: runtime.version, getModel: () => ({ id: "gpt-6.1-sol" }), getThinkingLevel: () => "medium", getCwd: () => packageRoot,
    }));
    headerContainer.addChild(new Spacer(1));
    const viewport = createChatViewport({ document, pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer, scrollbar: "hidden" });
    const lines = renderLayoutFrame(viewport.root, width, height, () => {}).lines.map(stripTerminalSequences);
    assert.equal(lines.length, height);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), "Runtime layout overflows");
    assert.ok(lines.some((line) => line.trim() === ">"), "Runtime hides input");
    assert.ok(lines.some((line) => line.includes("Runtime check")), "Runtime hides conversation");
    assert.ok(user.render(width).some((line) => line.includes("\x1b[48;2;32;32;32m")), "Runtime breaks user message background");
    assert.ok(user.render(width).map(stripTerminalSequences).some((line) => line.startsWith("  Runtime check")), "Runtime breaks user message inset");
    assert.ok(assistant.render(width).map(stripTerminalSequences).some((line) => line.startsWith("  Assistant reply")), "Runtime breaks assistant message inset");
    let modeToggles = 0, thinkingChanges = 0;
    const effortSteps: number[] = [];
    const Editor = createEscapeExitEditor(api.CustomEditor, matchesKey, { isIdle: () => true, hasPendingMessages: () => false },
      { getLevel: () => "medium", step: (direction) => { effortSteps.push(direction); } }, () => { modeToggles++; });
    const input = new Editor(tui as TUI, getEditorTheme(), new KeybindingsManager());
    input.setWorkingStatusIndicator({ renderInBorder: () => "Working", renderSpinnerInBorder: () => "*" } as unknown as Parameters<typeof input.setWorkingStatusIndicator>[0]);
    assert.ok(stripTerminalSequences(input.render(width)[0]).startsWith("  Working"), "Runtime breaks Working inset");
    assert.ok(!stripTerminalSequences(input.render(width)[1]).includes("Working"), "Runtime puts Working in the input border");
    input.setWorkingStatusIndicator(undefined);
    input.onAction("app.thinking.cycle", () => { thinkingChanges++; });
    input.handleInput("\x1b[Z");
    assert.equal(modeToggles, 1, "Runtime breaks Shift+Tab mode switching");
    assert.equal(thinkingChanges, 0, "Runtime still changes effort on Shift+Tab");
    input.setText("Runtime draft");
    input.handleInput("\x1b[1;2D"); input.handleInput("\x1b[1;2C");
    assert.deepEqual(effortSteps, [-1, 1], "Runtime breaks Shift+arrow effort controls");
    assert.equal(input.getText(), "Runtime draft", "Runtime effort controls alter the draft");
    input.setText("");
    const inputLines = input.render(width).map(stripTerminalSequences);
    assert.equal(inputLines[0].trim(), "medium", "Runtime hides effort above input");
    assert.equal(inputLines[1], "─".repeat(width), "Runtime breaks full-width input border");
    assert.ok(inputLines[2].startsWith("❯ "), "Runtime hides the input chevron or breaks text alignment");
    input.dispose();
    let exited = false;
    input.onCtrlD = () => { exited = true; };
    input.handleInput("\x1b");
    assert.equal(exited, true, "Runtime breaks Escape exit");
    // Custom commands mount a standalone header, without the chat's TUI tree.
    const palette = createUiTheme();
    const commandHeader = createHeader({ mode: "regular" }, palette, tuiApi, {
      version: runtime.version, getModel: () => ({ id: "gpt-6.1-sol" }), getThinkingLevel: () => "medium",
    });
    const panel = createCommandPanel({ title: "Activity", tui, theme: palette, measure: tuiApi, done() {},
      load: async () => "Activity loaded", renderBody: (value) => [value],
      renderHeader: (panelWidth) => commandHeader.render(panelWidth),
    });
    try {
      panel.render(width);
      await panel.ready;
      assert.ok(panel.render(width).map(stripTerminalSequences).some((line) => line.includes("Activity loaded")), "Runtime breaks command overlays");
    } finally {
      panel.dispose();
      commandHeader.dispose();
    }
    footer.dispose();
  }

  // Use the same host-module resolution as Pi extensions, against this runtime.
  const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
  const piAiManifest = findPackageJSON("@earendil-works/pi-ai", entry.href);
  assert.ok(piAiManifest, "Missing Pi model API package");
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    "@earendil-works/pi-coding-agent": runtime.entry,
    "@earendil-works/pi-ai": join(dirname(piAiManifest), "dist", "compat.js"),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  } });
  const contextApi = await jiti.import(join(packageRoot, "dist", "lib", "context.js")) as {
    readContextReport: typeof ReadContextReport; readContextSummary: typeof ReadContextSummary;
  };
  const appearanceApi = await jiti.import(join(packageRoot, "dist", "ui", "appearance.js")) as { nativeAppearanceTheme: typeof NativeAppearanceTheme };
  const { getThemeByName } = await import(new URL("./modes/interactive/theme/theme.js", entry).href) as {
    getThemeByName(name: string): InstanceType<PiApi["Theme"]> | undefined;
  };
  for (const mode of ["dark", "light"] as const) {
    const themed = appearanceApi.nativeAppearanceTheme({ getTheme: getThemeByName }, { mode, color: "green" });
    assert.ok(themed instanceof api.Theme, "Runtime breaks extension Theme instances");
    assert.equal(themed.appearance, mode, "Runtime breaks theme appearance");
  }
  const memory = api.SessionManager.inMemory(packageRoot);
  const context = {
    model: { contextWindow: 200_000 }, sessionManager: memory,
    getSystemPrompt: () => "Runtime context check",
    getSystemPromptOptions: () => ({ cwd: packageRoot, skills: [], contextFiles: [] }),
    getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
  } as unknown as ExtensionCommandContext;
  const tools = { getActiveTools: () => [], getAllTools: () => [] };
  assert.ok(contextApi.readContextSummary(context, tools).tokens! > 0, "Runtime breaks context accounting");
  assert.equal(contextApi.readContextReport(context, tools, api.SettingsManager.inMemory()).contextWindow, 200_000, "Runtime breaks context detail");
  const statusApi = await jiti.import(join(packageRoot, "dist", "lib", "status.js")) as { readStatus: typeof ReadStatus };
  const status = await statusApi.readStatus({ ...context, cwd: packageRoot, model: undefined, isProjectTrusted: () => false },
    tools, { version: runtime.version, packageDir: runtime.packageDir, agentDir: join(packageRoot, ".local", "status-runtime-check") });
  assert.equal(status.version, runtime.version, "Runtime breaks session status");
  assert.equal(status.sessionId, memory.getSessionId(), "Runtime hides session ID");
  if (existsSync(join(runtime.packageDir, "dist", "extensions", "mcp", "config.js"))) {
    assert.equal(status.mcpConfigKnown, true, "Runtime breaks MCP configuration metadata");
  }
  const commands = new Set<string>();
  const fakePi: Pick<ExtensionAPI, "on" | "registerCommand" | "registerTool"> = {
    on() { return () => {}; }, registerCommand(name) { commands.add(name); }, registerTool(tool) { assert.ok(tool.parameters, `Missing schema for ${tool.name}`); },
  };
  for (const file of readdirSync(join(packageRoot, "dist", "extensions")).filter((file) => file.endsWith(".js"))) {
    const factory = await jiti.import(join(packageRoot, "dist", "extensions", file), { default: true }) as ExtensionFactory;
    await factory(fakePi as ExtensionAPI);
  }
  for (const name of ["usage", "status", "stats", "config", "skills", "context", "effort", "permissions", "memory", "plan", "prompt", "theme", "color"]) {
    assert.ok(commands.has(name), `Runtime failed to register /${name}`);
  }
}
