import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Runtime } from "./runtime.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Bind our compiled extensions to the API already loaded by the selected CLI.
 * Jiti can natively import JS entries, bypassing its virtual-module aliases and
 * otherwise loading a second, unbundled SDK from this wrapper's dependencies.
 * Install before importing extensions; one selected engine lives per process.
 * Neither third-party imports nor extension filenames/provenance are changed.
 */
export function bindCompiledExtensionImports(runtime: Runtime, root = packageRoot) {
  const parents = ["extensions", "lib", "ui"].map(directory => pathToFileURL(join(root, "dist", directory) + "/").href);
  const bundle = pathToFileURL(join(runtime.packageDir, "dist", "bundle", "index.js")).href;
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (specifier === "@earendil-works/pi-coding-agent" && parent && parents.some(prefix => parent.startsWith(prefix))) {
        return nextResolve(bundle, context);
      }
      return nextResolve(specifier, context);
    },
  });
}
