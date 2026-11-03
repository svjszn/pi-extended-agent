import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_EDIT_BYTES = 1024 * 1024;
export interface FileNode { path: string; name: string; kind: "directory" | "file" | "link" | "other" }
export interface FileDocument {
  path: string; text: string; eol: "\n" | "\r\n" | "\r"; bom: boolean;
  hash: string; ino: number; dev: number; mode: number;
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const displayPath = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** A manual editor rooted at the command's cwd. Never traverse links or junctions. */
export class ProjectEditor {
  readonly root: string;
  constructor(cwd: string) { this.root = realpathSync(cwd); }
  path(name = "."): string {
    if (process.platform === "win32" && name.replace(/^[A-Za-z]:/, "").includes(":")) throw new Error("Alternate data streams are not supported.");
    const path = resolve(this.root, name), rel = relative(this.root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Choose a path inside the opened directory.");
    let part = this.root;
    if (lstatSync(part).isSymbolicLink()) throw new Error("The opened directory changed. Reopen /nano.");
    for (const segment of rel.split(sep).filter(Boolean)) {
      part = join(part, segment);
      if (lstatSync(part).isSymbolicLink()) throw new Error("Symbolic links and junctions are shown but not opened.");
    }
    if (realpathSync(path) !== path) throw new Error("The path changed. Reopen /nano.");
    return path;
  }
  list(name = "."): FileNode[] {
    const directory = this.path(name);
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length > 5000) throw new Error("This directory has more than 5,000 entries. Open a narrower path with /nano <directory>.");
    return entries.map(entry => ({ path: relative(this.root, join(directory, entry.name)), name: entry.name,
      kind: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" } satisfies FileNode))
      .sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
  }
  read(name: string): FileDocument {
    const path = this.path(name), initial = lstatSync(path);
    if (!initial.isFile()) throw new Error("Only regular text files can be opened.");
    if (initial.size > MAX_EDIT_BYTES) throw new Error("Files larger than 1 MiB cannot be edited here.");
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error("Only regular text files can be opened.");
      if (stat.size > MAX_EDIT_BYTES) throw new Error("Files larger than 1 MiB cannot be edited here.");
      const storage = Buffer.alloc(MAX_EDIT_BYTES + 1); let length = 0;
      while (length < storage.length) {
        const size = readSync(fd, storage, length, storage.length - length, null);
        if (size === 0) break; length += size;
      }
      const bytes = storage.subarray(0, length);
      if (bytes.length > MAX_EDIT_BYTES) throw new Error("The file grew beyond 1 MiB. Reopen a smaller file.");
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let text: string;
      try { text = decoded.decode(bytes); } catch { throw new Error("This file is not UTF-8 text."); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) throw new Error("Binary files and text with terminal control characters cannot be edited here.");
      const bom = text.startsWith("\uFEFF"); if (bom) text = text.slice(1);
      const endings = new Set(text.match(/\r\n|\r|\n/g) ?? []);
      if (endings.size > 1) throw new Error("Mixed line endings are not supported. Use an external editor for this file.");
      this.path(name);
      const current = lstatSync(path);
      if (stat.ino !== current.ino || stat.dev !== current.dev || stat.size !== bytes.length || current.size !== bytes.length) throw new Error("The file changed while opening. Try again.");
      return { path: relative(this.root, path), text: text.replace(/\r\n|\r/g, "\n"), eol: (endings.values().next().value ?? "\n") as FileDocument["eol"], bom,
        hash: hash(bytes), ino: stat.ino, dev: stat.dev, mode: stat.mode };
    } finally { closeSync(fd); }
  }
  save(document: FileDocument, text: string): FileDocument {
    if (Buffer.byteLength(text, "utf8") > MAX_EDIT_BYTES) throw new Error("The edited file exceeds 1 MiB.");
    if (/[\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) throw new Error("Unsupported control characters in the edited text.");
    const bytes = Buffer.from((document.bom ? "\uFEFF" : "") + text.replace(/\n/g, document.eol), "utf8");
    if (bytes.length > MAX_EDIT_BYTES) throw new Error("The encoded file exceeds 1 MiB.");
    const verify = () => {
      const current = this.read(document.path);
      if (current.hash !== document.hash || current.ino !== document.ino || current.dev !== document.dev) {
        throw new Error("The file changed on disk. Your edits are kept; reopen the file after copying or discarding them.");
      }
      if (lstatSync(this.path(document.path)).nlink > 1) throw new Error("Saving hard-linked files is not supported.");
    };
    verify();
    const path = this.path(document.path);
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.pi-edit`);
    let created = false;
    try {
      const fd = openSync(temp, "wx", document.mode & 0o777); created = true;
      try { writeFileSync(fd, bytes); fchmodSync(fd, document.mode & 0o777); fsyncSync(fd); } finally { closeSync(fd); }
      verify();
      renameSync(temp, path); created = false;
      return this.read(document.path);
    } finally { if (created && existsSync(temp)) unlinkSync(temp); }
  }
}

/** Logical lines retain tabs, trailing spaces and the final newline exactly. */
export class TextBuffer {
  text: string;
  cursor = 0;
  private undo: { text: string; cursor: number }[] = [];
  private redo: { text: string; cursor: number }[] = [];
  constructor(text: string) { this.text = text; }
  get position() {
    const before = this.text.slice(0, this.cursor), start = before.lastIndexOf("\n") + 1;
    return { line: before.split("\n").length - 1, col: this.cursor - start, start };
  }
  replace(start: number, end: number, value: string) {
    const next = this.text.slice(0, start) + value + this.text.slice(end);
    if (Buffer.byteLength(next, "utf8") > MAX_EDIT_BYTES) throw new Error("The edited file exceeds 1 MiB.");
    this.undo.push({ text: this.text, cursor: this.cursor });
    // Bound undo memory as well as the number of snapshots.
    while (this.undo.length > 100 || this.undo.reduce((size, item) => size + item.text.length, 0) > 4 * MAX_EDIT_BYTES) this.undo.shift();
    this.redo = []; this.text = next; this.cursor = start + value.length;
  }
  insert(value: string) {
    const text = value.replace(/\r\n|\r/g, "\n");
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) throw new Error("Paste contains unsupported control characters.");
    this.replace(this.cursor, this.cursor, text);
  }
  move(direction: "left" | "right" | "up" | "down" | "home" | "end") {
    const { start, col } = this.position;
    const lineEnd = this.text.indexOf("\n", this.cursor), end = lineEnd < 0 ? this.text.length : lineEnd;
    if (direction === "home") this.cursor = start;
    else if (direction === "end") this.cursor = end;
    else if (direction === "left") {
      const char = Array.from(this.text.slice(0, this.cursor)).at(-1); this.cursor -= char?.length ?? 0;
    } else if (direction === "right") this.cursor += Array.from(this.text.slice(this.cursor))[0]?.length ?? 0;
    else if (direction === "up" && start > 0) {
      const previous = this.text.lastIndexOf("\n", start - 2) + 1; this.cursor = Math.min(previous + col, start - 1);
    } else if (direction === "down" && end < this.text.length) {
      const nextEnd = this.text.indexOf("\n", end + 1); this.cursor = Math.min(end + 1 + col, nextEnd < 0 ? this.text.length : nextEnd);
    }
    // A vertical move must never split a surrogate pair.
    if (this.cursor > 0 && /[\uD800-\uDBFF]/.test(this.text[this.cursor - 1]) && /[\uDC00-\uDFFF]/.test(this.text[this.cursor] ?? "")) this.cursor--;
  }
  erase(backward: boolean) {
    const previous = this.cursor; this.move(backward ? "left" : "right");
    const next = this.cursor; this.cursor = previous;
    if (previous !== next) this.replace(Math.min(previous, next), Math.max(previous, next), "");
  }
  history(backward: boolean) {
    const source = backward ? this.undo : this.redo, target = backward ? this.redo : this.undo;
    const entry = source.pop(); if (!entry) return;
    target.push({ text: this.text, cursor: this.cursor }); this.text = entry.text; this.cursor = entry.cursor;
  }
}
