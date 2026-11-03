import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { assertProductionOutput, productionExtensions } from "./artifact-policy.ts";

export type BuildRunner = (executable: string, args: readonly string[], options: SpawnSyncOptions) => {
  status: number | null; signal?: NodeJS.Signals | null; error?: Error;
};
export interface BuildOptions { root?: string; development?: boolean; watch?: boolean; run?: BuildRunner }

const repository = fileURLToPath(new URL("../", import.meta.url));
const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

export function outputFiles(root: string, directory = "dist"): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Build output cannot contain symbolic links: ${entry.name}`);
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...outputFiles(root, name));
    else files.push(name);
  }
  return files;
}

/** Clean first: TypeScript does not remove JS whose source was deleted. */
export function build({ root = repository, development = false, watch = false, run = spawnSync }: BuildOptions = {}): void {
  root = resolve(root);
  const directory = development ? ".local/dev-dist" : "dist";
  const output = join(root, directory);
  // Never remove redirected output or write a launcher through a redirected path.
  for (const name of development ? [".local", directory] : [directory, "bin", "bin/pi.mjs"]) {
    try {
      if (lstatSync(join(root, name)).isSymbolicLink()) throw new Error(`Refusing redirected build output: ${name}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const manifest = development ? undefined : JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest) productionExtensions(manifest);
  rmSync(output, { recursive: true, force: true });
  try {
    if (!development) {
      // npm executables run inside node_modules, where Node does not strip types.
      // Keep their stable path as generated JavaScript, with TypeScript as source.
      const source = readFileSync(join(root, "bin/pi.ts"), "utf8");
      const launcher = ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
      } });
      writeFileSync(join(root, "bin/pi.mjs"), launcher.outputText, { mode: 0o755 });
    }
    const result = run(process.execPath, [compiler, "-p", join(root, development ? "tsconfig.dev.json" : "tsconfig.json"),
      ...(watch ? ["--watch"] : [])], { cwd: root, stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`TypeScript build failed (${result.signal ?? result.status}).`);
    if (manifest) assertProductionOutput(outputFiles(root), manifest);
  } catch (error) {
    // A failed build must not leave an old or partially emitted runnable package.
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !["--dev", "--watch", "-w"].includes(arg))) throw new Error("Use build.ts [--dev] [--watch].");
    build({ development: args.includes("--dev"), watch: args.includes("--watch") || args.includes("-w") });
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
