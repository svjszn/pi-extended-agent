import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { boundedText, cleanText } from "./project-state.js";
import { errorMessage } from "./errors.js";

export const AGENT_SCOPES = ["project", "global"] as const;
export type AgentScope = typeof AGENT_SCOPES[number];
export interface AgentDefinition {
  name: string;
  description: string;
  /** Tool allowlist. Undefined inherits the engine's default selection. */
  tools?: string[];
  /** Model id. Undefined keeps the parent's model. */
  model?: string;
  prompt: string;
  scope: AgentScope;
  filePath: string;
}
export type AgentDraft = Pick<AgentDefinition, "name" | "description" | "tools" | "model" | "prompt">;
export interface AgentCatalog { agents: AgentDefinition[]; unreadable: string[] }

const MAX_AGENTS = 32;
const MAX_PROMPT = 24_000;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function isAgentScope(value: unknown): value is AgentScope {
  return AGENT_SCOPES.some((scope) => scope === value);
}
export function validAgentName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 64 && NAME.test(name) && !RESERVED.test(name);
}
/** Project definitions live in the working tree; global ones live in the profile. */
export function agentsDirectory(scope: AgentScope, { cwd, agentDir }: { cwd: string; agentDir: string }) {
  return resolve(scope === "project" ? join(cwd, ".pi", "agents") : join(agentDir, "agents"));
}
function agentFile(scope: AgentScope, name: string, paths: { cwd: string; agentDir: string }) {
  if (!validAgentName(name)) throw new Error("Use an agent name with lowercase letters, digits, and single hyphens (up to 64 characters).");
  const directory = agentsDirectory(scope, paths);
  const file = resolve(directory, `${name}.md`);
  if (file !== join(directory, `${name}.md`)) throw new Error("Invalid agent path.");
  return file;
}

/** Tool entries are names or patterns, matching the engine's own allowlist syntax. */
function parseTools(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
  if (list === undefined || list.some((entry) => typeof entry !== "string")) throw new Error("Tools must be a list of names or patterns.");
  const tools = list.map((entry: string) => cleanText(entry)).filter(Boolean);
  if (tools.length > 100) throw new Error("An agent may list at most 100 tools.");
  for (const tool of tools) {
    if (tool.length > 200 || /\s/.test(tool)) throw new Error(`Invalid tool entry: ${tool}`);
  }
  return tools;
}

export function parseAgent(content: string, { name, scope, filePath }: { name: string; scope: AgentScope; filePath: string }): AgentDefinition {
  const { frontmatter, body } = parseFrontmatter<{ name?: unknown; description?: unknown; tools?: unknown; model?: unknown }>(content);
  if (frontmatter.name !== undefined && frontmatter.name !== name) {
    throw new Error(`The name in the file (${String(frontmatter.name)}) does not match its filename (${name}).`);
  }
  const description = boundedText(frontmatter.description ?? "", "Description", 1024);
  if (!description) throw new Error("An agent needs a description; it tells the model when to delegate.");
  const prompt = boundedText(body, "Agent instructions", MAX_PROMPT);
  if (!prompt) throw new Error("An agent needs instructions in the file body.");
  const model = frontmatter.model === undefined ? undefined : boundedText(frontmatter.model, "Model", 200) || undefined;
  return { name, description, tools: parseTools(frontmatter.tools), model, prompt, scope, filePath };
}

export function renderAgent(agent: AgentDraft) {
  // JSON strings and arrays are valid YAML, including [] and wildcard names.
  // Plain scalar interpolation changes the meaning of empty lists, #, and :.
  const lines = [`name: ${JSON.stringify(agent.name)}`, `description: ${JSON.stringify(agent.description)}`];
  if (agent.tools !== undefined) lines.push(`tools: ${JSON.stringify(agent.tools)}`);
  if (agent.model) lines.push(`model: ${JSON.stringify(agent.model)}`);
  return `---\n${lines.join("\n")}\n---\n\n${agent.prompt}\n`;
}

export class AgentStore {
  constructor(readonly paths: { cwd: string; agentDir: string; projectTrusted: boolean }) {}

  private read(scope: AgentScope, name: string): AgentDefinition {
    const filePath = agentFile(scope, name, this.paths);
    if (lstatSync(filePath).size > MAX_PROMPT + 8_000) throw new Error("Agent definition is too large.");
    return parseAgent(readFileSync(filePath, "utf8"), { name, scope, filePath });
  }
  private names(scope: AgentScope): string[] {
    // An untrusted project must not contribute instructions or tool selections.
    if (scope === "project" && !this.paths.projectTrusted) return [];
    const directory = agentsDirectory(scope, this.paths);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3))
      .filter((name) => validAgentName(name)).sort((a, b) => a.localeCompare(b));
  }
  /**
   * Project definitions shadow global ones with the same name, like project settings.
   * One damaged definition is reported without hiding the agents that still load.
   */
  list(): AgentCatalog {
    const agents = new Map<string, AgentDefinition>(), unreadable: string[] = [];
    for (const scope of ["global", "project"] as const) {
      for (const name of this.names(scope)) {
        try { agents.set(name, this.read(scope, name)); }
        catch (error) { unreadable.push(`${name} (${scope}): ${errorMessage(error)}`); }
      }
    }
    return { agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)), unreadable };
  }
  find(name: string): AgentDefinition | undefined {
    return this.list().agents.find((agent) => agent.name === name);
  }
  save(scope: AgentScope, agent: AgentDraft) {
    if (scope === "project" && !this.paths.projectTrusted) {
      throw new Error("Saving a project agent requires a trusted project. Reopen Pi and approve it, or choose the global scope.");
    }
    const filePath = agentFile(scope, agent.name, this.paths);
    const content = renderAgent(agent);
    // Validate exactly what will be stored, before replacing anything on disk.
    parseAgent(content, { name: agent.name, scope, filePath });
    const existing = new Set(this.names(scope));
    if (!existing.has(agent.name) && existing.size >= MAX_AGENTS) throw new Error(`Keep at most ${MAX_AGENTS} agents per scope.`);
    mkdirSync(agentsDirectory(scope, this.paths), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.tmp`;
    try { writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" }); renameSync(temporary, filePath); }
    finally { if (existsSync(temporary)) rmSync(temporary, { force: true }); }
    return filePath;
  }
  delete(scope: AgentScope, name: string) {
    const filePath = agentFile(scope, name, this.paths);
    if (!existsSync(filePath)) throw new Error(`Agent not found in the ${scope} scope: ${name}`);
    rmSync(filePath, { force: true });
  }
}

/** Describe the delegation surface for the model without loading full instructions. */
export function agentsPrompt(catalog: AgentCatalog) {
  if (!catalog.agents.length) return undefined;
  return `Available subagents for the task tool (each runs in its own context and returns a single report):\n${
    catalog.agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n")
  }\nDelegate only a self-contained task whose intermediate output this conversation does not need. A subagent cannot ask the user questions, and it inherits the current permission mode.`;
}
