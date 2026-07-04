// P4 — media-links registry: a project-independent record of which webcam
// recording and/or cursor-telemetry sidecar go with a given screen-recording
// video file, keyed by a lightweight content fingerprint rather than by path.
//
// The existing sidecar conventions (`<name>.session.json` next to a screen
// recording, `<path>.cursor.json` next to a video) only work while the file
// stays exactly where it was recorded. This registry lets OpenScreen re-find
// the same links after the screen video has been imported into a different
// project from a different location — the caller (electron/ipc/handlers.ts)
// tries the cheap path-adjacency sidecars first and falls back to this
// registry, backfilling an entry once it resolves so future lookups survive
// a later move even if the original sidecar doesn't travel with the file.
//
// ponytail: the fingerprint is deliberately NOT a full-file hash — recordings
// can be an hour of 4K footage, and re-reading gigabytes on every asset-add
// would make importing feel broken. Size + a head/tail byte sample is enough
// to survive move/rename/copy, which is the only scenario this needs to
// solve (not detecting a re-encoded duplicate).

import fs from "node:fs/promises";
import path from "node:path";
import type { CursorCaptureMode } from "../../src/lib/recordingSession";

// ponytail: `baseDir` is passed in by every caller (RECORDINGS_DIR in
// electron/ipc/handlers.ts) rather than imported here, so this module has no
// dependency on Electron and can be unit-tested with a plain temp directory —
// same rationale as DocumentService's constructor-injected `projectsRoot`.

const REGISTRY_FILE_NAME = "media-links.registry.json";
const SAMPLE_BYTES = 64 * 1024;

export interface MediaFingerprint {
	sizeBytes: number;
	headSampleBase64: string;
	tailSampleBase64: string;
}

export interface MediaLinkEntry {
	lastKnownPath: string;
	fingerprint: MediaFingerprint;
	webcamVideoPath?: string;
	webcamOffsetMs?: number;
	cursorTelemetryPath?: string;
	cursorCaptureMode?: CursorCaptureMode;
	updatedAt: string;
}

interface MediaLinksRegistryFile {
	version: 1;
	entries: MediaLinkEntry[];
}

const EMPTY_REGISTRY: MediaLinksRegistryFile = { version: 1, entries: [] };

function registryPath(baseDir: string): string {
	return path.join(baseDir, REGISTRY_FILE_NAME);
}

async function readSample(handle: fs.FileHandle, size: number, position: number): Promise<Buffer> {
	const buf = Buffer.alloc(size);
	if (size === 0) return buf;
	await handle.read(buf, 0, size, position);
	return buf;
}

/**
 * Reads at most `SAMPLE_BYTES` from the head and `SAMPLE_BYTES` from the tail
 * of the file — never the file body — so this stays fast regardless of
 * recording length.
 */
export async function computeFingerprint(filePath: string): Promise<MediaFingerprint> {
	const stat = await fs.stat(filePath);
	const handle = await fs.open(filePath, "r");
	try {
		const headSize = Math.min(SAMPLE_BYTES, stat.size);
		const head = await readSample(handle, headSize, 0);
		const tailSize = Math.min(SAMPLE_BYTES, stat.size);
		const tail = await readSample(handle, tailSize, Math.max(0, stat.size - tailSize));
		return {
			sizeBytes: stat.size,
			headSampleBase64: head.toString("base64"),
			tailSampleBase64: tail.toString("base64"),
		};
	} finally {
		await handle.close();
	}
}

export function fingerprintsMatch(a: MediaFingerprint, b: MediaFingerprint): boolean {
	return (
		a.sizeBytes === b.sizeBytes &&
		a.headSampleBase64 === b.headSampleBase64 &&
		a.tailSampleBase64 === b.tailSampleBase64
	);
}

function normalizeEntry(candidate: unknown): MediaLinkEntry | null {
	if (!candidate || typeof candidate !== "object") return null;
	const raw = candidate as Partial<MediaLinkEntry>;
	const fp = raw.fingerprint;
	if (
		typeof raw.lastKnownPath !== "string" ||
		!fp ||
		typeof fp.sizeBytes !== "number" ||
		typeof fp.headSampleBase64 !== "string" ||
		typeof fp.tailSampleBase64 !== "string"
	) {
		return null;
	}
	return {
		lastKnownPath: raw.lastKnownPath,
		fingerprint: {
			sizeBytes: fp.sizeBytes,
			headSampleBase64: fp.headSampleBase64,
			tailSampleBase64: fp.tailSampleBase64,
		},
		...(typeof raw.webcamVideoPath === "string" ? { webcamVideoPath: raw.webcamVideoPath } : {}),
		...(typeof raw.webcamOffsetMs === "number" ? { webcamOffsetMs: raw.webcamOffsetMs } : {}),
		...(typeof raw.cursorTelemetryPath === "string"
			? { cursorTelemetryPath: raw.cursorTelemetryPath }
			: {}),
		...(raw.cursorCaptureMode === "editable-overlay" || raw.cursorCaptureMode === "system"
			? { cursorCaptureMode: raw.cursorCaptureMode }
			: {}),
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
	};
}

async function readRegistry(baseDir: string): Promise<MediaLinksRegistryFile> {
	try {
		const raw = await fs.readFile(registryPath(baseDir), "utf-8");
		const parsed = JSON.parse(raw);
		const entries = Array.isArray(parsed?.entries)
			? parsed.entries
					.map((e: unknown) => normalizeEntry(e))
					.filter((e: MediaLinkEntry | null): e is MediaLinkEntry => e !== null)
			: [];
		return { version: 1, entries };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...EMPTY_REGISTRY };
		}
		console.warn("[media-links] failed to read registry, starting fresh:", error);
		return { ...EMPTY_REGISTRY };
	}
}

async function writeRegistry(baseDir: string, file: MediaLinksRegistryFile): Promise<void> {
	await fs.mkdir(baseDir, { recursive: true });
	const target = registryPath(baseDir);
	const tmpPath = `${target}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(tmpPath, JSON.stringify(file, null, 2), "utf-8");
	await fs.rename(tmpPath, target);
}

// Single-process, single-user desktop app — an in-process promise chain per
// registry path is enough to keep concurrent writes from clobbering each
// other (keyed by baseDir so tests using different temp dirs don't serialize
// against each other).
const writeQueues = new Map<string, Promise<unknown>>();

function withWriteLock<T>(baseDir: string, fn: () => Promise<T>): Promise<T> {
	const queue = writeQueues.get(baseDir) ?? Promise.resolve();
	const result = queue.then(fn, fn);
	writeQueues.set(
		baseDir,
		result.then(
			() => undefined,
			() => undefined,
		),
	);
	return result;
}

async function updateRegistry(
	baseDir: string,
	mutator: (file: MediaLinksRegistryFile) => MediaLinksRegistryFile,
): Promise<void> {
	await withWriteLock(baseDir, async () => {
		const current = await readRegistry(baseDir);
		await writeRegistry(baseDir, mutator(current));
	});
}

export interface MediaLinksToRegister {
	webcamVideoPath?: string;
	webcamOffsetMs?: number;
	cursorTelemetryPath?: string;
	cursorCaptureMode?: CursorCaptureMode;
}

/**
 * Registers (or refreshes) the links for `videoPath`. Safe to call whenever
 * a link is known-good — at recording time, or as an opportunistic backfill
 * after resolving a link via the legacy sidecar convention. `baseDir` is the
 * directory the registry file lives in (RECORDINGS_DIR in production).
 */
export async function registerMediaLinks(
	baseDir: string,
	videoPath: string,
	links: MediaLinksToRegister,
): Promise<void> {
	if (!links.webcamVideoPath && !links.cursorTelemetryPath) return;
	const fingerprint = await computeFingerprint(videoPath);
	await updateRegistry(baseDir, (file) => {
		const existingIndex = file.entries.findIndex((e) =>
			fingerprintsMatch(e.fingerprint, fingerprint),
		);
		const entry: MediaLinkEntry = {
			lastKnownPath: videoPath,
			fingerprint,
			...links,
			updatedAt: new Date().toISOString(),
		};
		const entries =
			existingIndex >= 0
				? file.entries.map((e, i) => (i === existingIndex ? { ...e, ...entry } : e))
				: [...file.entries, entry];
		return { version: 1, entries };
	});
}

export interface MediaLinksLookup {
	webcamVideoPath?: string;
	webcamOffsetMs?: number;
	cursorTelemetryPath?: string;
	cursorCaptureMode?: CursorCaptureMode;
}

/**
 * Looks up `videoPath` in the registry by content fingerprint — used as the
 * fallback when the file has no (or a stale) sidecar sitting next to it,
 * e.g. because it was moved, renamed, or imported from elsewhere.
 */
export async function findMediaLinksByFingerprint(
	baseDir: string,
	videoPath: string,
): Promise<MediaLinksLookup | null> {
	const fingerprint = await computeFingerprint(videoPath);
	const registry = await readRegistry(baseDir);
	const match = registry.entries.find((e) => fingerprintsMatch(e.fingerprint, fingerprint));
	if (!match) return null;

	// Path drifted from what's on record — refresh it so the next lookup can
	// take a cheaper path if one becomes available again.
	if (match.lastKnownPath !== videoPath) {
		void updateRegistry(baseDir, (file) => ({
			version: 1,
			entries: file.entries.map((e) =>
				fingerprintsMatch(e.fingerprint, fingerprint) ? { ...e, lastKnownPath: videoPath } : e,
			),
		}));
	}

	return {
		...(match.webcamVideoPath ? { webcamVideoPath: match.webcamVideoPath } : {}),
		...(typeof match.webcamOffsetMs === "number" ? { webcamOffsetMs: match.webcamOffsetMs } : {}),
		...(match.cursorTelemetryPath ? { cursorTelemetryPath: match.cursorTelemetryPath } : {}),
		...(match.cursorCaptureMode ? { cursorCaptureMode: match.cursorCaptureMode } : {}),
	};
}
