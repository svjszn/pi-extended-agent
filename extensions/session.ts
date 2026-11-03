import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../lib/errors.js";
import { SESSION_PREFERENCES_ENTRY, sessionPreferences, preferenceHandoffKey, handoffPreferences, takePreferences } from "../lib/session-preferences.js";
import { PERMISSIONS_ENTRY } from "../lib/permissions.js";

const DESCRIPTION = "Clear the conversation and start a new session";

function report(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">, text: string, error = false) {
  if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info"); else console.error(text);
}

/**
 * `/clear` and `/new` are the same action, kept in this interface rather than
 * Pi's own handler so the header, footer and input are rebuilt with the new
 * session. Pi's built-in `/new` is routed here by the command policy adapter.
 *
 * A session replacement invalidates the command context that started it, so
 * everything after it runs on the context `withSession` provides.
 */
export default function session(pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "new") return;
    const preferences = takePreferences(preferenceHandoffKey(getAgentDir(), ctx.cwd, event.previousSessionFile));
    if (!preferences) return;
    try {
      // Workspace initializes from this marker before it admits any tool calls.
      pi.appendEntry(SESSION_PREFERENCES_ENTRY, preferences);
      const selected = preferences.model;
      if (selected && (ctx.model?.provider !== selected.provider || ctx.model?.id !== selected.id)) {
        const model = ctx.modelRegistry.find(selected.provider, selected.id);
        if (!model || !await pi.setModel(model)) throw new Error(`The previous model ${selected.provider}/${selected.id} is unavailable.`);
      }
      pi.setThinkingLevel(preferences.effort);
    } catch (error) { report(ctx, `Could not restore session settings: ${errorMessage(error)}`, true); }
  });
  const handler = async (_args: string, ctx: ExtensionCommandContext) => {
    if (!ctx.isIdle()) {
      report(ctx, "Wait for the current run to finish before clearing the conversation.", true);
      return;
    }
    let replaced = false, settingUp = false;
    let release: (() => void) | undefined;
    try {
      const preferences = sessionPreferences(ctx, pi);
      release = handoffPreferences(preferenceHandoffKey(getAgentDir(), ctx.cwd, ctx.sessionManager.getSessionFile()), preferences);
      const result = await ctx.newSession({
        // setup runs before session_start, regardless of extension load order.
        // Persist the policy before permissions or subagents can read it.
        setup: async (manager) => {
          settingUp = true;
          manager.appendCustomEntry(PERMISSIONS_ENTRY, { mode: preferences.permissions });
        },
        withSession: async (fresh: Pick<ExtensionCommandContext, "hasUI" | "ui">) => {
          replaced = true;
          report(fresh, "New session started. The conversation and its context are empty.");
        },
      });
      // Nothing was replaced, so the context that started this is still usable.
      if (result.cancelled) report(ctx, "Clearing the conversation was cancelled.");
    } catch (error) {
      if (replaced || settingUp) console.error(errorMessage(error));
      else report(ctx, errorMessage(error), true);
    } finally { release?.(); }
  };
  pi.registerCommand("clear", { description: DESCRIPTION, handler });
}
