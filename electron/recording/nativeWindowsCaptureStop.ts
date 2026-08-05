import { type ChildProcessWithoutNullStreams, execFile } from "node:child_process";

/**
 * Stopping a native Windows (WGC) recording, as a unit that can be tested.
 *
 * This lives outside `electron/ipc/handlers.ts` for one reason: that module
 * calls `app.getPath()` while it is being imported, so nothing in it can be
 * loaded from a test. The stop path shipped broken twice (issues #115, #252)
 * with no test able to see it, so it moved here.
 */

/**
 * The outer bound on a stop, and deliberately not the lever.
 *
 * This was raised from 15s to 60s for issue #34 so `IMFSinkWriter::Finalize`
 * had room to drain on slow encoders, and it stays at 60s for the same reason:
 * a parent that gave up first would kill a working save.
 *
 * It must stay above the helper's own shutdown ceiling
 * (`OPENSCREEN_WGC_STOP_BUDGET_MS`, 50s — see the stop sequence in
 * `electron/native/wgc-capture/src/main.cpp`), which is what guarantees the
 * helper always ends itself rather than being killed mid-finalize from here.
 * Raise one and raise the other.
 *
 * What changed for issue #252 is that reaching this timeout is no longer how a
 * wedged recorder is caught: the helper bounds every shutdown step itself and
 * force-exits within seconds, so 'close' arrives long before this fires.
 * Getting here means the helper is stuck somewhere even `TerminateProcess`
 * could not reach.
 */
export const NATIVE_WINDOWS_CAPTURE_STOP_TIMEOUT_MS = 60_000;

/** How long a killed helper gets to actually die before we escalate. */
const NATIVE_WINDOWS_CAPTURE_KILL_GRACE_MS = 2_000;

const RECORDING_STOPPED_PATTERN = /Recording stopped\. Output path: (.+)/;
const STOP_TIMEOUT_EVENT_PATTERN = /"event":"stop-timeout"[^\n]*"step":"([^"]+)"/;

export type NativeWindowsCaptureStopReason = "stop-timeout" | "helper-failed";

export type NativeWindowsCaptureStopResult =
	| { ok: true; screenVideoPath: string }
	| {
			ok: false;
			reason: NativeWindowsCaptureStopReason;
			message: string;
			/** False when a wedged helper survived even the forced kill. */
			exited: boolean;
	  };

export function readStoppedPath(output: string) {
	return output.match(RECORDING_STOPPED_PATTERN)?.[1]?.trim() || null;
}

/** The step the helper's shutdown watchdog gave up on, if it fired. */
export function readAbandonedStep(output: string) {
	return output.match(STOP_TIMEOUT_EVENT_PATTERN)?.[1] ?? null;
}

/**
 * The most useful line of a failed helper run, for a toast.
 *
 * The log ends with `[stop-timing]` and JSON protocol lines on every run, so
 * "the last line" is reliably a diagnostic rather than a cause. Prefer what the
 * helper actually complained about.
 */
export function readHelperFailureMessage(output: string, code: number | null) {
	const complaints = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("ERROR:") || line.startsWith("WARNING:"));

	// Only lines that describe a failure. The rest of a helper log is progress
	// ("Recording started") and diagnostics, and reporting the last of those as
	// the error reads like a success message on a red toast.
	return complaints.at(-1) ?? `Native Windows capture exited with code=${code ?? "unknown"}`;
}

function hasExited(proc: ChildProcessWithoutNullStreams) {
	return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * `taskkill /T /F` on the helper. `ChildProcess.kill()` maps to
 * `TerminateProcess` on Windows, which is already forceful but cannot touch a
 * thread that is stuck below user mode -- the exact state a wedged display
 * driver leaves the helper in. Escalating gives us a second chance, and an
 * orphan that survives both is worth reporting rather than pretending away.
 */
function forceKillProcessTree(pid: number) {
	return new Promise<void>((resolve) => {
		// Bounded: taskkill walks the process tree and opens handles, both of
		// which can block on exactly the wedged process it is being asked to
		// kill. Nothing else can settle the stop promise by this point, so a
		// taskkill that never returns would recreate the unbounded wait this
		// whole path exists to end.
		execFile(
			"taskkill",
			["/PID", String(pid), "/T", "/F"],
			{ timeout: NATIVE_WINDOWS_CAPTURE_KILL_GRACE_MS, windowsHide: true },
			() => resolve(),
		);
	});
}

function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number) {
	if (hasExited(proc)) {
		return Promise.resolve(true);
	}

	return new Promise<boolean>((resolve) => {
		const settle = (exited: boolean) => {
			clearTimeout(timer);
			proc.off("close", onClose);
			resolve(exited);
		};
		const onClose = () => settle(true);
		const timer = setTimeout(() => settle(false), timeoutMs);
		proc.once("close", onClose);
	});
}

/**
 * Kills the helper and confirms it actually died, escalating once. Resolves to
 * whether the process is gone.
 */
export async function terminateNativeWindowsCapture(
	proc: ChildProcessWithoutNullStreams,
	options: {
		graceMs?: number;
		forceKill?: (pid: number) => Promise<void>;
	} = {},
) {
	if (hasExited(proc)) {
		return true;
	}

	const graceMs = options.graceMs ?? NATIVE_WINDOWS_CAPTURE_KILL_GRACE_MS;
	const forceKill = options.forceKill ?? forceKillProcessTree;

	proc.kill();
	if (await waitForExit(proc, graceMs)) {
		return true;
	}

	if (typeof proc.pid === "number") {
		await forceKill(proc.pid);
		return waitForExit(proc, graceMs);
	}

	return false;
}

/**
 * Waits for the helper to report a finalized recording.
 *
 * Resolves rather than rejects on failure: the caller needs to tell a stop
 * timeout apart from a helper error to pick the right message, and an `Error`
 * carrying the whole accumulated helper log is not something to put in front of
 * a user.
 */
export function waitForNativeWindowsCaptureStop(options: {
	proc: ChildProcessWithoutNullStreams;
	/** Path we asked the helper to write, used when it exits 0 without saying so. */
	targetPath: string | null;
	/** The accumulated helper output; read lazily so late chunks are included. */
	readOutput: () => string;
	timeoutMs?: number;
	killGraceMs?: number;
	forceKill?: (pid: number) => Promise<void>;
}): Promise<NativeWindowsCaptureStopResult> {
	const { proc, targetPath, readOutput } = options;
	const timeoutMs = options.timeoutMs ?? NATIVE_WINDOWS_CAPTURE_STOP_TIMEOUT_MS;

	const settleFromOutput = (code: number | null): NativeWindowsCaptureStopResult => {
		const output = readOutput();
		// The helper announces this as soon as the MP4 index is written, before
		// it releases the GPU device. So a helper that was killed during teardown
		// still reports a recording that is complete and playable -- taking its
		// word for that is what keeps the file (issue #252).
		const stoppedPath = readStoppedPath(output);
		if (stoppedPath) {
			return { ok: true, screenVideoPath: stoppedPath };
		}
		if (code === 0 && targetPath) {
			return { ok: true, screenVideoPath: targetPath };
		}
		// The helper's own shutdown watchdog gave up. That is a stop timeout, not
		// a generic failure, and it knows which step stalled.
		const abandonedStep = readAbandonedStep(output);
		if (abandonedStep) {
			return {
				ok: false,
				reason: "stop-timeout",
				message: `The recorder stalled while shutting down (${abandonedStep}).`,
				exited: true,
			};
		}
		return {
			ok: false,
			reason: "helper-failed",
			message: readHelperFailureMessage(output, code),
			exited: true,
		};
	};

	// The helper may already be gone -- it force-exits on its own shutdown
	// watchdog, and a DXGI device loss can kill it outright mid-recording. Node
	// does not re-emit 'close' for a process that has already exited, so
	// registering a listener first would burn the whole timeout waiting for an
	// event that can never arrive.
	if (hasExited(proc)) {
		return Promise.resolve(settleFromOutput(proc.exitCode));
	}

	return new Promise<NativeWindowsCaptureStopResult>((resolve) => {
		const onClose = (code: number | null) => {
			cleanup();
			resolve(settleFromOutput(code));
		};
		const onError = (error: Error) => {
			cleanup();
			resolve({
				ok: false,
				reason: "helper-failed",
				message: error.message,
				exited: hasExited(proc),
			});
		};
		const cleanup = () => {
			clearTimeout(timer);
			proc.off("close", onClose);
			proc.off("error", onError);
		};

		const timer = setTimeout(() => {
			cleanup();
			void (async () => {
				let exited = false;
				try {
					exited = await terminateNativeWindowsCapture(proc, {
						graceMs: options.killGraceMs,
						forceKill: options.forceKill,
					});
				} catch (error) {
					// Killing a wedged, possibly protected process can itself
					// fail. `cleanup()` has already dropped this promise's only
					// other path to settling, so swallowing the rejection here
					// would hang the stop handler forever -- the very failure
					// this timeout exists to end.
					console.warn("[native-wgc] could not terminate the wedged helper:", error);
				}
				// Check for a finalized recording before calling this a loss. The
				// helper announces the file as soon as its index is written and
				// only then does its GPU teardown, so the run most likely to end
				// up here is also the one most likely to have already produced a
				// perfectly playable MP4.
				const stoppedPath = readStoppedPath(readOutput());
				if (stoppedPath) {
					resolve({ ok: true, screenVideoPath: stoppedPath });
					return;
				}
				resolve({
					ok: false,
					reason: "stop-timeout",
					message: "The recorder did not shut down in time.",
					exited,
				});
			})();
		}, timeoutMs);

		proc.once("close", onClose);
		proc.once("error", onError);
	});
}
