# OpenScreen — Shared Team Memory

This file is the shared memory across all Mavis reins in this repo. Add durable facts here that the team should remember across sessions: build quirks, gotchas, environment-specific notes.

Format:
```
## <Topic> (<YYYY-MM-DD>)
<one-paragraph fact or gotcha>
```

---

## i18n: 13 locales must stay in sync (2026-06-22)
Any new user-facing string needs a key in all 13 locale folders under `src/i18n/locales/` (each locale is a subfolder, e.g. `src/i18n/locales/en/settings.json`). The `npm run i18n:check` script validates structural consistency. Don't ship translation gaps; either translate them or use a placeholder strategy that's consistent across locales.

## Native helpers need manual smoke tests (2026-06-22)
CI runs on Linux only. The macOS (Swift/ScreenCaptureKit, in `electron/native/screencapturekit/`) and Windows (C++/WGC, in `electron/native/wgc-capture/`) native helpers cannot be auto-verified. Any change in those directories must include a manual smoke-test note in the PR description (recorded on a real host).

## Biome owns lint AND format (2026-06-22)
There's no Prettier/ESLint — Biome 2.4 does both. Config in `biome.json`: tabs, double quotes, 100-col width, LF line endings. Don't add `eslint`/`prettier` configs on top; that would fight Biome.

## `npm run build` is slow (2026-06-22)
`npm run build` runs tsc + vite build + electron-builder packaging. For renderer-only iteration use `npm run build-vite` (tsc + vite only, no packaging). Only run the full `build` when verifying a release artifact.

## Release tag must point at the release branch, not main (2026-07-05)
On 2026-07-05 the original `promote.yml` did `git checkout main && git tag vX.Y.Z`, which captured the post-RC tip of `main` (23 commits after the RC cut) as the "stable" v1.6.0. The fix landed the same day: both `prerelease.yml` and `promote.yml` now use a frozen `release/vX.Y.Z` branch — one per stable version, named without the `-rc.N` suffix so both workflows resolve the same ref — and tag its tip, then dispatch `build.yml` pinned to that tag. See `.github/workflows/prerelease.yml` § Push RC tag and `.github/workflows/promote.yml` § Push stable tag. When reviewing release-related changes, **always verify the tag is being applied to the release branch tip, not to main.** The build.yml `release_tag` input is the SHA, not a branch name; if you set it to a tag the GitHub Release check will look for the source ref — pass the release branch name when smoke-testing without a tag.
