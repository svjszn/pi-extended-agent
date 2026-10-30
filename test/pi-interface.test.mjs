import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createFooter, createHeader } from "../dist/ui/chrome.js";
import { createChatStyle } from "../dist/ui/chat.js";
import { createCommandPanel } from "../dist/ui/command-panel.js";
import { createUiTheme } from "../dist/ui/theme.js";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const require = createRequire(piEntry);
const tuiEntry = pathToFileURL(require.resolve("@earendil-works/pi-tui"));
const { Container, Spacer, truncateToWidth, visibleWidth, stripTerminalSequences } = await import(tuiEntry.href);
const { renderLayoutFrame } = await import(new URL("./layout.js", tuiEntry).href);
const { createChatViewport } = await import(new URL("./modes/interactive/chat-viewport.js", piEntry).href);
const { UserMessageComponent } = await import(new URL("./modes/interactive/components/user-message.js", piEntry).href);
const { AssistantMessageComponent } = await import(new URL("./modes/interactive/components/assistant-message.js", piEntry).href);
const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", piEntry).href);
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
  const editor = content(["─".repeat(width), "> ", "─".repeat(width)]);
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
  const header = createHeader(tui, theme, measure, {
    version: "0.85.1", getModel: () => state.model, getThinkingLevel: () => state.thinking, getCwd: () => state.cwd,
  });
  headerContainer.addChild(new Spacer(1));
  headerContainer.addChild(header);
  headerContainer.addChild(new Spacer(1));
  const viewport = createChatViewport({ document, pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer, scrollbar: "hidden" });
  return {
    tui, header, footer, document, resourceList, state,
    render: () => renderLayoutFrame(viewport.root, tui.terminal.columns, tui.terminal.rows, () => {}).lines.map(stripTerminalSequences),
  };
}

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
  const header = createHeader({ mode: "regular" }, palette, measure, {
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
