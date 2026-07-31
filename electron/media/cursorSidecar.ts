// Reading the cursor-telemetry sidecar (`<videoPath>.cursor.json`), extracted
// from `electron/ipc/handlers.ts` so it can be called by something other than an
// IPC handler.
//
// ponytail: the extraction IS the fix, not a tidy-up. The readers existed and
// worked — they were simply only ever wired to the renderer (loadCursorTelemetry
// → CursorService → useCursorTelemetry → V4Timeline), so the ONE consumer that
// most needed them, the agent, could not reach them. Asked what pointer data the
// project holds, the model had no door to open and answered from the only thing
// it could see. Nothing here changes what is parsed; it changes who may parse.
//
// Node-pure on purpose: no `electron` import, no `app.getPath`. `RECORDINGS_DIR`
// comes from `electron/main.ts` (an `app.getPath` call at module scope), so
// importing it here would drag the whole Electron runtime into anything that
// wants to read a sidecar — the tests included. It is injected instead, exactly
// as `mediaLinksRegistry` already injects its `baseDir`.

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type {
	CursorProviderKind,
	CursorRecordingData,
	CursorRecordingSample,
	NativeCursorAsset,
} from "../../src/native/contracts";
import { findMediaLinksByFingerprint } from "./mediaLinksRegistry";

export const CURSOR_TELEMETRY_VERSION = 2;

/** Where a sidecar was found, or why it was not. `"none"` means we LOOKED and
 * there was nothing — distinct from never having looked, which this module
 * cannot represent and its callers must not conflate. */
export type CursorSidecarSource = "sidecar" | "registry" | "none";

export interface CursorSidecarResult {
	found: boolean;
	source: CursorSidecarSource;
	/** Absolute path of the file that was read; null when nothing was found. */
	path: string | null;
	data: CursorRecordingData;
}

function emptyRecording(): CursorRecordingData {
	return {
		version: CURSOR_TELEMETRY_VERSION,
		provider: "none",
		samples: [],
		assets: [],
	};
}

export function normalizeCursorSample(sample: unknown): CursorRecordingSample | null {
	if (!sample || typeof sample !== "object") {
		return null;
	}

	const point = sample as Partial<CursorRecordingSample>;
	const interactionType =
		point.interactionType === "click" ||
		point.interactionType === "mouseup" ||
		point.interactionType === "move"
			? point.interactionType
			: "move";
	return {
		timeMs:
			typeof point.timeMs === "number" && Number.isFinite(point.timeMs)
				? Math.max(0, point.timeMs)
				: 0,
		cx: typeof point.cx === "number" && Number.isFinite(point.cx) ? point.cx : 0.5,
		cy: typeof point.cy === "number" && Number.isFinite(point.cy) ? point.cy : 0.5,
		assetId: typeof point.assetId === "string" ? point.assetId : null,
		visible: typeof point.visible === "boolean" ? point.visible : true,
		cursorType: typeof point.cursorType === "string" ? point.cursorType : null,
		interactionType,
	};
}

export function normalizeCursorAsset(
	asset: unknown,
	platform: NodeJS.Platform = process.platform,
): NativeCursorAsset | null {
	if (!asset || typeof asset !== "object") {
		return null;
	}

	const candidate = asset as Partial<NativeCursorAsset>;
	if (typeof candidate.id !== "string" || typeof candidate.imageDataUrl !== "string") {
		return null;
	}

	return {
		id: candidate.id,
		platform: candidate.platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux",
		imageDataUrl: candidate.imageDataUrl,
		width:
			typeof candidate.width === "number" && Number.isFinite(candidate.width)
				? Math.max(1, Math.round(candidate.width))
				: 1,
		height:
			typeof candidate.height === "number" && Number.isFinite(candidate.height)
				? Math.max(1, Math.round(candidate.height))
				: 1,
		hotspotX:
			typeof candidate.hotspotX === "number" && Number.isFinite(candidate.hotspotX)
				? Math.max(0, Math.round(candidate.hotspotX))
				: 0,
		hotspotY:
			typeof candidate.hotspotY === "number" && Number.isFinite(candidate.hotspotY)
				? Math.max(0, Math.round(candidate.hotspotY))
				: 0,
		scaleFactor:
			typeof candidate.scaleFactor === "number" && Number.isFinite(candidate.scaleFactor)
				? Math.max(0.1, candidate.scaleFactor)
				: undefined,
		cursorType: typeof candidate.cursorType === "string" ? candidate.cursorType : null,
	};
}

export async function readCursorRecordingFileAt(
	telemetryPath: string,
): Promise<CursorRecordingData> {
	try {
		const content = await fs.readFile(telemetryPath, "utf-8");
		const parsed = JSON.parse(content);
		const rawSamples = Array.isArray(parsed)
			? parsed
			: Array.isArray(parsed?.samples)
				? parsed.samples
				: [];
		const rawAssets = Array.isArray(parsed?.assets) ? parsed.assets : [];

		const samples = rawSamples
			.map((sample: unknown) => normalizeCursorSample(sample))
			.filter((sample: CursorRecordingSample | null): sample is CursorRecordingSample =>
				Boolean(sample),
			)
			.sort((a: CursorRecordingSample, b: CursorRecordingSample) => a.timeMs - b.timeMs);

		const assets = rawAssets
			.map((asset: unknown) => normalizeCursorAsset(asset))
			.filter((asset: NativeCursorAsset | null): asset is NativeCursorAsset => Boolean(asset));

		return {
			version:
				typeof parsed?.version === "number" && Number.isFinite(parsed.version) ? parsed.version : 1,
			provider: (parsed?.provider === "native" ? "native" : "none") as CursorProviderKind,
			samples,
			assets,
		};
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code === "ENOENT") {
			return emptyRecording();
		}

		console.error("Failed to load cursor telemetry:", error);
		throw error;
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * P4 — the sidecar convention (`<videoPath>.cursor.json`) only holds while the
 * video stays exactly where it was recorded. If it's missing (file moved,
 * renamed, or imported from elsewhere), fall back to the fingerprint registry
 * (electron/media/mediaLinksRegistry.ts) to re-find the same telemetry file.
 *
 * ponytail: a malformed sidecar reports `found: false` rather than throwing.
 * The agent-facing caller has to be able to say "I looked and there is nothing
 * usable" — turning that into an exception would make the tool loop's only
 * honest answer indistinguishable from a crash, which is the same swap of
 * blindness for fact this whole change exists to stop.
 */
export async function readCursorSidecar(
	targetVideoPath: string,
	options: { recordingsDir?: string },
): Promise<CursorSidecarResult> {
	const directPath = `${targetVideoPath}.cursor.json`;
	if (await fileExists(directPath)) {
		try {
			return {
				found: true,
				source: "sidecar",
				path: directPath,
				data: await readCursorRecordingFileAt(directPath),
			};
		} catch {
			return { found: false, source: "none", path: null, data: emptyRecording() };
		}
	}
	if (options.recordingsDir) {
		try {
			const links = await findMediaLinksByFingerprint(options.recordingsDir, targetVideoPath);
			if (links?.cursorTelemetryPath) {
				return {
					found: true,
					source: "registry",
					path: links.cursorTelemetryPath,
					data: await readCursorRecordingFileAt(links.cursorTelemetryPath),
				};
			}
		} catch (error) {
			console.warn("[media-links] fingerprint lookup failed for cursor telemetry:", error);
		}
	}
	return { found: false, source: "none", path: null, data: emptyRecording() };
}

/** The shape the renderer's `loadCursorRecordingData` has always returned: the
 * recording data alone, with "not found" flattened into an empty payload. */
export async function readCursorRecordingFile(
	targetVideoPath: string,
	options: { recordingsDir?: string },
): Promise<CursorRecordingData> {
	return (await readCursorSidecar(targetVideoPath, options)).data;
}

/** The renderer's `loadCursorTelemetry`: positions only, no interaction type.
 *
 * ponytail: this projection DROPS `interactionType`, which means it drops every
 * click. That is fine for the timeline overlay it feeds and wrong for anything
 * that wants to know where the user acted — the agent digest reads
 * `readCursorSidecar` directly for exactly that reason. */
export async function readCursorTelemetryFile(
	targetVideoPath: string,
	options: { recordingsDir?: string },
) {
	try {
		const recordingData = await readCursorRecordingFile(targetVideoPath, options);
		return {
			success: true,
			samples: recordingData.samples.map((sample) => ({
				timeMs: sample.timeMs,
				cx: sample.cx,
				cy: sample.cy,
			})),
		};
	} catch (error) {
		console.error("Failed to load cursor telemetry:", error);
		return {
			success: false,
			message: "Failed to load cursor telemetry",
			error: String(error),
			samples: [],
		};
	}
}
