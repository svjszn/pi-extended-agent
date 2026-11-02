import { createCommandPanel } from "./command-panel.js";
import type { PanelOptions } from "./command-panel.js";
import { PERMISSION_MODES, PERMISSION_LABELS, PERMISSION_DESCRIPTIONS } from "../lib/permissions.js";
import type { PermissionMode } from "../lib/permissions.js";
import type { KeyId } from "@earendil-works/pi-tui";

type ScreenOptions = Pick<PanelOptions<boolean>, "tui" | "theme" | "measure" | "done" | "renderHeader" | "renderFooter" | "onDispose">;
export function createPermissionsScreen({ current, onSelect, ...options }: ScreenOptions & {
  current: PermissionMode; onSelect(mode: PermissionMode): void;
}) {
  let selected = PERMISSION_MODES.indexOf(current);
  const { theme, measure, tui } = options;
  return createCommandPanel({ ...options, title: "Permissions", load: () => true,
    renderBody: () => [theme.fg("muted", "Choose what the agent can do in this session."), "",
      ...PERMISSION_MODES.map((mode, index) => {
        const text = `${mode === current ? "●" : "○"} ${PERMISSION_LABELS[mode]}${mode === current ? " current" : ""}`;
        return index === selected ? theme.fg("primary", theme.bold(text)) : theme.fg("muted", text);
      }), "", theme.fg("dim", PERMISSION_DESCRIPTIONS[PERMISSION_MODES[selected]]), "",
      theme.fg("dim", "The choice is saved with this session. It controls agent tool calls, not OS access."),
    ],
    renderInput: (_width, focused) => (focused ? measure.CURSOR_MARKER || "" : "")
      + theme.fg("muted", "↑↓ choose · enter apply · esc cancel"),
    onInput(data, controls) {
      const key = (name: KeyId) => measure.matchesKey(data, name);
      if (key("escape") || key("ctrl+c")) { controls.close(false); return true; }
      if (key("enter")) { onSelect(PERMISSION_MODES[selected]); controls.close(true); return true; }
      if (key("up") || key("shift+tab")) selected = Math.max(0, selected - 1);
      else if (key("down") || key("tab")) selected = Math.min(PERMISSION_MODES.length - 1, selected + 1);
      else if (key("home")) selected = 0;
      else if (key("end")) selected = PERMISSION_MODES.length - 1;
      else return false;
      controls.reveal(2 + selected); tui.requestRender(); return true;
    },
  });
}

export type ApprovalChoice = "deny" | "once" | "run";
/**
 * Denial stays the default and Escape always denies. The run-wide choice appears
 * only when a caller offers it, and it is never preselected: a grant that covers
 * more than one call must be picked deliberately.
 */
export function createPermissionApprovalScreen({ lines, runLabel, onChoice, ...options }: ScreenOptions & {
  lines: string[]; runLabel?: string; onChoice?(choice: ApprovalChoice): void;
}) {
  const choices: ApprovalChoice[] = runLabel ? ["deny", "once", "run"] : ["deny", "once"];
  const labels: Record<ApprovalChoice, string> = { deny: "Deny", once: "Allow once", run: runLabel ?? "Allow for this run" };
  let selected = 0;
  const { theme, measure, tui } = options;
  const close = (controls: { close(result?: boolean): void }, choice: ApprovalChoice) => {
    onChoice?.(choice);
    controls.close(choice !== "deny");
  };
  return createCommandPanel({ ...options, title: "Permission request", load: () => true,
    renderBody: () => lines.map((line) => theme.fg("text", line)),
    renderInput: () => theme.fg("muted", `${choices.map((choice, index) =>
      `${index === selected ? "●" : "○"} ${labels[choice]}`).join("   ")} · ←→ choose · enter apply · esc deny`),
    onInput(data, controls) {
      const key = (name: KeyId) => measure.matchesKey(data, name);
      if (key("escape") || key("ctrl+c")) { close(controls, "deny"); return true; }
      if (key("enter")) { close(controls, choices[selected]); return true; }
      if (key("left") || key("shift+tab")) selected = Math.max(0, selected - 1);
      else if (key("right") || key("tab")) selected = Math.min(choices.length - 1, selected + 1);
      else return false;
      tui.requestRender(); return true;
    },
  });
}
