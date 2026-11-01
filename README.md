<p align="center">
  <a href="https://pi.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="ui/pi-logo.svg">
      <img src="ui/pi-logo-light.svg" alt="Pi logo" width="128" height="128">
    </picture>
  </a>
</p>

<h1 align="center">Pi Extended Agent</h1>

<p align="center">
  A personal Pi setup with a quiet terminal interface.<br>
  One package. The <code>pi</code> command. Managed engine updates.
</p>

<p align="center">
  <a href="https://svjszn.github.io/pi-extended-agent/">Documentation</a> &nbsp; / &nbsp;
  <a href="#installation">Installation</a> &nbsp; / &nbsp;
  <a href="#already-have-pi">Existing Pi users</a> &nbsp; / &nbsp;
  <a href="#updates">Updates</a> &nbsp; / &nbsp;
  <a href="#development">Development</a> &nbsp; / &nbsp;
  <a href="#contributing">Contributing</a>
</p>

## At a glance

| Component | Version / default |
| :--- | :--- |
| Package | `pi-extended-agent` · `1.2.0` |
| Bundled Pi fallback | `1.4.0` |
| Managed engine | Updated separately with `pi update --engine` |
| Startup model | Selected by the active Pi engine from its settings and catalog |
| Node.js | `>=22.19.0` |

Pi provides the agent loop, tools, authentication, and sessions. This package provides the CLI entry point, interface extensions, and engine updater. Pi is installed automatically; users do not install it separately.

```text
  ██████     pi coding agent v1.4.0
  ██  ██     Your model with medium effort
  ████  ██   ~/project
  ██    ██

  ...conversation...

  ────────────────────────────────────────────────────────────
  >
  ────────────────────────────────────────────────────────────
  auto mode
```

The header shows the actual engine version, model, effort, and current working directory. Short conversations sit above the input; the footer shows the permissions mode at the left: `auto mode` for full access, `ask mode` for approvals, or `read only`.

The terminal tab is titled **Pi Coding Agent**. Chat messages and input align with the logo's two-column inset. User messages have a subtle dark gray background with light text and an uncolored separating row; assistant replies keep the terminal background. Tool calls stay compact. On Windows, Pi suppresses the terminal/taskbar progress indicator and keeps background update checks from renaming the tab; Windows Terminal settings are unchanged. Below the input, **auto mode** appears on the left and current context usage on the right, for example `~24k / 200k · 12% context`. Narrow terminals show a shorter indicator.

## Installation

You need **Node.js 22.19.0 or newer** and npm. On Windows, Git for Windows supplies the Bash shell used by Pi's default shell tool. Existing Pi users should read the migration instructions below first.

### From npm

Install the package and start the agent:

```sh
npm install -g --ignore-scripts pi-extended-agent
pi
```

The package also provides `pi-extended-agent` as an alternative command. Both launch the same agent.
`pi --version` shows both the agent and active engine versions.

### From source

```sh
git clone https://github.com/svjszn/pi-extended-agent.git agent
cd agent
npm ci --ignore-scripts
npm run build
npm link --force --ignore-scripts
pi
```

**`npm ci` installs the bundled Pi dependency. `npm link` connects the global commands to this checkout.** Keep the checkout in place while using the link. To run without linking: `npm run pi`.

### Already have Pi?

Upstream Pi and this package both provide a command named `pi`. npm may reject the new installation with `EEXIST` rather than replace the existing command.

The recommended migration for an npm-installed upstream Pi is:

```sh
npm uninstall -g @earendil-works/pi-coding-agent
npm install -g --ignore-scripts pi-extended-agent
```

For a linked source checkout, replace the second command with `npm link --force --ignore-scripts` from that checkout, or install a locally packed `.tgz` file.

If you linked an early checkout under the old name `local-coding-agent`, run `npm unlink -g local-coding-agent` before linking this renamed package.

**Your existing `~/.pi/agent/` profile is preserved**, including sign-in, personal settings, and sessions. The upstream package is removed; its user data is not.

An explicit takeover is also possible with `npm install -g --force --ignore-scripts pi-extended-agent`, but it leaves the upstream package installed. Reinstalling that upstream package later can claim `pi` again. Removing it first avoids that ambiguity.

For a standalone Pi installation or a different npm prefix, inspect the shell's command resolution instead of deleting executables manually:

```powershell
# PowerShell
Get-Command pi -All
```

```sh
# Bash / Zsh
type -a pi
```

If another installation appears earlier on PATH, launch `pi-extended-agent` directly while fixing PATH or removing the old installation through its own package manager.

### Sign in and verify

Run `pi` from the project you want to work on. Inside Pi:

1. Enter `/login`, select ChatGPT/Codex, and complete the browser sign-in if needed. Existing standard-profile credentials are reused.
2. Enter `/status` to check the active Pi version, selected model, and authentication status. `/config info` shows configuration paths.

`/login` and `/logout` use the shared borderless command layout for provider selection. Sign-in and credential removal still run through Pi; `/logout` removes saved credentials but not environment variables or provider-side access.

If the selected provider has no configured authentication, startup shows a warning and the header keeps a `/login PROVIDER` hint. The hint disappears after sign-in. This checks local configuration only; it does not verify token validity with the provider.

Each computer needs its own sign-in. The standard profile is `~/.pi/agent/`, normally `C:\Users\YOUR_NAME\.pi\agent\` on Windows. `PI_CODING_AGENT_DIR` remains available for an explicitly chosen alternative profile.

## Updates

Update from your terminal, then restart Pi:

```sh
pi update
```

Run `pi update --help` for additional options.

## Daily use

### Commands

| Command | Shows |
| :--- | :--- |
| `/usage` | Active provider, available account usage limits, and local reset times |
| `/stats` | Annual activity calendar and local history statistics |
| `/status` | Pi version, session ID, login method, active model, MCP servers, and tools |
| `/config` | Configuration overview with an integrated Preferences tab |
| `/context` | Context window map, estimated breakdown, loaded instructions, skills, and active tools |
| `/effort [level]` | Choose reasoning effort or set a supported level directly |
| `/theme [dark\|light]` | Choose a dark or light interface |
| `/color [default\|yellow\|green\|blue\|purple]` | Choose the accent for input borders, the Pi logo, activity charts, and subtle message backgrounds |
| `/permissions [mode]` | Choose full access, per-action approval, or read-only agent tools |
| `/memory` | Inspect, edit, delete, and toggle automatic project memory |
| `/plan [goal]` | Research a task, edit its plan, and explicitly approve execution |
| `/prompt [scope]` | View the native system prompt and edit session, project, or global additions |
| `/model [query]` | Search and select a model in the shared full-screen interface |
| `/skills [query]` | Installed skills, skills.sh search, preview, and installation |

The commands open full terminal screens below the Pi header, aligned to its two-column inset. They have no enclosing border. Read-only screens show `esc to close` in the input row; `/skills` uses that row for search and filtering. Usage bars show the remaining allowance; configuration values align in columns. The shared white and gray palette lives in `ui/theme.ts`, ready for a future `/theme` command. Press **Escape** or **Enter** to close a read-only screen. Scroll with **↑/↓**, **Page Up/Down**, **Home/End**, or the mouse wheel. Opening a viewer does not call a model. Starting `/plan <goal>` or choosing Execute sends the corresponding task to the agent.

`/usage` names the active provider. It has account-usage readers for ChatGPT OAuth (`openai-codex`) and Claude OAuth (`anthropic`), using credentials resolved by Pi. It does not import credentials from a separate Claude Code installation. The Claude reader has fixture coverage; it has not been verified with a live Claude account. These account backends are not public API contracts, and availability depends on account access and OAuth scopes. Limits are fetched only when the screen opens; remaining allowances are never estimated from local token counts. API keys, unsupported providers, missing data, and network errors show an explicit unavailable state. Credentials and usage responses are not copied or stored.

`/stats` shows an annual calendar above two columns of statistics, with **All time / Last 7 days / Last 30 days** filters. Switch filters with **Tab / Shift+Tab** or **←/→**. Filters affect the statistics; the calendar always covers the latest year and crops to recent weeks in a narrow terminal. Intensity follows recorded daily tokens, with prompt counts as a fallback when token data is absent.

Statistics come from the active profile's local sessions, including the current session and a custom session directory. They include favorite model (by assistant response count), recorded tokens, session count, active days, most active day, and streaks. Session length is the span between its first and last recorded messages, including idle gaps. Token totals include reported tool, compaction, and summary usage; reasoning tokens are not added twice. Forked entries count once. Statistics cover all recorded history or the selected period, while the calendar uses local dates for the latest 365 days. Activity on other computers or in the Codex app is not included.

`/config` opens the original Configuration overview, with Current session, Saved preferences, and Files in aligned columns. Press Tab to switch to the integrated Preferences tab in the same full-screen panel, keeping the header, footer, inset, and white/gray palette. Preferences include all settings previously available as `/settings`: themes, model defaults, effort defaults, transport, compaction, image handling, terminal behavior, and warnings. Use arrow keys to navigate, Enter to edit, and type to filter. Escape backs out of a submenu, returns to the overview, then closes the screen. Tab switches between the overview and preferences. Native save callbacks apply settings to the session; changing TUI mode briefly closes and reopens the panel so Pi can switch renderers safely. `/config info` remains an alias for the overview. Project preferences respect Pi's trust decision, and credentials are excluded. In print/RPC mode, `/config` shows the read-only overview.

The command menu omits `/settings`, `/tree`, `/thinking`, `/scoped-models`, `/import`, `/export`, `/share`, `/bug`, `/copy`, `/session`, `/changelog`, `/hotkeys`, `/fork`, `/clone`, `/trust`, `/about-agent`, `/llama`, and `/mcp`. These commands are also rejected when entered manually. Use `/config` for preferences, `/effort` for session reasoning effort, and `/status` for engine and session information. The runtime adapter applies to both bundled and managed engines and is checked before engine updates activate. It does not modify upstream package files.

`/status` shows the active Pi engine version, session ID, provider login method, model, MCP servers, and active tool names. The model appears with MCP and tools, and shows only its model ID. Login reflects configured credentials without resolving or refreshing them. MCP metadata combines the engine's configuration reader with extension registrations and tool namespaces; project settings respect Pi's trust decision. Registered tools do not prove a live connection. Engines without a native MCP configuration reader show the servers inferred from registered tools and extensions.

`/effort` opens a horizontal slider with the levels supported by the current model. Use **←/→** or drag the slider, apply with **Enter**, or cancel with **Escape**. High and xhigh glow purple; max uses an animated rainbow when the model supports it. `/effort high` sets a level directly. The current effort appears in the header. The input-corner glow stays static while idle and animates only during active work while the input is focused; this does not change the selected reasoning effort.

`/model` uses the same header, two-column inset, borderless body, monochrome palette, and input dock as the other command screens. Search stays in the input row; the current model uses `●` and the highlighted row is bold. Native model discovery, scoped-model switching with Tab, selection with Enter, and saving the default with Ctrl+S retain Pi's behavior. Escape cancels the selector and its background catalog refresh. Model-screen compatibility is checked before activating an engine update.

### Agent permissions

Open `/permissions` to choose a mode in the shared white/gray full-screen interface, or set it directly:

```text
/permissions full
/permissions ask
/permissions read-only
```

- **Full access** preserves the previous behavior: tools execute without this package's approval prompts. It is the default for new sessions.
- **Ask before actions** allows Pi's built-in `read`, `find`, `grep`, and `ls` without prompting. File changes, shell commands, and other tools (including MCP and nested tools) require approval for each call. TUI approval screens show the complete tool input with scrolling, start on Deny, and support Allow once. RPC uses Pi's confirmation request; a client must respond. Without an interactive UI, calls requiring approval are denied.
- **Read only** permits those four built-in reading/search tools. Write, edit, Bash, PowerShell, and external tools are blocked. External tools' read-only hints do not grant permission. Our own memory reads and plan updates are also allowed: they only access the app's project notebook. Memory saves and deletes follow the normal permissions policy.

The selection is saved as session metadata and restored on resume or reload. It applies to subsequent tool calls; it does not stop a tool already running. Pending approval dialogs are cancelled when the mode changes or the session shuts down. The footer reflects the selected mode. These controls govern agent tool calls, including calls through other tools; they are not an operating-system sandbox or a project-directory boundary. Explicit user shell commands (`!` / `!!`), command actions such as installing skills, and extensions' direct code execution keep their existing behavior. Project trust remains separate.

### Automatic project memory

Automatic memory is enabled by default. During normal work the agent can save useful preferences, corrections, environment facts, and project decisions through `project_memory`. It does not run a separate model request or an extraction pass after each message. Source-control history, transient progress, and credentials do not belong in memory. Common credential patterns are rejected when saving.

`/memory` opens the project notebook. **Tab** changes topics; **e** edits the selected topic, **n** creates one, **d** deletes it after confirmation, and **t** toggles automatic memory. Document editors use **Enter** for newlines, **Ctrl+S** to save, and **Escape** to discard changes. Direct commands include `/memory on`, `/memory off`, `/memory read TOPIC`, `/memory edit TOPIC`, `/memory add`, and `/memory delete TOPIC`. Disabling memory preserves notes but stops loading and agent access until re-enabled.

Notes live under the active profile's `pi-extended/projects/PROJECT_KEY/memory/`. Git worktrees of the same repository share a notebook; separate repositories are isolated. Outside Git, the canonical working directory identifies the project. The short `MEMORY.md` index contains at most 32 summaries (160 bytes each); each topic has up to 12 KB of details read by the model only on demand. The notebook stays outside the source tree and persists across sessions. These local files are sent to the selected model when loaded into context.

### Plan before executing

**Shift+Tab** in the chat input switches between normal mode (`auto mode` with Full access) and `plan mode`. Switching out pauses and preserves the plan; switching back restores the draft. It keeps your input text, effort, and permission choice. It does not start execution. Finish the current run and queued messages before switching. **Shift+Left/Right** decreases/increases reasoning effort through the current model's supported levels, stopping at the lowest/highest level; `/effort` also remains available. Inside command screens, Shift+Tab keeps its usual navigation behavior.

Use `/plan <goal>` to start research, or open `/plan` and press **s** to enable planning before describing the task. The agent saves the goal, steps, affected areas, and checks with `update_plan`. The footer shows `plan mode`. A tool hook allows only built-in reading/search tools, memory reads, and our internal plan updates. Available built-in `find`, `grep`, and `ls` tools are temporarily activated so research works without shell access; the previous selection is restored on execution or cancellation. Changes, external tools, nested mutation calls, and shell commands are blocked even under Full access. Interactive/RPC user shell commands are also blocked while planning.

Review the result with `/plan`, edit with **e** or `/plan edit`, and explicitly choose **x** or `/plan execute` to start implementation. Only a user command can approve execution. The existing `/permissions` mode stays in force; executing a plan never grants Full access. `/plan cancel` leaves planning without starting work. Plans are saved per session in the profile, survive compaction, and restore when that session is resumed or reloaded. During execution the agent tracks pending, in-progress, and completed steps; changing the approved scope requires another edit and approval.

### System prompt additions

`/prompt` shows a preview for the next run, the native Pi prompt, and **session**, **project**, and **global** additions. Use **Tab** to choose a section, **e** to edit additions, or **d** to clear them after confirmation. Native Pi instructions remain intact. `/prompt session`, `/prompt project`, and `/prompt global` open the corresponding editor directly; `/prompt project Use npm for this repository.` saves text without opening an editor.

Global and project additions live in the active profile; session additions are stored in Pi session metadata. Additions are limited to 12 KB per scope and apply on the next run, in global → project → session order. Other extensions can add their own instructions at run start. Pi's existing system-prompt files, instruction discovery, and automatic compaction remain in use; this package does not replace them.

### Inspect context

`/context` shows a white and gray map of the active model's context window, followed by estimates for the system prompt, tool definitions, loaded instructions, skill descriptions, messages, and tool results. Free space and the configured compaction buffer appear separately. The screen also lists instruction paths, skill names, active tool names, and compaction settings. It reads in-memory session data without making a model request or adding content to the conversation.

The total follows Pi's current-window estimate, based on its latest valid assistant usage and estimates for newer messages. Before the first response, the indicator also estimates the prompt and active tool schemas. These are not cumulative billed tokens. `~` marks estimated values. Categories use Pi's character-based heuristic and reconcile to the total; unclassified differences appear as **Other context**. Individual source lists show raw estimates. Provider formatting, images, and extension hooks can affect final request sizes.

Compacted history and inactive branches are excluded. After compaction, Pi may report an unknown total until the next response; the footer shows `—` instead of retaining the previous usage. The indicator refreshes on session, model, message, and compaction events, without recounting tokens on every terminal frame. Use Pi's native `/compact` to summarize the current session or `/new` to begin a fresh one.

### Find and install skills

Open `/skills` for **Installed** and **Search** tabs, or enter `/skills react` to search immediately. The installed list comes from skills already loaded by Pi, including shared folders, configured paths, and packages. Type to filter it. In Search, type at least two characters to search [skills.sh](https://skills.sh/). A filled circle **●** marks a skill available in the current session; an empty circle **○** marks one that is not loaded. Results also show the source repository and install count. Descriptions appear when the catalog supplies them; the preview reads the description and full `SKILL.md` from GitHub.

- **Tab / Shift+Tab** switches tabs; **↑/↓** selects a skill; **Enter** opens its preview.
- In a new skill's preview, **Tab / ←/→** chooses **This project** or **All projects**, then **Enter** installs.
- **Page Up/Down** and **↑/↓** scroll the preview; **Escape** goes back, closes the manager, or cancels an active download.
- After installation, **Enter** returns to the chat and reloads Pi's skills without restarting the process.

Project skills go to `.pi/skills/`; global skills go to the active profile's `skills/` folder (`~/.pi/agent/skills/` by default). Project installation requires Pi's existing trust decision; choose a global installation or reopen Pi and approve the project when prompted. `--no-skills` and Pi's resource-discovery settings continue to apply.

The first version supports public GitHub skills from the catalog. Preview and installation use one pinned commit. The selected skill's directory is downloaded with its references, scripts, and assets, and each file is verified against its Git blob hash. Installation does not run scripts or install the skill's dependencies. Existing directories are never replaced. A failed or cancelled download is cleaned up before activation. Each installed folder includes `.pi-extended-source.json` with its source revision for future management.

Large repositories, symlinks, submodules, conflicting filenames, and skills over 200 files, 2 MiB per file, or 25 MiB total are not supported in this first version. Search uses the same public catalog endpoint as the Skills CLI; GitHub's unauthenticated request limits also apply to previews. No model-provider credentials are sent to either service. `/skills` in print/RPC mode is read-only: it lists or searches, without installing.

Use `/model` to switch models and `/effort` to choose reasoning effort. Model selection follows the active Pi engine's settings and catalog, including its provider defaults. This package does not inject a fixed model ID, so engine updates can change the provider default without leaving an obsolete CLI override. Explicit CLI model/provider choices, `--models`, and resumed sessions keep Pi's native behavior. Choosing a custom model ID explicitly remains supported by Pi. Before sign-in, Pi may have no model selected; the header shows a `/login` hint.

Press **Escape** to exit when the input is empty and Pi is idle. During work, in menus, and in autocomplete, Escape keeps its normal cancellation behavior. An unsent draft prevents Escape from exiting. **Ctrl+D** remains available.

```sh
pi --continue
pi --model openai-codex/gpt-6-astra
pi --thinking medium
pi --tui-mode regular
pi --no-extensions
```

## Development

| File | Responsibility |
| :--- | :--- |
| [`bin/pi.mjs`](bin/pi.mjs) | Stable npm entry point for installed and linked commands |
| [`bin/main.ts`](bin/main.ts) | Own the commands and launch the active Pi engine |
| [`bin/runtime.ts`](bin/runtime.ts) | Resolve bundled and managed engine versions |
| [`bin/update.ts`](bin/update.ts) | Install, activate, and roll back engines |
| [`bin/verify-runtime.ts`](bin/verify-runtime.ts) | Check candidate engine compatibility |
| [`extensions/`](extensions/) | Register commands, UI, and keyboard behavior |
| [`lib/`](lib/) | Read account usage, local activity, and selected configuration |
| [`ui/chrome.ts`](ui/chrome.ts) | Render the header, footer, and spacing |
| [`ui/escape-exit.ts`](ui/escape-exit.ts) | Preserve native behavior around Escape |
| [`ui/pi-logo.svg`](ui/pi-logo.svg) | Reference Pi logo geometry |
| [`test/`](test/) | Check UI, startup, and update behavior |

Source code uses TypeScript with `strict` enabled. Plain `npm ci` builds it through `prepare`; when using `npm ci --ignore-scripts`, run `npm run build` explicitly. Each build clears `dist/` before compiling, so deleted sources cannot leave stale JavaScript in a package. Pi loads only the explicit production extension files in `package.json`; unexpected extension output fails the build. Installed users do not need TypeScript or a build step. Development diagnostics live in `dev/`, compile separately with `npm run build:dev` into `.local/dev-dist/`, and are excluded from the npm package. Keep TypeScript paths in `tsconfig.json` aligned with the bundled Pi dependency; updated engines resolve their own modules at runtime.

After editing source files, run `npm run build` before restarting a directly linked `pi`. `npm run pi`, `npm start`, and `npm test` build automatically. For continuous compilation in another terminal, use `npm run build -- --watch`. Tests exercise the compiled JavaScript that ships to users. `npm pack` builds before creating an archive.

The startup resource listing is hidden; skills and extensions still load normally. UI integration relies on some Pi component structure, so engine updates are checked before activation.

```sh
npm run check
npm run build
npm test
```

Before publishing a release, run `npm run release:check`. It runs type checking and tests, packs the exact npm artifact, installs it into an isolated global prefix, and checks the installed CLI and extensions with an empty profile. The archive is saved under `.local/releases/`. This check never publishes or changes your normal global installation. Windows is the currently verified platform; Linux/macOS need their own runs before claiming support.

Repository instructions live in [AGENTS.md](AGENTS.md). The English documentation
site lives in `docs/` as an independent Nextra project. Run `npm ci --prefix docs`
and `npm run dev --prefix docs` to work on it. Production builds export static
pages and a search index; the Documentation workflow deploys them to GitHub
Pages. See [RELEASING.md](RELEASING.md) for verification and publication steps.

To check credentials and make one short model request:

```sh
npm run pi -- auth check --provider openai-codex --no-refresh --json
npm run smoke
```

The auth check should report `"status":"ready"`. The smoke request runs without tools or session storage and should return `PI_OK`. To use another model: `npm run smoke -- --model MODEL_ID`.

## Contributing

Bug reports, fixes, documentation improvements, and interface refinements are
welcome. For a larger feature, you can open an
[issue](https://github.com/svjszn/pi-extended-agent/issues) to discuss the approach.

Fork the repository, create a branch for your change, and follow the setup in
[Development](#development). Keep pull requests focused and explain the problem,
the resulting behavior, and how you checked it.

For agent code changes, run:

```sh
npm run check
npm test
```

For documentation changes, install the docs dependencies and build the site:

```sh
npm ci --prefix docs
npm run build --prefix docs
```

Add regression coverage for behavior fixes and include screenshots for interface
changes when possible. Keep generated files, local profiles, and credentials out
of commits. Read [AGENTS.md](AGENTS.md) for repository conventions and the
[contributing guide](https://svjszn.github.io/pi-extended-agent/contributing/)
for the full workflow.

Use focused English Conventional Commits such as
`fix(updates): preserve linked checkouts` and `test(security): reject runtime path escapes`.
Check `git status --short --branch` before starting and after committing. Use
patch versions for fixes and keep pending changes in the changelog until the
tested release is ready.

## Troubleshooting

**The original Pi interface opens or `/effort` is missing.** A different installation owns `pi`. Check PATH as shown above. Remove the old npm-installed Pi, then reinstall or relink this package. The unique `pi-extended-agent` command can also launch our package directly.

**An engine update fails.** The previous engine stays selected. Check the error, fix connectivity or npm access, and retry. If the version check times out, `pi update --to VERSION` skips that lookup and installs an exact version (installation still needs npm access or cached packages). Use `pi update --rollback` to select the previous version after a successful update.

**The updater reports a lock.** Another update may be running. If the updater was interrupted and no update process remains, remove the reported `update.lock` file and retry.

**Authentication is missing.** Check `PI_CODING_AGENT_DIR` and use `/login` on this computer. Early local experiments used `.local/pi/`; the current package does not select that directory automatically.

## License

[MIT](LICENSE).

Built on [Pi](https://pi.dev) by Earendil and contributors. Uses the official pixel mark in a terminal-friendly form.
