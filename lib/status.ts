import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext, ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

interface McpEntry { name: string; config?: { enabled?: boolean } }
interface McpConfiguration { servers: McpEntry[]; errors?: unknown[] }
interface McpOptions { agentDir: string; cwd: string; projectTrusted: boolean }
type McpLoader = (options: McpOptions) => Promise<McpConfiguration | undefined>;
type StatusPi = Pick<ExtensionAPI, "getActiveTools" | "getAllTools"> & { getMcpServers?(): McpEntry[] };
type NamespacedTool = ToolInfo & { namespace?: { name: string; aliases?: readonly string[] } };
export interface StatusReport {
  version: string;
  sessionId: string;
  login: string;
  model: string;
  tools: string[];
  mcp: { name: string; enabled: boolean; tools: number }[];
  mcpConfigKnown: boolean;
  mcpConfigError: boolean;
}

async function loadNativeMcpConfig(packageDir: string, options: McpOptions): Promise<McpConfiguration | undefined> {
  // Use the active engine's parser so project trust, overrides, and validation
  // match /mcp. Older bundled engines have no built-in MCP configuration reader.
  const path = join(packageDir, "dist", "extensions", "mcp", "config.js");
  if (!existsSync(path)) return undefined;
  const module = await import(pathToFileURL(path).href) as { loadMcpConfig(options: McpOptions): McpConfiguration };
  return module.loadMcpConfig(options);
}

/** Metadata only: no credential resolution, refresh, connection, or tool execution. */
export async function readStatus(ctx: ExtensionContext, pi: StatusPi, { version, agentDir, packageDir }: { version: string; agentDir: string; packageDir: string },
  { loadMcpConfig = (options) => loadNativeMcpConfig(packageDir, options) }: { loadMcpConfig?: McpLoader } = {}): Promise<StatusReport> {
  const model = ctx.model;
  let login = "No model selected";
  if (model) {
    const provider = model.provider === "openai-codex" ? "ChatGPT" : model.provider === "anthropic" ? "Claude"
      : ctx.modelRegistry.getProviderDisplayName(model.provider) || model.provider;
    const auth = ctx.modelRegistry.getProviderAuthStatus(model.provider);
    login = auth.configured ? `${provider} · ${ctx.modelRegistry.isUsingOAuth(model) ? "OAuth" : "API credentials"} configured`
      : `${provider} · not configured · /login`;
  }
  const servers = new Map<string, { name: string; enabled: boolean; tools: number }>();
  for (const entry of pi.getMcpServers?.() || []) servers.set(entry.name, { name: entry.name, enabled: entry.config?.enabled !== false, tools: 0 });
  let configuration: McpConfiguration | undefined, mcpConfigError = false;
  try {
    configuration = await loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    mcpConfigError = Boolean(configuration?.errors?.length);
    for (const entry of configuration?.servers || []) servers.set(entry.name, { name: entry.name, enabled: entry.config?.enabled !== false, tools: 0 });
  } catch { mcpConfigError = true; }
  const allTools: NamespacedTool[] = pi.getAllTools();
  for (const tool of allTools) {
    const match = /^mcp__(.+?)__/.exec(tool.name);
    const namespace = tool.namespace;
    if (!match && !namespace?.name.startsWith("mcp__")) continue;
    const id = namespace?.name.slice(5) || match![1];
    const name = namespace?.aliases?.find((alias) => servers.has(alias))
      || [...servers.keys()].find((candidate) => candidate.replace(/[^A-Za-z0-9_]/g, "_") === id)
      || namespace?.aliases?.[0] || id;
    const server = servers.get(name) || { name, enabled: true, tools: 0 };
    server.tools++;
    servers.set(name, server);
  }
  return { version, sessionId: ctx.sessionManager.getSessionId(), login,
    model: model ? model.id : "No model selected",
    tools: [...new Set(pi.getActiveTools())], mcp: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    mcpConfigKnown: configuration !== undefined, mcpConfigError,
  };
}
