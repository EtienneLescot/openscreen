import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PackedProjectData, runInfoCommand, runPackCommand } from "./projectCommands";

let root = "";

/** Absolute path inside the throwaway root, parents created. */
async function make(relative: string, contents = "video-bytes"): Promise<string> {
	const target = path.join(root, relative);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, contents, "utf8");
	return target;
}

async function writeProject(relative: string, data: PackedProjectData): Promise<string> {
	return make(relative, JSON.stringify(data));
}

const readProject = async (file: string): Promise<PackedProjectData> =>
	JSON.parse(await fs.readFile(file, "utf8"));

/** Collects CLI output instead of writing to stdout. */
function recorder() {
	const chunks: string[] = [];
	const write = (text: string) => {
		chunks.push(text);
	};
	return { write, text: () => chunks.join("") };
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "os-cli-pack-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("runPackCommand", () => {
	it("keeps screen and webcam apart when they share a basename", async () => {
		const screen = await make("rec/a/clip.mp4", "screen");
		const webcam = await make("rec/b/clip.mp4", "webcam");
		const project = await writeProject("demo.openscreen", {
			version: 1,
			media: { screenVideoPath: screen, webcamVideoPath: webcam },
		});
		const outDir = path.join(root, "packed");

		const out = recorder();
		expect(await runPackCommand(project, outDir, false, out.write)).toBe(0);

		const packed = await readProject(path.join(outDir, "demo.openscreen"));
		expect(packed.media?.screenVideoPath).not.toBe(packed.media?.webcamVideoPath);
		await expect(fs.readFile(packed.media?.screenVideoPath ?? "", "utf8")).resolves.toBe("screen");
		await expect(fs.readFile(packed.media?.webcamVideoPath ?? "", "utf8")).resolves.toBe("webcam");
	});

	it("copies the cursor sidecar and drops the legacy videoPath", async () => {
		const screen = await make("rec/clip.mp4", "screen");
		await make("rec/clip.mp4.cursor.json", "[]");
		const project = await writeProject("demo.openscreen", { version: 1, videoPath: screen });
		const outDir = path.join(root, "packed");

		const out = recorder();
		expect(await runPackCommand(project, outDir, true, out.write)).toBe(0);

		const packed = await readProject(path.join(outDir, "demo.openscreen"));
		expect(packed.videoPath).toBeUndefined();
		expect(packed.media?.screenVideoPath).toBe(path.join(outDir, "clip.mp4"));
		await expect(fs.readFile(path.join(outDir, "clip.mp4.cursor.json"), "utf8")).resolves.toBe(
			"[]",
		);
		expect(JSON.parse(out.text())).toMatchObject({ event: "done", cursorData: true });
	});

	it("falls back to media sitting next to the project when the stored path is stale", async () => {
		await make("moved/clip.mp4", "screen");
		const project = await writeProject("moved/demo.openscreen", {
			version: 1,
			media: { screenVideoPath: path.join(root, "gone", "clip.mp4") },
		});
		const outDir = path.join(root, "packed");

		const out = recorder();
		expect(await runPackCommand(project, outDir, false, out.write)).toBe(0);
		await expect(fs.readFile(path.join(outDir, "clip.mp4"), "utf8")).resolves.toBe("screen");
	});

	it("fails when the referenced media is nowhere to be found", async () => {
		const project = await writeProject("demo.openscreen", {
			version: 1,
			media: { screenVideoPath: path.join(root, "gone", "clip.mp4") },
		});

		const out = recorder();
		await expect(
			runPackCommand(project, path.join(root, "packed"), false, out.write),
		).rejects.toThrow(/Referenced media not found/);
	});
});

describe("runInfoCommand", () => {
	it("exits 1 when the project's video is missing, 0 when it is there", async () => {
		const missing = await writeProject("missing.openscreen", {
			version: 1,
			media: { screenVideoPath: path.join(root, "gone", "clip.mp4") },
		});
		const present = await writeProject("present.openscreen", {
			version: 1,
			media: { screenVideoPath: await make("rec/clip.mp4") },
		});

		const out = recorder();
		expect(await runInfoCommand(missing, false, out.write)).toBe(1);
		expect(out.text()).toContain("[MISSING]");
		expect(await runInfoCommand(present, false, out.write)).toBe(0);
	});

	it("counts timeline regions in --json mode", async () => {
		const project = await writeProject("demo.openscreen", {
			version: 1,
			media: { screenVideoPath: await make("rec/clip.mp4") },
			editor: { zoomRegions: [{}, {}], trimRegions: [{}], exportFormat: "mp4" },
		});

		const out = recorder();
		expect(await runInfoCommand(project, true, out.write)).toBe(0);
		expect(JSON.parse(out.text())).toMatchObject({
			zoomRegions: 2,
			trimRegions: 1,
			speedRegions: 0,
			annotationRegions: 0,
			exportFormat: "mp4",
			screenVideoExists: true,
		});
	});
});
