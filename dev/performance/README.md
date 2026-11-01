# Development-only performance diagnostics

This experimental extension is not part of the production build, npm package,
or public documentation. It is disabled during normal agent use. From a source
checkout, explicitly opt in:

```sh
npm run build
npm run build:dev
node bin/pi.mjs --extension ./.local/dev-dist/dev/performance/extension.js
```

`npm test` builds and tests the diagnostics separately. Do not treat these
experimental metrics as authoritative: opening the viewer during a run can
contaminate dialog timing, nested tool usage is incomplete, and pre-run
compaction is not captured. These limitations are not addressed by moving the
extension out of production.

Use `/perf` to inspect the current run or the most recent completed one:

```text
/perf
/perf history
/perf json
```

The report uses Pi's existing events. It makes no model requests, changes no
provider payloads, and adds no messages or tools to the model's context.
While the screen is open during a run, it refreshes once per second.

## What is measured

A run starts at `before_agent_start` and ends at `agent_settled`, after automatic
continuations and recovery. Time between separate user requests is excluded.
An interrupted shutdown is saved as interrupted rather than completed.

The report includes:

- Elapsed wall time, observed provider requests, request duration samples, and agent turns.
- Exclusive time in provider requests, tools, compaction, user dialogs, and other orchestration.
- Time to the first normalized text, thinking, or tool-call delta.
- Time to the first successful built-in `write` or `edit`, including nested calls.
- Tool calls, nested calls, failures, repeated reads of the same path, and identical shell commands.
- Reported input, output, cache-read, and cache-write tokens.
- Compaction attempts/failures, HTTP error responses, and failed assistant responses.

New runs also include a per-request timeline: total duration, time until the first
output event, time until the first text delta, output tokens, tool-call count,
HTTP status when observed, and stop reason. The two first-output values are
offsets from that individual request's start. A thinking or tool-call delta can
arrive before text, so neither value is a measurement of internal reasoning time.
Single-call and multi-call tool batches help identify long chains of small steps;
dependencies still determine which operations can safely run together.

Up to 256 request samples are retained per run. Older reports remain readable,
but show that detailed timing was not collected rather than inventing it.

Parallel and nested intervals are not summed twice. Where intervals overlap,
user dialogs take precedence, followed by compaction, tools, and provider time.
For example, a provider request inside a tool belongs to tool wall time.

Provider time includes network and generation. These events cannot separate
internal reasoning from network latency. Client-internal retries may not emit
request events. Shell/MCP file changes are not inferred, and repeated operations
can be necessary. A green test result or completed feature is not inferred from
an arbitrary successful shell command.

The model and effort shown are the initial configuration. Configuration changes
during a run are counted; use an unchanged configuration for comparable trials.
Incomplete measurements are marked, including overlapping provider calls that
cannot be paired without request IDs or collection limits reached on large runs.

## Use your own tasks as a benchmark

Choose a real frontend/backend task and write down the approved plan, scope,
required checks, and definition of done before timing it. Start each trial from
the same repository state with the same dependencies, data, and permissions.

First compare the current behavior with the updated approved-plan instructions
using the same model and effort. Then compare entire runs at different effort
levels separately. Repeat trials so a network fluctuation does not decide the
result. Require the same independent acceptance checks in every trial.

For each Pi run record `/perf json`, the acceptance-check results, and any
manual intervention. Measure elapsed time for Claude Code or Codex CLI separately:
`/perf` does not observe those external applications. Comparing different models
measures the complete systems, while the same model/effort helps isolate the harness.

Read the result before changing defaults. Many requests and repeated operations
suggest a different investigation from slow individual provider calls or long
test commands. A lower token count alone does not establish a faster result.

## Storage and privacy

The last 30 completed, failed, aborted, or interrupted runs are saved per session
under the profile's `pi-extended/projects/PROJECT_KEY/performance/` directory.
Resume the same session to inspect its history; older sessions have no measurements
until they run with this development extension explicitly enabled.

Only bounded timings, counters, model/effort identifiers, and tool names are saved.
Prompts, file paths, shell command text, request payloads, and tool output are not
stored. Repeated-operation detection uses in-memory hashes that are discarded
at the end of each run. Measurements stay out of the conversation context.
