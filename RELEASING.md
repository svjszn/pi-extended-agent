# Releasing Pi Extended Agent

The CLI and documentation have independent dependency trees. Run commands below
from the repository root unless a different directory is shown. GitHub Pages
and npm publication need an authenticated account with access to this repository
and the `pi-extended-agent` package name.

## 1. Verify the release

Check that `package.json`, `package-lock.json`, the changelog, README, and docs
agree on the wrapper version and bundled Pi engine. Run:

```sh
npm ci
npm run release:check
npm ci --prefix docs
npm run build --prefix docs
```

Check `git status --short --branch` before preparation and record changes under
the next unreleased changelog entry. Run `npm audit` and `npm audit --prefix docs`;
investigate findings rather than applying breaking upgrades with `--force`.
Commit each logical change with an English Conventional Commit subject. Before
publishing, remove the unreleased label for that version, rerun verification on
the final files, commit, and confirm that Git is clean.

Also build the docs with `DOCS_BASE_PATH=/pi-extended-agent` to exercise the
production subpath. In PowerShell:

```powershell
$env:DOCS_BASE_PATH = '/pi-extended-agent'
npm run build --prefix docs
Remove-Item Env:DOCS_BASE_PATH
```

`release:check` creates `.local/releases/pi-extended-agent-VERSION.tgz`, installs
it in an isolated global prefix, and tests that installed package. Inspect the
archive file list. It must exclude `docs/`, local profiles, fixtures,
credentials, and build caches. The release check does not call a model or
change the normal global installation.

## 2. Publish the documentation

Authenticate locally with `gh auth login`. In the repository's **Settings →
Pages → Build and deployment**, choose **GitHub Actions** as the source. Commit
and push the reviewed changes to `main`.

The Documentation workflow builds on documentation pull requests and publishes
successful `main` builds. It can also be started manually in Actions:

```sh
gh workflow run docs.yml --ref main
gh run list --workflow docs.yml
```

The intended production URL is:

```text
https://svjszn.github.io/pi-extended-agent/
```

After deployment, check the home page, a nested page loaded directly, mobile
navigation, the favicon, and a search result. All must work under the repository
subpath. A successful local export alone is not a verified public deployment.

## 3. Publish the exact npm archive

Authenticate with `npm login` and confirm the account with `npm whoami`. Before
the first publication, verify the package name is available or owned by the
intended account. Confirm the target version has not already been published.

For version 1.1.0:

```sh
npm view pi-extended-agent versions --json
npm publish .local/releases/pi-extended-agent-1.1.0.tgz --access public
```

For a never-published name, `npm view` may return `E404`. Follow npm's browser
or two-factor prompt if requested. Do not store tokens or one-time codes in
tracked files. Never publish from `docs/`, which is marked private.

Verify registry metadata and an isolated global install after publication:

```sh
npm view pi-extended-agent@1.1.0 version dist.integrity
npm install -g --prefix .local/published-smoke --ignore-scripts pi-extended-agent@1.1.0
```

Run the installed `pi --version` and `pi --help` from that prefix with an empty
test profile. Verify that the returned registry integrity matches the archive
validated by `release:check`. Do not replace the user's normal global command
as a release smoke test.

## 4. Tag and announce

After publication and deployment have been verified, replace any remaining
prepublication wording, commit those changes, tag the release commit as `v1.1.0`,
and push the tag. Create the GitHub release from the changelog, linking both
the documentation and npm package. Do not claim publication or deployment until
their remote results have been checked.
