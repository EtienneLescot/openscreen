# Release and secrets

OpenScreen's release machinery lives in `.github/workflows/prerelease.yml`, `promote.yml`, and `build.yml`; its credentials are repository secrets and variables consumed by those workflows and the downstream package and Discord automations. This page is the operational reference for cutting releases and maintaining those credentials.

## Release flow

### Cut a release candidate

Run the `Cut a release candidate` workflow (`prerelease.yml`) with:

- `bump`: `patch`, `minor`, or `major`; default `minor`.
- `rc_number`: the numeric `rc.N` counter; default `1`.
- `target_version`: optional stable-version override such as `2.0.0`.

The workflow computes `X.Y.Z-rc.N`, migrates items from `Next Release` to the `vX.Y.Z` milestone, creates or reuses `release/vX.Y.Z`, commits the prerelease version there, tags the frozen branch tip, explicitly dispatches `build.yml` at the RC tag, and announces the pre-release in the configured RC Discord channel.

`build.yml` does have a `push:` trigger on `v*` tags, but the release workflows do not rely on it. The dispatch is explicit *and* pinned to the tag, for two separate reasons:

- **Explicit**, because a tag pushed with `GITHUB_TOKEN` does not fire `build.yml`'s `push:` trigger in this org's setup — GitHub withholds that to stop workflows triggering each other in a loop. `promote.yml` does push the stable tag that way, so without the dispatch nothing would build.
- **Pinned with `--ref`**, because the build must check out the **tag**, not the default branch. The version bump lives only on the release branch; `main` still carries the previous stable version, and `build.yml`'s publish step would fail its guard (`package.json version X does not match <tag>`).

The two workflows push their tags with different credentials, which is deliberate: `promote.yml` uses `GITHUB_TOKEN` (a tag is a ref, not a file change), while `prerelease.yml` pushes the RC tag with `OPENSCREEN_RELEASE_TOKEN`. A `GITHUB_TOKEN` tag push is answered with `remote: Internal Server Error` — a 500, not a 403 — by a tag ruleset that rejects the Actions token, and that failure took down the whole `v1.8.0-rc.1` cut, skipping the build trigger and the Discord announce with it.

RC tags are signed and notarized exactly like stable ones. That keeps testers out of `xattr -rd com.apple.quarantine`, and exercises the whole credential path on every candidate instead of first proving it on the promotion build.

### Promote to stable

Run `Promote RC to stable release` (`promote.yml`) with:

- `rc_tag`: required tag matching `vX.Y.Z-(rc|beta|alpha).N`.
- `release_notes_extra`: optional text prepended to the stable Discord announcement.

The workflow validates the tag, closes the version milestone, checks out `release/vX.Y.Z`, changes `package.json` to the stable version, tags that branch tip, opens and rebase-merges a release-sync PR into `main`, explicitly dispatches `build.yml` at the stable tag, and announces the stable release. The build publishes signed/notarized artifacts when Apple credentials are complete; publication with `OPENSCREEN_RELEASE_TOKEN` emits the event that starts stable Homebrew, WinGet, Nix, and AUR workflows.

### Release branches (the contract)

Every released version has **exactly one frozen branch**, named for the stable version, living from the first RC cut onward:

```text
release/vX.Y.Z         created at rc.1, frozen through promote, kept for backports
release/vX.Y.Z-sync    ephemeral, created by promote to merge into main
```

The name carries **no `-rc.N` suffix**. `prerelease.yml` and `promote.yml` must resolve the same ref, and every RC of a version re-cuts from this one branch.

1. **`prerelease.yml` creates the branch at rc.1 and reuses it for later RCs.** It must never delete or recreate it: that would drop the cherry-picks and silently re-cut from `main`, defeating the freeze this contract exists to guarantee.
2. **`promote.yml` is the only automated writer** that turns `-rc.N` into the stable version on the branch. A maintainer doing that by hand means the dispatch failed — see [Manual fallback](#manual-fallback).
3. **`main` is never frozen.** Development continues as usual; the release branch is the freeze.
4. **Cherry-picks during the RC window** are committed manually by a maintainer (`git checkout release/vX.Y.Z && git cherry-pick <sha>`), then rerun `prerelease.yml` with the next `rc_number` to re-tag the branch tip.

Only cherry-picked bug fixes land on the branch between cut and promote. Features, refactors, and CI/docs changes are **not** applied — they live on `main` and ship in the next cycle. `git log release/vX.Y.Z..main --oneline` lists exactly what is *not* in the RC.

The branch **stays around** indefinitely: it is the frozen history of the release, useful for backports and forensics. Retiring one is a manual decision, taken only once a future major supersedes the line it froze.

This contract exists because of the **v1.6.0 incident (2026-07-05)**: the original `promote.yml` checked out `main`, so the stable tag captured the post-RC tip of `main` rather than the RC snapshot. Twenty-three commits (Tiptap, NotesWindow, an in-recorder lint button, AI handoff) shipped in v1.6.0 without ever having been in v1.6.0-rc.1. The re-release the same day used `release/v1.6.0` and cherry-picked only the commits that were genuinely safe.

Day-to-day branching, PR, and review procedure is maintained in [the operational git workflow](../../.harness/docs/git-workflow.md).

### Manual fallback

When the dispatch UI is unavailable, the release can be cut from a shell. Set the version with `.github/scripts/set-release-version.mjs` — the same script both workflows call — and **never with a hand-rolled `sed` on `package.json`**: the script also writes `package-lock.json`, and a release commit that bumps only `package.json` ships a lockfile whose root version disagrees with the package it locks. `npm ci` does not reject that (the root `version` field is not a dependency, so the sync check ignores it), which is how three releases shipped with the mismatch before anyone noticed.

```bash
RC=1.5.0-rc.1                          # bump the rc.N for every later candidate

# Cut RC (skips milestone migration and Discord announce)
git checkout -b release/v1.5.0 main    # rc.2+: git checkout release/v1.5.0 instead
node .github/scripts/set-release-version.mjs "$RC"
git commit -am "chore(release): bump to $RC [skip ci]"
git push origin release/v1.5.0
git tag "v$RC" && git push origin "v$RC"

# Promote (skips milestone close and Discord announce)
git checkout release/v1.5.0
node .github/scripts/set-release-version.mjs 1.5.0
git commit -am "chore(release): bump to 1.5.0 [skip ci]"
git push origin release/v1.5.0
git tag v1.5.0 && git push origin v1.5.0
```

A tag pushed with your own credentials **does** fire `build.yml`'s `push:` trigger, so the release publishes on its own and no explicit dispatch is needed — that restriction only applies to `GITHUB_TOKEN`. Either way the same `build.yml` builds and publishes.

The fallback skips milestone migration/closure, release-branch automation, main synchronization, and Discord announcements, so the operator must preserve the freeze and the version/tag match by hand.

### Backports / patch on a previous line

For a `v1.4.2` while `v1.5.0` is in flight:

1. Branch `release/1.4.x` from the `v1.4.0` (or `v1.4.1`) tag.
2. Cherry-pick the fix commits.
3. Push the branch, then `git tag v1.4.2-rc.1` on the branch tip.
4. `git push origin release/1.4.x v1.4.2-rc.1` — `build.yml` works from any branch.

No new workflow code is needed; the tag-pushed trigger is branch-agnostic.

### Issue tracking during a release cycle

- **Daily state**: issues/PRs accumulate in the rolling `Next Release` milestone. `merged-pr-bookkeeping.yml` adds them automatically on PR merge; maintainers can also drag issues in by hand.
- **At RC cut**: `prerelease.yml` snapshots `Next Release` into a versioned `vX.Y.Z` milestone. The rolling milestone is left open and empty for new work.
- **Between RC cut and promote**: any PR that merges during the RC window lands back in the empty `Next Release`. It is **not** retroactively added to `vX.Y.Z`. If a critical fix lands, cut `vX.Y.Z-rc.(N+1)` instead of promoting.
- **At promote**: `promote.yml` closes the `vX.Y.Z` milestone and uses its closed issues to populate the Discord release announcement.

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

## Microsoft Store publishing

`build.yml`'s `publish-msstore` job submits the appx to the Store through the [Microsoft Store Developer CLI](https://learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/github-actions). It runs for **stable versions only**, whether that comes from a pushed `vX.Y.Z` tag or from a manual `workflow_dispatch` whose `release_tag` is a stable one. An RC is excluded either way: it would go through certification and land on every user's machine as an automatic update.

| Name | Kind | Purpose |
|---|---|---|
| `MSSTORE_PRODUCT_ID` | Variable | Store product ID (`9MXQ1HQJL5G5`). Gates the whole job, so a fork never publishes to our listing. |
| `AZURE_AD_TENANT_ID` | Secret | Entra tenant associated with the Partner Center account. |
| `AZURE_AD_APPLICATION_CLIENT_ID` | Secret | Application (client) ID of the Entra app registration. |
| `AZURE_AD_APPLICATION_SECRET` | Secret | Client secret of that registration. The only real credential here. |
| `SELLER_ID` | Secret | Publisher/Seller ID from Partner Center account settings. |

With none of them set the job warns and skips, leaving the appx to be uploaded by hand from the run's artifacts; with some but not all it fails, on the same reasoning as the Apple path.

One-time setup, in order — each step depends on the previous one:

1. Associate an Entra tenant with the Partner Center account.
2. Register an application in Entra ID and create a client secret for it.
3. In Partner Center, under **Account settings → User management → Microsoft Entra applications**, add that application and give it the **Manager** role. Tenant and client IDs alone are not enough; the failure is an authorization error at submit time.
4. Set the four secrets and the variable.

Note what this does and does not remove. It removes the manual upload — which is worth having in itself: 1.8.0 ended up with two different packages under one version because the artifact was downloaded twice and both copies uploaded, and Partner Center rejects that outright. It does **not** remove certification: every submission still waits for Microsoft to validate it, and the update only goes live afterwards.

Two constraints from Microsoft's documentation: automated updates through GitHub Actions are supported **for free products only**, and the app must already be published and live in the Store — the API cannot create a listing, only submit to an existing one.

`msstore submission updateMetadata` can also drive the Store listing text from a versioned `metadata.json`, which would replace the CSV export/import round-trip. Not wired up here.

Rotate by issuing a new client secret on the Entra registration, updating `AZURE_AD_APPLICATION_SECRET`, publishing one release to confirm, then deleting the old secret. The tenant, client and seller IDs change only when the registration or account does.

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

**Homebrew publishing does not complete yet, and now says so.** `update-homebrew-cask.yml` has never published a cask — not once since it was written for the v1.5.0 pipeline. Neither `HOMEBREW_TAP_OWNER` nor `HOMEBREW_TAP_REPO` has ever existed on this repository, both sat in the job-level `if`, and an unconfigured job resolves to `skipped`, which is green: every release run reads as a success. The same failure as WinGet below, found the same way and fixed the same way — the configuration test now lives in a step that names what is missing (#335). Three things are needed, and the third is the one a variable cannot supply: `HOMEBREW_TAP_OWNER` and `HOMEBREW_TAP_REPO`; the `HOMEBREW_TAP_TOKEN` secret with contents write on that repository; and the tap repository itself, which **must** be named `homebrew-<something>` — that prefix is how `brew tap` resolves a repository at all, so `getopenscreen/openscreen-tap` would be checked out and pushed to successfully and still be untappable. With `getopenscreen/homebrew-openscreen`, the install command is `brew install --cask getopenscreen/openscreen/openscreen`.

Note what it would publish before turning it on: the two DMGs attached to the release — signed, notarized and stapled when the Apple credentials above are complete, ad-hoc-signed and un-notarized when they are not. A cask does not change either state, because `brew install --cask` runs the same Gatekeeper path as a manual download: on the ad-hoc artifact users still need the `xattr -rd com.apple.quarantine` step the README documents. What the tap buys is discovery and `brew upgrade`, not trust.

**WinGet publishing does not complete yet, and now says so.** `publish-winget.yml` starts on every stable release; whether it publishes depends on four prerequisites, and it names the missing ones in a `::warning::` instead of passing quietly. It used to pass quietly: the configuration test sat in the job-level `if`, an unconfigured job resolved to `skipped`, and a skipped job is green — so eight releases in a row reported success while publishing nothing, which is how #148 stayed open without anyone noticing. The four are: `WINGET_IDENTIFIER` (set, `OpenScreen.OpenScreen`); `WINGET_ACC_TOKEN` (absent — it must be a *classic* PAT with `public_repo`, since `winget-releaser` does not support fine-grained ones); a fork of `microsoft/winget-pkgs` under `getopenscreen`, which is where the action pushes its branch; and at least one version of the package already merged into `winget-pkgs`, because the action writes each manifest from the previous one and refuses to author the first. That first submission is manual, via `wingetcreate new`.

Note what it would publish before turning it on: `winget-releaser` submits the **NSIS `.exe`** attached to the release to the community repository, and that installer is unsigned. Users who install through the Microsoft Store, or through `winget --source msstore`, get the Store package that Microsoft signs during certification instead. Publishing to the community source therefore adds a second, unsigned route alongside the signed one — worth doing deliberately rather than by flipping a variable.

## Automatic `GITHUB_TOKEN`

GitHub supplies `GITHUB_TOKEN` per run. Workflows use it for semantic PR validation, release-asset reads, issue bookkeeping, and the Nix bump PR. Its scopes come from each workflow's `permissions` block and it is not manually created or rotated. Do not replace it with a PAT unless cross-workflow triggering or external-repository access is actually required.

## Secret-handling rules

- Store credentials as repository or environment secrets, never repository variables or committed files.
- Keep non-sensitive channel IDs, package IDs, repository names, and known-host material in variables.
- Scope tokens to the single repository or external package destination they need.
- Rotate before expiry and verify the replacement before revoking the previous credential.
- Treat workflow logs and manual shell commands as public: pass values through secret inputs/environment variables and never echo them.
