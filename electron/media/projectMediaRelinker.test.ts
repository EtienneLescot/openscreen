import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMediaLinks } from "./mediaLinksRegistry";
import { relinkProjectMedia } from "./projectMediaRelinker";

describe("relinkProjectMedia", () => {
	let tempDir: string;
	let logged: string[];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-project-relink-"));
		logged = [];
		const record = (...args: unknown[]) => {
			logged.push(args.join(" "));
		};
		vi.spyOn(console, "log").mockImplementation(record);
		vi.spyOn(console, "warn").mockImplementation(record);
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
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
		// The renderer persists whatever it was handed, so both rewrites are logged.
		expect(logged.join("\n")).toContain(currentScreenPath);
		expect(logged.join("\n")).toContain(currentWebcamPath);
	});

	it("refuses to relink an asset the document recorded no size for", async () => {
		// A same-named recording exists and is registered with its webcam, so a
		// basename match would resolve — that is exactly what must not happen. The
		// project has no fingerprint to check it against, and every document
		// migrated from v1.7 is in that state, so the only safe answer is no.
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
					cameraTrack: { sourcePath: "C:\\Users\\demo\\recording-42-webcam.mp4", visible: true },
				},
			],
		};

		const relinked = (await relinkProjectMedia(project, tempDir)) as typeof project;

		expect(logged.join("\n")).toContain("recording-42.mp4");
		expect(relinked.assets[0].originalPath).toBe("C:\\Users\\demo\\recording-42.mp4");
		expect(relinked.assets[0].cameraTrack.sourcePath).toBe(
			"C:\\Users\\demo\\recording-42-webcam.mp4",
		);
	});

	it("preserves unresolved screen and webcam paths without mutating the project", async () => {
		const project = {
			assets: [
				{
					id: "asset-missing",
					originalPath: "C:\\Users\\demo\\missing.mp4",
					sizeBytes: 42,
					cameraTrack: {
						sourcePath: "C:\\Users\\demo\\missing-webcam.mp4",
						visible: true,
					},
				},
			],
		};
		const before = structuredClone(project);

		const relinked = (await relinkProjectMedia(project, tempDir)) as typeof project;

		expect(relinked).toEqual(project);
		expect(relinked).not.toBe(project);
		expect(relinked.assets[0].originalPath).toBe("C:\\Users\\demo\\missing.mp4");
		expect(relinked.assets[0].cameraTrack.sourcePath).toBe("C:\\Users\\demo\\missing-webcam.mp4");
		expect(project).toEqual(before);
	});
});
