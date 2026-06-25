// ponytail: forward console.warn/error/log from the renderer to the main
// process so the diagnostic lines in `src/hooks/recorderHandle.ts` (and any
// other renderer-side logging) show up in `npm run dev` output. Without
// this, the renderer's `console.*` only goes to DevTools.
//
// Safe to ship: one-way, no backpressure, no return value. Silently no-ops
// if the preload bridge isn't available (e.g. unit tests in jsdom).

const api = (
	typeof window !== "undefined"
		? (
				window as {
					electronAPI?: {
						rendererConsole?: (channel: "log" | "warn" | "error", args: unknown[]) => void;
					};
				}
			).electronAPI
		: undefined
)?.rendererConsole;

if (api) {
	const wrap = (channel: "log" | "warn" | "error") => {
		const original = console[channel].bind(console);
		console[channel] = (...args: unknown[]) => {
			try {
				api(channel, args);
			} catch {
				// ponytail: never let the forwarder break the caller's logging.
			}
			original(...args);
		};
	};
	wrap("log");
	wrap("warn");
	wrap("error");
}

export {};
