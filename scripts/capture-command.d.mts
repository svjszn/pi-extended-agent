import type { SpawnSyncOptions, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
export function captureCommand(executable: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function captureCommand(executable: string, args: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<Buffer>;
