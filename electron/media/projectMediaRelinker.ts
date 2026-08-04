// Relinks the media a project points at when those files are no longer where
// the document says they are — the project was authored on another machine, or
// the recordings were moved after it was last saved. Runs on every project open
// (DocumentService.getProject), not just on import, because a document already
// broken by a move stays broken otherwise.
//
// ponytail: this rewrites paths that the renderer then saves back, so it is
// deliberately conservative — it only ever accepts a candidate the media-links
// registry can vouch for by recorded size, and it logs every rewrite. Guessing
// wrong here means the user opens a project and silently gets someone else's
// footage, which is worse than opening it with a missing-media placeholder.

import fs from "node:fs/promises";
import {
	findMediaLinksByFingerprint,
	findRelocatedMediaByStoredPath,
	type RelocatedMediaLookup,
} from "./mediaLinksRegistry";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		return (await fs.stat(filePath)).isFile();
	} catch {
		return false;
	}
}

async function resolveAssetMedia(
	asset: Record<string, unknown>,
	baseDir: string,
): Promise<Record<string, unknown>> {
	const originalPath = asset.originalPath;
	if (typeof originalPath !== "string" || !originalPath) return asset;

	const cameraTrack = asset.cameraTrack;
	const cameraPath =
		isRecord(cameraTrack) && typeof cameraTrack.sourcePath === "string" && cameraTrack.sourcePath
			? cameraTrack.sourcePath
			: null;
	const screenExists = await fileExists(originalPath);
	const cameraMissing = cameraPath !== null && !(await fileExists(cameraPath));
	// Nothing to repair, and this runs on every project open — don't fingerprint
	// (i.e. open and read) every asset just to confirm what the stats already say.
	if (screenExists && !cameraMissing) return asset;

	let links: RelocatedMediaLookup | null = null;
	if (screenExists) {
		try {
			const existing = await findMediaLinksByFingerprint(baseDir, originalPath);
			links = existing ? { screenVideoPath: originalPath, ...existing } : null;
		} catch {
			links = null;
		}
	} else if (typeof asset.sizeBytes === "number") {
		links = await findRelocatedMediaByStoredPath(baseDir, originalPath, asset.sizeBytes);
		if (links) {
			console.log(`[media-relink] screen video ${originalPath} -> ${links.screenVideoPath}`);
		}
	} else {
		// Documents migrated from v1.7 carry no size (only DocumentService.addAsset
		// records one), so this is the common case for old projects. Without it
		// there is nothing to tell one `recording.mp4` from another.
		console.warn(
			`[media-relink] ${originalPath} is missing and the project recorded no file size for it — refusing to guess a replacement`,
		);
	}
	if (!links) return asset;

	let nextCameraTrack = cameraTrack;
	if (
		isRecord(cameraTrack) &&
		cameraMissing &&
		links.webcamVideoPath &&
		(await fileExists(links.webcamVideoPath))
	) {
		console.log(`[media-relink] webcam video ${cameraPath} -> ${links.webcamVideoPath}`);
		nextCameraTrack = { ...cameraTrack, sourcePath: links.webcamVideoPath };
	}

	return {
		...asset,
		originalPath: links.screenVideoPath,
		...(nextCameraTrack === cameraTrack ? {} : { cameraTrack: nextCameraTrack }),
	};
}

/**
 * Relink registry-known media in a loaded Axcut document without mutating the
 * parsed JSON. Unknown project shapes and unresolved assets pass through.
 */
export async function relinkProjectMedia(project: unknown, baseDir: string): Promise<unknown> {
	if (!isRecord(project) || !Array.isArray(project.assets)) return project;
	const assets = await Promise.all(
		project.assets.map((asset) => (isRecord(asset) ? resolveAssetMedia(asset, baseDir) : asset)),
	);
	return { ...project, assets };
}
