import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentNotFoundError, DocumentService, ProjectFileError } from "./document-service";

async function makeTempDir(): Promise<string> {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-ai-edition-"));
	return base;
}

describe("DocumentService", () => {
	let tempDir: string;
	let service: DocumentService;

	beforeEach(async () => {
		tempDir = await makeTempDir();
		service = new DocumentService(tempDir);
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	describe("createProject", () => {
		it("creates a v4 doc with the given title and writes it to disk", async () => {
			const doc = await service.createProject("Demo Project");
			expect(doc.schemaVersion).toBe(4);
			expect(doc.project.title).toBe("Demo Project");
			expect(doc.project.id).toMatch(/^proj_/);
			expect(doc.assets).toEqual([]);

			const filePath = path.join(tempDir, `${doc.project.id}.axcut`);
			const raw = await fs.readFile(filePath, "utf8");
			expect(JSON.parse(raw)).toMatchObject({
				schemaVersion: 4,
				project: { title: "Demo Project" },
			});
		});

		it("falls back to 'Untitled Project' for empty titles", async () => {
			const doc = await service.createProject("   ");
			expect(doc.project.title).toBe("Untitled Project");
		});
	});

	describe("getProject", () => {
		it("returns the doc by id", async () => {
			const created = await service.createProject("Round trip");
			const fetched = await service.getProject(created.project.id);
			expect(fetched.project.id).toBe(created.project.id);
		});

		it("throws DocumentNotFoundError for missing projects", async () => {
			await expect(service.getProject("proj_does-not-exist")).rejects.toBeInstanceOf(
				DocumentNotFoundError,
			);
		});

		it("rejects project ids with path-traversal characters", async () => {
			await expect(service.getProject("../etc/passwd")).rejects.toBeInstanceOf(ProjectFileError);
			await expect(service.getProject("proj/with/slash")).rejects.toBeInstanceOf(ProjectFileError);
		});
	});

	describe("listProjects", () => {
		it("returns summaries sorted by updatedAt desc", async () => {
			const a = await service.createProject("A");
			await new Promise((r) => setTimeout(r, 5));
			const b = await service.createProject("B");
			const summaries = await service.listProjects();
			expect(summaries.map((s) => s.id)).toEqual([b.project.id, a.project.id]);
			expect(summaries[0]?.title).toBe("B");
		});

		it("skips files that fail to parse rather than throwing", async () => {
			const a = await service.createProject("OK");
			await fs.writeFile(path.join(tempDir, "garbage.axcut"), "not json", "utf8");
			const summaries = await service.listProjects();
			expect(summaries.map((s) => s.id)).toEqual([a.project.id]);
		});
	});

	describe("addAsset", () => {
		it("appends a video asset and sets primaryAssetId on the first add", async () => {
			const doc = await service.createProject("P");
			const updated = await service.addAsset(doc.project.id, {
				path: "/tmp/screen.mp4",
				label: "Screen",
			});
			expect(updated.assets).toHaveLength(1);
			const asset = updated.assets[0];
			expect(asset?.kind).toBe("video");
			expect(asset?.originalPath).toBe("/tmp/screen.mp4");
			expect(asset?.label).toBe("Screen");
			expect(updated.project.primaryAssetId).toBe(asset?.id);
		});

		it("resolves relative paths against the cwd", async () => {
			const doc = await service.createProject("P");
			const updated = await service.addAsset(doc.project.id, { path: "recording.webm" });
			expect(path.isAbsolute(updated.assets[0]?.originalPath ?? "")).toBe(true);
		});

		it("rejects unsupported video extensions", async () => {
			const doc = await service.createProject("P");
			await expect(
				service.addAsset(doc.project.id, { path: "/tmp/audio.mp3" }),
			).rejects.toBeInstanceOf(ProjectFileError);
		});

		it("preserves primaryAssetId when adding a second asset", async () => {
			const doc = await service.createProject("P");
			const first = await service.addAsset(doc.project.id, { path: "/tmp/a.mp4" });
			const after = await service.addAsset(doc.project.id, { path: "/tmp/b.mp4" });
			expect(after.project.primaryAssetId).toBe(first.project.primaryAssetId);
			expect(after.assets).toHaveLength(2);
		});
	});

	describe("removeAsset", () => {
		it("removes the asset and cascades clips + skipRanges", async () => {
			const doc = await service.createProject("P");
			const withAsset = await service.addAsset(doc.project.id, { path: "/tmp/a.mp4" });
			const assetId = withAsset.assets[0]?.id;
			expect(assetId).toBeTruthy();

			// Manually add a clip + skipRange so we can verify cascade
			const docWithTimeline = await service.saveProject({
				...withAsset,
				timeline: {
					...withAsset.timeline,
					clips: [
						{
							id: "clip_1",
							assetId,
							sourceStartSec: 0,
							timelineStartSec: 0,
							timelineEndSec: 1,
							wordRefs: [],
							origin: "system",
						},
					],
					skipRanges: [
						{
							id: "skip_1",
							assetId,
							startSec: 0,
							endSec: 1,
							origin: "user",
						},
					],
				},
			});

			const after = await service.removeAsset(docWithTimeline.project.id, assetId ?? "");
			expect(after.assets).toHaveLength(0);
			expect(after.timeline.clips).toHaveLength(0);
			expect(after.timeline.skipRanges).toHaveLength(0);
			expect(after.project.primaryAssetId).toBeUndefined();
		});

		it("reassigns primaryAssetId when removing the primary", async () => {
			const doc = await service.createProject("P");
			const a = await service.addAsset(doc.project.id, { path: "/tmp/a.mp4" });
			const b = await service.addAsset(doc.project.id, { path: "/tmp/b.mp4" });
			const primaryId = a.project.primaryAssetId;
			expect(primaryId).toBeTruthy();
			const after = await service.removeAsset(doc.project.id, primaryId ?? "");
			expect(after.project.primaryAssetId).toBe(b.assets[1]?.id);
		});

		it("throws when removing a missing asset", async () => {
			const doc = await service.createProject("P");
			await expect(service.removeAsset(doc.project.id, "asset_x")).rejects.toBeInstanceOf(
				ProjectFileError,
			);
		});
	});

	describe("deleteProject", () => {
		it("removes the .axcut file", async () => {
			const doc = await service.createProject("Bye");
			await service.deleteProject(doc.project.id);
			await expect(service.getProject(doc.project.id)).rejects.toBeInstanceOf(
				DocumentNotFoundError,
			);
		});

		it("is a no-op when the file doesn't exist", async () => {
			await expect(service.deleteProject("proj_never-existed")).resolves.toBeUndefined();
		});
	});
});
