export const REMOVED_COMMANDS = new Set([
  "settings", "tree", "thinking", "scoped-models", "skoped-models", "import", "export", "share", "bug", "copy",
  "session", "changelog", "hotkeys", "fork", "clone", "trust", "about-agent", "llama", "mcp",
]);

/**
 * Pi handles `/new` in its own submit handler, before extension commands are
 * ever consulted. Route it to our `/clear`, which starts the same new session
 * through the supported extension API and rebuilds this interface with it.
 */
export const REDIRECTED_COMMANDS: Record<string, string> = { new: "clear" };

export function redirectedCommand(text: string): string | undefined {
  const name = commandName(text);
  const target = name ? REDIRECTED_COMMANDS[name] : undefined;
  if (!target) return undefined;
  const rest = text.trim().slice(name!.length + 1).trim();
  return rest ? `/${target} ${rest}` : `/${target}`;
}

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
