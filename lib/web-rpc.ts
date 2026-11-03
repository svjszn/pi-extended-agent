import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { object, string, browserHistory, browserMessage } from "./web-types.js";
import type { WebChat, WebDialog, WebEvent, WebMessage, WebModel, WebPart, WebState, WebTool } from "./web-types.js";
import { WebSessions, webInput, webMessage, webProjection, webText } from "./web-sessions.js";
import { hasModel } from "./startup.js";

// Review control bytes visibly; stripping terminal escapes could hide part of an approval.
const reviewText = (value: unknown) => string(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

export interface RpcSpawn { executable: string; args: string[]; env?: NodeJS.ProcessEnv }
export class WebRpc {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { accept(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private dialogs = new Map<string, WebDialog>();
  private dialogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private state?: WebState;
  private generation = 0;
  private opening = false;
  private configuring = false;
  private stopped = false;
  private counter = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private draft?: WebMessage;
  constructor(private options: { cwd: string; agentDir: string; launcher: string; sessions: WebSessions;
    emit(event: WebEvent): void; spawn?: RpcSpawn; sessionDir?: string }) {}
  get current() { return this.child && this.child.stdin.writable && !this.child.stdin.destroyed ? this.state : undefined; }
  private publish(type: string, data?: unknown) { this.options.emit({ type, engineId: this.state?.engineId, data: type === "activity" ? { text: data, busy: this.state?.busy ?? false } : data }); }
  private write(value: unknown) {
    if (!this.child || this.child.stdin.destroyed || !this.child.stdin.writable) throw new Error("Pi is not connected. Reopen this chat.");
    const line = JSON.stringify(value) + "\n";
    if (this.child.stdin.writableLength > 1024 * 1024) throw new Error("Pi's command queue is full. Wait before retrying.");
    this.child.stdin.write(line, error => { if (error) { this.fail(new Error("Pi's command connection closed.")); void this.stop(); } });
  }
  private request(type: string, data: Record<string, unknown> = {}, timeout = 30_000): Promise<unknown> {
    const id = randomUUID();
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi did not respond to ${type}. Stop and reopen the chat.`)); }, timeout);
      this.pending.set(id, { accept, reject, timer });
      try { this.write({ id, type, ...data }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.clearDialogs();
    if (this.state) this.state.busy = false;
    if (!this.stopped) this.publish("error", error.message);
  }
  private clearDialogs(cancel = false) {
    if (cancel && this.child?.stdin.writable) for (const id of this.dialogs.keys()) this.write({ type: "extension_ui_response", id, cancelled: true });
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    this.dialogTimers.clear(); this.dialogs.clear(); if (this.state) this.state.dialogs = [];
  }
  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer); this.flushTimer = undefined;
    if (this.draft) {
      const message = browserMessage(this.draft), index = this.state?.messages.findIndex(item => item.id === message.id) ?? -1;
      if (this.state && index >= 0) this.state.messages[index] = message;
      this.publish("message", message);
    }
  }
  private receive(value: unknown) {
    const event = object(value), type = string(event.type);
    if (type === "response") {
      const id = string(event.id), pending = this.pending.get(id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(id);
      if (event.success === true) pending.accept(event.data);
      else pending.reject(new Error(webText(event.error, 4000) || "Pi rejected the command."));
      return;
    }
    if (!this.state) return;
    if ((type === "message_start" || type === "message_end") && object(event.message).role === "custom" && object(event.message).display === false) return;
    if (type === "message_start") {
      this.flush(); const message = webMessage(event.message, `live-${this.counter++}`);
      this.state.messages.push(message); this.state.messages = browserHistory(this.state.messages); this.draft = message; this.publish("message", message);
    } else if (type === "message_update" && this.draft) {
      const update = object(event.assistantMessageEvent), index = Number(update.contentIndex);
      if (!Number.isInteger(index) || index < 0 || index > 199) return;
      const kind = string(update.type), parts = this.draft.parts;
      if (kind === "text_start" || kind === "thinking_start") parts[index] = { type: kind === "text_start" ? "text" : "thinking", text: "" };
      else if (kind === "toolcall_start") parts[index] = { type: "tool", id: string(update.id), name: string(update.toolName), input: "" };
      else if (kind === "toolcall_end") {
        const call = object(update.toolCall); parts[index] = { type: "tool", id: string(call.id), name: string(call.name), input: webInput(call.arguments) };
      } else {
        const part = parts[index]; if (!part) return;
        if (kind === "text_delta" || kind === "thinking_delta") part.text = webText((part.text ?? "") + string(update.delta));
        else if (kind === "text_end" || kind === "thinking_end") part.text = webText(update.content);
        else if (kind === "toolcall_delta") part.input = webText((part.input ?? "") + string(update.delta));
      }
      if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flush(); }, 40);
    } else if (type === "message_end") {
      const message = webMessage(event.message, this.draft?.id ?? `live-${this.counter++}`);
      if (this.draft) this.state.messages[this.state.messages.length - 1] = message;
      else this.state.messages.push(message);
      this.state.messages = browserHistory(this.state.messages);
      this.draft = message; this.flush(); this.draft = undefined;
    } else if (type.startsWith("tool_execution_")) {
      const id = string(event.toolCallId), previous = this.state.tools.find(tool => tool.id === id);
      const result = object(type === "tool_execution_update" ? event.partialResult : event.result);
      const output = webMessage({ role: "toolResult", content: result.content }, id).parts.map(part => part.text ?? "").join("\n");
      const tool: WebTool = { id, name: string(event.toolName, previous?.name), input: event.args !== undefined ? webInput(event.args) : previous?.input ?? "",
        output: output || previous?.output || "", status: type === "tool_execution_end" ? event.isError === true ? "error" : "done" : "running" };
      if (previous) Object.assign(previous, tool); else { this.state.tools.push(tool); if (this.state.tools.length > 200) this.state.tools.shift(); }
      while (this.state.tools.length > 1 && this.state.tools.reduce((size, item) => size + item.input.length + item.output.length, 0) > 1024 * 1024) this.state.tools.shift();
      this.publish("tool", tool);
    } else if (type === "extension_ui_request") this.ui(event);
    else if (type === "agent_start") { this.state.busy = true; this.publish("activity", "Working"); }
    else if (type === "agent_settled") {
      this.flush(); this.state.busy = false; this.clearDialogs(true); this.publish("activity", event.aborted ? "Stopped" : "Ready");
      void this.synchronize().catch(error => this.publish("error", error.message));
    } else if (type === "compaction_start" || type === "auto_compaction_start") this.publish("activity", "Compacting context");
    else if (type === "auto_retry_start") this.publish("activity", "Retrying request");
    else if (type === "session_info_changed" || type === "thinking_level_changed" || type === "entry_appended") {
      if (type === "session_info_changed") this.state.chat.title = webText(event.name, 180) || this.state.chat.title;
      if (!this.state.busy && !this.opening) void this.synchronize().catch(error => this.publish("error", error.message));
    }
  }
  private ui(event: Record<string, unknown>) {
    const method = string(event.method), id = string(event.id);
    if (["confirm", "select", "input", "editor"].includes(method)) {
      if (this.dialogs.size >= 16) { this.write({ type: "extension_ui_response", id, cancelled: true }); return; }
      const dialog: WebDialog = { id, method: method as WebDialog["method"], title: webText(event.title, 8000), message: reviewText(event.message),
        options: Array.isArray(event.options) ? event.options.slice(0, 100).map(value => string(value)) : undefined,
        prefill: string(event.prefill), placeholder: webText(event.placeholder, 8000) };
      // Approval requests must be displayed in full. Refuse rather than approve an omitted tail.
      if ([event.message, event.prefill].some(value => typeof value === "string" && value.length > 256_000)
        || string(event.title).length > 8000 || Array.isArray(event.options) && (event.options.length > 100 || event.options.some(value => typeof value !== "string" || value.length > 4000))) {
        this.write({ type: "extension_ui_response", id, cancelled: true }); this.publish("notice", "A dialog was too large to review and was cancelled."); return;
      }
      this.dialogs.set(id, dialog); this.state!.dialogs = [...this.dialogs.values()]; this.publish("dialogs", this.state!.dialogs);
      if (typeof event.timeout === "number" && event.timeout > 0) this.dialogTimers.set(id, setTimeout(() => {
        this.dialogs.delete(id); this.dialogTimers.delete(id); this.state!.dialogs = [...this.dialogs.values()]; this.publish("dialogs", this.state!.dialogs);
      }, Math.min(event.timeout, 2_147_483_647)));
    } else if (method === "notify") this.publish("notice", webText(event.message, 8000));
    else if (method === "set_editor_text") this.publish("draft", webText(event.text));
    else if (method === "setStatus" && event.statusText) this.publish("activity", webText(event.statusText, 1000));
  }
  async open(id?: string, directory?: string) {
    if (this.opening) throw new Error("A chat is already opening. Wait before trying again.");
    if (id && this.current?.chat.id === id) return this.state!;
    if (this.state?.busy || this.dialogs.size || this.configuring) throw new Error("Stop the current reply or wait for settings before opening another chat.");
    this.opening = true;
    const beforeOpening = this.generation;
    try {
      const preferences = !id && this.state ? { model: this.state.model, thinking: this.state.thinking, permissions: this.state.permissions, workMode: this.state.workMode } : undefined;
      let path: string | undefined, history;
      if (id) { path = await this.options.sessions.resolve(id); history = await this.options.sessions.history(id); }
      const directoryName = (history?.chat.cwd || directory || this.options.cwd).replace(/^~(?=$|[\\/])/, () => homedir());
      const cwd = await realpath(resolve(this.options.cwd, directoryName));
      if (!(await lstat(cwd)).isDirectory()) throw new Error("Choose an existing project directory.");
      await this.stop(); this.stopped = false;
      const generation = ++this.generation;
      const launch = this.options.spawn ?? { executable: process.execPath, args: [this.options.launcher, "--mode", "rpc", ...(path ? ["--session", path] : [])] };
      this.child = spawn(launch.executable, launch.args, { cwd, windowsHide: true, stdio: "pipe", env: { ...process.env, ...launch.env,
        PI_CODING_AGENT_DIR: this.options.agentDir, PI_EXTENDED_WEB_UI: "1", PI_SKIP_VERSION_CHECK: "1",
        ...(this.options.sessionDir ? { PI_CODING_AGENT_SESSION_DIR: resolve(this.options.sessionDir) } : {}) } });
      this.child.stderr.resume(); // Provider/configuration diagnostics may contain secrets; never log or forward stderr.
      let buffer = ""; this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (chunk: string) => {
        if (generation !== this.generation) return;
        buffer += chunk;
        if (buffer.length > 32 * 1024 * 1024) { this.fail(new Error("Pi sent an oversized RPC record.")); void this.stop(); return; }
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
          if (!line) continue;
          try { this.receive(JSON.parse(line)); } catch { this.fail(new Error("Pi sent an invalid RPC record.")); void this.stop(); return; }
        }
      });
      this.child.on("error", () => { if (generation === this.generation) this.fail(new Error("Pi could not start. Run pi doctor in your terminal.")); });
      this.child.on("close", () => {
        if (generation !== this.generation) return;
        this.child = undefined; this.fail(new Error("Pi stopped. Check pi doctor and reopen this chat."));
      });
      const blank: WebChat = history?.chat ?? { id: "", sessionId: "", title: "New chat", preview: "", cwd, modified: Date.now(), count: 0 };
      this.state = { engineId: randomUUID(), chat: blank, busy: false, thinking: "off", messages: [], tools: [], dialogs: [], permissions: "allow", workMode: "auto" };
      await this.synchronize(false);
      if (preferences) {
        // Inherit restrictions before the new browser chat can admit any user prompt.
        await this.request("prompt", { message: `/permissions ${preferences.permissions}` });
        if (preferences.model) {
          await this.request("set_model", { provider: preferences.model.provider, modelId: preferences.model.id });
          await this.request("set_thinking_level", { level: preferences.thinking });
        }
        if (preferences.workMode === "plan" || preferences.workMode === "code") await this.request("prompt", { message: `/mode ${preferences.workMode}` });
      }
      await this.synchronize(); return this.state;
    } catch (error) { if (this.generation !== beforeOpening) { await this.stop(); this.state = undefined; } throw error; }
    finally { this.opening = false; }
  }
  private async synchronize(broadcast = true) {
    if (!this.state || !this.child) return;
    const state = object(await this.request("get_state", {}, this.opening ? 120_000 : 30_000)), current = this.state;
    const entries = object(await this.request("get_entries"));
    const projection = webProjection(Array.isArray(entries.entries) ? entries.entries : [], typeof entries.leafId === "string" || entries.leafId === null ? entries.leafId : undefined);
    if (current !== this.state) return;
    const model = object(state.model);
    current.model = typeof model.id === "string" && typeof model.provider === "string" && hasModel({ provider: model.provider, api: string(model.api) })
      ? { id: model.id, provider: model.provider, name: string(model.name, model.id) } : undefined;
    current.thinking = string(state.thinkingLevel, "off");
    if (typeof state.sessionFile === "string") current.chat.id = await this.options.sessions.register(state.sessionFile);
    current.chat.sessionId = string(state.sessionId); current.chat.title = webText(state.sessionName, 180) || current.chat.title;
    if (state.isStreaming === true || state.isCompacting === true) current.busy = true;
    if (!current.busy) {
      current.messages = browserHistory(projection.messages); current.permissions = projection.permissions; current.workMode = projection.workMode;
      const first = projection.messages.find(message => message.role === "user")?.parts.find(part => part.type === "text")?.text ?? "";
      current.chat.preview = first.slice(0, 240);
      if (!state.sessionName && first) current.chat.title = first.replace(/\s+/g, " ").slice(0, 100);
      current.chat.count = projection.messages.filter(message => message.role === "user" || message.role === "assistant").length;
    }
    current.chat.modified = Date.now(); this.options.sessions.invalidate(); if (broadcast) this.publish("state", current);
  }
  private check(engineId: string, allowOpening = false) {
    if (this.opening && !allowOpening) throw new Error("A chat is already opening. Wait before trying again.");
    if (this.configuring) throw new Error("Wait for settings to finish before sending another command.");
    if (!this.state || !this.child || engineId !== this.state.engineId) throw new Error("This chat is no longer active. Reopen it before sending.");
    return this.state;
  }
  async prompt(engineId: string, text: string) {
    const current = this.check(engineId);
    if (current.busy || this.dialogs.size) throw new Error("Wait for the current reply or stop it first.");
    if (!text.trim() || Buffer.byteLength(text) > 256_000) throw new Error("Enter a message of at most 256,000 bytes.");
    current.busy = true; current.tools = []; this.publish("activity", "Working");
    try {
      const result = object(await this.request("prompt", { message: text }, 600_000));
      if (result.disposition === "handled" || result.disposition === "cancelled") { current.busy = false; await this.synchronize(); }
      return { accepted: true };
    } catch (error) {
      await this.request("abort").catch(() => {}); current.busy = false; this.clearDialogs(true); this.publish("activity", "Ready"); throw error;
    }
  }
  async abort(engineId: string) {
    this.check(engineId, true);
    for (const id of this.dialogs.keys()) this.write({ type: "extension_ui_response", id, cancelled: true });
    this.clearDialogs(); this.publish("dialogs", []);
    await this.request("abort");
  }
  answer(engineId: string, value: Record<string, unknown>) {
    this.check(engineId, true); const id = string(value.id), dialog = this.dialogs.get(id);
    if (!dialog) throw new Error("This question is no longer pending.");
    const response: Record<string, unknown> = { type: "extension_ui_response", id };
    if (value.cancelled === true) response.cancelled = true;
    else if (dialog.method === "confirm" && typeof value.confirmed === "boolean") response.confirmed = value.confirmed;
    else if (dialog.method !== "confirm" && typeof value.value === "string" && Buffer.byteLength(value.value) <= 256_000) {
      if (dialog.method === "select" && !dialog.options?.includes(value.value)) throw new Error("Choose one of the available options.");
      response.value = value.value;
    } else throw new Error("Invalid question response.");
    this.write(response); this.dialogs.delete(id);
    const timer = this.dialogTimers.get(id); if (timer) clearTimeout(timer); this.dialogTimers.delete(id);
    this.state!.dialogs = [...this.dialogs.values()]; this.publish("dialogs", this.state!.dialogs);
  }
  async models(engineId: string) {
    this.check(engineId); const data = object(await this.request("get_available_models"));
    return (Array.isArray(data.models) ? data.models : []).map(value => {
      const model = object(value); return { provider: string(model.provider), id: string(model.id), name: string(model.name, string(model.id)) } satisfies WebModel;
    });
  }
  async levels(engineId: string) { this.check(engineId); return this.request("get_available_thinking_levels"); }
  async configure(engineId: string, values: Record<string, unknown>) {
    const current = this.check(engineId); if (current.busy || this.dialogs.size) throw new Error("Wait for Pi to finish before changing settings.");
    if (values.permissions !== undefined && !["allow", "ask", "deny"].includes(string(values.permissions))) throw new Error("Choose allow, ask, or deny.");
    this.configuring = true;
    try {
      if (typeof values.model === "string" && typeof values.provider === "string") await this.request("set_model", { provider: values.provider, modelId: values.model });
      if (typeof values.thinking === "string") await this.request("set_thinking_level", { level: values.thinking });
      if (["allow", "ask", "deny"].includes(string(values.permissions))) await this.request("prompt", { message: `/permissions ${values.permissions}` });
      await this.synchronize(); return this.state;
    } finally { this.configuring = false; }
  }
  async stop() {
    this.stopped = true; this.generation++; this.flush();
    const child = this.child; this.child = undefined;
    this.fail(new Error("The chat was closed."));
    if (!child) return;
    await new Promise<void>(accept => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(timer); accept(); };
      child.once("close", finish);
      timer = setTimeout(() => { child.kill("SIGKILL"); }, 3000);
      child.stdin.end();
    });
  }
}
