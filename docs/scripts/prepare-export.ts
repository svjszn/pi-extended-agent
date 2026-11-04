import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Next's static router URLs use dots; Windows exports can retain directory separators. */
export function prepareExport(directory = resolve('out')) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error('The export directory must not be a file link.');
  let aliases = 0;
  function visit(path: string, segment?: { root: string; names: string[] }) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Export assets must not be file links.');
      if (entry.isDirectory()) visit(file, segment ? { root: segment.root, names: [...segment.names, entry.name] }
        : entry.name.startsWith('__next.') ? { root: path, names: [entry.name] } : undefined);
      else if (segment && entry.name.endsWith('.txt')) {
        const alias = join(segment.root, [...segment.names, entry.name].join('.')), data = readFileSync(file);
        if (existsSync(alias)) {
          if (lstatSync(alias).isSymbolicLink() || !readFileSync(alias).equals(data)) throw new Error(`Conflicting static router asset: ${alias}`);
        } else { writeFileSync(alias, data, { flag: 'wx' }); aliases++; }
      }
    }
  }
  visit(directory); return aliases;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Prepared ${prepareExport()} static router asset aliases.`);
}
