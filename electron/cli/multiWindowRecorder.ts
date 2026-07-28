// Orchestrates `record --windows "a,b,c"`: one ScreenCaptureKit helper per
// matched window (all captured continuously and cleanly, even when occluded)
// plus the focus sampler. Runs entirely in the main process — no renderer.
//
// Output: one MP4 per window in the recordings directory, and a
// `<primary>.multiwindow.json` manifest binding the videos to the focus
// timeline for the export step's window-switch compositor.

import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, desktopCapturer } from "electron";
import type { CapturedWindow, MultiWindowManifest } from "../../src/lib/windowSwitch/contracts";
import { FocusSampler, resolveRecordedDisplayId } from "./focusSampler";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CAPTURE_HELPER_NAME = "openscreen-screencapturekit-helper";
const TARGET_FPS = 60;
const TARGET_WIDTH = 3840;
const TARGET_HEIGHT = 2160;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 20_000;

function resolveCaptureHelperPath(): string | null {
	const archTag = `darwin-${process.arch === "arm64" ? "arm64" : "x64"}`;
	const candidates = [
		process.env.OPENSCREEN_SCK_CAPTURE_EXE?.trim(),
		path.join(
			__dirname,
			"..",
			"electron",
			"native",
			"screencapturekit",
			"build",
			CAPTURE_HELPER_NAME,
		),
		path.join(__dirname, "..", "electron", "native", "bin", archTag, CAPTURE_HELPER_NAME),
		process.resourcesPath
			? path.join(process.resourcesPath, "electron", "native", "bin", archTag, CAPTURE_HELPER_NAME)
			: undefined,
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next location.
		}
	}
	return null;
}

function parseWindowIdFromSourceId(sourceId: string): number | null {
	// macOS desktopCapturer window source ids look like "window:<CGWindowID>:0".
	const match = /^window:(\d+)/.exec(sourceId);
	return match ? Number(match[1]) : null;
}

interface MultiHelperSession {
	child: ChildProcess;
	/** Resolves once every window has emitted recording-started. */
	allStarted: Promise<void>;
	/** Resolves with the finalized paths once every window has stopped. */
	allStopped: Promise<string[]>;
}

// One helper process captures every window: a second helper *process* would
// interrupt the first stream (SCStreamErrorDomain -3805), but multiple
// SCStreams coexist happily inside a single process.
function spawnMultiWindowCapture(
	helperPath: string,
	recordingsDir: string,
	targets: { windowId: number; sourceId: string; screenPath: string }[],
): MultiHelperSession {
	const request = {
		schemaVersion: 1,
		recordingId: Date.now(),
		source: {
			type: "window",
			sourceId: targets[0].sourceId,
			windowId: targets[0].windowId,
		},
		video: {
			fps: TARGET_FPS,
			width: TARGET_WIDTH,
			height: TARGET_HEIGHT,
			hideSystemCursor: false,
		},
		audio: {
			system: { enabled: false },
			microphone: { enabled: false, gain: 1 },
		},
		webcam: { enabled: false, width: 0, height: 0, fps: 30 },
		cursor: { mode: "system" },
		outputs: { screenPath: targets[0].screenPath },
		multiWindows: targets,
	};

	const child = spawn(helperPath, [JSON.stringify(request)], {
		cwd: recordingsDir,
		stdio: ["pipe", "pipe", "pipe"],
	});

	let startedCount = 0;
	const stoppedPaths: string[] = [];
	let resolveAllStarted: () => void;
	let rejectAllStarted: (error: Error) => void;
	const allStarted = new Promise<void>((resolve, reject) => {
		resolveAllStarted = resolve;
		rejectAllStarted = reject;
	});
	let resolveAllStopped: (paths: string[]) => void;
	let rejectAllStopped: (error: Error) => void;
	const allStopped = new Promise<string[]>((resolve, reject) => {
		resolveAllStopped = resolve;
		rejectAllStopped = reject;
	});

	let remainder = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		remainder += chunk;
		const lines = remainder.split("\n");
		remainder = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("{")) continue;
			try {
				const event = JSON.parse(trimmed) as {
					event?: string;
					message?: string;
					screenPath?: string;
				};
				if (event.event === "recording-started") {
					startedCount++;
					if (startedCount === targets.length) resolveAllStarted();
				} else if (event.event === "recording-stopped") {
					if (event.screenPath) stoppedPaths.push(event.screenPath);
					if (stoppedPaths.length === targets.length) {
						// Preserve the requested window order regardless of finalize order.
						const ordered = targets.map((target) => {
							const match = stoppedPaths.find((candidate) => candidate === target.screenPath);
							return match ?? target.screenPath;
						});
						resolveAllStopped(ordered);
					}
				} else if (event.event === "error") {
					const error = new Error(event.message ?? "Native capture error");
					rejectAllStarted(error);
					rejectAllStopped(error);
				}
			} catch {
				// Non-JSON helper chatter.
			}
		}
	});
	let stderrTail = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderrTail = (stderrTail + chunk).slice(-500);
	});
	child.on("exit", (code) => {
		const error = new Error(
			`Capture helper exited (${code})${stderrTail ? `: ${stderrTail}` : ""}`,
		);
		rejectAllStarted(error);
		rejectAllStopped(error);
	});
	child.on("error", (error) => {
		rejectAllStarted(error as Error);
		rejectAllStopped(error as Error);
	});

	return { child, allStarted, allStopped };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
		),
	]);
}

export interface MultiWindowRecordingHandle {
	/** Resolves when every window capture has emitted recording-started. */
	allStarted: Promise<void>;
	windowSummaries: { appName: string; title: string }[];
	stop: () => Promise<{
		manifestPath: string;
		primaryVideoPath: string;
		videoPaths: string[];
		durationMs: number;
		focusSampleCount: number;
	}>;
}

export async function startMultiWindowRecording(
	titleFilters: string[],
	displayIndex: number,
): Promise<MultiWindowRecordingHandle> {
	if (process.platform !== "darwin") {
		throw new Error("--windows capture is currently macOS-only");
	}
	const helperPath = resolveCaptureHelperPath();
	if (!helperPath) {
		throw new Error("Native capture helper missing; build it with: npm run build:native:mac");
	}

	const sources = await desktopCapturer.getSources({
		types: ["window"],
		thumbnailSize: { width: 0, height: 0 },
		fetchWindowIcons: false,
	});

	const matched: { windowId: number; sourceId: string; title: string }[] = [];
	for (const filter of titleFilters) {
		const needle = filter.toLowerCase();
		const source = sources.find(
			(candidate) =>
				candidate.name.toLowerCase().includes(needle) &&
				parseWindowIdFromSourceId(candidate.id) !== null &&
				!matched.some((m) => m.sourceId === candidate.id),
		);
		if (!source) {
			const available = sources.map((candidate) => `  - ${candidate.name}`).join("\n");
			throw new Error(`No window title contains "${filter}". Open windows:\n${available}`);
		}
		matched.push({
			windowId: parseWindowIdFromSourceId(source.id) as number,
			sourceId: source.id,
			title: source.name,
		});
	}
	if (matched.length < 2) {
		throw new Error("--windows needs at least two comma-separated window titles");
	}

	const recordingsDir = path.join(app.getPath("userData"), "recordings");
	await fs.mkdir(recordingsDir, { recursive: true });
	const recordingId = Date.now();

	const focusSampler = new FocusSampler();
	focusSampler.start();
	const startedAt = Date.now();

	const session = spawnMultiWindowCapture(
		helperPath,
		recordingsDir,
		matched.map((window, index) => ({
			windowId: window.windowId,
			sourceId: window.sourceId,
			screenPath: path.join(recordingsDir, `recording-${recordingId}-w${index}.mp4`),
		})),
	);

	const allStarted = withTimeout(
		session.allStarted,
		START_TIMEOUT_MS,
		"Window capture start",
	).catch(async (error) => {
		session.child.kill("SIGKILL");
		focusSampler.stop(0);
		throw error;
	});

	const stop = async () => {
		const durationMs = Date.now() - startedAt;
		session.child.stdin?.write("stop\n");
		const videoPaths = await withTimeout(
			session.allStopped,
			STOP_TIMEOUT_MS,
			"Window capture stop",
		);
		const focusData = focusSampler.stop(resolveRecordedDisplayId(displayIndex));

		const windows: CapturedWindow[] = matched.map((window, index) => {
			const focusMatch = focusData?.samples.find(
				(sample) => sample.windowNumber === window.windowId,
			);
			return {
				windowId: window.windowId,
				appName: focusMatch?.appName ?? "",
				title: window.title,
				videoPath: videoPaths[index],
				bounds: focusMatch
					? {
							x: focusMatch.x,
							y: focusMatch.y,
							width: focusMatch.width,
							height: focusMatch.height,
						}
					: { x: 0, y: 0, width: 0, height: 0 },
			};
		});

		const manifest: MultiWindowManifest = {
			version: 1,
			windows,
			focus: focusData ?? {
				version: 1,
				recordedDisplayId: 0,
				displays: [],
				samples: [],
			},
			durationMs,
		};
		const primaryVideoPath = videoPaths[0];
		const manifestPath = `${primaryVideoPath}.multiwindow.json`;
		await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");

		return {
			manifestPath,
			primaryVideoPath,
			videoPaths,
			durationMs,
			focusSampleCount: focusData?.samples.length ?? 0,
		};
	};

	return {
		allStarted,
		windowSummaries: matched.map((window) => ({ appName: "", title: window.title })),
		stop,
	};
}
