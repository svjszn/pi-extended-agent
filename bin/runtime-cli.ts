import { enableCompileCache } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Runtime } from "./runtime.js";
import { codeModeBuiltin } from "../lib/code-mode.js";
import { normalizeResumeArgs } from "./resume-args.js";

type CliApi = Pick<typeof import("@earendil-works/pi-coding-agent"), "main" | "createCodemodeExtension" | "parseArgs">;

/** Keep Pi's CLI setup while supplying a single configured built-in codemode factory. */
export async function runtimeCli(runtime: Runtime) {
  const api = await import(pathToFileURL(join(runtime.packageDir, "dist/bundle/index.js")).href) as CliApi;
  const setup = await import(pathToFileURL(join(runtime.packageDir, "dist/cli/setup.js")).href) as { setupCli(): void };
  if (typeof api.main !== "function" || typeof api.createCodemodeExtension !== "function" || typeof api.parseArgs !== "function" || typeof setup.setupCli !== "function") {
    throw new Error("This Pi engine does not support the configured CLI entry point.");
  }
  return {
    async run(args: string[]) {
      enableCompileCache();
      setup.setupCli();
      await api.main(normalizeResumeArgs(args, api.parseArgs), { extensionFactories: [codeModeBuiltin(api.createCodemodeExtension)] });
    },
  };
}
