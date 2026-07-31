// ponytail: the executable. `cli.ts` is a module and must stay importable
// without side effects — it used to call `main()` at import time, which set
// `process.exitCode` from inside a Vitest worker and could mask a failing run.
// Everything runnable lives here; `wb:build` bundles this file.

import { main } from "./cli";

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
