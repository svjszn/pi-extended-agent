import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { planUpdate, updateEngine, latestVersion } from "../dist/bin/update.js";
import { PI_PACKAGE, readRuntimeState, cachedVersions, selectedRuntime } from "../dist/bin/runtime.js";
import { checkForEngineUpdate, UPDATE_CHECK_INTERVAL } from "../dist/lib/update-notice.js";
import updateNotice from "../dist/extensions/update-notice.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = resolve(root, ".local/update-tests");
function fixture(t) {
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(join(fixtureRoot, "runtime-"));
  t.after(() => {
    const target = resolve(directory);
    assert.ok(target.startsWith(fixtureRoot + sep));
    rmSync(target, { recursive: true, force: true });
  });
  return directory;
}
function stage(directory, version) {
  const packageDir = join(directory, "releases", version, "node_modules", PI_PACKAGE);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: PI_PACKAGE, version, main: "index.js", bin: { pi: "cli.js" } }));
  writeFileSync(join(packageDir, "index.js"), "");
  writeFileSync(join(packageDir, "cli.js"), "");
}
const quiet = { log() {}, async verify() {} };

test("self aliases use the managed engine updater and resource updates stay native", () => {
  for (const args of [["update"], ["update", "self"], ["update", "pi"], ["update", "--self"]]) {
    assert.equal(planUpdate(args).type, "engine");
  }
  assert.deepEqual(planUpdate(["update", "--all"]).extensionArgs, ["update", "--extensions"]);
  for (const args of [["update", "--models"], ["update", "--extensions"], ["update", "--extension", "pi"]]) {
    assert.deepEqual(planUpdate(args), { type: "upstream", args });
  }
  assert.equal(planUpdate(["update", "--to", "1.4.0", "--offline"]).version, "1.4.0");
  assert.throws(() => planUpdate(["update", "--to", "../../other"]), /exact Pi version/);
  assert.throws(() => planUpdate(["update", "--rollback", "--all"]), /cannot be combined/);
});

test("verified engine activation preserves the package and launcher", async (t) => {
  const directory = fixture(t);
  const manifest = readFileSync(join(root, "package.json"));
  const launcher = readFileSync(join(root, "bin/pi.mjs"));
  const versions = [];
  await updateEngine(root, { version: "1.5.0" }, { ...quiet, directory,
    async install(version, dir) { assert.equal(dir, directory); stage(dir, version); },
    async verify(runtime) { versions.push(runtime.version); },
  });
  assert.deepEqual(versions, ["1.5.0"]);
  assert.equal(selectedRuntime(directory).version, "1.5.0");
  assert.deepEqual(readRuntimeState(directory), { version: "1.5.0", previous: null });
  assert.deepEqual(readFileSync(join(root, "package.json")), manifest);
  assert.deepEqual(readFileSync(join(root, "bin/pi.mjs")), launcher);
});

test("failed installation or incompatible UI leaves the previous engine active", async (t) => {
  for (const failure of ["install", "verify"]) {
    const directory = fixture(t);
    await assert.rejects(updateEngine(root, { version: "1.5.0" }, { ...quiet, directory,
      async install(version, dir) { if (failure === "install") throw new Error("install failed"); stage(dir, version); },
      async verify() { throw new Error("incompatible UI"); },
    }), /active engine was not changed/);
    assert.equal(readRuntimeState(directory).version, null);
    assert.equal(existsSync(join(directory, "update.lock")), false);
  }
});

test("offline updates reuse complete cached engines and rollback restores the bundled engine", async (t) => {
  const directory = fixture(t);
  stage(directory, "1.5.0");
  stage(directory, "1.3.0");
  assert.deepEqual(cachedVersions(directory), ["1.3.0", "1.5.0"]);
  const services = { ...quiet, directory, async install() { assert.fail("cached engine must not be reinstalled"); }, async latest() { assert.fail("offline update must not fetch metadata"); } };
  await updateEngine(root, { offline: true }, services);
  assert.equal(readRuntimeState(directory).version, "1.5.0");
  await updateEngine(root, { rollback: true }, services);
  assert.deepEqual(readRuntimeState(directory), { version: null, previous: "1.5.0" });
});

test("update check does not install or activate anything", async (t) => {
  const directory = fixture(t);
  await updateEngine(root, { checkOnly: true }, { ...quiet, directory,
    async latest() { return "1.4.0"; }, async install() { assert.fail("check must not install"); },
  });
  assert.equal(existsSync(join(directory, "active.json")), false);
});

test("release lookup uses npm with a retry and rejects invalid metadata", async () => {
  const version = await latestVersion(async (executable, args, options) => {
    assert.equal(executable, process.execPath);
    assert.ok(args.includes(`${PI_PACKAGE}@latest`));
    assert.ok(args.includes("--fetch-retries=1"));
    assert.ok(args.includes("--fetch-timeout=30000"));
    assert.ok(options.timeout > 60_000);
    return { stdout: '"1.4.0"\n' };
  });
  assert.equal(version, "1.4.0");
  for (const stdout of ['"latest"', '"../../other"', '{}', 'not json']) {
    await assert.rejects(latestVersion(async () => ({ stdout })), /invalid Pi version/);
  }
});

test("release lookup timeout explains recovery and preserves the active engine", async (t) => {
  const directory = fixture(t);
  stage(directory, "1.3.0");
  writeFileSync(join(directory, "active.json"), JSON.stringify({ version: "1.3.0", previous: null }));
  const state = readFileSync(join(directory, "active.json"));
  await assert.rejects(updateEngine(root, {}, { ...quiet, directory,
    async latest() {
      return latestVersion(async () => { throw Object.assign(new Error("process timed out"), { killed: true }); });
    },
    async install() { assert.fail("failed lookup must not install"); },
  }), /npm timed out.*pi update --to VERSION.*active engine was not changed/);
  assert.deepEqual(readFileSync(join(directory, "active.json")), state);
  assert.equal(selectedRuntime(directory).version, "1.3.0");
  assert.equal(existsSync(join(directory, "update.lock")), false);
});

test("runtime pointer rejects path traversal", (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, "active.json"), JSON.stringify({ version: "../../outside" }));
  assert.throws(() => selectedRuntime(directory), /Invalid runtime state/);
});

test("startup update checks cache registry results and compare with the active engine", async (t) => {
  const directory = fixture(t);
  let calls = 0;
  const options = { directory, now: 100000, offline: false, latest: async () => { calls++; return "1.5.0"; } };
  const notice = await checkForEngineUpdate("1.4.0", options);
  assert.match(notice, /Pi 1\.5\.0.*current: 1\.4\.0.*pi update/);
  assert.equal(existsSync(join(directory, "active.json")), false);
  assert.equal(await checkForEngineUpdate("1.5.0", options), undefined);
  assert.equal(await checkForEngineUpdate("1.6.0", options), undefined);
  assert.match(await checkForEngineUpdate("1.4.0", options), /1\.5\.0/);
  assert.equal(calls, 1);
  await checkForEngineUpdate("1.4.0", { ...options, now: options.now + UPDATE_CHECK_INTERVAL });
  assert.equal(calls, 2);
  writeFileSync(join(directory, "update-check.json"), "broken json");
  await checkForEngineUpdate("1.4.0", options);
  assert.equal(calls, 3);
});

test("offline, cancelled, and failed startup checks leave the session and engine alone", async (t) => {
  const directory = fixture(t);
  let calls = 0;
  const noFetch = async () => { calls++; return "1.5.0"; };
  assert.equal(await checkForEngineUpdate("1.4.0", { directory, offline: true, latest: noFetch }), undefined);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await checkForEngineUpdate("1.4.0", { directory, offline: false, signal: controller.signal, latest: noFetch }), undefined);
  assert.equal(calls, 0);
  for (const latest of [async () => { throw Error("network down"); }, async () => "invalid"]) {
    assert.equal(await checkForEngineUpdate("1.4.0", { directory, offline: false, latest }), undefined);
  }
  assert.equal(existsSync(join(directory, "update-check.json")), false);
  assert.equal(existsSync(join(directory, "active.json")), false);
});

test("background registry lookup has a short timeout, no retries, and supports cancellation", async () => {
  const controller = new AbortController();
  const version = await latestVersion(async (_executable, args, options) => {
    assert.ok(args.includes("--fetch-timeout=5000"));
    assert.ok(args.includes("--fetch-retries=0"));
    assert.equal(options.timeout, 6000);
    assert.equal(options.signal, controller.signal);
    return { stdout: '"1.5.0"' };
  }, { background: true, signal: controller.signal });
  assert.equal(version, "1.5.0");
});

test("update notification never blocks startup, checks once, and cancels on shutdown", async () => {
  const handlers = new Map(), notices = [];
  let finish, calls = 0, signal;
  const check = (_current, options) => {
    calls++; signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  };
  const pi = { on(event, handler) { handlers.set(event, handler); } };
  const ctx = { mode: "tui", ui: { notify: (message) => notices.push(message) } };
  updateNotice(pi, check);
  handlers.get("session_start")({}, { ...ctx, mode: "rpc" });
  assert.equal(calls, 0);
  assert.equal(handlers.get("session_start")({}, ctx), undefined);
  handlers.get("session_start")({}, ctx);
  assert.equal(calls, 1);
  finish("Pi 1.5.0 is available. Run pi update.");
  await new Promise(setImmediate);
  assert.equal(notices.length, 1);
  updateNotice(pi, check);
  handlers.get("session_start")({}, ctx);
  handlers.get("session_shutdown")();
  assert.equal(signal.aborted, true);
  finish("must not notify after shutdown");
  await new Promise(setImmediate);
  assert.equal(notices.length, 1);
});
