/**
 * Renderer side of the native export encoder: ships composited frames to the
 * main process, which feeds them to ffmpeg's stdin.
 *
 * Flow control is a credit window rather than stop-and-wait. Waiting for each
 * frame's ack before sending the next leaves the crossing idle for a full
 * round-trip per frame; keeping N frames in flight measured +56%. The window
 * saturates at 8 (32 adds nothing), because the crossing is bandwidth-bound —
 * IPC structured-clones every frame — not round-trip-bound.
 */

/** Frames in flight. Measured: 8 saturates the crossing, 32 buys nothing. */
export const CREDIT_WINDOW = 8;

export interface NativeSinkApi {
	exportStart: (req: unknown) => Promise<{
		sessionId: string;
		encoder: string;
		outputPath: string;
	}>;
	exportWriteFrame: (sessionId: string, frame: ArrayBuffer) => void;
	exportOnFrameAck: (cb: (sessionId: string, error: string | null) => void) => () => void;
	exportFinish: (sessionId: string) => Promise<{ outputPath: string }>;
	exportCancel: (sessionId: string) => Promise<void>;
}

export interface NativeSinkOptions {
	/** Omitted: main writes to a temp file and reports the path back. */
	outputPath?: string;
	width: number;
	height: number;
	frameRate: number;
	bitrate: number;
	pixelFormat: "nv12" | "bgra" | "rgba";
}

export class NativeFrameSink {
	private inFlight = 0;
	private waiters: Array<() => void> = [];
	private failure: Error | null = null;
	private unsubscribe: (() => void) | null = null;
	private closed = false;

	private constructor(
		private readonly api: NativeSinkApi,
		private readonly sessionId: string,
		readonly encoder: string,
		readonly outputPath: string,
	) {}

	static async start(opts: NativeSinkOptions, api: NativeSinkApi): Promise<NativeFrameSink> {
		const { sessionId, encoder, outputPath } = await api.exportStart(opts);
		const sink = new NativeFrameSink(api, sessionId, encoder, outputPath);
		// Subscribe before any frame goes out: an ack for frame 0 must not race the
		// listener's registration, or the window never refills.
		sink.unsubscribe = api.exportOnFrameAck((id, error) => sink.onAck(id, error));
		return sink;
	}

	private onAck(sessionId: string, error: string | null): void {
		// One renderer-wide ack channel: ignore other sessions' traffic.
		if (sessionId !== this.sessionId) return;
		if (error) this.failure ??= new Error(error);
		this.inFlight--;
		this.wake();
	}

	/** Resolve every waiter and let each re-check its own condition. */
	private wake(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) resolve();
	}

	private block(): Promise<void> {
		return new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	/**
	 * Ships one frame, blocking while the window is full.
	 *
	 * The buffer is handed to IPC, which copies it — the caller may reuse it as
	 * soon as this returns.
	 */
	async write(frame: ArrayBuffer): Promise<void> {
		if (this.failure) throw this.failure;
		if (this.closed) throw new Error("Export sink is closed");
		while (this.inFlight >= CREDIT_WINDOW) {
			await this.block();
			if (this.failure) throw this.failure;
			if (this.closed) throw new Error("Export sink is closed");
		}
		this.inFlight++;
		this.api.exportWriteFrame(this.sessionId, frame);
	}

	/** Waits for every in-flight frame to land, then closes ffmpeg's stdin. */
	async finish(): Promise<{ outputPath: string }> {
		if (this.closed) throw new Error("Export sink is closed");
		while (this.inFlight > 0 && !this.failure) {
			await this.block();
		}
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		// ffmpeg is already dying on its own; surface why rather than the timeout
		// that finishing a broken session would produce.
		if (this.failure) {
			await this.api.exportCancel(this.sessionId).catch(() => undefined);
			throw this.failure;
		}
		return this.api.exportFinish(this.sessionId);
	}

	async cancel(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		// Unblock anything parked on a credit: no further ack is coming.
		this.wake();
		await this.api.exportCancel(this.sessionId).catch(() => undefined);
	}
}
