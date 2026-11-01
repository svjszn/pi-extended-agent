# Changelog

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
