import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bindCompiledExtensionImports } from "../dist/bin/extension-runtime.js";

// Deliberately different APIs: using this wrapper's dependency instead of the
// selected managed engine must be observable, without installing another Pi.
test("compiled extension binding selects the managed API, preserves scope and filenames, and disposes", async t => {
  const base = fileURLToPath(new URL("../.local/extension-runtime-tests/", import.meta.url));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "case-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (name, content) => {
    const file = join(directory, name); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, content); return file;
  };
  const dependency = "node_modules/@earendil-works/pi-coding-agent/";
  write(`${dependency}package.json`, JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module",
    exports: { ".": "./index.js", "./extra": "./extra.js" } }));
  write(`${dependency}index.js`, 'export const VERSION = "wrapper-sdk"; export class CustomEditor {}');
  write(`${dependency}extra.js`, 'export const extra = "subpath";');
  write("engine/package.json", '{"type":"module"}');
  const bundle = write("engine/dist/bundle/index.js", 'export const VERSION = "managed-engine"; export class CustomEditor {}');
  const root = join(directory, "wrapper");
  write("wrapper/package.json", '{"type":"module"}');
  write("project/package.json", '{"type":"module"}');
  const source = 'export { VERSION, CustomEditor } from "@earendil-works/pi-coding-agent"; export { extra } from "@earendil-works/pi-coding-agent/extra"; export const location = import.meta.url;';
  const owned = ["extensions", "lib", "ui"].map(name => write(`wrapper/dist/${name}/probe.js`, source));
  const outside = ["wrapper/dist/bin/probe.js", "wrapper/dist/ui-sibling/probe.js", "project/extension.js",
    "wrapper/node_modules/addon/probe.mjs"].map(name => write(name, source));
  const after = write("wrapper/dist/lib/after.js", source);
  const api = await import(pathToFileURL(bundle));
  const binding = bindCompiledExtensionImports({ packageDir: join(directory, "engine") }, root);
  try {
    for (const file of owned) {
      const module = await import(pathToFileURL(file));
      assert.equal(module.VERSION, "managed-engine"); assert.equal(module.CustomEditor, api.CustomEditor);
      assert.equal(module.extra, "subpath"); assert.equal(module.location, pathToFileURL(file).href);
    }
    for (const file of outside) {
      const module = await import(pathToFileURL(file));
      assert.equal(module.VERSION, "wrapper-sdk"); assert.notEqual(module.CustomEditor, api.CustomEditor);
    }
  } finally { binding.deregister(); }
  assert.equal((await import(pathToFileURL(after))).VERSION, "wrapper-sdk");
});
