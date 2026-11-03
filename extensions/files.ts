import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { lstatSync } from "node:fs";
import { relative } from "node:path";

export default function files(pi: ExtensionAPI) {
  let closeActive: (() => void) | undefined;
  let generation = 0;
  pi.on("session_shutdown", () => { generation++; closeActive?.(); closeActive = undefined; });
  const notify = (ctx: ExtensionCommandContext, text: string, error = false) => {
    if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info"); else console.error(text);
  };
  for (const name of ["diff", "nano"] as const) pi.registerCommand(name, {
    description: name === "diff" ? "Browse working-tree and staged Git changes" : "Browse the working directory and edit text files inside Pi",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) { notify(ctx, `/${name} opens an interactive terminal screen. Run it in Pi's TUI.`, true); return; }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) { notify(ctx, `Wait for the current agent turn to finish before opening /${name}.`, true); return; }
      if (closeActive) { notify(ctx, "Close the current file screen first.", true); return; }
      const turn = generation, sessionId = ctx.sessionManager.getSessionId();
      try {
        const [{ createDiffScreen, createNanoScreen }, { ProjectEditor }, { createHeader }, { createUiTheme }] = await Promise.all([
          import("../ui/files-screen.js"), import("../lib/project-editor.js"), import("../ui/chrome.js"), import("../ui/theme.js"),
        ]);
        if (turn !== generation || ctx.signal?.aborted || closeActive || ctx.sessionManager.getSessionId() !== sessionId) return;
        if (!ctx.isIdle() || ctx.hasPendingMessages()) { notify(ctx, "The agent started working. Open the file screen after it finishes.", true); return; }
        let path = args.trim(), staged = false;
        if (name === "diff" && /^--staged(?:\s|$)/.test(path)) { staged = true; path = path.slice(8).trim(); }
        if (path.startsWith('"') && path.endsWith('"') || path.startsWith("'") && path.endsWith("'")) path = path.slice(1, -1);
        let project: InstanceType<typeof ProjectEditor> | undefined, initial: string | undefined;
        if (name === "nano") {
          project = new ProjectEditor(ctx.cwd);
          if (path) {
            const target = project.path(path);
            if (lstatSync(target).isDirectory()) project = new ProjectEditor(target);
            else initial = relative(project.root, target);
          }
        }
        await ctx.ui.custom<boolean>((tui, _theme, _keys, done) => {
          const header = createHeader({ mode: "regular" }, { truncateToWidth }, {
            version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
          });
          const footer = tui.children.at(-1);
          const onDispose = () => { header.dispose(); if (closeActive === close) closeActive = undefined; };
          const frame = { tui, theme: createUiTheme(), measure: { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi }, done,
            renderHeader: (width: number) => header.render(width), renderFooter: (width: number) => footer?.render(width), onDispose };
          const panel = name === "nano" ? createNanoScreen({ ...frame, project: project!, initial })
            : createDiffScreen({ ...frame, cwd: ctx.cwd, filter: path || undefined, staged });
          const close = () => { panel.dispose(); done(false); };
          closeActive = close;
          if (ctx.signal?.aborted || ctx.sessionManager.getSessionId() !== sessionId) close();
          return panel;
        }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
      } catch (error) {
        const text = error instanceof Error ? error.message.replace(/[\x00-\x1f\x7f-\x9f]/g, "") : "Could not open the file screen.";
        notify(ctx, text, true);
      }
    },
  });
}
