import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { request } from "node:http";
import type { WebEvent, WebState } from "../lib/web-types.ts";

const { WebSessions, webProjection } = await import(new URL("../dist/lib/web-sessions.js", import.meta.url).href) as typeof import("../lib/web-sessions.js");
const { browserHistory, browserMessage } = await import(new URL("../dist/lib/web-types.js", import.meta.url).href) as typeof import("../lib/web-types.js");
const { startWebServer } = await import(new URL("../dist/bin/web-server.js", import.meta.url).href) as typeof import("../bin/web-server.js");
const { parseUiArgs, openDashboard } = await import(new URL("../dist/bin/ui.js", import.meta.url).href) as typeof import("../bin/ui.js");
const { webQuestionAnswers } = await import(new URL("../dist/lib/web-questions.js", import.meta.url).href) as typeof import("../lib/web-questions.js");
const repository = fileURLToPath(new URL("../", import.meta.url)), launcher = join(repository, "bin/pi.mjs");
function fixture(t: TestContext) {
  const base = resolve(".local/web-tests"); mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, "case-"));
  const cwd = join(root, "project"), profile = join(root, "profile"), directory = join(profile, "sessions", "project"); mkdirSync(cwd);
  const file = join(directory, "chat.jsonl");
  const header = { type: "session", version: 3, id: "fixture-session", cwd, timestamp: new Date().toISOString() };
  const cleanup: (() => Promise<void>)[] = [];
  const write = (entries: unknown[], path = file) => { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, [header, ...entries].map(value => JSON.stringify(value)).join("\n") + "\n"); };
  t.after(async () => { for (const close of cleanup.reverse()) await close(); assert.ok(resolve(root).startsWith(base + sep)); rmSync(root, { recursive: true, force: true }); });
  return { root, cwd, profile, directory, file, header, write, cleanup };
}
function fakeEngine(f: ReturnType<typeof fixture>, hung = false) {
  const script = `
    const fs = require('node:fs'); const file = ${JSON.stringify(f.file)}, cwd = ${JSON.stringify(f.cwd)};
    let entries = [], sequence = 0, buffer = '', dialog;
    const header = ${JSON.stringify(f.header)};
    const state = {sessionId:'fixture-session', sessionFile:file, thinkingLevel:'low', isStreaming:false,
      model:{id:'fixture', provider:'fixture', name:'Fixture model', headers:{Authorization:'SECRET_PROVIDER_HEADER'}}};
    const out = x => process.stdout.write(JSON.stringify(x)+'\\n');
    const add = x => { const value={id:'entry-'+(++sequence),parentId:entries.at(-1)?.id??null,...x}; entries.push(value);
      fs.mkdirSync(require('node:path').dirname(file),{recursive:true}); fs.writeFileSync(file,[header,...entries].map(JSON.stringify).join('\\n')+'\\n'); return value; };
    function finish(text) { const message={role:'assistant',content:[{type:'text',text}],timestamp:Date.now()};
      add({type:'message',message}); out({type:'message_end',message}); state.isStreaming=false; out({type:'agent_settled',aborted:false}); }
    function command(c) {
      const reply=(data,success=true,error)=>out({type:'response',id:c.id,command:c.type,success,data,error});
      if(c.type==='get_state') reply(state);
      else if(c.type==='get_entries') reply({entries,leafId:entries.at(-1)?.id??null});
      else if(c.type==='get_available_models') reply({models:[state.model]});
      else if(c.type==='get_available_thinking_levels') reply({levels:['off','low','high']});
      else if(c.type==='set_thinking_level') {state.thinkingLevel=c.level;reply();}
      else if(c.type==='set_model') {state.model.id=c.modelId;reply(state.model);}
      else if(c.type==='prompt') {
        if(c.message.startsWith('/permissions ')) {add({type:'custom',customType:'pi-extended-permissions',data:{mode:c.message.split(' ')[1]}});reply({disposition:'handled'});return;}
        const user={role:'user',content:c.message,timestamp:Date.now()};add({type:'message',message:user});out({type:'message_start',message:user});out({type:'message_end',message:user});
        state.isStreaming=true;reply({disposition:'started'});out({type:'agent_start'});
        out({type:'message_start',message:{role:'assistant',content:[]}});
        if(c.message==='approval'||c.message==='oversized') {dialog='approval';out({type:'extension_ui_request',id:'approve',method:'confirm',title:'Allow write once?',message:'Tool: write\\n\\u009b'+ 'x'.repeat(c.message==='oversized'?300000:9000)+'REVIEW_TAIL'});}
        else {out({type:'message_update',assistantMessageEvent:{type:'text_start',contentIndex:0}});
          out({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'Hello \\u2028world'}});setTimeout(()=>finish('Hello \\u2028world'),30);}
      } else if(c.type==='extension_ui_response') {if(dialog==='approval'&&c.confirmed===true)fs.writeFileSync(${JSON.stringify(join(f.cwd, "approved"))},'explicitly approved');dialog=undefined;finish(c.confirmed===true?'Allowed':'Denied');}
      else if(c.type==='abort') {dialog=undefined;state.isStreaming=false;out({type:'agent_settled',aborted:true});reply();}
      else reply(undefined,false,'Unknown fixture command');
    }
    process.stderr.write('SECRET_STDERR_DIAGNOSTIC');
    process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line)command(JSON.parse(line));}});
    ${hung ? "process.stdin.on('end',()=>setInterval(()=>{},1000));process.on('SIGTERM',()=>{});" : ""}
  `;
  return { executable: process.execPath, args: ["-e", script] };
}
async function serverFixture(t: TestContext, native = false) {
  const f = fixture(t);
  const server = await startWebServer({ cwd: f.cwd, agentDir: f.profile, launcher, version: "fixture", ...(native ? {} : { rpcSpawn: fakeEngine(f) }) });
  f.cleanup.push(() => server.close());
  const headers = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
  const api = async (path: string, data?: unknown) => {
    const response = await fetch(server.origin + "/api/" + path, { method: data === undefined ? "GET" : "POST", headers, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  const wait = async (condition: () => boolean, limit = 5000) => { const end = Date.now() + limit; while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(condition(), "Expected state before timeout"); };
  return { ...f, server, api, headers, wait };
}

test("web history follows branch parents and context edits without leaking custom metadata", t => {
  const f = fixture(t), entries = [
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "first" } },
    { type: "message", id: "old", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: "OLD_BRANCH" }] } },
    { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "image", data: "PRIVATE_IMAGE_BYTES" }] } },
    { type: "custom", id: "p", parentId: "a", customType: "pi-extended-permissions", data: { mode: "read-only", secret: "PRIVATE_POLICY" } },
    { type: "context_edit", id: "e", parentId: "p", targetId: "u", replacement: { content: "edited" } },
  ];
  const projection = webProjection(entries);
  assert.equal(projection.permissions, "deny"); assert.equal(projection.messages[0].parts[0].text, "edited");
  assert.doesNotMatch(JSON.stringify(projection), /OLD_BRANCH|PRIVATE_IMAGE_BYTES|PRIVATE_POLICY/);
  assert.deepEqual(webProjection(entries, null).messages, []); assert.equal(existsSync(f.profile), false);
});

test("session discovery is bounded, read-only, supports names and skips damaged files", async t => {
  const f = fixture(t), sessions = new WebSessions(f.profile);
  assert.deepEqual((await sessions.list()).chats, []); assert.equal(existsSync(f.profile), false);
  f.write([{ type: "message", id: "m", parentId: null, message: { role: "user", content: "<img src=x onerror=alert(1)>\nQuestion" } },
    { type: "session_info", id: "name", parentId: "m", name: "Named chat" }]);
  writeFileSync(join(f.profile, "auth.json"), "AUTH_SENTINEL"); writeFileSync(join(f.profile, "models.json"), "MODELS_SENTINEL");
  writeFileSync(join(f.directory, "damaged.jsonl"), "{not json}\n");
  const before = readFileSync(f.file), auth = readFileSync(join(f.profile, "auth.json")); sessions.invalidate();
  const catalog = await sessions.list(); assert.equal(catalog.chats.length, 1); assert.equal(catalog.skipped, 1);
  assert.equal(catalog.chats[0].title, "Named chat"); const history = await sessions.history(catalog.chats[0].id);
  assert.match(history.messages[0].parts[0].text ?? "", /<img/);
  assert.doesNotMatch(JSON.stringify(history), /AUTH_SENTINEL|MODELS_SENTINEL/);
  assert.deepEqual(readFileSync(f.file), before); assert.deepEqual(readFileSync(join(f.profile, "auth.json")), auth);
  await assert.rejects(sessions.resolve("../auth.json"), /Unknown/);
  await assert.rejects(sessions.register(join(f.root, "outside.jsonl")), /outside/);
  const outside = join(f.root, "outside"); mkdirSync(outside); f.write([], join(outside, "external.jsonl"));
  symlinkSync(outside, join(f.profile, "sessions", "redirect"), process.platform === "win32" ? "junction" : "dir");
  sessions.invalidate(); assert.equal((await sessions.list()).chats.length, 1);
  await assert.rejects(sessions.register(join(f.profile, "sessions", "redirect", "external.jsonl")), /links/);
});

test("dashboard HTTP authenticates API requests, rejects foreign origins and never serves arbitrary files", async t => {
  const f = await serverFixture(t), root = await fetch(f.server.origin);
  assert.equal(root.status, 200); assert.match(root.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  const html = await root.text(); assert.match(html, /New chat/); assert.equal(html.includes(f.server.token), false);
  assert.equal((await fetch(f.server.origin + "/api/overview")).status, 401);
  assert.equal((await fetch(f.server.origin + "/api/overview", { headers: { Authorization: "Bearer " + "é".repeat(f.server.token.length) } })).status, 401);
  assert.equal((await fetch(f.server.origin + "/api/overview", { headers: { ...f.headers, Origin: "https://attacker.invalid" } })).status, 403);
  assert.equal((await fetch(f.server.origin + "/api/overview", { headers: { ...f.headers, "Sec-Fetch-Site": "cross-site" } })).status, 403);
  const foreignHost = await new Promise<number>(accept => { const req = request(f.server.origin + "/api/overview", { headers: { ...f.headers, Host: "attacker.invalid" } }, response => { response.resume(); accept(response.statusCode!); }); req.end(); });
  assert.equal(foreignHost, 403);
  for (const path of ["/auth.json", "/../package.json", "/app.js.map", "/api/chats/%2e%2e%2fauth.json"]) assert.ok((await fetch(f.server.origin + path, { headers: f.headers })).status >= 400);
  assert.equal((await f.api("overview")).status, 200); assert.equal(existsSync(f.profile), false, "opening the dashboard must not create the profile");
  const app = await fetch(f.server.origin + "/app.js"); assert.equal(app.status, 200); assert.match(app.headers.get("content-type") ?? "", /javascript/);
  assert.doesNotMatch(await app.text(), /node:|innerHTML/);
});

test("RPC-backed chat streams, persists and filters provider configuration before sending it to the browser", async t => {
  const f = await serverFixture(t), opened = await f.api("open", { cwd: f.cwd }); assert.equal(opened.status, 200, JSON.stringify(opened.data));
  const state = opened.data as WebState; assert.equal(state.chat.cwd, f.cwd); assert.ok(state.engineId);
  const events: WebEvent[] = []; const originalEmit = (f.server.rpc as unknown as { options: { emit(event: WebEvent): void } }).options.emit;
  t.mock.method((f.server.rpc as unknown as { options: { emit(event: WebEvent): void } }).options, "emit", (event: WebEvent) => { events.push(event); originalEmit(event); });
  const available = await f.api("models", { engineId: state.engineId });
  assert.doesNotMatch(JSON.stringify(opened.data) + JSON.stringify(available.data), /SECRET_PROVIDER_HEADER|SECRET_STDERR_DIAGNOSTIC/);
  assert.deepEqual((await f.api("levels", { engineId: state.engineId })).data.levels, ["off", "low", "high"]);
  assert.equal((await f.api("prompt", { engineId: state.engineId, text: "hello" })).status, 200);
  await f.wait(() => events.some(event => event.type === "state" && (event.data as WebState).messages.some(message => message.parts.some(part => part.text === "Hello \u2028world"))));
  const current = f.server.rpc.current!; assert.equal(current.busy, false);
  assert.match(JSON.stringify((await f.api(`chats/${current.chat.id}`)).data), /Hello/);
  assert.equal((await f.api("configure", { engineId: current.engineId, permissions: "deny" })).data.permissions, "deny");
  const setting = f.server.rpc.configure(current.engineId, { permissions: "ask" });
  await assert.rejects(f.server.rpc.prompt(current.engineId, "must not race a setting change"), /settings/); await setting;
  assert.equal((await f.api("prompt", { engineId: "wrong-tab", text: "must not run" })).status, 409);
  assert.equal((await f.api("open", { id: current.chat.id })).data.engineId, current.engineId);
});

test("browser approvals require a matching explicit answer, default to denial and are cancelled on abort", async t => {
  const f = await serverFixture(t), state = (await f.api("open", { cwd: f.cwd })).data as WebState;
  await f.api("prompt", { engineId: state.engineId, text: "approval" });
  await f.wait(() => f.server.rpc.current!.dialogs.length === 1);
  assert.equal(existsSync(join(f.cwd, "approved")), false);
  assert.match(f.server.rpc.current!.dialogs[0].message ?? "", /REVIEW_TAIL$/);
  assert.ok(f.server.rpc.current!.dialogs[0].message!.includes('\\u009b'), "approval control bytes are displayed visibly instead of omitted");
  assert.equal((await f.api("open", { cwd: f.cwd })).status, 409);
  assert.equal((await f.api("answer", { engineId: state.engineId, id: "wrong", confirmed: true })).status, 400);
  await f.api("answer", { engineId: state.engineId, id: "approve", cancelled: true });
  await f.wait(() => !f.server.rpc.current!.busy); assert.equal(existsSync(join(f.cwd, "approved")), false);
  await f.api("prompt", { engineId: state.engineId, text: "approval" }); await f.wait(() => f.server.rpc.current!.dialogs.length === 1);
  await f.api("answer", { engineId: state.engineId, id: "approve", confirmed: true });
  await f.wait(() => existsSync(join(f.cwd, "approved")) && !f.server.rpc.current!.busy);
  rmSync(join(f.cwd, "approved")); await f.api("prompt", { engineId: state.engineId, text: "approval" });
  await f.wait(() => f.server.rpc.current!.dialogs.length === 1); await f.api("abort", { engineId: state.engineId });
  await f.wait(() => !f.server.rpc.current!.busy); assert.equal(existsSync(join(f.cwd, "approved")), false);
  assert.equal((await f.api("answer", { engineId: state.engineId, id: "approve", confirmed: true })).status, 400);
  await f.api("prompt", { engineId: state.engineId, text: "oversized" });
  await f.wait(() => !f.server.rpc.current!.busy);
  assert.equal(f.server.rpc.current!.dialogs.length, 0); assert.equal(existsSync(join(f.cwd, "approved")), false, "an undisplayable approval is denied in full");
});

test("losing the last browser connection cancels pending approvals after the reconnect grace period", async t => {
  const f = await serverFixture(t), controller = new AbortController();
  const stream = await fetch(f.server.origin + "/api/events", { headers: f.headers, signal: controller.signal });
  assert.equal(stream.status, 200); f.cleanup.push(async () => { controller.abort(); await stream.body?.cancel().catch(() => {}); });
  const state = (await f.api("open", { cwd: f.cwd })).data as WebState;
  await f.api("prompt", { engineId: state.engineId, text: "approval" });
  await f.wait(() => f.server.rpc.current!.dialogs.length === 1); controller.abort();
  await f.wait(() => f.server.rpc.current?.busy === false && f.server.rpc.current.dialogs.length === 0, 15_000);
  assert.equal(existsSync(join(f.cwd, "approved")), false);
});

test("web question answers use the same validation as terminal answers", () => {
  const questions = [{ id: "q", title: "Scope", question: "Which scope?", multiSelect: false, options: [{ id: "a", label: "Project" }, { id: "b", label: "Global" }] }];
  assert.equal(webQuestionAnswers(questions, JSON.stringify([{ id: "q", selected: ["a"], text: "" }]))[0].selected[0].label, "Project");
  for (const value of [[], [{ id: "wrong", selected: ["a"], text: "" }], [{ id: "q", selected: ["unknown"], text: "" }], [{ id: "q", selected: ["a", "b"], text: "" }], [{ id: "q", selected: [], text: "" }]]) assert.throws(() => webQuestionAnswers(questions, JSON.stringify(value)));
});

test("browser display limits remain explicit and do not modify the original messages", () => {
  const original = { id: "large", role: "assistant", parts: Array.from({ length: 4 }, () => ({ type: "text" as const, text: "a".repeat(200_000) })) };
  const bounded = browserMessage(original); assert.ok(JSON.stringify(bounded).length < 512_500);
  assert.match(bounded.parts.at(-1)?.text ?? "", /omitted/); assert.equal(original.parts.length, 4);
  const history = Array.from({ length: 15 }, (_, index) => ({ id: String(index), role: "user", parts: [{ type: "text" as const, text: "x".repeat(200_000) }] }));
  const visible = browserHistory(history); assert.ok(visible.length < history.length);
  assert.match(visible[0].parts[0].text ?? "", /Earlier messages/); assert.equal(history.length, 15);
});

test("a stopped RPC process can reopen its chat and forced shutdown releases a hung process", async t => {
  const f = fixture(t), server = await startWebServer({ cwd: f.cwd, agentDir: f.profile, launcher, version: "fixture", rpcSpawn: fakeEngine(f, true) });
  f.cleanup.push(() => server.close());
  const first = await server.rpc.open(undefined, f.cwd);
  await server.rpc.stop(); assert.equal(server.rpc.current, undefined);
  const second = await server.rpc.open(undefined, f.cwd); assert.notEqual(second.engineId, first.engineId);
  assert.ok(server.rpc.current); await server.rpc.stop(); assert.equal(server.rpc.current, undefined);
});

test("pi ui parses bounded options and help runs without loading an engine or a profile", t => {
  const f = fixture(t); assert.deepEqual(parseUiArgs([]), { port: 0, open: true, help: false });
  assert.equal(parseUiArgs(["--no-open", "--port", "4321"]).port, 4321);
  for (const args of [["--host", "0.0.0.0"], ["--port", "-1"], ["--port", "65536"], ["--port"], ["--port", "1.5"]]) assert.throws(() => parseUiArgs(args), /Usage/);
  const guard = join(f.root, "no-engine.mjs"); writeFileSync(guard, 'import {registerHooks} from "node:module";registerHooks({load(url,context,next){if(url.includes("/node_modules/"))throw Error("Engine loaded");return next(url,context);}});');
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, launcher, "ui", ...args], { cwd: f.cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: f.profile, PI_EXTENDED_RUNTIME_DIR: join(f.root, "runtime") }, encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(run(["--help"]).status, 0); assert.match(run(["--help"]).stdout, /pi ui/); assert.equal(run(["--host"]).status, 2);
  assert.equal(existsSync(f.profile), false);
});

test("the real Pi RPC process retains the wrapper's permission guard in an isolated offline profile", async t => {
  const f = fixture(t), guard = join(f.root, "no-network.mjs"), called = join(f.root, "network-called");
  writeFileSync(guard, `import {writeFileSync} from 'node:fs';globalThis.fetch=async()=>{writeFileSync(${JSON.stringify(called)},'called');throw Error('Fixture networking is disabled');};`);
  const env: NodeJS.ProcessEnv = { PI_OFFLINE: "1", PI_EXTENDED_RUNTIME_DIR: join(f.root, "runtime") };
  for (const key of Object.keys(process.env)) if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET)$/.test(key)) env[key] = undefined;
  const server = await startWebServer({ cwd: f.cwd, agentDir: f.profile, launcher, version: "fixture", rpcSpawn: { executable: process.execPath,
    args: ["--import", pathToFileURL(guard).href, launcher, "--mode", "rpc", "--no-context-files", "--no-skills", "--no-prompt-templates"], env } });
  f.cleanup.push(() => server.close());
  const state = await server.rpc.open(undefined, f.cwd);
  assert.equal(state.chat.cwd, f.cwd); assert.equal(state.busy, false);
  const configured = await server.rpc.configure(state.engineId, { permissions: "deny" });
  assert.equal(configured?.permissions, "deny"); assert.equal(existsSync(called), false, "routine RPC checks must not contact providers or catalogs");
  await server.rpc.prompt(state.engineId, "/mode plan"); assert.equal(server.rpc.current?.workMode, "plan");
  const next = await server.rpc.open(undefined, f.cwd);
  assert.notEqual(next.engineId, state.engineId); assert.notEqual(next.chat.sessionId, state.chat.sessionId);
  assert.equal(next.permissions, "deny", "a new browser chat inherits restrictions before it accepts a prompt");
  assert.equal(next.workMode, "plan"); assert.equal(existsSync(called), false);
  assert.deepEqual(readdirSync(f.cwd), []);
});
