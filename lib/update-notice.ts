import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { compareVersions, runtimeDirectory, validVersion } from "../bin/runtime.js";
import { AGENT_PACKAGE, AGENT_VERSION } from "./package.js";

export const UPDATE_CHECK_INTERVAL = 12 * 60 * 60 * 1000;
export interface ReleaseUpdate {
  kind: "agent" | "engine";
  version: string;
  current: string;
  command: string;
  message: string;
}
interface CheckOptions {
  directory?: string;
  now?: number;
  offline?: boolean;
  signal?: AbortSignal;
  latest?: (signal?: AbortSignal) => Promise<string>;
}

/** Best-effort notification only. Never install or activate an engine on startup. */
export async function checkForEngineUpdate(current: string, options: CheckOptions = {}): Promise<string | undefined> {
  return (await checkForUpdate(current, options, false))?.message;
}

export async function checkForAgentUpdate(current = AGENT_VERSION, options: CheckOptions = {}): Promise<string | undefined> {
  return (await checkForUpdate(current, options, true))?.message;
}

export async function checkForReleaseUpdates(engine: string, options: CheckOptions = {}): Promise<ReleaseUpdate[]> {
  const updates = await Promise.all([checkForUpdate(AGENT_VERSION, options, true), checkForUpdate(engine, options, false)]);
  return updates.filter((update): update is ReleaseUpdate => update !== undefined);
}

export async function checkForUpdates(engine: string, options: CheckOptions = {}): Promise<string | undefined> {
  const notices = await Promise.all([checkForAgentUpdate(AGENT_VERSION, options), checkForEngineUpdate(engine, options)]);
  return notices.filter(Boolean).join("\n") || undefined;
}

async function checkForUpdate(current: string, options: CheckOptions, agent: boolean): Promise<ReleaseUpdate | undefined> {
  if ((options.offline ?? process.env.PI_OFFLINE !== undefined) || !validVersion(current)) return;
  const { signal } = options;
  const directory = options.directory ?? runtimeDirectory();
  const now = options.now ?? Date.now();
  const cacheName = agent ? "agent-update-check" : "update-check";
  const file = join(directory, `${cacheName}.json`);
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
      version = await (options.latest ?? (async (signal) => {
        const { latestPackageVersion, latestVersion } = await import("../bin/update.js");
        signal?.throwIfAborted();
        return agent ? latestPackageVersion(AGENT_PACKAGE, undefined, { signal, background: true })
          : latestVersion(undefined, { signal, background: true });
      }))(signal);
      signal?.throwIfAborted();
      if (!validVersion(version)) return;
      const temporary = join(directory, `${cacheName}.${process.pid}.${randomUUID()}.tmp`);
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, JSON.stringify({ checkedAt: now, version }), "utf8");
        await rename(temporary, file);
      } catch { /* Read-only cache storage must not suppress a successful check. */ }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    }
    signal?.throwIfAborted();
    if (compareVersions(version, current) > 0) {
      const command = agent ? "pi update" : "pi update --engine";
      return { kind: agent ? "agent" : "engine", version, current, command,
        message: `${agent ? "Pi Extended Agent" : "Pi"} ${version} is available (current: ${current}). Run ${command} in your terminal to update.` };
    }
  } catch { /* Network failures and cancellation must never interrupt the session. */ }
}
