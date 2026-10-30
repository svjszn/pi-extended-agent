export const REMOVED_COMMANDS = new Set([
  "settings", "tree", "thinking", "scoped-models", "skoped-models", "import", "export", "share", "bug", "copy",
  "session", "changelog", "hotkeys", "fork", "clone", "trust", "about-agent", "llama", "mcp",
]);

export function commandName(text: string): string | undefined {
  return /^\/([^\s]+)(?:\s|$)/.exec(text.trim())?.[1];
}

export function removedCommand(name: string): boolean {
  // Native extension conflicts can expose namespaced invocation names.
  return REMOVED_COMMANDS.has(name) || REMOVED_COMMANDS.has(name.split(":").at(-1)!);
}

export function removedCommandMessage(name: string): string {
  const replacement = name === "settings" ? " Use /config." : name === "thinking" ? " Use /effort." : "";
  return `/${name} is not available in Pi Extended Agent.${replacement}`;
}
