import { createUiTheme } from "./theme.js";
import type { CustomEditor, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { matchesKey as match, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { TreeComponent } from "./types.js";

const inputInset = (width: number) => Math.min(2, Math.floor(Math.max(0, width - 1) / 2));

function hasRunningShell(components: TreeComponent[]): boolean {
  // Pi 0.85.1 does not include ! / !! shell jobs in ctx.isIdle(). Its shell
  // transcript components retain a running status until completion or abort.
  for (const component of components) {
    if ("getCommand" in component && typeof component.getCommand === "function" && "status" in component && component.status === "running") return true;
    if (component.children && hasRunningShell(component.children)) return true;
  }
  return false;
}

export function createEscapeExitEditor(BaseEditor: typeof CustomEditor, matchesKey: typeof match, ctx: Pick<ExtensionContext, "isIdle" | "hasPendingMessages">,
  effort?: { getLevel(): string; step?(direction: -1 | 1): void }, toggleMode?: () => void) {
  const theme = createUiTheme();
  return class EscapeExitEditor extends BaseEditor {
    private effortRows = 0;
    setPaddingX() {
      // The inset surrounds the whole editor, including its horizontal rules.
      // Keep native content padding at zero so wrapping and cursor math agree.
      super.setPaddingX(0);
    }
    render(width: number) {
      const inset = inputInset(width);
      const padding = " ".repeat(inset);
      const inner = Math.max(1, width - inset * 2);
      const level = effort?.getLevel();
      const showEffort = Boolean(level && /^[a-z][a-z0-9_-]*$/i.test(level) && level.length <= inner);
      this.effortRows = showEffort ? 1 : 0;
      this.borderColor = (value) => theme.fg("border", value);
      const lines = super.render(inner).map((line) =>
        padding + theme.fg("primary", line) + padding,
      );
      if (showEffort && level) lines.unshift(padding + " ".repeat(inner - level.length) + theme.fg("muted", level) + padding);
      return lines;
    }
    handleMouse(event: TuiMouseEvent) {
      const inset = inputInset(event.width);
      if (event.y < this.effortRows) return undefined;
      return super.handleMouse?.({ ...event, x: event.x - inset, y: event.y - this.effortRows,
        width: Math.max(1, event.width - inset * 2), height: Math.max(0, event.height - this.effortRows) });
    }
    handleInput(data: string) {
      if (effort?.step && (matchesKey(data, "shift+left") || matchesKey(data, "shift+right"))) {
        effort.step(matchesKey(data, "shift+left") ? -1 : 1);
        this.tui.requestRender();
        return;
      }
      if (toggleMode && matchesKey(data, "shift+tab")) {
        toggleMode();
        return;
      }
      if (
        matchesKey(data, "escape") &&
        this.onCtrlD &&
        this.getText().length === 0 &&
        !this.isShowingAutocomplete() &&
        ctx.isIdle() &&
        !ctx.hasPendingMessages() &&
        !hasRunningShell(this.tui.children)
      ) {
        // Reuse Pi's Ctrl+D handler so session and terminal cleanup stay native.
        this.onCtrlD();
        return;
      }
      super.handleInput(data);
    }
  };
}
