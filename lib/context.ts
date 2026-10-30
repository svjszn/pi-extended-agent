import { buildSessionContext, estimateTokens, formatSkillsForPrompt, getLastAssistantUsage } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, SettingsManager, SessionEntry } from "@earendil-works/pi-coding-agent";

type ContextSource = "pi" | "estimate" | "unknown";
type ContextReader = Pick<ExtensionContext, "getContextUsage" | "getSystemPrompt" | "model" | "sessionManager">;
type ContextTools = Pick<ExtensionAPI, "getActiveTools" | "getAllTools">;
export interface ContextSummary {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  source: ContextSource;
  afterCompaction: boolean;
}
export interface ContextItem { name: string; tokens: number }
export type ContextCategoryId = "system" | "tools" | "instructions" | "skills" | "messages" | "results" | "other";
export interface ContextCategory extends ContextItem { id: ContextCategoryId }
export interface ContextReport extends ContextSummary {
  categories: ContextCategory[];
  files: ContextItem[];
  skills: ContextItem[];
  tools: ContextItem[];
  messageCount: number;
  compactions: number;
  autoCompact: boolean;
  reserveTokens: number;
}

const textTokens = (text: string) => Math.ceil(text.length / 4);
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function toolItems(pi: ContextTools): ContextItem[] {
  const active = new Set(pi.getActiveTools());
  return pi.getAllTools().filter((tool) => active.has(tool.name)).map((tool) => ({ name: tool.name,
    tokens: textTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  }));
}

function lastCompactionIndex(branch: SessionEntry[]): number {
  return branch.findLastIndex((entry) => entry.type === "compaction");
}

/** Pi's window estimate is never a sum of this session's billed token usage. */
export function readContextSummary(ctx: ContextReader, pi: ContextTools): ContextSummary {
  const usage = ctx.getContextUsage();
  const limit = usage?.contextWindow ?? ctx.model?.contextWindow;
  const contextWindow = valid(limit) && limit > 0 ? limit : null;
  const branch = ctx.sessionManager.getBranch();
  const compaction = lastCompactionIndex(branch);
  const afterCompaction = compaction >= 0;
  if (!usage || !valid(usage.tokens)) return { tokens: null, contextWindow, percent: null, source: "unknown", afterCompaction };
  let tokens = usage.tokens;
  let source: ContextSource = "pi";
  if (!getLastAssistantUsage(branch.slice(compaction + 1)) && !afterCompaction) {
    // Before the first provider response Pi only counts conversation content.
    // Include the prompt and active schemas so a new session isn't shown empty.
    tokens += textTokens(ctx.getSystemPrompt()) + toolItems(pi).reduce((sum, item) => sum + item.tokens, 0);
    source = "estimate";
  }
  return { tokens, contextWindow, percent: contextWindow ? tokens / contextWindow * 100 : null, source, afterCompaction };
}

/** Integer allocation keeps the estimated breakdown consistent with Pi's total. */
export function allocateTokens(total: number, weights: number[]): number[] {
  const sum = weights.reduce((value, weight) => value + Math.max(0, weight), 0);
  if (!sum) return weights.map(() => 0);
  const exact = weights.map((weight) => Math.max(0, weight) / sum * total);
  const values = exact.map(Math.floor);
  const order = exact.map((value, index) => ({ index, remainder: value - values[index] })).sort((a, b) => b.remainder - a.remainder);
  const remaining = total - values.reduce((value, count) => value + count, 0);
  for (const { index } of order.slice(0, remaining)) values[index]++;
  return values;
}

/** Read in-memory metadata only. Never return prompt, message, or file contents. */
export function readContextReport(ctx: ExtensionCommandContext, pi: ContextTools, settings: Pick<SettingsManager, "getCompactionSettings">): ContextReport {
  const summary = readContextSummary(ctx, pi);
  const options = ctx.getSystemPromptOptions();
  let prompt = ctx.getSystemPrompt();
  const files: ContextItem[] = [];
  for (const file of options.contextFiles || []) {
    if (!file.content.trim() || !prompt.includes(file.content)) continue;
    files.push({ name: file.path, tokens: textTokens(file.content) });
    prompt = prompt.replace(file.content, "");
  }
  const skills: ContextItem[] = [];
  const readTool = pi.getActiveTools().includes("read") ? "read" : "bash";
  // Pi 1.4 trims this section before inserting it into the structured prompt.
  const skillBlock = formatSkillsForPrompt(options.skills || [], readTool).trim();
  let skillTokens = 0;
  if (skillBlock && prompt.includes(skillBlock)) {
    skillTokens = textTokens(skillBlock);
    prompt = prompt.replace(skillBlock, "");
    for (const skill of options.skills || []) {
      if (!skill.disableModelInvocation) skills.push({ name: skill.name,
        tokens: textTokens(skill.name + skill.description + skill.filePath) });
    }
  }
  const tools = toolItems(pi);
  const branch = ctx.sessionManager.getBranch();
  // Native projection follows the active branch and discards compacted history.
  const messages = buildSessionContext(branch).messages;
  let conversation = 0, results = 0, messageCount = 0;
  for (const message of messages) {
    // Newer engines also project structured system messages. The current
    // system prompt is counted above; avoid including it in conversation size.
    if (String(message.role) === "system") continue;
    const tokens = estimateTokens(message);
    if (message.role === "toolResult" || message.role === "bashExecution") results += tokens;
    else conversation += tokens;
    messageCount++;
  }
  const categories: ContextCategory[] = [
    { id: "system", name: "System prompt", tokens: textTokens(prompt) },
    { id: "tools", name: "Tool definitions", tokens: tools.reduce((sum, item) => sum + item.tokens, 0) },
    { id: "instructions", name: "Instructions", tokens: files.reduce((sum, item) => sum + item.tokens, 0) },
    { id: "skills", name: "Skill descriptions", tokens: skillTokens },
    { id: "messages", name: "Messages", tokens: conversation },
    { id: "results", name: "Tool results", tokens: results },
  ];
  const rawTotal = categories.reduce((sum, item) => sum + item.tokens, 0);
  if (summary.tokens !== null) {
    if (rawTotal > summary.tokens) {
      const allocation = allocateTokens(Math.round(summary.tokens), categories.map((item) => item.tokens));
      categories.forEach((item, index) => { item.tokens = allocation[index]; });
    } else if (rawTotal < summary.tokens) categories.push({ id: "other", name: "Other context", tokens: summary.tokens - rawTotal });
  }
  const compaction = settings.getCompactionSettings();
  return { ...summary, categories, files, skills, tools, messageCount,
    compactions: branch.filter((entry) => entry.type === "compaction").length,
    autoCompact: compaction.enabled, reserveTokens: Math.max(0, compaction.reserveTokens),
  };
}
