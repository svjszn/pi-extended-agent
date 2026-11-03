import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { commandFixture, present } from "./helpers.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PanelFactory } from "./helpers.ts";

const { ProjectEditor, TextBuffer, MAX_EDIT_BYTES } = await import(new URL("../dist/lib/project-editor.js", import.meta.url).href) as typeof import("../lib/project-editor.js");
const { readGitChanges, readFileDiff } = await import(new URL("../dist/lib/git-diff.js", import.meta.url).href) as typeof import("../lib/git-diff.js");
const { createNanoScreen, createDiffScreen } = await import(new URL("../dist/ui/files-screen.js", import.meta.url).href) as typeof import("../ui/files-screen.js");
const { default: files } = await import(new URL("../dist/extensions/files.js", import.meta.url).href) as typeof import("../extensions/files.js");
const { createUiTheme } = await import(new URL("../dist/ui/theme.js", import.meta.url).href) as typeof import("../ui/theme.js");
const { setAppearance, getAppearance } = await import(new URL("../dist/lib/appearance.js", import.meta.url).href) as typeof import("../lib/appearance.js");
const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");

function fixture(t: TestContext) {
  const base = resolve(".local/files-tests"); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "case-"));
  t.after(() => { assert.ok(resolve(cwd).startsWith(base + sep)); rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, project: new ProjectEditor(cwd) };
}
function frame(t: TestContext) {
  const tui = { terminal: { rows: 26 }, requestRender() {} }, result: unknown[] = [];
  return { tui, theme: createUiTheme(), measure, done: (value?: boolean) => { result.push(value); }, result,
    renderHeader: () => ["  Pi header"], renderFooter: () => ["  deny mode"] };
}
function repository(t: TestContext) {
  const f = fixture(t), git = (...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(f.cwd, "no-hooks")}`, ...args],
    { cwd: f.cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q", "--template="); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "false");
  return { ...f, git };
}

test("editor round trips tabs, BOM, final newlines, CRLF, CR, empty text and Unicode", t => {
  const { cwd, project } = fixture(t);
  for (const [index, text] of ["\uFEFF\tconst a = 'привет 😀';  \r\n\r\n", "tabs\tremain\n", "no final newline", "", "old\rstyle\r"].entries()) {
    const name = `file-${index}.txt`; writeFileSync(join(cwd, name), text, "utf8");
    const before = readFileSync(join(cwd, name)), doc = project.read(name);
    project.save(doc, doc.text);
    assert.deepEqual(readFileSync(join(cwd, name)), before);
    const saved = project.save(project.read(name), doc.text + "next\n");
    assert.equal(saved.text, doc.text + "next\n");
    assert.deepEqual(readdirSync(cwd).filter(name => name.endsWith(".pi-edit")), []);
  }
});

test("editor refuses lossy files and oversized input without changing bytes", t => {
  const { cwd, project } = fixture(t);
  for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from("binary\0text"), Buffer.from("a\r\nb\n"), Buffer.from("\x1b[31mtext"), Buffer.alloc(MAX_EDIT_BYTES + 1, 65)]) {
    writeFileSync(join(cwd, "file"), bytes);
    assert.throws(() => project.read("file")); assert.deepEqual(readFileSync(join(cwd, "file")), bytes);
  }
  writeFileSync(join(cwd, "file"), "original"); const doc = project.read("file");
  assert.throws(() => project.save(doc, "x".repeat(MAX_EDIT_BYTES + 1)), /exceeds/);
  assert.throws(() => project.save(doc, "a\0b"), /control/);
  assert.equal(readFileSync(join(cwd, "file"), "utf8"), "original");
});

test("editor detects changed, replaced, missing and hard-linked files before saving", t => {
  const { cwd, project } = fixture(t), path = join(cwd, "file");
  writeFileSync(path, "original"); let doc = project.read("file");
  writeFileSync(path, "external"); assert.throws(() => project.save(doc, "edits"), /changed on disk/);
  assert.equal(readFileSync(path, "utf8"), "external");
  doc = project.read("file"); renameSync(path, join(cwd, "old")); writeFileSync(path, "external");
  assert.throws(() => project.save(doc, "edits"), /changed on disk/);
  doc = project.read("file"); rmSync(path); assert.throws(() => project.save(doc, "edits"));
  writeFileSync(path, "original"); linkSync(path, join(cwd, "link"));
  assert.throws(() => project.save(project.read("file"), "edits"), /hard-linked/);
  assert.equal(readFileSync(join(cwd, "link"), "utf8"), "original");
});

test("save failure retains the original and removes only its own temporary file", t => {
  const { cwd, project } = fixture(t), path = join(cwd, "file"); writeFileSync(path, "original");
  const doc = project.read("file"), original = project.read.bind(project); let reads = 0;
  t.mock.method(project, "read", (name: string) => { if (++reads === 2) throw Error("Fixture pre-rename failure"); return original(name); });
  assert.throws(() => project.save(doc, "edits"), /pre-rename failure/);
  assert.equal(readFileSync(path, "utf8"), "original"); assert.deepEqual(readdirSync(cwd), ["file"]);
});

test("tree is lazy, includes hidden paths, and refuses escapes and redirected ancestors", t => {
  const { cwd, project } = fixture(t);
  mkdirSync(join(cwd, ".hidden")); mkdirSync(join(cwd, "folder")); writeFileSync(join(cwd, "file"), "text");
  assert.deepEqual(project.list().map(node => node.name), [".hidden", "folder", "file"]);
  assert.throws(() => project.path("../outside"), /inside/);
  assert.throws(() => project.read("."), /regular text/);
  if (process.platform === "win32") assert.throws(() => project.path("file:stream"), /Alternate data/);
  const outside = join(cwd, "outside"); mkdirSync(outside); writeFileSync(join(outside, "secret"), "fixture");
  symlinkSync(outside, join(cwd, "junction"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(project.list().find(node => node.name === "junction")?.kind, "link");
  assert.throws(() => project.read("junction/secret"), /links/);
});

test("text buffer inserts, deletes, navigates and undoes without corrupting Unicode or tabs", () => {
  const buffer = new TextBuffer("a😀\t\nsecond\n");
  const content = () => buffer.text;
  buffer.move("right"); buffer.move("right"); assert.equal(buffer.cursor, 3);
  buffer.erase(true); assert.equal(content(), "a\t\nsecond\n");
  buffer.history(true); assert.equal(content(), "a😀\t\nsecond\n");
  buffer.history(false); assert.equal(content(), "a\t\nsecond\n");
  buffer.move("down"); assert.equal(buffer.position.line, 1);
  buffer.insert("\t新\r\ntext"); assert.ok(buffer.text.includes("\t新\ntext"));
  assert.throws(() => buffer.insert("\x1b[31m"), /control/);
  const text = buffer.text; assert.throws(() => buffer.insert("x".repeat(MAX_EDIT_BYTES + 1)), /limit|exceeds/); assert.equal(buffer.text, text);
});

test("nano expands real folders, edits a selected file, preserves formatting and guards unsaved navigation", async t => {
  const { cwd, project } = fixture(t), ui = frame(t);
  mkdirSync(join(cwd, "folder")); writeFileSync(join(cwd, "folder", "file.ts"), "\tfirst\r\n"); writeFileSync(join(cwd, "z.txt"), "other");
  const panel = createNanoScreen({ ...ui, project }); t.after(() => panel.dispose()); await panel.ready;
  const text = () => measure.stripTerminalSequences(panel.render(100).join("\n"));
  assert.match(text(), /folder/); assert.doesNotMatch(text(), /file.ts/);
  panel.handleInput("\r"); assert.match(text(), /file.ts/);
  panel.handleInput("\x1b[B"); panel.handleInput("\r"); assert.match(text(), /first/);
  panel.handleInput("x"); panel.handleInput("\x1b[Z"); // Shift+Tab goes to the tree; Tab inserts indentation in the editor.
  panel.handleInput("\x1b"); assert.match(text(), /Unsaved edits/); assert.equal(ui.result.length, 0);
  panel.handleInput("\x1b"); panel.handleInput("\t"); panel.handleInput("\x13");
  assert.equal(readFileSync(join(cwd, "folder", "file.ts"), "utf8"), "x\tfirst\r\n");
  panel.handleInput("y"); panel.handleInput("\x1b"); panel.handleInput("\x1b"); panel.handleInput("\x04");
  assert.equal(ui.result.length, 1); assert.equal(readFileSync(join(cwd, "folder", "file.ts"), "utf8"), "x\tfirst\r\n");
});

test("nano retains unsaved text after a disk conflict, supports bracketed paste and explicit discard", async t => {
  const { cwd, project } = fixture(t), ui = frame(t); writeFileSync(join(cwd, "file"), "original");
  const panel = createNanoScreen({ ...ui, project, initial: "file" }); t.after(() => panel.dispose()); await panel.ready;
  panel.handleInput("\x1b[200~pasted\t😀\n"); panel.handleInput("tail\x1b[201~");
  writeFileSync(join(cwd, "file"), "external"); panel.handleInput("\x13");
  const text = () => measure.stripTerminalSequences(panel.render(120).join("\n"));
  assert.match(text(), /changed on disk/); assert.match(text(), /pasted/); assert.equal(readFileSync(join(cwd, "file"), "utf8"), "external");
  panel.handleInput("\x03"); assert.equal(ui.result.length, 0);
  panel.handleInput("\x04"); assert.equal(ui.result.length, 1);
});

test("file screens fit both palettes and tiny terminals while keeping long-line cursors visible", async t => {
  const { cwd, project } = fixture(t), ui = frame(t); writeFileSync(join(cwd, "file"), "\t😀 long line " + "a".repeat(500) + "\n".repeat(30));
  const appearance = getAppearance(); t.after(() => setAppearance(appearance));
  const panel = createNanoScreen({ ...ui, project, initial: "file" }); t.after(() => panel.dispose()); await panel.ready;
  panel.handleInput("\x1b[F");
  for (const mode of ["dark", "light"] as const) {
    setAppearance({ ...appearance, mode });
    for (const [width, height] of [[120, 30], [74, 24], [24, 12], [8, 8], [1, 4]]) {
      ui.tui.terminal.rows = height; const lines = panel.render(width);
      assert.equal(lines.length, height); assert.ok(lines.every(line => measure.visibleWidth(line) <= width));
    }
  }
});

test("nano draws a software cursor on text, tabs, Unicode, empty lines and scrolled line ends", async t => {
  const { cwd, project } = fixture(t), appearance = getAppearance();
  t.after(() => setAppearance(appearance));
  const cases = [
    { text: "abc", keys: [], glyph: "a" },
    { text: "abc", keys: ["\x1b[C"], glyph: "b" },
    { text: "abc", keys: ["\x1b[F"], glyph: " " },
    { text: "", keys: [], glyph: " " },
    { text: "a\n", keys: ["\x1b[B"], glyph: " " },
    { text: "\ttext", keys: [], glyph: " " },
    { text: "😀text", keys: [], glyph: "😀" },
    { text: "e\u0301text", keys: [], glyph: "e\u0301" },
    { text: "e\u0301text", keys: ["\x1b[C"], glyph: " \u0301" },
    { text: "x".repeat(200), keys: ["\x1b[F"], glyph: " " },
    { text: "x".repeat(200) + "😀", keys: ["\x1b[F", "\x1b[D"], glyph: "😀" },
  ];
  for (const mode of ["dark", "light"] as const) for (const width of [120, 74, 24]) for (const item of cases) {
    setAppearance({ ...appearance, mode });
    const ui = frame(t); writeFileSync(join(cwd, "cursor.txt"), item.text);
    const panel = createNanoScreen({ ...ui, project, initial: "cursor.txt" });
    try {
      await panel.ready; panel.focused = true;
      for (const key of item.keys) panel.handleInput(key);
      const lines = panel.render(width), output = lines.join("\n");
      assert.ok(output.includes(measure.renderFakeCursor(item.glyph)), `Missing ${JSON.stringify(item.glyph)} at ${mode}/${width}`);
      const cursor = lines.find(line => line.includes(measure.CURSOR_MARKER)); assert.ok(cursor);
      const col = measure.visibleWidth(cursor.slice(0, cursor.indexOf(measure.CURSOR_MARKER)));
      assert.ok(col < width && col >= 2); assert.equal(output.split(measure.CURSOR_MARKER).length - 1, 1);
      panel.handleInput("\x1b[Z");
      assert.equal(panel.render(width).join("\n").includes(measure.renderFakeCursor(item.glyph)), false, "the text cursor is hidden while the tree has focus");
      assert.equal(readFileSync(join(cwd, "cursor.txt"), "utf8"), item.text);
    } finally { panel.dispose(); }
  }
});

test("Pi's actual fullscreen renderer displays the nano cursor with either hardware cursor setting", async t => {
  const { cwd, project } = fixture(t); writeFileSync(join(cwd, "file"), "abc");
  for (const hardware of [false, true]) {
    const writes: string[] = [];
    const terminal: import("@earendil-works/pi-tui").Terminal = {
      columns: 100, rows: 26, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write: value => { writes.push(value); },
      moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    const tui = new measure.TuiAltScreen(terminal, hardware, undefined, { mouse: false });
    const panel = createNanoScreen({ ...frame(t), tui, project, initial: "file" });
    await panel.ready;
    const overlay = tui.showOverlay(panel, { width: "100%", maxHeight: "100%", row: 0, col: 0 });
    try {
      tui.start(); tui.renderNow(true);
      const output = writes.join("");
      if (hardware) { assert.match(output, /\x1b\[\?25h/); assert.doesNotMatch(output, /\x1b\[7ma\x1b\[27m/); }
      else { assert.match(output, /\x1b\[7ma\x1b\[27m/); assert.doesNotMatch(output, /\x1b\[\?25h/); }
      assert.equal(output.includes(measure.CURSOR_MARKER), false, "cursor placement metadata is consumed by the renderer");
    } finally { overlay.hide(); panel.dispose(); tui.stop({ preserveScreen: true }); }
  }
});

test("Git views distinguish staged, unstaged, untracked, renamed, deleted and literal path changes", async t => {
  const { cwd, git } = repository(t);
  for (const name of ["a.ts", "delete.ts", "old name.ts", "[literal].ts"]) writeFileSync(join(cwd, name), "original\n");
  git("add", "."); git("-c", "user.useConfigOnly=true", "commit", "-qm", "fixture", "--no-verify");
  writeFileSync(join(cwd, "a.ts"), "staged\n"); git("add", "a.ts"); writeFileSync(join(cwd, "a.ts"), "working\n");
  git("mv", "old name.ts", "new name.ts"); rmSync(join(cwd, "delete.ts"));
  writeFileSync(join(cwd, "untracked.ts"), "new\n"); writeFileSync(join(cwd, "empty"), ""); writeFileSync(join(cwd, "[literal].ts"), "literal\n");
  const index = readFileSync(join(cwd, ".git", "index"));
  const working = await readGitChanges(cwd), staged = await readGitChanges(cwd, true);
  assert.deepEqual(staged.files.map(file => file.path).sort(), ["a.ts", "new name.ts"]);
  assert.ok(working.files.some(file => file.path === "delete.ts" && file.status === "D"));
  assert.ok(working.files.some(file => file.path === "untracked.ts" && file.untracked));
  assert.match((await readFileDiff(working, present(working.files.find(file => file.path === "a.ts")))).join("\n"), /-staged\n\+working/);
  assert.match((await readFileDiff(staged, present(staged.files.find(file => file.path === "a.ts")))).join("\n"), /-original\n\+staged/);
  const renamed = present(staged.files.find(file => file.path === "new name.ts")); assert.equal(renamed.previous, "old name.ts");
  assert.match((await readFileDiff(staged, renamed)).join("\n"), /original/);
  assert.match((await readFileDiff(working, present(working.files.find(file => file.path === "untracked.ts")))).join("\n"), /\+new/);
  assert.deepEqual(await readFileDiff(working, present(working.files.find(file => file.path === "empty"))), ["Untracked empty file: empty"]);
  const filtered = await readGitChanges(cwd, false, "[literal].ts"); assert.deepEqual(filtered.files.map(file => file.path), ["[literal].ts"]);
  await assert.rejects(readGitChanges(cwd, false, "../outside"), /inside/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(readGitChanges(cwd, false, undefined, controller.signal), /cancelled/);
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index, "read-only Git inspection must not rewrite the index");
});

test("Git handles an unborn branch and a plain folder without a provider or Git mutation", async t => {
  const repo = repository(t); writeFileSync(join(repo.cwd, "first"), "new"); repo.git("add", "first");
  const changes = await readGitChanges(repo.cwd, true); assert.equal(changes.files.length, 1);
  assert.match((await readFileDiff(changes, changes.files[0])).join("\n"), /\+new/);
  const plain = fixture(t), previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(plain.cwd);
  try { await assert.rejects(readGitChanges(plain.cwd), /not a Git working tree/); }
  finally { if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previous; }
});

test("diff screen switches staged views, navigates long lines and disposes pending reads", async t => {
  const { cwd, git } = repository(t), ui = frame(t);
  const original = "a".repeat(160) + "TAIL\n";
  writeFileSync(join(cwd, "file"), original); git("add", ".");
  const panel = createDiffScreen({ ...ui, cwd, staged: true }); t.after(() => panel.dispose()); await panel.ready;
  const text = () => measure.stripTerminalSequences(panel.render(100).join("\n"));
  const waitFor = async (pattern: RegExp) => {
    const deadline = Date.now() + 5000;
    while (!pattern.test(text()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(text(), pattern);
  };
  assert.match(text(), /\+aaa/); assert.doesNotMatch(text(), /TAIL/);
  for (let i = 0; i < 20; i++) panel.handleInput("\x1b[C");
  assert.match(text(), /TAIL/);
  panel.handleInput("1"); await waitFor(/No changes/);
  panel.handleInput("2"); await waitFor(/\+aaa/);
  for (const [width, height] of [[100, 30], [24, 12], [1, 4]]) {
    ui.tui.terminal.rows = height; const lines = panel.render(width); assert.equal(lines.length, height);
    assert.ok(lines.every(line => measure.visibleWidth(line) <= width));
  }
  panel.handleInput("1"); panel.dispose(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(readFileSync(join(cwd, "file"), "utf8"), original);
});

test("file commands use cwd, require an idle TUI, and close on replacement without writing session state", async t => {
  const { cwd } = fixture(t), commands = new Map<string, ReturnType<typeof commandFixture>>(), handlers = new Map();
  const notices: string[] = []; let opened = 0, closed = 0;
  const pi = { on: (name: string, callback: unknown) => { handlers.set(name, callback); }, registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, commandFixture(command)), getThinkingLevel: () => "low" };
  files(pi as unknown as ExtensionAPI);
  const ctx = { cwd, mode: "print", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "fixture" },
    ui: { notify: (text: string) => notices.push(text), custom: async (create: PanelFactory) => {
      const ui = frame(t), panel = create({ ...ui.tui, children: [] }, ui.theme, {}, () => { closed++; });
      opened++; await panel.ready; assert.match(measure.stripTerminalSequences(panel.render(80).join("\n")), /Nano/);
      handlers.get("session_shutdown")(); panel.dispose(); return false;
    } },
  };
  await present(commands.get("nano")).handler("", ctx); assert.equal(opened, 0); assert.match(present(notices.at(-1)), /interactive/);
  ctx.mode = "tui"; ctx.isIdle = () => false;
  await present(commands.get("diff")).handler("", ctx); assert.equal(opened, 0); assert.match(present(notices.at(-1)), /finish/);
  ctx.isIdle = () => true; await present(commands.get("nano")).handler("", ctx); assert.equal(opened, 1); assert.equal(closed, 1);
  const stale = present(commands.get("nano")).handler("", ctx);
  handlers.get("session_shutdown")(); await stale;
  assert.equal(opened, 1, "session replacement during lazy loading must not mount a stale screen");
  assert.deepEqual(readdirSync(cwd), []);
});
