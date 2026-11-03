import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ProjectEditor, displayPath } from "./project-editor.js";

export interface DiffFile { path: string; previous?: string; status: string; untracked: boolean }
export interface GitChanges { root: string; staged: boolean; files: DiffFile[] }
const LIMIT = 2 * 1024 * 1024;
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((accept, reject) => {
    execFile("git", ["--no-pager", "--literal-pathspecs", "-c", "core.quotepath=false", "-c", "color.ui=false", "-c", "core.fsmonitor=false", ...args],
      { cwd, signal, timeout: 15_000, maxBuffer: LIMIT, encoding: "utf8", windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) => {
        if (!error) accept(stdout);
        else if (signal?.aborted) reject(new Error("Diff loading was cancelled."));
        else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(new Error("Git output exceeds 2 MiB. Open a narrower path with /diff <path>."));
        else reject(new Error(args[0] === "rev-parse" ? "This directory is not a Git working tree, or Git is unavailable." : "Git could not read these changes. Refresh or inspect the repository in your terminal."));
      });
  });
}
export async function readGitChanges(cwd: string, staged = false, filter?: string, signal?: AbortSignal): Promise<GitChanges> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).replace(/\r?\n$/, "");
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  if (filter) {
    const path = resolve(cwd, filter), rel = relative(root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Choose a path inside this Git repository.");
    args.push("--", rel || ".");
  }
  const records = (await git(root, args, signal)).split("\0"), files: DiffFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (!record) continue;
    const x = record[0], y = record[1], path = record.slice(3);
    const previous = x === "R" || x === "C" || y === "R" || y === "C" ? records[++i] : undefined;
    if (staged ? x === " " || x === "?" || x === "!" : y === " " || x === "!") continue;
    files.push({ path, previous, status: staged ? x : x === "?" ? "?" : y, untracked: x === "?" });
  }
  if (files.length > 5000) throw new Error("More than 5,000 changed files. Use /diff <path> to narrow the view.");
  return { root, staged, files };
}
export async function readFileDiff(changes: GitChanges, file: DiffFile, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) throw new Error("Diff loading was cancelled.");
  if (file.untracked) {
    try {
      const doc = new ProjectEditor(changes.root).read(file.path);
      if (!doc.text) return [`Untracked empty file: ${displayPath(file.path)}`];
      const lines = doc.text ? doc.text.split("\n") : []; if (doc.text.endsWith("\n")) lines.pop();
      return [`--- /dev/null`, `+++ ${displayPath(file.path)}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`),
        ...(!doc.text.endsWith("\n") && doc.text ? ["\\ No newline at end of file"] : [])];
    } catch (error) { return [error instanceof Error ? error.message : "The untracked file cannot be displayed."]; }
  }
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", ...(changes.staged ? ["--cached"] : []), "--", file.path, ...(file.previous ? [file.previous] : [])];
  const output = await git(changes.root, args, signal);
  return output ? output.replace(/\n$/, "").split("\n") : ["No textual diff in this view. The change may be metadata-only or belong to the other view."];
}
