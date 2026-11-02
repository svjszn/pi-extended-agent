type ParseArgs = typeof import("@earendil-works/pi-coding-agent")["parseArgs"];
const aliases = new Set(["-r", "--resume"]);
const management = new Set(["auth", "install", "remove", "uninstall", "update", "list", "config", "mcp"]);

/** Give resume aliases an optional session argument, using Pi's own resolver. */
export function normalizeResumeArgs(args: string[], parse: ParseArgs): string[] {
  if (management.has(args[0])) return args;
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--") { result.push(...args.slice(index)); break; }
    const target = args[index + 1];
    if (aliases.has(value) && target && !target.startsWith("-") && !target.startsWith("@")) {
      // Ask the native parser whether this token is a flag or another option's
      // value. Neutralize earlier resume flags without changing their arity.
      const prefix = args.slice(0, index).map((arg) => aliases.has(arg) ? "--offline" : arg);
      if (parse([...prefix, value]).resume) {
        result.push("--session", target); index++; continue;
      }
    }
    result.push(value);
  }
  return result;
}
