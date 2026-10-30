import type { StatusReport } from "../lib/status.js";
import type { Measure, Palette } from "./types.js";

const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

export function statusLines(data: StatusReport, width: number, theme: Palette, measure: Measure): string[] {
  const servers = data.mcp.map((server) => `${server.name} (${!server.enabled ? "disabled" : server.tools ? `${server.tools} ${server.tools === 1 ? "tool" : "tools"} registered` : "configured"})`);
  const rows = [
    ["Version", data.version], ["Session ID", data.sessionId], ["Login", data.login], ["Model", data.model],
    ["MCP Servers", servers.join(", ") || (data.mcpConfigError ? "Unavailable" : data.mcpConfigKnown ? "None configured" : "No MCP tools registered")],
    ["Tools", data.tools.join(", ") || "None active"],
  ];
  const prefix = Math.max(...rows.map(([name]) => name.length)) + 3;
  const lines: string[] = [];
  for (const [index, [name, value]] of rows.entries()) {
    if (index === 3) lines.push("");
    if (width < 40) {
      lines.push(theme.fg("muted", `${name}:`));
      lines.push(...measure.wrapTextWithAnsi(clean(value), Math.max(1, width - 2)).map((part) => "  " + theme.fg("text", part)));
    } else {
      for (const [line, part] of measure.wrapTextWithAnsi(clean(value), Math.max(1, width - prefix)).entries()) {
        lines.push(theme.fg("muted", (line === 0 ? `${name}:` : "").padEnd(prefix)) + theme.fg("text", part));
      }
    }
  }
  if (data.mcp.length || data.mcpConfigError) lines.push("", theme.fg("dim", data.mcpConfigError
    ? "MCP configuration has errors. Check the MCP configuration files." : "Registered tools do not verify a live server connection."));
  return lines;
}
