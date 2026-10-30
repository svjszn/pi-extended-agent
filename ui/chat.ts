import { createUiTheme } from "./theme.js";
import type { TreeComponent } from "./types.js";

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
export function createChatStyle() {
  const palette = createUiTheme();
  const messages = new Map<NativeMessage, number>();
  const styled = new WeakSet<UserContent>();
  function styleUserContent(component: UserContent) {
    if (styled.has(component)) return;
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
    styled.add(component);
  }
  return {
    apply(container: { children: TreeComponent[] }, width: number) {
      const padding = Math.min(2, Math.max(0, Math.floor((width - 1) / 2)));
      // Removed messages must not keep entire previous sessions in memory.
      const current = new Set(container.children);
      for (const message of messages.keys()) {
        if (!current.has(message)) messages.delete(message);
      }
      for (const message of container.children) {
        const name = message.constructor?.name;
        if (!isNativeMessage(message)) continue;
        if (!messages.has(message)) messages.set(message, message.outputPad);
        if (message.outputPad !== padding) message.setOutputPad(padding);
        if (name === "UserMessageComponent") {
          for (const child of message.children) styleUserContent(child);
        }
      }
    },
    dispose() {
      for (const [message, padding] of messages) message.setOutputPad(padding);
      messages.clear();
    },
  };
}
