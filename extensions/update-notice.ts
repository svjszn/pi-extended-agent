import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkForEngineUpdate } from "../lib/update-notice.js";

export default function updateNotice(pi: ExtensionAPI, check = checkForEngineUpdate) {
  let started = false;
  const controller = new AbortController();
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || started || controller.signal.aborted) return;
    started = true;
    // Do not return the promise: the editor must be usable while npm is checking.
    void check(VERSION, { signal: controller.signal }).then((notice) => {
      if (notice && !controller.signal.aborted) ctx.ui.notify(notice, "info");
    }).catch(() => {});
  });
  pi.on("session_shutdown", () => controller.abort());
}
