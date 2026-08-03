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

	let links: RelocatedMediaLookup | null = null;
	if (await fileExists(originalPath)) {
		try {
			const existing = await findMediaLinksByFingerprint(baseDir, originalPath);
			links = existing ? { screenVideoPath: originalPath, ...existing } : null;
		} catch {
			links = null;
		}
	} else {
		links = await findRelocatedMediaByStoredPath(
			baseDir,
			originalPath,
			typeof asset.sizeBytes === "number" ? asset.sizeBytes : undefined,
		);
	}
	if (!links) return asset;

	let cameraTrack = asset.cameraTrack;
	if (isRecord(cameraTrack) && typeof cameraTrack.sourcePath === "string") {
		const cameraIsMissing = !(await fileExists(cameraTrack.sourcePath));
		if (cameraIsMissing && links.webcamVideoPath && (await fileExists(links.webcamVideoPath))) {
			cameraTrack = { ...cameraTrack, sourcePath: links.webcamVideoPath };
		}
	}

	return {
		...asset,
		originalPath: links.screenVideoPath,
		...(cameraTrack === asset.cameraTrack ? {} : { cameraTrack }),
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
