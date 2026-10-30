import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Worktrees use the common git directory; ordinary directories use their canonical path. */
export function projectIdentity(cwd: string) {
  let root = realpathSync(cwd), identity = root;
  for (let dir = root; ; dir = dirname(dir)) {
    const git = join(dir, ".git");
    if (existsSync(git)) {
      root = dir;
      let gitDir = lstatSync(git).isDirectory() ? git : resolve(dir, readFileSync(git, "utf8").trim().replace(/^gitdir:\s*/, ""));
      if (existsSync(join(gitDir, "commondir"))) gitDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
      identity = realpathSync(gitDir); break;
    }
    if (dirname(dir) === dir) break;
  }
  if (process.platform === "win32") identity = identity.toLowerCase();
  return { root, key: createHash("sha256").update(identity).digest("hex").slice(0, 24) };
}

/** All writes stay under an app-owned profile, never inside the working tree. */
export class StateFiles {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  path(name: string) {
    const path = resolve(this.directory, name), rel = relative(this.directory, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Invalid state path.");
    // Reject redirects at every component, including the profile directory itself.
    for (let part = path; ; part = dirname(part)) {
      if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error("State paths cannot contain symbolic links.");
      if (dirname(part) === part) break;
    }
    return path;
  }
  read(name: string, limit = 64_000): string | undefined {
    const path = this.path(name);
    if (!existsSync(path)) return;
    if (lstatSync(path).size > limit) throw new Error(`State file is too large: ${name}`);
    return readFileSync(path, "utf8");
  }
  write(name: string, text: string) {
    const path = this.path(name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" }); renameSync(temp, path); }
    finally { if (existsSync(temp)) rmSync(temp); }
  }
  remove(name: string) { rmSync(this.path(name), { force: true }); }
}

export function projectFiles(cwd: string, agentDir: string) {
  const identity = projectIdentity(cwd);
  return new StateFiles(join(agentDir, "pi-extended", "projects", identity.key));
}

export function cleanText(value: string) {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim();
}

export function boundedText(value: unknown, label: string, limit: number) {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const text = cleanText(value);
  if (Buffer.byteLength(text, "utf8") > limit) throw new Error(`${label} exceeds ${limit} bytes.`);
  return text;
}
