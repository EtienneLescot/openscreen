import { describe, expect, it } from "vitest";
import { CREDIT_WINDOW, NativeFrameSink, type NativeSinkApi } from "./nativeFrameSink";

/**
 * A stand-in for the main process: records frames, and only acks when told to,
 * so a test can hold the window full and observe the sender blocking.
 */
function fakeMain(over: Partial<NativeSinkApi> = {}) {
	let ack: ((sessionId: string, error: string | null) => void) | null = null;
	const state = {
		frames: [] as number[],
		pending: [] as number[],
		finished: false,
		cancelled: false,
		unsubscribed: false,
		listenerAtFirstFrame: null as boolean | null,
	};
	const api: NativeSinkApi = {
		exportStart: async () => ({ sessionId: "s1", encoder: "h264_amf" }),
		exportWriteFrame: (_id, frame) => {
			state.listenerAtFirstFrame ??= ack !== null;
			state.frames.push(frame.byteLength);
			state.pending.push(frame.byteLength);
		},
		exportOnFrameAck: (cb) => {
			ack = cb;
			return () => {
				state.unsubscribed = true;
			};
		},
		exportFinish: async () => {
			state.finished = true;
			return { outputPath: "/tmp/out.mp4" };
		},
		exportCancel: async () => {
			state.cancelled = true;
		},
		...over,
	};
	/** Ack `n` frames as the main process would, one message each. */
	const flush = (n = state.pending.length, error: string | null = null) => {
		for (let i = 0; i < n; i++) {
			state.pending.shift();
			ack?.("s1", error);
		}
	};
	/** Deliver an ack exactly as the main process would, for any session id. */
	const ackAs = (sessionId: string, error: string | null = null) => ack?.(sessionId, error);
	return { api, state, flush, ackAs };
}

const OPTS = {
	outputPath: "/tmp/out.mp4",
	width: 1920,
	height: 1080,
	frameRate: 60,
	bitrate: 8_000_000,
	pixelFormat: "nv12" as const,
};

/** Lets pending microtasks settle so a blocked write() can be observed as blocked. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("NativeFrameSink", () => {
	it("subscribes to acks before the first frame can be sent", async () => {
		const { api, state } = fakeMain();
		const sink = await NativeFrameSink.start(OPTS, api);
		await sink.write(new ArrayBuffer(16));
		// If the listener were registered after the first send, an ack arriving
		// promptly would be dropped and the window would never refill.
		expect(state.listenerAtFirstFrame).toBe(true);
	});

	it("keeps exactly CREDIT_WINDOW frames in flight and blocks the next one", async () => {
		const { api, state, flush } = fakeMain();
		const sink = await NativeFrameSink.start(OPTS, api);

		for (let i = 0; i < CREDIT_WINDOW; i++) await sink.write(new ArrayBuffer(1));
		expect(state.frames.length).toBe(CREDIT_WINDOW);

		let sent = false;
		const blocked = sink.write(new ArrayBuffer(1)).then(() => {
			sent = true;
		});
		await settle();
		// The window is full: this write must not have gone out.
		expect(sent).toBe(false);
		expect(state.frames.length).toBe(CREDIT_WINDOW);

		flush(1);
		await blocked;
		expect(state.frames.length).toBe(CREDIT_WINDOW + 1);
	});

	it("does not block below the window — the whole point over stop-and-wait", async () => {
		const { api, state } = fakeMain();
		const sink = await NativeFrameSink.start(OPTS, api);
		// No acks at all: the first CREDIT_WINDOW writes must still all resolve.
		for (let i = 0; i < CREDIT_WINDOW; i++) await sink.write(new ArrayBuffer(1));
		expect(state.frames.length).toBe(CREDIT_WINDOW);
	});

	it("ignores acks addressed to another session", async () => {
		const { api, state, ackAs } = fakeMain();
		const sink = await NativeFrameSink.start(OPTS, api);
		for (let i = 0; i < CREDIT_WINDOW; i++) await sink.write(new ArrayBuffer(1));

		let sent = false;
		void sink.write(new ArrayBuffer(1)).then(() => {
			sent = true;
		});
		// The ack channel is renderer-wide. A concurrent export's ack must not hand
		// us a credit we did not earn, or we would overrun our own window.
		ackAs("some-other-session");
		await settle();
		expect(sent).toBe(false);
		expect(state.frames.length).toBe(CREDIT_WINDOW);

		// Our own ack still works, proving the guard is on the id, not on everything.
		ackAs("s1");
		await settle();
		expect(sent).toBe(true);
	});

	it("drains every in-flight frame before finishing", async () => {
		const { api, state, flush } = fakeMain();
		const sink = await NativeFrameSink.start(OPTS, api);
		for (let i = 0; i < 3; i++) await sink.write(new ArrayBuffer(1));

		let done = false;
		const finishing = sink.finish().then((r) => {
			done = true;
			return r;
		});
		await settle();
		// Finishing with frames still in flight would close ffmpeg's stdin early
		// and truncate the file.
		expect(done).toBe(false);
		expect(state.finished).toBe(false);

		flush();
		await expect(finishing).resolves.toEqual({ outputPath: "/tmp/out.mp4" });
		expect(state.finished).toBe(true);
	});

	it("finishes immediately when nothing is in flight", async () => {
		const { api } = fakeMain();
		const sink = await NativeFrameSink.start(OPTS, api);
		await expect(sink.finish()).resolves.toEqual({ outputPath: "/tmp/out.mp4" });
	});

	it("unsubscribes from the ack channel on finish", async () => {
		const { api, state } = fakeMain();
		const sink = await NativeFrameSink.start(OPTS, api);
		await sink.finish();
		expect(state.unsubscribed).toBe(true);
	});

	it("surfaces an ffmpeg write failure to the writer rather than hanging", async () => {
		const { api, flush } = fakeMain();
		const sink = await NativeFrameSink.start(OPTS, api);
		for (let i = 0; i < CREDIT_WINDOW; i++) await sink.write(new ArrayBuffer(1));

		const blocked = sink.write(new ArrayBuffer(1));
		flush(1, "ffmpeg exited: Cannot load nvcuda.dll");
		// The parked write must reject, not resume: ffmpeg is gone.
		await expect(blocked).rejects.toThrow(/nvcuda/);
	});

	it("reports the ffmpeg failure from finish() instead of the file it never wrote", async () => {
		const { api, state, flush } = fakeMain();
		const sink = await NativeFrameSink.start(OPTS, api);
		await sink.write(new ArrayBuffer(1));
		flush(1, "ffmpeg died");
		await expect(sink.finish()).rejects.toThrow(/ffmpeg died/);
		// A dead session must be cancelled, not finished — finishing waits on a
		// process that will never exit cleanly.
		expect(state.finished).toBe(false);
		expect(state.cancelled).toBe(true);
	});

	it("cancel() releases a writer parked on a credit that will never arrive", async () => {
		const { api, state } = fakeMain();
		const sink = await NativeFrameSink.start(OPTS, api);
		for (let i = 0; i < CREDIT_WINDOW; i++) await sink.write(new ArrayBuffer(1));

		const blocked = sink.write(new ArrayBuffer(1));
		await sink.cancel();
		// Without the wake in cancel(), this write would hang forever and the
		// export loop would never unwind.
		await expect(blocked).rejects.toThrow(/closed/);
		expect(state.cancelled).toBe(true);
		expect(state.unsubscribed).toBe(true);
	});

	it("is idempotent on cancel", async () => {
		const { api } = fakeMain();
		const sink = await NativeFrameSink.start(OPTS, api);
		await sink.cancel();
		await expect(sink.cancel()).resolves.toBeUndefined();
	});
});
