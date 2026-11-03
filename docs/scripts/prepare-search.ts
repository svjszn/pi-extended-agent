import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('public/_pagefind/pagefind.js')) {
  if (existsSync('out/_pagefind/pagefind.js')) await import('./sync-search.ts');
  else {
    console.log('Building the documentation search index for local development…');
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Run this script with npm run dev.');
    const result = spawnSync(process.execPath, [npm, 'run', 'build'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
