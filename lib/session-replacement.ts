/**
 * `/clear`, `/new`, `/resume`, `/fork` and a reload replace the session behind
 * the same terminal. Pi tears the old session down, loads the next runtime, and
 * only then binds extensions again, so anything this interface mounted stays on
 * screen across the gap while the context that created it goes stale.
 */
const REPLACED_SESSION = new Set(["reload", "new", "resume", "fork"]);

/** True while one terminal continues with a replacement session. */
export function isSessionReplaced(event: unknown): boolean {
  return REPLACED_SESSION.has((event as { reason?: string } | undefined)?.reason ?? "");
}

/**
 * Read through a session context that a replacement can invalidate. Pi's
 * context getters throw once their session is gone, so a component kept on
 * screen keeps reporting what that session last said until the next one binds.
 */
export function lastKnown<T>(read: () => T, initial: T): () => T {
  let value = initial;
  return () => {
    try { return (value = read()); } catch { return value; }
  };
}
