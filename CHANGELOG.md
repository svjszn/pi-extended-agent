# Changelog

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
