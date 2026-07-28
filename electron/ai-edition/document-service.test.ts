import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
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
		it("creates a v5 doc with the given title and writes it to disk", async () => {
			const doc = await service.createProject("Demo Project");
			expect(doc.schemaVersion).toBe(5);
			expect(doc.project.title).toBe("Demo Project");
			expect(doc.project.id).toMatch(/^proj_/);
			expect(doc.assets).toEqual([]);

			const filePath = path.join(tempDir, `${doc.project.id}.openscreen`);
			const raw = await fs.readFile(filePath, "utf8");
			expect(JSON.parse(raw)).toMatchObject({
				schemaVersion: 5,
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
			await fs.writeFile(path.join(tempDir, "garbage.openscreen"), "not json", "utf8");
			const summaries = await service.listProjects();
			expect(summaries.map((s) => s.id)).toEqual([a.project.id]);
		});

		it("migrates a legacy .axcut project to .openscreen on access", async () => {
			// A project written by an older build: same document bytes, `.axcut` name.
			const created = await service.createProject("Legacy");
			const openscreenPath = path.join(tempDir, `${created.project.id}.openscreen`);
			const axcutPath = path.join(tempDir, `${created.project.id}.axcut`);
			await fs.rename(openscreenPath, axcutPath);

			// A fresh service (new process) must still surface and load it, renaming
			// the file across in the process.
			const fresh = new DocumentService(tempDir);
			const summaries = await fresh.listProjects();
			expect(summaries.map((s) => s.id)).toEqual([created.project.id]);
			await expect(fresh.getProject(created.project.id)).resolves.toMatchObject({
				project: { id: created.project.id, title: "Legacy" },
			});
			await expect(fs.access(axcutPath)).rejects.toBeTruthy();
			await expect(fs.access(openscreenPath)).resolves.toBeUndefined();
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
		it("removes the asset and cascades clips + trimRanges", async () => {
			const doc = await service.createProject("P");
			const withAsset = await service.addAsset(doc.project.id, { path: "/tmp/a.mp4" });
			const assetId = withAsset.assets[0]?.id;
			expect(assetId).toBeTruthy();

			// Manually add a clip + trimRange so we can verify cascade
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
					trimRanges: [
						{
							id: "trim_1",
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
			expect(after.timeline.trimRanges).toHaveLength(0);
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
		it("removes the project file", async () => {
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

	// These reproduce a bug that destroyed two real project files: fs.writeFile
	// truncates and writes from offset 0, so two concurrent saves of one project
	// spliced together — a short document over a long one's head, the long one's
	// tail surviving past its end. The file parsed as JSON up to the splice and
	// then died, taking the user's edits with it.
	describe("concurrent saves", () => {
		/** A document whose serialised length is driven by `annotations`. */
		const withBulk = (doc: AxcutDocument, count: number): AxcutDocument => ({
			...doc,
			annotations: Array.from({ length: count }, (_, i) => ({
				id: `ann_${i}`,
				startMs: i,
				endMs: i + 1,
				type: "text" as const,
				content: `annotation ${i} ${"x".repeat(200)}`,
				position: { x: 10, y: 10 },
				size: { width: 20, height: 10 },
				style: {
					color: "#ffffff",
					backgroundColor: "transparent",
					fontSize: 32,
					fontFamily: "Inter",
					fontWeight: "bold" as const,
					fontStyle: "normal" as const,
					textDecoration: "none" as const,
					textAlign: "center" as const,
				},
				zIndex: i,
			})),
		});

		// Repeated, because the race is a coin flip: measured on the pre-fix code,
		// one long/short race spliced the file ~5 times out of 10. A single attempt
		// passed against the very bug it was written for. 12 rounds miss it once in
		// ~4000 runs; the loop is the test, not decoration.
		it("leaves valid JSON when a long and a short save race", async () => {
			for (let round = 0; round < 12; round++) {
				const doc = await service.createProject(`Race ${round}`);
				const file = path.join(tempDir, `${doc.project.id}.openscreen`);

				// Unawaited on purpose: this is the exact shape of the real failure —
				// two saves of one project in flight at once.
				await Promise.all([
					service.saveProject(withBulk(doc, 400)),
					service.saveProject(withBulk(doc, 1)),
				]);

				const raw = await fs.readFile(file, "utf8");
				// The destroyed projects died exactly here, at the splice point: the
				// short document's bytes, then the long one's tail past its end.
				const parsed = JSON.parse(raw);
				// Whichever save landed last must be on disk WHOLE — never a mix.
				expect([1, 400]).toContain(parsed.annotations.length);
				expect(raw.trimEnd().endsWith("}")).toBe(true);
			}
		});

		it("applies racing saves in call order, last one winning", async () => {
			const doc = await service.createProject("Order");
			await Promise.all([
				service.saveProject(withBulk(doc, 300)),
				service.saveProject(withBulk(doc, 5)),
				service.saveProject(withBulk(doc, 120)),
			]);
			const onDisk = await service.getProject(doc.project.id);
			expect(onDisk.annotations).toHaveLength(120);
		});

		it("survives many interleaved saves of one project", async () => {
			const doc = await service.createProject("Storm");
			// Sizes deliberately alternate long/short: equal-length writes overwrite
			// each other cleanly and would prove nothing.
			await Promise.all(
				Array.from({ length: 20 }, (_, i) => service.saveProject(withBulk(doc, i % 2 ? 300 : 2))),
			);
			const onDisk = await service.getProject(doc.project.id);
			expect(onDisk.annotations).toHaveLength(300);
		});

		it("keeps the previous document when a save fails mid-write", async () => {
			const doc = await service.createProject("Durable");
			await service.saveProject(withBulk(doc, 3));

			// Fail the write itself, not the validation before it: a full disk or an
			// EIO lands here, where the old pipeline had already truncated the file.
			const open = vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("ENOSPC: disk full"));
			await expect(service.saveProject(withBulk(doc, 99))).rejects.toThrow(ProjectFileError);
			open.mockRestore();

			// The point of temp+rename: the good document is still there, intact.
			const after = await service.getProject(doc.project.id);
			expect(after.annotations).toHaveLength(3);
		});

		it("does not leave temp files behind", async () => {
			const doc = await service.createProject("Tidy");
			await Promise.all([
				service.saveProject(withBulk(doc, 50)),
				service.saveProject(withBulk(doc, 2)),
			]);
			const entries = await fs.readdir(tempDir);
			expect(entries.filter((name) => name.includes(".tmp-"))).toEqual([]);
		});

		it("a failed save does not block later saves of the same project", async () => {
			const doc = await service.createProject("Recover");
			// The queue chains one save onto the last. If it chained on success only,
			// this rejection would strand every save behind it for the session.
			const open = vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("EIO"));

			const failing = service.saveProject(withBulk(doc, 2));
			const following = service.saveProject(withBulk(doc, 7));
			await expect(failing).rejects.toThrow(ProjectFileError);
			await expect(following).resolves.toBeTruthy();
			open.mockRestore();

			expect((await service.getProject(doc.project.id)).annotations).toHaveLength(7);
		});
	});
});
