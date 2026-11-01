import { createModelScreen } from "../ui/model-screen.js";
import type { NativeModelSelector } from "../ui/model-screen.js";
import { createHeader } from "../ui/chrome.js";
import { createUiTheme } from "../ui/theme.js";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Measure } from "../ui/types.js";

interface SelectorMount { component: NativeModelSelector; dispose?(): void }
interface ModelHost {
  showModelSelector(query?: string): void;
  showSelector(create: (done: () => void) => SelectorMount): void;
  createExtensionUIContext(): ExtensionUIContext;
  disposeActiveSelector(): void;
  activeSelectorToken?: object;
  activeSelectorDispose?: () => void;
  showError(message: string): void;
  session: { model?: { id: string }; thinkingLevel: string };
  sessionManager: { getCwd(): string };
  footerContainer: { render(width: number): string[] };
}
export interface ModelInterfaceApi { InteractiveMode: { prototype: ModelHost } }
const installed = new WeakSet<object>();

export function installModelInterface(api: ModelInterfaceApi, measure: Measure, version: string) {
  const host = api.InteractiveMode?.prototype;
  if (typeof host?.showModelSelector !== "function" || typeof host?.disposeActiveSelector !== "function") {
    throw new Error("Pi engine does not support the model-screen adapter.");
  }
  if (installed.has(host)) return;
  const showModels = host.showModelSelector;
  host.showModelSelector = function (query) {
    let mount: SelectorMount | undefined, finish: (() => void) | undefined, closed = false;
    const token = {};
    const close = () => {
      if (closed) return;
      closed = true;
      if (this.activeSelectorToken === token) {
        this.activeSelectorToken = undefined; this.activeSelectorDispose = undefined;
      }
      mount?.dispose?.(); finish?.();
    };
    const originalSelector = this.showSelector;
    try {
      this.showSelector = (create) => { mount = create(close); };
      showModels.call(this, query);
    } finally { this.showSelector = originalSelector; }
    if (!mount) throw new Error("Pi model selector no longer exposes its controller.");
    const native = mount;
    this.disposeActiveSelector();
    this.activeSelectorToken = token; this.activeSelectorDispose = close;
    void this.createExtensionUIContext().custom((tui, _theme, _keys, done) => {
      finish = () => done(undefined);
      const theme = createUiTheme();
      const header = createHeader({ mode: "regular" }, measure, {
        version, getModel: () => this.session.model, getThinkingLevel: () => this.session.thinkingLevel,
        getCwd: () => this.sessionManager.getCwd(),
      });
      return createModelScreen({ tui, theme, measure, done: close, selector: native.component,
        renderHeader: (width) => header.render(width), renderFooter: (width) => this.footerContainer.render(width),
        onDispose: () => { header.dispose(); close(); },
      });
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } })
      .catch((error) => { close(); this.showError(error instanceof Error ? error.message : String(error)); });
  };
  installed.add(host);
}
