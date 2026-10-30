import { cpSync, existsSync } from 'node:fs';

export function syncSearch() {
  if (!existsSync('out/_pagefind/pagefind.js')) throw new Error('Build the Pagefind index before syncing search.');
  cpSync('out/_pagefind', 'public/_pagefind', { recursive: true });
}

syncSearch();
