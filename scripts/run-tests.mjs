import { run } from "node:test";
import { spec } from "node:test/reporters";

const files = process.argv.slice(2);
if (!files.length) throw new Error("Specify at least one test file.");

// Node 22.19 supports this API, but not the --test-isolation CLI flag.
const tests = run({ files, isolation: "none" });
tests.on("test:fail", () => { process.exitCode = 1; });
tests.compose(spec).pipe(process.stdout);
