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
  Not really a minimalistic harness.<br>
  A personal Pi setup for working on code in the terminal.
</p>

<p align="center">
  <a href="https://svjszn.github.io/pi-extended-agent/">Documentation</a> &nbsp; / &nbsp;
  <a href="#installation">Installation</a> &nbsp; / &nbsp;
  <a href="#updates">Updates</a> &nbsp; / &nbsp;
  <a href="https://github.com/svjszn/pi-extended-agent/issues">Issues</a>
</p>

Built on [Pi](https://pi.dev), with a quiet terminal interface, project memory,
reviewable plans, permission prompts, and bounded subagents. Pi provides the
agent loop, authentication, model discovery, sessions, and compaction.

See the [changelog](CHANGELOG.md) for what's new in **1.5.0**.

## What it adds

- Compact or full tool output, dark/light themes, and selectable accent colors.
- Project memory and prompt additions that stay outside the working tree.
- Plans with explicit execution approval and `allow` / `ask` / `deny` permissions.
- Built-in scout and lens subagents for code research and review.
- `/diff`, `/nano`, and `/doctor` for changes, manual editing, and local diagnostics.
- Managed Pi engine updates with compatibility checks and rollback.

## Installation

You need **Node.js 22.19.0 or newer** and npm. On Windows, install Git for Windows
to provide Bash. If you already have `pi`, read the
[migration guide](https://svjszn.github.io/pi-extended-agent/getting-started/migration/)
before replacing the command.

```sh
npm install -g --ignore-scripts pi-extended-agent
cd your-project
pi
```

Pi is included. `pi-extended-agent` is an alternative executable for the same
package. In Pi, connect a provider and choose an available model:

```text
/login
/model
```

Existing Pi credentials and sessions are reused from the active profile. Fresh
sessions use Allow. Enter `/permissions ask` to require approval for changes and
shell commands, then describe a task in the chat.

## Updates

Run these in your terminal, then restart Pi:

```sh
pi update                 # Update Pi Extended Agent
pi update --engine        # Update its managed Pi engine
```

`pi --version` shows both versions. Use `--check` to check without installing;
see [Updates](https://svjszn.github.io/pi-extended-agent/guide/updates/) for exact
versions, rollback, and linked source checkouts.

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

Run `npm run pi` to build and launch the local agent. See
[Development](https://svjszn.github.io/pi-extended-agent/development/) and
[Contributing](https://svjszn.github.io/pi-extended-agent/contributing/) for source
installation, the separate docs site, and contribution checks.

## License

[MIT](LICENSE). Built on Pi by Earendil and contributors; uses the official Pi mark.
