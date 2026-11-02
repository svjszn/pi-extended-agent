import { createSessionScreen } from "../ui/session-screen.js";
import type { NativeSessionSelector } from "../ui/session-screen.js";
import { createHeader } from "../ui/chrome.js";
import { createUiTheme } from "../ui/theme.js";
import { AppearanceStore, setAppearance } from "../lib/appearance.js";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Measure } from "../ui/types.js";

interface Selector extends NativeSessionSelector {
  render(width: number): string[];
  requestRender(): void;
  cancelLoads(): void;
}
interface Mount { component: Selector; dispose?(): void }
interface SessionHost {
  shutdown(options?: { fromSignal?: boolean }): Promise<void>;
  showSessionSelector(): void;
  showSelector(create: (done: () => void) => Mount): void;
  disposeActiveSelector(): void;
  activeSelectorToken?: object;
  activeSelectorDispose?: () => void;
  createExtensionUIContext(): ExtensionUIContext;
  showError(message: string): void;
  session: { model?: { id: string }; thinkingLevel: string };
  sessionManager: { getCwd(): string };
}
export interface SessionInterfaceApi {
  SessionSelectorComponent: { prototype: Selector };
  InteractiveMode: { prototype: SessionHost };
  getAgentDir(): string;
}
const installed = new WeakSet<object>();
const dispose = (selector: Selector) => { selector.cancelLoads(); selector.header.setStatusMessage(null); };

/** Keep the session ID so either resume alias can reopen this exact chat. */
export function rewriteResumeHint(text: string): string {
  const ansi = "(?:\\x1b\\[[0-?]*[ -/]*[@-~])*";
  const match = text.match(new RegExp(`^(${ansi}To resume this session:${ansi}[ \\t]+)([^\\r\\n]+) --session ([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\\r?\\n$`));
  return match ? `${match[1]}${match[2]} --resume ${match[3]} (or ${match[2]} -r ${match[3]})\n` : text;
}

/** Style the same native selector used by pi -r/--resume and the live /resume command. */
export function installSessionInterface(api: SessionInterfaceApi, measure: Measure, version: string) {
  const selectorType = api.SessionSelectorComponent?.prototype, host = api.InteractiveMode?.prototype;
  if (typeof selectorType?.getSessionList !== "function" || typeof selectorType.cancelLoads !== "function"
    || typeof host?.showSessionSelector !== "function" || typeof host.disposeActiveSelector !== "function" || typeof host.shutdown !== "function") {
    throw new Error("Pi engine does not support the session-screen adapter.");
  }
  if (installed.has(selectorType)) return;
  const shutdown = host.shutdown;
  host.shutdown = async function (options) {
    // Keep Pi's drain, terminal cleanup, session disposal, signal handling and
    // exit intact. Rewrite only its complete resume-hint line during shutdown.
    const write = process.stdout.write;
    const replacement: typeof write = function (this: typeof process.stdout, chunk: string | Uint8Array, ...args: unknown[]) {
      return Reflect.apply(write, this, [typeof chunk === "string" ? rewriteResumeHint(chunk) : chunk, ...args]);
    };
    process.stdout.write = replacement;
    try { return await shutdown.call(this, options); }
    finally { if (process.stdout.write === replacement) process.stdout.write = write; }
  };
  const screens = new WeakMap<Selector, ReturnType<typeof createSessionScreen>>();
  // The native startup picker mounts this component directly and focuses its
  // list. Keep that input controller, loaders and selection callback intact.
  selectorType.render = function (width) {
    let screen = screens.get(this);
    if (!screen) {
      try { setAppearance(new AppearanceStore(api.getAgentDir()).read()); }
      catch { /* Appearance errors are reported by the session extension after resume. */ }
      const header = createHeader({ mode: "regular" }, measure, { version, getModel: () => undefined, getThinkingLevel: () => "" });
      const tui = { terminal: { get rows() { return process.stdout.rows || 24; } }, requestRender: () => this.requestRender() };
      screen = createSessionScreen({ selector: this, tui, theme: createUiTheme(), measure, done() {},
        renderHeader: (columns) => header.render(columns), onDispose: () => { header.dispose(); dispose(this); } });
      screens.set(this, screen);
      for (const action of ["onSelect", "onCancel", "onExit"] as const) {
        const list = this.getSessionList(), original = list[action];
        list[action] = (path?: string) => { screen!.dispose(); original?.(path!); };
      }
    }
    screen.focused = this.getSessionList().focused;
    return screen.render(width);
  };
  const nativeShow = host.showSessionSelector;
  host.showSessionSelector = function () {
    let mount: Mount | undefined, finish: (() => void) | undefined, closed = false;
    const token = {};
    const close = () => {
      if (closed) return;
      closed = true;
      if (this.activeSelectorToken === token) { this.activeSelectorToken = undefined; this.activeSelectorDispose = undefined; }
      if (mount) { dispose(mount.component); mount.dispose?.(); }
      finish?.();
    };
    const show = this.showSelector;
    try { this.showSelector = (create) => { mount = create(close); }; nativeShow.call(this); }
    finally { this.showSelector = show; }
    if (!mount) throw new Error("Pi session selector no longer exposes its controller.");
    const native = mount;
    this.disposeActiveSelector(); this.activeSelectorToken = token; this.activeSelectorDispose = close;
    void this.createExtensionUIContext().custom((tui, _theme, _keys, done) => {
      finish = () => done(undefined);
      const header = createHeader({ mode: "regular" }, measure, { version,
        getModel: () => this.session.model, getThinkingLevel: () => this.session.thinkingLevel, getCwd: () => this.sessionManager.getCwd() });
      return createSessionScreen({ selector: native.component, tui, theme: createUiTheme(), measure, done: close,
        renderHeader: (width) => header.render(width), onDispose: () => { header.dispose(); close(); } });
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } })
      .catch((error) => { close(); this.showError(error instanceof Error ? error.message : String(error)); });
  };
  installed.add(selectorType);
}
