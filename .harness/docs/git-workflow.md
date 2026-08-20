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

Releases are cut by two `workflow_dispatch` workflows (`prerelease.yml`, then `promote.yml`). Trunk-based on `main`, but **a release branch freezes the RC codebase between cut and promote**.

The operational reference — workflow inputs, the release-branch contract, cherry-pick rules, the manual fallback, backports, milestone handling and the credentials — is `technical-documentation/engineering/release-and-secrets.md`. Read it before touching a release; do not restate it here, because the copy that lives outside the docs checker is the one that goes stale.
