import type { ExtensionContext, ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface ConfigSection { title: string; rows: [string, string][] }
interface ConfigPaths { agentDir: string; globalPath: string; projectPath: string; tuiMode?: string; version: string }

/** Explicit fields only: never dump settings, models.json, or auth.json. */
export function configSections(ctx: ExtensionContext, pi: ExtensionAPI, settings: SettingsManager, { agentDir, globalPath, projectPath, tuiMode, version }: ConfigPaths): ConfigSection[] {
  return [
    { title: "Current session", rows: [
      ["Pi", version],
      ["Model", ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "No model selected"],
      ["Effort", pi.getThinkingLevel()],
      ["Theme", ctx.ui.theme?.name || settings.getTheme() || "Default"],
      ["Interface", tuiMode || "Non-interactive"],
      ["Tools", pi.getActiveTools().join(", ") || "None"],
    ] },
    { title: "Saved preferences", rows: [
      ["Transport", settings.getTransport()],
      ["Auto compact", settings.getCompactionEnabled() ? "On" : "Off"],
      ["Auto retry", settings.getRetryEnabled() ? "On" : "Off"],
      ["Steering", settings.getSteeringMode()],
      ["Follow-up", settings.getFollowUpMode()],
    ] },
    { title: "Files", rows: [
      ["Profile", agentDir],
      ["Global settings", globalPath],
      ["Project settings", `${projectPath}${ctx.isProjectTrusted() ? "" : " (untrusted; ignored)"}`],
      ["Session", ctx.sessionManager.getSessionFile() || "In memory"],
    ] },
  ];
}
