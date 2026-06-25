// DocumentService — main-process owner of v3 AxcutDocument projects.
// Persists one .axcut JSON per project under userData/projects/. Slim port of
// axcut's apps/server/src/services/document-service.ts (no separate paths.ts —
// uses app.getPath("userData") directly; no Python probe_media — assets carry
// only path metadata, duration is filled in by the renderer).
//
// ponytail: Phase 1 surface area is intentionally narrow (list / get / create
// / save / addAsset / removeAsset). ops/history/agent runtime land in Phase 6.

import fs from "node:fs/promises";
import path from "node:path";
import { createId } from "../../src/lib/ai-edition/document/ids";
import {
	type AxcutAsset,
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";

const PROJECT_FILE_EXTENSION = ".axcut";

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

export class DocumentService {
	private readonly projectsRoot: string;

	constructor(projectsRoot: string) {
		this.projectsRoot = projectsRoot;
	}

	async ensureProjectsDir(): Promise<void> {
		await fs.mkdir(this.projectsRoot, { recursive: true });
	}

	private fileFor(projectId: string): string {
		const safe = safeProjectId(projectId);
		return path.join(this.projectsRoot, `${safe}${PROJECT_FILE_EXTENSION}`);
	}

	async listProjects(): Promise<ProjectSummary[]> {
		await this.ensureProjectsDir();
		const entries = await fs.readdir(this.projectsRoot);
		const axcutFiles = entries.filter((name) => name.endsWith(PROJECT_FILE_EXTENSION));
		const summaries: ProjectSummary[] = [];
		for (const name of axcutFiles) {
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
		const filePath = this.fileFor(projectId);
		try {
			const raw = await fs.readFile(filePath, "utf8");
			return documentSchema.parse(JSON.parse(raw));
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
				throw new DocumentNotFoundError(projectId);
			}
			throw new ProjectFileError(
				`Failed to read project ${projectId}: ${error instanceof Error ? error.message : String(error)}`,
				projectId,
			);
		}
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
		const filePath = this.fileFor(projectId);
		try {
			await fs.unlink(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				throw error;
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
		const asset: AxcutAsset = {
			id: createId("asset"),
			kind: "video",
			label: input.label?.trim() || path.basename(absolutePath),
			originalPath: absolutePath,
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
				skipRanges: doc.timeline.skipRanges.filter((r) => r.assetId !== assetId),
			},
			project: {
				...doc.project,
				primaryAssetId,
				updatedAt: new Date().toISOString(),
			},
		};
		return this.saveProject(next);
	}

	private async writeProject(doc: AxcutDocument): Promise<void> {
		await this.ensureProjectsDir();
		const filePath = this.fileFor(doc.project.id);
		await fs.writeFile(filePath, JSON.stringify(doc, null, 2), "utf8");
	}
}
