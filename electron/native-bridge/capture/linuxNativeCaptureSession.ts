import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { CursorRecordingData } from "../../../src/native/contracts";
import {
	NdjsonLineReader,
	PipeWireCursorAccumulator,
	type PipeWireHelperEvent,
} from "../cursor/recording/pipeWireCursorAccumulator";
import { findPipeWireCursorHelperPath } from "../cursor/recording/pipeWireCursorRecordingSession";

/**
 * Drives the Linux capture helper for a full recording: video, audio and cursor
 * telemetry from ONE portal session.
 *
 * WHY ONE SESSION MATTERS ENOUGH TO BUILD THIS. `SelectSources` may be called
 * once per portal session, so a second process means a second picker. Before
 * this, Linux users picked a source twice — once for Chromium's
 * `getDisplayMedia` and once for the cursor helper — and the two captures could
 * legitimately be of different things, because each picker was answered
 * separately. That is also why the cursor overlay never lined up: the telemetry
 * described one stream and the pixels came from another.
 *
 * TIMEOUTS. `ready` arrives in milliseconds and means the helper loaded
 * libpipewire and reached the portal. `capture-started` cannot arrive until a
 * human has clicked through the compositor's dialog, which has no upper bound —
 * so it is deliberately NOT on a timer. The caller shows its own UI for that
 * wait; a timeout here would cancel recordings whose user was merely reading the
 * dialog.
 */

const READY_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 15_000;

export interface LinuxCaptureConfig {
	outputPath: string;
	cursorMode: "metadata" | "embedded";
	fps: number;
	bitrate?: number;
	audio: {
		system: { enabled: boolean };
		microphone: { enabled: boolean; deviceName?: string; gain: number };
	};
	maxCursorSamples: number;
	/**
	 * Negotiate the portal and stop there, until [`arm`] is called.
	 *
	 * Splits "the user has chosen what to share" from "pixels are flowing" so a
	 * countdown can sit between them. Without it the countdown runs first and the
	 * picker appears afterwards, which is backwards: the picker's wait has no
	 * upper bound, so the countdown finishes while the user is still reading a
	 * dialog they have not been shown yet.
	 */
	deferStart?: boolean;
}

/** What the portal handed over. `undefined` means the backend did not say. */
export type LinuxCaptureSourceKind = "monitor" | "window" | "virtual";

export interface LinuxCaptureResult {
	path: string;
	durationMs: number;
	frames: number;
	droppedFrames: number;
	cursor: CursorRecordingData;
	/** What the portal actually granted, when it said. */
	sourceKind?: LinuxCaptureSourceKind;
	videoEncoder?: string;
}

export class LinuxNativeCaptureSession {
	private readonly cursor: PipeWireCursorAccumulator;
	private readonly lines = new NdjsonLineReader();
	private process: ChildProcessByStdio<Writable, Readable, Readable> | null = null;

	private readyResolve: (() => void) | null = null;
	private readyReject: ((error: Error) => void) | null = null;
	private readyTimer: NodeJS.Timeout | null = null;

	private startedResolve: (() => void) | null = null;
	private startedReject: ((error: Error) => void) | null = null;

	private sourceSelected = false;
	private sourceSelectedResolve: (() => void) | null = null;
	private sourceSelectedReject: ((error: Error) => void) | null = null;
	private armed = false;

	private stopped: LinuxCaptureResult | null = null;
	private stoppedResolve: (() => void) | null = null;
	private stoppedReject: ((error: Error) => void) | null = null;

	private sourceKind: LinuxCaptureSourceKind | undefined;
	private videoEncoder: string | undefined;
	private lastError: string | null = null;
	private paused = false;

	constructor(private readonly config: LinuxCaptureConfig) {
		this.cursor = new PipeWireCursorAccumulator(config.maxCursorSamples);
	}

	/**
	 * Spawns the helper and resolves once it reports `ready` — which is BEFORE
	 * the portal picker is raised. Call [`waitUntilCapturing`] to wait for the
	 * user to answer it.
	 */
	async start(): Promise<void> {
		const helperPath = findPipeWireCursorHelperPath();
		if (!helperPath) {
			throw new Error(
				"The Linux capture helper is not available. Build it with `npm run build:native:linux`.",
			);
		}

		this.cursor.reset(Date.now());
		this.lines.reset();

		const request = {
			outputPath: this.config.outputPath,
			cursorMode: this.config.cursorMode,
			video: {
				fps: this.config.fps,
				...(this.config.bitrate ? { bitrate: this.config.bitrate } : {}),
			},
			audio: this.config.audio,
			...(this.config.deferStart ? { deferStart: true } : {}),
		};

		const child = spawn(helperPath, [JSON.stringify(request)], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			const message = chunk.trim();
			if (message) {
				console.error("[capture-linux]", message);
			}
		});
		child.once("exit", (code, signal) => {
			this.process = null;
			const reason =
				this.lastError ??
				`the Linux capture helper exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
			this.rejectReady(new Error(reason));
			this.startedReject?.(new Error(reason));
			this.startedReject = null;
			this.startedResolve = null;
			// A session held open across a countdown can die before it is armed —
			// the user revoking the share from the compositor's indicator, or
			// closing the window they picked. Whoever is waiting on the picker
			// has to learn that rather than wait forever.
			this.sourceSelectedReject?.(new Error(reason));
			this.sourceSelectedReject = null;
			this.sourceSelectedResolve = null;
			// A clean exit after `capture-stopped` is the normal path; anything
			// else means the file may not have its trailer.
			if (this.stopped) {
				this.stoppedResolve?.();
			} else {
				this.stoppedReject?.(new Error(reason));
			}
			this.stoppedResolve = null;
			this.stoppedReject = null;
		});
		child.once("error", (error) => {
			this.process = null;
			this.rejectReady(error);
		});

		try {
			await new Promise<void>((resolve, reject) => {
				this.readyResolve = resolve;
				this.readyReject = reject;
				this.readyTimer = setTimeout(() => {
					this.rejectReady(new Error("Timed out waiting for the Linux capture helper"));
				}, READY_TIMEOUT_MS);
			});
		} catch (error) {
			this.kill();
			throw error;
		}
	}

	/**
	 * Resolves once the user has answered the compositor's picker.
	 *
	 * No timeout, for the same reason as [`waitUntilCapturing`]: a human is
	 * reading a dialog and there is no upper bound on that. Resolves immediately
	 * if the answer already arrived, so callers need not race the event.
	 *
	 * A session started WITHOUT `deferStart` still reports this — it simply
	 * arrives moments before capture rather than being waited on.
	 */
	waitUntilSourceSelected(): Promise<void> {
		if (this.sourceSelected) {
			return Promise.resolve();
		}
		if (!this.process) {
			return Promise.reject(new Error("The Linux capture helper is not running."));
		}
		return new Promise<void>((resolve, reject) => {
			this.sourceSelectedResolve = resolve;
			this.sourceSelectedReject = reject;
		});
	}

	/**
	 * Releases a deferred session: connect to PipeWire and start encoding.
	 *
	 * Safe to call on a session that was not deferred (the helper ignores the
	 * verb) and safe to call twice, so a caller never has to track whether a
	 * prepare happened.
	 */
	arm() {
		if (this.armed) {
			return;
		}
		this.armed = true;
		this.write("record");
	}

	/**
	 * Resolves when the first frame has been encoded — i.e. once the user has
	 * answered the portal picker. No timeout, on purpose: see the class doc.
	 */
	waitUntilCapturing(): Promise<void> {
		if (!this.process) {
			return Promise.reject(new Error("The Linux capture helper is not running."));
		}
		return new Promise<void>((resolve, reject) => {
			this.startedResolve = resolve;
			this.startedReject = reject;
		});
	}

	pause() {
		if (this.paused) {
			return;
		}
		this.paused = true;
		this.write("pause");
	}

	resume() {
		if (!this.paused) {
			return;
		}
		this.paused = false;
		this.write("resume");
	}

	get isPaused() {
		return this.paused;
	}

	/**
	 * What the portal granted. Known from `stream-started`, so it is populated by
	 * the time [`waitUntilCapturing`] resolves.
	 *
	 * `undefined` means the backend did not report a kind — which is NOT the same
	 * as "a screen", and callers must not collapse the two. Guessing is what this
	 * whole field exists to stop.
	 */
	get grantedSourceKind(): LinuxCaptureSourceKind | undefined {
		return this.sourceKind;
	}

	/**
	 * Asks the helper to write the trailer and exit, then returns what it made.
	 *
	 * Waits for the PROCESS to exit rather than for `capture-stopped` alone: the
	 * MP4's moov atom is written during teardown, and returning a path to a file
	 * whose index is still being written would hand the app an unplayable
	 * recording.
	 */
	async stop(): Promise<LinuxCaptureResult> {
		const child = this.process;
		if (!child) {
			if (this.stopped) {
				return this.stopped;
			}
			throw new Error("The Linux capture helper is not running.");
		}

		const exited = new Promise<void>((resolve, reject) => {
			this.stoppedResolve = resolve;
			this.stoppedReject = reject;
		});
		this.write("stop");
		try {
			child.stdin.end();
		} catch {
			// Already closed if the helper died on its own; the exit handler runs.
		}

		const timer = setTimeout(() => {
			console.error("[capture-linux] helper did not exit in time; terminating");
			this.kill();
		}, STOP_TIMEOUT_MS);
		try {
			await exited;
		} finally {
			clearTimeout(timer);
		}

		if (!this.stopped) {
			throw new Error(this.lastError ?? "The Linux capture helper produced no output file.");
		}
		return this.stopped;
	}

	/** Kills the helper and discards whatever it wrote. */
	discard() {
		this.kill();
	}

	private write(command: string) {
		try {
			this.process?.stdin.write(`${command}\n`);
		} catch {
			// The helper is gone; stop()/exit already reports that.
		}
	}

	private kill() {
		const child = this.process;
		if (!child || child.killed) {
			return;
		}
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) {
				child.kill("SIGKILL");
			}
		}, 500).unref();
	}

	private handleStdout(chunk: string) {
		this.lines.push(chunk, (line) => {
			let payload: PipeWireHelperEvent;
			try {
				payload = JSON.parse(line) as PipeWireHelperEvent;
			} catch (error) {
				console.error("Failed to parse Linux capture helper output:", error, line);
				return;
			}
			this.handleEvent(payload);
		});
	}

	private handleEvent(payload: PipeWireHelperEvent) {
		switch (payload.event) {
			case "ready":
				this.resolveReady();
				return;

			case "source-selected":
				if (payload.sourceKind) {
					this.sourceKind = payload.sourceKind;
				}
				this.sourceSelected = true;
				console.info(
					"[capture-linux] source selected",
					JSON.stringify({ sourceKind: payload.sourceKind ?? null }),
				);
				this.sourceSelectedResolve?.();
				this.sourceSelectedResolve = null;
				this.sourceSelectedReject = null;
				return;

			case "stream-started":
				if (payload.sourceKind) {
					this.sourceKind = payload.sourceKind;
				}
				// The source kind is logged unconditionally for the same reason
				// as the audio node: when someone reports "I picked a window and
				// got my whole screen", this line is the answer, and it is the
				// only place the truth appears — the app cannot name a source
				// when asking the portal, so nothing upstream knows it.
				console.info(
					"[capture-linux] portal stream started",
					JSON.stringify({
						width: payload.width,
						height: payload.height,
						sourceKind: payload.sourceKind ?? null,
					}),
				);
				return;

			case "audio-source":
				// Logged unconditionally: when someone reports "that is not my
				// microphone", this line is the answer.
				console.info(
					"[capture-linux] audio source",
					JSON.stringify({
						role: payload.role,
						requested: payload.requested ?? null,
						node: payload.node ?? null,
					}),
				);
				if (payload.requested && !payload.node) {
					console.warn(
						`[capture-linux] no PipeWire node matched ${JSON.stringify(payload.requested)}; ` +
							"the session default source was recorded instead",
					);
				}
				return;

			case "encoder-selection":
				this.videoEncoder = payload.video;
				console.info(
					"[capture-linux] encoder",
					JSON.stringify({ video: payload.video, rejected: payload.rejected ?? [] }),
				);
				return;

			case "capture-started":
				// Cursor samples started flowing when the helper did, which was
				// before the portal picker. The recording's zero is HERE, so the
				// telemetry is re-based onto it and anything from during the
				// picker is dropped rather than left pinned to the start.
				this.cursor.rebase(payload.timestampMs);
				console.info(
					"[capture-linux] capture started",
					JSON.stringify({ width: payload.width, height: payload.height, fps: payload.fps }),
				);
				this.startedResolve?.();
				this.startedResolve = null;
				this.startedReject = null;
				return;

			case "cursor-sample":
				this.cursor.addSample(payload);
				return;

			case "capture-stopped":
				this.stopped = {
					path: payload.path,
					durationMs: payload.durationMs,
					frames: payload.frames,
					droppedFrames: payload.dropped,
					cursor: this.cursor.toRecordingData(),
					...(this.sourceKind ? { sourceKind: this.sourceKind } : {}),
					...(this.videoEncoder ? { videoEncoder: this.videoEncoder } : {}),
				};
				console.info(
					"[capture-linux] capture stopped",
					JSON.stringify({
						frames: payload.frames,
						dropped: payload.dropped,
						durationMs: payload.durationMs,
						convertMs: payload.convertMs,
						uploadMs: payload.uploadMs,
						encodeMs: payload.encodeMs,
					}),
				);
				return;

			case "warning":
				console.warn(`[capture-linux] ${payload.code}: ${payload.message}`);
				return;

			case "error":
				console.error(`[capture-linux] ${payload.code}: ${payload.message}`);
				// Kept so the process-exit handler can report the CAUSE rather
				// than just the exit code, which on its own says nothing useful.
				this.lastError = payload.message;
				this.rejectReady(new Error(payload.message));
				this.sourceSelectedReject?.(new Error(payload.message));
				this.sourceSelectedReject = null;
				this.sourceSelectedResolve = null;
				return;

			case "debug":
				console.info("[capture-linux][debug]", JSON.stringify(payload));
				return;
		}
	}

	private resolveReady() {
		const resolve = this.readyResolve;
		this.clearReadyState();
		resolve?.();
	}

	private rejectReady(error: Error) {
		const reject = this.readyReject;
		this.clearReadyState();
		reject?.(error);
	}

	private clearReadyState() {
		if (this.readyTimer) {
			clearTimeout(this.readyTimer);
			this.readyTimer = null;
		}
		this.readyResolve = null;
		this.readyReject = null;
	}
}
