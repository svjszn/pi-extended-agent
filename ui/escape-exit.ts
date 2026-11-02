import { createUiTheme, faintInputRule } from "./theme.js";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CustomEditor, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { matchesKey as match, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { TreeComponent } from "./types.js";
import { visibleUpdateLabel, visibleUpdateVersion } from "../lib/update-status.js";
import { flashExpiry, visibleFlash } from "../lib/flash-status.js";
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
      clearTimeout(this.flashTimer);
      this.flashTimer = undefined;
    }
    private stopAnimation() { clearInterval(this.animation); this.animation = undefined; }
    private animate(enabled: boolean) {
      if (!enabled || !this.focused) { this.stopAnimation(); return; }
      if (this.animation || this.disposed) return;
      this.animation = setInterval(() => {
        if (!this.focused || ctx.isIdle() || !animatedEffort(effort?.getLevel() ?? "") || visibleUpdateLabel()) { this.stopAnimation(); return; }
        this.tui.requestRender();
      }, 80);
      this.animation.unref?.();
    }
    private flashTimer: ReturnType<typeof setTimeout> | undefined;
    private flashUntil = 0;
    /** Repaint once when a transient notice runs out, without a render loop. */
    private scheduleFlashExpiry() {
      const until = flashExpiry();
      if (until === this.flashUntil) return;
      this.flashUntil = until;
      clearTimeout(this.flashTimer);
      this.flashTimer = undefined;
      const delay = until - now();
      if (!until || delay <= 0 || this.disposed) return;
      this.flashTimer = setTimeout(() => {
        this.flashTimer = undefined;
        if (!this.disposed) this.tui.requestRender();
      }, delay);
      this.flashTimer.unref?.();
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
      // A transient notice takes the corner while it lasts: it reports something
      // the user just did, and the effort level is still one keystroke away.
      const flash = visibleFlash(rightWidth);
      const update = flash ? undefined : visibleUpdateLabel(rightWidth);
      const level = effort?.getLevel() ?? "";
      const label = truncateToWidth(flash ?? update ?? level, rightWidth, "");
      const statusWidth = Math.max(0, inner - (label ? visibleWidth(label) + 2 : 0));
      const status = statusWidth ? truncateToWidth(this.statusIndicator?.renderInBorder(statusWidth) ?? "", statusWidth, "") : "";
      // Reserve the row only when it carries something: an unauthenticated
      // session has no effort to show and must not leave a blank line.
      this.statusRows = status || label ? 1 : 0;
      this.scheduleFlashExpiry();
      const animateLabel = !this.disposed && this.focused && !flash && !update && !!label && animatedEffort(level) && !ctx.isIdle();
      this.animate(animateLabel);
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
        const role = flash ? "muted" : update || level === "low" ? "effortLow" : level === "medium" ? "effortMedium"
          : level === "high" ? "effortHigh" : level === "xhigh" ? "effortXhigh" : "primary";
        // A paused shimmer is not the base color: use the exact high/xhigh
        // palette for the whole idle label, retaining a static rainbow for max.
        let right = !flash && !update && (animateLabel || level === "max")
          ? effortGlow(level, label, animateLabel ? now() / 1000 : 0) : theme.fg(role, label);
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
