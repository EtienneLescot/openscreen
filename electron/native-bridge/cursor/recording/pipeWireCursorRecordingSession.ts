import { type ChildProcessByStdio, spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { CursorRecordingData } from "../../../../src/native/contracts";
import {
	NdjsonLineReader,
	PipeWireCursorAccumulator,
	type PipeWireHelperEvent,
} from "./pipeWireCursorAccumulator";
import type { CursorRecordingSession } from "./session";

/**
 * Linux cursor recording via the ScreenCast portal's METADATA cursor mode.
 *
 * Why this exists at all: `screen.getCursorScreenPoint()` returns {0,0} under
 * Wayland, so `TelemetryRecordingSession` silently produced recordings whose
 * every sample sat in the top-left corner. The portal is the only source of a
 * real pointer position on Wayland — the compositor keeps the cursor out of the
 * captured pixels and attaches it to each frame as metadata instead.
 *
 * Two consequences the caller should know about:
 *
 *   * `interactionType` is "move" unless the helper could read left-button
 *     presses from evdev — which needs the user in the `input` group, because
 *     Wayland exposes no portal for mouse buttons and /dev/input/event* is
 *     root:input. When it can, the coinciding sample is tagged "click"; when it
 *     cannot, every sample is a move, as before. See the helper's input.rs.
 *   * The helper raises its own portal picker. On Wayland, Electron's
 *     `desktopCapturer` already raised one, so the user currently picks a source
 *     twice. Merging the two is the job of the capture stage that will reuse this
 *     same portal session — SelectSources may only be called once per session,
 *     so it has to be one session doing both.
 *
 * If the helper is missing or fails, this throws rather than falling back to
 * `TelemetryRecordingSession`. The caller (`startCursorRecording` in
 * electron/ipc/handlers.ts) catches that and records without cursor data, which
 * is the honest outcome: no cursor file beats a file full of {0,0}.
 */

const HELPER_NAME = "openscreen-pipewire-helper";
const READY_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 500;

interface PipeWireCursorRecordingSessionOptions {
	maxSamples: number;
	sampleIntervalMs: number;
	startTimeMs?: number;
}

function platformArchTag() {
	return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

function helperCandidates() {
	const envPath = process.env.OPENSCREEN_LINUX_CURSOR_HELPER_EXE?.trim();
	const appRoot = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : process.cwd();
	const archTag = platformArchTag();
	const resourceRoot =
		typeof process.resourcesPath === "string"
			? process.resourcesPath
			: path.join(appRoot, "resources");

	return [
		envPath,
		path.join(appRoot, "electron", "native", "pipewire-capture", "build", HELPER_NAME),
		path.join(appRoot, "electron", "native", "bin", archTag, HELPER_NAME),
		path.join(resourceRoot, "electron", "native", "bin", archTag, HELPER_NAME),
	].filter((candidate): candidate is string => Boolean(candidate));
}

export function findPipeWireCursorHelperPath() {
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

export class PipeWireCursorRecordingSession implements CursorRecordingSession {
	private readonly cursor: PipeWireCursorAccumulator;
	private readonly lines = new NdjsonLineReader();
	private process: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
	private readyResolve: (() => void) | null = null;
	private readyReject: ((error: Error) => void) | null = null;
	private readyTimer: NodeJS.Timeout | null = null;

	constructor(private readonly options: PipeWireCursorRecordingSessionOptions) {
		this.cursor = new PipeWireCursorAccumulator(options.maxSamples);
	}

	async start(): Promise<void> {
		this.cursor.reset(this.options.startTimeMs ?? Date.now());
		this.lines.reset();

		const helperPath = findPipeWireCursorHelperPath();
		if (!helperPath) {
			throw new Error(
				"Linux cursor helper is not available. Build it with `npm run build:native:linux`.",
			);
		}

		const child = spawn(
			helperPath,
			[JSON.stringify({ sampleIntervalMs: this.options.sampleIntervalMs })],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		this.process = child;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdoutChunk(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			const message = chunk.trim();
			if (message) {
				console.error("[cursor-linux]", message);
			}
		});
		child.once("exit", (code, signal) => {
			this.rejectReady(
				new Error(`Linux cursor helper exited before ready (code=${code}, signal=${signal})`),
			);
			this.process = null;
		});
		child.once("error", (error) => {
			this.rejectReady(error);
			this.process = null;
		});

		try {
			await this.waitUntilReady();
		} catch (error) {
			this.killHelperProcess(child);
			this.process = null;
			throw error;
		}
	}

	async stop(): Promise<CursorRecordingData> {
		const child = this.process;
		this.process = null;
		this.clearReadyState();

		if (child) {
			// `stop` on stdin lets the helper close the portal session cleanly;
			// SIGTERM is the fallback if it does not exit promptly.
			try {
				child.stdin.write("stop\n");
				child.stdin.end();
			} catch {
				// The pipe may already be closed if the helper died on its own.
			}
			this.killHelperProcess(child, STOP_GRACE_MS);
		}

		return this.cursor.toRecordingData();
	}

	private handleStdoutChunk(chunk: string) {
		this.lines.push(chunk, (line) => {
			try {
				this.handleEvent(JSON.parse(line) as PipeWireHelperEvent);
			} catch (error) {
				console.error("Failed to parse Linux cursor helper output:", error, line);
			}
		});
	}

	private handleEvent(payload: PipeWireHelperEvent) {
		switch (payload.event) {
			case "ready":
				this.resolveReady();
				return;
			case "stream-started":
				console.info(
					"[cursor-linux] portal stream started",
					JSON.stringify({
						nodeId: payload.nodeId,
						width: payload.width,
						height: payload.height,
					}),
				);
				return;
			case "cursor-sample":
				this.cursor.addSample(payload);
				return;
			case "warning":
				console.warn(`[cursor-linux] ${payload.code}: ${payload.message}`);
				return;
			case "error":
				console.error(`[cursor-linux] ${payload.code}: ${payload.message}`);
				this.rejectReady(new Error(payload.message));
				return;
			case "debug":
				console.info("[cursor-linux][debug]", JSON.stringify(payload));
				return;
		}
	}

	private waitUntilReady() {
		return new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
			this.readyTimer = setTimeout(() => {
				this.rejectReady(new Error("Timed out waiting for Linux cursor helper"));
			}, READY_TIMEOUT_MS);
		});
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

	private killHelperProcess(child: ChildProcessByStdio<Writable, Readable, Readable>, graceMs = 0) {
		if (child.killed) {
			return;
		}

		const terminate = () => {
			if (!child.killed) {
				child.kill("SIGTERM");
			}
			setTimeout(() => {
				if (!child.killed) {
					child.kill("SIGKILL");
				}
			}, 500).unref();
		};

		if (graceMs > 0) {
			setTimeout(terminate, graceMs).unref();
			return;
		}
		terminate();
	}
}
