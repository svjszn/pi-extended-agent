import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Inspect Pi's auth metadata without resolving keys, refreshing tokens, or making requests. */
export function startupAuthNotice(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): string | undefined {
  const provider = ctx.model?.provider;
  if (!provider) return "No model selected. Run /login, then /model.";
  if (ctx.modelRegistry.getProviderAuthStatus(provider).configured) return undefined;
  const label = provider === "openai-codex" ? "ChatGPT" : provider === "anthropic" ? "Claude"
    : ctx.modelRegistry.getProviderDisplayName(provider) || provider;
  return `Run /login ${provider} — ${label} sign-in is not configured.`;
}
