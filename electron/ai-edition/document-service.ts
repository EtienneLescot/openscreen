// DocumentService — main-process owner of v3 AxcutDocument projects.
// Persists one .openscreen JSON per project under userData/projects/ (the file
// carries its own `schemaVersion`, so migration keys off the content, not the
// extension). Older builds wrote these same documents as `.axcut`; those are
// renamed to `.openscreen` on first access. Slim port of
// axcut's apps/server/src/services/document-service.ts (no separate paths.ts —
// uses app.getPath("userData") directly; no Python probe_media — assets carry
// only path metadata, duration is filled in by the renderer).
//
// ponytail: Phase 1 surface area is intentionally narrow (list / get / create
// / save / addAsset / removeAsset). ops/history/agent runtime land in Phase 6.

import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../src/lib/ai-edition/document/ids";
import {
	type AxcutAsset,
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";

const PROJECT_FILE_EXTENSION = ".openscreen";
// Older builds stored these same v3/v4 AxcutDocuments under `.axcut`. We read
// them for back-compat and rename them to PROJECT_FILE_EXTENSION on access.
const LEGACY_PROJECT_FILE_EXTENSION = ".axcut";

export interface ProjectSummary {
	id: string;
	title: string;
	updatedAt: string;
	assetCount: number;
}

export interface AddAssetInput {
	path: string;
	label?: string;
}

export class DocumentNotFoundError extends Error {
	constructor(public readonly projectId: string) {
		super(`Project not found: ${projectId}`);
		this.name = "DocumentNotFoundError";
	}
}

export class ProjectFileError extends Error {
	constructor(
		message: string,
		public readonly projectId?: string,
	) {
		super(message);
		this.name = "ProjectFileError";
	}
}

const SUPPORTED_VIDEO_EXTENSIONS = new Set([
	".mp4",
	".mov",
	".m4v",
	".webm",
	".mkv",
	".avi",
	".wmv",
]);

function isSupportedVideoPath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return SUPPORTED_VIDEO_EXTENSIONS.has(ext);
}

function safeProjectId(raw: string): string {
	// ponytail: project ids are uuid-prefixed strings (e.g. "proj_<uuid>"). Reject
	// anything that smells like path traversal before we ever touch the disk.
	if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
		throw new ProjectFileError(`Invalid project id: ${raw}`);
	}
	return raw;
}

/**
 * Windows fails a rename onto an open file with EPERM/EBUSY: an indexer, an
 * antivirus or a backup agent can hold the destination for a few milliseconds
 * after we last touched it. The write itself is sound, so retry briefly rather
 * than surface a save error the user cannot act on. POSIX renames don't hit this
 * and take the first attempt.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
	const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code ?? "";
			if (attempt >= 5 || !RETRYABLE.has(code)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
		}
	}
}

export class DocumentService {
	private readonly projectsRoot: string;
	private legacyMigrationDone = false;
	/** Tail of the in-flight save chain per project id — see writeProject. */
	private readonly writeQueues = new Map<string, Promise<void>>();

	constructor(projectsRoot: string) {
		this.projectsRoot = projectsRoot;
	}

	async ensureProjectsDir(): Promise<void> {
		await fs.mkdir(this.projectsRoot, { recursive: true });
		await this.migrateLegacyExtensions();
	}

	// One-time-per-process pass renaming any legacy `.axcut` project files to
	// `.openscreen`. The document bytes are identical (same schemaVersion), so
	// this is a pure rename — no content migration involved.
	private async migrateLegacyExtensions(): Promise<void> {
		if (this.legacyMigrationDone) return;
		this.legacyMigrationDone = true;
		let entries: string[];
		try {
			entries = await fs.readdir(this.projectsRoot);
		} catch {
			return;
		}
		await Promise.all(
			entries
				.filter((name) => name.endsWith(LEGACY_PROJECT_FILE_EXTENSION))
				.map(async (name) => {
					const from = path.join(this.projectsRoot, name);
					const base = name.slice(0, -LEGACY_PROJECT_FILE_EXTENSION.length);
					const to = path.join(this.projectsRoot, `${base}${PROJECT_FILE_EXTENSION}`);
					try {
						// If a `.openscreen` already exists for this id it's authoritative;
						// drop the stale `.axcut`. Otherwise rename the legacy file across.
						await fs.access(to);
						await fs.unlink(from);
					} catch {
						await fs
							.rename(from, to)
							.catch((err) =>
								console.warn(`[ai-edition] failed to migrate ${from} -> ${to}:`, err),
							);
					}
				}),
		);
	}

	private fileFor(projectId: string): string {
		const safe = safeProjectId(projectId);
		return path.join(this.projectsRoot, `${safe}${PROJECT_FILE_EXTENSION}`);
	}

	private legacyFileFor(projectId: string): string {
		const safe = safeProjectId(projectId);
		return path.join(this.projectsRoot, `${safe}${LEGACY_PROJECT_FILE_EXTENSION}`);
	}

	async listProjects(): Promise<ProjectSummary[]> {
		await this.ensureProjectsDir();
		const entries = await fs.readdir(this.projectsRoot);
		// ensureProjectsDir (above) already migrated any legacy `.axcut` files.
		const projectFiles = entries.filter((name) => name.endsWith(PROJECT_FILE_EXTENSION));
		const summaries: ProjectSummary[] = [];
		for (const name of projectFiles) {
			const filePath = path.join(this.projectsRoot, name);
			try {
				const raw = await fs.readFile(filePath, "utf8");
				const parsed = documentSchema.parse(JSON.parse(raw));
				summaries.push({
					id: parsed.project.id,
					title: parsed.project.title,
					updatedAt: parsed.project.updatedAt,
					assetCount: parsed.assets.length,
				});
			} catch (error) {
				// ponytail: skip unreadable files rather than failing the whole list.
				// A future migration pass can recover them.
				console.warn(`[ai-edition] failed to read ${filePath}:`, error);
			}
		}
		summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return summaries;
	}

	async getProject(projectId: string): Promise<AxcutDocument> {
		// Prefer the canonical `.openscreen` file, falling back to a not-yet-migrated
		// legacy `.axcut` so a project opened before its migration pass still loads.
		let raw: string;
		try {
			raw = await fs.readFile(this.fileFor(projectId), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				throw new ProjectFileError(
					`Failed to read project ${projectId}: ${error instanceof Error ? error.message : String(error)}`,
					projectId,
				);
			}
			try {
				raw = await fs.readFile(this.legacyFileFor(projectId), "utf8");
			} catch (legacyError) {
				if ((legacyError as NodeJS.ErrnoException)?.code === "ENOENT") {
					throw new DocumentNotFoundError(projectId);
				}
				throw new ProjectFileError(
					`Failed to read project ${projectId}: ${legacyError instanceof Error ? legacyError.message : String(legacyError)}`,
					projectId,
				);
			}
		}
		return documentSchema.parse(JSON.parse(raw));
	}

	async createProject(title: string): Promise<AxcutDocument> {
		await this.ensureProjectsDir();
		const projectId = createId("proj");
		const doc = createEmptyDocument({
			projectId,
			title: title?.trim() || "Untitled Project",
		});
		await this.writeProject(doc);
		return doc;
	}

	async saveProject(document: AxcutDocument): Promise<AxcutDocument> {
		const parsed = documentSchema.parse(document);
		const stamped: AxcutDocument = {
			...parsed,
			project: { ...parsed.project, updatedAt: new Date().toISOString() },
		};
		await this.writeProject(stamped);
		return stamped;
	}

	async deleteProject(projectId: string): Promise<void> {
		// Remove the canonical file and any lingering legacy `.axcut` for this id.
		for (const filePath of [this.fileFor(projectId), this.legacyFileFor(projectId)]) {
			try {
				await fs.unlink(filePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
					throw error;
				}
			}
		}
	}

	async addAsset(projectId: string, input: AddAssetInput): Promise<AxcutDocument> {
		const doc = await this.getProject(projectId);
		if (!input.path) {
			throw new ProjectFileError("Asset path is required.", projectId);
		}
		if (!isSupportedVideoPath(input.path)) {
			throw new ProjectFileError(
				`Unsupported video extension: ${path.extname(input.path)} (supported: ${[...SUPPORTED_VIDEO_EXTENSIONS].join(", ")})`,
				projectId,
			);
		}
		const absolutePath = path.isAbsolute(input.path) ? input.path : path.resolve(input.path);
		// P3.1 — capture the file size at import. Non-fatal: a stat failure
		// (network drive, permissions) just leaves sizeBytes undefined.
		let sizeBytes: number | undefined;
		try {
			sizeBytes = (await fs.stat(absolutePath)).size;
		} catch {
			sizeBytes = undefined;
		}
		const asset: AxcutAsset = {
			id: createId("asset"),
			kind: "video",
			label: input.label?.trim() || path.basename(absolutePath),
			originalPath: absolutePath,
			sizeBytes,
			cameraTrack: null,
		};
		const next: AxcutDocument = {
			...doc,
			assets: [...doc.assets, asset],
			project: {
				...doc.project,
				...(doc.project.primaryAssetId ? {} : { primaryAssetId: asset.id }),
				updatedAt: new Date().toISOString(),
			},
		};
		return this.saveProject(next);
	}

	async removeAsset(projectId: string, assetId: string): Promise<AxcutDocument> {
		const doc = await this.getProject(projectId);
		if (!doc.assets.some((a) => a.id === assetId)) {
			throw new ProjectFileError(`Asset ${assetId} not found in project ${projectId}.`, projectId);
		}
		const assets = doc.assets.filter((a) => a.id !== assetId);
		const primaryAssetId =
			doc.project.primaryAssetId === assetId
				? (assets[0]?.id ?? undefined)
				: doc.project.primaryAssetId;
		const next: AxcutDocument = {
			...doc,
			assets,
			timeline: {
				...doc.timeline,
				clips: doc.timeline.clips.filter((c) => c.assetId !== assetId),
				trimRanges: doc.timeline.trimRanges.filter((r) => r.assetId !== assetId),
			},
			project: {
				...doc.project,
				primaryAssetId,
				updatedAt: new Date().toISOString(),
			},
		};
		return this.saveProject(next);
	}

	/**
	 * Serialise saves per project, then write atomically.
	 *
	 * This has destroyed real project files. `fs.writeFile` opens with O_TRUNC and
	 * writes from offset 0, so two concurrent saves of the SAME project interleave
	 * onto one path: the short document lands over the long one's opening bytes and
	 * the long one's tail survives past its end. The result parses as JSON right up
	 * to the splice and then dies — the file is unreadable and the edits in it are
	 * gone. Two projects on this machine were lost exactly that way (a complete
	 * document followed by the tail of a longer, older version).
	 *
	 * Both halves are load-bearing:
	 *  - the queue makes concurrent saves of one project sequential, so a save
	 *    always writes over a settled file, never a half-written one;
	 *  - temp + rename makes each save all-or-nothing, so a crash (or a full disk)
	 *    mid-write leaves the previous document intact instead of a truncated one.
	 * The queue alone would still leave a torn file on a crash; the rename alone
	 * would still let two saves race for the same destination.
	 */
	private writeProject(doc: AxcutDocument): Promise<void> {
		const projectId = doc.project.id;
		const tail = this.writeQueues.get(projectId) ?? Promise.resolve();
		// Chained on both settlements: one save failing must not cancel the next.
		const run = tail.then(
			() => this.writeProjectNow(doc),
			() => this.writeProjectNow(doc),
		);
		const settled = run.catch(() => undefined);
		this.writeQueues.set(projectId, settled);
		void settled.then(() => {
			// Only the tail clears the entry — a later save may already own it.
			if (this.writeQueues.get(projectId) === settled) this.writeQueues.delete(projectId);
		});
		return run;
	}

	private async writeProjectNow(doc: AxcutDocument): Promise<void> {
		await this.ensureProjectsDir();
		const filePath = this.fileFor(doc.project.id);
		// The suffix goes AFTER the extension on purpose: listProjects matches on a
		// trailing `.openscreen`, so an interrupted write's leftover is invisible to
		// it rather than showing up as a corrupt project. Unique per write, so two
		// queues (or two processes) never share a temp path.
		const tempPath = `${filePath}.tmp-${process.pid}-${createId("w")}`;
		const json = JSON.stringify(doc, null, 2);

		let handle: FileHandle | undefined;
		try {
			handle = await fs.open(tempPath, "w");
			await handle.writeFile(json, "utf8");
			// Flush before the rename: without it the rename can reach the disk first
			// and a power loss leaves the new name pointing at unwritten blocks.
			await handle.sync();
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await fs.unlink(tempPath).catch(() => undefined);
			throw new ProjectFileError(
				`Failed to write project ${doc.project.id}: ${error instanceof Error ? error.message : String(error)}`,
				doc.project.id,
			);
		}
		await handle.close();

		try {
			await renameWithRetry(tempPath, filePath);
		} catch (error) {
			await fs.unlink(tempPath).catch(() => undefined);
			throw new ProjectFileError(
				`Failed to save project ${doc.project.id}: ${error instanceof Error ? error.message : String(error)}`,
				doc.project.id,
			);
		}

		// A save supersedes any legacy `.axcut` for this id (ensureProjectsDir
		// usually renamed it already; this is a belt-and-braces cleanup).
		await fs.unlink(this.legacyFileFor(doc.project.id)).catch(() => undefined);
	}
}
