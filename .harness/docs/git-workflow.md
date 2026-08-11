# Git Workflow for OpenScreen

Conventions for the Mavis reins when working in this repo.

## Branches

- Default branch: `main`. Never push to it directly.
- Feature branches: `feature/<short-kebab>` or `fix/<short-kebab>`. Match the style of recent merged PRs.
- One PR = one concern. Don't bundle a refactor with a feature.

## Commits

- Short imperative summary line (≤72 chars). Optional body explaining the why.
- Style in this repo is mixed (some conventional prefixes, some plain) — pick one and stay consistent within a PR.
- Husky pre-commit runs lint-staged (Biome on staged `*.{ts,tsx,js,jsx,mts,cts,json}`). Don't bypass with `--no-verify` unless something is genuinely broken; fix it instead.

## Hooks (Mavis)

- Pre-commit (`.harness/hooks/pre-commit.md`) — runs Biome + the affected unit test files. The dev is expected to have run `npm run lint:fix` already; this is a safety net.
- Post-commit (`.harness/hooks/post-commit.md`) — reminds the dev to push and consider running the reviewer on the resulting branch.

## CI (`.github/workflows/ci.yml`)

CI runs on every PR to `main`, `feat/ai-edition` and `release/**`, and on every push to those:
- `npm run lint` (Biome)
- `npx tsc --noEmit` (TypeScript, app code)
- `npx tsc -p tsconfig.test.json --noEmit` (TypeScript, test files — a separate gate at zero)
- `npm run test` (Vitest unit)
- `npm run docs:check`
- `npx vite build` (renderer build smoke)
- `cargo test` / `cargo check` for the compositor on macOS, Windows and Linux

All must be green before merge. Native helper code is NOT covered by CI — manual smoke test is required for `electron/*-helper/` changes; note it in the PR description.

## Pull request flow

1. Branch from `main`.
2. Implement + add tests in the same package.
3. While implementing, run only the affected tests (`npx vitest --run <path>` or `--changed`); `npx tsc --noEmit` and `npm run lint` are the cheap inner-loop checks. Run the full `npm run test` **once**, here, before pushing.
4. Push and open the PR via `gh pr create`. Use `.github/pull_request_template.md`.
5. Wait for the Mavis reviewer (`openscreen-reviewer`) PASS or address the requested changes.
6. Merge once CI is green and review is PASS. PR titles must follow Conventional Commits (enforced by the `semantic-pr` job in `ci.yml`) — this keeps the auto-generated release notes clean.

## Release flow

Two `workflow_dispatch` workflows cut a release. Trunk-based on `main`, but **release branches freeze the RC codebase between cut and promote** (see § Release branches below). Both require the `OPENSCREEN_RELEASE_TOKEN` secret — see `technical-documentation/engineering/release-and-secrets.md`.

### Step 1: cut a release candidate

`Actions` → `Cut a release candidate` → `Run workflow`.

- `bump`: `patch | minor | major` (default `minor`)
- `rc_number`: integer, default `1` (use `.2`, `.3`, … for subsequent RCs)
- `target_version` (optional): override the auto-computed next version (e.g. `2.0.0` when bumping straight to a major)

The workflow:

1. Computes the next SemVer from `package.json` + `bump`, builds `vX.Y.Z-rc.N`.
2. Migrates every issue/PR in the rolling `Next Release` milestone into a fresh `vX.Y.Z` milestone. Each migrated item gets a hidden marker comment so re-running is idempotent.
3. Creates `release/vX.Y.Z` (at rc.1) or reuses it (rc.2+), and commits `package.json` → `X.Y.Z-rc.N` there. **The branch is NOT merged into `main`** — it stays frozen, so the RC contains the cut snapshot plus cherry-picks only. The branch is named for the **stable** version, with no `-rc.N` suffix, because `promote.yml` has to resolve the same ref.
4. Pushes the tag `vX.Y.Z-rc.N` at the release branch tip, then **explicitly dispatches `build.yml` with `--ref` pinned to that tag**, which publishes a **GitHub pre-release** (badged as such, does not become "Latest"). Two reasons the dispatch is explicit and pinned: a `GITHUB_TOKEN` tag push does not fire `build.yml`'s `push:` trigger, and the build must check out the *tag* — `main` still carries the previous stable version and would fail the publish step's version guard. RC tags are signed and notarized like stable ones, so testers do not have to clear the quarantine attribute by hand.
5. Posts in `#rc-testing` on Discord with the download link.

Tier 3 (homebrew/winget/nix/aur) does **not** run on pre-releases — they're already gated on `!prerelease`.

### Step 2: announce and QA

Pin the pre-release link in `#rc-testing`. Get the maintainer team + a few early adopters to install and smoke-test.

**Between RC cut and promote**, the only thing that may happen on `release/vX.Y.Z` is **cherry-picks of bugfixes** that address problems discovered in the RC. Features, refactors, and CI/docs changes are **not** applied to the release branch — they live on `main` and ship in the next release cycle. `git log release/vX.Y.Z..main --oneline` lists exactly what is *not* in the RC.

If the RC has a regression, fix forward on `main`, then **cherry-pick the fix commit onto the release branch** with `git cherry-pick <sha>`, then re-cut as `vX.Y.Z-rc.(N+1)` (the rerun of `prerelease.yml` reuses the frozen branch and re-tags its tip; no rebase required). The previous RC is auto-superseded by GitHub.

### Step 3: promote to stable

`Actions` → `Promote RC to stable release` → `Run workflow`.

- `rc_tag`: e.g. `v1.5.0-rc.2`
- `release_notes_extra` (optional): a one-paragraph note that gets prepended to the auto-generated release notes

The workflow:

1. Validates the tag matches `^vX.Y.Z-(rc|beta|alpha)\.N$`.
2. Closes the `vX.Y.Z` milestone (snapshotting it for the release notes).
3. Checks out `release/vX.Y.Z` (the frozen branch), strips `-rc.N` from `package.json`, and commits the bump there. The stable tag points at this tip — the released code is the exact RC + cherry-picks.
4. Pushes the tag `vX.Y.Z` and dispatches `build.yml` pinned to that tag (full notarization). The `release: published` event fires Tier 3 (homebrew/winget/nix/aur) thanks to `OPENSCREEN_RELEASE_TOKEN`.
5. Opens a **release-sync PR** (e.g. `release/v1.6.0-sync → main`) that brings `main` into line with the released snapshot. Rebase-merged via PAT (EtienneLescot is a ruleset bypass actor).
6. Posts in `#announcements` on Discord with the release notes + a "Closed issues in this release" list pulled from the milestone.

The release branch itself **stays around** indefinitely — it is the frozen history of the release, useful for backports and forensics. Deletion happens only when a future major cuts over and supersedes it.

### Release branches (the contract)

Every released version has **exactly one frozen branch**, named for the stable version, living from the first RC cut onward:

```
release/vX.Y.Z         created at rc.1, frozen through promote, kept for backports
release/vX.Y.Z-sync    ephemeral, created by promote to merge into main
```

The name carries **no `-rc.N` suffix**. `prerelease.yml` and `promote.yml` must resolve the same ref, and every RC of a version re-cuts from this one branch.

Key rules:

1. **`prerelease.yml` creates the branch at rc.1 and reuses it for later RCs.** It must never delete or recreate it: that would drop the cherry-picks and silently re-cut from `main`, which defeats the freeze this contract exists to guarantee.
2. **`promote.yml` is the only automated writer** that turns `-rc.N` into the stable version on the branch. A maintainer doing that by hand means the dispatch failed — see § Manual fallback.
3. **`main` is never frozen.** Develop as usual. The release branch is the freeze.
4. **Cherry-picks during the RC window** are committed manually by a maintainer (`git checkout release/vX.Y.Z && git cherry-pick <sha>`), then rerun `prerelease.yml` with the next `rc_number` to re-tag the branch tip.

This exists because of the v1.6.0 incident (2026-07-05): the original `promote.yml` checked out `main`, so the stable tag captured the post-RC tip of `main` rather than the RC snapshot. Twenty-three commits (Tiptap, NotesWindow, an in-recorder lint button, AI handoff) ended up in v1.6.0 without ever being in v1.6.0-rc.1. The re-release of v1.6.0 on 2026-07-05 used `release/v1.6.0` and cherry-picked only the truly safe commits.

### Manual fallback (emergency)

If the dispatch UI is unavailable, the workflow still works from a shell:

Use `set-release-version.mjs`, not a hand-rolled `sed`: it writes the version to **`package-lock.json` too**, and a release commit that bumps only `package.json` ships a lockfile disagreeing with the package it locks (`npm ci` never catches it).

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

A tag pushed manually with your own credentials **does** fire `build.yml`'s `push:` trigger, so the release publishes on its own. (The workflows push tags with `GITHUB_TOKEN`, which does *not* fire it — that's why they dispatch `build.yml` explicitly.) Either way the same `build.yml` builds and publishes.

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
