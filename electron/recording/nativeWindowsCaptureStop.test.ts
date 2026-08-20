import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isSalvageableFragmentedCapture,
	NATIVE_WINDOWS_SALVAGEABLE_OUTPUT_BYTES,
	readMicrophoneDefaulted,
	readStoppedPath,
	readWebcamFormat,
	readWebcamUnavailable,
	terminateNativeWindowsCapture,
	waitForNativeWindowsCaptureStop,
} from "./nativeWindowsCaptureStop";

/**
 * Stands in for wgc-capture.exe. `exitCode`/`signalCode` are real properties on
 * `ChildProcess` and the code under test reads them to decide whether waiting
 * for 'close' can still pay off, so the fake has to model them honestly.
 */
class FakeHelper extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin: Writable;
	exitCode: number | null = null;
	signalCode: string | null = null;
	pid: number | undefined = 4242;
	killCalls = 0;
	/** When false, kill() is recorded but the process refuses to die. */
	diesOnKill = true;

	constructor() {
		super();
		this.stdin = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
	}

	kill() {
		this.killCalls += 1;
		if (this.diesOnKill) {
			this.exit(1);
		}
		return true;
	}

	exit(code: number) {
		this.exitCode = code;
		this.emit("close", code);
	}
}

function asProc(helper: FakeHelper) {
	return helper as unknown as ChildProcessWithoutNullStreams;
}

let helper: FakeHelper;

beforeEach(() => {
	vi.useFakeTimers();
	helper = new FakeHelper();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("readStoppedPath", () => {
	it("reads the finalized path out of the helper log", () => {
		expect(readStoppedPath("Recording stopped. Output path: C:\\rec\\a.mp4\n")).toBe(
			"C:\\rec\\a.mp4",
		);
	});

	it("is null when the helper never reported a finalized file", () => {
		expect(readStoppedPath("Recording started\n[stop-timing] step=microphone elapsed_ms=0\n")).toBe(
			null,
		);
	});
});

describe("readWebcamUnavailable", () => {
	it("sees the helper giving up on the camera", () => {
		const output =
			'{"event":"ready","schemaVersion":2}\n' +
			"WARNING: Failed to initialize native webcam capture; continuing without webcam\n" +
			'{"event":"warning","code":"webcam-unavailable","message":"Failed to initialize native webcam capture"}\n' +
			"Recording started\n";
		expect(readWebcamUnavailable(output)).toBe(true);
	});

	it("is false for a run whose camera worked", () => {
		const output =
			'{"event":"webcam-format","schemaVersion":2,"width":1920,"height":1080,"fps":30,"deviceName":"Camera (NVIDIA Broadcast)"}\n' +
			"Recording started\n";
		expect(readWebcamUnavailable(output)).toBe(false);
	});
});

describe("readMicrophoneDefaulted", () => {
	// The helper keys the event on the OUTCOME — it ended up on the default input
	// — not on which lookup failed, so both routes to that fallback land here.
	it("sees the fallback when no microphone name was supplied", () => {
		const output =
			'{"event":"warning","code":"microphone-defaulted","message":"The requested microphone could not be resolved; capturing the default input"}\n' +
			"Recording started\n";
		expect(readMicrophoneDefaulted(output)).toBe(true);
	});

	it("sees it when a supplied name matched no endpoint", () => {
		const output =
			"WARNING: Could not resolve microphone by name; using default capture endpoint\n" +
			'{"event":"warning","code":"microphone-defaulted","message":"The requested microphone could not be resolved; capturing the default input"}\n';
		expect(readMicrophoneDefaulted(output)).toBe(true);
	});

	it("is false when the requested microphone was found", () => {
		const output =
			'{"event":"audio-format","schemaVersion":2,"microphone":true,"microphoneDeviceName":"Microphone (Logitech PRO X)"}\n';
		expect(readMicrophoneDefaulted(output)).toBe(false);
	});
});

describe("readWebcamFormat", () => {
	it("reads the negotiated camera format", () => {
		const output =
			'{"event":"webcam-format","schemaVersion":2,"width":1920,"height":1080,"fps":30,"deviceName":"Camera (NVIDIA Broadcast)"}\n';
		expect(readWebcamFormat(output)).toMatchObject({
			width: 1920,
			height: 1080,
			deviceName: "Camera (NVIDIA Broadcast)",
		});
	});

	// Captured verbatim from a real run: the helper's stderr diagnostic and its
	// stdout event land in the same drained chunk, with no newline between them.
	// Parsing that line whole throws, which used to read as "no camera at all".
	it("reads the event even when stderr is glued onto the front of it", () => {
		const output =
			"INFO: DirectShow webcam connected subtype NV12 720x1280 " +
			'stride=2880{"event":"webcam-format","schemaVersion":2,"width":720,"height":1280,"fps":30,"deviceName":"OBS Virtual Camera"}\n';
		expect(readWebcamFormat(output)).toMatchObject({
			width: 720,
			height: 1280,
			deviceName: "OBS Virtual Camera",
		});
	});

	// A friendly name is free text from the driver, so it can contain the very
	// character that used to end the slice. Cutting the object there dropped a
	// camera that was working perfectly.
	it("reads a device name that contains a closing brace", () => {
		const output =
			'{"event":"webcam-format","schemaVersion":2,"width":1280,"height":720,"fps":30,"deviceName":"Camera } Studio"}\n';
		expect(readWebcamFormat(output)).toMatchObject({
			width: 1280,
			deviceName: "Camera } Studio",
		});
	});

	it("reads a device name whose escaped quote precedes a brace", () => {
		const output =
			'{"event":"webcam-format","schemaVersion":2,"width":640,"height":480,"fps":30,"deviceName":"Cam \\"X\\" } 2"}\n';
		expect(readWebcamFormat(output)).toMatchObject({ deviceName: 'Cam "X" } 2' });
	});

	it("is null when the object is cut off mid-way", () => {
		expect(readWebcamFormat('{"event":"webcam-format","width":1280')).toBe(null);
	});

	it("is null when the helper never announced a camera", () => {
		expect(readWebcamFormat("Recording started\n")).toBe(null);
	});
});

describe("isSalvageableFragmentedCapture", () => {
	const big = NATIVE_WINDOWS_SALVAGEABLE_OUTPUT_BYTES * 8;

	// The whole point of the fragmented container, and the case that used to be
	// deleted-or-disowned while the file on disk played perfectly (#252).
	it("keeps a fragmented capture whose stop never finalized", () => {
		expect(isSalvageableFragmentedCapture("fragmented-mp4", big)).toBe(true);
	});

	// The ablation. Same size, same failed stop, no index anywhere in the file:
	// this one really is lost, and saying otherwise would open an empty editor.
	it("does not pretend a plain MP4 survived the same failure", () => {
		expect(isSalvageableFragmentedCapture("mp4", big)).toBe(false);
	});

	it("rejects a fragmented file too small to hold a complete fragment", () => {
		expect(
			isSalvageableFragmentedCapture("fragmented-mp4", NATIVE_WINDOWS_SALVAGEABLE_OUTPUT_BYTES - 1),
		).toBe(false);
	});

	it("takes the floor itself as salvageable", () => {
		expect(
			isSalvageableFragmentedCapture("fragmented-mp4", NATIVE_WINDOWS_SALVAGEABLE_OUTPUT_BYTES),
		).toBe(true);
	});

	// A helper predating the fragmented sink reports no container at all. Absent
	// is not fragmented -- guessing here would resurrect the total loss.
	it("refuses to guess when the helper never reported a container", () => {
		expect(isSalvageableFragmentedCapture(null, big)).toBe(false);
		expect(isSalvageableFragmentedCapture(undefined, big)).toBe(false);
	});

	it("rejects a file that is not there at all", () => {
		expect(isSalvageableFragmentedCapture("fragmented-mp4", null)).toBe(false);
	});
});

describe("waitForNativeWindowsCaptureStop", () => {
	it("resolves with the path the helper reported", async () => {
		let output = "Recording started\n";
		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () => output,
		});

		output += "Recording stopped. Output path: C:\\rec\\a.mp4\n";
		helper.exit(0);

		await expect(pending).resolves.toEqual({ ok: true, screenVideoPath: "C:\\rec\\a.mp4" });
	});

	it("falls back to the requested path when the helper exits 0 quietly", async () => {
		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () => "",
		});

		helper.exit(0);

		await expect(pending).resolves.toEqual({ ok: true, screenVideoPath: "C:\\rec\\a.mp4" });
	});

	/**
	 * The helper can be gone before the stop IPC even runs -- it force-exits on
	 * its own shutdown watchdog, and a lost D3D device kills it outright. Node
	 * never re-emits 'close' for a process that already exited, so waiting for
	 * one burned the entire stop timeout and reported it as a hang (issue #252).
	 */
	it("settles immediately when the helper has already exited", async () => {
		helper.exitCode = 0;

		const result = await waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () => "Recording stopped. Output path: C:\\rec\\a.mp4\n",
		});

		expect(result).toEqual({ ok: true, screenVideoPath: "C:\\rec\\a.mp4" });
		// No timers were needed: nothing was ever scheduled to wait on.
		expect(vi.getTimerCount()).toBe(0);
	});

	/**
	 * The helper announces a finalized recording before it releases the GPU
	 * device, so its own watchdog killing it during teardown must still count as
	 * a success -- the MP4 on disk is complete, and the caller deletes files it
	 * is told are failures.
	 */
	it("keeps the recording when the helper was killed after finalizing", async () => {
		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () =>
				"[stop-timing] step=encoder-finalize elapsed_ms=400\n" +
				"Recording stopped. Output path: C:\\rec\\a.mp4\n" +
				"[stop-timing] step=wgc-session-close elapsed_ms=8001 phase=abandoned\n" +
				'{"event":"stop-timeout","schemaVersion":2,"step":"wgc-session-close"}\n',
		});

		helper.exit(3);

		await expect(pending).resolves.toEqual({ ok: true, screenVideoPath: "C:\\rec\\a.mp4" });
	});

	/**
	 * The webcam is a second, optional file, and the helper announces the screen
	 * recording before finalizing it precisely so a bad camera clip cannot veto a
	 * complete capture. The exit code is non-zero and the reason is on stderr;
	 * the screen MP4 is still finished and must still be kept.
	 */
	it("keeps the screen recording when only the webcam failed to finalize", async () => {
		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () =>
				"Recording stopped. Output path: C:\\rec\\a.mp4\n" +
				"[stop-timing] step=webcam-encoder-finalize elapsed_ms=900\n" +
				"ERROR: Failed to finalize the webcam recording\n",
		});

		helper.exit(1);

		await expect(pending).resolves.toEqual({ ok: true, screenVideoPath: "C:\\rec\\a.mp4" });
	});

	it("classifies the helper's own shutdown watchdog as a stop timeout", async () => {
		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () =>
				"[stop-timing] step=video-writer-join elapsed_ms=8001 phase=abandoned\n" +
				'{"event":"stop-timeout","schemaVersion":2,"step":"video-writer-join"}\n',
		});

		helper.exit(3);

		await expect(pending).resolves.toEqual({
			ok: false,
			reason: "stop-timeout",
			message: "The recorder stalled while shutting down (video-writer-join).",
			exited: true,
		});
	});

	it("reports a helper failure with its output rather than a timeout", async () => {
		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () => "ERROR: Failed to encode WGC frame\n",
		});

		helper.exit(1);

		await expect(pending).resolves.toEqual({
			ok: false,
			reason: "helper-failed",
			message: "ERROR: Failed to encode WGC frame",
			exited: true,
		});
	});

	/** Every run ends with diagnostics, so "the last line" is never the cause. */
	it("skips diagnostic noise when picking the user-facing failure message", async () => {
		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () =>
				"ERROR: Failed to initialize Media Foundation encoder\n" +
				"[stop-timing] step=microphone elapsed_ms=2\n" +
				'{"event":"warning","code":"webcam-unavailable"}\n',
		});

		helper.exit(1);

		await expect(pending).resolves.toMatchObject({
			reason: "helper-failed",
			message: "ERROR: Failed to initialize Media Foundation encoder",
		});
	});

	it("still settles when killing the wedged helper throws", async () => {
		helper.diesOnKill = false;
		const forceKill = vi.fn(async () => {
			throw new Error("EPERM");
		});

		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () => "",
			timeoutMs: 20_000,
			killGraceMs: 2_000,
			forceKill,
		});

		await vi.advanceTimersByTimeAsync(20_000);
		await vi.advanceTimersByTimeAsync(4_000);

		await expect(pending).resolves.toMatchObject({
			ok: false,
			reason: "stop-timeout",
			exited: false,
		});
	});

	it("kills the helper and reports a timeout when it never finalizes", async () => {
		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () => "[stop-timing] step=video-writer-join phase=begin elapsed_ms=0\n",
			timeoutMs: 20_000,
		});

		await vi.advanceTimersByTimeAsync(20_000);

		await expect(pending).resolves.toEqual({
			ok: false,
			reason: "stop-timeout",
			// A short sentence, not the log: this ends up in a toast.
			message: "The recorder did not shut down in time.",
			exited: true,
		});
		expect(helper.killCalls).toBe(1);
	});

	/** The timeout path is the likeliest place for an already-finalized file. */
	it("keeps a recording the helper finalized before the parent gave up", async () => {
		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () =>
				"Recording stopped. Output path: C:\\rec\\a.mp4\n" +
				"[stop-timing] step=wgc-session-close elapsed_ms=1 phase=begin\n",
			timeoutMs: 20_000,
		});

		await vi.advanceTimersByTimeAsync(20_000);

		await expect(pending).resolves.toEqual({ ok: true, screenVideoPath: "C:\\rec\\a.mp4" });
	});

	it("reports the exit code rather than a progress line when nothing failed loudly", async () => {
		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () => 'Recording started\n{"event":"ready","schemaVersion":2}\n',
		});

		helper.exit(9);

		await expect(pending).resolves.toMatchObject({
			reason: "helper-failed",
			message: "Native Windows capture exited with code=9",
		});
	});

	it("escalates to a forced tree kill when the helper survives kill()", async () => {
		helper.diesOnKill = false;
		const forceKill = vi.fn(async () => {
			helper.exit(1);
		});

		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () => "",
			timeoutMs: 20_000,
			killGraceMs: 2_000,
			forceKill,
		});

		await vi.advanceTimersByTimeAsync(20_000);
		await vi.advanceTimersByTimeAsync(2_000);

		const result = await pending;
		expect(forceKill).toHaveBeenCalledWith(4242);
		expect(result).toMatchObject({ ok: false, reason: "stop-timeout", exited: true });
	});

	it("reports the helper as surviving when even the forced kill fails", async () => {
		helper.diesOnKill = false;
		// taskkill returns, but the helper is wedged below user mode and survives.
		const forceKill = vi.fn(async () => undefined);

		const pending = waitForNativeWindowsCaptureStop({
			proc: asProc(helper),
			targetPath: "C:\\rec\\a.mp4",
			readOutput: () => "",
			timeoutMs: 20_000,
			killGraceMs: 2_000,
			forceKill,
		});

		await vi.advanceTimersByTimeAsync(20_000);
		await vi.advanceTimersByTimeAsync(4_000);

		await expect(pending).resolves.toMatchObject({
			ok: false,
			reason: "stop-timeout",
			exited: false,
		});
	});
});

describe("terminateNativeWindowsCapture", () => {
	it("is a no-op for a helper that already exited", async () => {
		helper.exitCode = 0;

		await expect(terminateNativeWindowsCapture(asProc(helper))).resolves.toBe(true);
		expect(helper.killCalls).toBe(0);
	});

	it("does not wait out the grace period when kill() works", async () => {
		const pending = terminateNativeWindowsCapture(asProc(helper), { graceMs: 2_000 });

		await expect(pending).resolves.toBe(true);
		expect(helper.killCalls).toBe(1);
	});
});
