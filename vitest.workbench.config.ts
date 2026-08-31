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
		// this one sat at a hardcoded 120 s while the harness moved to 300 s, so
		// vitest killed the turn before `runTurn` could classify it — a dead worker
		// where the run should have recorded a TIMEOUT verdict. Equal values would
		// only make the race unbiased; the margin is what guarantees the harness
		// wins.
		testTimeout: DEFAULT_TURN_TIMEOUT_MS + 30_000,
		reporters: ["default"],
		// ponytail: the fixed cost of the suite is the dynamic
		// `await import("./deep-agent/service")` in chat-service.ts:398 — the agent
		// graph, the tool schemas and the document model behind them, paid ONCE PER
		// WORKER. One non-isolated thread makes the marginal cost of a new file its
		// own runtime.
		//
		// (This used to name `deepagents`, a package the tree no longer depends on.
		// The cost survived the package: it was never that factory, it was the graph
		// underneath. Re-measure before trusting any figure for it — `await
		// import(…)` timed inside a `.wb.ts` is enough.)
		//
		// The trade this accepts: `sessionsByProject` (chat-service.ts:38) and
		// `messageCheckpointsBySession` (:50) are module Maps with no exported
		// reset, so state leaks between files. The harness mints a unique projectId
		// per run (`lib/harness.ts:239`), which is what makes that safe — anything
		// calling `runChat` directly would bypass the guard.
		pool: "threads",
		maxWorkers: 1,
		isolate: false,
		fileParallelism: false,
	},
	resolve: {
		alias: { "@": path.resolve(__dirname, "src") },
	},
});
