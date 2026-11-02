import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../lib/errors.js";

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
  const handler = async (_args: string, ctx: ExtensionCommandContext) => {
    if (!ctx.isIdle()) {
      report(ctx, "Wait for the current run to finish before clearing the conversation.", true);
      return;
    }
    let replaced = false;
    try {
      const result = await ctx.newSession({
        withSession: async (fresh: Pick<ExtensionCommandContext, "hasUI" | "ui">) => {
          replaced = true;
          report(fresh, "New session started. The conversation and its context are empty.");
        },
      });
      // Nothing was replaced, so the context that started this is still usable.
      if (result.cancelled) report(ctx, "Clearing the conversation was cancelled.");
    } catch (error) {
      if (replaced) console.error(errorMessage(error));
      else report(ctx, errorMessage(error), true);
    }
  };
  pi.registerCommand("clear", { description: DESCRIPTION, handler });
}
