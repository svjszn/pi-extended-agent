import { createAuthSelectorScreen, createAuthDialogScreen } from "../ui/auth-screen.js";
import type { AuthSelector, AuthDialog } from "../ui/auth-screen.js";
import { createHeader } from "../ui/chrome.js";
import { createUiTheme } from "../ui/theme.js";
import type { Measure, TreeComponent } from "../ui/types.js";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

interface Mount { component: AuthSelector; focus?: unknown; dispose?(): void }
interface AuthHost {
  showSelector(create: (done: () => void) => Mount): void;
  disposeActiveSelector(): void;
  showLoginDialog(providerId: string, providerName: string, onBack?: () => void): Promise<void>;
  showApiKeyLoginDialog(providerId: string, providerName: string, onBack?: () => void): Promise<void>;
  showAmbientAuthDialog(option: { name: string }, onBack?: () => void): void;
  createExtensionUIContext(): ExtensionUIContext;
  showError(text: string): void;
  ui: { mode: string; requestRender(): void };
  editorContainer: { children: TreeComponent[]; addChild(child: TreeComponent): void };
  editor: TreeComponent;
  session: { model?: { id: string }; thinkingLevel: string };
  sessionManager: { getCwd(): string };
  footerContainer: { render(width: number): string[] };
}
export interface AuthInterfaceApi { InteractiveMode: { prototype: AuthHost } }
const installed = new WeakSet<object>();

export function installAuthInterface(api: AuthInterfaceApi, measure: Measure, version: string) {
  const host = api.InteractiveMode?.prototype;
  if ([host?.showSelector, host?.disposeActiveSelector, host?.showLoginDialog, host?.showApiKeyLoginDialog,
    host?.showAmbientAuthDialog, host?.createExtensionUIContext].some((method) => typeof method !== "function")) {
    throw new Error("Pi engine does not support the auth-screen adapter.");
  }
  if (installed.has(host)) return;
  const headerFor = (owner: AuthHost) => {
    const theme = createUiTheme();
    const header = createHeader({ mode: "regular" }, measure, {
      version, getModel: () => owner.session.model, getThinkingLevel: () => owner.session.thinkingLevel,
      getCwd: () => owner.sessionManager.getCwd(),
    });
    return { theme, header };
  };
  const showSelector = host.showSelector;
  host.showSelector = function (create) {
    let mount: Mount | undefined, finish: (() => void) | undefined, closed = false, styled = false;
    const close = () => { if (closed) return; closed = true; finish?.(); };
    showSelector.call(this, (done) => {
      mount = create(() => { done(); close(); });
      const component = mount.component;
      styled = Array.isArray(component.filteredProviders) ||
        (Array.isArray(component.options) && component.baseTitle?.startsWith("Select authentication method") === true);
      if (!styled) return mount;
      return { ...mount, dispose: () => { mount?.dispose?.(); close(); } };
    });
    if (!styled || !mount) return;
    const native = mount.component;
    void this.createExtensionUIContext().custom((tui, _theme, _keys, done) => {
      finish = () => done(undefined);
      const { theme, header } = headerFor(this);
      return createAuthSelectorScreen({ selector: native, tui, theme, measure, done: () => this.disposeActiveSelector(),
        renderHeader: (width) => header.render(width), renderFooter: (width) => this.footerContainer.render(width),
        onDispose: () => { header.dispose(); if (!closed) this.disposeActiveSelector(); },
      });
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } })
      .catch((error) => { this.disposeActiveSelector(); this.showError(error instanceof Error ? error.message : String(error)); });
  };

  const showDialog = (owner: AuthHost, dialog: AuthDialog, name: string, completed?: Promise<void>) => {
    let finish: (() => void) | undefined, closed = false;
    const close = () => { if (closed) return; closed = true; finish?.(); };
    const current = () => owner.editorContainer.children.at(-1);
    const cancel = () => {
      const component = current();
      if (component !== dialog && component !== owner.editor) (component as AuthDialog | undefined)?.handleInput?.("\x1b");
      if (!dialog.signal.aborted) dialog.handleInput("\x1b");
    };
    void owner.createExtensionUIContext().custom((tui, _theme, _keys, done) => {
      finish = () => done(undefined);
      const { theme, header } = headerFor(owner);
      return createAuthDialogScreen({ dialog, providerName: name, current, tui, theme, measure, done: close,
        renderHeader: (width) => header.render(width), renderFooter: (width) => owner.footerContainer.render(width),
        onDispose: () => { header.dispose(); if (!closed) cancel(); close(); },
      });
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } })
      .catch((error) => { cancel(); owner.showError(error instanceof Error ? error.message : String(error)); });
    void completed?.then(close, close);
  };
  for (const method of ["showLoginDialog", "showApiKeyLoginDialog"] as const) {
    const native = host[method];
    host[method] = function (providerId, providerName, onBack) {
      // A provider may synchronously request a method choice, replacing the dialog
      // before the async native method returns. Capture it at the mount boundary.
      const container = this.editorContainer;
      const addChild = container.addChild;
      let dialog: AuthDialog | undefined;
      try {
        container.addChild = function (child) {
          const candidate = child as AuthDialog;
          if (candidate.contentContainer && candidate.input && candidate.signal) dialog = candidate;
          return addChild.call(this, child);
        };
        const pending = native.call(this, providerId, providerName, onBack);
        if (dialog) showDialog(this, dialog, providerName, pending);
        return pending;
      } finally { container.addChild = addChild; }
    };
  }
  const ambient = host.showAmbientAuthDialog;
  host.showAmbientAuthDialog = function (option, onBack) {
    ambient.call(this, option, onBack);
    const dialog = this.editorContainer.children.at(-1) as AuthDialog | undefined;
    if (dialog?.contentContainer && dialog.input) showDialog(this, dialog, option.name);
  };
  installed.add(host);
}
