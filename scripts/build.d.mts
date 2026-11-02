import type { SpawnSyncOptions } from "node:child_process";
export type BuildRunner = (executable: string, args: readonly string[], options: SpawnSyncOptions) => {
  status: number | null; signal?: NodeJS.Signals | null; error?: Error;
};
export interface BuildOptions { root?: string; development?: boolean; watch?: boolean; run?: BuildRunner }
export function build(options?: BuildOptions): void;
export function outputFiles(root: string, directory?: string): string[];
