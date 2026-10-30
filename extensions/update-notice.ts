import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkForReleaseUpdates } from "../lib/update-notice.js";
import { setAvailableUpdates, setUpdateNoticeVisible, visibleUpdateLabel } from "../lib/update-status.js";

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
        timer = setTimeout(() => rotate(!showUpdate), showUpdate ? 4000 : 8000);
        timer.unref?.();
      };
      rotate(false);
    }).catch(() => {});
  });
  pi.on("session_shutdown", () => {
    controller.abort();
    clearTimeout(timer);
    setAvailableUpdates([]);
  });
}
