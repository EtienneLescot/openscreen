import path from "node:path";
import { defineConfig } from "vitest/config";

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
		testTimeout: 120_000,
		reporters: ["default"],
		// ponytail: the fixed cost of the suite is the dynamic
		// `await import("deepagents")` in chat-service.ts:346 — hundreds of
		// milliseconds, paid ONCE PER WORKER. One non-isolated thread makes the
		// marginal cost of a new file its own runtime.
		//
		// The trade this accepts: `sessionsByProject` (chat-service.ts:36) and
		// `messageCheckpointsBySession` (:48) are module Maps with no exported
		// reset, so state now leaks between files. `runScenario` mints a unique
		// projectId per run, which is what makes that safe — anything calling
		// `runChat` directly would bypass the guard.
		pool: "threads",
		maxWorkers: 1,
		isolate: false,
		fileParallelism: false,
	},
	resolve: {
		alias: { "@": path.resolve(__dirname, "src") },
	},
});
