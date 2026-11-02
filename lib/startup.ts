import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Pi hands an unauthenticated session a placeholder model whose provider, api
 * and id are all "unknown", with a zero context window. Treat that as no model
 * rather than showing its fields to the user.
 */
export function hasModel(model: { provider?: string; api?: string } | undefined | null): boolean {
  return Boolean(model) && model!.provider !== "unknown" && model!.api !== "unknown";
}

/** Inspect Pi's auth metadata without resolving keys, refreshing tokens, or making requests. */
export function startupAuthNotice(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): string | undefined {
  if (!hasModel(ctx.model)) return "No models available. Run /login to connect a provider.";
  const provider = ctx.model!.provider;
  if (ctx.modelRegistry.getProviderAuthStatus(provider).configured) return undefined;
  const label = provider === "openai-codex" ? "ChatGPT" : provider === "anthropic" ? "Claude"
    : ctx.modelRegistry.getProviderDisplayName(provider) || provider;
  return `Run /login ${provider} — ${label} sign-in is not configured.`;
}
