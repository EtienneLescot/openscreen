# Secrets and tokens

OpenScreen uses a small set of GitHub Actions secrets and repository variables. This file documents what each one does and how to create or rotate it.

## Required for releases

### `OPENSCREEN_RELEASE_TOKEN`

A **fine-grained personal access token** used by the release pipeline (`build.yml#publish-release`, `prerelease.yml`, `promote.yml`) for the actions that `GITHUB_TOKEN` cannot perform reliably:

- Creating a GitHub Release via `gh release create` such that the `release: published` event **does** fire downstream workflows (homebrew/winget/nix/aur). With `GITHUB_TOKEN`, the event is suppressed to prevent recursive workflow runs.
- Pushing commits and tags to `main` from `prerelease.yml` and `promote.yml` in a way that can later trigger downstream CI.
- Closing milestones and posting comments during the issue-migration step.

**Why not just use `GITHUB_TOKEN` for everything else?**

Most of the repo's workflows (CI, build, Tier 3 publishers, Discord sync) only need read access or scoped write access within a single repo. `GITHUB_TOKEN` is fine for those and is the safer default. The release pipeline needs cross-workflow event firing, which only a PAT can provide.

**How to create it:**

1. Go to <https://github.com/settings/tokens?type=beta> (fine-grained PATs).
2. **Resource owner**: `getopenscreen` (only this org — do not grant access to personal repos).
3. **Repository access**: `getopenscreen/openscreen` only.
4. **Permissions**:
   - `Contents`: Read and write
   - `Issues`: Read and write
   - `Pull requests`: Read and write (the release pipeline opens a PR to bump `package.json` and rebase-merges it into `main` because the org-level workflow permissions block `GITHUB_TOKEN` from creating PRs)
   - `Actions`: Read and write (the release pipeline triggers `build.yml` via `gh workflow run`; GITHUB_TOKEN tag pushes don't fire downstream workflows in this org)
   - `Workflows`: Read and write (the release branch contains the workflow files; creating it requires writing to `.github/workflows/`)
   - `Metadata`: Read-only (auto-selected)
5. **Expiration**: 1 year. Set a calendar reminder to rotate.
6. Generate the token, copy it once, then add it as a repository secret. The `gh` CLI does **not** accept the value as a positional argument — use `--body` or stdin:
   ```bash
   # Either:
   gh secret set OPENSCREEN_RELEASE_TOKEN --body "ghp_xxxxxxxxxxxxxxxxxxxx" --repo getopenscreen/openscreen
   # Or:
   echo "ghp_xxxxxxxxxxxxxxxxxxxx" | gh secret set OPENSCREEN_RELEASE_TOKEN --repo getopenscreen/openscreen
   ```
7. Verify by triggering a test `workflow_dispatch` on `prerelease.yml` with `bump=patch`, `rc_number=99` against an empty milestone, then revert the resulting `package.json` bump PR/commit.

**Rotation:**

Old token and new token both work in parallel until the old one expires or is revoked. Rotate by:

1. Generate the new token.
2. Update the secret.
3. Revoke the old token.

There's no need to coordinate a rotation window — the release pipeline runs at most a few times per month.

## Required repo ruleset bypass

The `main` branch is protected by the repository ruleset `main-protection` (id `18060803` on this repo), which requires changes to be made through a pull request. The release pipeline (`prerelease.yml` and `promote.yml`) commits `package.json` directly to `main` because the version bump has to land before the tag is pushed and the build runs.

To allow that direct push, the ruleset has two bypass actors:

- **`EtienneLescot`** (id `215859519`) — so manual pushes from the maintainer's local checkout work.
- **`github-actions[bot]`** (id `41898282`) — so the workflow's `GITHUB_TOKEN` push (the default `actions/checkout@v4` auth) is also accepted.

## Required repo ruleset bypass and PR flow

The `main` branch is protected by the repository ruleset `main-protection` (id `18060803` on this repo). It enforces:

- `deletion` — branches can't be deleted
- `non_fast_forward` — no force pushes
- `required_linear_history` — fast-forward only
- `pull_request` — 1 approving review + code owner review, only rebase merge allowed (`merge` and `squash` are disabled at the repo level)

The release pipeline (`prerelease.yml` and `promote.yml`) cannot bypass this directly because:

- The org policy disables `GITHUB_TOKEN` write permissions (`Allow GitHub Actions to create and approve pull requests` is OFF at the org level), so `GITHUB_TOKEN` cannot create the bump PR.
- Fine-grained PATs do not satisfy ruleset bypass actors, so a PAT-driven direct push is rejected with `GH013`.

So the workflow:

1. Pushes the bump commit to a `release/vX.Y.Z` branch using the PAT (no rule check on non-main branches).
2. Opens the PR using the PAT (`gh pr create` with `GH_TOKEN=$OPENSCREEN_RELEASE_TOKEN`).
3. Rebase-merges the PR using the PAT. EtienneLescot is a ruleset bypass actor with `bypass_mode: "always"`, so the `pull_request` review requirement is skipped for this merge.

The ruleset has two bypass actors:

- **`EtienneLescot`** (id `215859519`) — so the PAT-driven PR merge satisfies the `pull_request` rule.
- **`github-actions[bot]`** (id `41898282`) — added defensively, though `GITHUB_TOKEN`-driven operations are blocked by the org policy regardless.

To confirm the bypass list:

```bash
gh api /repos/getopenscreen/openscreen/rulesets/18060803 --jq '.bypass_actors'
# Expect both 215859519 and 41898282 with bypass_mode "always".
```

## Required for Discord announcements

### `DISCORD_BOT_TOKEN`

Bot token from a Discord application added to the OpenScreen Discord server with the `bot` scope and at minimum:

- `Send Messages` in any text channels where the bot posts
- `Create Public Threads` in the forum channels (for the release announce script)
- `Send Messages in Threads` so the first message in a new thread goes through
- `Manage Messages` if you want the roadmap-sync workflow to pin its message
- `Read Message History` (usually default)

Stored as a repository secret.

### `DISCORD_RC_TESTING_CHANNEL_ID`

Snowflake ID of the Discord channel where release candidates are announced. Can be a regular text channel or a forum channel — the `discord-release-announce.mjs` script auto-detects the type:

- **Text channel** (`type=0`): posts the announcement as a regular message.
- **Forum channel** (`type=15` or `16`): creates a new thread with the announcement as the first message. One thread per release, named like `v1.5.1-rc.1 RC — testing`.

Set as a **repository variable** (not a secret — it's not sensitive):

```bash
gh variable set DISCORD_RC_TESTING_CHANNEL_ID --body "1521416826146263051" --repo getopenscreen/openscreen
```

### `DISCORD_RELEASE_CHANNEL_ID`

Same pattern as above, for the stable release announcement channel.

```bash
gh variable set DISCORD_RELEASE_CHANNEL_ID --body "<id>" --repo getopenscreen/openscreen
```

### `DISCORD_ROADMAP_CHANNEL_ID` and `DISCORD_ROADMAP_MESSAGE_ID`

Used by `discord-roadmap-sync.yml` to keep the pinned roadmap message in sync. Repository variables.

## Tier 3 package registries

Each external registry has its own credential set. See the per-workflow README comments at the top of these files:

- `.github/workflows/update-homebrew-cask.yml` — `HOMEBREW_TAP_TOKEN`, `HOMEBREW_TAP_OWNER`, `HOMEBREW_TAP_REPO`, `HOMEBREW_CASK_NAME`
- `.github/workflows/publish-winget.yml` — `WINGET_ACC_TOKEN`, `WINGET_IDENTIFIER`
- `.github/workflows/bump-nix-package.yml` — uses `GITHUB_TOKEN` (no extra secret required)
- `.github/workflows/aur-publish.yml` — `AUR_SSH_PRIVATE_KEY`, `AUR_KNOWN_HOSTS`, `AUR_PACKAGE_NAME`

All four already gate on `!prerelease`, so a `vX.Y.Z-rc.N` tag will not push to homebrew/winget/nix/aur.

## Apple notarization

`build.yml` skips notarization when the tag contains a `-` (i.e. any pre-release), so the macOS secrets below are only consulted for stable releases:

- `MAC_CERTIFICATE_P12` (base64 of the Developer ID Application `.p12`)
- `MAC_CERTIFICATE_PASSWORD`
- `MAC_CSC_NAME`
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`

If any of these is missing, the build produces an **unsigned** DMG without notarization. This is the expected behavior for forks and CI debug runs. The release pipeline still works; the macOS DMG will trigger a Gatekeeper warning on first install.