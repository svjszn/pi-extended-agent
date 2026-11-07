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
  A terminal coding agent that asks before it changes anything,<br>
  plans before it starts, and remembers your project between sessions.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-extended-agent"><img alt="npm" src="https://img.shields.io/npm/v/pi-extended-agent?color=2d8f4e&label=npm"></a>
  <a href="https://github.com/svjszn/pi-extended-agent/actions/workflows/ci.yml"><img alt="Checks" src="https://github.com/svjszn/pi-extended-agent/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node 22.19+" src="https://img.shields.io/badge/node-%E2%89%A522.19-5a5a5a">
</p>

<p align="center">
  <a href="https://svjszn.github.io/pi-extended-agent/">Documentation</a> &nbsp;·&nbsp;
  <a href="#install">Install</a> &nbsp;·&nbsp;
  <a href="#what-it-adds-to-pi">What it adds</a> &nbsp;·&nbsp;
  <a href="#updates">Updates</a> &nbsp;·&nbsp;
  <a href="https://github.com/svjszn/pi-extended-agent/issues">Issues</a>
</p>

<p align="center">
  <img src="docs/public/assets/session.png" alt="Pi Extended Agent working on a task in plan mode, showing compact tool output, the current step, and elapsed time with output tokens" width="860">
</p>

Pi Extended Agent is a personal [Pi](https://pi.dev) setup, published because the
pieces turned out to be worth sharing. Pi supplies the agent loop, authentication,
model discovery, sessions, and compaction. This package wraps it in a quieter
terminal interface and adds the controls that long sessions need.

See the [changelog](CHANGELOG.md) for what landed in **1.5.0**.

## Install

You need **Node.js 22.19.0 or newer** and npm. On Windows, install Git for Windows
so Pi has a Bash for its shell tool.

```sh
npm install -g --ignore-scripts pi-extended-agent
cd your-project
pi
```

Pi itself ships inside the package, so there is nothing else to install.
`pi-extended-agent` is an alternative name for the same executable.

> **Already have `pi`?** Upstream Pi owns the same command name, and npm reports
> `EEXIST` rather than replacing it. Read the
> [migration guide](https://svjszn.github.io/pi-extended-agent/getting-started/migration/)
> before you install.

Inside Pi, connect a provider and pick a model. Existing Pi credentials and
sessions in your profile are reused as they are.

```text
/login
/model
```

Fresh sessions start in Allow. Run `/permissions ask` to require approval for
changes and shell commands, then describe what you want done.

## What it adds to Pi

| | Plain Pi | With this package |
| --- | --- | --- |
| **Tool permissions** | Runs tools as configured | `allow` / `ask` / `deny` per session, with a full-screen approval dialog showing the complete tool input before you decide |
| **Planning** | — | `/plan` researches first, then waits for explicit `/plan execute`; nothing is written until you approve |
| **Project memory** | — | Notes that persist across sessions, stored in your profile rather than the working tree |
| **Subagents** | — | Built-in `scout` (research) and `lens` (review), plus your own via `/agents` — each bounded and held to the parent's permissions |
| **Changes and files** | — | `/diff` for working-tree and staged changes, `/nano` to edit a file without leaving the session |
| **Context** | Usage total | `/context` breaks the window down by prompt, tools, instructions, skills, messages, and results |
| **Interface** | Pi's default | Compact or full tool output, dark/light themes, selectable accent colors |
| **Updates** | Global self-update | `pi update` for the agent, `pi update --engine` for the Pi engine, with a compatibility check and rollback |
| **Diagnostics** | — | `/doctor` and a standalone `pi doctor` that works even when the selected engine will not start |

### Decide how much to approve

`/permissions` sets one of three modes for the session. In `ask`, reads and
searches run freely while shell commands, edits, and external tools stop for
approval — and the approval dialog pages through the complete tool input, so you
are never approving a truncated command.

<p align="center">
  <img src="docs/public/assets/permissions.png" alt="The permissions screen offering Allow, Ask, and Deny, with Ask selected and its behaviour described" width="860">
</p>

### Plan first, then execute

`/plan` puts the session into research-only mode. The agent investigates, drafts a
goal with steps, affected areas, and checks, and then stops. Nothing is modified
until you run `/plan execute` — subagents included.

### Keep the transcript readable

Tool calls collapse to one line with their result, so a long session stays
scannable. Click a call, or switch to full output, when you want everything.

<p align="center">
  <img src="docs/public/assets/shell.png" alt="A session running shell commands in code mode, each call collapsed to a single line with its result underneath" width="860">
</p>

### Delegate research and review

`scout` traces a question through the codebase and reports back with file and line
references. `lens` reviews changes for real defects. Both run in their own context
and under the same permissions as the session that spawned them, so a subagent can
never do something you have not allowed. `/agents` edits them or adds your own.

<p align="center">
  <img src="docs/public/assets/agents.png" alt="The subagents screen showing the built-in scout agent, its tools, model, and full instructions" width="860">
</p>

### Know what is filling the context window

`/context` splits the window into the system prompt, tool definitions,
instructions, skill descriptions, messages, and tool results, so a session that is
filling up tells you what to trim.

<p align="center">
  <img src="docs/public/assets/context.png" alt="The context screen breaking a session down by category, with free space and the compaction buffer" width="860">
</p>

## Updates

Run these in your terminal, then restart Pi:

```sh
pi update                 # Update Pi Extended Agent
pi update --engine        # Update its managed Pi engine
```

`pi --version` prints both versions. Add `--check` to look without installing.
See [Updates](https://svjszn.github.io/pi-extended-agent/guide/updates/) for
pinned versions, rollback, and linked source checkouts.

## Documentation

| To… | Read |
| --- | --- |
| Install, sign in, and start a session | [Getting started](https://svjszn.github.io/pi-extended-agent/) |
| Adjust tool output and navigate the terminal | [Terminal interface](https://svjszn.github.io/pi-extended-agent/guide/interface/) |
| Review a plan and control agent actions | [Planning](https://svjszn.github.io/pi-extended-agent/guide/planning/) · [Permissions](https://svjszn.github.io/pi-extended-agent/guide/permissions/) |
| Inspect changes or edit files manually | [Files and changes](https://svjszn.github.io/pi-extended-agent/guide/files/) |
| Save project knowledge or delegate work | [Memory](https://svjszn.github.io/pi-extended-agent/guide/memory/) · [Subagents](https://svjszn.github.io/pi-extended-agent/guide/agents/) |
| Find a command or resolve a problem | [Commands](https://svjszn.github.io/pi-extended-agent/reference/commands/) · [Troubleshooting](https://svjszn.github.io/pi-extended-agent/reference/troubleshooting/) |

## Development

From a cloned checkout:

```sh
npm ci
npm run check
npm test
```

`npm run pi` builds and launches the local agent. See
[Development](https://svjszn.github.io/pi-extended-agent/development/) and
[Contributing](https://svjszn.github.io/pi-extended-agent/contributing/) for
source installation, the separate docs site, and the contribution checks.

## License

[MIT](LICENSE). Built on Pi by Earendil and contributors; uses the official Pi mark.
