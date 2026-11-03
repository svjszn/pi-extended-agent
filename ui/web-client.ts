import type { WebChat, WebDialog, WebEvent, WebHistory, WebMessage, WebModel, WebState, WebTool } from "../lib/web-types.js";
import { browserHistory } from "../lib/web-types.js";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value;
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asString = (value: unknown) => typeof value === "string" ? value : "";
let token = location.hash.slice(1);
try { if (token) sessionStorage.setItem("pi-ui-token", token); else token = sessionStorage.getItem("pi-ui-token") ?? ""; } catch {}
window.history.replaceState(null, "", location.pathname);
const app = document.querySelector(".app")!, list = element("chat-list"), messages = element("messages"), conversation = element("conversation");
const prompt = element<HTMLTextAreaElement>("prompt"), model = element<HTMLSelectElement>("model"), effort = element<HTMLSelectElement>("effort"), permissions = element<HTMLSelectElement>("permissions");
const notice = element("notice"), activity = element("activity"), search = element<HTMLInputElement>("search"), filter = element<HTMLSelectElement>("project-filter");
const question = element<HTMLDialogElement>("question-dialog"), newDialog = element<HTMLDialogElement>("new-dialog");
let active: WebState | undefined, selected: WebChat | undefined, chats: WebChat[] = [], cwd = "", connected = false, opening = false;
let display: WebMessage[] = [], tools = new Map<string, WebTool>(), models: WebModel[] = [], currentDialog: WebDialog | undefined;
let rendered = new Map<string, { element: HTMLElement; signature: string }>(), searchTimer: ReturnType<typeof setTimeout>, live = true;
const drafts = new Map<string, string>();
let selectionRun = 0, overviewRun = 0;

function showNotice(text: string) { notice.textContent = text; notice.hidden = !text; }
async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { method: data === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    body: data === undefined ? undefined : JSON.stringify(data), cache: "no-store" });
  const value = await response.json(); if (!response.ok) throw new Error(asString(record(value).error) || `Request failed (${response.status}).`); return value as T;
}
function projectName(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path; }
function relativeDate(value: number) {
  const date = new Date(value), today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  today.setDate(today.getDate() - 1); return date.toDateString() === today.toDateString() ? "Yesterday" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function renderList() {
  list.replaceChildren(); let group = "";
  const visible = chats.filter(chat => !filter.value || chat.cwd === filter.value);
  for (const chat of visible) {
    const date = relativeDate(chat.modified);
    if (date !== group) { group = date; list.append(node("div", date, "chat-group")); }
    const button = node("button", undefined, "chat-item"); button.type = "button"; button.setAttribute("aria-current", String(selected?.id === chat.id));
    button.append(node("strong", chat.title), node("small", `${projectName(chat.cwd)}${active?.chat.id === chat.id && active.busy ? " · Working" : ""}`));
    button.title = `${chat.title}\n${chat.cwd}`; button.addEventListener("click", () => { void selectChat(chat); }); list.append(button);
  }
  if (!visible.length) list.append(node("p", search.value || filter.value ? "No matching chats. Try another search." : "No chats yet. Start a conversation in your project.", "list-empty"));
  element("chat-count").textContent = `${visible.length} ${visible.length === 1 ? "chat" : "chats"}`;
}
async function overview(refresh = false) {
  const run = ++overviewRun;
  const result = await api<{ cwd: string; version: string; chats: WebChat[]; skipped: number }>(`overview?q=${encodeURIComponent(search.value)}${refresh ? "&refresh=1" : ""}`);
  if (run !== overviewRun) return;
  cwd = result.cwd; chats = result.chats;
  const currentProject = filter.value, paths = [...new Set(chats.map(chat => chat.cwd))];
  filter.replaceChildren(new Option("All projects", ""), ...paths.map(path => new Option(projectName(path), path)));
  if (paths.includes(currentProject)) filter.value = currentProject;
  if (!selected) { element("project-path").textContent = cwd; element("scope").textContent = cwd; }
  if (result.skipped) showNotice(`${result.skipped} session files could not be listed or exceeded the browser limits. You can still resume them in Pi's terminal.`);
  renderList();
}
function inline(parent: HTMLElement, text: string) {
  // Deliberately small Markdown subset: no HTML, remote images or executable URLs.
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(from, match.index)));
    const part = match[0];
    if (part.startsWith("`")) parent.append(node("code", part.slice(1, -1)));
    else if (part.startsWith("**")) parent.append(node("strong", part.slice(2, -2)));
    else {
      const boundary = part.indexOf("]("), a = node("a", part.slice(1, boundary)); a.href = part.slice(boundary + 2, -1); a.target = "_blank"; a.rel = "noopener noreferrer"; parent.append(a);
    }
    from = match.index! + part.length;
  }
  parent.append(document.createTextNode(text.slice(from)));
}
function markdown(text: string) {
  const container = node("div"), lines = text.split("\n"); let paragraph: string[] = [], code: string[] | undefined, language = "", items: HTMLOListElement | HTMLUListElement | undefined;
  const flush = () => { if (paragraph.length) { const p = node("p"); inline(p, paragraph.join("\n")); container.append(p); paragraph = []; } items = undefined; };
  const flushCode = () => {
    const block = node("div", undefined, "code-block"), header = node("div", undefined, "code-header"), copy = node("button", "Copy"); copy.type = "button";
    const value = (code ?? []).join("\n"); copy.addEventListener("click", () => { void navigator.clipboard.writeText(value).then(() => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200); }).catch(() => showNotice("Select the code and copy it with your keyboard.")); });
    header.append(node("span", language || "Code"), copy); const pre = node("pre"); pre.append(node("code", value)); block.append(header, pre); container.append(block); code = undefined;
  };
  for (const line of lines) {
    if (line.startsWith("```")) { if (code) flushCode(); else { flush(); code = []; language = line.slice(3).trim(); } continue; }
    if (code) { code.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line), item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (heading) { flush(); const title = node(heading[1].length < 3 ? "h2" : "h3"); inline(title, heading[2]); container.append(title); }
    else if (item) {
      if (paragraph.length) flush();
      if (!items) { items = /^\s*\d/.test(line) ? node("ol") : node("ul"); container.append(items); }
      const li = node("li"); inline(li, item[1]); items.append(li);
    } else { if (items) flush(); paragraph.push(line); }
  }
  if (code) flushCode(); flush(); return container;
}
function toolView(id: string, name: string, input: string) {
  const state = tools.get(id), details = node("details", undefined, "tool"); details.dataset.tool = id;
  details.dataset.status = state?.status ?? "done";
  const summary = node("summary"); summary.append(node("strong", name || "Tool"), node("span", state?.status === "running" ? "Running" : state?.status === "error" ? "Failed" : "Finished"));
  details.append(summary, node("pre", state?.input || input));
  if (state?.output) details.append(node("pre", state.output)); return details;
}
function renderMessages() {
  const follow = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100;
  element("welcome").hidden = display.length > 0;
  const keep = new Set<string>();
  for (const message of display) {
    keep.add(message.id);
    const related = message.parts.filter(part => part.type === "tool").map(part => tools.get(part.id ?? ""));
    const signature = JSON.stringify([message, related]); const previous = rendered.get(message.id);
    if (previous?.signature === signature) continue;
    const row = previous?.element ?? node("article", undefined, `message ${message.role.replace(/[^a-zA-Z]/g, "")}`);
    const open = new Set([...row.querySelectorAll<HTMLDetailsElement>("details[open]")].map(details => details.dataset.tool ?? details.className));
    row.replaceChildren(); row.dataset.error = String(message.error === true);
    row.append(node("div", message.role === "assistant" ? "Pi" : message.role === "user" ? "You" : message.role === "toolResult" ? "Tool result" : "Session", "message-role"));
    for (const part of message.parts) {
      if (part.type === "text") row.append(message.role === "assistant" ? markdown(part.text ?? "") : node("p", part.text));
      else if (part.type === "thinking") { const details = node("details", undefined, "thinking"); details.append(node("summary", "Reasoning"), node("pre", part.text)); row.append(details); }
      else if (part.type === "tool") row.append(toolView(part.id ?? "", part.name ?? "Tool", part.input ?? ""));
      else row.append(node("p", part.text));
    }
    for (const details of row.querySelectorAll<HTMLDetailsElement>("details")) details.open = open.has(details.dataset.tool ?? details.className);
    if (!previous) messages.append(row); rendered.set(message.id, { element: row, signature });
  }
  for (const [id, row] of rendered) if (!keep.has(id)) { row.element.remove(); rendered.delete(id); }
  if (follow) conversation.scrollTop = conversation.scrollHeight;
}
function controls() {
  const current = active && active.chat.id === selected?.id, busy = Boolean(active?.busy), disabled = opening || !connected;
  element<HTMLButtonElement>("send").disabled = disabled || busy || Boolean(active?.dialogs.length);
  element("stop").hidden = !busy && !active?.dialogs.length;
  element<HTMLButtonElement>("stop").title = `Stop the reply in ${active?.chat.title ?? "this chat"}`;
  model.disabled = effort.disabled = permissions.disabled = !current || disabled || busy || Boolean(active?.dialogs.length);
  element("resume").hidden = !selected?.sessionId;
  if (current) { permissions.value = active!.permissions; if (active!.model) model.value = `${active!.model.provider}\0${active!.model.id}`; effort.value = active!.thinking; }
  element("chat-title").textContent = selected?.title ?? "Your next idea starts here.";
  element("project-path").textContent = selected?.cwd ?? cwd;
  element("scope").textContent = (selected?.cwd ?? cwd) + (current && active!.workMode !== "auto" ? ` · ${active!.workMode} mode` : "");
}
function setActivity(text: string) { activity.textContent = text; activity.dataset.busy = String(active?.busy ?? false); controls(); }
function applyState(state: WebState) {
  active = state;
  if (!selected || selected.id === state.chat.id || selected.id === "") { selected = state.chat; display = state.messages; tools = new Map(state.tools.map(tool => [tool.id, tool])); renderMessages(); }
  setActivity(state.busy ? "Working" : ""); renderList(); dialogs();
}
async function loadSettings() {
  if (!active) return; const engineId = active.engineId;
  const available = await api<WebModel[]>("models", { engineId }); if (active?.engineId !== engineId) return;
  models = available; model.replaceChildren(...available.map(value => new Option(value.name || value.id, `${value.provider}\0${value.id}`)));
  if (!available.length) model.append(new Option("No models — connect a provider in Pi", ""));
  const data = await api<{ levels: string[] }>("levels", { engineId });
  if (active?.engineId !== engineId) return;
  effort.replaceChildren(...data.levels.map(level => new Option(level, level))); controls();
}
async function selectChat(chat: WebChat) {
  const run = ++selectionRun;
  if (selected) drafts.set(selected.id, prompt.value);
  selected = chat; prompt.value = drafts.get(chat.id) ?? ""; app.classList.remove("sidebar-open");
  opening = true; showNotice(""); controls(); renderList(); setActivity("Opening chat…");
  try {
    if (active?.chat.id === chat.id) applyState(active);
    else {
      const history = await api<WebHistory>(`chats/${chat.id}`); if (run !== selectionRun) return;
      selected = history.chat; display = history.messages; tools.clear(); renderMessages();
      if (active?.busy || active?.dialogs.length) { showNotice("A reply is running in another chat. Stop it before continuing here."); return; }
      const state = await api<WebState>("open", { id: chat.id }); if (run !== selectionRun) return; applyState(state);
    }
    await loadSettings();
  } catch (error) { if (run === selectionRun) showNotice((error as Error).message); }
  finally { if (run === selectionRun) { opening = false; setActivity(active?.busy ? "Working" : ""); controls(); } }
}
async function ensureActive() {
  if (active && active.chat.id === selected?.id) return active;
  const state = await api<WebState>("open", selected ? { id: selected.id } : { cwd }); applyState(state); await loadSettings(); return state;
}

let getAnswer: (() => Record<string, unknown>) | undefined;
function dialogs() {
  const pending = active?.dialogs[0]; if (pending?.id === currentDialog?.id && question.open) return;
  if (question.open) question.close(); currentDialog = pending; getAnswer = undefined;
  if (!pending) return;
  element("question-title").textContent = pending.title; element("question-error").textContent = "";
  const body = element("question-body"); body.replaceChildren();
  if (active?.chat.id !== selected?.id) body.append(node("p", `Chat: ${active?.chat.title}\nProject: ${active?.chat.cwd}`));
  const answer = element<HTMLButtonElement>("question-answer"); answer.textContent = pending.method === "confirm" ? /^Allow .+ once\?$/.test(pending.title) ? "Allow once" : "Confirm" : "Continue";
  if (pending.method === "confirm") { body.append(node("pre", pending.message ?? "")); getAnswer = () => ({ confirmed: true }); }
  else if (pending.method === "select") {
    const select = node("select"); select.setAttribute("aria-label", pending.title);
    const first = new Option("Choose an option…", ""); first.disabled = true; first.selected = true; select.append(first, ...(pending.options ?? []).map(value => new Option(value, value))); body.append(select);
    getAnswer = () => { if (!select.value) throw Error("Choose an option before continuing."); return { value: select.value }; };
  } else if (pending.method === "editor" && pending.prefill?.startsWith("PI_WEB_QUESTIONS\n")) {
    try {
      const questions = JSON.parse(pending.prefill.slice("PI_WEB_QUESTIONS\n".length)) as { id: string; title: string; question: string; multiSelect: boolean; options: { id: string; label: string; description?: string; recommended?: boolean }[] }[];
      const drafts: { id: string; selected: HTMLInputElement[]; text: HTMLTextAreaElement }[] = [];
      for (const item of questions) {
        body.append(node("h3", item.title, "question-heading"), node("p", item.question)); const selected: HTMLInputElement[] = [];
        for (const option of item.options) {
          const label = node("label", undefined, "question-option"), check = node("input"); check.type = item.multiSelect ? "checkbox" : "radio"; check.name = item.id; check.value = option.id;
          const text = node("span"); text.append(node("strong", option.label + (option.recommended ? " (Recommended)" : ""))); if (option.description) text.append(node("small", option.description));
          label.append(check, text); body.append(label); selected.push(check);
        }
        const label = node("label", "Your answer or extra details"), text = node("textarea"); text.maxLength = 2000; label.append(text); body.append(label); drafts.push({ id: item.id, selected, text });
      }
      getAnswer = () => {
        const values = drafts.map(item => ({ id: item.id, selected: item.selected.filter(input => input.checked).map(input => input.value), text: item.text.value }));
        if (values.some(value => !value.selected.length && !value.text.trim())) throw Error("Answer each question before continuing.");
        if (values.some(value => new TextEncoder().encode(value.text).length > 2000)) throw Error("Keep each written answer within 2,000 UTF-8 bytes.");
        return { value: JSON.stringify(values) };
      };
      answer.textContent = "Send answers";
    } catch { body.append(node("p", "This question could not be displayed. Cancel it and ask Pi to restate it.")); }
  } else {
    const input = pending.method === "editor" ? node("textarea") : node("input"); input.setAttribute("aria-label", pending.title); input.value = pending.prefill ?? ""; input.placeholder = pending.placeholder ?? "";
    if (input instanceof HTMLInputElement) input.type = "text"; body.append(input); getAnswer = () => ({ value: input.value });
  }
  question.showModal(); element("question-cancel").focus();
}
async function answerQuestion(cancelled: boolean) {
  if (!active || !currentDialog) return;
  try {
    if (!cancelled && !getAnswer) throw Error("Cancel this question and ask Pi to restate it.");
    const input = cancelled ? { cancelled: true } : getAnswer!();
    await api("answer", { engineId: active.engineId, id: currentDialog.id, ...input });
  } catch (error) { element("question-error").textContent = (error as Error).message; }
}
function event(value: WebEvent) {
  if (value.type === "connected") return;
  if (value.type === "state") { applyState(value.data as WebState); void overview().catch(() => {}); return; }
  if (value.type === "dialogs" && (!active || active.engineId !== value.engineId)) {
    void api<WebState | null>("state").then(state => { if (state) applyState(state); }).catch(error => showNotice(error.message)); return;
  }
  if (!active || value.engineId !== active.engineId) return;
  if (value.type === "dialogs") { active.dialogs = value.data as WebDialog[]; dialogs(); controls(); }
  else if (value.type === "activity") {
    const status = record(value.data), text = asString(status.text); active.busy = status.busy === true; setActivity(active.busy ? text : ""); renderList();
  } else if (value.type === "message") {
    const message = value.data as WebMessage, index = active.messages.findIndex(item => item.id === message.id);
    if (index >= 0) active.messages[index] = message; else active.messages.push(message);
    active.messages = browserHistory(active.messages);
    if (selected?.id === active.chat.id) { display = active.messages; renderMessages(); }
  } else if (value.type === "tool") {
    const tool = value.data as WebTool; tools.set(tool.id, tool);
    while (tools.size > 1 && (tools.size > 200 || [...tools.values()].reduce((size, item) => size + item.input.length + item.output.length, 0) > 1024 * 1024)) tools.delete(tools.keys().next().value!);
    if (selected?.id === active.chat.id) renderMessages();
  } else if (value.type === "error") { active = undefined; setActivity(""); showNotice(String(value.data)); }
  else if (value.type === "notice") showNotice(String(value.data));
  else if (value.type === "draft" && active.chat.id === selected?.id) prompt.value = String(value.data);
}
async function stream() {
  while (live) {
    const controller = new AbortController();
    const close = () => { live = false; controller.abort(); }; window.addEventListener("pagehide", close, { once: true });
    try {
      const response = await fetch("/api/events", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (!response.ok || !response.body) throw Error("Reconnect using the complete URL printed by pi ui.");
      connected = true; element("connection").textContent = "Connected"; element("connection").dataset.connected = "true"; controls();
      const snapshot = await api<WebState | null>("state"); if (snapshot) applyState(snapshot);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
      while (live) {
        const result = await reader.read(); if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true }); if (buffer.length > 32 * 1024 * 1024) throw Error("The chat stream exceeded its limit. Refresh the dashboard.");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          for (const line of block.split("\n")) if (line.startsWith("data: ")) event(JSON.parse(line.slice(6)) as WebEvent);
        }
      }
    } catch (error) { if (live) showNotice((error as Error).message); }
    finally { controller.abort(); window.removeEventListener("pagehide", close); connected = false; element("connection").textContent = "Disconnected"; element("connection").dataset.connected = "false"; controls(); }
    if (live) await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

element<HTMLFormElement>("composer").addEventListener("submit", event => {
  event.preventDefault(); const text = prompt.value; if (!text.trim() || opening || active?.busy || active?.dialogs.length) return;
  void (async () => {
    opening = true; controls(); showNotice("");
    try {
      const state = await ensureActive(); prompt.value = ""; drafts.delete(state.chat.id); active!.busy = true; setActivity("Working");
      await api("prompt", { engineId: state.engineId, text });
    } catch (error) { prompt.value = text; if (active) active.busy = false; showNotice((error as Error).message); }
    finally { opening = false; controls(); }
  })();
});
prompt.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); element<HTMLFormElement>("composer").requestSubmit(); } });
element("stop").addEventListener("click", () => { if (active) void api("abort", { engineId: active.engineId }).catch(error => showNotice(error.message)); });
search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { void overview().catch(error => showNotice(error.message)); }, 180); });
filter.addEventListener("change", renderList);
element("refresh").addEventListener("click", () => { void overview(true).then(() => active ? loadSettings() : undefined).catch(error => showNotice(error.message)); });
element("menu").addEventListener("click", () => app.classList.toggle("sidebar-open"));
document.addEventListener("keydown", event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); app.classList.add("sidebar-open"); search.focus(); } if (event.key === "Escape") app.classList.remove("sidebar-open"); });
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-prompt]")) button.addEventListener("click", () => { prompt.value = button.dataset.prompt ?? ""; prompt.focus(); });
function theme(value: string) { document.documentElement.dataset.theme = value; try { localStorage.setItem("pi-ui-theme", value); } catch {} }
try { theme(localStorage.getItem("pi-ui-theme") ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")); } catch { theme("dark"); }
element("theme").addEventListener("click", () => theme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
element("resume").addEventListener("click", () => { if (selected && /^[a-zA-Z0-9_-]{1,120}$/.test(selected.sessionId)) void navigator.clipboard.writeText(`pi --resume ${selected.sessionId}`).then(() => showNotice("Terminal resume command copied.")).catch(() => showNotice(`pi --resume ${selected!.sessionId}`)); });
element("new-chat").addEventListener("click", () => { element<HTMLInputElement>("new-directory").value = cwd; element("new-error").textContent = ""; newDialog.showModal(); });
element("new-cancel").addEventListener("click", () => newDialog.close());
element<HTMLFormElement>("new-form").addEventListener("submit", event => {
  event.preventDefault();
  void (async () => {
    try {
      opening = true; controls();
      const state = await api<WebState>("open", { cwd: element<HTMLInputElement>("new-directory").value });
      if (selected) drafts.set(selected.id, prompt.value); selected = undefined; prompt.value = ""; applyState(state);
      await loadSettings(); newDialog.close(); app.classList.remove("sidebar-open"); prompt.focus(); await overview();
    } catch (error) { element("new-error").textContent = (error as Error).message; }
    finally { opening = false; controls(); }
  })();
});
async function configure(data: Record<string, unknown>) {
  if (!active) return;
  opening = true; controls();
  try { const state = await api<WebState>("configure", { engineId: active.engineId, ...data }); applyState(state); if (data.model) await loadSettings(); }
  catch (error) { showNotice((error as Error).message); }
  finally { opening = false; controls(); }
}
model.addEventListener("change", () => { const selected = models.find(item => `${item.provider}\0${item.id}` === model.value); if (selected) void configure({ model: selected.id, provider: selected.provider }); });
effort.addEventListener("change", () => { void configure({ thinking: effort.value }); });
permissions.addEventListener("change", () => { void configure({ permissions: permissions.value }); });
element("question-cancel").addEventListener("click", () => { void answerQuestion(true); });
element("question-answer").addEventListener("click", () => { void answerQuestion(false); });
question.addEventListener("cancel", event => { event.preventDefault(); void answerQuestion(true); });
controls();
if (!token) showNotice("Open the complete dashboard URL printed by pi ui in your terminal.");
else { void overview().catch(error => showNotice(error.message)); void stream(); }
