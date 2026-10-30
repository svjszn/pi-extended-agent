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
- `docs/` is an independent Nextra site. Its dependencies must stay out of the CLI.
- `scripts/release-check.mjs` validates the installed npm artifact in an isolated prefix.

## Development

Use Node.js 22.19.0 or newer. Install with `npm ci`; if lifecycle scripts are
disabled, run `npm run build` afterward. Edit TypeScript sources, never `dist/`
or `node_modules/`. Build before restarting a linked `pi`.

- `npm run check` checks strict TypeScript types.
- `npm run build` compiles the CLI and extensions into `dist/`.
- `npm test` builds and runs the complete suite.
- For a focused check after building:
  `node --test --test-isolation=none test/workspace.test.mjs`.
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
  white/gray palette, borderless command screens, and working narrow-terminal
  layouts. Reuse shared components before adding a new screen structure.
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
implemented commands and distinguish engine updates (`pi update`) from wrapper
updates (`npm install -g pi-extended-agent@latest`). Do not claim verification on
an operating system, provider, or deployment that was not actually checked.

The docs site is a static export published to GitHub Pages by
`.github/workflows/docs.yml`. Check the repository base path, internal links,
assets, and search index when changing its configuration.

Before npm publication, run `npm run release:check` and inspect the archive.
Publish the validated `.tgz` artifact. Do not include `docs/`, fixtures, profiles,
credentials, or build caches. Publishing, tagging, and pushing require a user
request that authorizes those actions; do not infer a release from routine edits.
