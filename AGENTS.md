# Working on Pi Extended Agent

Pi Extended Agent is an npm CLI that wraps Pi Coding Agent with a custom terminal
interface and a separately managed engine. Keep changes focused on the user's
request; avoid adding features, dependencies, or refactors to unrelated areas.

## Repository map

- `bin/pi.mjs` is the stable npm executable; `bin/*.ts` implements the launcher,
  runtime selection, updates, and adapters to Pi's native interface.
- `extensions/` registers slash commands, hooks, and tools through Pi's extension API.
- `lib/` contains storage, provider readers, and other non-UI logic.
- `ui/` contains terminal components and the existing Pi SVG marks.
- `test/` tests the compiled JavaScript, including real Pi SDK integration.
- `dev/` contains opt-in diagnostics, built into `.local/dev-dist/`, never shipped.
- `docs/` is an independent Nextra site. Its dependencies must stay out of the CLI.
- `scripts/release-check.mjs` validates the installed npm artifact in an isolated prefix.

## Development

Use Node.js 22.19.0 or newer. Install with `npm ci`; if lifecycle scripts are
disabled, run `npm run build` afterward. Edit TypeScript sources, never `dist/`
or `node_modules/`. Build before restarting a linked `pi`.

- `npm run check` checks strict TypeScript types.
- `npm run build` clears `dist/`, compiles production code, and checks its extension allowlist.
- `npm run build:dev` separately builds development diagnostics into `.local/dev-dist/`.
- `npm test` builds both targets and runs the complete suite.
- For a focused check after building:
  `node scripts/run-tests.mjs test/workspace.test.mjs`.
- `npm run release:check` checks types, tests, packing, isolated installation,
  commands, permissions, memory, planning, compaction, and session resume.
- For documentation, run `npm ci` and `npm run build` from `docs/`.

Run checks relevant to the change. Add regression coverage for data loss,
permissions, lifecycle behavior, and compatibility bugs. Report environment
restrictions separately from product failures. Do not call a model or use the
real user profile for routine tests; use isolated fixtures instead.

## Product and compatibility rules

- Preserve Pi's authentication, model discovery, session handling, compaction,
  and agent loop. Prefer supported extension APIs to private adapters.
- Keep necessary private adapters isolated in `bin/` and extend the runtime
  compatibility probe when their dependencies change. Never activate an engine
  whose compatibility check failed.
- Keep the interface aligned to the existing Pi logo inset, with the shared
  dark/light palette, borderless command screens, and working narrow-terminal
  layouts. Input rules span the terminal; keep the content inset and chevron.
  The selected accent colors input borders, the Pi mark, activity charts, and
  subtle user message backgrounds. Keep text and effort/mode colors independent.
  Reuse shared components before adding a new screen structure.
- Show only reasoning levels supported by the active model; never hardcode a
  model ID as the user's startup choice.
- Preserve the distinction between permissions, project trust, and planning.
  Plan execution needs explicit user approval; nested tool calls must pass the
  same permission checks. Permission errors must not silently allow a tool.
- Store notebook, prompt, and plan state under the active profile, outside the
  working tree. Use atomic writes, bounded input, and validated paths. Reserve
  `memory` as a topic ID because it conflicts with `MEMORY.md` on Windows.
- Never expose credentials in logs, UI, fixtures, documentation, or commits.
  Do not read `auth.json` to diagnose unrelated problems.

## Documentation and releases

Write user-facing documentation in English. Keep examples aligned with the
implemented commands and distinguish agent updates (`pi update`) from engine
updates (`pi update --engine`). Do not claim verification on
an operating system, provider, or deployment that was not actually checked.

The docs site is a static export published to GitHub Pages by
`.github/workflows/docs.yml`. Check the repository base path, internal links,
assets, and search index when changing its configuration.

Before npm publication, run `npm run release:check` and inspect the archive.
Publish the validated `.tgz` artifact. Do not include `docs/`, `dev/`, diagnostics,
fixtures, profiles, credentials, or build caches. Keep `pi.extensions` as explicit
production files, not a directory or glob. Removed commands must be absent from
both SDK and production CLI-bundle registration checks. Publishing, tagging, and pushing require a user
request that authorizes those actions; do not infer a release from routine edits.

## Git and versioning

Inspect `git status --short --branch` and recent commits before starting. Keep
one logical change per commit and use Conventional Commit subjects in English,
for example `fix(updates): preserve linked source checkouts` or
`test(security): cover runtime path escapes`. Explain the problem and checks in
the body when they are needed for review. Do not rewrite existing history,
discard someone else's edits, or commit credentials, generated files, or caches.

Run the relevant checks before committing. Create commits only when the user
explicitly requests them; discussing commit conventions or a clean working tree
does not authorize automatic commits. After a requested commit, check that the
working tree is clean. If
the environment blocks Git writes, report the restriction and leave the reviewed
diff intact; never claim a clean tree or a successful commit without checking.

Use patch releases for fixes, minor releases for compatible features, and major
releases for breaking changes. Record pending work under an unreleased changelog
entry. Keep package.json and both root lockfile version fields aligned when
preparing a release. A release tag must refer to the tested, published commit.
Never reuse an npm version or publish automatically while testing.

Report security review findings in the conversation; do not add audit reports
to the repository. Keep upstream Pi dependency findings at the upstream level;
do not turn them into project release blockers unless the user requests it.
