type Factory = unknown;
interface ChromeHost {
  resetExtensionUI(): void;
  setExtensionHeader(factory?: Factory): void;
  setExtensionFooter(factory?: Factory): void;
  setCustomEditorComponent(factory?: Factory): void;
}
export interface ChromeRuntimeApi { InteractiveMode: { prototype: ChromeHost } }

/** The slots this interface fills: the header, the footer and the input editor. */
const CHROME = ["setExtensionHeader", "setExtensionFooter", "setCustomEditorComponent"] as const;
type Chrome = (typeof CHROME)[number];

const natives = new WeakMap<ChromeHost, () => void>();

/**
 * Pi detaches every extension-provided component before it invalidates the
 * outgoing session, then mounts the next session's components after the
 * replacement runtime has loaded. In between, the engine's own header, startup
 * resource list, footer and editor are on screen for as long as loading takes,
 * so `/clear` and `/new` flash Pi's startup screen over this interface.
 *
 * Keep the three chrome slots mounted across that gap. Everything else
 * `resetExtensionUI` releases — dialogs, overlays, widgets, autocomplete and
 * terminal input listeners — is still released, and mounting a replacement
 * component still works, so the next session takes the slots over directly.
 */
export function keepSessionChrome(api: ChromeRuntimeApi) {
  const ui = api.InteractiveMode?.prototype;
  for (const method of [ui?.resetExtensionUI, ...CHROME.map((name) => ui?.[name])]) {
    if (typeof method !== "function") throw new Error("This Pi engine does not support the session-chrome adapter.");
  }
  if (natives.has(ui)) return;
  const reset = ui.resetExtensionUI;
  natives.set(ui, reset);
  ui.resetExtensionUI = function (this: ChromeHost) {
    const own = CHROME.map((name) => Object.getOwnPropertyDescriptor(this, name));
    for (const name of CHROME) {
      const release = this[name];
      Object.defineProperty(this, name, {
        configurable: true, writable: true,
        value(this: ChromeHost, factory?: Factory) { if (factory) return release.call(this, factory); },
      });
    }
    try { return reset.call(this); } finally {
      CHROME.forEach((name, index) => {
        const descriptor = own[index];
        if (descriptor) Object.defineProperty(this, name, descriptor);
        else Reflect.deleteProperty(this, name);
      });
    }
  };
}

/** The engine's own reset, whether or not the adapter has wrapped it yet. */
export function nativeSessionReset(api: ChromeRuntimeApi) {
  const ui = api.InteractiveMode?.prototype;
  return natives.get(ui) ?? ui?.resetExtensionUI;
}

/** The host members `resetExtensionUI` touches, without a terminal or a session. */
export function chromeProbeHost(api: ChromeRuntimeApi): ChromeHost & { released: string[] } {
  const noop = () => {};
  const host = Object.create(api.InteractiveMode.prototype) as ChromeHost & { released: string[] };
  const released: string[] = [];
  Object.assign(host, {
    released,
    extensionDialogs: [],
    ui: { hideOverlay: noop, requestRender: noop, setFocus: noop },
    clearExtensionTerminalInputListeners: noop,
    clearExtensionWidgets: noop,
    footerDataProvider: { clearExtensionStatuses: noop },
    footer: { invalidate: noop },
    autocompleteProviderWrappers: [],
    setupAutocompleteProvider: noop,
    defaultEditor: {},
    updateTerminalTitle: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
  });
  for (const name of CHROME) {
    Object.defineProperty(host, name, {
      configurable: true, writable: true,
      value: (factory?: Factory) => { released.push(`${name}:${factory ? "mount" : "release"}`); },
    });
  }
  return host;
}

/**
 * Probe the adapter against the candidate engine: the native reset must still
 * release the chrome through these three methods, and ours must keep it while
 * still accepting the next session's components.
 */
export function verifySessionChrome(api: ChromeRuntimeApi) {
  if (!natives.has(api.InteractiveMode.prototype)) throw new Error("The session-chrome adapter is not installed.");
  const native = nativeSessionReset(api);
  const releases = CHROME.map((name) => `${name}:release`);
  const bare = chromeProbeHost(api);
  native.call(bare);
  for (const release of releases) {
    if (!bare.released.includes(release)) throw new Error(`Pi no longer releases the interface chrome through ${release.split(":")[0]}.`);
  }
  const host = chromeProbeHost(api);
  host.resetExtensionUI();
  if (host.released.length) throw new Error("Pi still drops the interface chrome when a session is replaced.");
  host.setExtensionHeader(() => ({}));
  if (host.released.at(-1) !== "setExtensionHeader:mount") throw new Error("The session-chrome adapter blocks the next session's header.");
}
