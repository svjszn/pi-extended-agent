import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions, SpawnSyncOptionsWithBufferEncoding, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File descriptors also work in Windows environments that restrict process pipes.
export function captureCommand(executable: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function captureCommand(executable: string, args: readonly string[], options?: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer>;
export function captureCommand(executable: string, args: readonly string[], options: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>;
export function captureCommand(executable: string, args: readonly string[], options: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
  const directory = mkdtempSync(join(tmpdir(), 'pi-capture-'));
  const files: [string, string] = [join(directory, 'stdout'), join(directory, 'stderr')];
  const handles: number[] = [];
  try {
    for (const file of files) handles.push(openSync(file, 'w'));
    const result = spawnSync(executable, args, { ...options, stdio: ['ignore', ...handles] });
    const encoding = options.encoding === 'buffer' ? null : options.encoding;
    const stdout = readFileSync(files[0], encoding), stderr = readFileSync(files[1], encoding);
    return { ...result, stdout, stderr, output: [null, stdout, stderr] };
  } finally {
    for (const handle of handles) closeSync(handle);
    for (const file of files) if (existsSync(file)) unlinkSync(file);
    rmdirSync(directory);
  }
}
