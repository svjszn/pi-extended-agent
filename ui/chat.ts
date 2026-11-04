import { Spacer } from "@earendil-works/pi-tui";
import { createUiTheme } from "./theme.js";
import type { TreeComponent } from "./types.js";
import { isActivity, isResearchActivity, isToolOnlyMessage, styleToolCall } from "../bin/tool-interface.js";
import type { Activity, ToolGroup, ToolPresentation } from "../bin/tool-interface.js";
import { getAppearance, toolOutputMode } from "../lib/appearance.js";
import type { Appearance, ToolOutputMode } from "../lib/appearance.js";

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
export function createChatStyle(repaint: () => void = () => {}, getToolsExpanded?: () => boolean) {
  const palette = createUiTheme();
  const messages = new Map<NativeMessage, number>();
  const styled = new WeakMap<UserContent, Readonly<Appearance>>();
  const activities = new Map<Activity, { restore(): void; presentation: ToolPresentation; mode: ToolOutputMode }>();
  const researchGroups = new WeakMap<Activity, ToolGroup>();
  let previousExpansion: boolean | undefined;
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
      const expanded = getToolsExpanded?.();
      const collapsedAll = previousExpansion === true && expanded === false;
      previousExpansion = expanded;
      // Removed messages must not keep entire previous sessions in memory.
      const current = new Set(container.children);
      for (const [component, style] of activities) {
        if (!current.has(component)) { style.restore(); activities.delete(component); }
      }
      for (const message of messages.keys()) {
        if (!current.has(message)) { removeGaps(message); messages.delete(message); }
      }
      for (const [index, message] of container.children.entries()) {
        if (isActivity(message)) {
          const mode = toolOutputMode();
          let style = activities.get(message);
          if (!style) {
            const presentation: ToolPresentation = {};
            style = { restore: styleToolCall(message, repaint, presentation), presentation, mode };
            activities.set(message, style);
            if (expanded ?? mode === "full") message.setExpanded(true);
          } else if (style.mode !== mode) {
            message.setExpanded(expanded ?? mode === "full"); style.mode = mode;
            const group = researchGroups.get(message); if (group) group.open = false;
          }
          style.presentation.group = undefined;
          style.presentation.gap = false;
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
      if (expanded === undefined ? toolOutputMode() === "compact" : !expanded) {
        let members: Activity[] = [];
        const flush = () => {
          if (members.length > 1) {
            let group = researchGroups.get(members[0]);
            if (!group) { group = { members, open: false, expanded: false }; researchGroups.set(members[0], group); }
            if (collapsedAll) group.open = false;
            group.members = members;
            group.expanded = group.open || members.some(member => member.expanded);
            for (const member of members) activities.get(member)!.presentation.group = group;
          }
          members = [];
        };
        for (const component of container.children) {
          if (isResearchActivity(component)) members.push(component);
          // A native assistant message containing only tool calls renders no text.
          // Bridge it without removing or reordering any transcript components.
          else if (isToolOnlyMessage(component)) continue;
          else flush();
        }
        flush();
      }
      let previous: Activity | undefined;
      for (const component of container.children) {
        if (isActivity(component)) {
          const presentation = activities.get(component)!.presentation;
          const sameGroup = presentation.group && presentation.group === (previous && activities.get(previous)?.presentation.group);
          presentation.gap = Boolean(previous && !sameGroup);
          previous = component;
        } else if (!isToolOnlyMessage(component)) previous = undefined;
      }
    },
    dispose() {
      for (const [message, padding] of messages) { removeGaps(message); message.setOutputPad(padding); }
      messages.clear();
      for (const style of activities.values()) style.restore();
      activities.clear();
    },
  };
}
