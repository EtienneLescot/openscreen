import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerMediaLinks } from "./mediaLinksRegistry";
import { relinkProjectMedia } from "./projectMediaRelinker";

describe("relinkProjectMedia", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-project-relink-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("relinks stale screen and webcam paths without mutating the loaded project", async () => {
		const currentScreenPath = path.join(tempDir, "recording-42.mp4");
		const currentWebcamPath = path.join(tempDir, "recording-42-webcam.mp4");
		await fs.writeFile(currentScreenPath, "screen bytes");
		await fs.writeFile(currentWebcamPath, "webcam bytes");
		await registerMediaLinks(tempDir, currentScreenPath, {
			webcamVideoPath: currentWebcamPath,
		});

		const project = {
			assets: [
				{
					id: "asset-1",
					originalPath: "C:\\Users\\demo\\recording-42.mp4",
					sizeBytes: Buffer.byteLength("screen bytes"),
					cameraTrack: {
						sourcePath: "C:\\Users\\demo\\recording-42-webcam.mp4",
						startMs: 0,
						offsetMs: 0,
						visible: true,
					},
				},
			],
		};

		const relinked = (await relinkProjectMedia(project, tempDir)) as typeof project;

		expect(relinked.assets[0].originalPath).toBe(currentScreenPath);
		expect(relinked.assets[0].cameraTrack.sourcePath).toBe(currentWebcamPath);
		expect(project.assets[0].originalPath).toBe("C:\\Users\\demo\\recording-42.mp4");
		expect(project.assets[0].cameraTrack.sourcePath).toBe(
			"C:\\Users\\demo\\recording-42-webcam.mp4",
		);
	});
});
