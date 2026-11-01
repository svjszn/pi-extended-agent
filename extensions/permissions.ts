import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { PERMISSION_MODES, PERMISSION_LABELS, PERMISSION_DESCRIPTIONS, PERMISSIONS_ENTRY, PERMISSIONS_CHANGED,
  isPermissionMode, readPermissionMode, permissionDecision, permissionRequest } from "../lib/permissions.js";
import type { PermissionMode } from "../lib/permissions.js";
import { isWorkspaceBookkeeping } from "../lib/workspace-tools.js";
import { PLAN_ENTRY, isPlanning, canPlanRead } from "../lib/plan.js";
import type { Plan } from "../lib/plan.js";

export default function permissions(pi: ExtensionAPI) {
  let mode: PermissionMode = "full";
  let lifetime = new AbortController();
  let changes = new AbortController();
  let queue = Promise.resolve();
  pi.on("session_start", (_event, ctx) => {
    mode = readPermissionMode(ctx.sessionManager.getEntries());
    lifetime = new AbortController(); changes = new AbortController(); queue = Promise.resolve();
    pi.events.emit(PERMISSIONS_CHANGED, { mode });
  });
  pi.on("session_shutdown", () => { lifetime.abort(); changes.abort(); });
  const apply = (value: PermissionMode) => {
    if (value === mode) return;
    // Save before changing enforcement so a failed save leaves the old mode intact.
    pi.appendEntry(PERMISSIONS_ENTRY, { mode: value });
    mode = value; changes.abort(); changes = new AbortController();
    pi.events.emit(PERMISSIONS_CHANGED, { mode });
  };
  const approve = async (name: string, input: unknown, ctx: ExtensionContext, signal: AbortSignal) => {
    if (!ctx.hasUI || signal.aborted) return false;
    const lines = permissionRequest(name, input, ctx.cwd);
    if (ctx.mode !== "tui") return Boolean(await ctx.ui.confirm(`Allow ${name} once?`, lines.join("\n"), { signal }));
    const [{ createPermissionApprovalScreen }, { createHeader }, { createUiTheme }] = await Promise.all([
      import("../ui/permissions-screen.js"), import("../ui/chrome.js"), import("../ui/theme.js"),
    ]);
    // Cancellation or a mode change during module loading must not open a stale approval.
    if (signal.aborted) return false;
    return Boolean(await ctx.ui.custom<boolean>((tui, _theme, _keys, done) => {
      const theme = createUiTheme();
      const measure = { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi };
      const header = createHeader({ mode: "regular" }, measure, {
        version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
      });
      const footer = tui.children.at(-1);
      const abort = () => { panel.dispose(); done(false); };
      const panel = createPermissionApprovalScreen({ tui, theme, measure, done, lines,
        renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width),
        onDispose: () => { signal.removeEventListener("abort", abort); header.dispose(); },
      });
      signal.addEventListener("abort", abort, { once: true });
      return panel;
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } }));
  };
  pi.on("tool_call", async (event, ctx) => {
    const signal = AbortSignal.any([lifetime.signal, changes.signal, ...(ctx.signal ? [ctx.signal] : [])]);
    const tools = pi.getAllTools();
    const marker = ctx.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === PLAN_ENTRY).at(-1);
    if (isPlanning((marker as { data?: Plan } | undefined)?.data) && !canPlanRead(event.toolName, tools)
      && !isWorkspaceBookkeeping(event.toolName, event.input, tools)) {
      return { block: true, terminate: true, reason: `Plan mode: ${event.toolName} is blocked until /plan execute.` };
    }
    const decision = isWorkspaceBookkeeping(event.toolName, event.input, tools) ? "allow" : permissionDecision(mode, event.toolName, tools);
    if (decision === "allow" && !signal.aborted) return;
    const blocked = (reason: string) => ({ block: true, terminate: true, reason });
    if (decision === "block" || signal.aborted) return blocked(`Permissions: ${event.toolName} is blocked in ${PERMISSION_LABELS[mode]} mode.`);
    // Parallel tool calls receive one approval dialog at a time.
    const task = queue.then(async () => {
      if (signal.aborted) return false;
      try { return await approve(event.toolName, event.input, ctx, signal); } catch { return false; }
    });
    queue = task.then(() => {}, () => {});
    return await task && !signal.aborted ? undefined : blocked(`Permission was not granted for ${event.toolName}.`);
  });
  pi.on("before_agent_start", (event) => {
    if (mode === "full") return;
    const text = `Agent permissions: ${PERMISSION_DESCRIPTIONS[mode]}${mode === "read-only" ? " Do not attempt to bypass blocked tools through another tool." : " Permission is granted for each action separately."}`;
    if (event.systemPromptOptions?.forceSystemPrompt !== undefined || !event.systemPromptOptions) return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
    event.systemPromptOptions.sections.pi_extended_permissions = text;
  });
  pi.registerCommand("permissions", {
    description: "Choose full access, approval prompts, or read-only agent tools",
    getArgumentCompletions: (prefix) => PERMISSION_MODES.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
      .map((value) => ({ value, label: PERMISSION_LABELS[value] })),
    handler: async (args, ctx) => {
      const notify = (text: string, type: "info" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, type); else console.error(text);
      };
      const value = args.trim().toLowerCase();
      if (value) {
        if (!isPermissionMode(value)) { notify(`Available modes: ${PERMISSION_MODES.join(", ")}.`, "error"); return; }
        apply(value); notify(`Permissions: ${PERMISSION_LABELS[mode]}`); return;
      }
      if (ctx.mode !== "tui") {
        notify(`Permissions: ${PERMISSION_LABELS[mode]}\n${PERMISSION_DESCRIPTIONS[mode]}\nAvailable: ${PERMISSION_MODES.join(", ")}`); return;
      }
      const [{ createPermissionsScreen }, { createHeader }, { createUiTheme }] = await Promise.all([
        import("../ui/permissions-screen.js"), import("../ui/chrome.js"), import("../ui/theme.js"),
      ]);
      let selected: PermissionMode | undefined;
      await ctx.ui.custom((tui, _theme, _keys, done) => {
        const theme = createUiTheme();
        const measure = { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi };
        const header = createHeader({ mode: "regular" }, measure, {
          version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
        });
        const footer = tui.children.at(-1);
        return createPermissionsScreen({ tui, theme, measure, done, current: mode, onSelect: (value) => { selected = value; },
          renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width), onDispose: () => header.dispose(),
        });
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
      if (selected) { apply(selected); notify(`Permissions: ${PERMISSION_LABELS[mode]}`); }
    },
  });
}
