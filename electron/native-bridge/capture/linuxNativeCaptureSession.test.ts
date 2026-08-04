import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Same hoisting caveat as the cursor-session test next door: `vi.mock` factories
 * run above every top-level statement, so the cast is written out inline rather
 * than shared through a helper that would still be in its temporal dead zone.
 */
type WithDefault = { default?: Record<string, unknown> };

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = vi.fn();
	return { ...actual, spawn, default: { ...((actual as WithDefault).default ?? {}), spawn } };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	// No helper binary in a test checkout; pretend the first candidate resolves so
	// path lookup is not what is under test.
	return {
		...actual,
		accessSync: vi.fn(),
		default: { ...((actual as WithDefault).default ?? {}), accessSync: vi.fn() },
	};
});

import { spawn } from "node:child_process";
import { LinuxNativeCaptureSession } from "./linuxNativeCaptureSession";

class FakeHelper extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdinWrites: string[] = [];
	killed = false;
	stdin: Writable;

	constructor() {
		super();
		const writes = this.stdinWrites;
		this.stdin = new Writable({
			write(chunk, _encoding, callback) {
				writes.push(chunk.toString());
				callback();
			},
		});
	}

	kill() {
		this.killed = true;
		return true;
	}

	emitEvent(event: Record<string, unknown>) {
		this.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...event })}\n`);
	}
}

const spawnMock = vi.mocked(spawn);
let helper: FakeHelper;

function newSession(deferStart = false) {
	return new LinuxNativeCaptureSession({
		...(deferStart ? { deferStart: true } : {}),
		outputPath: "/tmp/recording.mp4",
		cursorMode: "metadata",
		fps: 30,
		audio: {
			system: { enabled: false },
			microphone: { enabled: false, gain: 1 },
		},
		maxCursorSamples: 100,
	});
}

async function startReady(session: LinuxNativeCaptureSession) {
	const started = session.start();
	await Promise.resolve();
	helper.emitEvent({ event: "ready", timestampMs: 1_000 });
	await started;
}

function flushStdout() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Drives a session to a finished recording, optionally granting a source kind. */
async function record(sourceKind?: string) {
	const session = newSession();
	await startReady(session);

	helper.emitEvent({
		event: "stream-started",
		timestampMs: 1_100,
		nodeId: 42,
		width: 1280,
		height: 720,
		...(sourceKind ? { sourceKind } : {}),
	});
	await flushStdout();

	const stopping = session.stop();
	await flushStdout();
	helper.emitEvent({
		event: "capture-stopped",
		timestampMs: 2_000,
		path: "/tmp/recording.mp4",
		durationMs: 900,
		frames: 27,
		dropped: 0,
	});
	await flushStdout();
	helper.emit("exit", 0, null);

	return { session, result: await stopping };
}

beforeEach(() => {
	helper = new FakeHelper();
	spawnMock.mockReset();
	spawnMock.mockReturnValue(helper as unknown as ReturnType<typeof spawn>);
	const silence = () => {
		// The session logs every helper diagnostic; keep the test output readable.
	};
	vi.spyOn(console, "info").mockImplementation(silence);
	vi.spyOn(console, "warn").mockImplementation(silence);
	vi.spyOn(console, "error").mockImplementation(silence);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LinuxNativeCaptureSession", () => {
	/**
	 * The regression this file exists for. A restore token is bound to the source
	 * it was minted for, so replaying one made the portal hand back an
	 * already-approved MONITOR on every later run and stop raising its picker —
	 * and since `SelectSources` cannot name a source, "record this window" then
	 * had no way to mean anything. The request must carry no token at all.
	 */
	it("sends no restore token to the helper", async () => {
		await startReady(newSession());

		const [, args] = spawnMock.mock.calls[0];
		const request = JSON.parse((args as string[])[0]) as Record<string, unknown>;

		expect(request).not.toHaveProperty("restoreToken");
		expect(JSON.stringify(request)).not.toContain("restoreToken");
	});

	it("reports the source kind the portal granted", async () => {
		const { session, result } = await record("window");

		expect(session.grantedSourceKind).toBe("window");
		expect(result.sourceKind).toBe("window");
	});

	it("distinguishes a granted monitor from a granted window", async () => {
		const { session, result } = await record("monitor");

		expect(session.grantedSourceKind).toBe("monitor");
		expect(result.sourceKind).toBe("monitor");
	});

	/**
	 * Absent is not "monitor". A backend that omits the field leaves the kind
	 * unknown, and collapsing that into a default is how the UI came to assert a
	 * source the capture had never been told about.
	 */
	it("leaves the granted kind unknown when the portal does not report one", async () => {
		const { session, result } = await record();

		expect(session.grantedSourceKind).toBeUndefined();
		expect(result.sourceKind).toBeUndefined();
	});

	/**
	 * The sequencing fix. The picker has to be answered BEFORE the countdown, so
	 * "a source was chosen" must be observable separately from "pixels are
	 * flowing" — otherwise the only thing to wait on is the first frame, which is
	 * far too late to start counting down.
	 */
	it("resolves the source selection before any frame is captured", async () => {
		const session = newSession(true);
		await startReady(session);

		let selected = false;
		const selecting = session.waitUntilSourceSelected().then(() => {
			selected = true;
		});
		await flushStdout();
		expect(selected).toBe(false);

		helper.emitEvent({
			event: "source-selected",
			timestampMs: 1_100,
			nodeId: 42,
			sourceKind: "window",
		});
		await selecting;

		expect(selected).toBe(true);
		// The kind is known one phase earlier than before, which is when the tray
		// label is needed.
		expect(session.grantedSourceKind).toBe("window");
	});

	it("asks the helper to defer, and arms it only when told to", async () => {
		const session = newSession(true);
		await startReady(session);

		const [, args] = spawnMock.mock.calls[0];
		expect(JSON.parse((args as string[])[0])).toMatchObject({ deferStart: true });
		expect(helper.stdinWrites).not.toContain("record\n");

		session.arm();
		expect(helper.stdinWrites).toContain("record\n");
	});

	it("arms at most once, so a caller need not track whether it prepared", async () => {
		const session = newSession(true);
		await startReady(session);

		session.arm();
		session.arm();
		session.arm();

		expect(helper.stdinWrites.filter((line) => line === "record\n")).toHaveLength(1);
	});

	it("does not ask the helper to defer unless it was configured to", async () => {
		await startReady(newSession());

		const [, args] = spawnMock.mock.calls[0];
		expect(JSON.parse((args as string[])[0])).not.toHaveProperty("deferStart");
	});

	/**
	 * A prepared session is held open across the countdown, so it can die before
	 * it is ever armed — the user revoking the share from the compositor's
	 * indicator, or closing the window they picked. Whoever is waiting on the
	 * picker must learn that instead of waiting forever.
	 */
	it("rejects a pending source selection when the helper dies", async () => {
		const session = newSession(true);
		await startReady(session);

		const selecting = session.waitUntilSourceSelected();
		await flushStdout();
		helper.emit("exit", 1, null);

		await expect(selecting).rejects.toThrow();
	});

	it("resolves the source selection immediately once it has already arrived", async () => {
		const session = newSession(true);
		await startReady(session);

		helper.emitEvent({
			event: "source-selected",
			timestampMs: 1_100,
			nodeId: 42,
			sourceKind: "monitor",
		});
		await flushStdout();

		// Callers must not have to race the event to observe it.
		await expect(session.waitUntilSourceSelected()).resolves.toBeUndefined();
	});

	it("knows the granted kind by the time the capture is confirmed running", async () => {
		const session = newSession();
		await startReady(session);

		const capturing = session.waitUntilCapturing();
		helper.emitEvent({
			event: "stream-started",
			timestampMs: 1_100,
			nodeId: 7,
			width: 800,
			height: 600,
			sourceKind: "window",
		});
		helper.emitEvent({
			event: "capture-started",
			timestampMs: 1_200,
			path: "/tmp/recording.mp4",
			width: 800,
			height: 600,
			fps: 30,
		});
		await capturing;

		expect(session.grantedSourceKind).toBe("window");
	});
});
