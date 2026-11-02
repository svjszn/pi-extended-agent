// One approval dialog at a time across the session: parent tool calls and
// subagent tool calls share this queue, so two overlays never compete for the
// terminal. Shared through globalThis because the native host and the
// jiti-loaded extensions hold separate module instances.
const key = Symbol.for("pi-extended-agent.approval-queue");
interface QueueState { tail: Promise<void> }
const globals = globalThis as typeof globalThis & { [key]?: QueueState };
const state = globals[key] ??= { tail: Promise.resolve() };

/**
 * Run one approval at a time. A rejected or hanging request never blocks the
 * queue for the next caller, and a failure resolves to `fallback` rather than
 * propagating: a permission error must not read as a grant.
 */
export function serializeApproval<T>(request: () => Promise<T>, fallback: T): Promise<T> {
  const result = state.tail.then(request, request).catch(() => fallback);
  state.tail = result.then(() => {}, () => {});
  return result;
}
