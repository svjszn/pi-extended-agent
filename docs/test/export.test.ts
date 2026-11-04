import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { prepareExport } from '../scripts/prepare-export.ts';

test('static router assets resolve under the same URLs after a Windows or POSIX export', t => {
  const base = resolve('.next/export-tests'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-'));
  t.after(() => { assert.ok(resolve(root).startsWith(base + sep)); rmSync(root, { recursive: true, force: true }); });
  const route = join(root, 'guide', 'planning'); mkdirSync(join(route, '__next.$oc$mdxPath'), { recursive: true });
  const source = join(route, '__next.$oc$mdxPath', '__PAGE__.txt');
  writeFileSync(source, 'Static route payload');
  writeFileSync(join(route, '__next._tree.txt'), 'Native flat asset');
  assert.equal(prepareExport(root), 1);
  const requested = join(route, '__next.$oc$mdxPath.__PAGE__.txt');
  assert.equal(readFileSync(requested, 'utf8'), 'Static route payload');
  assert.equal(readFileSync(source, 'utf8'), 'Static route payload');
  assert.equal(readFileSync(join(route, '__next._tree.txt'), 'utf8'), 'Native flat asset');
  assert.equal(prepareExport(root), 0, 'preparation is repeatable');
  writeFileSync(requested, 'Unexpected existing data');
  assert.throws(() => prepareExport(root), /Conflicting/);
  assert.equal(readFileSync(requested, 'utf8'), 'Unexpected existing data');
});
