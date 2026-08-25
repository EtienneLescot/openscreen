import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		// `node`, not `jsdom`. Building a jsdom for every test file was the single
		// most expensive thing this suite did — 719s of cumulative environment setup
		// against 89s of actual test time — and only 37 of the 140 files need a DOM
		// at all. Those 37 opt back in with a `// @vitest-environment jsdom` docblock
		// on line 1, which is also the fix when a new test dies on `document is not
		// defined`. (`electron/media/audioPeaks.test.ts` already used the same
		// docblock the other way round, to escape the global jsdom; that one is now
		// redundant but harmless.)
		environment: "node",
		include: [
			"{src,electron,scripts,benchmark,.github}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
		],
		// Vitest's 5s default is too tight here and produces red runs that mean nothing.
		// Measured: with the machine loaded, 11 tests fail and 9 of them are purely
		// "Test timed out in 5000ms" — ordinary component tests that pass in 200ms on an
		// idle box. A single jsdom file needs ~9.5s just to boot React, so 5s of budget
		// is not a signal about the test. Raising this costs nothing on a passing run:
		// the timeout only ever fires on a test that was going to fail anyway.
		testTimeout: 15_000,
		// Everything else that looks like a speedup here was measured and is NOT one.
		// Full suite, same machine, back to back: 175s with jsdom everywhere, 81s with
		// the split above.
		//   * `--no-isolate`      ~20% faster, but it fails tests. Sharing one module
		//                         registry per worker breaks `vi.mock`, and 29 test
		//                         files rely on it (`@/native/client` alone is mocked
		//                         in 10 of them, differently each time). Not worth
		//                         making the suite's main mocking tool unsound.
		//   * `deps.optimizer.web` slower, not faster.
		//   * `--pool=threads`    >5min, killed. jsdom in worker threads is pathological.
		//   * `--maxWorkers=16`   inside the run-to-run noise on an 8-core box, and a
		//                         number that would be wrong on any other machine.
		// What is left is import cost: a jsdom file is ~9.5s alone, of which ~6.7s is
		// pulling in React + testing-library and ~1.9s is the DOM itself.
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
});
