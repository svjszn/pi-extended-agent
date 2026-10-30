import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File descriptors also work in Windows environments that restrict process pipes.
export function captureCommand(executable, args, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-capture-'));
  const files = [join(directory, 'stdout'), join(directory, 'stderr')];
  const handles = [];
  try {
    for (const file of files) handles.push(openSync(file, 'w'));
    const result = spawnSync(executable, args, { ...options, stdio: ['ignore', ...handles] });
    const [stdout, stderr] = files.map((file) => readFileSync(file, options.encoding));
    return { ...result, stdout, stderr, output: [null, stdout, stderr] };
  } finally {
    for (const handle of handles) closeSync(handle);
    for (const file of files) if (existsSync(file)) unlinkSync(file);
    rmdirSync(directory);
  }
}
