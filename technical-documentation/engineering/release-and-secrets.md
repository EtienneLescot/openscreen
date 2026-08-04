# Release and secrets

OpenScreen's release machinery lives in `.github/workflows/prerelease.yml`, `promote.yml`, and `build.yml`; its credentials are repository secrets and variables consumed by those workflows and the downstream package and Discord automations. This page is the operational reference for cutting releases and maintaining those credentials.

## Release flow

### Cut a release candidate

Run the `Cut a release candidate` workflow (`prerelease.yml`) with:

- `bump`: `patch`, `minor`, or `major`; default `minor`.
- `rc_number`: the numeric `rc.N` counter; default `1`.
- `target_version`: optional stable-version override such as `2.0.0`.

The workflow computes `X.Y.Z-rc.N`, migrates items from `Next Release` to the `vX.Y.Z` milestone, creates or reuses `release/vX.Y.Z`, commits the prerelease version there, tags the frozen branch tip, explicitly dispatches `build.yml` at the RC tag, and announces the pre-release in the configured RC Discord channel.

### Promote to stable

Run `Promote RC to stable release` (`promote.yml`) with:

- `rc_tag`: required tag matching `vX.Y.Z-(rc|beta|alpha).N`.
- `release_notes_extra`: optional text prepended to the stable Discord announcement.

The workflow validates the tag, closes the version milestone, checks out `release/vX.Y.Z`, changes `package.json` to the stable version, tags that branch tip, opens and rebase-merges a release-sync PR into `main`, explicitly dispatches `build.yml` at the stable tag, and announces the stable release. The build publishes signed/notarized artifacts when Apple credentials are complete; publication with `OPENSCREEN_RELEASE_TOKEN` emits the event that starts stable Homebrew, WinGet, Nix, and AUR workflows.

### Release-branch freeze rule

An RC cut creates `release/vX.Y.Z`. That branch is not merged into `main` until the stable tag is published, and only cherry-picked RC bug fixes land on it during the RC window. Subsequent RCs reuse the same branch. This rule exists because a promote workflow once tagged `main` instead of the tested RC snapshot and shipped unreleased commits.

Development continues on `main`; the freeze applies to the release branch. Day-to-day branching, PR, review, and cherry-pick procedure is maintained in [the operational git workflow](../../.harness/docs/git-workflow.md).

### Manual tag fallback

When the dispatch UI is unavailable, prepare the correct prerelease or stable `package.json` commit on the frozen release branch, then push the tag at that exact commit:

```bash
git tag v1.8.0-rc.1 <release-branch-sha>
git push origin v1.8.0-rc.1

# After QA and the stable version commit on the same release branch:
git tag v1.8.0 <stable-release-branch-sha>
git push origin v1.8.0
```

Any `v*` tag triggers `build.yml`. The fallback skips milestone migration/closure, release-branch automation, explicit build dispatch, main synchronization, and Discord announcements, so the operator must preserve the freeze and version/tag match manually.

## Required release credential

### `OPENSCREEN_RELEASE_TOKEN`

This fine-grained personal access token is used by `prerelease.yml`, `promote.yml`, and `build.yml`. It migrates and closes issues/milestones, pushes release branches, creates and merges the release-sync PR, dispatches `build.yml`, and creates GitHub releases so `release: published` can start downstream workflows. The automatic `GITHUB_TOKEN` cannot reliably trigger those subsequent workflows.

Grant the token access only to the OpenScreen repository with:

- Contents: read and write.
- Issues: read and write.
- Pull requests: read and write.
- Actions: read and write, for explicit build dispatch.
- Workflows: read and write, because the pushed release branch contains `.github/workflows/`.
- Metadata: read-only.

Create a fine-grained token from GitHub settings, set a finite expiry, and save it as the repository secret `OPENSCREEN_RELEASE_TOKEN`:

```bash
gh secret set OPENSCREEN_RELEASE_TOKEN --body "<token>" --repo getopenscreen/openscreen
```

Rotate it by creating the replacement with the same repository and scopes, updating the secret, verifying a non-destructive workflow/API operation, then revoking the old token. Do not revoke the previous token until the replacement is installed.

The repository's main-branch ruleset must also permit the configured maintainer/PAT flow to rebase-merge the release-sync PR with `--admin`; that bypass is repository configuration rather than a secret.

## Apple signing and notarization

`build.yml` enables signing only when all of these secrets are present:

| Secret | Purpose |
|---|---|
| `MAC_CERTIFICATE_P12` | Base64-encoded Developer ID Application certificate and private key imported into a temporary keychain. |
| `MAC_CERTIFICATE_PASSWORD` | Password protecting the P12 archive. |
| `MAC_CSC_NAME` | Signing identity passed to electron-builder and `codesign`. |
| `APPLE_ID` | Apple account used by `notarytool`. |
| `APPLE_TEAM_ID` | Apple Developer team identifier. |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password used by `notarytool`. |

The certificate account needs Developer ID signing capability, and the Apple account/app-specific password must be able to submit notarization requests for the team. Every tag signs the DMG, notarizes, staples, and validates it, pre-releases included — that keeps RC testers out of `xattr -rd com.apple.quarantine`, and exercises the whole credential path on each candidate instead of first proving it on the promotion build. If any value is missing, the macOS job falls back to an ad-hoc signature and still creates a DMG.

Rotate the certificate by exporting a replacement P12, base64-encoding it without line-wrap changes, updating the P12/password/name secrets together, testing a stable-format manual build, then revoking the old certificate if required. Rotate the app-specific password in Apple ID settings, replace `APPLE_APP_SPECIFIC_PASSWORD`, verify notarization, and revoke the old password. `APPLE_ID` and `APPLE_TEAM_ID` normally change only when the owning account or team changes.

## Discord secrets and variables

| Name | Kind | Used for |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Secret | RC/stable announcements, PR forum sync, roadmap sync, and weekly leaderboard posts. |
| `DISCORD_REVIEWER_ROLE_ID` | Secret | Role mention used by PR-to-Discord synchronization. |
| `DISCORD_RC_TESTING_CHANNEL_ID` | Variable | RC announcement destination. |
| `DISCORD_RELEASE_CHANNEL_ID` | Variable | Stable announcement destination. |
| `DISCORD_PR_FORUM_CHANNEL_ID` | Variable | Forum that receives PR threads. |
| `DISCORD_ALERT_CHANNEL_ID` | Variable | Optional alert destination for PR sync failures. |
| `DISCORD_ROADMAP_CHANNEL_ID` | Variable | Channel containing the synchronized roadmap message. |
| `DISCORD_ROADMAP_MESSAGE_ID` | Variable | Optional explicit message override; pin discovery is otherwise used. |
| `DISCORD_SPOTLIGHT_CHANNEL_ID` | Variable | Weekly leaderboard destination. |

The bot token comes from a Discord application authorized with the `bot` scope. Grant only the channel permissions each automation needs: View Channel, Send Messages, Embed Links, Create Public Threads and Send Messages in Threads for forum use, Manage Threads for forum state, and Manage Messages when roadmap pinning is required. Rotate by resetting the bot token in the Discord developer portal, updating `DISCORD_BOT_TOKEN`, testing a non-release post/sync, then invalidating the old token automatically through the reset. Channel and role IDs are identifiers rather than credentials; update their repository variable/secret when channels or roles are replaced.

## Package registry credentials and variables

| Name | Kind | Required access and use | Rotation |
|---|---|---|---|
| `HOMEBREW_TAP_TOKEN` | Secret | Token accepted by checkout/push for the repository named by `HOMEBREW_TAP_OWNER` and `HOMEBREW_TAP_REPO`; contents write is sufficient for a dedicated tap. | Create a replacement, update the secret, manually dispatch `update-homebrew-cask.yml`, then revoke the old token. |
| `HOMEBREW_TAP_OWNER` | Variable | Owner of the tap repository. | Update when the tap moves. |
| `HOMEBREW_TAP_REPO` | Variable | Tap repository name. | Update when the tap moves. |
| `HOMEBREW_CASK_NAME` | Variable | Cask filename/name; defaults to `openscreen` when unset. | Update with the tap's cask rename. |
| `WINGET_ACC_TOKEN` | Secret | Token consumed by `winget-releaser` to submit to the WinGet community repository; grant the scopes required by that action's upstream submission account and no unrelated repository access. | Replace the token, update the secret, replay `publish-winget.yml` for a stable tag, then revoke the old token. |
| `WINGET_IDENTIFIER` | Variable | Package identifier passed to the WinGet action. | Update only if the Store/community identifier changes. |
| `AUR_SSH_PRIVATE_KEY` | Secret | Private SSH key whose public key is authorized for the configured AUR package repository. | Add a replacement public key to AUR, update the private-key secret, manually dispatch and verify, then remove the old AUR key. |
| `AUR_KNOWN_HOSTS` | Variable | Pinned `aur.archlinux.org` host-key lines; required because strict host checking is enabled. | Replace only after independently verifying an AUR host-key change. |
| `AUR_PACKAGE_NAME` | Variable | AUR repository/package name and workflow gate. | Update if the package is renamed. |

`bump-nix-package.yml` uses the workflow-scoped `GITHUB_TOKEN`; it requires repository contents and pull-request write permissions as declared in the workflow and has no additional long-lived secret.

## Automatic `GITHUB_TOKEN`

GitHub supplies `GITHUB_TOKEN` per run. Workflows use it for semantic PR validation, release-asset reads, issue bookkeeping, and the Nix bump PR. Its scopes come from each workflow's `permissions` block and it is not manually created or rotated. Do not replace it with a PAT unless cross-workflow triggering or external-repository access is actually required.

## Secret-handling rules

- Store credentials as repository or environment secrets, never repository variables or committed files.
- Keep non-sensitive channel IDs, package IDs, repository names, and known-host material in variables.
- Scope tokens to the single repository or external package destination they need.
- Rotate before expiry and verify the replacement before revoking the previous credential.
- Treat workflow logs and manual shell commands as public: pass values through secret inputs/environment variables and never echo them.
