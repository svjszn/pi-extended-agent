import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createWorkspaceScreen, createWorkspaceEditor } from "./workspace-screen.js";
import type { WorkspacePage } from "./workspace-screen.js";
import { createHeader } from "./chrome.js";
import { createUiTheme } from "./theme.js";
import { AGENT_SCOPES, parseAgent, renderAgent } from "../lib/agents.js";
import type { AgentDefinition, AgentDraft, AgentScope } from "../lib/agents.js";
import type { Measure } from "./types.js";

interface Host { pi: ExtensionAPI; ctx: ExtensionCommandContext; measure: Measure }
const overlay = { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } } as const;

function chrome({ pi, ctx, measure }: Host) {
  const theme = createUiTheme();
  const header = createHeader({ mode: "regular" }, measure, {
    version: VERSION, getModel: () => ctx.model, getThinkingLevel: () => pi.getThinkingLevel(), getCwd: () => ctx.cwd,
  });
  return { theme, header };
}

/** The agent browser reuses the shared workspace screen rather than a new layout. */
export async function openAgentsScreen(host: Host & { pages: WorkspacePage[]; initial: number }) {
  let selected: { action: string; page: number } | undefined;
  await host.ctx.ui.custom((tui, _theme, _keys, done) => {
    const { theme, header } = chrome(host);
    const footer = tui.children.at(-1);
    return createWorkspaceScreen({
      title: "Subagents", tui, theme, measure: host.measure, done, pages: host.pages, initial: host.initial,
      hint: "tab agents · n new · e edit · d delete · esc close",
      actions: { n: "new", e: "edit", d: "delete" },
      onAction: (action, page) => { selected = { action, page }; },
      renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width),
      onDispose: () => header.dispose(),
    });
  }, overlay);
  return selected;
}

const SCOPE_LINE = "scope: ";

/**
 * Agents are edited as the file itself, so the format stays the one stored on
 * disk. The scope line is editor-only and never written into the definition.
 */
export async function openAgentEditor(host: Host & { existing?: AgentDefinition }): Promise<{ scope: AgentScope; draft: AgentDraft } | undefined> {
  const existing = host.existing;
  const name = existing?.name ?? await host.ctx.ui.input("Agent name", "for example: test-runner");
  if (!name) return undefined;
  const template: AgentDraft = existing ?? {
    name, description: "", prompt: "Describe what this agent does, how it should work, and what to report back.",
  };
  const initial = `${SCOPE_LINE}${existing?.scope === "project" ? "project" : "global"}\n${renderAgent({ ...template, name })}`;
  let saved: string | undefined;
  await host.ctx.ui.custom((tui, _theme, _keys, done) => {
    const { theme, header } = chrome(host);
    const footer = tui.children.at(-1);
    return createWorkspaceEditor({
      title: `Agent · ${name}`, text: initial, tui, theme, measure: host.measure, done,
      onSave: (value) => { saved = value; },
      renderHeader: (width) => header.render(width), renderFooter: (width) => footer?.render(width),
      onDispose: () => header.dispose(),
    });
  }, overlay);
  if (saved === undefined) return undefined;
  const lines = saved.split(/\r?\n/);
  const first = lines[0]?.trim().toLowerCase();
  if (!first?.startsWith(SCOPE_LINE)) throw new Error(`Keep the first line as "${SCOPE_LINE}project" or "${SCOPE_LINE}global".`);
  const value = first.slice(SCOPE_LINE.length).trim();
  const scope = AGENT_SCOPES.find((candidate) => candidate === value);
  if (!scope) throw new Error(`Unknown scope: ${value}. Use project or global.`);
  const parsed = parseAgent(lines.slice(1).join("\n"), { name, scope, filePath: "" });
  return { scope, draft: { name, description: parsed.description, tools: parsed.tools, model: parsed.model, prompt: parsed.prompt } };
}
