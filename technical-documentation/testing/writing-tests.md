# Writing Tests

This project uses Vitest for unit/integration tests, plus Playwright for desktop end-to-end coverage.

## Test types at a glance

| Test type | Config | What it is for | Run it |
|---|---|---|---|
| Unit | `vitest.config.ts` | Logic, data transformations, React behavior, and integrations that do not require real browser media/graphics APIs. | `npx vitest --run <path>` while working, `npm run test` once at the end |
| End-to-end / Playwright | `playwright.config.ts` | Full workflows under `tests/e2e`, including Electron/native integration checklists and export flows. | `npm run test:e2e` |

> There used to be a third tier — "browser tests" in real headless Chromium via
> `vitest.browser.config.ts` and `npm run test:browser`, for `VideoDecoder`,
> `MediaRecorder`, `OffscreenCanvas` and WebGL. **It no longer exists**: no config, no
> script, no `*.browser.test.ts` file, and no CI job. Real-codec and real-GPU behavior is
> covered instead by the Rust compositor's own `cargo test` suites (`crates/`, run by the
> three `rust-*-compositor-check` CI jobs) and by the manual checklist below.

## Unit tests

**Config:** `vitest.config.ts`  
**Runs in:** Node by default; jsdom only for files that ask for it  
**File pattern:** `{src,electron,.github}/**/*.test.{ts,tsx}`  
**CI command:** `npm run test`

Use unit tests for pure logic, utility functions, data transformations, and React behavior.

### Environment: node by default, jsdom on request

Building a jsdom for a test that never touches the DOM was this suite's single largest
cost — 719s of cumulative environment setup against 89s of actual test time. So
`vitest.config.ts` sets `environment: "node"`, and the 37 files that genuinely need a DOM
opt in with a docblock on line 1:

```ts
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
```

That is also the fix when a new test dies on `document is not defined` or
`ReferenceError: window is not defined`. Every `*.test.tsx` needs it; a `*.test.ts` needs
it only if it renders a component, uses `renderHook`, or reaches for a browser global.

### Platform-conditional code

CI runs on Linux only. A test covering a `process.platform`-gated path must pin the
platform itself, or it passes vacuously in CI and fails on every Windows and macOS
machine. `electron/recording/webm-seek-index.test.ts` sets `process.platform` in
`beforeEach` and restores it in `afterEach` — copy that shape.

### File placement

Co-locate the test file next to the source file, or put it in a `__tests__/` folder in the same directory.

```
src/lib/compositeLayout.ts
src/lib/compositeLayout.test.ts        # co-located

src/i18n/__tests__/tutorialHelpTranslations.test.ts  # grouped
```

### Example

```ts
import { describe, expect, it } from "vitest";
import { computeCompositeLayout } from "./compositeLayout";

describe("computeCompositeLayout", () => {
  it("anchors the overlay in the lower-right corner", () => {
    const layout = computeCompositeLayout({
      canvasSize: { width: 1920, height: 1080 },
      screenSize: { width: 1920, height: 1080 },
      webcamSize: { width: 1280, height: 720 },
    });

    expect(layout).not.toBeNull();
    expect(layout!.webcamRect!.x).toBeGreaterThan(1920 / 2);
    expect(layout!.webcamRect!.y).toBeGreaterThan(1080 / 2);
  });
});
```

### Path aliases

The `@/` alias resolves to `src/`. Use it for imports that would otherwise need long relative paths.

```ts
import { SUPPORTED_LOCALES } from "@/i18n/config";
```

### Running locally

The full run is ~1670 tests over 140 files and takes over a minute. Run it once, at the end of a
task — not after each edit.

```bash
npx vitest --run src/lib/foo.test.ts   # one file, while you work (1-10s)
npx vitest --run src/lib/ai-edition    # one directory
npm run test:changed                   # only what the working tree touches
npx vitest --run --changed main        # only what the branch diff touches
npm run test                           # everything (~80s), once, before committing
```

`npm run test:watch` never terminates — don't start it from a script or an agent session.

---

## Choosing the right type

| Situation | Use |
|---|---|
| Pure function / data transformation | Unit test (node) |
| i18n key coverage | Unit test (node) |
| React component or hook behavior | Unit test + `// @vitest-environment jsdom` |
| `VideoDecoder` / `VideoEncoder` / real codecs | Rust test in `crates/`, or the manual checklist |
| WebGL / Pixi.js / GPU rendering | Rust test in `crates/`, or the manual checklist |
| A full export producing a real file | `tests/e2e/`, or the manual checklist |

Automated suites do not exercise every hardware, permission, codec, signing, and packaged-app combination. Use the [manual end-to-end checklist](manual-e2e-checklist.md) for those release and platform checks.
