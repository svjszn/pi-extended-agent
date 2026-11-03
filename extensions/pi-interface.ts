import { truncateToWidth } from "@earendil-works/pi-tui";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { createFooter, createHeader } from "../ui/chrome.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { readContextSummary } from "../lib/context.js";
import type { ContextSummary } from "../lib/context.js";
import { hasModel, startupAuthNotice } from "../lib/startup.js";
import { PERMISSIONS_CHANGED, isPermissionMode, readPermissionMode } from "../lib/permissions.js";
import type { PermissionMode } from "../lib/permissions.js";
import { PLAN_CHANGED, PLAN_ENTRY, isPlanning } from "../lib/plan.js";
import type { Plan } from "../lib/plan.js";
import { acquireTerminalChrome } from "../ui/terminal-chrome.js";
import { isSessionReplaced, lastKnown } from "../lib/session-replacement.js";
import { CODE_MODE_CHANGED, readCodeMode } from "../lib/code-mode.js";

export default function piInterface(pi: ExtensionAPI) {
  let activeTui: TUI | undefined;
  let terminalChrome: ReturnType<typeof acquireTerminalChrome> | undefined;
  let context: ContextSummary | undefined;
  let permissionMode: PermissionMode = "allow", stopPermissions: (() => void) | undefined;
  let planning = false, stopPlan: (() => void) | undefined;
  let codeMode = false, stopCodeMode: (() => void) | undefined;
  const listenPermissions = () => {
    stopCodeMode ??= pi.events?.on(CODE_MODE_CHANGED, (data) => {
      codeMode = (data as { enabled?: boolean })?.enabled === true; activeTui?.requestRender();
    });
    stopPlan ??= pi.events?.on(PLAN_CHANGED, (data) => {
      planning = (data as { planning?: boolean })?.planning === true; activeTui?.requestRender();
    });
    stopPermissions ??= pi.events?.on(PERMISSIONS_CHANGED, (data) => {
      const mode = (data as { mode?: unknown } | undefined)?.mode;
      if (isPermissionMode(mode)) { permissionMode = mode; activeTui?.requestRender(); }
    });
  };
  listenPermissions();
  const refreshContext = (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    // Without a model there is no window to report; the placeholder one is zero.
    context = hasModel(ctx.model) ? readContextSummary(ctx, pi) : undefined;
    activeTui?.requestRender();
  };
  // The header already carries the sign-in notice. Warn only when a selected
  // model cannot be used, never about having no model at all.
  const notifyAuth = (ctx: ExtensionContext) => {
    if (!hasModel(ctx.model)) return;
    const notice = startupAuthNotice(ctx);
    if (notice) ctx.ui.notify(notice, "warning");
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    listenPermissions();
    permissionMode = readPermissionMode(ctx.sessionManager.getEntries());
    const marker = ctx.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === PLAN_ENTRY).at(-1);
    planning = isPlanning((marker as { data?: Plan } | undefined)?.data);
    codeMode = readCodeMode(ctx.sessionManager.getEntries()).enabled;
    refreshContext(_event, ctx);
    const measure = { truncateToWidth };
    // Pi keeps this header on screen while the next session loads, and the
    // context that created it throws on every read once it is replaced. Report
    // what this session last said until the next header takes the slot.
    const info = {
      version: VERSION,
      getModel: lastKnown<ExtensionContext["model"] | undefined>(() => ctx.model, undefined),
      getThinkingLevel: lastKnown(() => pi.getThinkingLevel(), ""),
      getCwd: lastKnown(() => ctx.cwd, process.cwd()),
      getAuthNotice: lastKnown<string | undefined>(() => startupAuthNotice(ctx), undefined),
    };
    ctx.ui.setHeader((tui) => {
      if (activeTui !== tui) {
        terminalChrome?.dispose();
        terminalChrome = acquireTerminalChrome(tui);
      }
      activeTui = tui;
      return createHeader(tui, measure, info);
    });
    ctx.ui.setFooter((tui, theme, footerData) => createFooter(ctx, tui, theme, footerData, measure, () => context, () => permissionMode, () => planning, () => codeMode));
    notifyAuth(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    refreshContext(event, ctx);
    if (ctx.mode === "tui") notifyAuth(ctx);
  });
  // Shell children can change the shared Windows console title without calling
  // our terminal object. Reassert it once they finish, not on every render.
  pi.on("tool_execution_end", () => terminalChrome?.refresh());
  pi.on("agent_settled", () => terminalChrome?.refresh());
  pi.on("message_end", refreshContext);
  pi.on("turn_end", refreshContext);
  pi.on("agent_end", refreshContext);
  pi.on("session_compact", refreshContext);
  pi.on("session_tree", refreshContext);
  pi.on("thinking_level_select", () => activeTui?.requestRender());
  pi.on("session_shutdown", (event) => {
    // The terminal colors, the pinned title, the flash capture and the mounted
    // header and footer belong to the terminal, not to one session. Releasing
    // them on every replacement re-queries the terminal, repaints the whole
    // screen and shows Pi's own startup chrome while the next session loads, so
    // keep them, and what they report, while the same terminal continues.
    if (!isSessionReplaced(event)) {
      terminalChrome?.dispose(); terminalChrome = undefined;
      activeTui = undefined;
      context = undefined; permissionMode = "allow"; planning = false; codeMode = false;
    }
    stopPermissions?.(); stopPermissions = undefined;
    stopPlan?.(); stopPlan = undefined;
    stopCodeMode?.(); stopCodeMode = undefined;
  });
}
