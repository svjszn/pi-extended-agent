import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createFooter, createHeader } from "../ui/chrome.js";
import { createEscapeExitEditor } from "../ui/escape-exit.js";
import { beginSubagentStatus } from "../lib/subagent-status.js";
import { createCommandPanel } from "../ui/command-panel.js";
import { createAuthSelectorScreen } from "../ui/auth-screen.js";
import { captureFlashes } from "./flash-interface.js";
import { visibleFlash } from "../lib/flash-status.js";
import { createUiTheme } from "../ui/theme.js";
import { createChatStyle } from "../ui/chat.js";
import { getAppearance, setAppearance } from "../lib/appearance.js";
import type { nativeAppearanceTheme as NativeAppearanceTheme } from "../ui/appearance.js";
import type { Runtime } from "./runtime.js";
import type { Palette, HeaderTui, PanelTui } from "../ui/types.js";
import type { Component, TUI, EditorTheme } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionFactory, ExtensionCommandContext, ExtensionUIContext, KeybindingsManager as Keys } from "@earendil-works/pi-coding-agent";
import type { readContextReport as ReadContextReport, readContextSummary as ReadContextSummary } from "../lib/context.js";
import type { readStatus as ReadStatus } from "../lib/status.js";
import { installCommandPolicy, prepareRuntimeCommands, verifyCommandPolicy } from "./command-policy.js";
import { keepSessionChrome, verifySessionChrome } from "./chrome-interface.js";
import type { ChromeRuntimeApi } from "./chrome-interface.js";
import type { CommandRuntimeApi } from "./command-policy.js";
import { runtimeCli } from "./runtime-cli.js";
import { createSessionScreen } from "../ui/session-screen.js";
import type { NativeSessionSelector } from "../ui/session-screen.js";

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
  // Resolve the selected engine's CLI setup and public entry point without starting it.
  await runtimeCli(runtime);
  const entry = pathToFileURL(runtime.entry);
  const require = createRequire(entry);
  const api = await import(entry.href) as PiApi;
  installCommandPolicy(api as unknown as CommandRuntimeApi);
  keepSessionChrome(api as unknown as ChromeRuntimeApi);
  const commandApi = await prepareRuntimeCommands(runtime);
  await verifyCommandPolicy(commandApi);
  // A session replacement must leave this interface mounted on the terminal.
  verifySessionChrome(api as unknown as ChromeRuntimeApi);
  verifySessionChrome(commandApi as unknown as ChromeRuntimeApi);
  // Native JS extension imports use this executable's bundled public API, not
  // the wrapper's separately installed SDK. Check deferred command readers too.
  const bundledApi = commandApi as unknown as Record<string, unknown>;
  for (const name of ["getAgentDir", "getPackageDir", "SettingsManager", "CustomEditor", "buildSessionContext",
    "estimateTokens", "formatSkillsForPrompt", "getLastAssistantUsage", "parseFrontmatter",
    // Subagents are built on these supported factories, not on private adapters.
    "createAgentSessionServices", "createAgentSessionFromServices", "SessionManager", "createCodemodeExtension"]) {
    assert.equal(typeof bundledApi[name], "function", `Missing bundled extension API: ${name}`);
  }
  assert.equal(bundledApi.VERSION, runtime.version, "Bundled extension API version mismatch");
  assert.equal(api.VERSION, runtime.version, "Runtime API version mismatch");
  assert.equal(typeof api.CustomEditor, "function", "Missing CustomEditor API");
  const tuiEntry = pathToFileURL(require.resolve("@earendil-works/pi-tui"));
  const tuiApi = await import(tuiEntry.href) as TuiApi;
  assert.equal(typeof tuiApi.renderFakeCursor, "function", "Missing software cursor renderer for /nano");
  const { Container, Spacer, matchesKey, truncateToWidth, visibleWidth, stripTerminalSequences } = tuiApi;
  // These private adapters deliberately declare only the surface we exercise.
  // The candidate-runtime probe below checks their actual behavior before activation.
  const { renderLayoutFrame } = await import(new URL("./layout.js", tuiEntry).href) as PrivateLayoutApi;
  const { createChatViewport } = await import(new URL("./modes/interactive/chat-viewport.js", entry).href) as PrivateViewportApi;
  const { KeybindingsManager } = await import(new URL("./core/keybindings.js", entry).href) as { KeybindingsManager: new () => Keys };
  const SessionSelector = (commandApi as unknown as PiApi).SessionSelectorComponent;
  assert.equal(typeof SessionSelector, "function", "Missing native session selector");
  const fixtureChat = { id: "compat-chat", path: "compat-chat.jsonl", cwd: packageRoot, name: "Compatibility chat",
    firstMessage: "Inspect the module", allMessagesText: "Inspect the module\nneedle", messageCount: 2, created: new Date(), modified: new Date() };
  const sessionSelector = new SessionSelector(async () => [fixtureChat], async () => [fixtureChat], () => {}, () => {}, () => {}, () => {},
    { keybindings: new KeybindingsManager() });
  const sessionPanel = createSessionScreen({ selector: sessionSelector as unknown as NativeSessionSelector,
    tui: { terminal: { rows: 24 }, requestRender() {} }, theme: createUiTheme(), measure: tuiApi, done() {} });
  try {
    await sessionPanel.ready;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(sessionPanel.render(80).some((line) => line.includes("Compatibility chat")), "Runtime breaks resume listings");
    sessionPanel.handleInput("needle");
    assert.ok(sessionPanel.render(80).some((line) => line.includes("Compatibility chat")), "Runtime breaks conversation search");
    sessionPanel.handleInput("\x1b");
  } finally { sessionPanel.dispose(); }
  const { UserMessageComponent } = await import(new URL("./modes/interactive/components/user-message.js", entry).href) as { UserMessageComponent: new (text: string) => Component };
  const { AssistantMessageComponent } = await import(new URL("./modes/interactive/components/assistant-message.js", entry).href) as { AssistantMessageComponent: new (message: { content: ({ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> })[] }) => Component };
  const { initTheme, getEditorTheme } = await import(new URL("./modes/interactive/theme/theme.js", entry).href) as {
    initTheme(name: string, watch: boolean): void; getEditorTheme(): EditorTheme;
  };
  initTheme("dark", false);
  // Probe the native auth selector shape without reading credentials or starting a login.
  const authHost = Object.create(commandApi.InteractiveMode.prototype) as {
    getLoginProviderOptions(type?: string): unknown[];
    showLoginProviderSelector(type?: string): void;
    showSelector(create: (done: () => void) => { component: import("../ui/auth-screen.js").AuthSelector }): void;
    ui: { requestRender(): void };
  };
  authHost.getLoginProviderOptions = () => [{ id: "compat", name: "Compatibility provider", authType: "api_key" }];
  authHost.ui = { requestRender() {} };
  let authSelector: import("../ui/auth-screen.js").AuthSelector | undefined;
  authHost.showSelector = (create) => { authSelector = create(() => {}).component; };
  authHost.showLoginProviderSelector("api_key");
  if (!authSelector || !Array.isArray((authSelector as import("../ui/auth-screen.js").AuthSelector).filteredProviders)) {
    throw new Error("Pi auth provider selector has changed.");
  }
  const authTui = { children: [], terminal: { rows: 24, columns: 80 }, requestRender() {} };
  const authScreen = createAuthSelectorScreen({ selector: authSelector, tui: authTui, theme: createUiTheme(), measure: tuiApi, done() {} });
  try {
    await authScreen.ready;
    if (!authScreen.render(80).some((line) => line.includes("Compatibility provider"))) throw new Error("Pi auth selector no longer renders providers.");
  } finally { authScreen.dispose(); }
  assert.equal(typeof api.ToolExecutionComponent, "function", "Missing native tool renderer");
  const tool = new api.ToolExecutionComponent("read", "compat-tool", { path: "example.ts" }, { showImages: false }, undefined,
    { requestRender() {} } as TUI, packageRoot);
  tool.updateResult({ content: [{ type: "text", text: "Runtime tool details" }], isError: false });
  const toolStyle = createChatStyle();
  const toolPrompt = new UserMessageComponent("Inspect the runtime");
  const previousAppearance = getAppearance();
  try {
    setAppearance({ ...previousAppearance, toolOutput: "compact" });
    toolStyle.apply({ children: [toolPrompt, tool] }, 80);
    const promptLines = toolPrompt.render(80);
    assert.equal(stripTerminalSequences(promptLines.at(-1)!), "", "Runtime breaks the gap after user messages");
    assert.ok(!promptLines.at(-1)!.includes("\x1b[48;"), "Runtime colors the message separator");
    assert.equal(tool.render(80).length, 1, "Runtime breaks compact tool calls");
    assert.ok(stripTerminalSequences(tool.render(80)[0]).startsWith("  ● Read("), "Runtime breaks tool call inset");
    tool.handleMouse({ type: "click", button: "left", x: 3, y: 0, width: 80, height: 1,
      screenX: 3, screenY: 0, shift: false, alt: false, ctrl: false });
    assert.ok(tool.render(80).join("\n").includes("Runtime tool details"), "Runtime breaks tool disclosure");
    tool.setExpanded(false);
    const second = new api.ToolExecutionComponent("grep", "compat-search", { pattern: "runtime", path: "." }, { showImages: false }, undefined,
      { requestRender() {} } as TUI, packageRoot);
    second.updateResult({ content: [{ type: "text", text: "Runtime search details" }], isError: false });
    const toolOnlyMessage = new AssistantMessageComponent({ content: [{ type: "toolCall", id: "compat-search", name: "grep", arguments: { pattern: "runtime" } }] });
    const research = { children: [toolPrompt, tool, toolOnlyMessage, second] };
    toolStyle.apply(research, 80);
    assert.ok(stripTerminalSequences(tool.render(80)[0]).includes("Explored 1 file · 1 search"), "Runtime breaks research groups");
    assert.equal(second.render(80).length, 0, "Runtime fails to collapse grouped research");
    tool.handleMouse({ type: "click", button: "left", x: 3, y: 0, width: 80, height: 1,
      screenX: 3, screenY: 0, shift: false, alt: false, ctrl: false });
    toolStyle.apply(research, 80);
    tool.render(80);
    assert.ok(stripTerminalSequences(second.render(80).join("\n")).includes("Search(runtime in .)"), "Runtime hides calls in an opened group");
    assert.ok(!second.render(80).join("\n").includes("Runtime search details"), "Opening a group must not expand every result");
    const expansionHost = Object.assign(Object.create(commandApi.InteractiveMode.prototype), {
      toolOutputExpanded: false, loadedResourcesContainer: { children: [] }, chatContainer: { children: [tool, second] },
      builtInHeader: { setExpanded() {} }, showStatus() {},
    }) as { createExtensionUIContext(): Pick<ExtensionUIContext, "getToolsExpanded" | "setToolsExpanded"> };
    const expansion = expansionHost.createExtensionUIContext();
    assert.equal(typeof expansion.getToolsExpanded, "function", "Missing tool expansion reader");
    assert.equal(typeof expansion.setToolsExpanded, "function", "Missing tool expansion control");
    assert.equal(expansion.getToolsExpanded(), false);
    expansion.setToolsExpanded(true);
    assert.equal(expansion.getToolsExpanded(), true, "Runtime breaks session-wide tool expansion");
    assert.ok(second.render(80).join("\n").includes("Runtime search details"), "Native expansion hides grouped results");
    expansion.setToolsExpanded(false);
    setAppearance({ ...previousAppearance, toolOutput: "full" });
    toolStyle.apply(research, 80);
    assert.ok(second.render(80).join("\n").includes("Runtime search details"), "Runtime breaks full tool output");
  } finally { toolStyle.dispose(); setAppearance(previousAppearance); }
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
    const nativeChatRender = chat.render;
    let chatRenders = 0;
    chat.render = (columns) => { chatRenders++; return nativeChatRender.call(chat, columns); };
    const tui: HeaderTui & PanelTui = { mode: "fullscreen", children: [], terminal: { rows: height, columns: width }, requestRender() {} };
    const footer = createFooter({ cwd: packageRoot }, tui, theme,
      { onBranchChange: () => () => {}, getGitBranch: () => "main" }, tuiApi);
    const pendingMessages = component([]), status = component([]), widgetsAbove = new Spacer(1);
    const editor = component(["─".repeat(width), "> ", "─".repeat(width)]), widgetsBelow = component([]);
    tui.children = [document, pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer];
    headerContainer.addChild(new Spacer(1));
    const header = createHeader(tui, tuiApi, {
      version: runtime.version, getModel: () => ({ id: "gpt-6.1-sol" }), getThinkingLevel: () => "medium", getCwd: () => packageRoot,
    });
    headerContainer.addChild(header);
    headerContainer.addChild(new Spacer(1));
    const viewport = createChatViewport({ document, pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer, scrollbar: "hidden" });
    const lines = renderLayoutFrame(viewport.root, width, height, () => {}).lines.map(stripTerminalSequences);
    assert.equal(lines.length, height);
    assert.equal(chatRenders, 1, "Runtime renders the transcript twice while measuring the header");
    assert.ok(lines.every((line) => visibleWidth(line) <= width), "Runtime layout overflows");
    assert.ok(lines.some((line) => line.trim() === ">"), "Runtime hides input");
    assert.ok(lines.some((line) => line.includes("Runtime check")), "Runtime hides conversation");
    assert.ok(user.render(width).some((line) => line.includes("\x1b[48;2;32;32;32m")), "Runtime breaks user message background");
    assert.ok(user.render(width).map(stripTerminalSequences).some((line) => line.startsWith("  Runtime check")), "Runtime breaks user message inset");
    assert.ok(assistant.render(width).map(stripTerminalSequences).some((line) => line.startsWith("  Assistant reply")), "Runtime breaks assistant message inset");
    let modeToggles = 0, thinkingChanges = 0;
    const effortSteps: number[] = [];
    const Editor = createEscapeExitEditor(api.CustomEditor, matchesKey, { isIdle: () => true, hasPendingMessages: () => false,
      getRunProgress: () => ({ elapsedMs: 83_000, outputTokens: 3200, estimated: false }) },
      { getLevel: () => "medium", step: (direction) => { effortSteps.push(direction); } }, () => { modeToggles++; });
    const input = new Editor(tui as TUI, getEditorTheme(), new KeybindingsManager());
    input.setWorkingStatusIndicator({ renderInBorder: () => "Working", renderSpinnerInBorder: () => "*" } as unknown as Parameters<typeof input.setWorkingStatusIndicator>[0]);
    assert.ok(stripTerminalSequences(input.render(width)[0]).startsWith("  Working"), "Runtime breaks Working inset");
    if (width >= 80) assert.ok(stripTerminalSequences(input.render(width)[0]).includes("1m 23s · ↓ 3.2k tokens"), "Runtime breaks run progress");
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
    const activity = beginSubagentStatus("lens");
    try {
      activity.update("Using read", { toolCalls: 2 });
      const activeLines = input.render(width).map(stripTerminalSequences);
      assert.equal(activeLines.length, inputLines.length, "Runtime adds a separate subagent status row");
      assert.ok(activeLines[0].includes("Working"), "Runtime hides subagent activity above input");
      assert.equal(activeLines[1], inputLines[1], "Runtime shifts the input during subagent work");
      if (width >= 80) {
        assert.ok(activeLines[0].includes("lens"), "Runtime hides the active subagent name");
        assert.ok(activeLines[0].includes("2 calls"), "Runtime hides subagent tool-call counts");
        assert.ok(activeLines[0].includes("medium"), "Runtime hides effort during subagent work");
      }
    } finally { activity.dispose(); }
    assert.equal(stripTerminalSequences(input.render(width)[0]).trim(), "medium", "Runtime leaves stale subagent activity");
    // Copy-on-select confirmations must still reach a flash the corner can take over.
    assert.equal(typeof (tuiApi as unknown as { TuiAltScreen?: { prototype?: { flash?: unknown } } })
      .TuiAltScreen?.prototype?.flash, "function", "Pi's alternate screen no longer flashes copy confirmations");
    const flashHost: { flash?(message: string, durationMs?: number): void } = { flash() {} };
    const restoreFlashes = captureFlashes(flashHost);
    assert.ok(restoreFlashes, "Pi no longer exposes the alternate-screen flash stack");
    flashHost.flash!("Copied!");
    assert.equal(visibleFlash(80), "Copied!", "Runtime breaks the relocated copy notice");
    input.setText("");
    assert.equal(stripTerminalSequences(input.render(width)[0]).trim(), "Copied!", "Runtime hides the relocated copy notice");
    restoreFlashes!();
    assert.equal(visibleFlash(80), undefined, "Restoring the flash stack must clear the corner");
    input.dispose();
    let exited = false;
    input.onCtrlD = () => { exited = true; };
    input.handleInput("\x1b");
    assert.equal(exited, true, "Runtime breaks Escape exit");
    // Custom commands mount a standalone header, without the chat's TUI tree.
    const palette = createUiTheme();
    const commandHeader = createHeader({ mode: "regular" }, tuiApi, {
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
    header.dispose();
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
  assert.equal(status.sessionName, "Not set", "Runtime breaks session name lookup");
  if (existsSync(join(runtime.packageDir, "dist", "extensions", "mcp", "config.js"))) {
    assert.equal(status.mcpConfigKnown, true, "Runtime breaks MCP configuration metadata");
  }
  const commands = new Set<string>(), registeredTools = new Set<string>();
  const fakePi: Pick<ExtensionAPI, "on" | "registerCommand" | "registerTool"> = {
    on() { return () => {}; }, registerCommand(name) { commands.add(name); }, registerTool(tool) {
      assert.ok(tool.parameters, `Missing schema for ${tool.name}`); registeredTools.add(tool.name);
    },
  };
  const extensionFiles: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).pi?.extensions;
  assert.ok(Array.isArray(extensionFiles) && extensionFiles.length > 0, "Missing production extension allowlist");
  for (const file of extensionFiles) {
    assert.ok(typeof file === "string" && /^\.\/dist\/extensions\/[a-z0-9-]+\.js$/.test(file), "Invalid production extension path");
    const factory = await jiti.import(join(packageRoot, file), { default: true }) as ExtensionFactory;
    await factory(fakePi as ExtensionAPI);
  }
  assert.ok(!commands.has("perf"), "Development performance command must not ship");
  for (const name of ["usage", "status", "stats", "doctor", "diff", "nano", "config", "skills", "context", "effort", "permissions", "memory", "plan", "prompt", "mode", "theme", "color", "agents", "scout", "lens", "clear"]) {
    assert.ok(commands.has(name), `Runtime failed to register /${name}`);
  }
  for (const name of ["task", "ask_user"]) assert.ok(registeredTools.has(name), `Runtime failed to register ${name}`);
}
