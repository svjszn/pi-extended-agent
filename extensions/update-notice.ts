import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkForReleaseUpdates } from "../lib/update-notice.js";
import { setAvailableUpdates, setUpdateNoticeVisible, visibleUpdateLabel } from "../lib/update-status.js";

const UPDATE_DISPLAY_MS = 12_000;
const EFFORT_DISPLAY_MS = 24_000;

export default function updateNotice(pi: ExtensionAPI, check = checkForReleaseUpdates) {
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || started || controller.signal.aborted) return;
    started = true;
    setAvailableUpdates([]);
    ctx.ui.setStatus("pi-update", undefined);
    // Do not return the promise: the editor must be usable while npm is checking.
    void check(VERSION, { signal: controller.signal }).then((updates) => {
      if (controller.signal.aborted) return;
      setAvailableUpdates(updates);
      if (!updates.length) return;
      // Repaint the idle editor only when this shared slot changes, not per frame.
      const rotate = (showUpdate: boolean) => {
        if (controller.signal.aborted) return;
        setUpdateNoticeVisible(showUpdate);
        ctx.ui.setStatus("pi-update", visibleUpdateLabel());
        timer = setTimeout(() => rotate(!showUpdate), showUpdate ? UPDATE_DISPLAY_MS : EFFORT_DISPLAY_MS);
        timer.unref?.();
      };
      rotate(true);
    }).catch(() => {});
  });
  pi.on("session_shutdown", () => {
    controller.abort();
    clearTimeout(timer);
    setAvailableUpdates([]);
  });
}
