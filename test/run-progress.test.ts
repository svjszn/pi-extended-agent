import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire, findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CustomEditor, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { assistantFixture, present, tuiFixture } from "./helpers.ts";

const { RunProgressTracker } = await import(new URL("../dist/lib/run-progress.js", import.meta.url).href) as typeof import("../lib/run-progress.js");
const { default: escapeExit } = await import(new URL("../dist/extensions/escape-exit.js", import.meta.url).href) as typeof import("../extensions/escape-exit.js");
const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { stripTerminalSequences } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");
type ProgressEditor = InstanceType<ReturnType<typeof import("../ui/escape-exit.js").createEscapeExitEditor>>;

test("run progress replaces streaming estimates with provider output across turns and retries", () => {
  let time = 100;
  const tracker = new RunProgressTracker(() => time);
  assert.equal(tracker.snapshot(), undefined);
  tracker.begin();
  tracker.startMessage();
  tracker.update("thinking", 0);
  tracker.update("text", 0);
  tracker.update('{"path":"fixture"}', 0);
  time += 62_300;
  assert.deepEqual(tracker.snapshot(), { elapsedMs: 62_300, outputTokens: 8, estimated: true });
  tracker.update("", 14);
  assert.equal(tracker.snapshot()?.outputTokens, 14);
  assert.equal(tracker.snapshot()?.estimated, false);
  tracker.endMessage(assistantFixture([], { usage: {
    input: 1000, output: 12, cacheRead: 9000, cacheWrite: 500, totalTokens: 10_512,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  } }));
  tracker.begin(); // A retry/continuation must neither reset the clock nor count the old response twice.
  tracker.startMessage();
  tracker.update("next", 0);
  assert.deepEqual(tracker.snapshot(), { elapsedMs: 62_300, outputTokens: 13, estimated: true });
  tracker.endMessage(assistantFixture([], { usage: { ...assistantFixture([]).usage, output: 5 } }));
  tracker.addUsage({ output: 3 });
  assert.deepEqual(tracker.snapshot(), { elapsedMs: 62_300, outputTokens: 20, estimated: false });
  tracker.reset();
  tracker.update("late update", 100);
  tracker.endMessage(assistantFixture([{ type: "text", text: "late message" }]));
  assert.equal(tracker.snapshot(), undefined);
  tracker.begin();
  assert.deepEqual(tracker.snapshot(), { elapsedMs: 0, outputTokens: 0, estimated: false });
});

test("missing provider usage remains explicitly estimated, including non-streaming and aborted output", () => {
  const tracker = new RunProgressTracker(() => 0);
  tracker.begin();
  tracker.endMessage(assistantFixture([{ type: "thinking", thinking: "12345678" }, { type: "text", text: "1234" }]));
  assert.deepEqual(tracker.snapshot(), { elapsedMs: 0, outputTokens: 3, estimated: true });
  tracker.startMessage();
  tracker.update("12345678", Number.NaN);
  tracker.endMessage(assistantFixture([], { stopReason: "aborted" }));
  tracker.addUsage({ output: -10 });
  tracker.addUsage({ output: Infinity });
  assert.deepEqual(tracker.snapshot(), { elapsedMs: 0, outputTokens: 5, estimated: true });
});

test("real Pi streaming hooks show per-run progress, keep it through tools, and clear it at settlement", async (t) => {
  const base = resolve(".local/run-progress-tests"); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "case-")), agentDir = join(cwd, "profile");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(resolve(cwd).startsWith(base + sep)); rmSync(cwd, { recursive: true, force: true });
  });
  const aiManifest = present(findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(dirname(aiManifest), "dist/compat.js")).href) as typeof import("@earendil-works/pi-ai");
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
  let requests = 0, editor: ProgressEditor | undefined;
  const rows: string[] = [], initial: string[] = [], settled: string[] = [];
  const row = () => stripTerminalSequences(present(editor).render(100)[0]);
  runtime.registerProvider("progress-fixture", { api: "progress-fixture-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const tool = ++requests === 1;
      const message = assistantFixture([{ type: "thinking", thinking: "12345678" },
        ...(tool ? [{ type: "toolCall" as const, id: "probe", name: "progress_probe", arguments: {} }]
          : [{ type: "text" as const, text: "1234" }])],
      { api: model.api, provider: model.provider, model: model.id, stopReason: tool ? "toolUse" : "stop" });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: assistantFixture([], { api: model.api, provider: model.provider, model: model.id }) });
        stream.push({ type: "thinking_delta", contentIndex: 0, delta: "12345678", partial: message });
        const final = { ...message, usage: { ...message.usage, input: 1000, output: tool ? 13 : 7, cacheRead: 9000 } };
        stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message: final }); stream.end();
      });
      return stream;
    },
  });
  const settings = SettingsManager.inMemory({ retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    extensionFactories: [escapeExit, pi => {
      pi.on("before_agent_start", () => { initial.push(row()); });
      pi.on("message_update", () => { rows.push(row()); });
      pi.on("message_end", event => { if (event.message.role === "assistant") rows.push(row()); });
      pi.on("agent_settled", () => { settled.push(row()); });
      pi.registerTool({ name: "progress_probe", label: "Fixture", description: "Local fixture", parameters: { type: "object", properties: {} },
        async execute() { rows.push(row()); return { content: [{ type: "text", text: "Fixture result" }], details: {} }; } });
    }],
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager: settings,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), model: runtime.getModel("progress-fixture", "fixture"), tools: [] });
  t.after(() => { editor?.dispose(); session.dispose(); runtime.unregisterProvider("progress-fixture"); });
  await session.bindExtensions({ mode: "tui", uiContext: {
    setEditorComponent(create: NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>) {
      editor = create(tuiFixture({ children: [], terminal: { rows: 24, columns: 100 }, requestRender() {} }),
        { borderColor: text => text, selectList: {} } as Parameters<typeof create>[1], new KeybindingsManager()) as ProgressEditor;
      editor.setWorkingStatusIndicator({ renderInBorder: () => "Working", renderSpinnerInBorder: () => "*" } as unknown as Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]);
      editor.focused = true;
    },
  } as unknown as ExtensionUIContext });
  await session.prompt("Run the local probe.");
  assert.equal(requests, 2);
  assert.ok(rows.some(value => /↓ ~2 tokens/.test(value)), rows.join("\n"));
  assert.ok(rows.some(value => /↓ 13 tokens/.test(value)), rows.join("\n"));
  assert.ok(rows.some(value => /↓ 20 tokens/.test(value)), rows.join("\n"));
  assert.doesNotMatch(settled[0], /tokens|\d+s/);
  await session.prompt("Another local run.");
  assert.equal(initial.length, 2);
  assert.ok(initial.every(value => /0s · ↓ 0 tokens/.test(value)), initial.join("\n"));
  assert.equal(settled.length, 2);
});
