import { createCommandPanel } from "./command-panel.js";
import type { PanelOptions, PanelControls } from "./command-panel.js";
import type { TreeComponent } from "./types.js";

interface Provider {
  id: string; name: string; authType: string; subscription?: boolean;
  status?: { type: string; source?: string };
}
export interface AuthSelector {
  mode?: "login" | "logout";
  options?: string[];
  allProviders?: Provider[];
  filteredProviders?: Provider[];
  selectedIndex: number;
  searchInput?: { focused: boolean; render(width: number): string[] };
  handleInput(data: string): void;
  focused?: boolean;
  baseTitle?: string;
}
export interface AuthDialog extends TreeComponent {
  contentContainer: { children: TreeComponent[] };
  signal: AbortSignal;
  input: TreeComponent & { focused: boolean; getValue(): string };
  handleInput(data: string): void;
  focused: boolean;
}
type ScreenOptions = Pick<PanelOptions<boolean>, "tui" | "theme" | "measure" | "done" | "renderHeader" | "renderFooter" | "onDispose">;
// Keep OSC 8 links from the native OAuth flow, but replace Pi's foreground colors with ours.
const neutral = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const clean = (text: string) => neutral(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");

export function createAuthSelectorScreen({ selector, ...options }: ScreenOptions & { selector: AuthSelector }) {
  const { theme, measure, tui } = options;
  if (!Array.isArray(selector.options) && !Array.isArray(selector.filteredProviders)) throw new Error("Pi auth selection is incompatible.");
  let controls: PanelControls | undefined, lastSelection = "";
  const isProvider = Array.isArray(selector.filteredProviders);
  const rows = (width: number) => {
    const lines = [theme.fg("muted", selector.mode === "logout" ? "Choose a stored credential to remove." :
      isProvider ? "Choose a provider." : "Choose a sign-in method."), ""];
    const providers = selector.filteredProviders ?? [];
    const entries = isProvider ? providers.map((provider) => {
      const type = provider.authType === "api_key" ? "API key" : provider.subscription === false ? "account" : "subscription";
      const status = provider.status ? provider.status.type === provider.authType ? "configured" : "other method configured" : "not configured";
      return `${clean(provider.name)} · ${type} · ${status}`;
    }) : selector.options ?? [];
    let selectedRow = lines.length;
    for (const [index, text] of entries.entries()) {
      if (index === selector.selectedIndex) selectedRow = lines.length;
      lines.push(index === selector.selectedIndex ? theme.fg("primary", theme.bold(`› ${clean(text)}`)) : theme.fg("muted", `  ${clean(text)}`));
    }
    if (!entries.length) lines.push(theme.fg("muted", "No matching providers."));
    lines.push("", theme.fg("dim", "↑↓ choose · enter select · esc cancel"));
    const selection = `${width}:${selector.selectedIndex}:${entries.length}`;
    if (selection !== lastSelection) { controls?.reveal(selectedRow); lastSelection = selection; }
    return lines;
  };
  return createCommandPanel({ ...options, title: selector.mode === "logout" ? "Logout" : "Login", load: () => true,
    renderBody: (_data, width) => rows(width),
    renderInput(width, focused) {
      if (!selector.searchInput) return theme.fg("muted", "↑↓ select · enter continue · esc cancel");
      selector.focused = focused;
      return theme.fg("text", neutral(selector.searchInput.render(Math.max(1, width))[0] ?? ""));
    },
    onInput(data, panel) {
      controls = panel;
      selector.handleInput(data);
      tui.requestRender();
      return true;
    },
  });
}

/** Render the native login controller in the shared frame; it still owns OAuth, input, cancellation, and URL copying. */
export function createAuthDialogScreen({ dialog, providerName, current, ...options }: ScreenOptions & {
  dialog: AuthDialog; providerName: string; current(): TreeComponent | undefined;
}) {
  const { theme, measure, tui } = options;
  const rows = (width: number) => {
    const component = current();
    if (component !== dialog) {
      const choice = component as unknown as AuthSelector | undefined;
      if (Array.isArray(choice?.options)) return [theme.fg("muted", "Choose an option."), "", ...choice.options.map((text, index) =>
        index === choice.selectedIndex ? theme.fg("primary", theme.bold(`› ${clean(text)}`)) : theme.fg("muted", `  ${clean(text)}`))];
      return [theme.fg("muted", "Finishing sign-in…")];
    }
    const lines: string[] = [];
    for (const child of dialog.contentContainer.children) {
      if (child === dialog.input) continue;
      const rendered = child.render(width).map(neutral);
      // Pi replaces a submitted input with a Text containing its value. Never echo an API key or authorization code.
      if (child.constructor.name === "Text" && rendered.some((line) => line.trimStart().startsWith("> "))) continue;
      lines.push(...rendered.map((line) => theme.fg("text", line)));
    }
    return lines.length ? lines : [theme.fg("muted", "Starting sign-in…")];
  };
  return createCommandPanel({ ...options, title: `Login · ${clean(providerName)}`, load: () => true,
    renderBody: (_data, width) => rows(width),
    renderInput(width, focused) {
      const component = current();
      if (component !== dialog) return theme.fg("muted", "↑↓ choose · enter select · esc cancel");
      dialog.focused = focused;
      if (!dialog.contentContainer.children.includes(dialog.input)) return theme.fg("muted", "esc cancel · ctrl+x copy sign-in URL");
      dialog.input.focused = focused;
      // OAuth callback URLs, codes and API keys must not be echoed in our view.
      const masked = "•".repeat(Math.min(120, Array.from(dialog.input.getValue()).length));
      return theme.fg("text", `${masked}${focused ? measure.CURSOR_MARKER || "" : ""}`);
    },
    onInput(data, panel) {
      const component = current();
      if (component && typeof (component as AuthDialog).handleInput === "function") (component as AuthDialog).handleInput(data);
      if (dialog.signal.aborted || current() === undefined) panel.close();
      tui.requestRender();
      return true;
    },
  });
}
