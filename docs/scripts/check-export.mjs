import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';

const root = resolve('out');
const basePath = process.env.DOCS_BASE_PATH ?? '';
const html = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith('.html')) html.push(file);
  }
}
walk(root);
assert.ok(html.length >= 16, 'Documentation pages are missing from the export.');
for (const file of html) {
  const content = readFileSync(file, 'utf8');
  for (const tag of content.matchAll(/<(?:a|link|script|img|source)\b[^>]*>/g)) {
    for (const attribute of tag[0].matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const href = attribute[1].replaceAll('&amp;', '&');
      if (!href.startsWith('/') || href.startsWith('//')) continue;
      const pathname = decodeURIComponent(new URL(href, 'https://docs.invalid').pathname);
      assert.ok(!basePath || pathname === basePath || pathname.startsWith(`${basePath}/`), `${file}: link misses base path: ${href}`);
      const path = pathname.slice(basePath.length).replace(/^\/+/, '');
      const target = resolve(root, path);
      const rel = relative(root, target);
      assert.ok(!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== '..', `Link leaves export: ${href}`);
      assert.ok([target, join(target, 'index.html'), `${target}.html`].some((path) => existsSync(path) && statSync(path).isFile()), `${file}: broken link or asset: ${href}`);
    }
  }
}
assert.ok(existsSync(join(root, '_pagefind/pagefind.js')), 'Pagefind search bundle is missing.');
assert.ok(existsSync(join(root, '.nojekyll')), 'GitHub Pages marker is missing.');
console.log(`Verified ${html.length} exported HTML pages, internal links, assets, and search bundle (${basePath || '/'}).`);
