const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface UsageLimit { name: string; remaining: number; resetsAt: number | null }
export interface UsageReport {
  provider: string;
  plan?: string;
  limits?: UsageLimit[];
  unavailable?: string;
  fetchedAt?: number;
}
interface RateWindow { used_percent?: number; reset_at?: number; reset_after_seconds?: number; limit_window_seconds?: number }
interface RateLimit { primary_window?: RateWindow; secondary_window?: RateWindow }
interface ChatGptUsage {
  rate_limit?: RateLimit;
  additional_rate_limits?: { rate_limit?: RateLimit; limit_name?: string; metered_feature?: string }[];
  plan_type?: string;
}
interface ClaudeWindow { utilization?: number; resets_at?: string }
type ClaudeUsage = Record<string, ClaudeWindow | undefined>;
interface UsageOptions { signal?: AbortSignal; fetchImpl?: typeof fetch }

export function usageProvider(ctx: Pick<ExtensionContext, "model" | "modelRegistry">) {
  const id = ctx.model?.provider;
  return { id, label: id === "openai-codex" ? "ChatGPT" : id === "anthropic" ? "Claude"
    : (id ? ctx.modelRegistry.getProviderDisplayName?.(id) || id : "Provider") };
}

function windowName(seconds = 0, fallback: string) {
  if (seconds === 604800) return "Weekly limit";
  if (seconds > 0 && seconds % 86400 === 0) return `${seconds / 86400}-day limit`;
  if (seconds > 0 && seconds % 3600 === 0) return `${seconds / 3600}-hour limit`;
  if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60}-minute limit`;
  return fallback;
}

export function parseUsage(input: unknown, now = Date.now()): UsageReport {
  const data = input as ChatGptUsage;
  if (!data || typeof data !== "object") throw new Error("The usage service returned an invalid response.");
  const limits: UsageLimit[] = [];
  const add = (rate: RateLimit | undefined, prefix = "") => {
    for (const [key, fallback] of [["primary_window", "Primary limit"], ["secondary_window", "Secondary limit"]] as const) {
      const window = rate?.[key];
      if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) continue;
      const resetsAt = typeof window.reset_at === "number" && Number.isFinite(window.reset_at) ? window.reset_at * 1000
        : typeof window.reset_after_seconds === "number" && Number.isFinite(window.reset_after_seconds) ? now + window.reset_after_seconds * 1000 : null;
      limits.push({
        name: `${prefix}${windowName(window.limit_window_seconds, fallback)}`,
        remaining: Math.max(0, Math.min(100, 100 - window.used_percent)),
        resetsAt,
      });
    }
  };
  add(data.rate_limit);
  for (const extra of Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : []) {
    add(extra.rate_limit, `${extra.limit_name || extra.metered_feature || "Additional"} · `);
  }
  if (limits.length === 0) throw new Error("The service did not return usage windows for this account. Check chatgpt.com/codex/settings/usage.");
  return { provider: "ChatGPT", plan: typeof data.plan_type === "string" ? data.plan_type : "ChatGPT", limits, fetchedAt: now };
}

export function parseClaudeUsage(input: unknown, now = Date.now()): UsageReport {
  const data = input as ClaudeUsage | null;
  const limits: UsageLimit[] = [];
  for (const [key, name] of [["five_hour", "5-hour limit"], ["seven_day", "Weekly limit"],
    ["seven_day_opus", "Opus weekly limit"], ["seven_day_sonnet", "Sonnet weekly limit"]]) {
    const window = data?.[key];
    if (typeof window?.utilization !== "number" || !Number.isFinite(window.utilization)) continue;
    const resetsAt = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : NaN;
    limits.push({ name, remaining: Math.max(0, Math.min(100, 100 - window.utilization)), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null });
  }
  if (!limits.length) throw new Error("Claude did not return usage windows for this account. Check claude.ai/settings/usage.");
  return { provider: "Claude", limits, fetchedAt: now };
}

/** Read-only account request. No model calls, credential copies, or saved responses. */
export async function fetchUsage(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, { signal, fetchImpl = fetch }: UsageOptions = {}): Promise<UsageReport> {
  const model = ctx.model;
  const provider = usageProvider(ctx);
  if (!model || !["openai-codex", "anthropic"].includes(provider.id || "")) {
    return { provider: provider.label, unavailable: "This provider's usage limits are not available here. Check your provider's usage page." };
  }
  if (!ctx.modelRegistry.isUsingOAuth(model)) {
    return { provider: provider.label, unavailable: "This connection uses API billing. Subscription usage windows are not available for API keys." };
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(`${provider.label} sign-in is unavailable. Use /login and try /usage again.`);
  const headers: Record<string, string> = { authorization: `Bearer ${auth.apiKey}`, accept: "application/json" };
  if (provider.id === "anthropic") headers["anthropic-beta"] = "oauth-2025-04-20";
  else {
    let accountId;
    try {
      const payload = JSON.parse(Buffer.from(auth.apiKey.split(".")[1], "base64url").toString("utf8"));
      accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    } catch { /* Never print credentials or token decoding errors. */ }
    if (typeof accountId !== "string" || !accountId) throw new Error("ChatGPT account information is missing. Use /login and retry.");
    headers["chatgpt-account-id"] = accountId;
  }
  const requestSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  try {
    // Account backends are not public API contracts. Do not infer plan billing
    // from these responses, and never forward a token to another provider.
    const response = await fetchImpl(provider.id === "anthropic" ? CLAUDE_USAGE_URL : USAGE_URL, {
      headers,
      signal: requestSignal, redirect: "error",
    });
    if (response.status === 401) throw new Error(`${provider.label} sign-in expired. Use /login and retry.`);
    if (!response.ok) throw new Error(`${provider.label} usage is unavailable (HTTP ${response.status}). Retry /usage or check the provider's usage page.`);
    const data = await response.json();
    return provider.id === "anthropic" ? parseClaudeUsage(data) : parseUsage(data);
  } catch (error) {
    if (requestSignal.aborted) throw new Error("Usage request cancelled or timed out. Retry /usage.");
    if (error instanceof TypeError || error instanceof SyntaxError) throw new Error(`Could not read ${provider.label} usage. Check your connection and retry /usage.`);
    throw error;
  }
}
