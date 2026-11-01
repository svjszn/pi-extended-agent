import assert from "node:assert/strict";

/** Production extensions must be individually reviewed; no directory/glob discovery. */
export function productionExtensions(manifest) {
  const entries = manifest.pi?.extensions;
  assert.ok(Array.isArray(entries) && entries.length > 0, "Declare the production extension allowlist.");
  assert.ok(entries.every((entry) => typeof entry === "string" && /^\.\/dist\/extensions\/[a-z0-9-]+\.js$/.test(entry)),
    "Production extensions must be explicit ./dist/extensions/NAME.js files.");
  const files = entries.map((entry) => entry.slice(2));
  assert.equal(new Set(files).size, files.length, "Duplicate production extensions.");
  return files;
}

export function assertProductionOutput(files, manifest) {
  const extensions = productionExtensions(manifest);
  for (const file of extensions) assert.ok(files.includes(file), `Missing production extension: ${file}`);
  const allowed = new Set(extensions.flatMap((file) => [file, `${file}.map`]));
  for (const file of files) {
    if (file.startsWith("dist/extensions/")) assert.ok(allowed.has(file), `Unexpected production extension output: ${file}`);
    assert.ok(!/(^|\/)(?:dev|performance)(\/|\.)|(^|\/)performance-view\./i.test(file), `Development diagnostics must not ship: ${file}`);
  }
}

export function assertPackageFiles(files, manifest) {
  assertProductionOutput(files, manifest);
  for (const required of ["bin/pi.mjs", "dist/bin/main.js", "dist/bin/verify-runtime.js", "README.md", "CHANGELOG.md", "LICENSE"]) {
    assert.ok(files.includes(required), `Missing package file: ${required}`);
  }
  assert.ok(files.every((file) => !/(^|\/)(?:\.env(?:\..*)?|auth\.json|\.local|node_modules|test)(\/|$)/.test(file)),
    "Package includes local/private files.");
  assert.ok(files.every((file) => !/^(?:docs|dev|profile|scripts|\.github)\//.test(file)), "Package includes development-only files.");
}
