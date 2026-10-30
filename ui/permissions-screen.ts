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

export function createPermissionApprovalScreen({ lines, ...options }: ScreenOptions & { lines: string[] }) {
  let allow = false;
  const { theme, measure, tui } = options;
  return createCommandPanel({ ...options, title: "Permission request", load: () => true,
    renderBody: () => lines.map((line) => theme.fg("text", line)),
    renderInput: () => theme.fg("muted", `${allow ? "○ Deny   ● Allow once" : "● Deny   ○ Allow once"} · ←→ choose · enter apply · esc deny`),
    onInput(data, controls) {
      const key = (name: KeyId) => measure.matchesKey(data, name);
      if (key("escape") || key("ctrl+c")) { controls.close(false); return true; }
      if (key("enter")) { controls.close(allow); return true; }
      if (key("left") || key("right") || key("tab") || key("shift+tab")) { allow = !allow; tui.requestRender(); return true; }
      return false;
    },
  });
}
