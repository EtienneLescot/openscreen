import path from "node:path";
import { defineConfig } from "vitest/config";
import { DEFAULT_TURN_TIMEOUT_MS } from "./workbench/lib/harness";

// ponytail: separate from vitest.config.ts on purpose — `workbench/` is outside
// that config's include glob AND outside tsconfig.test.json's include, so the
// workbench never runs in `npm test` (no CI, no network) and never feeds the
// typecheck ratchet. Run it explicitly: `npm run wb`.
//
// Type coverage is NOT abandoned, it is moved: `npm run wb:typecheck` uses
// tsconfig.workbench.json. The fixtures here are hand-written documents, which
// is exactly the class of file that drifted out of the schema before
// tsconfig.test.json existed — they also go through `documentSchema.parse`.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["workbench/**/*.wb.ts"],
		// ponytail: derived from the harness cutoff, and deliberately ABOVE it. A
		// `.wb.ts` driving a live turn is cut by whichever deadline fires first;
		// this one used to sit at 120 s while the harness moved to 300 s, so vitest
		// killed the turn before the harness could classify it. Equal values would
		// only make that race unbiased — the margin is what guarantees the harness
		// wins and the run gets a TIMEOUT verdict instead of a dead worker.
		testTimeout: DEFAULT_TURN_TIMEOUT_MS + 30_000,
		reporters: ["default"],
		// ponytail: the fixed cost of the suite is `runChat`'s dynamic
		// `await import("./deep-agent/service")` — measured at ~1.25 s, of which
		// ~0.38 s is `langchain` itself and the rest is the agent graph, the tool
		// schemas and the document model behind them. It is paid ONCE PER WORKER,
		// and 7 of the 19 `.wb.ts` files reach that path, so isolating them would
		// re-pay it six more times. One non-isolated thread makes the marginal
		// cost of a new file its own runtime.
		//
		// (This used to name `deepagents`, which 0e53709a removed from the
		// dependencies. The cost survived the package: it was never that factory,
		// it was the graph underneath. Re-measure before trusting the figure —
		// `await import(…)` timed inside a `.wb.ts` is enough.)
		//
		// The trade this accepts: `sessionsByProject` (chat-service.ts:38) and
		// `messageCheckpointsBySession` (:50) are module Maps with no exported
		// reset, so state leaks between files. The harness mints a unique
		// projectId per run (`lib/harness.ts:239`), which is what makes that
		// safe — anything calling `runChat` directly would bypass the guard.
		pool: "threads",
		maxWorkers: 1,
		isolate: false,
		fileParallelism: false,
	},
	resolve: {
		alias: { "@": path.resolve(__dirname, "src") },
	},
});
