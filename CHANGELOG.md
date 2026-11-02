# Changelog

## Unreleased

- Add the `ask_user` tool with a shared question screen: single/multiple choice, recommended options, written answers and extra details, mouse/keyboard navigation, and review before sending. Serialize questions with permission dialogs, cancel stale requests on abort/session replacement, and allow only the origin-verified question tool through read-only and planning guards without granting execution approval.

- Show elapsed run time and generated output tokens beside Working. Include streamed reasoning and tool arguments, mark live estimates with `~` until provider usage arrives, and reset counters when a run settles or the session changes. Preserve native status messages, effort and update labels, and narrow layouts.

## 1.3.0

- Check `/agents` and the `task` tool in the installed npm artifact, including agent definition persistence, unknown-agent errors, command screens on cold load and reload, and disk session resume. Cover editor save/cancel behavior and narrow layouts without widening an explicit empty tool selection.

- Refine the legacy π header logo with wider 4:3 proportions, thinner slab serifs, and separated feet while preserving its accent color and shared text inset.

- Support `pi --resume SESSION_ID` and `pi -r SESSION_ID` for direct resume, and include the current chat ID in the exit hint. Keep the search picker when no ID is supplied, preserve custom session directories, and use Pi's native session resolver.

- Show `pi -r`, `pi --resume`, and `/resume` in the shared borderless resume screen, with recent chats, dates, message counts, native conversation search, and current/all-project scopes. Keep Pi's session loading and resume callbacks.

- Keep the current model, reasoning effort, and auto/code/plan work mode across `/new` and `/clear`. Start an inherited plan mode with an empty plan, preserving the old plan in its original session and requiring fresh execution approval.

- Register code mode through Pi's configured built-in extension slot instead of the workspace extension, avoiding the duplicate `codemode` startup warning and respecting built-in extension enable/disable settings.

- Migrate every test suite and the installed-package smoke check to TypeScript, preserve compiled-runtime coverage, and validate all test types with the strict test configuration.
- Add code mode with Pi's native QuickJS orchestration in its on variant alongside ordinary tools. Shift+Tab cycles auto, plan, and code; `/mode` selects a mode directly. Show code mode in the footer using high-effort blue. Preserve permissions, paused plans, tool exclusions, and session state across reload/resume.

- Preserve explicit empty subagent tool selections when saving or editing definitions; quote YAML values and reject invalid tool list types.
- Cancel active subagents when the parent permission or plan mode changes, and reject approvals that arrive after cancellation.
- Own subagent cancellation at the parent session: manual runs stop with Esc, Ctrl+C, or `/agents stop`, and session shutdown waits for child cleanup. Cancelled initialization never sends a provider request.
- Reuse terminal chrome across new extension factories during session replacement, restore the original callbacks and shell colors on exit, and dispose the outgoing editor when its replacement mounts.
- Report exhausted provider errors as failed subagent runs, preserve successful retry recovery, and recognize provider-side cancellation.
- Migrate subagent and session-lifecycle regression tests to strict TypeScript and include them in `npm run check`.

- Add a persistent **Legacy logo** toggle in `/config` → Preferences to replace the header mark with the classic serif π, keeping the selected accent color.

- Enable and disable installed skills with Space in `/skills`, keeping disabled entries visible for re-enabling. Save native Pi resource and package filters at the skill's scope, preserve skill files, and reload when the screen closes so disabled skills no longer appear in the available-skill prompt.

- Add `/agents` and a `task` tool for subagents: a delegated run works in its own context with its own instructions, tool selection, and model, and returns a single report. Definitions are Markdown files with frontmatter in `.pi/agents/` or the profile, where a project definition shadows a profile one and an untrusted project contributes none.
- Enforce the session's permission mode inside every subagent through an injected guard that runs the same checks as the parent, with the tool selection narrowed before the run and never wider than the definition. Read only and plan mode allow research only.
- Offer **Deny**, **Allow once**, and **Allow for this run** when a subagent needs approval in Ask mode, with denial as the default and the run-wide choice never preselected. Parent and subagent approvals share one queue, so two dialogs never compete for the terminal.
- Report an unreadable agent definition by name without hiding the agents that still load.
- Report an unauthenticated start in one plain header line instead of Pi's placeholder fields and two warnings: the header no longer reads "unknown with off effort", the duplicate sign-in warning is gone, and the engine's multi-line no-models warning is suppressed while every other startup warning still shows.
- Hide the effort label and the context readout while no model is selected, leaving no blank row above the input.
- Keep this interface's header, footer and input mounted while a session is replaced. Pi detaches extension components before it invalidates the outgoing session and mounts the next ones only after the replacement runtime has loaded, so `/clear`, `/new`, `/resume`, `/fork` and a reload flashed Pi's own startup header, resource listing, footer and editor for as long as loading took. The kept components report what their session last said, since a replaced context throws on every read.
- Keep the selected theme and accent through a session replacement. Pi rebuilds its theme from settings after extensions bind, which discarded the in-memory theme carrying the chosen appearance and repainted the screen in different colors on `/clear` and `/new`.
- Keep the terminal colors, pinned title and copy-notice capture mounted while one terminal continues with a replacement session, so `/clear`, `/new`, `/resume`, `/fork` and a reload no longer re-query the terminal and repaint the whole screen. A quit, or an unrecognised shutdown reason, still hands the terminal back.
- Add `/clear`, which clears the conversation by starting a new session through the supported extension API, so the header, footer and input are rebuilt with it. `/new` is routed to the same command instead of Pi's own handler, which claims it before extension commands are consulted.
- Show copy-on-select confirmations in the input corner, where effort and update information already appear, instead of the alternate screen's top-right stack. The notice takes the corner for a moment, then the effort level returns; a corner too narrow for it keeps the level instead.

## 1.2.0

- Bring `/login` and `/logout` provider selection and sign-in dialogs into the shared borderless terminal layout while keeping Pi's authentication and credential handling.
- Show the current session name set with `/name` immediately after Session ID in `/status`, or Not set for unnamed sessions.
- Render paused high/xhigh corner labels in solid #B1B9F9/#AF87FF instead of freezing a per-letter shimmer at different shades.
- Freeze the input-corner effort glow while idle; animate only during active work, preserving the selected reasoning level and stopping repaint timers on settlement, cancellation, blur, or disposal.
- Separate user message cards from compact tool calls with an uncolored blank row.
- Render the header from the shared appearance palette only, removing the unused native theme argument.
- Bind this wrapper's compiled extension imports to the selected CLI's bundled API, avoiding duplicate SDK loading while preserving third-party resolution and tool provenance.
- Load command screens, activity readers, skill services, and engine compatibility verification on demand; keep command registration, session hooks, and permission enforcement eager, and reject approvals cancelled while their view loads.
- Keep updater and interface initialization out of the version-reporting path.
- Reuse transcript rendering within each fullscreen document frame, avoiding a second history render for header spacing while preserving native mouse layout and fresh streaming/resize output.
- Keep one damaged memory note from hiding the others: the index reports the unreadable topic IDs, saves and deletes keep working, and the note's own read error names the topic and how to remove it. Damaged files still count toward the 32-topic limit.
- Bound the permission request shown for approval: long values are shortened individually and the whole input is capped, so a large write stays readable and cheap to repaint. Every truncation is stated.
- Report an invalid session prompt addition as invalid text instead of failing on a missing property.
- Keep a captured npm failure reportable when its temporary directory cannot be removed.
- Keep background npm checks from renaming the Pi tab on Windows, restore the title after agent tools finish, and suppress Windows terminal/taskbar progress without changing terminal settings.
- Clean build output before compilation, explicitly allowlist production extensions, and reject stale or development files in release artifacts.
- Keep experimental diagnostics in a separate development-only build; published packages do not register diagnostic commands.
- Clarify execution of approved plans: stay within scope, reuse planning findings, batch independent research, run required validation, and finish when the requirements and checks are satisfied.
- Extend bounded batching and completion guidance to ordinary tasks while preserving validation, dependencies, permissions, and the user's effort choice.

## 1.1.0

- Dark and light themes with `/theme`; `/color` previews neutral, yellow, green, blue, and purple accents for input borders, Pi logo, activity charts, and subtle message backgrounds. Appearance is saved in the Pi profile.
- Compact, expandable tool, shell, and skill calls with visible error summaries.
- Align Working above the input with the conversation; effort remains visible at the right and periodically alternates with available update information.
- Horizontal effort slider with mouse/keyboard selection, purple glow for high/xhigh, and an animated rainbow for max when supported by the model.
- Visible high/xhigh shimmer and rainbow max above the input, with animation paused for update notices and unfocused input. Full-width faint input rules with the chevron outside the text grid.
- Neutral stationary effort track with faster/smarter labels; low/auto mode and update text share #FFC107, medium/plan mode and green input borders share #4EBA65, high uses #B1B9F9, and xhigh and update versions use #AF87FF.
- `pi update` updates Pi Extended Agent itself; `pi update --engine` updates the managed Pi engine.
- Separate background release notices and caches for the agent and engine, with the corresponding terminal update command.
- `pi --version` reports both the agent and active Pi engine versions.
- Protect linked checkouts and other npm prefixes from the global agent updater; install an exact version with lifecycle scripts disabled.
- Reject engine manifest entry points that escape their package, including symbolic link redirects.
- Reject npm and fine-grained GitHub tokens when saving project memory.
- Pin patched xmldom and KaTeX dependencies for the documentation.
- Add Windows/Linux release checks on Node.js 22.19 and 24 and contribution rules.

## 1.0.0

First release of Pi Extended Agent, bundling Pi 1.4.0.

- Shared terminal interface for configuration, models, effort, permissions, skills, usage, status, and context.
- Automatic project memory with a short MEMORY.md index, topic editing, and shared Git worktree storage.
- Persistent planning with a read-only tool barrier, explicit execution approval, and step tracking.
- Session, project, and global prompt additions that preserve Pi's native system prompt.
- Shift+Tab switches normal/plan modes; Shift+Left/Right adjusts supported reasoning effort.
- Per-action tool approval and read-only permissions, including nested tool calls.
- Managed engine updates with compatibility checks, rollback, and background update notices.
- Native Pi authentication, model discovery, session history, and automatic compaction.
- English Nextra documentation with static search and a GitHub Pages deployment workflow.
- Repository instructions in AGENTS.md and a documented npm release procedure.
- Reserved memory index identifier to prevent note loss on case-insensitive filesystems.
