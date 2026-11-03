import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { object, string, browserMessage, browserHistory } from "./web-types.js";
import type { WebChat, WebHistory, WebMessage, WebPart } from "./web-types.js";
import { normalizePermissionMode } from "./permissions.js";

const MAX_FILE = 16 * 1024 * 1024;
const MAX_TEXT = 256_000;
export const chatKey = (path: string) => createHash("sha256").update(resolve(path)).digest("hex").slice(0, 32);
const printable = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
export function webText(value: unknown, limit = MAX_TEXT) {
  const text = printable(string(value));
  return text.length > limit ? text.slice(0, limit) + "\n[Text shortened for the browser]" : text;
}
export function webInput(value: unknown) { return webText(typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2)); }
export function webMessage(value: unknown, id: string): WebMessage {
  const message = object(value), parts: WebPart[] = [];
  if (typeof message.content === "string") parts.push({ type: "text", text: webText(message.content) });
  else if (Array.isArray(message.content)) for (const block of message.content.slice(0, 200)) {
    const item = object(block);
    if (item.type === "text") parts.push({ type: "text", text: webText(item.text) });
    else if (item.type === "thinking") parts.push({ type: "thinking", text: webText(item.thinking) });
    else if (item.type === "toolCall") parts.push({ type: "tool", id: string(item.id), name: string(item.name), input: webInput(item.arguments) });
    else if (item.type === "image") parts.push({ type: "image", text: "Image attachment (view in Pi's terminal)" });
  }
  if (message.errorMessage) parts.push({ type: "text", text: webText(message.errorMessage) });
  return browserMessage({ id, role: string(message.role, "system"), parts, error: message.isError === true || message.stopReason === "error" });
}

/** Project only the selected branch. Custom policy data and provider configuration never leave the server. */
export function webProjection(values: unknown[], leafId?: string | null): Pick<WebHistory, "messages" | "permissions" | "workMode"> {
  const entries = values.map(object), byId = new Map(entries.filter(entry => typeof entry.id === "string").map(entry => [String(entry.id), entry]));
  const path: Record<string, unknown>[] = [], visited = new Set<string>();
  let current = leafId === null ? undefined : leafId ? byId.get(leafId) : entries.at(-1);
  if (current && typeof current.id === "string") {
    while (current && path.length < 50_000) {
      const id = string(current.id); if (visited.has(id)) throw new Error("The session contains a cyclic branch.");
      visited.add(id); path.push(current); current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
    }
    path.reverse();
  } else if (leafId !== null) path.push(...entries); // Legacy linear sessions.
  const edits = new Map<string, unknown>();
  for (const entry of path) if (entry.type === "context_edit") edits.set(string(entry.targetId), entry.replacement);
  const messages: WebMessage[] = []; let permissions = "allow", workMode = "auto";
  for (const entry of path) {
    if (entry.type === "custom" && entry.customType === "pi-extended-permissions") permissions = normalizePermissionMode(object(entry.data).mode) ?? permissions;
    if (entry.type === "custom" && entry.customType === "pi-extended-code-mode") workMode = object(entry.data).enabled === true ? "code" : "auto";
    if (entry.type === "custom" && entry.customType === "pi-extended-plan") {
      const status = object(entry.data).status; workMode = status === "planning" || status === "ready" ? "plan" : "auto";
    }
    if (entry.type === "message" || entry.type === "custom_message" && entry.display === true) {
      let message = entry.type === "message" ? object(entry.message) : { role: "system", content: entry.content };
      if (edits.has(string(entry.id))) {
        const replacement = edits.get(string(entry.id)); if (replacement === null) continue;
        message = { ...message, content: object(replacement).content };
      }
      messages.push(webMessage(message, string(entry.id, `history-${messages.length}`)));
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      messages.push({ id: string(entry.id), role: "system", parts: [{ type: "text", text: `${entry.type === "compaction" ? "Context compacted" : "Branch summary"}\n${webText(entry.summary)}` }] });
    }
  }
  return { messages, permissions, workMode };
}

export class WebSessions {
  private paths = new Map<string, string>();
  private cached?: { at: number; chats: WebChat[]; skipped: number };
  private scanning?: Promise<{ chats: WebChat[]; skipped: number }>;
  readonly roots: string[];
  constructor(agentDir: string, extraSessionDir?: string) { this.roots = [join(resolve(agentDir), "sessions"), ...(extraSessionDir ? [resolve(extraSessionDir)] : [])]; }
  invalidate() { this.cached = undefined; }
  async safe(path: string, allowMissing = false) {
    const absolute = resolve(path);
    for (const root of this.roots) {
      const rel = relative(root, absolute);
      if (isAbsolute(rel) || !rel || rel === ".." || rel.startsWith(`..${sep}`) || !absolute.endsWith(".jsonl")) continue;
      // Profile may itself be a user-selected link; everything from sessions/ down must be real.
      let part = root;
      for (const segment of ["", ...rel.split(sep)]) {
        if (segment) part = join(part, segment);
        try { if ((await lstat(part)).isSymbolicLink()) throw new Error("Session links are not opened."); }
        catch (error) { if (allowMissing && object(error).code === "ENOENT") return absolute; throw error; }
      }
      return absolute;
    }
    throw new Error("This session is outside the active profile.");
  }
  async register(path: string) { const safe = await this.safe(path, true), id = chatKey(safe); this.paths.set(id, safe); return id; }
  async resolve(id: string) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Unknown chat.");
    if (!this.paths.has(id)) await this.list();
    const path = this.paths.get(id); if (!path) throw new Error("Unknown chat.");
    return this.safe(path);
  }
  private async read(path: string): Promise<WebHistory> {
    await this.safe(path);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await file.stat(); if (!stat.isFile() || stat.size > MAX_FILE) throw new Error("Session is not a regular file of 16 MiB or less.");
      const buffer = Buffer.alloc(stat.size + 1); let length = 0;
      while (length < buffer.length) { const result = await file.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
      if (length > stat.size) throw new Error("Session changed while reading. Refresh the chat list.");
      await this.safe(path); const current = await lstat(path);
      if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error("Session changed while reading.");
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)), records: unknown[] = [];
      const lines = raw.split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch { if (index !== lines.length - 1 || raw.endsWith("\n")) throw new Error("Session JSON is damaged."); }
        if (records.length > 50_000) throw new Error("Session contains too many entries.");
      }
      const header = object(records.shift());
      if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") throw new Error("Invalid session header.");
      if (typeof header.version === "number" && header.version > 3) throw new Error("This session uses a newer format.");
      const projection = webProjection(records), entries = records.map(object);
      const preview = projection.messages.find(message => message.role === "user")?.parts.find(part => part.type === "text")?.text ?? "";
      const name = entries.findLast(entry => entry.type === "session_info");
      return { chat: { id: chatKey(path), sessionId: webText(header.id, 120), cwd: webText(header.cwd, 4000),
        title: webText(object(name).name, 180) || preview.replace(/\s+/g, " ").slice(0, 100) || "Untitled chat", preview: preview.slice(0, 240),
        modified: stat.mtimeMs, count: projection.messages.filter(message => message.role === "user" || message.role === "assistant").length }, ...projection, messages: browserHistory(projection.messages) };
    } finally { await file.close(); }
  }
  async history(id: string) { return this.read(await this.resolve(id)); }
  async list() {
    if (this.cached && Date.now() - this.cached.at < 5000) return this.cached;
    if (this.scanning) return this.scanning;
    this.scanning = this.scan();
    try { const result = await this.scanning; this.cached = { ...result, at: Date.now() }; return result; }
    finally { this.scanning = undefined; }
  }
  private async scan() {
    const files: { path: string; modified: number; size: number }[] = []; const seen = new Set<string>(); let skipped = 0, directories = 0;
    const visit = async (dir: string, depth: number) => {
      if (++directories > 1000 || files.length >= 5000) { skipped++; return; }
      try {
        if ((await lstat(dir)).isSymbolicLink()) { skipped++; return; }
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries.slice(0, 5000)) {
          if (files.length >= 5000) { skipped++; break; }
          const path = join(dir, entry.name);
          if (entry.isSymbolicLink()) { skipped++; continue; }
          if (entry.isDirectory() && depth === 0) await visit(path, 1);
          else if (entry.isFile() && entry.name.endsWith(".jsonl") && !seen.has(path)) { const stat = await lstat(path); seen.add(path); files.push({ path, modified: stat.mtimeMs, size: stat.size }); }
        }
        skipped += Math.max(0, entries.length - 5000);
      } catch (error) { if (object(error).code !== "ENOENT") skipped++; }
    };
    for (const root of this.roots) await visit(root, 0);
    files.sort((a, b) => b.modified - a.modified); skipped += Math.max(0, files.length - 1000);
    const chats: WebChat[] = []; let budget = 128 * 1024 * 1024;
    for (const file of files.slice(0, 1000)) {
      if (file.size > MAX_FILE || file.size > budget) { skipped++; continue; }
      budget -= file.size;
      try { const history = await this.read(file.path); this.paths.set(history.chat.id, file.path); chats.push(history.chat); }
      catch { skipped++; }
    }
    return { chats, skipped };
  }
}
