import { Spacer } from "@earendil-works/pi-tui";
import { createUiTheme } from "./theme.js";
import type { TreeComponent } from "./types.js";
import { isActivity, styleToolCall } from "../bin/tool-interface.js";
import { getAppearance } from "../lib/appearance.js";
import type { Appearance } from "../lib/appearance.js";

interface UserContent extends TreeComponent {
  defaultTextStyle?: { color?: (text: string) => string; bgColor?: (text: string) => string };
  defaultStylePrefix?: string;
  setBgFn?(callback: (text: string) => string): void;
}
interface NativeMessage extends TreeComponent {
  outputPad: number;
  children: UserContent[];
  setOutputPad(padding: number): void;
}
function isNativeMessage(component: TreeComponent): component is NativeMessage {
  return ["UserMessageComponent", "AssistantMessageComponent"].includes(component.constructor.name)
    && "setOutputPad" in component && typeof component.setOutputPad === "function"
    && "outputPad" in component && typeof component.outputPad === "number" && Array.isArray(component.children);
}

// Keep Pi's Markdown, streaming, thinking controls, and terminal message zones.
// Only style its native message components; runtime checks cover both the Box
// used in 0.85 and the directly padded Markdown used in 1.4.
export function createChatStyle(repaint: () => void = () => {}) {
  const palette = createUiTheme();
  const messages = new Map<NativeMessage, number>();
  const styled = new WeakMap<UserContent, Readonly<Appearance>>();
  const activities = new Map<TreeComponent, () => void>();
  const gaps = new Map<NativeMessage, { before: Spacer; after: Spacer }>();
  function removeGaps(message: NativeMessage) {
    const gap = gaps.get(message);
    if (!gap) return;
    for (const spacer of [gap.before, gap.after]) {
      const index = message.children.indexOf(spacer);
      if (index !== -1) message.children.splice(index, 1);
    }
    gaps.delete(message);
  }
  function styleUserContent(component: UserContent) {
    const appearance = getAppearance();
    if (styled.get(component) === appearance) return;
    if (typeof component.setBgFn === "function") {
      component.setBgFn((text) => palette.bg("userMessage", text));
    }
    if (component.defaultTextStyle) {
      component.defaultTextStyle = {
        ...component.defaultTextStyle,
        color: (text) => palette.fg("text", text),
        ...(component.defaultTextStyle.bgColor ? { bgColor: (text) => palette.bg("userMessage", text) } : {}),
      };
      component.defaultStylePrefix = undefined;
      component.invalidate();
    }
    for (const child of component.children || []) styleUserContent(child);
    styled.set(component, appearance);
  }
  return {
    apply(container: { children: TreeComponent[] }, width: number) {
      const padding = Math.min(2, Math.max(0, Math.floor((width - 1) / 2)));
      // Removed messages must not keep entire previous sessions in memory.
      const current = new Set(container.children);
      for (const [component, restore] of activities) {
        if (!current.has(component)) { restore(); activities.delete(component); }
      }
      for (const message of messages.keys()) {
        if (!current.has(message)) { removeGaps(message); messages.delete(message); }
      }
      for (const [index, message] of container.children.entries()) {
        if (isActivity(message)) {
          if (!activities.has(message)) activities.set(message, styleToolCall(message, repaint));
          continue;
        }
        const name = message.constructor?.name;
        if (!isNativeMessage(message)) continue;
        if (!messages.has(message)) messages.set(message, message.outputPad);
        if (message.outputPad !== padding) message.setOutputPad(padding);
        if (name === "UserMessageComponent") {
          let gap = gaps.get(message);
          if (!gap) { gap = { before: new Spacer(0), after: new Spacer(1) }; gaps.set(message, gap); }
          gap.before.setLines(index > 0 && isActivity(container.children[index - 1]) ? 1 : 0);
          // Native Markdown owns the card's colored padding. Keep the separating
          // row outside it, using real children so mouse layout and zones agree.
          if (!message.children.includes(gap.before)) message.children.unshift(gap.before);
          if (!message.children.includes(gap.after)) message.children.push(gap.after);
          for (const child of message.children) styleUserContent(child);
        }
      }
    },
    dispose() {
      for (const [message, padding] of messages) { removeGaps(message); message.setOutputPad(padding); }
      messages.clear();
      for (const restore of activities.values()) restore();
      activities.clear();
    },
  };
}
