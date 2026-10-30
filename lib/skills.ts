import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm, lstat, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { FileHandle } from "node:fs/promises";
import { hasErrorCode } from "./errors.js";

export type SkillScope = "project" | "global";
export interface CatalogSkill {
  name: string; skillId: string; source: string; description: string; installs: number; installed?: false;
}
export interface InstalledSkill {
  name: string; description: string; source: string; filePath: string; scope: string; installed: true;
  skillId?: string; installs?: never;
}
export type SkillItem = CatalogSkill | InstalledSkill;
export interface SkillFile { path: string; sha: string; mode: string }
export interface SkillPreview {
  name: string; description: string; source: string; commit: string; directory: string;
  files: SkillFile[]; content: string; skillId: string;
}
export interface InstalledPreview {
  name: string; description: string; source: string; content: string; installed: true;
  scope?: string; filePath?: string; commit?: string;
}
export interface SkillInstallResult { name: string; path: string; scope: SkillScope }
interface RequestOptions { signal?: AbortSignal; fetchImpl?: typeof fetch }
interface InstallOptions extends RequestOptions { scope: SkillScope; cwd: string; agentDir: string; projectTrusted: boolean }
interface GitEntry { path: string; type: string; mode: string; sha: string; size?: number }

const SOURCE_FILE = ".pi-extended-source.json";
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 25 * 1024 * 1024;
const SOURCE = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/i;
const SHA = /^[a-f0-9]{40}$/;
export const skillText = (value: unknown) => String(value ?? "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();

export function validSkillName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
}

function skillFile(root: string, path: string) {
  if (typeof path !== "string" || /[\\\x00-\x1f\x7f<>:"|?*]/.test(path)) throw new Error("The skill contains an unsupported file path.");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("The skill contains an unsafe file path.");
  const target = resolve(root, ...parts);
  if (!target.startsWith(resolve(root) + sep)) throw new Error("The skill file is outside its installation folder.");
  return target;
}

async function request(url: string, options: RequestOptions = {}, limit = MAX_FILE) {
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
  let response;
  try {
    response = await (options.fetchImpl || fetch)(url, { signal, headers: { accept: "application/vnd.github+json", "user-agent": "pi-extended-agent" } });
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) throw new Error("The service request limit was reached. Try again later.");
      throw new Error(`Could not load skills (HTTP ${response.status}).`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    if (!response.body) throw new Error("The skills service returned an empty response.");
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("The skill response is too large.");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (signal.aborted) throw new Error(options.signal?.aborted ? "Cancelled." : "The skills request timed out. Try again.");
    if (error instanceof TypeError) throw new Error("Could not reach the skills service. Check your connection and try again.");
    throw error;
  }
}

async function json<T>(url: string, options: RequestOptions, limit?: number): Promise<T> {
  try { return JSON.parse((await request(url, options, limit)).toString("utf8")); }
  catch (error) { if (error instanceof SyntaxError) throw new Error("The skills service returned invalid data."); throw error; }
}

export async function searchSkills(query: string, options: RequestOptions = {}): Promise<CatalogSkill[]> {
  const value = query.trim().slice(0, 200);
  if (value.length < 2) return [];
  const url = new URL("https://skills.sh/api/search");
  url.search = new URLSearchParams({ q: value, limit: "20" }).toString();
  const data = await json<{ skills: CatalogSkill[] }>(url.href, options);
  if (!Array.isArray(data.skills)) throw new Error("The skill catalog returned an invalid result list.");
  return data.skills.filter((item) => item && SOURCE.test(item.source) && validSkillName(item.skillId || item.name))
    .map((item) => ({ name: skillText(item.name), skillId: item.skillId || item.name, source: item.source,
      description: skillText(item.description), installs: Number.isFinite(item.installs) ? Math.max(0, item.installs) : 0 }))
    .sort((a, b) => b.installs - a.installs);
}

function verifyBlob(bytes: Buffer, sha: string) {
  if (!SHA.test(sha || "") || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== sha) {
    throw new Error("The downloaded skill does not match the selected GitHub revision.");
  }
}

const rawUrl = (source: string, commit: string, path: string) => `https://raw.githubusercontent.com/${source}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Preview one immutable revision; installation uses this same file list and commit. */
export async function previewSkill(item: CatalogSkill, options: RequestOptions = {}): Promise<SkillPreview> {
  if (!SOURCE.test(item.source) || !validSkillName(item.skillId)) throw new Error("This screen supports public GitHub skills only.");
  const source = item.source;
  const head = await json<{ sha: string }>(`https://api.github.com/repos/${source}/commits/HEAD`, options);
  if (!SHA.test(head.sha || "")) throw new Error("GitHub did not return a valid repository revision.");
  const tree = await json<{ tree: GitEntry[]; truncated?: boolean }>(`https://api.github.com/repos/${source}/git/trees/${head.sha}?recursive=1`, options, 8 * MAX_FILE);
  if (!Array.isArray(tree.tree) || tree.truncated) throw new Error("This repository is too large to preview completely.");
  const candidates = tree.tree.filter((entry) => entry.type === "blob" && (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")));
  const score = (entry: GitEntry) => {
    const folder = entry.path.split("/").at(-2);
    return folder === item.skillId ? 2 : folder && item.skillId.endsWith(`-${folder}`) ? 1 : 0;
  };
  candidates.sort((a, b) => score(b) - score(a));
  for (const candidate of candidates.slice(0, 80)) {
    options.signal?.throwIfAborted();
    if (candidate.mode === "120000") continue;
    const bytes = await request(rawUrl(source, head.sha, candidate.path), options);
    verifyBlob(bytes, candidate.sha);
    const content = bytes.toString("utf8");
    const { frontmatter } = parseFrontmatter<{ name?: string; description?: string }>(content);
    if (frontmatter.name !== item.skillId) continue;
    if (!validSkillName(frontmatter.name) || typeof frontmatter.description !== "string" || !frontmatter.description.trim() || frontmatter.description.trim().length > 1024) {
      throw new Error("This skill needs a valid name and description in SKILL.md.");
    }
    const prefix = candidate.path === "SKILL.md" ? "" : candidate.path.slice(0, -"SKILL.md".length);
    const entries = tree.tree.filter((entry) => entry.path.startsWith(prefix) && entry.type !== "tree");
    if (entries.length > 200) throw new Error("This skill has too many files to install here.");
    let total = 0;
    const names = new Set();
    const files = entries.map((entry) => {
      const path = entry.path.slice(prefix.length);
      skillFile(resolve("skill"), path);
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) || !SHA.test(entry.sha || "")) throw new Error("Skills with symlinks or submodules are not supported.");
      if ((entry.size || 0) > MAX_FILE || (total += entry.size || 0) > MAX_TOTAL) throw new Error("This skill is too large to install here.");
      if (names.has(path.toLowerCase()) || path === SOURCE_FILE) throw new Error("This skill contains conflicting file names.");
      names.add(path.toLowerCase());
      return { path, sha: entry.sha, mode: entry.mode };
    });
    return { name: frontmatter.name, description: frontmatter.description.trim(), source, commit: head.sha,
      directory: prefix, files, content, skillId: item.skillId };
  }
  throw new Error(candidates.length > 80 ? "This repository has too many skills to resolve this entry here."
    : "The catalog skill was not found in the current repository revision.");
}

export function installedSkills(ctx: Pick<ExtensionCommandContext, "getSystemPromptOptions">): InstalledSkill[] {
  return (ctx.getSystemPromptOptions().skills || []).map((skill) => ({ ...skill, installed: true as const,
    scope: skill.sourceInfo?.scope === "user" ? "global" : skill.sourceInfo?.scope || "global",
    source: skill.sourceInfo?.origin === "package" ? skill.sourceInfo.source : "Local file" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function previewInstalledSkill(item: InstalledSkill): Promise<InstalledPreview> {
  const file = await open(item.filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_FILE + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FILE) throw new Error("This skill is too large to preview here.");
    let metadata;
    try { metadata = JSON.parse(await readFile(join(dirname(item.filePath), SOURCE_FILE), "utf8")); } catch { /* Existing skills may have no manager metadata. */ }
    return { ...item, ...(SOURCE.test(metadata?.source) && SHA.test(metadata?.commit || "") ? { source: metadata.source, commit: metadata.commit } : {}),
      content: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally { await file.close(); }
}

/** Download only; no dependency installs, helper execution, or existing-skill replacement. */
export async function installSkill(preview: SkillPreview, { scope, cwd, agentDir, projectTrusted, signal, fetchImpl }: InstallOptions): Promise<SkillInstallResult> {
  signal?.throwIfAborted();
  if (!["project", "global"].includes(scope)) throw new Error("Choose an installation scope.");
  if (scope === "project" && !projectTrusted) throw new Error("Project installation requires a trusted project. Reopen Pi and approve the project, or choose a global installation.");
  if (!SOURCE.test(preview.source) || !SHA.test(preview.commit || "") || !validSkillName(preview.name)
    || !preview.files?.length || preview.files.length > 200 || !preview.files.some((file) => file.path === "SKILL.md")) throw new Error("Invalid skill preview. Open the skill again before installing.");
  if (typeof preview.directory !== "string" || (preview.directory && !preview.directory.endsWith("/"))) throw new Error("Invalid skill source folder.");
  if (preview.directory) skillFile(resolve("skill"), preview.directory.slice(0, -1));
  const root = resolve(scope === "project" ? join(cwd, ".pi", "skills") : join(agentDir, "skills"));
  await mkdir(root, { recursive: true });
  const canonical = await realpath(root);
  const target = skillFile(canonical, preview.name);
  const lockPath = join(canonical, `.${preview.name}.install.lock`);
  let lock: FileHandle | undefined, stage: string | undefined;
  try {
    try { lock = await open(lockPath, "wx"); }
    catch (error) { if (hasErrorCode(error, "EEXIST")) throw new Error("This skill is already being installed. Try again when that finishes."); throw error; }
    try { await lstat(target); throw new Error("A skill with this name already exists. It was not replaced."); }
    catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
    stage = await mkdtemp(join(dirname(canonical), ".skill-install-"));
    const staging = stage;
    let next = 0, size = 0, failure: unknown;
    const download = async () => {
      while (next < preview.files.length && !failure) {
        const file = preview.files[next++];
        try {
          signal?.throwIfAborted();
          const destination = skillFile(staging, file.path);
          const bytes = await request(rawUrl(preview.source, preview.commit, preview.directory + file.path), { signal, fetchImpl });
          verifyBlob(bytes, file.sha);
          size += bytes.length;
          if (size > MAX_TOTAL) throw new Error("This skill is too large to install here.");
          if (file.path === "SKILL.md" && bytes.toString("utf8") !== preview.content) throw new Error("The skill changed after preview. Open it again before installing.");
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, bytes, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
        } catch (error) { failure ||= error; }
      }
    };
    // Drain every worker before cleanup so cancelled downloads cannot recreate staging files.
    await Promise.all(Array.from({ length: Math.min(4, preview.files.length) }, download));
    if (failure) throw failure;
    signal?.throwIfAborted();
    const metadata = { source: preview.source, commit: preview.commit, directory: preview.directory, installedAt: new Date().toISOString() };
    await writeFile(join(stage, SOURCE_FILE), JSON.stringify(metadata, null, 2), { flag: "wx" });
    try { await lstat(target); throw new Error("A skill with this name already exists. It was not replaced."); }
    catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
    signal?.throwIfAborted();
    const absoluteStage = resolve(stage);
    if (dirname(absoluteStage) !== dirname(canonical) || !basename(absoluteStage).startsWith(".skill-install-") || dirname(target) !== canonical) throw new Error("Invalid installation paths.");
    await rename(absoluteStage, target);
    stage = undefined;
    return { name: preview.name, path: target, scope };
  } finally {
    try {
      if (stage) {
        const absoluteStage = resolve(stage);
        if (dirname(absoluteStage) !== dirname(canonical) || !basename(absoluteStage).startsWith(".skill-install-")) throw new Error("Invalid temporary installation path.");
        await rm(absoluteStage, { recursive: true, force: true });
      }
    } finally { if (lock) { await lock.close(); await rm(lockPath, { force: true }); } }
  }
}
