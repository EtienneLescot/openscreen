// ponytail: Electron 28+ terminates on uncaughtException/unhandledRejection.
// Renderer reload / DevTools detach routinely produces EPIPE on in-flight
// IPC replies — churn, not a bug. Swallow the expected codes; re-throw the
// rest so genuine failures still kill the app.

const SWALLOWED_ERROR_CODES = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]);

export function shouldSwallowMainProcessError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && SWALLOWED_ERROR_CODES.has(code);
}

export function installMainProcessErrorGuards(): void {
	process.on("uncaughtException", (error) => {
		if (shouldSwallowMainProcessError(error)) {
			const e = error as NodeJS.ErrnoException;
			console.warn("[main] swallowed uncaughtException:", e.code, e.message);
			return;
		}
		console.error("[main] uncaughtException:", error);
		throw error;
	});
	process.on("unhandledRejection", (reason) => {
		if (shouldSwallowMainProcessError(reason)) {
			console.warn("[main] swallowed unhandledRejection:", (reason as NodeJS.ErrnoException).code);
			return;
		}
		console.error("[main] unhandledRejection:", reason);
		throw reason instanceof Error ? reason : new Error(String(reason));
	});
}
