import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

/**
 * Reading macOS' Screen Recording grant from a short-lived child process.
 *
 * `CGPreflightScreenCaptureAccess()` caches its answer for the life of the process
 * that calls it. Once it has answered false it answers false forever, whatever the
 * user does in System Settings afterwards -- Apple's own guidance is to relaunch.
 * Electron's `systemPreferences.getMediaAccessStatus("screen")` is that same
 * function (Chromium's `IsScreenCaptureAllowed()` in `ui/base/cocoa/permissions_utils.mm`),
 * so the app's main process holds one stale bool for its entire run.
 *
 * That is the whole reason this module exists. The helper is spawned fresh for every
 * read, so every read is the current answer, and a grant the user makes while the app
 * is running becomes observable without a restart.
 *
 * The prompt is NOT raised here. It stays in the main process, where Chromium raises
 * it through the app bundle, so TCC records the grant against the app's designated
 * requirement rather than against a bare child binary.
 */

const HELPER_NAME = "openscreen-screencapturekit-helper";

/** Kept in step with `screenAccessStatusFlag` in ScreenCaptureRecorder.swift. */
const SCREEN_ACCESS_STATUS_FLAG = "--screen-access-status";

/**
 * The helper prints one line and exits, so this bounds a hung spawn rather than a
 * slow answer. Shorter than the cursor helper's budget because nothing here waits
 * on a window server handshake.
 */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Why `denied` is the only status that means "the user said no".
 *
 * The other four mean the helper never got to answer -- absent from the build, killed
 * by the loader, crashed, or hung. Treating those as a refusal is what would put the
 * "grant Screen Recording" dialog in front of a user whose permission is fine, which is
 * the same failure the cursor helper's `missing-helper` split exists to prevent (#515).
 */
export type MacScreenAccessStatus =
	| "granted"
	| "denied"
	| "missing-helper"
	| "error"
	| "exited"
	| "timeout";

export interface MacScreenAccessResult {
	success: boolean;
	granted: boolean;
	status: MacScreenAccessStatus;
	error?: string;
}

/** True when the probe never got far enough to answer the permission question. */
export function isMacScreenProbeUnavailable(status: MacScreenAccessStatus) {
	return (
		status === "missing-helper" || status === "error" || status === "exited" || status === "timeout"
	);
}

function helperCandidates() {
	const envPath = process.env.OPENSCREEN_SCK_CAPTURE_EXE?.trim();
	const appRoot = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : process.cwd();
	const archTag = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	const resourceRoot =
		typeof process.resourcesPath === "string"
			? process.resourcesPath
			: path.join(appRoot, "resources");

	return [
		envPath,
		path.join(appRoot, "electron", "native", "screencapturekit", "build", HELPER_NAME),
		path.join(appRoot, "electron", "native", "bin", archTag, HELPER_NAME),
		path.join(resourceRoot, "electron", "native", "bin", archTag, HELPER_NAME),
	].filter((candidate): candidate is string => Boolean(candidate));
}

export function findMacScreenAccessHelperPath() {
	for (const candidate of helperCandidates()) {
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next helper location.
		}
	}

	return null;
}

/**
 * Reads the current Screen Recording grant, uncached.
 *
 * Never prompts and never blocks on the user: the helper calls the preflight function
 * only, so this is safe to poll while macOS' own prompt is on screen.
 */
export async function readMacScreenCaptureAccess(): Promise<MacScreenAccessResult> {
	if (process.platform !== "darwin") {
		return { success: true, granted: true, status: "granted" };
	}

	const helperPath = findMacScreenAccessHelperPath();
	if (!helperPath) {
		return { success: true, granted: false, status: "missing-helper" };
	}

	return new Promise<MacScreenAccessResult>((resolve) => {
		const child = spawn(helperPath, [SCREEN_ACCESS_STATUS_FLAG], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let settled = false;
		let lineBuffer = "";

		const finish = (result: MacScreenAccessResult) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (!child.killed) {
				child.kill("SIGTERM");
			}
			resolve(result);
		};

		const timer = setTimeout(() => {
			finish({
				success: false,
				granted: false,
				status: "timeout",
				error: "Timed out reading the macOS screen recording permission",
			});
		}, PROBE_TIMEOUT_MS);

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			lineBuffer += chunk;
			const lines = lineBuffer.split(/\r?\n/);
			lineBuffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				try {
					const event = JSON.parse(trimmed) as { event?: string; granted?: boolean };
					if (event.event === "screen-access") {
						finish({
							success: true,
							granted: event.granted === true,
							status: event.granted === true ? "granted" : "denied",
						});
						return;
					}
				} catch {
					// Ignore non-JSON helper output.
				}
			}
		});

		child.once("error", (error) => {
			finish({ success: false, granted: false, status: "error", error: error.message });
		});

		// `close`, not `exit`. This helper prints one line and dies, and `exit` can fire
		// before stdout has been drained to the listener above -- which would report a
		// perfectly good answer as a dead helper. `close` waits for the stdio streams.
		//
		// Reaching it at all means the helper ran and said nothing: an older build without
		// the flag, which answers `invalidArguments` and exits 1. Reported as `exited`
		// rather than a refusal, so the caller falls back to the app's own status instead
		// of accusing the user of denying a permission they may well hold.
		child.once("close", (code, signal) => {
			finish({
				success: false,
				granted: false,
				status: "exited",
				error: `macOS screen access probe exited (code=${code}, signal=${signal})`,
			});
		});
	});
}
