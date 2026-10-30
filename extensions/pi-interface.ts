import { truncateToWidth } from "@earendil-works/pi-tui";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { createFooter, createHeader, pinTerminalTitle } from "../ui/chrome.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { readContextSummary } from "../lib/context.js";
import type { ContextSummary } from "../lib/context.js";
import { startupAuthNotice } from "../lib/startup.js";
import { PERMISSIONS_CHANGED, isPermissionMode, readPermissionMode } from "../lib/permissions.js";
import type { PermissionMode } from "../lib/permissions.js";
import { PLAN_CHANGED, PLAN_ENTRY, isPlanning } from "../lib/plan.js";
import type { Plan } from "../lib/plan.js";

export default function piInterface(pi: ExtensionAPI) {
  let activeTui: TUI | undefined, restoreTitle: (() => void) | undefined;
  let context: ContextSummary | undefined;
  let permissionMode: PermissionMode = "full", stopPermissions: (() => void) | undefined;
  let planning = false, stopPlan: (() => void) | undefined;
  const listenPermissions = () => {
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
    context = readContextSummary(ctx, pi);
    activeTui?.requestRender();
  };
  const notifyAuth = (ctx: ExtensionContext) => {
    const notice = startupAuthNotice(ctx);
    if (notice) ctx.ui.notify(notice, "warning");
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    listenPermissions();
    permissionMode = readPermissionMode(ctx.sessionManager.getEntries());
    const marker = ctx.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === PLAN_ENTRY).at(-1);
    planning = isPlanning((marker as { data?: Plan } | undefined)?.data);
    refreshContext(_event, ctx);
    const measure = { truncateToWidth };
    ctx.ui.setHeader((tui, theme) => {
      if (activeTui !== tui) {
        restoreTitle?.();
        restoreTitle = pinTerminalTitle(tui.terminal);
      }
      activeTui = tui;
      return createHeader(tui, theme, measure, {
        version: VERSION,
        getModel: () => ctx.model,
        getThinkingLevel: () => pi.getThinkingLevel(),
        getCwd: () => ctx.cwd,
        getAuthNotice: () => startupAuthNotice(ctx),
      });
    });
    ctx.ui.setFooter((tui, theme, footerData) => createFooter(ctx, tui, theme, footerData, measure, () => context, () => permissionMode, () => planning));
    notifyAuth(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    refreshContext(event, ctx);
    if (ctx.mode === "tui") notifyAuth(ctx);
  });
  pi.on("message_end", refreshContext);
  pi.on("turn_end", refreshContext);
  pi.on("agent_end", refreshContext);
  pi.on("session_compact", refreshContext);
  pi.on("session_tree", refreshContext);
  pi.on("thinking_level_select", () => activeTui?.requestRender());
  pi.on("session_shutdown", () => {
    restoreTitle?.(); restoreTitle = undefined; activeTui = undefined; context = undefined;
    stopPermissions?.(); stopPermissions = undefined; permissionMode = "full";
    stopPlan?.(); stopPlan = undefined; planning = false;
  });
}
