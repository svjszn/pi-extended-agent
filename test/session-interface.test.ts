import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, SessionStartEvent, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const { default: piInterface } = await import(new URL("../dist/extensions/pi-interface.js", import.meta.url).href) as typeof import("../extensions/pi-interface.js");
const { acquireTerminalChrome } = await import(new URL("../dist/ui/terminal-chrome.js", import.meta.url).href) as typeof import("../ui/terminal-chrome.js");
const { default: escapeExit } = await import(new URL("../dist/extensions/escape-exit.js", import.meta.url).href) as typeof import("../extensions/escape-exit.js");
const { setAppearance, DEFAULT_APPEARANCE } = await import(new URL("../dist/lib/appearance.js", import.meta.url).href) as typeof import("../lib/appearance.js");

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type Component = { render(width: number): string[]; dispose?(): void };
type Start = (event: SessionStartEvent, ctx: ExtensionContext) => void;
type Shutdown = (event: SessionShutdownEvent) => void;
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function terminal() {
  const writes: string[] = [];
  let queries = 0;
  const originalFlash = () => {};
  const originalTitle = () => {};
  const originalProgress = () => {};
  const originalColors = { foreground: { r: 17, g: 34, b: 51 }, background: { r: 68, g: 85, b: 102 } };
  const tui = {
    mode: "regular", children: [], requestRender() {}, invalidate() {}, flash: originalFlash,
    terminal: { columns: 80, rows: 24, write: (text: string) => { writes.push(text); }, setTitle: originalTitle, setProgress: originalProgress },
    queryTerminalColors: async () => { queries++; return originalColors; },
  };
  return { tui, native: tui as unknown as TUI, writes, queries: () => queries, originalFlash, originalTitle, originalProgress };
}

function runtime(view: ReturnType<typeof terminal>) {
  let start!: Start, shutdown!: Shutdown, header: Component | undefined, footer: Component | undefined;
  let stale = false;
  const listeners = new Map<string, (data: unknown) => void>();
  const live = <T>(value: T): T => { if (stale) throw new Error("Session context is no longer active"); return value; };
  piInterface({
    on(name: string, handler: unknown) {
      if (name === "session_start") start = handler as Start;
      if (name === "session_shutdown") shutdown = handler as Shutdown;
    },
    events: { on: (name: string, handler: (data: unknown) => void) => { listeners.set(name, handler); return () => { listeners.delete(name); }; } }, getThinkingLevel: () => live("high"), getActiveTools: () => [], getAllTools: () => [],
  } as unknown as ExtensionAPI);
  const ctx = {
    mode: "tui", hasUI: true,
    get cwd() { return live("/work/project"); },
    get model() { return live({ id: "m", name: "Model One", provider: "p", api: "a" }); },
    get modelRegistry() { return live({ getProviderAuthStatus: () => ({ configured: true }), getProviderDisplayName: (id: string) => id }); },
    sessionManager: { getEntries: () => [], getBranch: () => [] },
    getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }), getSystemPrompt: () => "prompt",
    ui: {
      setHeader(create: (tui: TUI) => Component) { header?.dispose?.(); header = create(view.native); },
      setFooter(create: (tui: TUI, palette: typeof theme, data: object) => Component) { footer?.dispose?.(); footer = create(view.native, theme, {}); },
      notify() {},
    },
  } as unknown as ExtensionContext;
  return {
    start() { start({ type: "session_start", reason: "new" }, ctx); },
    shutdown(reason?: SessionShutdownEvent["reason"]) { shutdown({ type: "session_shutdown", reason } as SessionShutdownEvent); },
    invalidate() { stale = true; }, header: () => header!, footer: () => footer!,
    emit(name: string, data: unknown) { listeners.get(name)?.(data); },
    dispose() { header?.dispose?.(); footer?.dispose?.(); },
  };
}

test("the live footer updates on code-mode changes and releases its subscription on shutdown", async () => {
  const { CODE_MODE_CHANGED } = await import(new URL("../dist/lib/code-mode.js", import.meta.url).href) as typeof import("../lib/code-mode.js");
  const view = terminal(), host = runtime(view);
  host.start(); await settle();
  host.emit(CODE_MODE_CHANGED, { enabled: true });
  assert.match(host.footer().render(80).join(""), /38;2;177;185;249mcode mode/);
  host.emit(CODE_MODE_CHANGED, { enabled: false });
  assert.match(host.footer().render(80).join(""), /allow mode/);
  host.shutdown("quit");
  host.emit(CODE_MODE_CHANGED, { enabled: true });
  assert.doesNotMatch(host.footer().render(80).join(""), /code mode/);
  host.dispose();
});

test("new extension factories reuse terminal chrome across session replacements and restore the shell", async (t) => {
  const view = terminal(), listeners = process.listenerCount("exit");
  let current = runtime(view);
  t.after(() => { current.shutdown("quit"); current.dispose(); });
  current.start(); await settle();
  const painted = view.writes.length;
  for (const reason of ["new", "reload", "resume", "fork", "new", "reload"] as const) {
    current.shutdown(reason); current.invalidate(); current.dispose();
    current = runtime(view); current.start(); await settle();
    assert.equal(view.queries(), 1, "a fresh factory must not re-query the already mounted terminal");
    assert.equal(view.writes.length, painted, "replacement must not repaint terminal colors");
    assert.equal(process.listenerCount("exit"), listeners + 1, "only one terminal cleanup listener may remain");
  }
  current.shutdown("quit");
  assert.equal(view.tui.flash, view.originalFlash);
  assert.equal(view.tui.terminal.setTitle, view.originalTitle);
  assert.equal(view.tui.terminal.setProgress, view.originalProgress);
  assert.equal(view.writes.at(-1), "\x1b]10;#112233\x07\x1b]11;#445566\x07");
  assert.equal(process.listenerCount("exit"), listeners);
});

test("an outgoing runtime cannot release a newer runtime's terminal resources", async (t) => {
  const view = terminal(), old = runtime(view), fresh = runtime(view);
  t.after(() => { fresh.shutdown("quit"); old.shutdown("quit"); old.dispose(); fresh.dispose(); });
  old.start(); await settle(); old.shutdown("new");
  fresh.start(); await settle();
  const writes = view.writes.length;
  old.shutdown("quit");
  assert.notEqual(view.tui.flash, view.originalFlash);
  assert.equal(view.writes.length, writes);
  fresh.shutdown("quit"); assert.equal(view.tui.flash, view.originalFlash);
});

test("unknown shutdown reasons restore terminal resources and allow a later clean mount", async () => {
  const view = terminal(), host = runtime(view);
  host.start(); await settle(); host.shutdown();
  assert.equal(view.tui.flash, view.originalFlash);
  host.start(); await settle(); assert.equal(view.queries(), 2);
  host.shutdown("quit"); host.dispose();
});

test("a replaced session keeps its header and footer readable while its context is stale", async () => {
  const view = terminal(), host = runtime(view);
  host.start(); await settle();
  const header = host.header().render(80), footer = host.footer().render(80);
  assert.ok(header.some((line) => line.includes("Model One with high effort")));
  assert.ok(footer.join("").includes("context"));
  host.shutdown("new"); host.invalidate();
  assert.deepEqual(host.header().render(80), header);
  assert.deepEqual(host.footer().render(80), footer);
  host.shutdown("quit"); host.dispose();
});

test("terminal ownership is shared even when the chrome module is loaded twice", async () => {
  const view = terminal();
  const again = await import(new URL("../dist/ui/terminal-chrome.js?fresh-instance", import.meta.url).href) as typeof import("../ui/terminal-chrome.js");
  const old = acquireTerminalChrome(view.native); await settle();
  const fresh = again.acquireTerminalChrome(view.native); await settle();
  old.dispose(); assert.notEqual(view.tui.flash, view.originalFlash); assert.equal(view.queries(), 1);
  fresh.dispose(); assert.equal(view.tui.flash, view.originalFlash);
});

test("appearance changes repaint once after replacements and stop repainting after quit", async (t) => {
  t.after(() => setAppearance(DEFAULT_APPEARANCE));
  const view = terminal(), old = runtime(view), fresh = runtime(view);
  old.start(); await settle(); old.shutdown("new"); fresh.start(); await settle();
  const before = view.writes.length;
  setAppearance({ mode: "light", color: "green" }); await settle();
  assert.equal(view.writes.length, before + 1);
  fresh.shutdown("quit"); const restored = view.writes.length;
  setAppearance(DEFAULT_APPEARANCE); await settle(); assert.equal(view.writes.length, restored);
  old.dispose(); fresh.dispose();
});

test("a new escape-editor factory disposes the editor kept by the outgoing runtime", async () => {
  const native = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
    KeybindingsManager: new () => import("@earendil-works/pi-coding-agent").KeybindingsManager;
  };
  const view = terminal();
  let editor: { dispose(): void } | undefined;
  const ctx = { mode: "tui", model: undefined, isIdle: () => true, hasPendingMessages: () => false,
    ui: { setEditorComponent(create: Parameters<ExtensionUIContext["setEditorComponent"]>[0]) {
      assert.ok(create);
      editor = create(view.native, { borderColor: (text: string) => text, selectList: {} } as Parameters<NonNullable<typeof create>>[1], new native.KeybindingsManager()) as unknown as typeof editor;
    } },
  } as unknown as ExtensionContext;
  const load = () => {
    let start!: Start, shutdown!: Shutdown;
    escapeExit({ on(name: string, handler: unknown) {
      if (name === "session_start") start = handler as Start;
      if (name === "session_shutdown") shutdown = handler as Shutdown;
    }, getThinkingLevel: () => "medium", events: { emit() {} } } as unknown as ExtensionAPI);
    return { start: () => start({ type: "session_start", reason: "new" }, ctx), shutdown: (reason: SessionShutdownEvent["reason"]) => shutdown({ type: "session_shutdown", reason }) };
  };
  const old = load(); old.start();
  let disposed = 0; const first = editor!, dispose = first.dispose.bind(first);
  first.dispose = () => { disposed++; dispose(); };
  old.shutdown("new"); assert.equal(disposed, 0);
  const fresh = load(); fresh.start();
  assert.equal(disposed, 1); assert.notEqual(editor, first);
  fresh.shutdown("quit");
});
