import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { latestVersion } from "../bin/update.js";
import { compareVersions, runtimeDirectory, validVersion } from "../bin/runtime.js";

export const UPDATE_CHECK_INTERVAL = 12 * 60 * 60 * 1000;
interface CheckOptions {
  directory?: string;
  now?: number;
  offline?: boolean;
  signal?: AbortSignal;
  latest?: (signal?: AbortSignal) => Promise<string>;
}

/** Best-effort notification only. Never install or activate an engine on startup. */
export async function checkForEngineUpdate(current: string, options: CheckOptions = {}): Promise<string | undefined> {
  if ((options.offline ?? process.env.PI_OFFLINE !== undefined) || !validVersion(current)) return;
  const { signal } = options;
  const directory = options.directory ?? runtimeDirectory();
  const now = options.now ?? Date.now();
  const file = join(directory, "update-check.json");
  try {
    signal?.throwIfAborted();
    let version: string | undefined;
    try {
      const cache = JSON.parse(await readFile(file, "utf8"));
      if (validVersion(cache.version) && Number.isFinite(cache.checkedAt)
        && cache.checkedAt <= now && now - cache.checkedAt < UPDATE_CHECK_INTERVAL) version = cache.version;
    } catch { /* A missing or invalid cache needs a fresh check. */ }
    if (!version) {
      signal?.throwIfAborted();
      version = await (options.latest ?? ((signal) => latestVersion(undefined, { signal, background: true })))(signal);
      signal?.throwIfAborted();
      if (!validVersion(version)) return;
      const temporary = join(directory, `update-check.${process.pid}.${randomUUID()}.tmp`);
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, JSON.stringify({ checkedAt: now, version }), "utf8");
        await rename(temporary, file);
      } catch { /* Read-only cache storage must not suppress a successful check. */ }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    }
    signal?.throwIfAborted();
    if (compareVersions(version, current) > 0) {
      return `Pi ${version} is available (current: ${current}). Run pi update in your terminal to update.`;
    }
  } catch { /* Network failures and cancellation must never interrupt the session. */ }
}
