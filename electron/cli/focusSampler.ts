// Spawns the macOS focus-telemetry helper during `record --follow-windows`
// and buffers its NDJSON samples. The CLI controller starts it when the
// capture begins and writes the collected timeline as a `<video>.focus.json`
// sidecar when the recording finishes.

import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { screen } from "electron";
import type {
	FocusDisplayInfo,
	FocusRecordingData,
	FocusSample,
} from "../../src/lib/windowFocus/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FOCUS_HELPER_NAME = "openscreen-macos-focus-helper";
const SAMPLE_INTERVAL_MS = 200;

interface RawHelperSample {
	type?: string;
	timestampMs?: number;
	windowNumber?: number;
	appName?: string;
	windowTitle?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	displayId?: number;
}

function resolveFocusHelperPath(): string | null {
	const archTag = `darwin-${process.arch === "arm64" ? "arm64" : "x64"}`;
	const candidates = [
		process.env.OPENSCREEN_MAC_FOCUS_HELPER_EXE?.trim(),
		path.join(
			__dirname,
			"..",
			"electron",
			"native",
			"screencapturekit",
			"build",
			FOCUS_HELPER_NAME,
		),
		path.join(__dirname, "..", "electron", "native", "bin", archTag, FOCUS_HELPER_NAME),
		process.resourcesPath
			? path.join(process.resourcesPath, "electron", "native", "bin", archTag, FOCUS_HELPER_NAME)
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

export function isFocusSamplingAvailable(): boolean {
	return process.platform === "darwin" && resolveFocusHelperPath() !== null;
}

export class FocusSampler {
	private child: ChildProcess | null = null;
	private rawSamples: RawHelperSample[] = [];
	private startedAtEpochMs: number | null = null;
	private stdoutRemainder = "";
	private lastError = "";
	private sawReady = false;
	private exitCode: number | string | null = null;

	diagnostics(): string {
		return JSON.stringify({
			started: this.startedAtEpochMs !== null,
			sawReady: this.sawReady,
			rawSamples: this.rawSamples.length,
			exitCode: this.exitCode,
			lastError: this.lastError,
		});
	}

	start(): void {
		if (this.child) return;
		const helperPath = resolveFocusHelperPath();
		if (!helperPath) {
			throw new Error("Focus helper is not available. Build it with: npm run build:native:mac");
		}

		this.startedAtEpochMs = Date.now();
		this.child = spawn(helperPath, [JSON.stringify({ sampleIntervalMs: SAMPLE_INTERVAL_MS })], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.child.stdout?.setEncoding("utf8");
		this.child.stdout?.on("data", (chunk: string) => {
			this.stdoutRemainder += chunk;
			const lines = this.stdoutRemainder.split("\n");
			this.stdoutRemainder = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed) as RawHelperSample;
					if (parsed.type === "ready") {
						this.sawReady = true;
					} else if (parsed.type === "sample") {
						this.rawSamples.push(parsed);
					}
				} catch {
					// Ignore malformed helper output lines.
				}
			}
		});
		this.child.stderr?.setEncoding("utf8");
		this.child.stderr?.on("data", (chunk: string) => {
			this.lastError = chunk.slice(0, 500);
		});
		this.child.on("exit", (code, signal) => {
			this.exitCode = code ?? signal ?? "unknown";
		});
		this.child.on("error", (error) => {
			this.lastError = String(error);
			this.child = null;
		});
	}

	/** Stops the helper and converts the buffer into sidecar data. */
	stop(recordedDisplayId: number): FocusRecordingData | null {
		const startedAt = this.startedAtEpochMs;
		if (this.child) {
			this.child.kill("SIGTERM");
			this.child = null;
		}
		if (startedAt === null) return null;

		const displays: FocusDisplayInfo[] = screen.getAllDisplays().map((display) => ({
			id: display.id,
			bounds: display.bounds,
			scaleFactor: display.scaleFactor,
			isPrimary: display.id === screen.getPrimaryDisplay().id,
		}));

		const samples: FocusSample[] = [];
		for (const raw of this.rawSamples) {
			if (
				typeof raw.timestampMs !== "number" ||
				typeof raw.width !== "number" ||
				typeof raw.height !== "number"
			) {
				continue;
			}
			samples.push({
				timeMs: Math.max(0, raw.timestampMs - startedAt),
				windowNumber: raw.windowNumber ?? 0,
				appName: raw.appName ?? "",
				windowTitle: raw.windowTitle ?? "",
				x: raw.x ?? 0,
				y: raw.y ?? 0,
				width: raw.width,
				height: raw.height,
				displayId: raw.displayId ?? 0,
			});
		}

		return { version: 1, recordedDisplayId, displays, samples };
	}
}

export function resolveRecordedDisplayId(displayIndex: number): number {
	// The CLI's --display index maps to desktopCapturer's screen ordering,
	// which matches Electron's display list order on macOS.
	const displays = screen.getAllDisplays();
	const display = displays[displayIndex] ?? screen.getPrimaryDisplay();
	return display.id;
}
