import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { planUpdate, updateEngine, latestVersion } from "../dist/bin/update.js";
import { PI_PACKAGE, readRuntimeState, cachedVersions, selectedRuntime, describeRuntime } from "../dist/bin/runtime.js";
import { checkForEngineUpdate, checkForAgentUpdate, checkForUpdates, checkForReleaseUpdates, UPDATE_CHECK_INTERVAL } from "../dist/lib/update-notice.js";
import { installAgent, updateAgent } from "../dist/bin/self-update.js";
import updateNotice from "../dist/extensions/update-notice.js";
import { availableUpdateLabel, setAvailableUpdates, visibleUpdateLabel } from "../dist/lib/update-status.js";

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

test("agent updates are the default, engine updates are explicit, and resource updates stay native", () => {
  for (const args of [["update"], ["update", "self"], ["update", "pi"], ["update", "--self"]]) {
    assert.equal(planUpdate(args).type, args.includes("pi") ? "engine" : "package");
  }
  assert.deepEqual(planUpdate(["update", "--check"]), { type: "package", checkOnly: true });
  assert.equal(planUpdate(["update", "--engine"]).type, "engine");
  assert.equal(planUpdate(["update", "--engine", "--check"]).checkOnly, true);
  assert.throws(() => planUpdate(["update", "self", "--rollback"]), /Use pi update/);
  assert.deepEqual(planUpdate(["update", "--all"]).extensionArgs, ["update", "--extensions"]);
  for (const args of [["update", "--models"], ["update", "--extensions"], ["update", "--extension", "pi"]]) {
    assert.deepEqual(planUpdate(args), { type: "upstream", args });
  }
  assert.equal(planUpdate(["update", "--to", "1.4.0", "--offline"]).version, "1.4.0");
  assert.throws(() => planUpdate(["update", "--to", "../../other"]), /exact Pi version/);
  assert.throws(() => planUpdate(["update", "--rollback", "--all"]), /cannot be combined/);
});

test("agent updates install an exact release into the current global prefix", async (t) => {
  const directory = fixture(t);
  const globalRoot = process.platform === "win32" ? join(directory, "node_modules") : join(directory, "lib", "node_modules");
  const packageRoot = join(globalRoot, "pi-extended-agent");
  mkdirSync(packageRoot, { recursive: true });
  const manifest = join(packageRoot, "package.json");
  writeFileSync(manifest, JSON.stringify({ name: "pi-extended-agent", version: "1.0.0" }));
  const calls = [], logs = [];
  const services = { log: (line) => logs.push(line), latest: async () => "1.0.1", globalRoot: async () => globalRoot,
    install: async (version, prefix) => {
      calls.push([version, prefix]);
      writeFileSync(manifest, JSON.stringify({ name: "pi-extended-agent", version }));
    } };
  await updateAgent(packageRoot, { checkOnly: true }, services);
  assert.deepEqual(calls, []);
  await updateAgent(packageRoot, {}, services);
  assert.deepEqual(calls, [["1.0.1", directory]]);
  assert.match(logs.join("\n"), /Restart pi/);
  await updateAgent(packageRoot, {}, services);
  assert.equal(calls.length, 1);
  await updateAgent(packageRoot, {}, { ...services, latest: async () => "1.0.0" });
  assert.equal(calls.length, 1, "a normal update must not downgrade the agent");
});

test("agent updates protect source checkouts and npm links and reject invalid releases", async (t) => {
  const directory = fixture(t), packageRoot = join(directory, "checkout"), globalRoot = join(directory, "node_modules");
  mkdirSync(packageRoot); mkdirSync(globalRoot);
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-extended-agent", version: "1.0.0" }));
  const services = { log() {}, latest: async () => "1.0.1", globalRoot: async () => globalRoot,
    install() { assert.fail("source checkout must not be replaced"); } };
  await assert.rejects(updateAgent(packageRoot, {}, services), /source checkout/);
  symlinkSync(packageRoot, join(globalRoot, "pi-extended-agent"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(updateAgent(packageRoot, {}, services), /npm link/);
  for (const version of ["latest", "../../escape", "1.0.1; echo bad"]) {
    await assert.rejects(updateAgent(packageRoot, {}, { ...services, latest: async () => version }), /Invalid target agent version/);
  }
});

test("agent installation failures do not report success", async (t) => {
  const directory = fixture(t), globalRoot = join(directory, "node_modules"), packageRoot = join(globalRoot, "pi-extended-agent");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-extended-agent", version: "1.0.0" }));
  const logs = [], services = { log: (line) => logs.push(line), latest: async () => "1.0.1", globalRoot: async () => globalRoot };
  await assert.rejects(updateAgent(packageRoot, {}, { ...services, install: async () => { throw Error("npm failed"); } }), /npm failed/);
  await assert.rejects(updateAgent(packageRoot, {}, { ...services, install: async () => {} }), /did not install/);
  assert.doesNotMatch(logs.join("\n"), /updated to/);
  assert.equal(existsSync(join(globalRoot, ".pi-extended-agent-update.lock")), false);
  writeFileSync(join(globalRoot, ".pi-extended-agent-update.lock"), "busy");
  await assert.rejects(updateAgent(packageRoot, {}, { ...services, install: () => assert.fail("concurrent update must not run") }), /already locked/);
});

test("agent installation invokes npm without a shell, lifecycle scripts, or floating versions", async (t) => {
  const directory = fixture(t), cli = join(directory, "npm-cli.js"), output = join(directory, "args.json");
  writeFileSync(cli, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`);
  const previous = process.env.npm_execpath;
  process.env.npm_execpath = cli;
  try {
    const prefix = join(directory, "prefix with spaces");
    await installAgent("1.0.1", prefix);
    assert.deepEqual(JSON.parse(readFileSync(output)), ["install", "--global", "--prefix", prefix,
      "--ignore-scripts", "--no-audit", "--no-fund", "pi-extended-agent@1.0.1"]);
    await assert.rejects(installAgent("../../bad", prefix), /Invalid target/);
  } finally {
    if (previous === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous;
  }
});

test("runtime manifests cannot redirect the launcher outside the engine package", (t) => {
  const directory = fixture(t);
  stage(directory, "1.5.0");
  const packageDir = join(directory, "releases", "1.5.0", "node_modules", PI_PACKAGE);
  const manifest = join(packageDir, "package.json");
  const outside = join(directory, "outside.js"); writeFileSync(outside, "throw Error('must not execute');");
  for (const main of [outside, "../../../../../../outside.js", null]) {
    writeFileSync(manifest, JSON.stringify({ name: PI_PACKAGE, version: "1.5.0", main, bin: { pi: "cli.js" } }));
    assert.throws(() => describeRuntime(packageDir), /entry point/);
  }
  writeFileSync(manifest, JSON.stringify({ name: PI_PACKAGE, version: "1.5.0", main: "index.js", bin: { pi: outside } }));
  assert.throws(() => describeRuntime(packageDir), /outside its package/);
  const redirect = join(packageDir, "redirect");
  symlinkSync(directory, redirect, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(manifest, JSON.stringify({ name: PI_PACKAGE, version: "1.5.0", main: "redirect/outside.js", bin: { pi: "cli.js" } }));
  assert.throws(() => describeRuntime(packageDir), /outside its package/);
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

test("agent and engine notices use separate caches and point to their own commands", async (t) => {
  const directory = fixture(t);
  let calls = 0;
  const options = { directory, offline: false, now: 1000, latest: async () => { calls++; return "1.0.1"; } };
  assert.match(await checkForAgentUpdate("1.0.0", options), /Pi Extended Agent 1\.0\.1.*Run pi update in/);
  assert.equal(await checkForAgentUpdate("1.0.1", options), undefined);
  assert.equal(calls, 1);
  assert.match(await checkForEngineUpdate("1.4.0", { ...options, latest: async () => "1.5.0" }), /pi update --engine/);
  assert.equal(JSON.parse(readFileSync(join(directory, "agent-update-check.json"))).version, "1.0.1");
  assert.equal(JSON.parse(readFileSync(join(directory, "update-check.json"))).version, "1.5.0");
  assert.equal(await checkForAgentUpdate("1.0.0", { ...options, offline: true }), undefined);
});

test("combined notices check both release streams without confusing their versions", async (t) => {
  const directory = fixture(t);
  let calls = 0;
  const notice = await checkForUpdates("1.4.0", { directory, offline: false, latest: async () => { calls++; return "1.5.0"; } });
  assert.equal(calls, 2);
  assert.match(notice, /Pi Extended Agent 1\.5\.0.*pi update in/);
  assert.match(notice, /Pi 1\.5\.0.*pi update --engine/);
  const reports = await checkForReleaseUpdates("1.4.0", { directory, offline: false, latest: async () => assert.fail("cached release checks must not fetch") });
  assert.deepEqual(reports.map(({ kind, command }) => [kind, command]), [["agent", "pi update"], ["engine", "pi update --engine"]]);
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

test("update notification never blocks startup, checks once, and cancels on shutdown", async (t) => {
  const handlers = new Map(), statuses = [];
  let finish, calls = 0, signal;
  const check = (_current, options) => {
    calls++; signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  };
  const pi = { on(event, handler) { handlers.set(event, handler); } };
  const ctx = { mode: "tui", ui: { setStatus: (_key, message) => statuses.push(message), notify() { assert.fail("updates belong in the persistent input status"); } } };
  updateNotice(pi, check);
  t.after(() => handlers.get("session_shutdown")());
  handlers.get("session_start")({}, { ...ctx, mode: "rpc" });
  assert.equal(calls, 0);
  assert.equal(handlers.get("session_start")({}, ctx), undefined);
  handlers.get("session_start")({}, ctx);
  assert.equal(calls, 1);
  finish([{ kind: "agent", version: "1.2.0", current: "1.1.0", command: "pi update", message: "An agent update is available." }]);
  await new Promise(setImmediate);
  assert.equal(statuses.at(-1), undefined);
  assert.equal(visibleUpdateLabel(), undefined);
  assert.equal(availableUpdateLabel(), "Update 1.2.0 · pi update");
  assert.equal(availableUpdateLabel(12), "↑ 1.2.0");
  handlers.get("session_shutdown")();
  updateNotice(pi, check);
  handlers.get("session_start")({}, ctx);
  handlers.get("session_shutdown")();
  assert.equal(signal.aborted, true);
  const count = statuses.length;
  finish([{ kind: "agent", version: "9.0.0", current: "1.1.0", command: "pi update", message: "must not notify after shutdown" }]);
  await new Promise(setImmediate);
  assert.equal(statuses.length, count);
  assert.equal(availableUpdateLabel(), undefined);
});

test("update slot rotates while idle and stops repainting on shutdown or when no update exists", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handlers = new Map(), statuses = [];
  const pi = { on: (event, handler) => handlers.set(event, handler) };
  const ctx = { mode: "tui", ui: { setStatus: (_key, text) => statuses.push(text) } };
  const update = { kind: "agent", version: "1.2.0", current: "1.1.0", command: "pi update", message: "Update available" };
  updateNotice(pi, async () => [update]);
  t.after(() => handlers.get("session_shutdown")());
  handlers.get("session_start")({}, ctx);
  await Promise.resolve();
  assert.equal(visibleUpdateLabel(), undefined);
  const count = statuses.length;
  t.mock.timers.tick(7999);
  assert.equal(statuses.length, count, "effort stays visible without per-frame repaints");
  t.mock.timers.tick(1);
  assert.equal(visibleUpdateLabel(), "Update 1.2.0 · pi update");
  assert.equal(statuses.at(-1), visibleUpdateLabel());
  t.mock.timers.tick(3999);
  assert.equal(visibleUpdateLabel(), "Update 1.2.0 · pi update");
  t.mock.timers.tick(1);
  assert.equal(visibleUpdateLabel(), undefined);
  t.mock.timers.tick(8000);
  assert.equal(visibleUpdateLabel(), "Update 1.2.0 · pi update");
  handlers.get("session_shutdown")();
  const stopped = statuses.length;
  t.mock.timers.tick(60000);
  assert.equal(statuses.length, stopped);
  assert.equal(availableUpdateLabel(), undefined);

  updateNotice(pi, async () => []);
  handlers.get("session_start")({}, ctx);
  await Promise.resolve();
  const noUpdate = statuses.length;
  t.mock.timers.tick(60000);
  assert.equal(statuses.length, noUpdate);
});

test("agent update status takes priority over the separately managed engine", () => {
  setAvailableUpdates([
    { kind: "engine", version: "1.5.0", current: "1.4.0", command: "pi update --engine", message: "Engine release" },
    { kind: "agent", version: "1.2.0", current: "1.1.0", command: "pi update", message: "Agent release" },
  ]);
  assert.equal(availableUpdateLabel(), "Update 1.2.0 · pi update");
  setAvailableUpdates([]);
});
