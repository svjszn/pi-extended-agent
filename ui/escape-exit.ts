import { createUiTheme, faintInputRule } from "./theme.js";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CustomEditor, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { matchesKey as match, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { TreeComponent } from "./types.js";
import { visibleUpdateLabel, visibleUpdateVersion } from "../lib/update-status.js";
import { animatedEffort, effortGlow } from "./effort-style.js";

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
  effort?: { getLevel(): string; step?(direction: -1 | 1): void }, toggleMode?: () => void, now = Date.now) {
  const theme = createUiTheme();
  return class EscapeExitEditor extends BaseEditor {
    private statusRows = 0;
    private animation: ReturnType<typeof setInterval> | undefined;
    private disposed = false;
    dispose() {
      this.disposed = true;
      this.stopAnimation();
    }
    private stopAnimation() { clearInterval(this.animation); this.animation = undefined; }
    private animate(enabled: boolean) {
      if (!enabled || !this.focused) { this.stopAnimation(); return; }
      if (this.animation || this.disposed) return;
      this.animation = setInterval(() => {
        if (!this.focused || !animatedEffort(effort?.getLevel() ?? "") || visibleUpdateLabel()) { this.stopAnimation(); return; }
        this.tui.requestRender();
      }, 80);
      this.animation.unref?.();
    }
    private statusIndicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];
    setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]) {
      this.statusIndicator = indicator;
      super.setWorkingStatusIndicator(indicator);
    }
    protected renderTopBorder(width: number, hiddenLineCount: number) {
      // Keep the native overflow label; Working and updates sit above the border.
      super.setWorkingStatusIndicator(undefined);
      try { return super.renderTopBorder(width, hiddenLineCount); }
      finally { super.setWorkingStatusIndicator(this.statusIndicator); }
    }
    setPaddingX() {
      // Native padding keeps wrapping, IME and mouse coordinates in agreement.
      // The chevron occupies the inset, leaving text on the conversation grid.
      super.setPaddingX(2);
    }
    render(width: number) {
      const inset = inputInset(width);
      const padding = " ".repeat(inset);
      const inner = Math.max(1, width - inset * 2);
      const rawStatus = this.statusIndicator?.renderInBorder(inner) ?? "";
      const rightWidth = rawStatus ? Math.max(0, inner - 12) : inner;
      const update = visibleUpdateLabel(rightWidth);
      const level = effort?.getLevel() ?? "";
      const label = truncateToWidth(update ?? level, rightWidth, "");
      const statusWidth = Math.max(0, inner - (label ? visibleWidth(label) + 2 : 0));
      const status = statusWidth ? truncateToWidth(this.statusIndicator?.renderInBorder(statusWidth) ?? "", statusWidth, "") : "";
      this.statusRows = effort || status || label ? 1 : 0;
      this.animate(!update && !!label && animatedEffort(level));
      this.borderColor = (value) => faintInputRule(theme.fg("inputBorder", value));
      const contentPadding = Math.min(2, Math.max(0, Math.floor((width - 4) / 2)));
      super.setPaddingX(contentPadding);
      const nativeLines = super.render(width);
      if (contentPadding >= 2 && nativeLines[1]?.startsWith(" ".repeat(contentPadding))) {
        // Decorate the native padding only; the prefix is never part of input.
        const prefix = " ".repeat(contentPadding - 2) + "❯ ";
        nativeLines[1] = prefix + nativeLines[1].slice(contentPadding);
      }
      const lines = nativeLines.map((line) => theme.fg("primary", truncateToWidth(line, width, "")));
      if (this.statusRows) {
        const role = update || level === "low" ? "effortLow" : level === "medium" ? "effortMedium"
          : level === "high" ? "effortHigh" : level === "xhigh" ? "effortXhigh" : "primary";
        let right = !update && animatedEffort(level) ? effortGlow(level, label, now() / 1000) : theme.fg(role, label);
        const version = update ? visibleUpdateVersion() : undefined;
        const versionStart = version ? label.indexOf(version) : -1;
        if (version && versionStart >= 0) {
          right = theme.fg("effortLow", label.slice(0, versionStart)) + theme.fg("purple", version)
            + theme.fg("effortLow", label.slice(versionStart + version.length));
        }
        lines.unshift(padding + status + " ".repeat(Math.max(0, inner - visibleWidth(status) - visibleWidth(right))) + right + padding);
      }
      return lines;
    }
    handleMouse(event: TuiMouseEvent) {
      if (event.y < this.statusRows) return undefined;
      return super.handleMouse?.({ ...event, y: event.y - this.statusRows, height: Math.max(0, event.height - this.statusRows) });
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
