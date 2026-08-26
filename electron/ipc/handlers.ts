import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DesktopCapturerSource, Rectangle } from "electron";
import {
	app,
	BrowserWindow,
	desktopCapturer,
	dialog,
	ipcMain,
	screen,
	shell,
	systemPreferences,
} from "electron";
import {
	type NativeLinuxRecordingRequest,
	portalCursorMode,
} from "../../src/lib/nativeLinuxRecording";
import type { NativeMacRecordingRequest } from "../../src/lib/nativeMacRecording";
import type { NativeWindowsRecordingRequest } from "../../src/lib/nativeWindowsRecording";
import {
	type CursorCaptureMode,
	normalizeCursorCaptureMode,
	normalizeProjectMedia,
	normalizeRecordingSession,
	type ProjectMedia,
	type RecordedVideoAssetInput,
	type RecordingSession,
	type StoreRecordedSessionInput,
} from "../../src/lib/recordingSession";
import type {
	CursorRecordingData,
	CursorRecordingSample,
	ProjectFileResult,
	ProjectPathResult,
} from "../../src/native/contracts";
import {
	compactSessionNow,
	createSession,
	deleteSession,
	getSessionContextUsage,
	listSessions,
	renameSession,
	rewindToMessage,
	runChat,
	selectSession,
} from "../ai-edition/chat-service";
import type { CursorTelemetryReader } from "../ai-edition/deep-agent/service";
import { DocumentService } from "../ai-edition/document-service";
import { LlmConfigStore } from "../ai-edition/llm-config-store";
import { isDiagnosticModeEnabled, mainLogBuffer } from "../diagnostics/main-log-buffer";
import { mainT } from "../i18n";
import { getInstallChannel } from "../install-channel";
import { RECORDINGS_DIR } from "../main";
import { type AudioPeaksResult, getAudioPeaks } from "../media/audioPeaks";
import {
	readCursorRecordingFile as readCursorRecordingFileFrom,
	readCursorSidecar,
	readCursorTelemetryFile as readCursorTelemetryFileFrom,
} from "../media/cursorSidecar";
import { findMediaLinksByFingerprint, registerMediaLinks } from "../media/mediaLinksRegistry";
import { relinkProjectMedia } from "../media/projectMediaRelinker";
import {
	type LinuxCaptureSourceKind,
	LinuxNativeCaptureSession,
} from "../native-bridge/capture/linuxNativeCaptureSession";
import { createCursorRecordingSession } from "../native-bridge/cursor/recording/factory";
import { requestMacCursorAccessibilityAccess } from "../native-bridge/cursor/recording/macNativeCursorRecordingSession";
import { findPipeWireCursorHelperPath } from "../native-bridge/cursor/recording/pipeWireCursorRecordingSession";
import type { CursorRecordingSession } from "../native-bridge/cursor/recording/session";
import { toHelperRect } from "../native-bridge/helperCoordinates";
import { scoreDeviceNameMatch } from "../recording/deviceNameMatching";
import {
	isSalvageableFragmentedCapture,
	NATIVE_WINDOWS_SALVAGEABLE_OUTPUT_BYTES,
	readMicrophoneDefaulted,
	readWebcamFormat,
	readWebcamUnavailable,
	terminateNativeWindowsCapture,
	waitForNativeWindowsCaptureStop,
} from "../recording/nativeWindowsCaptureStop";
import { patchWebmDurationOnDisk } from "../recording/webm-duration";
import { reindexRecordingOnDisk } from "../recording/webm-seek-index";
import { registerNativeBridgeHandlers } from "./nativeBridge";
import { RecordingStreamRegistry, registerRecordingStreamHandlers } from "./recordingStream";

const PROJECT_FILE_EXTENSION = "openscreen";
export const SHORTCUTS_FILE = path.join(app.getPath("userData"), "shortcuts.json");
const RECORDING_FILE_PREFIX = "recording-";
const RECORDING_SESSION_SUFFIX = ".session.json";
const ALLOWED_IMPORT_VIDEO_EXTENSIONS = new Set([
	".webm",
	".mp4",
	".mov",
	".avi",
	".mkv",
	".m4v",
	".wmv",
	".flv",
	".ts",
]);
const PREVIEW_AUDIO_DIR = path.join(app.getPath("userData"), "preview-audio");
const nativeMacCaptureEvents = new EventEmitter();

// Enumeration walks every display and window and grabs a thumbnail of each, so it
// is allowed to be slow on a loaded machine. It is not allowed to be unbounded.
// Deliberately above the CLI runner's own 20s bound, so the more specific message
// there still wins for `openscreen sources`; this is the backstop for everything
// else that calls get-sources.
const GET_SOURCES_TIMEOUT_MS = 30_000;

/**
 * Reject if `work` has not settled within `ms`.
 *
 * The abandoned promise keeps running — there is no way to cancel a
 * desktopCapturer call — so this bounds the *wait*, not the work. That is the
 * whole available remedy: an unbounded await leaves a caller with no error and no
 * way out, which is strictly worse than a late failure it can report.
 */
function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		}),
	]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Paths the user approved via file picker or project load (i.e. outside the default dirs).
const approvedPaths = new Set<string>();

function approveFilePath(filePath: string): void {
	approvedPaths.add(path.resolve(filePath));
}

function getAllowedReadDirs(): string[] {
	return [RECORDINGS_DIR];
}

function isPathWithinDir(filePath: string, dirPath: string): boolean {
	const resolved = path.resolve(filePath);
	const resolvedDir = path.resolve(dirPath);
	return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

function isPathAllowed(filePath: string): boolean {
	const resolved = path.resolve(filePath);
	if (approvedPaths.has(resolved)) return true;
	return getAllowedReadDirs().some((dir) => isPathWithinDir(resolved, dir));
}

function resolveApprovedVideoPath(videoPath?: string | null): string | null {
	const normalizedPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedPath) {
		return null;
	}

	if (!hasAllowedImportVideoExtension(normalizedPath) || !isPathAllowed(normalizedPath)) {
		return null;
	}

	return normalizedPath;
}

// Attach the parent window only when valid, to avoid passing a destroyed BrowserWindow to dialogs.
function buildDialogOptions<T extends Electron.OpenDialogOptions | Electron.SaveDialogOptions>(
	baseOptions: T,
	parentWindow: BrowserWindow | null,
): T & { parent?: BrowserWindow } {
	const mainWindow = parentWindow;
	if (mainWindow && !mainWindow.isDestroyed()) {
		return { ...baseOptions, parent: mainWindow };
	}
	return baseOptions;
}

function hasAllowedImportVideoExtension(filePath: string): boolean {
	return ALLOWED_IMPORT_VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function runProcess(
	command: string,
	args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function parseAfinfoAudioTrackBitrates(output: string): number[] {
	const bitrates: number[] = [];
	const trackSections = output.split(/\n----\n/g).slice(1);
	for (const section of trackSections) {
		const match = section.match(/\bbit rate:\s*([0-9]+)\s*bits per second/i);
		bitrates.push(match ? Number(match[1]) : 0);
	}
	return bitrates;
}

async function prepareSupplementalPreviewAudioTrack(videoPath: string) {
	const normalizedPath = await approveReadableVideoPath(videoPath);
	if (!normalizedPath) {
		return {
			success: false,
			message: "File path is not approved or is not a supported video file",
		};
	}

	if (process.platform !== "darwin" || path.extname(normalizedPath).toLowerCase() !== ".mp4") {
		return { success: true, path: null };
	}

	const afinfo = await runProcess("/usr/bin/afinfo", [normalizedPath]);
	if (afinfo.code !== 0) {
		return { success: true, path: null };
	}

	const bitrates = parseAfinfoAudioTrackBitrates(`${afinfo.stdout}\n${afinfo.stderr}`);
	if (bitrates.length <= 1) {
		return { success: true, path: null };
	}

	let supplementalTrackIndex = 1;
	for (let index = 2; index < bitrates.length; index += 1) {
		if (bitrates[index] > bitrates[supplementalTrackIndex]) {
			supplementalTrackIndex = index;
		}
	}

	await fs.mkdir(PREVIEW_AUDIO_DIR, { recursive: true });
	const sourceStat = await fs.stat(normalizedPath);
	const parsedPath = path.parse(normalizedPath);
	const outputPath = path.join(
		PREVIEW_AUDIO_DIR,
		`${parsedPath.name}.track-${supplementalTrackIndex}.${Math.round(sourceStat.mtimeMs)}.m4a`,
	);

	try {
		const outputStat = await fs.stat(outputPath);
		if (outputStat.mtimeMs >= sourceStat.mtimeMs) {
			return { success: true, path: pathToFileURL(outputPath).toString() };
		}
	} catch {
		// Generate below.
	}

	const conversion = await runProcess("/usr/bin/afconvert", [
		"--read-track",
		String(supplementalTrackIndex),
		"-f",
		"m4af",
		"-d",
		"aac",
		normalizedPath,
		outputPath,
	]);
	if (conversion.code !== 0) {
		return {
			success: false,
			message: conversion.stderr || conversion.stdout || "Failed to prepare preview audio",
		};
	}

	return { success: true, path: pathToFileURL(outputPath).toString() };
}

async function approveReadableVideoPath(
	filePath?: string | null,
	trustedDirs?: string[],
): Promise<string | null> {
	const normalizedPath = normalizeVideoSourcePath(filePath);
	if (!normalizedPath) {
		return null;
	}

	if (isPathAllowed(normalizedPath)) {
		return normalizedPath;
	}

	if (!hasAllowedImportVideoExtension(normalizedPath)) {
		return null;
	}

	// With trustedDirs (e.g. project load), only auto-approve paths inside them so a
	// malicious project file can't approve reads to arbitrary locations.
	if (trustedDirs) {
		const resolved = path.resolve(normalizedPath);
		const withinTrusted = trustedDirs.some((dir) => isPathWithinDir(resolved, dir));
		if (!withinTrusted) {
			return null;
		}
	}

	try {
		const stats = await fs.stat(normalizedPath);
		if (!stats.isFile()) {
			return null;
		}
	} catch {
		return null;
	}

	approveFilePath(normalizedPath);
	return normalizedPath;
}

function resolveRecordingOutputPath(fileName: string): string {
	const trimmed = fileName.trim();
	if (!trimmed) {
		throw new Error("Invalid recording file name");
	}

	const parsedPath = path.parse(trimmed);
	const hasTraversalSegments = trimmed.split(/[\\/]+/).some((segment) => segment === "..");
	const isNestedPath =
		parsedPath.dir !== "" ||
		path.isAbsolute(trimmed) ||
		trimmed.includes("/") ||
		trimmed.includes("\\");
	if (hasTraversalSegments || isNestedPath || parsedPath.base !== trimmed) {
		throw new Error("Recording file name must not contain path segments");
	}

	return path.join(RECORDINGS_DIR, parsedPath.base);
}

function isValidDurationMs(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Finalize one recording file: flush/close the stream if it was streamed, else write
 * the buffered bytes (short recording or stream failed to open). Returns whether it was
 * streamed, so the caller knows if the WebM duration needs patching on disk.
 */
async function finalizeRecordingFile(
	registry: RecordingStreamRegistry,
	fileName: string,
	filePath: string,
	videoData?: ArrayBuffer,
): Promise<boolean> {
	const streamed = await registry.finalize(fileName);
	if (!streamed && videoData && videoData.byteLength > 0) {
		await fs.writeFile(filePath, Buffer.from(videoData));
	}
	return streamed;
}

/**
 * Give a finalized recording a usable container, by whichever route works.
 *
 * MediaRecorder omits the `Duration` header, so without repair the editor sees
 * `duration = Infinity` and cannot scale its timeline.
 *
 * Two routes, in order of quality:
 *   1. A full container remux through libavformat's matroska muxer (Linux, where
 *      capture goes through MediaRecorder). The muxer derives `Duration` from
 *      the real packet timestamps rather than from the renderer's wall-clock
 *      measurement, and writes `Cues`/`SeekHead` on the way past.
 *   2. The EBML header patch, which splices the caller's `durationMs` into the
 *      Info section. Used on Windows/macOS, and on Linux whenever the remux is
 *      unavailable (no addon, or a `.node` predating it) or fails.
 *
 * Both rewrite the file exactly once, so route 1 is not the more expensive one —
 * it is the same I/O for a strictly better result. Either way a failure leaves
 * the original file intact; a recording is never lost to a failed repair.
 */
async function repairRecordingContainer(filePath: string, durationMs: number): Promise<void> {
	const reindexed = await reindexRecordingOnDisk(filePath);
	if (reindexed.reindexed) {
		console.info(
			`[recording] re-muxed ${path.basename(filePath)}: ${reindexed.packets} packets, ` +
				`${reindexed.streams} streams, ${reindexed.wallS.toFixed(3)}s`,
		);
		return;
	}
	await patchWebmDurationOnDisk(filePath, durationMs);
}

async function getApprovedProjectSession(
	project: unknown,
	projectFilePath?: string,
): Promise<RecordingSession | null> {
	if (!project || typeof project !== "object") {
		return null;
	}

	const rawProject = project as { media?: unknown; videoPath?: unknown };
	const media: ProjectMedia | null =
		normalizeProjectMedia(rawProject.media) ??
		(typeof rawProject.videoPath === "string"
			? {
					screenVideoPath: normalizeVideoSourcePath(rawProject.videoPath) ?? rawProject.videoPath,
				}
			: null);

	if (!media) {
		return null;
	}

	// Only auto-approve media within the project's dir or RECORDINGS_DIR, so a crafted
	// project file can't approve reads to arbitrary locations.
	const trustedDirs = [RECORDINGS_DIR];
	if (projectFilePath) {
		trustedDirs.push(path.dirname(path.resolve(projectFilePath)));
	}

	// Packed/portable projects: when the stored absolute path no longer exists
	// (project moved to another machine or directory), fall back to a file with
	// the same basename next to the project file (see `openscreen pack`).
	const resolveWithSiblingFallback = async (mediaPath: string): Promise<string> => {
		if (!projectFilePath) return mediaPath;
		const exists = await fs
			.stat(mediaPath)
			.then((stats) => stats.isFile())
			.catch(() => false);
		if (exists) return mediaPath;
		const sibling = path.join(
			path.dirname(path.resolve(projectFilePath)),
			path.basename(mediaPath),
		);
		const siblingExists = await fs
			.stat(sibling)
			.then((stats) => stats.isFile())
			.catch(() => false);
		return siblingExists ? sibling : mediaPath;
	};

	const screenVideoPath = await approveReadableVideoPath(
		await resolveWithSiblingFallback(media.screenVideoPath),
		trustedDirs,
	);
	if (!screenVideoPath) {
		throw new Error("Project references an invalid or unsupported screen video path");
	}

	const webcamVideoPath = media.webcamVideoPath
		? await approveReadableVideoPath(
				await resolveWithSiblingFallback(media.webcamVideoPath),
				trustedDirs,
			)
		: undefined;
	if (media.webcamVideoPath && !webcamVideoPath) {
		throw new Error("Project references an invalid or unsupported webcam video path");
	}

	return webcamVideoPath
		? { screenVideoPath, webcamVideoPath, createdAt: Date.now() }
		: { screenVideoPath, createdAt: Date.now() };
}

type SelectedSource = {
	name: string;
	id?: string;
	display_id?: string;
	[key: string]: unknown;
};

type AttachNativeMacWebcamRecordingInput = {
	screenVideoPath?: string;
	recordingId?: number;
	webcam?: RecordedVideoAssetInput;
	cursorCaptureMode?: CursorCaptureMode;
	/**
	 * Webcam clip duration (ms), head start included. A streamed webcam file carries
	 * no Duration header and the renderer no longer holds the blob to patch, so the
	 * main process repairs the container on disk with this value.
	 */
	durationMs?: number;
	/** See {@link ProjectMedia.webcamOffsetMs}. */
	webcamOffsetMs?: number;
};

let selectedSource: SelectedSource | null = null;
let selectedDesktopSource: DesktopCapturerSource | null = null;
let lastEnumeratedSources = new Map<string, DesktopCapturerSource>();
let currentProjectPath: string | null = null;
let currentRecordingSession: RecordingSession | null = null;

// single source of truth for the mic/camera/system-audio/cursor
// choices a user makes in the editor's Rec-mode stage, so the HUD window's
// useScreenRecorder (a separate renderer, own process, own React tree) picks
// up those choices instead of silently reverting to its own defaults when
// startNewRecording() switches windows. Mirrors the selectedSource pattern
// above (in-memory, broadcast on change) rather than persisting to disk —
// this is a live session preference, not project content.
export interface RecordingPrefs {
	micEnabled: boolean;
	micDeviceId: string | null;
	/**
	 * The microphone's LABEL, carried beside its id because the native Windows
	 * helper selects by name and Chromium selects by id.
	 *
	 * Without it, a HUD rebuilt for a new recording restored the id and had to
	 * re-derive the name from its own `enumerateDevices()` — which needs a full
	 * getUserMedia permission round-trip first, and an auto-started recording
	 * beat it. The request then went out with no name at all, and the helper
	 * answers that by recording the Windows default endpoint instead of the
	 * microphone the user picked (getopenscreen/openscreen#404).
	 */
	micDeviceName: string | null;
	camEnabled: boolean;
	camDeviceId: string | null;
	systemAudioEnabled: boolean;
	cursorCaptureMode: CursorCaptureMode;
}
let recordingPrefs: RecordingPrefs = {
	micEnabled: false,
	micDeviceId: null,
	micDeviceName: null,
	camEnabled: false,
	camDeviceId: null,
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay",
};

// Cached source from the user's pick. Used by setDisplayMediaRequestHandler in main.ts for cursor-free capture.
export function getSelectedDesktopSource(): DesktopCapturerSource | null {
	return selectedDesktopSource;
}
let currentVideoPath: string | null = null;

function normalizePath(filePath: string) {
	return path.resolve(filePath);
}

function normalizeVideoSourcePath(videoPath?: string | null): string | null {
	if (typeof videoPath !== "string") {
		return null;
	}

	const trimmed = videoPath.trim();
	if (!trimmed) {
		return null;
	}

	if (/^file:\/\//i.test(trimmed)) {
		try {
			return fileURLToPath(trimmed);
		} catch {
			// Fall through and keep best-effort string path below.
		}
	}

	return trimmed;
}

function isTrustedProjectPath(filePath?: string | null) {
	if (!filePath || !currentProjectPath) {
		return false;
	}
	return normalizePath(filePath) === normalizePath(currentProjectPath);
}

const CURSOR_SAMPLE_INTERVAL_MS = 33;
const MAX_CURSOR_SAMPLES = 60 * 60 * 30; // 1 hour @ 30Hz

let cursorRecordingSession: CursorRecordingSession | null = null;
let pendingCursorRecordingData: CursorRecordingData | null = null;
let nativeWindowsCaptureProcess: ChildProcessWithoutNullStreams | null = null;
let nativeWindowsCaptureOutput = "";
let nativeWindowsCaptureTargetPath: string | null = null;
let nativeWindowsCaptureWebcamTargetPath: string | null = null;
let nativeWindowsCaptureRecordingId: number | null = null;
let nativeWindowsCursorOffsetMs = 0;
let nativeWindowsCursorCaptureMode: CursorCaptureMode = "editable-overlay";
let nativeWindowsCursorRecordingStartMs = 0;
let nativeWindowsPauseStartedAtMs: number | null = null;
let nativeWindowsPauseRanges: Array<{ startMs: number; endMs: number }> = [];
let nativeWindowsIsPaused = false;
/**
 * The MP4 flavour the helper reported for THIS run, or null if it never said.
 * Read at stop, not for reporting: it is what decides whether a capture that
 * failed to finalize still left a playable file behind.
 */
let nativeWindowsCaptureContainer: string | null = null;
/** Cuts a surviving helper's output loose so it cannot pollute the next recording. */
let nativeWindowsCaptureDrainCleanup: (() => void) | null = null;

function detachNativeWindowsCaptureOutputDrain() {
	nativeWindowsCaptureDrainCleanup?.();
	nativeWindowsCaptureDrainCleanup = null;
}

function resetNativeWindowsCaptureState() {
	nativeWindowsCaptureDrainCleanup = null;
	nativeWindowsCaptureProcess = null;
	nativeWindowsCaptureTargetPath = null;
	nativeWindowsCaptureWebcamTargetPath = null;
	nativeWindowsCaptureRecordingId = null;
	nativeWindowsCursorOffsetMs = 0;
	nativeWindowsCursorCaptureMode = "editable-overlay";
	nativeWindowsCursorRecordingStartMs = 0;
	nativeWindowsPauseStartedAtMs = null;
	nativeWindowsPauseRanges = [];
	nativeWindowsIsPaused = false;
	nativeWindowsCaptureContainer = null;
}

/** Reads the file, then defers the judgement to the tested predicate. */
async function salvageNativeWindowsFragmentedCapture(screenVideoPath: string | null) {
	if (!screenVideoPath) {
		return false;
	}
	const stats = await fs.stat(screenVideoPath).catch(() => null);
	return isSalvageableFragmentedCapture(nativeWindowsCaptureContainer, stats?.size ?? null);
}

/**
 * Best-effort removal of the files a failed or discarded native Windows capture
 * left behind. Each removal is isolated: a helper that outlived its kill still
 * holds the MP4 open on Windows, and an EBUSY there must not mask why we were
 * cleaning up in the first place.
 */
async function removeNativeWindowsCaptureOutputs(
	screenVideoPath: string | null,
	webcamVideoPath: string | null,
	options: { onlyIfUnusable?: boolean } = {},
) {
	const targets = [
		screenVideoPath,
		webcamVideoPath,
		screenVideoPath ? `${screenVideoPath}.cursor.json` : null,
	];

	for (const target of targets) {
		if (!target || !isPathWithinDir(target, RECORDINGS_DIR)) {
			continue;
		}
		try {
			if (options.onlyIfUnusable && target !== `${screenVideoPath}.cursor.json`) {
				const stats = await fs.stat(target).catch(() => null);
				if (stats && stats.size >= NATIVE_WINDOWS_SALVAGEABLE_OUTPUT_BYTES) {
					console.warn(
						"[native-wgc] keeping a capture output that may still be playable:",
						target,
						stats.size,
					);
					continue;
				}
			}
			await fs.rm(target, { force: true });
		} catch (error) {
			console.warn("[native-wgc] could not remove leftover capture output:", target, error);
		}
	}
}
let nativeMacCaptureProcess: ChildProcessWithoutNullStreams | null = null;
let nativeMacCaptureOutput = "";
let nativeMacCaptureTargetPath: string | null = null;
let nativeMacCaptureRecordingId: number | null = null;
let nativeMacCursorOffsetMs = 0;
let nativeMacCursorCaptureMode: CursorCaptureMode = "editable-overlay";
let nativeMacCursorRecordingStartMs = 0;
let nativeMacPauseStartedAtMs: number | null = null;
let nativeMacPauseRanges: Array<{ startMs: number; endMs: number }> = [];
let nativeMacIsPaused = false;
// Global frame of the region captured by the SCK helper (see getSelectedSourceBounds).
let activeMacCaptureBounds: Rectangle | null = null;
let linuxNativeCaptureSession: LinuxNativeCaptureSession | null = null;
let linuxNativeCaptureRecordingId: number | null = null;
let linuxNativeCaptureCursorMode: CursorCaptureMode = "editable-overlay";
/** What the portal granted for the running capture, for the tray's label. */
let linuxNativeCaptureSourceLabel: string | null = null;
/**
 * A portal session negotiated ahead of the countdown, waiting to be armed.
 *
 * Held here rather than in the renderer because the helper is a child process of
 * THIS process: a renderer that reloads, or a countdown abandoned without a
 * cancel, would otherwise leak a live ScreenCast session — the compositor's
 * "screen is being shared" indicator with nothing recording behind it.
 */
let preparedLinuxCapture: {
	session: LinuxNativeCaptureSession;
	outputPath: string;
	/** What the helper was actually spawned with. See [`captureSettingsOf`]. */
	request: NativeLinuxRecordingRequest;
} | null = null;
/**
 * Identifies the prepare that is still waiting on the picker.
 *
 * The slot above is only filled AFTER an await with no upper bound — a human is
 * reading a dialog. For that whole window it is null, so without this token a
 * cancel would find nothing to cancel and a second prepare would find nothing to
 * supersede: the first session would then assign itself afterwards and stay
 * alive, holding a ScreenCast grant and the compositor's sharing indicator with
 * nothing recording behind it.
 */
let preparingLinuxCaptureToken: symbol | null = null;

/**
 * Claims the prepared session when it matches the recording about to start.
 *
 * A mismatch means the prepare was for a recording that never happened, so it is
 * discarded rather than reused: arming it would record against the wrong output
 * path, and leaving it would strand a portal session.
 */
function takePreparedLinuxSession(
	outputPath: string,
	request: NativeLinuxRecordingRequest,
): LinuxNativeCaptureSession | null {
	const prepared = preparedLinuxCapture;
	if (!prepared) {
		return null;
	}
	preparedLinuxCapture = null;
	if (prepared.outputPath !== outputPath) {
		console.warn("[native-linux] discarding a prepared session for a different recording");
		prepared.session.discard();
		return null;
	}
	// EVERY CAPTURE SETTING IS FIXED AT SPAWN. `arm()` only writes `record`, so a
	// prepared helper is already running with the audio and cursor settings it
	// was created with — and the HUD does not lock its controls during the
	// countdown, so the user really can change them in between. Reusing the
	// session would record one thing while the app believed another, including
	// the cursor mode that decides whether the editor draws its own pointer.
	if (captureSettingsOf(prepared.request) !== captureSettingsOf(request)) {
		console.info("[native-linux] settings changed during the countdown; renegotiating");
		prepared.session.discard();
		return null;
	}
	return prepared.session;
}

/** The request fields baked into the helper's spawn arguments, canonicalised. */
function captureSettingsOf(request: NativeLinuxRecordingRequest): string {
	return JSON.stringify({
		fps: request.video?.fps ?? null,
		bitrate: request.video?.bitrate ?? null,
		system: request.audio?.system?.enabled ?? false,
		microphone: request.audio?.microphone?.enabled ?? false,
		deviceName: request.audio?.microphone?.deviceName ?? null,
		gain: request.audio?.microphone?.gain ?? null,
		cursor: normalizeCursorCaptureMode(request?.cursor?.mode) ?? "editable-overlay",
	});
}

/** Tears down a prepared-but-unarmed session, e.g. an abandoned countdown. */
function discardPreparedLinuxCapture(reason: string) {
	// Invalidate any negotiation still in flight, so the session it is about to
	// produce is discarded on arrival instead of stranded.
	preparingLinuxCaptureToken = null;
	if (!preparedLinuxCapture) {
		return;
	}
	console.info(`[native-linux] discarding the prepared capture: ${reason}`);
	preparedLinuxCapture.session.discard();
	preparedLinuxCapture = null;
}

/**
 * Names what the portal handed over, for the tray tooltip.
 *
 * There is no window title to show: the ScreenCast portal reports a kind and a
 * PipeWire node id, never a name. Reporting the kind is the most that can be
 * said honestly, and an unknown kind stays unknown — calling it "Screen" would
 * be the same guess that put a window's name on a full-screen recording.
 */
function linuxSourceLabel(kind?: LinuxCaptureSourceKind): string {
	switch (kind) {
		case "window":
			return mainT("common", "recordingSource.window");
		case "monitor":
			return mainT("common", "recordingSource.screen");
		case "virtual":
			return mainT("common", "recordingSource.virtual");
		default:
			return mainT("common", "recordingSource.unknown");
	}
}
/**
 * NO PORTAL RESTORE TOKEN IS KEPT, AND THAT IS DELIBERATE.
 *
 * A token used to be persisted here so the compositor's picker would not appear
 * on every recording. It is gone because it made "record this window" record the
 * whole screen instead. A restore token is bound to the source it was minted
 * for, so once any monitor had been approved the portal restored that monitor on
 * every later run and stopped raising the picker at all — and `SelectSources`
 * has no parameter naming a source, so the app could not ask for anything else.
 * On Wayland the picker IS the source chooser; suppressing it left the user with
 * no way to change what they were recording.
 *
 * Answering the picker each time is the cost of being able to choose at all.
 */

// ponytail: the sidecar readers used to live here, ~150 lines of parsing wedged
// between the capture state machine and the asset-path helpers, reachable only
// through IPC. They now live in `electron/media/cursorSidecar.ts` — Node-pure,
// injectable, testable — because the agent needed to read the same file and
// could not import an IPC handler. What is left here is the binding of
// `RECORDINGS_DIR` (an `app.getPath` at main-module scope) to those readers.
//
// ponytail: a FUNCTION, not a captured object. `main.ts` imports this module and
// this module imports `RECORDINGS_DIR` back from it, so at the moment this file
// is evaluated that binding is still in its temporal dead zone — reading it here
// threw `Cannot access 'RECORDINGS_DIR' before initialization` and the app died
// before its first window. Every call site is already inside a handler, i.e.
// long after both modules finished loading.
const cursorSidecarOptions = () => ({ recordingsDir: RECORDINGS_DIR });

const readCursorRecordingFile = (targetVideoPath: string) =>
	readCursorRecordingFileFrom(targetVideoPath, cursorSidecarOptions());

const readCursorTelemetryFile = (targetVideoPath: string) =>
	readCursorTelemetryFileFrom(targetVideoPath, cursorSidecarOptions());

/**
 * The agent's door onto cursor telemetry — the last mile of D-TELEM.
 *
 * ponytail: `resolveApprovedVideoPath` is not ceremony. The asset path comes
 * from the DOCUMENT rather than from the model, but the document is a file on
 * disk that the user (or a future import path) can put anything in, and the
 * sidecar path is DERIVED from it. Reusing the same allow-list the video loaders
 * use means a crafted `originalPath` cannot walk this into reading an arbitrary
 * JSON file. A refused path yields "unavailable", not "no-sidecar": we did not
 * look, and the model must not report otherwise.
 */
const agentCursorTelemetryReader: CursorTelemetryReader = {
	probe: async ({ originalPath }) => {
		const approved = resolveApprovedVideoPath(originalPath);
		if (!approved) return false;
		return (await readCursorSidecar(approved, cursorSidecarOptions())).found;
	},
	read: async ({ assetId, originalPath }) => {
		const approved = resolveApprovedVideoPath(originalPath);
		if (!approved) {
			return {
				status: "unavailable",
				assetId,
				note: "The asset's file is outside the folders this app may read, so its cursor sidecar was not opened.",
			};
		}
		const sidecar = await readCursorSidecar(approved, cursorSidecarOptions());
		if (!sidecar.found) return { status: "no-sidecar", assetId };
		return { status: "ok", assetId, samples: sidecar.data.samples };
	},
};

function resolveAssetBasePath() {
	try {
		if (app.isPackaged) {
			const assetPath = path.join(process.resourcesPath, "assets");
			return pathToFileURL(`${assetPath}${path.sep}`).toString();
		}
		const assetPath = path.join(app.getAppPath(), "public", "assets");
		return pathToFileURL(`${assetPath}${path.sep}`).toString();
	} catch (err) {
		console.error("Failed to resolve asset base path:", err);
		return null;
	}
}

function getSelectedSourceBounds() {
	// Single-window capture records only the window's region, not the whole display.
	// Normalizing the cursor against display bounds leaves a fixed offset in the export,
	// so prefer the helper-reported window frame when capturing a window.
	const isWindowSource = selectedSource?.id?.startsWith("window:") === true;
	if (isWindowSource && activeMacCaptureBounds) {
		return activeMacCaptureBounds;
	}

	const cursor = screen.getCursorScreenPoint();
	const sourceDisplayId = Number(selectedSource?.display_id);
	const sourceDisplay = Number.isFinite(sourceDisplayId)
		? (screen.getAllDisplays().find((display) => display.id === sourceDisplayId) ?? null)
		: null;
	return (sourceDisplay ?? screen.getDisplayNearestPoint(cursor)).bounds;
}

function getSelectedSourceId() {
	return typeof selectedSource?.id === "string" ? selectedSource.id : null;
}

function getSelectedDisplay() {
	const sourceDisplayId = Number(selectedSource?.display_id);
	if (!Number.isFinite(sourceDisplayId)) {
		return null;
	}

	return screen.getAllDisplays().find((display) => display.id === sourceDisplayId) ?? null;
}

function resolveUnpackedAppPath(...segments: string[]) {
	const resolved = path.join(app.getAppPath(), ...segments);
	if (app.isPackaged) {
		return resolved.replace(/\.asar([/\\])/, ".asar.unpacked$1");
	}

	return resolved;
}

function resolvePackagedResourcePath(...segments: string[]) {
	if (!app.isPackaged) {
		return null;
	}

	return path.join(process.resourcesPath, ...segments);
}

function getNativeWindowsCaptureHelperCandidates() {
	const envPath = process.env.OPENSCREEN_WGC_CAPTURE_EXE?.trim();
	const archTag = process.arch === "arm64" ? "win32-arm64" : "win32-x64";
	return [
		envPath,
		resolveUnpackedAppPath(
			"electron",
			"native",
			"wgc-capture",
			"build",
			"Release",
			"wgc-capture.exe",
		),
		resolveUnpackedAppPath("electron", "native", "wgc-capture", "build", "wgc-capture.exe"),
		resolveUnpackedAppPath("electron", "native", "bin", archTag, "wgc-capture.exe"),
		resolvePackagedResourcePath("electron", "native", "bin", archTag, "wgc-capture.exe"),
	].filter((candidate): candidate is string => Boolean(candidate));
}

async function findNativeWindowsCaptureHelperPath() {
	if (process.platform !== "win32") {
		return null;
	}

	for (const candidate of getNativeWindowsCaptureHelperCandidates()) {
		try {
			await fs.access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next configured helper location.
		}
	}

	return null;
}

function getNativeMacCaptureHelperCandidates() {
	const envPath = process.env.OPENSCREEN_SCK_CAPTURE_EXE?.trim();
	const archTag = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	const helperName = "openscreen-screencapturekit-helper";
	return [
		envPath,
		resolveUnpackedAppPath("electron", "native", "screencapturekit", "build", helperName),
		resolveUnpackedAppPath("electron", "native", "bin", archTag, helperName),
		resolvePackagedResourcePath("electron", "native", "bin", archTag, helperName),
	].filter((candidate): candidate is string => Boolean(candidate));
}

async function findNativeMacCaptureHelperPath() {
	if (process.platform !== "darwin") {
		return null;
	}

	for (const candidate of getNativeMacCaptureHelperCandidates()) {
		try {
			await fs.access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next configured helper location.
		}
	}

	return null;
}

function isWindowsGraphicsCaptureOsSupported() {
	if (process.platform !== "win32") {
		return false;
	}

	const [, , build] = process.getSystemVersion().split(".").map(Number);
	return Number.isFinite(build) && build >= 19041;
}

function queryDirectShowVideoInputRegistry() {
	return new Promise<string>((resolve) => {
		const proc = spawn(
			"reg.exe",
			["query", "HKCR\\CLSID\\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\Instance", "/s"],
			{ windowsHide: true },
		);
		let stdout = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf16le").includes("\u0000")
				? chunk.toString("utf16le")
				: chunk.toString();
		});
		proc.on("close", () => resolve(stdout));
		proc.on("error", () => resolve(""));
	});
}

async function resolveDirectShowWebcamClsid(deviceName?: string) {
	if (process.platform !== "win32" || !deviceName?.trim()) {
		return null;
	}

	const output = await queryDirectShowVideoInputRegistry();
	let current: { friendlyName?: string; clsid?: string } = {};
	const entries: Array<{ friendlyName?: string; clsid?: string }> = [];
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (/^HKEY_/i.test(line)) {
			if (current.friendlyName || current.clsid) entries.push(current);
			current = {};
			continue;
		}
		const match = line.match(/^(\S+)\s+REG_SZ\s+(.+)$/);
		if (!match) continue;
		if (match[1] === "FriendlyName") current.friendlyName = match[2].trim();
		if (match[1] === "CLSID") current.clsid = match[2].trim();
	}
	if (current.friendlyName || current.clsid) entries.push(current);

	let best: { clsid: string; friendlyName?: string; score: number } | null = null;
	for (const entry of entries) {
		if (!entry.clsid) continue;
		const score = scoreDeviceNameMatch(entry.friendlyName ?? "", entry.clsid, deviceName);
		if (!best || score > best.score) {
			best = { clsid: entry.clsid, friendlyName: entry.friendlyName, score };
		}
	}

	if (!best || best.score <= 0) {
		return null;
	}

	console.info("[native-wgc] resolved DirectShow webcam filter", {
		requestedName: deviceName,
		filterName: best.friendlyName,
		clsid: best.clsid,
		score: best.score,
	});
	return best.clsid;
}

async function startCursorRecording(recordingId?: number) {
	// On Linux the native capture helper already produces cursor samples, from
	// the SAME portal session that produces the pixels. Spawning the cursor-only
	// helper alongside it would open a SECOND portal session — and since
	// SelectSources may be called once per session, that means a second picker
	// in front of the user, for a stream nothing consumes. The double prompt is
	// precisely what the native path exists to remove.
	if (linuxNativeCaptureSession) {
		return;
	}

	if (cursorRecordingSession) {
		pendingCursorRecordingData = await cursorRecordingSession.stop();
		cursorRecordingSession = null;
	}

	pendingCursorRecordingData = null;
	cursorRecordingSession = createCursorRecordingSession({
		getDisplayBounds: getSelectedSourceBounds,
		maxSamples: MAX_CURSOR_SAMPLES,
		platform: process.platform,
		sampleIntervalMs: CURSOR_SAMPLE_INTERVAL_MS,
		sourceId: getSelectedSourceId(),
		startTimeMs:
			typeof recordingId === "number" && Number.isFinite(recordingId) ? recordingId : undefined,
	});

	try {
		await cursorRecordingSession.start();
	} catch (error) {
		console.error("Failed to start cursor recording session:", error);
		cursorRecordingSession = null;
	}
}

async function stopCursorRecording() {
	if (!cursorRecordingSession) {
		return;
	}

	try {
		pendingCursorRecordingData = await cursorRecordingSession.stop();
	} catch (error) {
		console.error("Failed to stop cursor recording session:", error);
		pendingCursorRecordingData = null;
	} finally {
		cursorRecordingSession = null;
	}
}

async function writePendingCursorTelemetry(videoPath: string) {
	const telemetryPath = `${videoPath}.cursor.json`;
	if (pendingCursorRecordingData && pendingCursorRecordingData.samples.length > 0) {
		await fs.writeFile(telemetryPath, JSON.stringify(pendingCursorRecordingData, null, 2), "utf-8");
	}
	pendingCursorRecordingData = null;
}

// P4 — proactively seeds the media-links registry for a fresh recording so
// its camera/cursor-telemetry links can still be found later even if the
// screen video is moved, renamed, or imported into a different project.
// Best-effort: a registry write hiccup must never fail the recording flow.
async function registerRecordingMediaLinks(
	screenVideoPath: string,
	options: {
		webcamVideoPath?: string;
		webcamOffsetMs?: number;
		cursorCaptureMode?: CursorCaptureMode;
	},
) {
	try {
		const cursorTelemetryPath = `${screenVideoPath}.cursor.json`;
		const hasCursorTelemetry = await fs
			.access(cursorTelemetryPath, fsConstants.F_OK)
			.then(() => true)
			.catch(() => false);
		await registerMediaLinks(RECORDINGS_DIR, screenVideoPath, {
			...(options.webcamVideoPath ? { webcamVideoPath: options.webcamVideoPath } : {}),
			...(options.webcamVideoPath && Number.isFinite(options.webcamOffsetMs)
				? { webcamOffsetMs: options.webcamOffsetMs }
				: {}),
			...(hasCursorTelemetry ? { cursorTelemetryPath } : {}),
			...(options.cursorCaptureMode ? { cursorCaptureMode: options.cursorCaptureMode } : {}),
		});
	} catch (error) {
		console.warn("[media-links] failed to register recording links:", error);
	}
}

function shiftPendingCursorTelemetry(offsetMs: number) {
	if (!pendingCursorRecordingData || !Number.isFinite(offsetMs) || offsetMs <= 0) {
		return;
	}

	pendingCursorRecordingData = {
		...pendingCursorRecordingData,
		samples: pendingCursorRecordingData.samples
			.map((sample) => ({
				...sample,
				timeMs: Math.max(0, sample.timeMs - offsetMs),
			}))
			.sort((a, b) => a.timeMs - b.timeMs),
	};
}

function compactPendingCursorTelemetryPauseRanges(
	ranges: Array<{ startMs: number; endMs: number }>,
) {
	if (!pendingCursorRecordingData || ranges.length === 0) {
		return;
	}

	const normalizedRanges = ranges
		.map((range) => ({
			startMs: Math.max(0, Math.min(range.startMs, range.endMs)),
			endMs: Math.max(0, Math.max(range.startMs, range.endMs)),
		}))
		.filter((range) => Number.isFinite(range.startMs) && Number.isFinite(range.endMs))
		.filter((range) => range.endMs > range.startMs)
		.sort((a, b) => a.startMs - b.startMs);

	if (normalizedRanges.length === 0) {
		return;
	}

	pendingCursorRecordingData = {
		...pendingCursorRecordingData,
		samples: pendingCursorRecordingData.samples
			.map((sample) => {
				let pausedBeforeSampleMs = 0;
				for (const range of normalizedRanges) {
					if (sample.timeMs >= range.startMs && sample.timeMs <= range.endMs) {
						return null;
					}
					if (sample.timeMs > range.endMs) {
						pausedBeforeSampleMs += range.endMs - range.startMs;
					}
				}

				return {
					...sample,
					timeMs: Math.max(0, sample.timeMs - pausedBeforeSampleMs),
				};
			})
			.filter((sample): sample is CursorRecordingSample => Boolean(sample))
			.sort((a, b) => a.timeMs - b.timeMs),
	};
}

function completeNativeMacCursorPauseRange(endMs = Date.now()) {
	if (nativeMacPauseStartedAtMs === null || nativeMacCursorRecordingStartMs <= 0) {
		return;
	}

	nativeMacPauseRanges.push({
		startMs: Math.max(0, nativeMacPauseStartedAtMs - nativeMacCursorRecordingStartMs),
		endMs: Math.max(0, endMs - nativeMacCursorRecordingStartMs),
	});
	nativeMacPauseStartedAtMs = null;
}

function completeNativeWindowsCursorPauseRange(endMs = Date.now()) {
	if (nativeWindowsPauseStartedAtMs === null || nativeWindowsCursorRecordingStartMs <= 0) {
		return;
	}

	nativeWindowsPauseRanges.push({
		startMs: Math.max(0, nativeWindowsPauseStartedAtMs - nativeWindowsCursorRecordingStartMs),
		endMs: Math.max(0, endMs - nativeWindowsCursorRecordingStartMs),
	});
	nativeWindowsPauseStartedAtMs = null;
}

function waitForNativeWindowsCaptureStart(proc: ChildProcessWithoutNullStreams) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out waiting for native Windows capture to start"));
		}, 12000);

		// Observes only. `attachNativeWindowsCaptureOutputDrain` is the single
		// writer of `nativeWindowsCaptureOutput` and is registered first, so the
		// chunk that triggers this call is already in the buffer.
		const onOutput = () => {
			if (nativeWindowsCaptureOutput.includes("Recording started")) {
				cleanup();
				resolve();
			}
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(
				new Error(
					nativeWindowsCaptureOutput.trim() ||
						`Native Windows capture exited before recording started (code=${code ?? "unknown"})`,
				),
			);
		};
		const cleanup = () => {
			clearTimeout(timer);
			proc.stdout.off("data", onOutput);
			proc.stderr.off("data", onOutput);
			proc.off("error", onError);
			proc.off("exit", onExit);
		};

		proc.stdout.on("data", onOutput);
		proc.stderr.on("data", onOutput);
		proc.once("error", onError);
		proc.once("exit", onExit);
	});
}

/**
 * Keeps reading the helper for as long as it lives.
 *
 * `waitForNativeWindowsCaptureStart` drops every listener the moment it sees
 * "Recording started", so until this existed the whole recording ran unobserved:
 * helper warnings and `[stop-timing]` diagnostics were discarded, which is why
 * issue #252 had no helper-side evidence from a real app run and had to be
 * reproduced by driving the .exe by hand. macOS has had this since it shipped
 * (`attachNativeMacCaptureOutputDrain`); Windows never did.
 */
function attachNativeWindowsCaptureOutputDrain(proc: ChildProcessWithoutNullStreams) {
	const drain = (chunk: Buffer) => {
		nativeWindowsCaptureOutput += chunk.toString();
	};
	const cleanup = () => {
		proc.stdout.off("data", drain);
		proc.stderr.off("data", drain);
	};

	proc.stdout.on("data", drain);
	proc.stderr.on("data", drain);
	proc.once("close", cleanup);
	// An 'error' event with no listener throws, and in the main process that is
	// an uncaught exception rather than a rejected promise. Both streams need a
	// sink for the whole life of the helper: stdin raises EPIPE when the helper
	// died before we wrote to it, and `kill()` on a wedged process re-emits its
	// failure on the ChildProcess itself.
	// All four emitters, not just stdin: `cleanup` only drops 'data', so an
	// abandoned-but-still-alive helper leaves these pipes open with no consumer,
	// and an ECONNRESET when the OS finally reaps it would take down the main
	// process.
	proc.stdin.on("error", (error) => {
		console.warn("[native-wgc] helper stdin error:", error);
	});
	proc.stdout.on("error", (error) => {
		console.warn("[native-wgc] helper stdout error:", error);
	});
	proc.stderr.on("error", (error) => {
		console.warn("[native-wgc] helper stderr error:", error);
	});
	proc.on("error", (error) => {
		console.warn("[native-wgc] helper process error:", error);
	});

	// Returned so an abandoned helper can be cut loose. A process that survived
	// both kill attempts keeps writing, and `nativeWindowsCaptureOutput` is
	// shared with whatever recording starts next.
	return cleanup;
}

/**
 * Sends `stop` and closes the command channel behind it.
 *
 * The helper treats stdin EOF as a stop too, so ending the stream is a free
 * second signal if the write itself is lost.
 */
function sendNativeWindowsStopCommand(proc: ChildProcessWithoutNullStreams) {
	if (!proc.stdin.writable) {
		return false;
	}

	proc.stdin.write("stop\n");
	proc.stdin.end();
	return true;
}

function readNativeWindowsEncoderSelection(output: string) {
	const lines = output
		.split(/\r?\n/)
		.filter((line) => line.includes('"event":"encoder-selection"'));
	const lastLine = lines.at(-1);
	if (!lastLine) {
		return null;
	}

	try {
		return JSON.parse(lastLine) as {
			video?: string;
			// Which MP4 flavour the helper actually wrote, `fragmented-mp4` or
			// `mp4`. It reports this because the fragmented sink degrades to the
			// plain one rather than failing a recording, so the flavour is a
			// per-run outcome and not a property of the version. This is the only
			// thing that can answer "was this file supposed to survive a kill?",
			// which is what `salvageNativeWindowsFragmentedCapture` asks.
			container?: string;
			preferSoftwareEncoder?: boolean;
			// Whether BeginWriting() actually landed on a hardware H.264 MFT, as
			// opposed to `video` above, which only says which configuration path
			// was tried. "default" plus a software runtime means the machine never
			// got hardware acceleration in the first place -- see
			// kVideoEncoderRuntime* in mf_encoder.h.
			videoEncoderRuntime?: string;
		};
	} catch {
		return null;
	}
}

function tryParseNativeHelperEvent(line: string) {
	try {
		const parsed = JSON.parse(line);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function dispatchNativeMacHelperEvent(event: Record<string, unknown>) {
	const bounds = event.captureBounds as Rectangle | undefined;
	if (bounds && bounds.width > 0 && bounds.height > 0) {
		activeMacCaptureBounds = bounds;
	}
	nativeMacCaptureEvents.emit("helper-event", event);
}

function inspectNativeMacCaptureOutput() {
	for (const line of nativeMacCaptureOutput.split(/\r?\n/)) {
		const event = tryParseNativeHelperEvent(line.trim());
		if (event) {
			dispatchNativeMacHelperEvent(event);
		}
	}
}

function attachNativeMacCaptureOutputDrain(proc: ChildProcessWithoutNullStreams) {
	let lineBuffer = "";
	const drain = (chunk: Buffer) => {
		const text = chunk.toString();
		nativeMacCaptureOutput += text;
		lineBuffer += text;
		const lines = lineBuffer.split(/\r?\n/);
		lineBuffer = lines.pop() ?? "";
		for (const line of lines) {
			const event = tryParseNativeHelperEvent(line.trim());
			if (event) {
				dispatchNativeMacHelperEvent(event);
			}
		}
	};
	const cleanup = () => {
		proc.stdout.off("data", drain);
		proc.stderr.off("data", drain);
		proc.off("close", cleanup);
		proc.off("error", cleanup);
	};

	proc.stdout.on("data", drain);
	proc.stderr.on("data", drain);
	proc.once("close", cleanup);
	proc.once("error", cleanup);
}

function waitForNativeMacCaptureStart(proc: ChildProcessWithoutNullStreams) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out waiting for native macOS capture to start"));
		}, 10_000);

		const inspect = (event: Record<string, unknown>) => {
			if (event.event === "recording-started") {
				cleanup();
				resolve();
				return;
			}
			if (event.event === "error") {
				cleanup();
				reject(new Error(String(event.message ?? event.code ?? "Native macOS capture failed")));
			}
		};

		const onOutput = (event: Record<string, unknown>) => inspect(event);
		const onClose = (code: number | null) => {
			cleanup();
			reject(
				new Error(
					nativeMacCaptureOutput.trim() ||
						`Native macOS capture exited before recording started (code=${code ?? "unknown"})`,
				),
			);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			clearTimeout(timer);
			nativeMacCaptureEvents.off("helper-event", onOutput);
			proc.off("close", onClose);
			proc.off("error", onError);
		};

		nativeMacCaptureEvents.on("helper-event", onOutput);
		proc.once("close", onClose);
		proc.once("error", onError);
		inspectNativeMacCaptureOutput();
	});
}

function waitForNativeMacCaptureStop(proc: ChildProcessWithoutNullStreams) {
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`Timed out waiting for native macOS capture to stop. Output path: ${
						nativeMacCaptureTargetPath ?? "unknown"
					}. Output: ${nativeMacCaptureOutput.trim()}`,
				),
			);
		}, 30_000);

		const inspect = (event: Record<string, unknown>) => {
			if (event.event === "recording-stopped") {
				cleanup();
				resolve(String(event.screenPath ?? nativeMacCaptureTargetPath ?? ""));
				return;
			}
			if (event.event === "error") {
				cleanup();
				reject(new Error(String(event.message ?? event.code ?? "Native macOS capture failed")));
			}
		};

		const onOutput = (event: Record<string, unknown>) => inspect(event);
		const onClose = (code: number | null) => {
			if (code === 0 && nativeMacCaptureTargetPath) {
				cleanup();
				resolve(nativeMacCaptureTargetPath);
				return;
			}
			cleanup();
			reject(
				new Error(
					nativeMacCaptureOutput.trim() ||
						`Native macOS capture exited with code=${code ?? "unknown"}`,
				),
			);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			clearTimeout(timer);
			nativeMacCaptureEvents.off("helper-event", onOutput);
			proc.off("close", onClose);
			proc.off("error", onError);
		};

		nativeMacCaptureEvents.on("helper-event", onOutput);
		proc.once("close", onClose);
		proc.once("error", onError);
		inspectNativeMacCaptureOutput();
	});
}

function setCurrentRecordingSessionState(session: RecordingSession | null) {
	currentRecordingSession = session;
	currentVideoPath = session?.screenVideoPath ?? null;
}

function getSessionManifestPathForVideo(videoPath: string) {
	const parsedPath = path.parse(videoPath);
	const baseName = parsedPath.name.endsWith("-webcam")
		? parsedPath.name.slice(0, -"-webcam".length)
		: parsedPath.name;
	return path.join(parsedPath.dir, `${baseName}${RECORDING_SESSION_SUFFIX}`);
}

async function loadRecordedSessionForVideoPath(
	videoPath: string,
): Promise<RecordingSession | null> {
	try {
		const manifestPath = getSessionManifestPathForVideo(videoPath);
		if (!isPathAllowed(manifestPath)) {
			const parsedVideoPath = path.parse(videoPath);
			if (!isPathWithinDir(path.resolve(manifestPath), parsedVideoPath.dir)) {
				return null;
			}
		}

		const content = await fs.readFile(manifestPath, "utf-8");
		const session = normalizeRecordingSession(JSON.parse(content));
		if (!session) {
			return null;
		}

		const normalizedVideoPath = normalizePath(videoPath);
		const matchesScreen = normalizePath(session.screenVideoPath) === normalizedVideoPath;
		const matchesWebcam =
			typeof session.webcamVideoPath === "string" &&
			normalizePath(session.webcamVideoPath) === normalizedVideoPath;
		if (!matchesScreen && !matchesWebcam) {
			return null;
		}

		if (!isPathAllowed(session.screenVideoPath)) {
			const approvedScreen = await approveReadableVideoPath(session.screenVideoPath, [
				path.dirname(manifestPath),
				RECORDINGS_DIR,
			]);
			if (!approvedScreen) {
				return null;
			}
			session.screenVideoPath = approvedScreen;
		}

		if (session.webcamVideoPath && !isPathAllowed(session.webcamVideoPath)) {
			const approvedWebcam = await approveReadableVideoPath(session.webcamVideoPath, [
				path.dirname(manifestPath),
				RECORDINGS_DIR,
			]);
			if (!approvedWebcam) {
				session.webcamVideoPath = undefined;
			} else {
				session.webcamVideoPath = approvedWebcam;
			}
		}

		approveFilePath(session.screenVideoPath);
		if (session.webcamVideoPath) {
			approveFilePath(session.webcamVideoPath);
		}
		return session;
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code !== "ENOENT") {
			console.error("Failed to restore recording session manifest:", error);
		}
		return null;
	}
}

// P4 — resolves the camera (and cursor-telemetry path, though callers that
// only care about the camera can ignore it) for a screen-recording video,
// trying the cheap path-adjacency sidecar first (handles "just recorded" and
// pre-existing recordings) and falling back to the fingerprint registry
// (handles the file having been moved/renamed/imported from elsewhere).
// `videoPath` must already be normalized + approved by the caller.
async function resolveMediaLinksForVideo(videoPath: string): Promise<{
	webcamVideoPath?: string;
	webcamOffsetMs?: number;
	cursorTelemetryPath?: string;
	resolvedVia: "sidecar" | "fingerprint" | "none";
}> {
	const session = await loadRecordedSessionForVideoPath(videoPath);
	const cursorTelemetryPath = `${videoPath}.cursor.json`;
	const hasCursorTelemetry = await fs
		.access(cursorTelemetryPath, fsConstants.F_OK)
		.then(() => true)
		.catch(() => false);

	if (session?.webcamVideoPath || hasCursorTelemetry) {
		// Opportunistic backfill so the link survives a later move even if this
		// recording predates the registry, or if its sidecar doesn't travel with it.
		await registerMediaLinks(RECORDINGS_DIR, videoPath, {
			...(session?.webcamVideoPath ? { webcamVideoPath: session.webcamVideoPath } : {}),
			...(session?.webcamVideoPath && Number.isFinite(session.webcamOffsetMs)
				? { webcamOffsetMs: session.webcamOffsetMs }
				: {}),
			...(hasCursorTelemetry ? { cursorTelemetryPath } : {}),
		}).catch((error) => console.warn("[media-links] backfill failed:", error));

		return {
			...(session?.webcamVideoPath
				? {
						webcamVideoPath: session.webcamVideoPath,
						webcamOffsetMs: session.webcamOffsetMs ?? 0,
					}
				: {}),
			...(hasCursorTelemetry ? { cursorTelemetryPath } : {}),
			resolvedVia: "sidecar",
		};
	}

	try {
		const links = await findMediaLinksByFingerprint(RECORDINGS_DIR, videoPath);
		if (links?.webcamVideoPath || links?.cursorTelemetryPath) {
			let webcamVideoPath = links.webcamVideoPath;
			if (webcamVideoPath && !isPathAllowed(webcamVideoPath)) {
				webcamVideoPath =
					(await approveReadableVideoPath(webcamVideoPath, [RECORDINGS_DIR])) ?? undefined;
			}
			return {
				...(webcamVideoPath ? { webcamVideoPath, webcamOffsetMs: links.webcamOffsetMs ?? 0 } : {}),
				...(links.cursorTelemetryPath ? { cursorTelemetryPath: links.cursorTelemetryPath } : {}),
				resolvedVia: "fingerprint",
			};
		}
	} catch (error) {
		console.warn("[media-links] fingerprint lookup failed:", error);
	}

	return { resolvedVia: "none" };
}

/**
 * Writes the diagnostic bundle a bug report needs: app/OS facts, the native
 * helpers' raw stdout/stderr (which is where `[stop-timing]` and
 * `encoder-selection` land — see nativeWindowsCaptureStop.ts), and the main
 * process's own recent console output. Shared by the renderer's IPC call and
 * the menu/tray "Save Diagnostics" entry point in main.ts, which has no
 * renderer-side `projectState`/`logs` to offer and does not need to.
 */
export async function exportDiagnosticFile(payload: {
	error: string;
	stack?: string;
	projectState: unknown;
	logs: string[];
}) {
	const { filePath, canceled } = await dialog.showSaveDialog({
		title: "Save Diagnostic File",
		defaultPath: `openscreen-diagnostic-${Date.now()}.json`,
		filters: [{ name: "JSON", extensions: ["json"] }],
	});

	if (canceled || !filePath) return { success: false, canceled: true };

	const HELPER_OUTPUT_MAX_BYTES = 64 * 1024;
	const tail = (s: string, max: number) => (s.length <= max ? s : s.slice(s.length - max));

	const diagnostic = {
		timestamp: new Date().toISOString(),
		appVersion: app.getVersion(),
		platform: process.platform,
		arch: process.arch,
		// The same fact the About box leads with, and for the same reason: it is what
		// explains why a copy does or does not offer an update check. This file is the
		// artifact users actually attach, so it must not be the one that omits it.
		channel: getInstallChannel(),
		osRelease: os.release(),
		osVersion: os.version(),
		totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
		nodeVersion: process.versions.node,
		electronVersion: process.versions.electron,
		chromeVersion: process.versions.chrome,
		error: payload.error,
		stack: payload.stack,
		projectState: payload.projectState,
		recentLogs: payload.logs,
		helperOutput: {
			windows: tail(nativeWindowsCaptureOutput, HELPER_OUTPUT_MAX_BYTES),
			mac: tail(nativeMacCaptureOutput, HELPER_OUTPUT_MAX_BYTES),
		},
		mainProcessLogs: mainLogBuffer.snapshot(),
	};

	try {
		await fs.writeFile(filePath, JSON.stringify(diagnostic, null, 2), "utf-8");
		return { success: true, path: filePath };
	} catch (error) {
		console.error("Failed to write diagnostic file:", error);
		return { success: false, error: String(error) };
	}
}

export function registerIpcHandlers(
	createEditorWindow: () => void,
	createSourceSelectorWindow: () => BrowserWindow,
	createCountdownOverlayWindow: () => BrowserWindow,
	createNotesWindowWrapper: () => BrowserWindow,
	getMainWindow: () => BrowserWindow | null,
	getSourceSelectorWindow: () => BrowserWindow | null,
	getNotesWindow: () => BrowserWindow | null,
	getCountdownOverlayWindow?: () => BrowserWindow | null,
	onRecordingStateChange?: (recording: boolean, sourceName: string) => void,
	_switchToHud?: () => void,
) {
	async function requestScreenAccess() {
		if (process.platform !== "darwin") {
			return { success: true, granted: true, status: "granted" };
		}

		try {
			const status = systemPreferences.getMediaAccessStatus("screen");
			if (status === "granted") {
				return { success: true, granted: true, status };
			}

			// Screen recording has no askForMediaAccess equivalent, so trigger the
			// TCC prompt without opening OpenScreen's source selector above it.
			if (status === "not-determined") {
				const mainWin = getMainWindow();
				if (mainWin && !mainWin.isDestroyed()) {
					if (!mainWin.isVisible()) {
						mainWin.show();
					}
					mainWin.focus();
				}
				app.focus({ steal: true });
				desktopCapturer
					.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
					.catch(() => {
						// Permission probing failure is reported by the explicit status check below.
					});
				return { success: true, granted: false, status: "not-determined" };
			}

			return { success: true, granted: false, status };
		} catch (error) {
			console.error("Failed to request screen access:", error);
			return { success: false, granted: false, status: "unknown", error: String(error) };
		}
	}

	ipcMain.handle("get-sources", async (_, opts) => {
		// desktopCapturer.getSources can never settle where the GL stack cannot be
		// reached -- a container, a CI runner, a host whose ANGLE fails to
		// initialise. Bounded here rather than per-caller because every caller has
		// the same exposure and none of them can cancel this call: the CLI runners
		// (`sources`, `record`) and the GUI pickers (SourceSelector, RecStage) all
		// await it, and a renderer-side race would only stop *waiting* while this
		// keeps running and its reply goes to nobody. Rejecting is what turns an
		// indefinite spinner into the pickers' existing error branch.
		// How long it actually took, under the existing diagnostic flag. The bound
		// above turned an indefinite hang into a named failure, which is where the
		// open question starts rather than ends: on a headless runner `openscreen
		// sources` gets an answer within 20s four times in five while `record` --
		// the same call with the same options -- exceeds 30s every time. A duration
		// on both paths is what tells those apart; a threshold alone cannot.
		const startedAt = Date.now();
		const diagnostic = isDiagnosticModeEnabled();
		let sources: Awaited<ReturnType<typeof desktopCapturer.getSources>>;
		try {
			sources = await withDeadline(
				desktopCapturer.getSources(opts),
				GET_SOURCES_TIMEOUT_MS,
				`Desktop source enumeration did not return within ${GET_SOURCES_TIMEOUT_MS}ms. ` +
					"This usually means the display or GPU stack cannot be reached — check that a display server is available.",
			);
		} catch (error) {
			if (diagnostic) {
				// The reason, not an assumption about it: this catch also sees a
				// getSources that rejected on its own, well inside the deadline, and
				// calling that a timeout would point the next reader at the wrong thing.
				// The deadline error carries its own wording.
				const reason = error instanceof Error ? error.message : String(error);
				console.info(
					`[get-sources] failed after ${Date.now() - startedAt}ms (types=${(opts?.types ?? []).join(",")}): ${reason}`,
				);
			}
			throw error;
		}
		if (diagnostic) {
			console.info(
				`[get-sources] returned ${sources.length} source(s) in ${Date.now() - startedAt}ms (types=${(opts?.types ?? []).join(",")})`,
			);
		}
		lastEnumeratedSources = new Map(sources.map((source) => [source.id, source]));
		return sources.map((source) => ({
			id: source.id,
			name: source.name,
			display_id: source.display_id,
			thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : null,
			appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
		}));
	});

	ipcMain.handle("select-source", async (_, source: SelectedSource) => {
		selectedSource = source;
		// Reuse the exact source object returned during enumeration to avoid
		// Windows window-source id mismatches across separate getSources() calls.
		selectedDesktopSource =
			typeof source.id === "string" ? (lastEnumeratedSources.get(source.id) ?? null) : null;

		if (!selectedDesktopSource && typeof source.id === "string") {
			try {
				const sources = await desktopCapturer.getSources({
					types: ["screen", "window"],
					thumbnailSize: { width: 0, height: 0 },
					fetchWindowIcons: true,
				});
				lastEnumeratedSources = new Map(sources.map((candidate) => [candidate.id, candidate]));
				selectedDesktopSource = lastEnumeratedSources.get(source.id) ?? null;
			} catch {
				selectedDesktopSource = null;
			}
		}
		const mainWin = getMainWindow();
		if (mainWin && !mainWin.isDestroyed()) {
			mainWin.webContents.send("selected-source-changed", selectedSource);
		}
		const sourceSelectorWin = getSourceSelectorWindow();
		if (sourceSelectorWin) {
			sourceSelectorWin.close();
		}
		return selectedSource;
	});

	ipcMain.handle("get-selected-source", () => {
		return selectedSource;
	});

	ipcMain.handle("get-recording-prefs", () => {
		return recordingPrefs;
	});

	ipcMain.handle("set-recording-prefs", (_, prefs: Partial<RecordingPrefs>) => {
		recordingPrefs = { ...recordingPrefs, ...prefs };
		const mainWin = getMainWindow();
		if (mainWin && !mainWin.isDestroyed()) {
			mainWin.webContents.send("recording-prefs-changed", recordingPrefs);
		}
		return recordingPrefs;
	});

	ipcMain.handle("request-camera-access", async () => {
		if (process.platform !== "darwin") {
			return { success: true, granted: true, status: "granted" };
		}

		try {
			const status = systemPreferences.getMediaAccessStatus("camera");
			if (status === "granted") {
				return { success: true, granted: true, status };
			}

			if (status === "not-determined") {
				const granted = await systemPreferences.askForMediaAccess("camera");
				return {
					success: true,
					granted,
					status: granted ? "granted" : systemPreferences.getMediaAccessStatus("camera"),
				};
			}

			return { success: true, granted: false, status };
		} catch (error) {
			console.error("Failed to request camera access:", error);
			return {
				success: false,
				granted: false,
				status: "unknown",
				error: String(error),
			};
		}
	});

	ipcMain.handle("request-screen-access", async () => {
		return requestScreenAccess();
	});

	ipcMain.handle("request-native-mac-cursor-access", async () => {
		const access = await requestMacCursorAccessibilityAccess();

		// When the editable cursor can't get Accessibility trust, pop a native dialog
		// that deep-links to the Accessibility pane (mirrors the Screen Recording flow).
		if (process.platform === "darwin" && !access.granted) {
			const mainWin = getMainWindow();
			const detail =
				access.status === "missing-helper"
					? "The cursor helper couldn't be found in this build, so the editable cursor can't be enabled. Rebuild the native helper (npm run build:native:mac) or switch the HUD cursor mode to system."
					: "Allow OpenScreen under System Settings → Privacy & Security → Accessibility, then press record again to start the countdown.";
			const messageOptions = {
				type: "warning",
				buttons: ["Open Accessibility Settings", "Cancel"],
				defaultId: 0,
				cancelId: 1,
				message: "Accessibility access is required for the editable cursor",
				detail,
			} satisfies Electron.MessageBoxOptions;
			const result =
				mainWin && !mainWin.isDestroyed()
					? await dialog.showMessageBox(mainWin, messageOptions)
					: await dialog.showMessageBox(messageOptions);
			if (result.response === 0) {
				await shell.openExternal(
					"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
				);
			}
		}

		return access;
	});

	ipcMain.handle("open-source-selector", async () => {
		// Nothing to open on Linux WHEN THE NATIVE HELPER IS THERE. The selector's
		// own `desktopCapturer.getSources()` raises a portal dialog — a SECOND
		// one, for a session that is thrown away — and whatever it returns cannot
		// reach the helper, because `SelectSources` has no parameter naming a
		// source. Refusing keeps that dialog from appearing at all.
		//
		// Without the helper the recorder falls back to Chromium's capture, which
		// DOES consume a source id, so the picker has to stay reachable there or
		// that path could never start.
		if (process.platform === "linux" && findPipeWireCursorHelperPath()) {
			return { opened: false, reason: "portal-owns-selection" };
		}

		const access = await requestScreenAccess();
		if (!access.granted) {
			if (process.platform === "darwin" && access.status !== "not-determined") {
				const mainWin = getMainWindow();
				const messageOptions = {
					type: "warning",
					buttons: ["Open System Settings", "Cancel"],
					defaultId: 0,
					cancelId: 1,
					message: "Screen Recording permission is required",
					detail:
						"Allow OpenScreen in macOS System Settings, then come back and choose a screen or window.",
				} satisfies Electron.MessageBoxOptions;
				const result =
					mainWin && !mainWin.isDestroyed()
						? await dialog.showMessageBox(mainWin, messageOptions)
						: await dialog.showMessageBox(messageOptions);
				if (result.response === 0) {
					await shell.openExternal(
						"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
					);
				}
			}
			return {
				opened: false,
				reason: "screen-access-required",
				access,
			};
		}

		const sourceSelectorWin = getSourceSelectorWindow();
		if (sourceSelectorWin) {
			sourceSelectorWin.focus();
			return { opened: true };
		}
		createSourceSelectorWindow();
		return { opened: true };
	});

	ipcMain.handle("open-notes", async () => {
		const notesSelectorWin = getNotesWindow();
		if (notesSelectorWin) {
			notesSelectorWin.focus();
			return { opened: true };
		}

		createNotesWindowWrapper();
		return { opened: true };
	});

	ipcMain.handle("switch-to-editor", () => {
		// createEditorWindow already closes the current mainWindow (the HUD) before
		// opening the editor. Closing it here too double-closes, leaving ghost
		// transparent windows and compounding the HUD shadow each cycle.
		createEditorWindow();
	});

	ipcMain.handle("switch-to-hud", () => {
		_switchToHud?.();
		return { success: true };
	});

	ipcMain.handle("start-new-recording", () => {
		_switchToHud?.();
		const hudWindow = getMainWindow();
		if (hudWindow && !hudWindow.isDestroyed()) {
			const sendAutoStart = () => hudWindow.webContents.send("hud-auto-start-recording");
			if (hudWindow.webContents.isLoading()) {
				hudWindow.webContents.once("did-finish-load", sendAutoStart);
			} else {
				sendAutoStart();
			}
		}
		return { success: true };
	});

	ipcMain.handle("countdown-overlay-show", async (_, value: number, runId: number) => {
		const overlayWindow = getCountdownOverlayWindow?.() ?? createCountdownOverlayWindow();
		if (overlayWindow.isDestroyed()) {
			return;
		}

		// Wait for the first frame before showing, else Chromium flashes a black
		// rectangle because it hasn't rendered any pixels yet.
		if (overlayWindow.webContents.isLoading()) {
			await new Promise<void>((resolve) => {
				overlayWindow.once("ready-to-show", resolve);
			});
		}

		if (!overlayWindow.isVisible()) {
			overlayWindow.showInactive();
		}

		overlayWindow.webContents.send("countdown-overlay-value", value, runId);
	});

	ipcMain.handle("countdown-overlay-set-value", (_, value: number, runId: number) => {
		const overlayWindow = getCountdownOverlayWindow?.();
		if (!overlayWindow || overlayWindow.isDestroyed()) {
			return;
		}

		overlayWindow.webContents.send("countdown-overlay-value", value, runId);
	});

	ipcMain.handle("countdown-overlay-hide", (_, runId: number) => {
		const overlayWindow = getCountdownOverlayWindow?.();
		if (!overlayWindow || overlayWindow.isDestroyed()) {
			return;
		}

		overlayWindow.webContents.send("countdown-overlay-value", null, runId);
		overlayWindow.hide();
	});

	ipcMain.handle("is-native-windows-capture-available", async () => {
		if (!isWindowsGraphicsCaptureOsSupported()) {
			return { success: true, available: false, reason: "unsupported-os" };
		}

		const helperPath = await findNativeWindowsCaptureHelperPath();
		return helperPath
			? { success: true, available: true, helperPath }
			: { success: true, available: false, reason: "missing-helper" };
	});

	ipcMain.handle("is-native-mac-capture-available", async () => {
		if (process.platform !== "darwin") {
			return { success: true, available: false, reason: "unsupported-platform" };
		}

		const helperPath = await findNativeMacCaptureHelperPath();
		return helperPath
			? { success: true, available: true, helperPath }
			: { success: true, available: false, reason: "missing-helper" };
	});

	ipcMain.handle("is-native-linux-capture-available", async () => {
		if (process.platform !== "linux") {
			return { success: true, available: false, reason: "unsupported-platform" };
		}

		const helperPath = findPipeWireCursorHelperPath();
		return helperPath
			? { success: true, available: true, helperPath }
			: { success: true, available: false, reason: "missing-helper" };
	});

	/**
	 * Raises the compositor's picker and stops there, holding the grant.
	 *
	 * Best-effort by contract: every failure returns `success: false` rather than
	 * throwing, because the caller's fallback is simply to start normally and get
	 * the picker after its countdown — the behaviour that shipped before this
	 * existed. Nothing downstream may depend on a prepare having succeeded.
	 */
	ipcMain.handle(
		"prepare-native-linux-recording",
		async (_, request: NativeLinuxRecordingRequest) => {
			if (process.platform !== "linux") {
				return { success: false, reason: "unsupported-platform" };
			}
			if (linuxNativeCaptureSession) {
				return { success: false, reason: "already-recording" };
			}
			discardPreparedLinuxCapture("superseded by a new prepare");
			const token = Symbol("prepare-native-linux-recording");
			preparingLinuxCaptureToken = token;

			try {
				if (!findPipeWireCursorHelperPath()) {
					return { success: false, reason: "missing-helper" };
				}
				const recordingId =
					typeof request?.recordingId === "number" && Number.isFinite(request.recordingId)
						? request.recordingId
						: Date.now();
				const outputPath = path.join(RECORDINGS_DIR, `${RECORDING_FILE_PREFIX}${recordingId}.mp4`);
				const cursorCaptureMode =
					normalizeCursorCaptureMode(request?.cursor?.mode) ?? "editable-overlay";

				await fs.mkdir(RECORDINGS_DIR, { recursive: true });

				const session = new LinuxNativeCaptureSession({
					outputPath,
					cursorMode: portalCursorMode(cursorCaptureMode),
					fps: request.video.fps,
					...(request.video.bitrate ? { bitrate: request.video.bitrate } : {}),
					audio: {
						system: { enabled: request.audio.system.enabled },
						microphone: {
							enabled: request.audio.microphone.enabled,
							...(request.audio.microphone.deviceName
								? { deviceName: request.audio.microphone.deviceName }
								: {}),
							gain: request.audio.microphone.gain,
						},
					},
					maxCursorSamples: MAX_CURSOR_SAMPLES,
					deferStart: true,
				});

				await session.start();
				// The picker is up now. No timeout: a human is reading a dialog.
				await session.waitUntilSourceSelected();

				// Cancelled or superseded while the picker was up. Discard rather
				// than assign: this grant is for a recording nobody is waiting for
				// any more, and keeping it would leave the sharing indicator on.
				if (preparingLinuxCaptureToken !== token) {
					session.discard();
					return { success: false, reason: "cancelled" };
				}
				preparingLinuxCaptureToken = null;

				preparedLinuxCapture = { session, outputPath, request };
				return {
					success: true,
					recordingId,
					sourceKind: session.grantedSourceKind ?? null,
				};
			} catch (error) {
				console.warn("Could not prepare the native Linux capture:", error);
				discardPreparedLinuxCapture("prepare failed");
				return { success: false, error: String(error) };
			}
		},
	);

	/** Drops a prepared session, e.g. when the countdown was cancelled. */
	ipcMain.handle("cancel-native-linux-prepare", async () => {
		discardPreparedLinuxCapture("cancelled by the renderer");
		return { success: true };
	});

	ipcMain.handle(
		"start-native-linux-recording",
		async (_, request: NativeLinuxRecordingRequest) => {
			try {
				if (process.platform !== "linux") {
					return { success: false, error: "Native Linux capture requires Linux." };
				}
				if (linuxNativeCaptureSession) {
					return { success: false, error: "Native Linux capture is already running." };
				}
				if (!findPipeWireCursorHelperPath()) {
					return { success: false, error: "Native Linux capture helper is not available." };
				}

				const recordingId =
					typeof request?.recordingId === "number" && Number.isFinite(request.recordingId)
						? request.recordingId
						: Date.now();
				const outputPath = path.join(RECORDINGS_DIR, `${RECORDING_FILE_PREFIX}${recordingId}.mp4`);
				const cursorCaptureMode =
					normalizeCursorCaptureMode(request?.cursor?.mode) ?? "editable-overlay";

				await fs.mkdir(RECORDINGS_DIR, { recursive: true });

				// A session prepared before the countdown, if there was one. Taking
				// it here rather than requiring it is what keeps every caller
				// working: a path that never prepared still gets a full start
				// below, just with the picker after its countdown instead of
				// before. Nothing has to know which path it is on.
				const prepared = takePreparedLinuxSession(outputPath, request);
				const session =
					prepared ??
					new LinuxNativeCaptureSession({
						outputPath,
						cursorMode: portalCursorMode(cursorCaptureMode),
						fps: request.video.fps,
						...(request.video.bitrate ? { bitrate: request.video.bitrate } : {}),
						audio: {
							system: { enabled: request.audio.system.enabled },
							microphone: {
								enabled: request.audio.microphone.enabled,
								...(request.audio.microphone.deviceName
									? { deviceName: request.audio.microphone.deviceName }
									: {}),
								gain: request.audio.microphone.gain,
							},
						},
						maxCursorSamples: MAX_CURSOR_SAMPLES,
					});

				console.info("[native-linux] starting capture", {
					outputPath,
					prepared: Boolean(prepared),
					cursor: { mode: cursorCaptureMode },
					audio: request.audio,
					video: request.video,
				});

				if (!prepared) {
					await session.start();
					// Blocks until the user answers the portal picker, which has no
					// upper bound. On this path the countdown has already run.
					await session.waitUntilSourceSelected();
				}
				// Idempotent, and a no-op for a session that was not deferred.
				session.arm();
				await session.waitUntilCapturing();

				linuxNativeCaptureSession = session;
				linuxNativeCaptureRecordingId = recordingId;
				linuxNativeCaptureCursorMode = cursorCaptureMode;

				// The portal's answer, not an in-app selection — on Wayland there
				// is none to have. This used to read `selectedSource || { name:
				// "Screen" }`, so the tray confidently displayed the name of a
				// window the capture had never been told about.
				linuxNativeCaptureSourceLabel = linuxSourceLabel(session.grantedSourceKind);
				if (onRecordingStateChange) {
					onRecordingStateChange(true, linuxNativeCaptureSourceLabel);
				}

				return { success: true, recordingId, path: outputPath };
			} catch (error) {
				console.error("Failed to start native Linux recording:", error);
				linuxNativeCaptureSession = null;
				linuxNativeCaptureRecordingId = null;
				linuxNativeCaptureCursorMode = "editable-overlay";
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle("pause-native-linux-recording", async () => {
		if (!linuxNativeCaptureSession) {
			return { success: false, error: "Native Linux capture is not running." };
		}
		linuxNativeCaptureSession.pause();
		return { success: true };
	});

	ipcMain.handle("resume-native-linux-recording", async () => {
		if (!linuxNativeCaptureSession) {
			return { success: false, error: "Native Linux capture is not running." };
		}
		linuxNativeCaptureSession.resume();
		return { success: true };
	});

	ipcMain.handle("stop-native-linux-recording", async (_, discard?: boolean) => {
		const session = linuxNativeCaptureSession;
		const recordingId = linuxNativeCaptureRecordingId ?? Date.now();
		const cursorCaptureMode = linuxNativeCaptureCursorMode;

		if (!session) {
			return { success: false, error: "Native Linux capture is not running." };
		}

		try {
			if (discard) {
				session.discard();
				const discarded = path.join(RECORDINGS_DIR, `${RECORDING_FILE_PREFIX}${recordingId}.mp4`);
				await Promise.all([
					fs.rm(discarded, { force: true }),
					fs.rm(`${discarded}.cursor.json`, { force: true }),
				]);
				return { success: true, discarded: true };
			}

			const result = await session.stop();

			// The helper collects cursor samples itself, from the same portal
			// session that produced the pixels, so there is no separate sampler
			// to stop and no clock offset to correct — the two are one recording.
			if (cursorCaptureMode === "editable-overlay" && result.cursor.samples.length > 0) {
				await fs.writeFile(
					`${result.path}.cursor.json`,
					JSON.stringify(result.cursor, null, 2),
					"utf-8",
				);
			}

			const session_: RecordingSession = {
				screenVideoPath: result.path,
				createdAt: recordingId,
				cursorCaptureMode,
			};
			setCurrentRecordingSessionState(session_);
			currentProjectPath = null;

			const sessionManifestPath = path.join(
				RECORDINGS_DIR,
				`${path.parse(result.path).name}${RECORDING_SESSION_SUFFIX}`,
			);
			await fs.writeFile(sessionManifestPath, JSON.stringify(session_, null, 2), "utf-8");
			await registerRecordingMediaLinks(result.path, { cursorCaptureMode });

			console.info("[native-linux] capture stored", {
				path: result.path,
				frames: result.frames,
				droppedFrames: result.droppedFrames,
				durationMs: result.durationMs,
				videoEncoder: result.videoEncoder,
				cursorSamples: result.cursor.samples.length,
			});

			return {
				success: true,
				path: result.path,
				session: session_,
				message: "Native Linux recording session stored successfully",
			};
		} catch (error) {
			console.error("Failed to stop native Linux recording:", error);
			return { success: false, error: String(error) };
		} finally {
			linuxNativeCaptureSession = null;
			linuxNativeCaptureRecordingId = null;
			linuxNativeCaptureCursorMode = "editable-overlay";
			const stoppedLabel = linuxNativeCaptureSourceLabel ?? linuxSourceLabel();
			linuxNativeCaptureSourceLabel = null;
			if (onRecordingStateChange) {
				onRecordingStateChange(false, stoppedLabel);
			}
		}
	});

	ipcMain.handle(
		"start-native-windows-recording",
		async (_, request: NativeWindowsRecordingRequest) => {
			try {
				if (!isWindowsGraphicsCaptureOsSupported()) {
					return {
						success: false,
						error: "Windows Graphics Capture requires Windows 10 build 19041 or newer.",
					};
				}
				if (nativeWindowsCaptureProcess) {
					return { success: false, error: "Native Windows capture is already running." };
				}

				const helperPath = await findNativeWindowsCaptureHelperPath();
				if (!helperPath) {
					return { success: false, error: "Native Windows capture helper is not available." };
				}

				if (!request?.source?.sourceId) {
					return {
						success: false,
						error: "Native Windows capture request is missing a source.",
					};
				}

				const recordingId =
					typeof request.recordingId === "number" && Number.isFinite(request.recordingId)
						? request.recordingId
						: Date.now();
				const outputPath = path.join(RECORDINGS_DIR, `${RECORDING_FILE_PREFIX}${recordingId}.mp4`);
				const webcamOutputPath = path.join(
					RECORDINGS_DIR,
					`${RECORDING_FILE_PREFIX}${recordingId}-webcam.mp4`,
				);
				const sourceDisplay =
					request.source.type === "display" && typeof request.source.displayId === "number"
						? (screen.getAllDisplays().find((display) => display.id === request.source.displayId) ??
							null)
						: getSelectedDisplay();
				const bounds = sourceDisplay?.bounds ?? getSelectedSourceBounds();
				// `bounds` is DIPs; the helper matches it against physical monitor rects
				// (getopenscreen/openscreen#346). Converted here, at the wire, and not in
				// `getSelectedSourceBounds` — the cursor session shares that getter and
				// converts on its own side.
				const helperBounds = toHelperRect(bounds);
				const displayId =
					typeof request.source.displayId === "number" && Number.isFinite(request.source.displayId)
						? request.source.displayId
						: Number(selectedSource?.display_id);
				const webcamDirectShowClsid = request.webcam.enabled
					? await resolveDirectShowWebcamClsid(request.webcam.deviceName)
					: null;
				const cursorCaptureMode =
					normalizeCursorCaptureMode(request.cursor?.mode) ?? "editable-overlay";
				const envPreferSoftwareEncoder = (process.env.OPENSCREEN_WGC_PREFER_SOFTWARE_ENCODER ?? "")
					.trim()
					.toLowerCase();
				const preferSoftwareEncoder =
					request.preferSoftwareEncoder === true ||
					envPreferSoftwareEncoder === "true" ||
					envPreferSoftwareEncoder === "1";
				const config = {
					schemaVersion: 2,
					recordingId,
					preferSoftwareEncoder,
					outputPath,
					sourceType: request.source.type,
					sourceId: request.source.sourceId,
					displayId: Number.isFinite(displayId) ? displayId : 0,
					windowHandle: request.source.windowHandle ?? null,
					fps: request.video.fps,
					videoWidth: request.video.width,
					videoHeight: request.video.height,
					displayX: helperBounds.x,
					displayY: helperBounds.y,
					displayW: helperBounds.width,
					displayH: helperBounds.height,
					hasDisplayBounds: true,
					captureSystemAudio: request.audio.system.enabled,
					captureMic: request.audio.microphone.enabled,
					microphoneDeviceId: request.audio.microphone.deviceId ?? null,
					microphoneDeviceName: request.audio.microphone.deviceName ?? null,
					microphoneGain: request.audio.microphone.gain,
					webcamEnabled: request.webcam.enabled,
					webcamDeviceId: request.webcam.deviceId ?? null,
					webcamDeviceName: request.webcam.deviceName ?? null,
					webcamDirectShowClsid,
					webcamWidth: request.webcam.width,
					webcamHeight: request.webcam.height,
					webcamFps: request.webcam.fps,
					captureCursor: cursorCaptureMode === "system",
					cursorCaptureMode,
					outputs: {
						screenPath: outputPath,
						webcamPath: webcamOutputPath,
					},
					source: {
						type: request.source.type,
						sourceId: request.source.sourceId,
						displayId: Number.isFinite(displayId) ? displayId : null,
						windowHandle: request.source.windowHandle ?? null,
						bounds: helperBounds,
					},
					video: request.video,
					audio: request.audio,
					webcam: request.webcam,
					cursor: {
						mode: cursorCaptureMode,
					},
				};

				console.info("[native-wgc] starting Windows capture", {
					helperPath,
					source: request.source,
					audio: request.audio,
					webcam: request.webcam,
					encoder: { preferSoftwareEncoder },
					cursor: { mode: cursorCaptureMode },
					// Both spaces, deliberately: the helper's own errors quote the physical
					// rect, and a report that only carried the DIP one would be read against
					// numbers it never saw (getopenscreen/openscreen#346).
					bounds: { dip: bounds, helper: helperBounds },
					sourceId: selectedSource?.id ?? null,
					usedDisplayMatch: Boolean(sourceDisplay),
					outputPath,
				});

				await fs.mkdir(RECORDINGS_DIR, { recursive: true });
				nativeWindowsCaptureOutput = "";
				nativeWindowsCaptureTargetPath = outputPath;
				nativeWindowsCaptureWebcamTargetPath = request.webcam.enabled ? webcamOutputPath : null;
				nativeWindowsCaptureRecordingId = recordingId;
				nativeWindowsCursorOffsetMs = 0;
				nativeWindowsCursorCaptureMode = cursorCaptureMode;
				nativeWindowsCursorRecordingStartMs = 0;
				nativeWindowsPauseStartedAtMs = null;
				nativeWindowsPauseRanges = [];
				nativeWindowsIsPaused = false;

				const cursorStartTimeMs = Date.now();
				if (cursorCaptureMode === "editable-overlay") {
					nativeWindowsCursorRecordingStartMs = cursorStartTimeMs;
					await startCursorRecording(cursorStartTimeMs);
					console.info("[native-wgc] cursor sampler ready", {
						cursorStartTimeMs,
						warmupMs: Date.now() - cursorStartTimeMs,
					});
				} else {
					pendingCursorRecordingData = null;
				}

				const proc = spawn(helperPath, [JSON.stringify(config)], {
					cwd: RECORDINGS_DIR,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
				nativeWindowsCaptureProcess = proc;
				nativeWindowsCaptureDrainCleanup = attachNativeWindowsCaptureOutputDrain(proc);
				console.info("[native-wgc] helper spawned", { pid: proc.pid });

				await waitForNativeWindowsCaptureStart(proc);
				const captureStartedAtMs = Date.now();
				nativeWindowsCursorOffsetMs =
					cursorCaptureMode === "editable-overlay"
						? Math.max(0, captureStartedAtMs - cursorStartTimeMs)
						: 0;
				const webcamFormat = readWebcamFormat(nativeWindowsCaptureOutput);
				const encoderSelection = readNativeWindowsEncoderSelection(nativeWindowsCaptureOutput);
				// Captured now because stop may have no helper left to ask. A helper
				// killed mid-recording is exactly the case where this matters most.
				nativeWindowsCaptureContainer = encoderSelection?.container ?? null;
				console.info("[native-wgc] capture started", {
					captureStartedAtMs,
					cursorOffsetMs: nativeWindowsCursorOffsetMs,
					webcamFormat,
					encoderSelection,
				});

				const source = selectedSource || { name: "Screen" };
				if (onRecordingStateChange) {
					onRecordingStateChange(true, source.name);
				}

				// Reported at start, not at stop: the helper decides the camera is a
				// lost cause during its own init — before it announces "Recording
				// started", so the warning is already in the buffer here — and telling
				// the user now, while the take is still worth restarting, beats telling
				// them at the end. Keyed on the helper's own event rather than on a
				// missing `webcamFormat`: absence of the format line also means "the
				// line could not be parsed", which would put a red toast on a recording
				// whose camera is working perfectly.
				const webcamUnavailable =
					request.webcam.enabled && readWebcamUnavailable(nativeWindowsCaptureOutput);
				// Same shape as the camera notice: the helper records the Windows
				// default input rather than failing, so this take is usable but is
				// almost certainly the wrong microphone.
				const microphoneDefaulted =
					request.audio.microphone.enabled && readMicrophoneDefaulted(nativeWindowsCaptureOutput);
				if (microphoneDefaulted) {
					console.warn("[native-wgc] recording the default input; the microphone was not named", {
						deviceId: request.audio.microphone.deviceId,
						deviceName: request.audio.microphone.deviceName,
					});
				}
				if (webcamUnavailable) {
					console.warn("[native-wgc] recording without a camera; the helper could not open it", {
						deviceId: request.webcam.deviceId,
						deviceName: request.webcam.deviceName,
					});
				}

				return {
					success: true,
					recordingId,
					path: outputPath,
					helperPath,
					videoEncoderSelection: encoderSelection?.video ?? null,
					videoEncoderRuntime: encoderSelection?.videoEncoderRuntime ?? null,
					webcamUnavailable,
					microphoneDefaulted,
				};
			} catch (error) {
				console.error("Failed to start native Windows recording:", error);
				nativeWindowsCaptureProcess?.kill();
				detachNativeWindowsCaptureOutputDrain();
				resetNativeWindowsCaptureState();
				await stopCursorRecording();
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle("start-native-mac-recording", async (_, request: NativeMacRecordingRequest) => {
		try {
			if (process.platform !== "darwin") {
				return { success: false, error: "Native macOS capture requires macOS." };
			}
			if (nativeMacCaptureProcess) {
				return { success: false, error: "Native macOS capture is already running." };
			}

			const helperPath = await findNativeMacCaptureHelperPath();
			if (!helperPath) {
				return { success: false, error: "Native macOS capture helper is not available." };
			}

			if (!request?.source?.sourceId) {
				return { success: false, error: "Native macOS capture request is missing a source." };
			}

			const recordingId =
				typeof request.recordingId === "number" && Number.isFinite(request.recordingId)
					? request.recordingId
					: Date.now();
			const outputPath = path.join(RECORDINGS_DIR, `${RECORDING_FILE_PREFIX}${recordingId}.mp4`);
			const cursorCaptureMode =
				normalizeCursorCaptureMode(request.cursor?.mode) ?? "editable-overlay";
			try {
				await desktopCapturer.getSources({
					types: ["screen"],
					thumbnailSize: { width: 1, height: 1 },
				});
			} catch {
				// The helper reports the final ScreenCaptureKit permission status.
			}
			if (request.audio?.microphone?.enabled) {
				const micStatus = systemPreferences.getMediaAccessStatus("microphone");
				if (micStatus !== "granted") {
					await systemPreferences.askForMediaAccess("microphone");
				}
			}
			const sourceDisplay =
				request.source.type === "display" && typeof request.source.displayId === "number"
					? (screen.getAllDisplays().find((display) => display.id === request.source.displayId) ??
						null)
					: getSelectedDisplay();
			const bounds = request.source.bounds ?? sourceDisplay?.bounds ?? getSelectedSourceBounds();
			const config: NativeMacRecordingRequest = {
				...request,
				schemaVersion: 1,
				recordingId,
				source: {
					...request.source,
					bounds,
				},
				video: {
					...request.video,
					hideSystemCursor: cursorCaptureMode === "editable-overlay",
				},
				webcam: {
					...request.webcam,
					enabled: false,
				},
				cursor: {
					mode: cursorCaptureMode,
				},
				outputs: {
					screenPath: outputPath,
					manifestPath: path.join(
						RECORDINGS_DIR,
						`${RECORDING_FILE_PREFIX}${recordingId}${RECORDING_SESSION_SUFFIX}`,
					),
				},
			};

			console.info("[native-sck] starting macOS capture", {
				helperPath,
				source: config.source,
				audio: config.audio,
				webcam: config.webcam,
				cursor: config.cursor,
				outputPath,
			});

			await fs.mkdir(RECORDINGS_DIR, { recursive: true });
			nativeMacCaptureOutput = "";
			nativeMacCaptureTargetPath = outputPath;
			nativeMacCaptureRecordingId = recordingId;
			nativeMacCursorOffsetMs = 0;
			nativeMacCursorCaptureMode = cursorCaptureMode;
			nativeMacCursorRecordingStartMs = 0;
			nativeMacPauseStartedAtMs = null;
			nativeMacPauseRanges = [];
			nativeMacIsPaused = false;
			activeMacCaptureBounds = null;

			const cursorStartTimeMs = Date.now();
			if (cursorCaptureMode === "editable-overlay") {
				nativeMacCursorRecordingStartMs = cursorStartTimeMs;
				await startCursorRecording(cursorStartTimeMs);
			} else {
				pendingCursorRecordingData = null;
			}

			const proc = spawn(helperPath, [JSON.stringify(config)], {
				cwd: RECORDINGS_DIR,
				stdio: ["pipe", "pipe", "pipe"],
			});
			nativeMacCaptureProcess = proc;
			attachNativeMacCaptureOutputDrain(proc);

			await waitForNativeMacCaptureStart(proc);
			const captureStartedAtMs = Date.now();
			nativeMacCursorOffsetMs =
				cursorCaptureMode === "editable-overlay"
					? Math.max(0, captureStartedAtMs - cursorStartTimeMs)
					: 0;

			const source = selectedSource || { name: "Screen" };
			if (onRecordingStateChange) {
				onRecordingStateChange(true, source.name);
			}

			return {
				success: true,
				recordingId,
				path: outputPath,
				helperPath,
			};
		} catch (error) {
			console.error("Failed to start native macOS recording:", error);
			nativeMacCaptureProcess?.kill();
			nativeMacCaptureProcess = null;
			nativeMacCaptureTargetPath = null;
			nativeMacCaptureRecordingId = null;
			nativeMacCursorOffsetMs = 0;
			nativeMacCursorCaptureMode = "editable-overlay";
			nativeMacCursorRecordingStartMs = 0;
			nativeMacPauseStartedAtMs = null;
			nativeMacPauseRanges = [];
			nativeMacIsPaused = false;
			await stopCursorRecording();
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipcMain.handle("pause-native-mac-recording", async () => {
		if (process.platform !== "darwin") {
			return { success: false, error: "Native macOS capture requires macOS." };
		}

		const proc = nativeMacCaptureProcess;
		if (!proc) {
			return { success: false, error: "Native macOS capture is not running." };
		}
		if (nativeMacIsPaused) {
			return { success: true };
		}
		if (!proc.stdin.writable) {
			return { success: false, error: "Native macOS capture command channel is closed." };
		}

		try {
			proc.stdin.write("pause\n");
			nativeMacIsPaused = true;
			nativeMacPauseStartedAtMs = Date.now();
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipcMain.handle("resume-native-mac-recording", async () => {
		if (process.platform !== "darwin") {
			return { success: false, error: "Native macOS capture requires macOS." };
		}

		const proc = nativeMacCaptureProcess;
		if (!proc) {
			return { success: false, error: "Native macOS capture is not running." };
		}
		if (!nativeMacIsPaused) {
			return { success: true };
		}
		if (!proc.stdin.writable) {
			return { success: false, error: "Native macOS capture command channel is closed." };
		}

		try {
			proc.stdin.write("resume\n");
			completeNativeMacCursorPauseRange();
			nativeMacIsPaused = false;
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipcMain.handle("pause-native-windows-recording", async () => {
		const proc = nativeWindowsCaptureProcess;
		if (!proc) {
			return { success: false, error: "Native Windows capture is not running." };
		}
		if (nativeWindowsIsPaused) {
			return { success: true };
		}
		if (!proc.stdin.writable) {
			return { success: false, error: "Native Windows capture command channel is closed." };
		}

		try {
			proc.stdin.write("pause\n");
			nativeWindowsIsPaused = true;
			nativeWindowsPauseStartedAtMs = Date.now();
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipcMain.handle("resume-native-windows-recording", async () => {
		const proc = nativeWindowsCaptureProcess;
		if (!proc) {
			return { success: false, error: "Native Windows capture is not running." };
		}
		if (!nativeWindowsIsPaused) {
			return { success: true };
		}
		if (!proc.stdin.writable) {
			return { success: false, error: "Native Windows capture command channel is closed." };
		}

		try {
			proc.stdin.write("resume\n");
			completeNativeWindowsCursorPauseRange();
			nativeWindowsIsPaused = false;
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipcMain.handle("stop-native-windows-recording", async (_, discard?: boolean) => {
		const proc = nativeWindowsCaptureProcess;
		const preferredPath = nativeWindowsCaptureTargetPath;
		const preferredWebcamPath = nativeWindowsCaptureWebcamTargetPath;
		const recordingId = nativeWindowsCaptureRecordingId ?? Date.now();
		const cursorCaptureMode = nativeWindowsCursorCaptureMode;

		if (!proc) {
			return { success: false, error: "Native Windows capture is not running." };
		}

		// Discarding does not need a finalized file, so it must not wait for one.
		// Cancel and Restart both route here, and making them sit through the
		// full stop handshake meant a wedged helper could not be escaped from at
		// all -- the user waited out the timeout only to be told the recording
		// failed, then waited it out again to cancel. Linux has always done this;
		// Windows never did.
		if (discard) {
			try {
				completeNativeWindowsCursorPauseRange();
				await stopCursorRecording();
				pendingCursorRecordingData = null;
				const exited = await terminateNativeWindowsCapture(proc);
				if (!exited) {
					detachNativeWindowsCaptureOutputDrain();
				}
				await removeNativeWindowsCaptureOutputs(preferredPath, preferredWebcamPath);
				return { success: true, discarded: true };
			} finally {
				// Unconditional. Killing a wedged helper can itself throw, and
				// leaving the handle set would make every later recording fail
				// with "already running" against a process nobody can stop.
				resetNativeWindowsCaptureState();
				if (onRecordingStateChange) {
					onRecordingStateChange(false, (selectedSource || { name: "Screen" }).name);
				}
			}
		}

		// Set when the helper failed its stop handshake but left a playable
		// fragmented file. Reported so a bug report can tell a clean stop from a
		// recovered one; the user-facing path is deliberately identical.
		let recovered = false;

		try {
			completeNativeWindowsCursorPauseRange();
			const stopPromise = waitForNativeWindowsCaptureStop({
				proc,
				targetPath: preferredPath,
				readOutput: () => nativeWindowsCaptureOutput,
			});
			if (!sendNativeWindowsStopCommand(proc)) {
				console.warn("[native-wgc] stop command channel was already closed");
			}
			const stopResult = await stopPromise;
			if (!stopResult.ok) {
				console.error("[native-wgc] stop failed", {
					reason: stopResult.reason,
					exited: stopResult.exited,
					pid: proc.pid,
					output: stopResult.message,
				});
				if (!stopResult.exited) {
					detachNativeWindowsCaptureOutputDrain();
				}

				// A failed stop stopped meaning a lost take when the helper started
				// writing fragmented MP4. The file on disk is already playable, so
				// the only thing standing between the user and their recording is
				// this function deciding to throw it away and say so. Fall through
				// into the normal save path instead: same manifest, same media
				// links, same editor. From the user's side it simply worked, minus
				// at most the last incomplete fragment.
				//
				// Only once the helper is actually dead. `exited: false` means it
				// survived even the forced kill -- stuck somewhere `TerminateProcess`
				// could not reach -- and on Windows such a process still holds the
				// MP4 open and may still be appending to it. Handing that file to
				// the editor trades an honest failure for a sharing violation on a
				// file that is still moving, so a wedged helper keeps the old answer.
				if (stopResult.exited && (await salvageNativeWindowsFragmentedCapture(preferredPath))) {
					console.warn("[native-wgc] stop failed but the fragmented output is playable", {
						reason: stopResult.reason,
						path: preferredPath,
					});
					recovered = true;
				} else {
					await stopCursorRecording();
					// Same as the discard path. `startCursorRecording` clears this on
					// the next recording anyway, so this is not what keeps the samples
					// from being written next to someone else's video -- it just stops
					// a lost take's telemetry from sitting in memory until then.
					pendingCursorRecordingData = null;
					// Reaching here means the container was the plain one, whose only
					// index is written by the `Finalize()` this stop never reached, so
					// what is on disk really is an unindexed stub and leaving those
					// behind just accumulates unplayable recordings the user cannot
					// explain. Size-gate it anyway: throwing away a recording to tidy
					// up after a failed stop is the worse mistake of the two, and the
					// gate is the same one the salvage check above uses.
					await removeNativeWindowsCaptureOutputs(preferredPath, preferredWebcamPath, {
						onlyIfUnusable: true,
					});
					// The helper log goes to console/diagnostics above, not into this
					// string: it ends up in a toast, and pasting an entire capture log
					// into the HUD tells the user nothing they can act on.
					return {
						success: false,
						reason: stopResult.reason,
						error:
							stopResult.reason === "stop-timeout"
								? "Timed out waiting for native Windows capture to stop. The recording could not be saved."
								: stopResult.message.split(/\r?\n/).filter(Boolean).at(-1) ||
									"Native Windows capture failed.",
					};
				}
			}

			// Only a successful stop names the file; the salvage path above falls
			// through with `ok: false` and nothing but the path we asked for.
			const screenVideoPath = (stopResult.ok ? stopResult.screenVideoPath : null) || preferredPath;
			if (!screenVideoPath) {
				throw new Error("Native Windows capture did not return an output path.");
			}

			if (cursorCaptureMode === "editable-overlay") {
				await stopCursorRecording();
			} else {
				pendingCursorRecordingData = null;
			}

			if (cursorCaptureMode === "editable-overlay") {
				compactPendingCursorTelemetryPauseRanges(nativeWindowsPauseRanges);
				shiftPendingCursorTelemetry(nativeWindowsCursorOffsetMs);
				await writePendingCursorTelemetry(screenVideoPath);
			}
			let webcamVideoPath: string | undefined;
			if (preferredWebcamPath) {
				try {
					// Size, not just existence. A camera that opened but delivered no
					// frame still gets a file created for it, and its `Finalize()` then
					// fails, leaving nought bytes on disk. Admitting that file put a
					// camera track in the document pointing at something no demuxer can
					// read, and the preview compositor answers an unreadable camera by
					// drawing the SCREEN recording inside the little camera rectangle —
					// which is how a webcam that never recorded showed up as the desktop
					// duplicated into its own corner (getopenscreen/openscreen#387).
					const webcamStat = await fs.stat(preferredWebcamPath);
					webcamVideoPath = webcamStat.size > 0 ? preferredWebcamPath : undefined;
					if (!webcamVideoPath) {
						console.warn("[native-wgc] the webcam file is empty; saving without a camera", {
							path: preferredWebcamPath,
						});
					}
				} catch {
					webcamVideoPath = undefined;
				}
			}
			const session: RecordingSession = webcamVideoPath
				? { screenVideoPath, webcamVideoPath, createdAt: recordingId, cursorCaptureMode }
				: { screenVideoPath, createdAt: recordingId, cursorCaptureMode };
			setCurrentRecordingSessionState(session);
			currentProjectPath = null;

			const sessionManifestPath = path.join(
				RECORDINGS_DIR,
				`${path.parse(screenVideoPath).name}${RECORDING_SESSION_SUFFIX}`,
			);
			await fs.writeFile(sessionManifestPath, JSON.stringify(session, null, 2), "utf-8");
			await registerRecordingMediaLinks(screenVideoPath, { webcamVideoPath, cursorCaptureMode });

			return {
				success: true,
				path: screenVideoPath,
				session,
				recovered,
				// `preferredWebcamPath` is non-null only for a take that asked for a
				// camera, so the pair means "a camera was requested and none survived".
				// This is the second, quieter way to lose one: the helper opened the
				// device happily and then never got a frame out of it, so it reports no
				// `webcam-unavailable` and the start-time notice stays silent. Left
				// unreported, the user would find out in the editor — which is exactly
				// the silence this change exists to end.
				webcamDropped: Boolean(preferredWebcamPath) && !webcamVideoPath,
				message: recovered
					? "Native Windows recording recovered from a failed stop"
					: "Native Windows recording session stored successfully",
			};
		} catch (error) {
			console.error("Failed to stop native Windows recording:", error);
			await stopCursorRecording();
			return { success: false, error: String(error) };
		} finally {
			resetNativeWindowsCaptureState();
			const source = selectedSource || { name: "Screen" };
			if (onRecordingStateChange) {
				onRecordingStateChange(false, source.name);
			}
		}
	});

	ipcMain.handle("stop-native-mac-recording", async (_, discard?: boolean) => {
		if (process.platform !== "darwin") {
			return { success: false, error: "Native macOS capture requires macOS." };
		}

		const proc = nativeMacCaptureProcess;
		const preferredPath = nativeMacCaptureTargetPath;
		const recordingId = nativeMacCaptureRecordingId ?? Date.now();
		const cursorCaptureMode = nativeMacCursorCaptureMode;

		if (!proc) {
			return { success: false, error: "Native macOS capture is not running." };
		}

		try {
			completeNativeMacCursorPauseRange();
			const stoppedPathPromise = waitForNativeMacCaptureStop(proc);
			proc.stdin.write("stop\n");
			const stoppedPath = await stoppedPathPromise;
			const screenVideoPath = stoppedPath || preferredPath;
			if (!screenVideoPath) {
				throw new Error("Native macOS capture did not return an output path.");
			}

			if (cursorCaptureMode === "editable-overlay") {
				await stopCursorRecording();
			} else {
				pendingCursorRecordingData = null;
			}
			if (discard) {
				pendingCursorRecordingData = null;
				await Promise.all([
					fs.rm(screenVideoPath, { force: true }),
					fs.rm(`${screenVideoPath}.cursor.json`, { force: true }),
				]);
				return { success: true, discarded: true };
			}

			if (cursorCaptureMode === "editable-overlay") {
				compactPendingCursorTelemetryPauseRanges(nativeMacPauseRanges);
				shiftPendingCursorTelemetry(nativeMacCursorOffsetMs);
				await writePendingCursorTelemetry(screenVideoPath);
			}

			const session: RecordingSession = {
				screenVideoPath,
				createdAt: recordingId,
				cursorCaptureMode,
			};
			setCurrentRecordingSessionState(session);
			currentProjectPath = null;

			const sessionManifestPath = path.join(
				RECORDINGS_DIR,
				`${path.parse(screenVideoPath).name}${RECORDING_SESSION_SUFFIX}`,
			);
			await fs.writeFile(sessionManifestPath, JSON.stringify(session, null, 2), "utf-8");
			await registerRecordingMediaLinks(screenVideoPath, { cursorCaptureMode });

			return {
				success: true,
				path: screenVideoPath,
				session,
				message: "Native macOS recording session stored successfully",
			};
		} catch (error) {
			console.error("Failed to stop native macOS recording:", error);
			await stopCursorRecording();
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			nativeMacCaptureProcess = null;
			nativeMacCaptureTargetPath = null;
			nativeMacCaptureRecordingId = null;
			nativeMacCursorOffsetMs = 0;
			nativeMacCursorCaptureMode = "editable-overlay";
			nativeMacCursorRecordingStartMs = 0;
			nativeMacPauseStartedAtMs = null;
			nativeMacPauseRanges = [];
			nativeMacIsPaused = false;
			activeMacCaptureBounds = null;
			const source = selectedSource || { name: "Screen" };
			if (onRecordingStateChange) {
				onRecordingStateChange(false, source.name);
			}
		}
	});

	// On-disk write streams for in-progress recordings, keyed by output file name.
	// Chunks append as they arrive so the renderer never buffers the full video (#616).
	// Declared here because both the webcam attach below and store-recorded-session
	// finalize through the same registry.
	const recordingStreams = new RecordingStreamRegistry();
	registerRecordingStreamHandlers(ipcMain, recordingStreams, resolveRecordingOutputPath);

	/**
	 * Writes a browser-recorded webcam clip next to a natively-recorded screen
	 * video and rewrites the session manifest to include both.
	 *
	 * Shared by macOS and Linux, whose native helpers both leave the camera to
	 * the renderer's `MediaRecorder`: opening the device a second time from the
	 * helper would fight the preview for an exclusive claim, and buys nothing
	 * that the screen capture needs. (Windows is the exception — its helper takes
	 * the webcam through DirectShow so both streams share one start clock.)
	 *
	 * Nothing in here is platform-specific; the two `ipcMain.handle` calls below
	 * differ only in which platform they accept.
	 */
	const attachNativeWebcamRecording = async (
		platformLabel: string,
		payload: AttachNativeMacWebcamRecordingInput,
	) => {
		try {
			{
				const screenVideoPath = normalizeVideoSourcePath(payload.screenVideoPath);
				if (!screenVideoPath || !isPathWithinDir(screenVideoPath, RECORDINGS_DIR)) {
					return {
						success: false,
						error: `Native ${platformLabel} webcam attachment requires a recording output path.`,
					};
				}

				await fs.access(screenVideoPath, fsConstants.R_OK);

				if (!payload.webcam?.fileName) {
					return {
						success: false,
						error: `Native ${platformLabel} webcam attachment is missing video data.`,
					};
				}

				const webcamVideoPath = resolveRecordingOutputPath(payload.webcam.fileName);
				// A streamed webcam arrives with an empty buffer: its bytes are already on
				// disk, so close the stream and keep the file rather than writing it here.
				// Nothing multi-gigabyte crosses IPC or gets flattened into one Buffer (#253).
				const webcamStreamed = await finalizeRecordingFile(
					recordingStreams,
					payload.webcam.fileName,
					webcamVideoPath,
					payload.webcam.videoData,
				);
				// Mirrors finalizeRecordingFile's own condition, so this fires exactly when
				// it wrote nothing and the session would point at a file that isn't there.
				if (
					!webcamStreamed &&
					!(payload.webcam.videoData && payload.webcam.videoData.byteLength > 0)
				) {
					return {
						success: false,
						error: `Native ${platformLabel} webcam attachment is missing video data.`,
					};
				}
				// Streamed files lack the WebM Duration header, which the editor needs to
				// scale its timeline. Best-effort: a failed repair leaves the clip intact.
				if (webcamStreamed && isValidDurationMs(payload.durationMs)) {
					await repairRecordingContainer(webcamVideoPath, payload.durationMs);
				}

				const createdAt =
					typeof payload.recordingId === "number" && Number.isFinite(payload.recordingId)
						? payload.recordingId
						: Date.now();
				const cursorCaptureMode = normalizeCursorCaptureMode(payload.cursorCaptureMode);
				const webcamOffsetMs = Number.isFinite(payload.webcamOffsetMs)
					? payload.webcamOffsetMs
					: undefined;
				const session: RecordingSession = {
					screenVideoPath,
					webcamVideoPath,
					createdAt,
					...(webcamOffsetMs !== undefined ? { webcamOffsetMs } : {}),
					...(cursorCaptureMode ? { cursorCaptureMode } : {}),
				};
				setCurrentRecordingSessionState(session);
				currentProjectPath = null;

				const sessionManifestPath = path.join(
					RECORDINGS_DIR,
					`${path.parse(screenVideoPath).name}${RECORDING_SESSION_SUFFIX}`,
				);
				await fs.writeFile(sessionManifestPath, JSON.stringify(session, null, 2), "utf-8");
				await registerRecordingMediaLinks(screenVideoPath, {
					webcamVideoPath,
					webcamOffsetMs,
					cursorCaptureMode,
				});

				return {
					success: true,
					path: screenVideoPath,
					session,
					message: `Native ${platformLabel} webcam recording attached successfully`,
				};
			}
		} catch (error) {
			console.error(`Failed to attach native ${platformLabel} webcam recording:`, error);
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};

	ipcMain.handle(
		"attach-native-mac-webcam-recording",
		async (_, payload: AttachNativeMacWebcamRecordingInput) => {
			if (process.platform !== "darwin") {
				return { success: false, error: "Native macOS webcam attachment requires macOS." };
			}
			return attachNativeWebcamRecording("macOS", payload);
		},
	);

	ipcMain.handle(
		"attach-native-linux-webcam-recording",
		async (_, payload: AttachNativeMacWebcamRecordingInput) => {
			if (process.platform !== "linux") {
				return { success: false, error: "Native Linux webcam attachment requires Linux." };
			}
			return attachNativeWebcamRecording("Linux", payload);
		},
	);

	ipcMain.handle("store-recorded-session", async (_, payload: StoreRecordedSessionInput) => {
		try {
			return await storeRecordedSessionFiles(payload);
		} catch (error) {
			console.error("Failed to store recording session:", error);
			return {
				success: false,
				message: "Failed to store recording session",
				error: String(error),
			};
		}
	});

	async function storeRecordedSessionFiles(payload: StoreRecordedSessionInput) {
		const createdAt =
			typeof payload.createdAt === "number" && Number.isFinite(payload.createdAt)
				? payload.createdAt
				: Date.now();
		const cursorCaptureMode = normalizeCursorCaptureMode(payload.cursorCaptureMode);
		const screenVideoPath = resolveRecordingOutputPath(payload.screen.fileName);
		const screenStreamed = await finalizeRecordingFile(
			recordingStreams,
			payload.screen.fileName,
			screenVideoPath,
			payload.screen.videoData,
		);

		let webcamVideoPath: string | undefined;
		let webcamStreamed = false;
		if (payload.webcam) {
			webcamVideoPath = resolveRecordingOutputPath(payload.webcam.fileName);
			webcamStreamed = await finalizeRecordingFile(
				recordingStreams,
				payload.webcam.fileName,
				webcamVideoPath,
				payload.webcam.videoData,
			);
		}

		// MediaRecorder occasionally produces a 0-byte file on Windows
		// when the display stream is captured but no frames are produced (the
		// streaming WriteStream was opened but never received any chunks). Detect
		// the bad file here so the recording fails loudly instead of opening the
		// editor on a file the <video> element can't decode. The WebM EBML header
		// alone is ~33 bytes; 1KB rules out a header-only file with no frames.
		const MIN_VALID_BYTES = 1024;
		try {
			const screenStat = await fs.stat(screenVideoPath);
			if (screenStat.size < MIN_VALID_BYTES) {
				await fs.unlink(screenVideoPath).catch(() => undefined);
				if (webcamVideoPath) {
					await fs.unlink(webcamVideoPath).catch(() => undefined);
				}
				return {
					success: false,
					message: `Screen recording is empty (${screenStat.size} bytes). The screen capture did not produce any frames — this can happen on Windows when the display source changes during recording. Try recording again.`,
				};
			}
		} catch (statError) {
			// file missing is fatal; any other stat error is non-fatal, the
			// editor will surface the load error on its own.
			if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
				return {
					success: false,
					message: "Screen recording file is missing on disk.",
				};
			}
		}

		// Streamed files lack the WebM Duration header (renderer no longer holds the
		// blob), so repair the container on disk for the editor's seek bar and timeline.
		// Best-effort, independent per file, so they run together.
		if (isValidDurationMs(payload.durationMs)) {
			const patches: Promise<unknown>[] = [];
			if (screenStreamed) {
				patches.push(repairRecordingContainer(screenVideoPath, payload.durationMs));
			}
			if (webcamStreamed && webcamVideoPath) {
				patches.push(repairRecordingContainer(webcamVideoPath, payload.durationMs));
			}
			await Promise.all(patches);
		}

		const webcamOffsetMs =
			webcamVideoPath && Number.isFinite(payload.webcamOffsetMs)
				? payload.webcamOffsetMs
				: undefined;
		const session: RecordingSession = webcamVideoPath
			? {
					screenVideoPath,
					webcamVideoPath,
					createdAt,
					...(webcamOffsetMs !== undefined ? { webcamOffsetMs } : {}),
					...(cursorCaptureMode ? { cursorCaptureMode } : {}),
				}
			: { screenVideoPath, createdAt, ...(cursorCaptureMode ? { cursorCaptureMode } : {}) };
		setCurrentRecordingSessionState(session);
		currentProjectPath = null;

		await writePendingCursorTelemetry(screenVideoPath);

		const sessionManifestPath = path.join(
			RECORDINGS_DIR,
			`${path.parse(payload.screen.fileName).name}${RECORDING_SESSION_SUFFIX}`,
		);
		await fs.writeFile(sessionManifestPath, JSON.stringify(session, null, 2), "utf-8");
		await registerRecordingMediaLinks(screenVideoPath, {
			webcamVideoPath,
			webcamOffsetMs,
			cursorCaptureMode,
		});

		return {
			success: true,
			path: screenVideoPath,
			session,
			message: "Recording session stored successfully",
		};
	}

	ipcMain.handle("store-recorded-video", async (_, videoData: ArrayBuffer, fileName: string) => {
		try {
			return await storeRecordedSessionFiles({
				screen: { videoData, fileName },
				createdAt: Date.now(),
			});
		} catch (error) {
			console.error("Failed to store recorded video:", error);
			return {
				success: false,
				message: "Failed to store recorded video",
				error: String(error),
			};
		}
	});

	ipcMain.handle("get-recorded-video-path", async () => {
		try {
			if (currentRecordingSession?.screenVideoPath) {
				return { success: true, path: currentRecordingSession.screenVideoPath };
			}

			const files = await fs.readdir(RECORDINGS_DIR);
			const videoFiles = files.filter(
				(file) => file.endsWith(".webm") && !file.endsWith("-webcam.webm"),
			);

			if (videoFiles.length === 0) {
				return { success: false, message: "No recorded video found" };
			}

			const latestVideo = videoFiles.sort().reverse()[0];
			const videoPath = path.join(RECORDINGS_DIR, latestVideo);

			return { success: true, path: videoPath };
		} catch (error) {
			console.error("Failed to get video path:", error);
			return { success: false, message: "Failed to get video path", error: String(error) };
		}
	});

	ipcMain.handle(
		"set-recording-state",
		async (_, recording: boolean, recordingId?: number, cursorCaptureMode?: CursorCaptureMode) => {
			const normalizedCursorCaptureMode =
				normalizeCursorCaptureMode(cursorCaptureMode) ?? "editable-overlay";
			if (recording && normalizedCursorCaptureMode === "editable-overlay") {
				await startCursorRecording(recordingId);
			} else {
				await stopCursorRecording();
			}

			const source = selectedSource || { name: "Screen" };
			if (onRecordingStateChange) {
				onRecordingStateChange(recording, source.name);
			}
		},
	);

	ipcMain.handle("get-cursor-telemetry", async (_, videoPath?: string) => {
		const targetVideoPath = resolveApprovedVideoPath(
			videoPath ?? currentRecordingSession?.screenVideoPath,
		);
		if (!targetVideoPath) {
			return { success: true, samples: [] };
		}

		return readCursorTelemetryFile(targetVideoPath);
	});

	// Protocol allowlist. `shell.openExternal` hands the string to the OS handler,
	// so `file:`, `ms-msdt:`, a UNC path, or any registered custom scheme is a
	// launch primitive — the renderer runs with webSecurity:false and now renders
	// model-generated content, so "the renderer is trusted" is not a strong enough
	// premise to skip this. http/https/mailto is everything the app actually opens.
	const EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

	ipcMain.handle("open-external-url", async (_, url: string) => {
		try {
			const parsed = new URL(url);
			if (!EXTERNAL_URL_PROTOCOLS.has(parsed.protocol)) {
				console.warn(`Refused to open external URL with protocol ${parsed.protocol}`);
				return { success: false, error: `Unsupported URL protocol: ${parsed.protocol}` };
			}
			await shell.openExternal(parsed.toString());
			return { success: true };
		} catch (error) {
			console.error("Failed to open URL:", error);
			return { success: false, error: String(error) };
		}
	});

	// Return base path for assets so renderer can resolve file:// paths in production
	ipcMain.handle("get-asset-base-path", () => {
		return resolveAssetBasePath();
	});

	ipcMain.handle("pick-export-save-path", async (_, fileName: string, exportFolder?: string) => {
		try {
			const isGif = fileName.toLowerCase().endsWith(".gif");
			const filters = isGif
				? [{ name: mainT("dialogs", "fileDialogs.gifImage"), extensions: ["gif"] }]
				: [{ name: mainT("dialogs", "fileDialogs.mp4Video"), extensions: ["mp4"] }];

			// Prefer the user's last export folder if it still exists, else ~/Downloads.
			// Validate here because the renderer can't stat the filesystem.
			let defaultDir = app.getPath("downloads");
			if (exportFolder) {
				try {
					const stats = await fs.stat(exportFolder);
					if (stats.isDirectory()) {
						defaultDir = exportFolder;
					}
				} catch (err) {
					console.warn(
						`Could not access remembered export folder "${exportFolder}", falling back to Downloads:`,
						err,
					);
				}
			}
			const dialogOptions = buildDialogOptions(
				{
					title: isGif
						? mainT("dialogs", "fileDialogs.saveGif")
						: mainT("dialogs", "fileDialogs.saveVideo"),
					defaultPath: path.join(defaultDir, fileName),
					filters,
					properties: ["createDirectory", "showOverwriteConfirmation"],
				},
				getMainWindow(),
			);
			const result = await dialog.showSaveDialog(dialogOptions);

			if (result.canceled || !result.filePath) {
				return { success: false, canceled: true, message: "Export canceled" };
			}

			return { success: true, path: path.normalize(result.filePath) };
		} catch (error) {
			console.error("Failed to show save dialog:", error);
			return {
				success: false,
				message: "Failed to show save dialog",
				error: String(error),
			};
		}
	});

	ipcMain.handle("write-export-to-path", async (_, videoData: ArrayBuffer, filePath: string) => {
		try {
			// Sanity-check the path: the renderer is trusted (contextIsolation on), but a
			// stale-state bug shouldn't be able to clobber arbitrary files.
			if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
				return { success: false, message: "Invalid path" };
			}
			const lower = filePath.toLowerCase();
			if (!lower.endsWith(".mp4") && !lower.endsWith(".gif")) {
				return { success: false, message: "Invalid file type" };
			}

			const normalizedPath = path.normalize(filePath);
			await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
			await fs.writeFile(normalizedPath, Buffer.from(videoData));

			return {
				success: true,
				path: normalizedPath,
				message: "Video exported successfully",
			};
		} catch (error) {
			console.error("Failed to write exported video:", error);
			return {
				success: false,
				message: "Failed to save exported video",
				error: String(error),
			};
		}
	});

	ipcMain.handle("open-video-file-picker", async () => {
		try {
			const dialogOptions = buildDialogOptions(
				{
					title: mainT("dialogs", "fileDialogs.selectVideo"),
					defaultPath: RECORDINGS_DIR,
					filters: [
						{
							name: mainT("dialogs", "fileDialogs.videoFiles"),
							extensions: ["webm", "mp4", "mov", "avi", "mkv", "m4v", "wmv", "flv", "ts"],
						},
						{ name: mainT("dialogs", "fileDialogs.allFiles"), extensions: ["*"] },
					],
					properties: ["openFile"],
				},
				getMainWindow(),
			);
			const result = await dialog.showOpenDialog(dialogOptions);

			if (result.canceled || result.filePaths.length === 0) {
				return { success: false, canceled: true };
			}

			const normalizedPath = await approveReadableVideoPath(result.filePaths[0]);
			if (!normalizedPath) {
				return {
					success: false,
					message: "Selected file is not a supported readable video file",
				};
			}

			currentProjectPath = null;
			return {
				success: true,
				path: normalizedPath,
			};
		} catch (error) {
			console.error("Failed to open file picker:", error);
			return {
				success: false,
				message: "Failed to open file picker",
				error: String(error),
			};
		}
	});

	ipcMain.handle("reveal-in-folder", async (_, filePath: string) => {
		try {
			// showItemInFolder returns nothing, it throws on error
			shell.showItemInFolder(filePath);
			return { success: true };
		} catch (error) {
			console.error(`Error revealing item in folder: ${filePath}`, error);
			// Fall back to opening the directory if revealing fails (file moved/deleted
			// after export, or a path showItemInFolder rejects).
			try {
				const openPathResult = await shell.openPath(path.dirname(filePath));
				if (openPathResult) {
					// openPath returned an error message
					return { success: false, error: openPathResult };
				}
				return { success: true, message: "Could not reveal item, but opened directory." };
			} catch (openError) {
				console.error(`Error opening directory: ${path.dirname(filePath)}`, openError);
				return { success: false, error: String(error) };
			}
		}
	});

	ipcMain.handle("read-binary-file", async (_, filePath: string) => {
		try {
			const normalizedPath = await approveReadableVideoPath(filePath);
			if (!normalizedPath) {
				return {
					success: false,
					message: "File path is not approved or is not a supported video file",
				};
			}

			const data = await fs.readFile(normalizedPath);
			return {
				success: true,
				data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
				path: normalizedPath,
			};
		} catch (error) {
			console.error("Failed to read binary file:", error);
			return {
				success: false,
				message: "Failed to read binary file",
				error: String(error),
			};
		}
	});

	// Stat an approved video file. Used to decide whether a recording is small
	// enough to slurp via read-binary-file, or large enough that it must be
	// streamed in chunks (Node's fs.readFile caps a single read at 2 GiB, so any
	// recording above that can never be loaded whole — see read-file-chunk).
	ipcMain.handle("get-readable-file-info", async (_, filePath: string) => {
		try {
			const normalizedPath = await approveReadableVideoPath(filePath);
			if (!normalizedPath) {
				return {
					success: false,
					message: "File path is not approved or is not a supported video file",
				};
			}

			const stat = await fs.stat(normalizedPath);
			return {
				success: true,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				path: normalizedPath,
			};
		} catch (error) {
			console.error("Failed to stat file:", error);
			return {
				success: false,
				message: "Failed to stat file",
				error: String(error),
			};
		}
	});

	// Waveform peaks for a timeline clip, decoded natively (see media/audioPeaks).
	// The renderer's own pipelines take ~12s on a 32-minute recording because they
	// decode the whole track in Chromium; ffmpeg does the same work in ~2s off the
	// UI process, and the result is cached on disk so it is paid once per file.
	// `peaks: null` means "no native path available" — the caller falls back to
	// its own decoding rather than losing the waveform.
	ipcMain.handle(
		"get-audio-peaks",
		async (_, filePath: string, durationSec: number): Promise<AudioPeaksResult> => {
			try {
				// Same approval gate as every other read of a renderer-supplied path.
				const normalizedPath = await approveReadableVideoPath(filePath);
				if (!normalizedPath) {
					return { success: false, message: "File path is not approved" };
				}
				const peaks = await getAudioPeaks(normalizedPath, durationSec);
				return { success: true, peaks };
			} catch (error) {
				// A clip with no audio track lands here. Degrade quietly: the renderer
				// draws no waveform, which is correct, and logs its own warning.
				return { success: false, message: String(error) };
			}
		},
	);

	// Cap renderer-requested chunk sizes so a buggy or compromised renderer
	// cannot make the main process allocate an arbitrarily large buffer.
	const MAX_IPC_CHUNK_BYTES = 64 * 1024 * 1024;

	// Read a byte range [offset, offset+length) from an approved video file.
	// Lets the renderer stream a >2 GiB recording into OPFS one chunk at a time
	// instead of materialising the whole file in memory, which fs.readFile cannot
	// do (2 GiB cap) and a 16 GB machine cannot hold for multi-GB recordings.
	ipcMain.handle("read-file-chunk", async (_, filePath: string, offset: number, length: number) => {
		try {
			const normalizedPath = await approveReadableVideoPath(filePath);
			if (!normalizedPath) {
				return {
					success: false,
					message: "File path is not approved or is not a supported video file",
				};
			}
			if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(length) || length <= 0) {
				return { success: false, message: "Invalid chunk range" };
			}
			if (length > MAX_IPC_CHUNK_BYTES) {
				return { success: false, message: "Requested chunk size exceeds limit" };
			}

			const handle = await fs.open(normalizedPath, "r");
			try {
				const buffer = Buffer.allocUnsafe(length);
				const { bytesRead } = await handle.read(buffer, 0, length, offset);
				return {
					success: true,
					data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead),
					bytesRead,
				};
			} finally {
				await handle.close();
			}
		} catch (error) {
			console.error("Failed to read file chunk:", error);
			return {
				success: false,
				message: "Failed to read file chunk",
				error: String(error),
			};
		}
	});

	ipcMain.handle("prepare-preview-audio-track", async (_, filePath: string) => {
		try {
			return await prepareSupplementalPreviewAudioTrack(filePath);
		} catch (error) {
			console.error("Failed to prepare preview audio track:", error);
			return {
				success: false,
				message: "Failed to prepare preview audio track",
				error: String(error),
			};
		}
	});

	ipcMain.handle(
		"save-project-file",
		async (_, projectData: unknown, suggestedName?: string, existingProjectPath?: string) => {
			return saveProjectFile(projectData, suggestedName, existingProjectPath);
		},
	);

	async function saveProjectFile(
		projectData: unknown,
		suggestedName?: string,
		existingProjectPath?: string,
	): Promise<ProjectFileResult> {
		try {
			const trustedExistingProjectPath = isTrustedProjectPath(existingProjectPath)
				? existingProjectPath
				: null;

			if (trustedExistingProjectPath) {
				await fs.writeFile(
					trustedExistingProjectPath,
					JSON.stringify(projectData, null, 2),
					"utf-8",
				);
				currentProjectPath = trustedExistingProjectPath;
				return {
					success: true,
					path: trustedExistingProjectPath,
					message: "Project saved successfully",
				};
			}

			const safeName = (suggestedName || `project-${Date.now()}`).replace(/[^a-zA-Z0-9-_]/g, "_");
			const defaultName = safeName.endsWith(`.${PROJECT_FILE_EXTENSION}`)
				? safeName
				: `${safeName}.${PROJECT_FILE_EXTENSION}`;

			const dialogOptions = buildDialogOptions(
				{
					title: mainT("dialogs", "fileDialogs.saveProject"),
					defaultPath: path.join(RECORDINGS_DIR, defaultName),
					filters: [
						{
							name: mainT("dialogs", "fileDialogs.openscreenProject"),
							extensions: [PROJECT_FILE_EXTENSION],
						},
						{ name: "JSON", extensions: ["json"] },
					],
					properties: ["createDirectory", "showOverwriteConfirmation"],
				},
				getMainWindow(),
			);
			const result = await dialog.showSaveDialog(dialogOptions);

			if (result.canceled || !result.filePath) {
				return {
					success: false,
					canceled: true,
					message: "Save project canceled",
				};
			}

			await fs.writeFile(result.filePath, JSON.stringify(projectData, null, 2), "utf-8");
			currentProjectPath = result.filePath;

			return {
				success: true,
				path: result.filePath,
				message: "Project saved successfully",
			};
		} catch (error) {
			console.error("Failed to save project file:", error);
			return {
				success: false,
				message: "Failed to save project file",
				error: String(error),
			};
		}
	}

	ipcMain.handle("load-project-file", async (_, projectFolder?: string) => {
		return loadProjectFile(projectFolder);
	});

	async function loadProjectFile(projectFolder?: string): Promise<ProjectFileResult> {
		try {
			// Default to the projects directory, where the editor actually stores
			// openable project files (one `.openscreen` per project). Prefer the user's
			// last opened-project folder if given and still valid; only fall back to
			// RECORDINGS_DIR if the projects dir doesn't exist yet (fresh install).
			// Validate here because the renderer can't stat the filesystem.
			const projectsDir = path.join(app.getPath("userData"), "projects");
			let defaultDir = RECORDINGS_DIR;
			try {
				const stats = await fs.stat(projectsDir);
				if (stats.isDirectory()) defaultDir = projectsDir;
			} catch {
				// projects dir not created yet — keep RECORDINGS_DIR fallback.
			}
			if (projectFolder) {
				try {
					const stats = await fs.stat(projectFolder);
					if (stats.isDirectory()) {
						defaultDir = projectFolder;
					}
				} catch (err) {
					// Stat can fail if the folder was moved/deleted (expected) or on a
					// permission error (worth surfacing). We fall back either way, but log it.
					console.warn(
						`Could not access remembered project folder "${projectFolder}", falling back to default:`,
						err,
					);
				}
			}
			const dialogOptions = buildDialogOptions(
				{
					title: mainT("dialogs", "fileDialogs.openProject"),
					defaultPath: defaultDir,
					filters: [
						{
							name: mainT("dialogs", "fileDialogs.openscreenProject"),
							// All projects are `.openscreen`; `.axcut` is kept only so files
							// written by older builds (pre-migration) still show up.
							extensions: [PROJECT_FILE_EXTENSION, "axcut"],
						},
						{ name: "JSON", extensions: ["json"] },
						{ name: mainT("dialogs", "fileDialogs.allFiles"), extensions: ["*"] },
					],
					properties: ["openFile"],
				},
				getMainWindow(),
			);
			const result = await dialog.showOpenDialog(dialogOptions);

			if (result.canceled || result.filePaths.length === 0) {
				return { success: false, canceled: true, message: "Open project canceled" };
			}

			const filePath = result.filePaths[0];
			const content = await fs.readFile(filePath, "utf-8");
			const project = await relinkProjectMedia(JSON.parse(content), RECORDINGS_DIR);
			currentProjectPath = filePath;
			let session: RecordingSession | null = null;
			try {
				session = await getApprovedProjectSession(project, filePath);
			} catch (sessionError) {
				console.warn(
					"[loadProjectFile] Could not approve session paths, proceeding without session:",
					sessionError,
				);
			}
			setCurrentRecordingSessionState(session);

			return {
				success: true,
				path: filePath,
				project,
			};
		} catch (error) {
			console.error("Failed to load project file:", error);
			return {
				success: false,
				message: "Failed to load project file",
				error: String(error),
			};
		}
	}

	ipcMain.handle("load-project-file-from-path", async (_event, filePath: string) => {
		return loadProjectFileFromPath(filePath);
	});

	async function loadProjectFileFromPath(filePath: string): Promise<ProjectFileResult> {
		try {
			if (!filePath || typeof filePath !== "string") {
				return { success: false, message: "Invalid file path" };
			}
			// Validate extension and readability
			if (path.extname(filePath).toLowerCase() !== `.${PROJECT_FILE_EXTENSION}`) {
				return { success: false, message: "Not an Openscreen project file" };
			}
			const stats = await fs.stat(filePath).catch(() => null);
			if (!stats?.isFile()) {
				return { success: false, message: "File not found" };
			}
			const content = await fs.readFile(filePath, "utf-8");
			const project = await relinkProjectMedia(JSON.parse(content), RECORDINGS_DIR);
			currentProjectPath = filePath;

			// Approve session paths but tolerate failures (e.g. video moved outside trusted
			// dirs) so the project still loads and the renderer can show "video not found".
			let session: import("../../src/lib/recordingSession").RecordingSession | null = null;
			try {
				session = await getApprovedProjectSession(project, filePath);
			} catch (sessionError) {
				console.warn(
					"[loadProjectFileFromPath] Could not approve session paths, proceeding without session:",
					sessionError,
				);
			}
			setCurrentRecordingSessionState(session);
			return { success: true, path: filePath, project };
		} catch (error) {
			console.error("Failed to load project file from path:", error);
			return {
				success: false,
				message: "Failed to load project file",
				error: String(error),
			};
		}
	}

	ipcMain.handle("load-current-project-file", async () => {
		return loadCurrentProjectFile();
	});

	async function loadCurrentProjectFile(): Promise<ProjectFileResult> {
		try {
			if (!currentProjectPath) {
				return { success: false, message: "No active project" };
			}

			const content = await fs.readFile(currentProjectPath, "utf-8");
			const project = JSON.parse(content);
			setCurrentRecordingSessionState(await getApprovedProjectSession(project, currentProjectPath));
			return {
				success: true,
				path: currentProjectPath,
				project,
			};
		} catch (error) {
			console.error("Failed to load current project file:", error);
			return {
				success: false,
				message: "Failed to load current project file",
				error: String(error),
			};
		}
	}

	ipcMain.handle("set-current-video-path", async (_, path: string) => {
		return setCurrentVideoPath(path);
	});

	ipcMain.handle("set-current-recording-session", (_, session: RecordingSession | null) => {
		const normalizedSession = normalizeRecordingSession(session);
		setCurrentRecordingSessionState(normalizedSession);
		currentVideoPath = normalizedSession?.screenVideoPath ?? null;
		currentProjectPath = null;
		return { success: true, session: currentRecordingSession };
	});

	ipcMain.handle("get-current-recording-session", () => {
		return currentRecordingSession
			? { success: true, session: currentRecordingSession }
			: { success: false };
	});

	// returns the webcam path (if any) for a given screen video by
	// reading its sibling session.json — drives the cameraTrack auto-link on
	// `addAsset` in the new editor's project store.
	ipcMain.handle(
		"find-recording-camera",
		async (
			_event,
			videoPath: string,
		): Promise<{
			success: boolean;
			webcamVideoPath?: string;
			offsetMs?: number;
			error?: string;
		}> => {
			try {
				const normalized = normalizeVideoSourcePath(videoPath);
				if (!normalized || !isPathAllowed(normalized)) {
					return { success: false, error: "Video path has not been approved" };
				}
				const resolution = await resolveMediaLinksForVideo(normalized);
				if (!resolution.webcamVideoPath) {
					return { success: false, error: "No camera attached to this recording" };
				}
				return {
					success: true,
					webcamVideoPath: resolution.webcamVideoPath,
					offsetMs: resolution.webcamOffsetMs ?? 0,
				};
			} catch (err) {
				return {
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},
	);

	async function setCurrentVideoPath(path: string): Promise<ProjectPathResult> {
		const normalizedPath = normalizeVideoSourcePath(path);
		if (!normalizedPath || !isPathAllowed(normalizedPath)) {
			return {
				success: false,
				message: "Video path has not been approved",
			};
		}

		const restoredSession = await loadRecordedSessionForVideoPath(normalizedPath);
		if (restoredSession) {
			setCurrentRecordingSessionState(restoredSession);
		} else {
			setCurrentRecordingSessionState({
				screenVideoPath: normalizedPath,
				createdAt: Date.now(),
			});
		}
		currentProjectPath = null;
		return { success: true, path: currentVideoPath ?? normalizedPath };
	}

	ipcMain.handle("get-current-video-path", () => {
		return getCurrentVideoPathResult();
	});

	function getCurrentVideoPathResult(): ProjectPathResult {
		return currentVideoPath ? { success: true, path: currentVideoPath } : { success: false };
	}

	ipcMain.handle("clear-current-video-path", () => {
		return clearCurrentVideoPath();
	});

	function clearCurrentVideoPath(): ProjectPathResult {
		currentVideoPath = null;
		currentProjectPath = null;
		setCurrentRecordingSessionState(null);
		return { success: true };
	}

	// Keep the native Windows/Linux window-control overlay in the app's theme
	// colours. The renderer sends the resolved CSS values so the palette stays in
	// one place. No-op on macOS (traffic lights aren't tintable) and on any window
	// that wasn't created with an overlay, which is what setTitleBarOverlay throws on.
	ipcMain.on("set-titlebar-overlay", (event, color: string, symbolColor: string) => {
		try {
			BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay({ color, symbolColor });
		} catch {
			// Best-effort cosmetic.
		}
	});

	ipcMain.handle("get-shortcuts", async () => {
		try {
			const data = await fs.readFile(SHORTCUTS_FILE, "utf-8");
			return JSON.parse(data);
		} catch {
			return null;
		}
	});

	ipcMain.handle("save-shortcuts", async (_, shortcuts: unknown) => {
		try {
			await fs.writeFile(SHORTCUTS_FILE, JSON.stringify(shortcuts, null, 2), "utf-8");
			return { success: true };
		} catch (error) {
			console.error("Failed to save shortcuts:", error);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle(
		"save-diagnostic",
		async (_, payload: { error: string; stack?: string; projectState: unknown; logs: string[] }) =>
			exportDiagnosticFile(payload),
	);

	// One instance each, not one per call. DocumentService serialises saves of a
	// project through a per-INSTANCE queue (see its writeProject comment — this
	// race destroyed two real project files), so a second instance means a second
	// queue racing for the same path: temp+rename still keeps the file valid, but
	// a save can land under a concurrent one and be silently lost.
	const aiEditionDocuments = new DocumentService(
		path.join(app.getPath("userData"), "projects"),
		RECORDINGS_DIR,
	);

	// LlmConfigStore is single-instance for a duller reason — its constructor does
	// two sync readFileSync plus a safeStorage decrypt, and it was running on every
	// chat message. But it must also stay UNBUILT until something actually needs it:
	// on macOS that decrypt is backed by a Keychain item, so constructing it at
	// startup made every launch prompt for Keychain access, including for users who
	// never open the AI layer at all. (The prompt repeats because an unsigned or
	// ad-hoc-signed build has no stable code identity for the item's ACL to trust —
	// signing is the other half of that fix, and is not this function's business.)
	// Memoised, so the "one instance" guarantee above still holds.
	let aiEditionLlmConfigInstance: LlmConfigStore | null = null;
	const getAiEditionLlmConfig = (): LlmConfigStore => {
		if (!aiEditionLlmConfigInstance) {
			aiEditionLlmConfigInstance = new LlmConfigStore(app.getPath("userData"));
		}
		return aiEditionLlmConfigInstance;
	};

	registerNativeBridgeHandlers({
		getPlatform: () => process.platform,
		getCurrentProjectPath: () => currentProjectPath,
		getCurrentVideoPath: () => currentVideoPath,
		saveProjectFile,
		loadProjectFile,
		loadCurrentProjectFile,
		loadProjectFileFromPath,
		setCurrentVideoPath,
		getCurrentVideoPathResult,
		clearCurrentVideoPath,
		resolveAssetBasePath,
		resolveVideoPath: (videoPath?: string | null) =>
			normalizeVideoSourcePath(videoPath ?? currentVideoPath),
		loadCursorRecordingData: readCursorRecordingFile,
		loadCursorTelemetry: readCursorTelemetryFile,
		// compositor view's createView needs the renderer-owning
		// BrowserWindow's native handle (HWND on Windows, NSView* on macOS).
		// Same ownership rules as desktopCapturer: `BrowserWindow.fromWebContents`
		// gives us the window that hosts this sender; `getNativeWindowHandle`
		// is the platform-native parent handle the D3D11 addon parents its
		// child window to.
		getNativeWindowHandle: (sender) => {
			const window = BrowserWindow.fromWebContents(sender);
			if (!window || window.isDestroyed()) {
				return null;
			}
			try {
				return window.getNativeWindowHandle();
			} catch {
				return null;
			}
		},
		getAiEditionDocuments: () => aiEditionDocuments,
		getAiEditionLlmConfig,
		runAiEditionChat: (projectId, sessionId, message, document, sink) =>
			runChat(projectId, sessionId, message, getAiEditionLlmConfig(), document, sink, {
				cursor: agentCursorTelemetryReader,
			}),
		undoAiEditionToolBatch: (_projectId, _sessionId) => ({
			success: false,
			error: "Per-tool-batch undo retired in favor of per-message rewind.",
		}),
		rewindToMessage: (projectId, sessionId, messageId) =>
			rewindToMessage(projectId, sessionId, messageId),
		compactNow: (projectId, sessionId) =>
			compactSessionNow(projectId, sessionId, getAiEditionLlmConfig()),
		getContextUsage: getSessionContextUsage,
		listAiEditionChatSessions: (projectId) => listSessions(projectId),
		createAiEditionChatSession: (projectId, title) => createSession(projectId, title),
		selectAiEditionChatSession: (projectId, sessionId) => selectSession(projectId, sessionId),
		renameAiEditionChatSession: (projectId, sessionId, title) =>
			renameSession(projectId, sessionId, title),
		deleteAiEditionChatSession: (projectId, sessionId) => deleteSession(projectId, sessionId),
	});
}
