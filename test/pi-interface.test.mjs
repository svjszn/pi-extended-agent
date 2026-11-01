import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createFooter, createHeader, pinTerminalTitle } from "../dist/ui/chrome.js";
import { createChatStyle } from "../dist/ui/chat.js";
import { createCommandPanel } from "../dist/ui/command-panel.js";
import { createUiTheme } from "../dist/ui/theme.js";
import { shareTranscriptFrame } from "../dist/bin/transcript-interface.js";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const require = createRequire(piEntry);
const tuiEntry = pathToFileURL(require.resolve("@earendil-works/pi-tui"));
const { Container, Spacer, truncateToWidth, visibleWidth, stripTerminalSequences } = await import(tuiEntry.href);
const { renderLayoutFrame, getLayoutBoxesAt } = await import(new URL("./layout.js", tuiEntry).href);
const { createChatViewport } = await import(new URL("./modes/interactive/chat-viewport.js", piEntry).href);
const { UserMessageComponent } = await import(new URL("./modes/interactive/components/user-message.js", piEntry).href);
const { AssistantMessageComponent } = await import(new URL("./modes/interactive/components/assistant-message.js", piEntry).href);
const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", piEntry).href);
const { ToolExecutionComponent } = await import(piEntry);
const theme = { bold: (s) => s, fg: (_color, s) => s };
const measure = { truncateToWidth, visibleWidth };
const content = (lines) => ({ render: () => lines, invalidate() {} });

function scene(width, height, messages, resources = []) {
  const document = new Container();
  const headerContainer = new Container();
  document.addChild(headerContainer);
  const resourceList = content(resources);
  document.addChild(resourceList);
  document.addChild(content(messages));
  const pendingMessages = content([]);
  const status = content([]);
  const widgetsAbove = new Spacer(1);
  const editor = { render: (columns) => ["─".repeat(columns), "> ", "─".repeat(columns)], invalidate() {} };
  const widgetsBelow = content([]);
  const state = { model: { id: "gpt-6.1-sol" }, thinking: "medium", cwd: process.cwd() };
  const tui = { mode: "fullscreen", terminal: { rows: height, columns: width }, requestRender() {} };
  const footer = createFooter(
    { cwd: process.cwd() },
    tui, theme,
    { onBranchChange: () => () => {}, getGitBranch: () => "main" },
    measure,
  );
  tui.children = [document, pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer];
  const nativeDocumentRender = document.render;
  const header = createHeader(tui, measure, {
    version: "0.85.1", getModel: () => state.model, getThinkingLevel: () => state.thinking, getCwd: () => state.cwd,
  });
  headerContainer.addChild(new Spacer(1));
  headerContainer.addChild(header);
  headerContainer.addChild(new Spacer(1));
  const viewport = createChatViewport({ document, pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer, scrollbar: "hidden" });
  const frame = () => renderLayoutFrame(viewport.root, tui.terminal.columns, tui.terminal.rows, () => {});
  return {
    tui, header, footer, document, resourceList, state, editor, frame, nativeDocumentRender,
    render: () => frame().lines.map(stripTerminalSequences),
  };
}

test("transcript siblings render once per frame, including the first frame and offscreen history", () => {
  for (const count of [2, 1000]) {
    const view = scene(80, 24, []), chat = new Container();
    let renders = 0;
    for (let i = 0; i < count; i++) chat.addChild({ render() { renders++; return [`Message ${i}`]; }, invalidate() {} });
    view.document.children[view.document.children.length - 1] = chat;
    try {
      for (const [width, height] of [[80, 24], [24, 12], [100, 36], [80, 24]]) {
        view.tui.terminal.columns = width; view.tui.terminal.rows = height;
        renders = 0; const lines = view.render();
        assert.equal(renders, count, "measuring the header gap must reuse this frame's transcript output");
        assert.equal(lines.length, height);
        assert.ok(lines.some((line) => line.trim() === `Message ${count - 1}`));
      }
    } finally { view.header.dispose(); }
    assert.equal(view.document.render, view.nativeDocumentRender);
  }
});

test("frame sharing preserves width-specific results, fresh frames, errors and render ownership", () => {
  let calls = 0, value = "first", fail = false;
  const child = { render(width) { calls++; if (fail) throw new Error("fixture render failure"); return [`${value}:${width}`]; } };
  const render = child.render;
  const document = { children: [child], render(width) { return [...child.render(width), ...child.render(width), ...child.render(width + 1)]; } };
  const native = document.render, restore = shareTranscriptFrame(document);
  assert.deepEqual(document.render(20), ["first:20", "first:20", "first:21"]); assert.equal(calls, 2);
  assert.equal(child.render, render);
  value = "next"; assert.deepEqual(document.render(20), ["next:20", "next:20", "next:21"]); assert.equal(calls, 4);
  fail = true; assert.throws(() => document.render(20), /fixture render failure/); assert.equal(child.render, render);
  fail = false; assert.match(document.render(20)[0], /next/);
  restore(); restore(); assert.equal(document.render, native);
  const stop = shareTranscriptFrame(document), replacement = () => [];
  document.render = replacement; stop(); assert.equal(document.render, replacement);
});

test("header measurements track streaming, compaction and a changing input dock without stale heights", () => {
  const messages = ["Old response"], view = scene(80, 24, messages);
  try {
    assert.equal(view.render().findIndex((line) => line.trim() === "Old response"), 18);
    messages.push("Streamed line", "Newest response");
    let lines = view.render();
    assert.equal(lines.findIndex((line) => line.trim() === "Newest response"), 18);
    view.editor.render = (width) => ["─".repeat(width), "> ", "input line 2", "input line 3", "─".repeat(width)];
    lines = view.render(); assert.equal(lines.findIndex((line) => line.trim() === "Newest response"), 16);
    messages.splice(0, messages.length, "Compacted response");
    lines = view.render(); assert.equal(lines.findIndex((line) => line.trim() === "Compacted response"), 16);
    assert.ok(!lines.some((line) => line.includes("Old response") || line.includes("Newest response")));
    messages.length = 0; lines = view.render(); assert.equal(lines[1].slice(2, 10), "██████  ");
  } finally { view.header.dispose(); }
});

test("regular mode keeps native document rendering after a fullscreen header is replaced", () => {
  const view = scene(80, 24, ["Regular transcript"]);
  view.header.dispose();
  const container = view.document.children[0], previous = container.children.indexOf(view.header);
  view.tui.mode = "regular";
  const header = createHeader(view.tui, measure, {
    version: "fixture", getModel: () => ({ id: "fixture" }), getThinkingLevel: () => "medium",
  });
  container.children[previous] = header;
  try {
    assert.equal(view.document.render, view.nativeDocumentRender);
    const lines = view.document.render(80).map(stripTerminalSequences);
    assert.ok(lines.some((line) => line.includes("Regular transcript")));
    assert.ok(lines.length < 24, "regular mode must not insert fullscreen spacer rows");
  } finally { header.dispose(); }
});

test("terminal chrome pins its title, clears Windows progress, and restores methods on disposal", () => {
  const titles = [], progress = [];
  const terminal = { setTitle(title) { titles.push(title); }, setProgress(active) { progress.push(active); } };
  const originalTitle = terminal.setTitle, originalProgress = terminal.setProgress;
  const restore = pinTerminalTitle(terminal, "win32");
  assert.deepEqual(progress, [false], "clear a progress keepalive that started before the extension mounted");
  terminal.setTitle("npm view @earendil-works/pi-coding-agent");
  terminal.setProgress(true); terminal.setProgress(false);
  assert.deepEqual(progress, [false], "never reactivate Windows taskbar progress");
  titles.push("shell changed the shared console title");
  restore.refresh();
  assert.equal(titles.at(-1), "Pi Coding Agent");
  restore(); restore();
  assert.equal(terminal.setTitle, originalTitle); assert.equal(terminal.setProgress, originalProgress);
  const count = titles.length; restore.refresh(); assert.equal(titles.length, count);
  terminal.setProgress(true); assert.deepEqual(progress, [false, true]);
});

test("terminal chrome preserves non-Windows progress and does not undo a newer terminal owner", () => {
  for (const platform of ["linux", "darwin"]) {
    const progress = [], terminal = { setTitle() {}, setProgress(value) { progress.push(value); } };
    const original = terminal.setProgress, restore = pinTerminalTitle(terminal, platform);
    assert.equal(terminal.setProgress, original);
    terminal.setProgress(true); assert.deepEqual(progress, [true]);
    const replacement = () => {};
    terminal.setTitle = replacement; restore(); assert.equal(terminal.setTitle, replacement);
  }
  const terminal = { setTitle() {}, setProgress() {} }, restore = pinTerminalTitle(terminal, "win32");
  const replacement = () => {}; terminal.setProgress = replacement;
  restore(); assert.equal(terminal.setProgress, replacement);
  pinTerminalTitle({ setTitle() {} }, "win32")();
});

test("short conversation sits directly above the editor with the logo at the top", () => {
  const view = scene(80, 24, ["User: hello", "Pi: hello"]);
  const lines = view.render();
  assert.equal(lines.length, 24);
  assert.equal(lines[1].slice(2, 10), "██████  ");
  assert.equal(lines[2].slice(2, 10), "██  ██  ");
  assert.equal(lines[3].slice(2, 10), "████  ██");
  assert.equal(lines[4].slice(2, 10), "██    ██");
  assert.ok(lines[1].indexOf("pi coding agent v0.85.1") > 10);
  assert.ok(lines[2].indexOf("GPT-6.1-Sol with medium effort") > 10);
  assert.equal(lines[3].indexOf(process.cwd()), lines[2].indexOf("GPT-6.1-Sol"));
  assert.equal(lines[17].trim(), "User: hello");
  assert.equal(lines[18].trim(), "Pi: hello");
  assert.equal(lines[21].trim(), ">");
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  assert.ok(lines.every((line) => !line.includes("$")));
});

test("narrow terminals and resize keep every line within the screen", () => {
  for (const [width, height] of [[24, 12], [40, 18], [120, 35], [16, 9]]) {
    const view = scene(width, height, ["hello"]);
    const lines = view.render();
    assert.equal(lines.length, height);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.some((line) => line.includes(">")));
  }
});

test("long transcripts show the newest messages and leave the editor visible", () => {
  const view = scene(80, 24, Array.from({ length: 70 }, (_, i) => `Message ${i}`));
  const lines = view.render();
  assert.ok(lines.some((line) => line.trim() === "Message 69"));
  assert.ok(lines.some((line) => line.trim() === ">"));
  assert.equal(lines.length, 24);
});

test("resizing the same viewport recalculates space above the conversation", () => {
  const view = scene(80, 24, ["hello"]);
  view.render();
  view.tui.terminal.rows = 36;
  const larger = view.render();
  assert.equal(larger.findIndex((line) => line.trim() === "hello"), 30);
  view.tui.terminal.rows = 16;
  const smaller = view.render();
  assert.equal(smaller.findIndex((line) => line.trim() === "hello"), 10);
});

test("footer shows auto mode at the left without the working folder or branch", () => {
  const view = scene(80, 24, []);
  assert.equal(stripTerminalSequences(view.footer.render(80)[0]), "  auto mode");
  assert.equal(view.render().at(-1).trim(), "auto mode");
  view.footer.dispose();
});

test("header reflects model, effort, and working directory changes", () => {
  const view = scene(80, 24, []);
  view.render();
  view.state.model = { id: "gpt-6-astra" };
  view.state.thinking = "high";
  view.state.cwd = "C:\\projects\\another-project";
  const lines = view.render();
  assert.ok(lines.some((line) => line.includes("GPT-6-Astra with high effort")));
  assert.ok(!lines.some((line) => line.includes("with medium effort")));
  assert.ok(lines.some((line) => line.includes(view.state.cwd)));
});

test("startup resource listing is hidden and restored when the header is disposed", () => {
  const view = scene(80, 24, ["User: hello"], ["[Skills]", "long list of skills", "[Extensions]"]);
  const lines = view.render();
  assert.ok(!lines.some((line) => line.includes("[Skills]")));
  assert.ok(lines.some((line) => line.includes("User: hello")));
  view.header.dispose();
  assert.equal(view.document.children[1], view.resourceList);
});

test("command overlays render their standalone header and close without a chat tree", async () => {
  const palette = createUiTheme();
  const header = createHeader({ mode: "regular" }, measure, {
    version: "test", getModel: () => ({ id: "gpt-6.1-sol" }), getThinkingLevel: () => "medium",
  });
  let closed = false;
  const panel = createCommandPanel({
    title: "Activity", tui: { terminal: { rows: 24 }, requestRender() {} }, theme: palette,
    measure: { ...await import(tuiEntry.href) }, done: () => { closed = true; },
    load: async () => "Activity loaded", renderBody: (value) => [value],
    renderHeader: (width) => header.render(width),
  });
  try {
    for (const width of [24, 80]) {
      assert.ok(panel.render(width).map(stripTerminalSequences).some((line) => line.includes("Loading…")));
    }
    await panel.ready;
    const lines = panel.render(80).map(stripTerminalSequences);
    assert.ok(lines.some((line) => line.includes("pi coding agent vtest")));
    assert.ok(lines.some((line) => line.includes("Activity loaded")));
    panel.handleInput("\x1b");
    assert.equal(closed, true);
  } finally {
    panel.dispose();
    header.dispose();
  }
});

test("user cards have uncolored gaps around compact tool groups without shifting tool hit targets", () => {
  initTheme("dark", false);
  const user = new UserMessageComponent("Inspect the project"), nextUser = new UserMessageComponent("Continue");
  const tool = (id) => {
    const component = new ToolExecutionComponent("read", id, { path: "src/main.ts" }, { showImages: false }, undefined, { requestRender() {} }, process.cwd());
    component.updateResult({ content: [{ type: "text", text: "Tool details" }], isError: false });
    return component;
  };
  const first = tool("gap-1"), second = tool("gap-2"), chat = new Container(), style = createChatStyle();
  for (const component of [user, first, second, nextUser]) chat.addChild(component);
  try {
    for (const width of [80, 24, 8, 1, 80, 80]) {
      style.apply(chat, width);
      const before = user.render(width), after = nextUser.render(width);
      assert.equal(stripTerminalSequences(before.at(-1)), "");
      assert.equal(stripTerminalSequences(after[0]), "");
      assert.ok(!before.at(-1).includes("\x1b[48;")); assert.ok(!after[0].includes("\x1b[48;"));
      assert.equal(user.children.length, 3); assert.equal(nextUser.children.length, 3);
      assert.equal(first.render(width).length, 1); assert.equal(second.render(width).length, 1);
      assert.ok(chat.render(width).every((line) => visibleWidth(line) <= width));
    }
    const lines = chat.render(80).map(stripTerminalSequences);
    const firstLine = lines.findIndex((line) => line.includes("▸ read"));
    assert.equal(lines[firstLine - 1], ""); assert.match(lines[firstLine + 1], /▸ read/);
    first.handleMouse({ type: "click", button: "left", x: 3, y: 0, width: 80, height: 1 });
    assert.ok(first.render(80).join("\n").includes("Tool details"));
    user.setOutputPad(0); style.apply(chat, 80); assert.equal(user.children.length, 3);
    chat.removeChild(first); chat.removeChild(second); style.apply(chat, 80);
    assert.ok(nextUser.render(80)[0].includes("\x1b[48;"), "remove the leading gap when the preceding activity disappears");
    chat.removeChild(nextUser); style.apply(chat, 80); assert.equal(nextUser.children.length, 1);
  } finally { style.dispose(); }
  assert.equal(user.children.length, 1); assert.equal(user.outputPad, 1);
});

test("shared transcript measurements preserve native mouse layout through tool expansion and resize", () => {
  initTheme("dark", false);
  const view = scene(80, 36, []), chat = new Container();
  const user = new UserMessageComponent("Inspect **Pi** — 日本語 👋");
  const assistant = new AssistantMessageComponent({ content: [{ type: "text", text: "Streaming response" }] });
  const tool = new ToolExecutionComponent("read", "mouse-frame", { path: "src/main.ts" }, { showImages: false }, undefined,
    { requestRender() {} }, process.cwd());
  tool.updateResult({ content: [{ type: "text", text: "Visible tool details" }], isError: false });
  chat.addChild(user); chat.addChild(assistant); chat.addChild(tool);
  view.document.children[view.document.children.length - 1] = chat;
  const clickTool = () => {
    const frame = view.frame(), row = frame.lines.map(stripTerminalSequences).findIndex((line) => /[▸▾] read/.test(line));
    assert.ok(row >= 0);
    const box = getLayoutBoxesAt(frame, 3, row).find((item) => item.component === view.document);
    assert.ok(box);
    const result = view.document.handleMouse({ type: "click", button: "left", x: 3 - box.rect.x, y: row - box.rect.y,
      width: box.rect.width, height: box.rect.height, screenX: 3, screenY: row, shift: false, alt: false, ctrl: false });
    assert.equal(result?.handled, true);
  };
  try {
    for (const width of [80, 24, 80]) {
      view.tui.terminal.columns = width;
      clickTool(); assert.equal(tool.expanded, true);
      assert.ok(view.render().some((line) => line.includes("Visible tool details")));
      clickTool(); assert.equal(tool.expanded, false);
      assert.ok(!view.render().some((line) => line.includes("Visible tool details")));
      assistant.updateContent({ content: [{ type: "text", text: `New response at ${width}` }] }, true);
      assert.ok(view.render().some((line) => line.includes(`New response at ${width}`)));
      assert.ok(view.frame().lines.every((line) => visibleWidth(line) <= width));
      assert.ok(user.render(width)[0].startsWith("\x1b]133;A\x07"));
      assert.ok(user.render(width).at(-1).includes("\x1b]133;C\x07"));
    }
  } finally { view.header.dispose(); }
});

test("native messages keep Markdown, streaming, and terminal zones with aligned gray user messages", () => {
  initTheme("dark", false);
  const user = new UserMessageComponent("Hello **Pi**\n\n```js\nconst x = 1;\n```\n\nПривет");
  const assistant = new AssistantMessageComponent({ content: [{ type: "text", text: "Working…" }] });
  const chat = new Container();
  chat.addChild(user);
  chat.addChild(assistant);
  const style = createChatStyle();
  for (const width of [80, 24, 8, 80]) {
    style.apply(chat, width);
    const userLines = user.render(width);
    assert.ok(userLines.some((line) => line.includes("\x1b[48;2;32;32;32m")));
    assert.ok(userLines.some((line) => line.includes("\x1b[38;2;237;237;237m")));
    assert.ok(userLines[0].startsWith("\x1b]133;A\x07"));
    assert.ok(userLines.at(-1).includes("\x1b]133;C\x07"));
    assert.ok(userLines.every((line) => visibleWidth(line) <= width));
    assert.ok(assistant.render(width).every((line) => visibleWidth(line) <= width));
    if (width >= 24) {
      assert.ok(userLines.map(stripTerminalSequences).some((line) => line.startsWith("  Hello Pi")));
      assert.ok(userLines.map(stripTerminalSequences).some((line) => line.includes("const x = 1;")));
    }
  }
  assistant.updateContent({ content: [{ type: "text", text: "Finished response" }] }, true);
  assert.ok(assistant.render(80).map(stripTerminalSequences).some((line) => line.startsWith("  Finished response")));
  assert.ok(!assistant.render(80).some((line) => line.includes("\x1b[48;2;32;32;32m")));
  user.setOutputPad(1); // Native theme/settings changes rebuild message children.
  style.apply(chat, 80);
  assert.ok(user.render(80).some((line) => line.includes("\x1b[48;2;32;32;32m")));
  style.dispose();
  assert.equal(user.outputPad, 1);
  assert.equal(assistant.outputPad, 1);
  assert.ok(!user.render(80).some((line) => line.includes("\x1b[48;2;32;32;32m")));
});
