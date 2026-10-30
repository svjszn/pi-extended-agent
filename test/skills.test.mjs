import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { installSkill, previewInstalledSkill, previewSkill, searchSkills, validSkillName } from "../dist/lib/skills.js";
import { createSkillsScreen } from "../dist/ui/skills-screen.js";
import { createUiTheme } from "../dist/ui/theme.js";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const measure = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
const fixtureRoot = resolve(fileURLToPath(new URL("../.local/skills-tests", import.meta.url)));
const commit = "1".repeat(40);
const content = "---\nname: sample-skill\ndescription: A sample skill for testing.\n---\n# Sample\n\nUse the bundled references.\n";
const blob = (bytes) => createHash("sha1").update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest("hex");
const item = { name: "sample-skill", skillId: "sample-skill", source: "acme/skills", installs: 1234 };

function fixture(t) {
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(join(fixtureRoot, "case-"));
  t.after(() => {
    assert.ok(resolve(directory).startsWith(fixtureRoot + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, cwd: join(directory, "project"), agentDir: join(directory, "profile"), projectTrusted: true };
}

function repository() {
  const files = new Map([
    ["SKILL.md", Buffer.from(content)], ["scripts/helper.js", Buffer.from("console.log('manual helper');\n")],
    ["references/naïve.md", Buffer.from("# Reference\n")], ["assets/data.bin", Buffer.from([0, 255, 1, 2])],
  ]);
  const tree = [...files].map(([path, bytes]) => ({ path: `skills/sample-skill/${path}`, type: "blob", mode: "100644", sha: blob(bytes), size: bytes.length }));
  const fetchImpl = async (url, options) => {
    options.signal.throwIfAborted();
    if (url === "https://api.github.com/repos/acme/skills/commits/HEAD") return Response.json({ sha: commit });
    if (url === `https://api.github.com/repos/acme/skills/git/trees/${commit}?recursive=1`) return Response.json({ tree });
    const prefix = `https://raw.githubusercontent.com/acme/skills/${commit}/skills/sample-skill/`;
    assert.ok(url.startsWith(prefix), `Unexpected URL: ${url}`);
    const path = decodeURIComponent(url.slice(prefix.length));
    assert.ok(files.has(path), `Unexpected source file: ${path}`);
    return new Response(files.get(path));
  };
  return { files, tree, fetchImpl };
}

test("catalog search encodes queries and rejects unsupported or unsafe sources", async () => {
  const results = await searchSkills("react testing", { async fetchImpl(url) {
    assert.equal(new URL(url).searchParams.get("q"), "react testing");
    return Response.json({ skills: [null, { ...item, name: "\x1b[31msample-skill\x1b[0m" }, { ...item, source: "https://other.example/repo" }, { ...item, skillId: "../escape" }] });
  } });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "sample-skill");
  assert.equal(results[0].source, "acme/skills");
  assert.deepEqual(await searchSkills("a", { fetchImpl: () => assert.fail("short query must not fetch") }), []);
  for (const name of ["../bad", "con", "nul", "a/b", "has space"]) assert.equal(validSkillName(name), false);
});

test("preview pins a revision and keeps the complete skill subtree", async () => {
  const repo = repository();
  const preview = await previewSkill(item, repo);
  assert.equal(preview.commit, commit);
  assert.equal(preview.content, content);
  assert.equal(preview.description, "A sample skill for testing.");
  assert.deepEqual(preview.files.map((file) => file.path), [...repo.files.keys()]);
  await assert.rejects(previewSkill({ ...item, skillId: "../../elsewhere" }, { fetchImpl: () => assert.fail("invalid source must not fetch") }), /public GitHub/);
  repo.tree.push({ path: "skills/sample-skill/link", type: "blob", mode: "120000", sha: "2".repeat(40), size: 3 });
  await assert.rejects(previewSkill(item, repo), /symlinks/);
});

test("installation copies verified files into the selected Pi scope and preserves existing skills", async (t) => {
  const options = fixture(t), repo = repository();
  const preview = await previewSkill(item, repo);
  const result = await installSkill(preview, { ...options, ...repo, scope: "global" });
  assert.equal(result.path, join(options.agentDir, "skills", "sample-skill"));
  for (const [path, bytes] of repo.files) assert.deepEqual(readFileSync(join(result.path, path)), bytes);
  assert.equal(JSON.parse(readFileSync(join(result.path, ".pi-extended-source.json"))).commit, commit);
  const installedPreview = await previewInstalledSkill({ ...result, filePath: join(result.path, "SKILL.md") });
  assert.equal(installedPreview.source, "acme/skills");
  assert.equal(installedPreview.commit, commit);
  assert.equal(loadSkillsFromDir({ dir: join(options.agentDir, "skills"), source: "user" }).skills[0].name, "sample-skill");
  assert.equal(existsSync(join(options.cwd, ".pi")), false);
  writeFileSync(join(result.path, "user.txt"), "Keep my changes");
  await assert.rejects(installSkill(preview, { ...options, ...repo, scope: "global" }), /already exists/);
  assert.equal(readFileSync(join(result.path, "user.txt"), "utf8"), "Keep my changes");
  assert.deepEqual(readdirSync(join(options.agentDir, "skills")), ["sample-skill"]);
});

test("untrusted projects and unsafe paths never activate a skill", async (t) => {
  const options = fixture(t), repo = repository(), preview = await previewSkill(item, repo);
  await assert.rejects(installSkill(preview, { ...options, scope: "project", projectTrusted: false }), /requires a trusted project/);
  assert.equal(existsSync(join(options.cwd, ".pi")), false);
  const malicious = { ...preview, files: [...preview.files, { path: "../escaped.txt", sha: blob("escape"), mode: "100644" }] };
  await assert.rejects(installSkill(malicious, { ...options, ...repo, scope: "project" }), /unsafe file path/);
  assert.equal(existsSync(join(options.cwd, ".pi", "escaped.txt")), false);
  assert.deepEqual(readdirSync(join(options.cwd, ".pi")), ["skills"]);
  assert.deepEqual(readdirSync(join(options.cwd, ".pi", "skills")), []);
});

test("checksum failures and cancellation clean partial downloads and release the install lock", async (t) => {
  const options = fixture(t), repo = repository(), preview = await previewSkill(item, repo);
  await assert.rejects(installSkill(preview, { ...options, scope: "project", fetchImpl: async () => new Response("tampered") }), /does not match/);
  const controller = new AbortController();
  let started;
  const helperStarted = new Promise((resolve) => { started = resolve; });
  const installation = installSkill(preview, { ...options, scope: "project", signal: controller.signal,
    fetchImpl: async (url, request) => {
      if (url.endsWith("scripts/helper.js")) {
        started();
        return new Promise((_resolve, reject) => {
          if (request.signal.aborted) { reject(new Error("aborted")); return; }
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return repo.fetchImpl(url, request);
    },
  });
  await helperStarted;
  controller.abort();
  await assert.rejects(installation, /Cancelled|aborted/);
  assert.deepEqual(readdirSync(join(options.cwd, ".pi")), ["skills"]);
  assert.deepEqual(readdirSync(join(options.cwd, ".pi", "skills")), []);
});

function screen(t, overrides = {}, options = {}) {
  let closed;
  const installed = { name: "existing-skill", description: "Already installed", filePath: "profile/skills/existing/SKILL.md", source: "local", scope: "global", installed: true };
  const panel = createSkillsScreen({ tui: { terminal: { rows: 30 }, requestRender() {} }, theme: createUiTheme(), measure, Input: measure.Input,
    done: (result) => { closed = result; }, projectTrusted: true, projectPath: "/project/.pi/skills", globalPath: "/profile/skills",
    services: {
      installed: () => [installed], search: async () => [item], preview: async () => ({ ...item, content, commit, files: [{ path: "SKILL.md" }] }),
      previewInstalled: async (item) => ({ ...item, content }), install: async (_item, scope) => ({ name: item.name, path: "/installed", scope }), ...overrides,
    }, ...options,
  });
  t.after(() => panel.dispose());
  return { panel, closed: () => closed };
}

test("skills screen searches, previews, chooses scope, and requests reload only after a successful install", async (t) => {
  let scope;
  const view = screen(t, { install: async (_item, location) => { scope = location; return { name: item.name, path: "/global/skill" }; } });
  const { panel } = view;
  await panel.ready;
  assert.match(measure.stripTerminalSequences(panel.render(80).join("\n")), /● existing-skill/);
  panel.handleInput("\t");
  panel.handleInput("sample");
  panel.handleInput("\r");
  await panel.whenIdle();
  assert.match(measure.stripTerminalSequences(panel.render(80).join("\n")), /○ sample-skill/);
  panel.handleInput("\r");
  await panel.whenIdle();
  assert.match(measure.stripTerminalSequences(panel.render(80).join("\n")), /SKILL.md/);
  panel.handleInput("\t");
  panel.handleInput("\r");
  await panel.whenIdle();
  assert.equal(scope, "global");
  assert.match(measure.stripTerminalSequences(panel.render(80).join("\n")), /Installed sample-skill/);
  panel.handleInput("\r");
  assert.equal(view.closed(), true);
});

test("installed skill preview is read-only, Esc goes back, and layouts fit narrow terminals", async (t) => {
  const view = screen(t, { install: () => assert.fail("installed skills must not be replaced") });
  const { panel } = view;
  await panel.ready;
  for (const width of [1, 8, 24, 80, 140]) assert.ok(panel.render(width).every((line) => measure.visibleWidth(line) <= width));
  panel.render(80);
  panel.handleInput("\r"); await panel.whenIdle();
  for (const width of [1, 8, 24, 80, 140]) {
    const lines = panel.render(width);
    assert.equal(lines.length, 30);
    assert.ok(lines.every((line) => measure.visibleWidth(line) <= width));
  }
  panel.handleInput("\x1b");
  assert.equal(view.closed(), undefined);
  assert.match(measure.stripTerminalSequences(panel.render(80).join("\n")), /Installed\s+Search/);
  panel.handleInput("\x1b");
  assert.equal(view.closed(), false);
});

test("search failures remain visible and untrusted project installation is blocked in the UI", async (t) => {
  const failed = screen(t, { search: async () => { throw new Error("Network unavailable"); } }, { initialQuery: "sample" });
  await failed.panel.ready; await failed.panel.whenIdle();
  assert.match(measure.stripTerminalSequences(failed.panel.render(80).join("\n")), /Network unavailable/);
  const view = screen(t, { install: () => assert.fail("untrusted project must not install") }, { initialQuery: "sample", projectTrusted: false });
  await view.panel.ready; await view.panel.whenIdle(); view.panel.render(80);
  view.panel.handleInput("\r"); await view.panel.whenIdle();
  view.panel.handleInput("\t"); // Global is the default for untrusted projects; choose project.
  view.panel.handleInput("\r"); await view.panel.whenIdle();
  assert.match(measure.stripTerminalSequences(view.panel.render(80).join("\n")), /reopen Pi and approve/);
});

test("closing skills cancels pending searches without installing anything", async (t) => {
  let signal;
  const view = screen(t, { search: async (_query, value) => {
    signal = value;
    return new Promise((_resolve, reject) => {
      if (signal.aborted) { reject(new Error("Cancelled")); return; }
      signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    });
  }, install: () => assert.fail("closing search must not install") }, { initialQuery: "sample" });
  await view.panel.ready;
  view.panel.handleInput("\x1b");
  await view.panel.whenIdle();
  assert.equal(signal.aborted, true);
  assert.equal(view.closed(), false);
});
