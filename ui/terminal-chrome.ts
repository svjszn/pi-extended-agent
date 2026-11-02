import type { TUI } from "@earendil-works/pi-tui";
import { pinTerminalTitle } from "./chrome.js";
import { mountAppearanceTerminal } from "./appearance.js";
import { captureFlashes } from "../bin/flash-interface.js";
import type { FlashHost } from "../bin/flash-interface.js";

interface MountedChrome { owner: symbol; refresh(): void; dispose(): void }
const key = Symbol.for("pi-extended-agent.terminal-chrome");
const globals = globalThis as typeof globalThis & { [key]?: WeakMap<object, MountedChrome> };
// Pi invokes new extension factories on replacement, including across jiti
// module instances. The terminal owns these resources; no session context does.
const mounted = globals[key] ??= new WeakMap();

export function acquireTerminalChrome(tui: TUI) {
  let current = mounted.get(tui);
  if (!current) {
    const appearance = mountAppearanceTerminal(tui);
    const title = pinTerminalTitle(tui.terminal);
    const flashes = captureFlashes(tui as FlashHost, () => tui.requestRender());
    current = { owner: Symbol(), refresh: title.refresh,
      dispose() { appearance.dispose(); title(); flashes?.(); },
    };
    mounted.set(tui, current);
  }
  const resource = current, owner = Symbol();
  resource.owner = owner;
  return {
    refresh() { if (resource.owner === owner) resource.refresh(); },
    dispose() {
      // An outgoing runtime cannot tear down a newer runtime's terminal lease.
      if (resource.owner !== owner || mounted.get(tui) !== resource) return;
      mounted.delete(tui); resource.dispose();
    },
  };
}
