import { toast } from "sonner";
import { create } from "zustand";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { toastText } from "@/i18n/toastText";
import { nativeBridgeClient } from "@/native/client";
import {
	type Interval,
	replaceTimeline as replaceTimelineOp,
	restoreFullTimeline as restoreFullTimelineOp,
} from "../document/timeline";
import { type AxcutAsset, type AxcutDocument, documentSchema } from "../schema";
import { probeVideoDimensions } from "../timeline/duration";
import { clearHistory, pushHistory } from "./undoStack";

// ponytail: thin Zustand wrapper over the native-bridge client. Keeps the
// current project + revision counter in renderer memory; mutations round-trip
// through the main process via the bridge so disk state stays authoritative.

export type ProjectStatus = "idle" | "loading" | "ready" | "error";

export interface DocumentWriteOptions {
	/**
	 * Record the outgoing document on the undo stack. Defaults to `true`: a write
	 * is a user edit unless the caller says otherwise.
	 *
	 * Pass `false` for writes the user never asked for -- probe backfills,
	 * transcripts arriving from a background job, the restore an undo itself
	 * persists. Those must not become Ctrl+Z steps, and a persist that re-recorded
	 * the document it just restored would undo the undo.
	 */
	history?: boolean;
}

export interface ProjectState {
	projectId: string | null;
	document: AxcutDocument | null;
	revision: number;
	status: ProjectStatus;
	error: string | null;
	sourceDurationSec: number;
	currentTimeSec: number;
	/** Single source of truth for "is the timeline transport playing?" — previously
	 *  duplicated as separate local state in NewEditorShell AND VirtualPreview, each
	 *  independently wired to the same raw <video> DOM events, which let one advance
	 *  a clip boundary while the other unconditionally stopped playback. */
	playing: boolean;
	/** True when the in-memory document has local changes that haven't been written to disk yet. */
	dirty: boolean;
	/** Timestamp of the most recent successful save (used by the titlebar indicator). */
	lastSavedAt: Date | null;

	loadProject: (projectId: string) => Promise<void>;
	createProject: (title: string) => Promise<AxcutDocument>;
	refresh: () => Promise<void>;
	addAsset: (path: string, label?: string) => Promise<AxcutAsset | null>;
	removeAsset: (assetId: string) => Promise<void>;
	/**
	 * Write the document to disk. Resolves `true` when it landed, `false` when it did
	 * not -- and a `false` has ALREADY been reported to the user and logged, so a
	 * caller that ignores it is choosing not to react, not choosing to stay silent.
	 *
	 * It never rejects, by design. Every save in the app funnels through here and
	 * almost all of them are `void`-ed from a click handler, so a rejection here was
	 * an unhandled rejection in the renderer with no toast, no log and no clue --
	 * change a caption font on a read-only project and the edit was simply gone.
	 */
	saveDocument: (document: AxcutDocument, opts?: DocumentWriteOptions) => Promise<boolean>;
	setDocument: (document: AxcutDocument, opts?: DocumentWriteOptions) => void;
	replaceTimeline: (intervals: Interval[], reason: string) => Promise<void>;
	restoreFullTimeline: () => Promise<void>;
	setSourceDuration: (sec: number) => void;
	setCurrentTime: (sec: number) => void;
	setPlaying: (playing: boolean) => void;
	markClean: () => void;
	clear: () => void;
}

function parseDocument(value: unknown): AxcutDocument {
	return documentSchema.parse(value);
}

/**
 * Record `prev` as the state Ctrl+Z returns to, unless the caller opted out or
 * this write is not a change (`commit`-style re-saves hand back the very object
 * the store already holds, and a live drag's `setLive` then `commit` pair would
 * otherwise take two undos to reverse one gesture).
 *
 * Synchronous on purpose -- see the header of `undoStack.ts` for what the
 * deferred `import("./undo")` this replaced did to redo.
 */
function recordHistory(
	prev: AxcutDocument | null,
	next: AxcutDocument,
	opts?: DocumentWriteOptions,
) {
	if (opts?.history === false) return;
	if (!prev || prev === next) return;
	pushHistory({ projectId: prev.project.id, doc: structuredClone(prev) });
}

export const useProjectStore = create<ProjectState>((set, get) => ({
	projectId: null,
	document: null,
	revision: 0,
	status: "idle",
	error: null,
	sourceDurationSec: 0,
	currentTimeSec: 0,
	playing: false,
	dirty: false,
	lastSavedAt: null,

	async loadProject(projectId) {
		set({ status: "loading", error: null });
		try {
			const result = await nativeBridgeClient.aiEdition.get(projectId);
			if (!result.success || !result.document) {
				throw new Error(result.error ?? "Failed to load project");
			}
			const document = parseDocument(result.document);
			set({
				projectId,
				document,
				revision: get().revision + 1,
				status: "ready",
				error: null,
				dirty: false,
				lastSavedAt: new Date(),
			});
			clearHistory();
		} catch (error) {
			set({
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},

	async createProject(title) {
		set({ status: "loading", error: null });
		try {
			const result = await nativeBridgeClient.aiEdition.create(title);
			if (!result.success || !result.document) {
				throw new Error(result.error ?? "Failed to create project");
			}
			const document = parseDocument(result.document);
			set({
				projectId: document.project.id,
				document,
				revision: get().revision + 1,
				status: "ready",
				error: null,
				dirty: false,
				lastSavedAt: new Date(),
			});
			clearHistory();
			return document;
		} catch (error) {
			set({
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	},

	async refresh() {
		const { projectId } = get();
		if (!projectId) return;
		await get().loadProject(projectId);
	},

	async addAsset(path, label) {
		const { projectId } = get();
		if (!projectId) throw new Error("No project loaded");
		const result = await nativeBridgeClient.aiEdition.addAsset(projectId, path, label);
		let document = parseDocument(result.document);
		const addedAsset =
			document.assets.find((a) => a.originalPath === path && (label ? a.label === label : true)) ??
			document.assets.at(-1) ??
			null;

		// P4 — auto-link the camera track from the recording-links registry (or
		// its legacy sidecar) for EVERY asset added, not just the first one in
		// the project: a project can hold multiple recordings, each with its
		// own camera (or none). The link is stored on the asset itself, not a
		// document-global field, so it follows the right clip in the timeline.
		// The camera DSL is read-only — cuts/zoom/speed live on the main
		// timeline and apply to the camera via the shared source-time
		// progression.
		if (addedAsset && window.electronAPI?.findRecordingCamera) {
			try {
				const camera = await window.electronAPI.findRecordingCamera(addedAsset.originalPath);
				if (camera.success && camera.webcamVideoPath) {
					// Stamp the camera's real dimensions at link time so a new recording never
					// needs the backfill in `useTimeline`. They decide the PiP's layout box, and
					// without them it falls back to a hardcoded 4:3 — which is how a 16:9 camera
					// used to be framed one way in the preview and another in an export.
					//
					// Deliberately outside the shape below and deliberately non-fatal: a probe
					// that fails must leave the link intact and let the backfill try again later,
					// never take the `catch` that drops the camera from the recording entirely.
					const camDims = await probeVideoDimensions(toFileUrl(camera.webcamVideoPath)).catch(
						() => null,
					);
					const linked = {
						sourcePath: camera.webcamVideoPath,
						startMs: 0,
						// ROUNDED, because `cameraTrackSchema` requires an integer and
						// the native capture paths measure this offset with
						// `performance.now()`, whose resolution is 100 µs — so roughly
						// nine recordings in ten produced something like -192.8 here.
						// `parseDocument` below then threw, the catch treated it as a
						// lookup failure, and the camera was dropped from a recording
						// that had one: the editor showed the screen video in the
						// camera's place. Sub-millisecond precision is meaningless for
						// a frame offset (a 60 fps frame is 16.7 ms), so rounding costs
						// nothing. Recordings already on disk carry the fractional
						// value in their session manifest, which is why this rounds on
						// the way IN rather than only at the recorder.
						offsetMs: Math.round(camera.offsetMs ?? 0),
						visible: true,
						...(camDims ?? {}),
					};
					const next: AxcutDocument = {
						...document,
						assets: document.assets.map((a) =>
							a.id === addedAsset.id ? { ...a, cameraTrack: linked } : a,
						),
					};
					// Only adopt the linked document if it actually reached disk -- otherwise
					// the caller is handed a document claiming a camera link the file does not
					// have. The store has already told the user the write failed.
					// `history: false`: linking a camera is part of adding the asset, not an
					// edit of its own -- and `get().document` here is still the pre-add document,
					// so recording it would make Ctrl+Z jump back past the import.
					if (await get().saveDocument(next, { history: false })) document = parseDocument(next);
				}
				// success:false just means no camera was found for this asset —
				// the normal case for a plain imported video. Nothing to surface.
			} catch (err) {
				// An actual lookup failure (not "no camera found") — worth surfacing.
				// Logged as well as toasted: a toast is gone in five seconds, and the
				// symptom this produces (a recording that silently loses its camera)
				// is reported from the editor, long after.
				console.warn("[project] camera auto-link failed:", err);
				const name = addedAsset.originalPath.split(/[\\/]/).pop() ?? addedAsset.originalPath;
				void import("sonner").then(({ toast }) =>
					toast.error(`Could not check for a camera recording near ${name}`, {
						description: err instanceof Error ? err.message : String(err),
					}),
				);
			}
		}

		set({
			document,
			revision: get().revision + 1,
			dirty: false,
			lastSavedAt: new Date(),
		});
		return addedAsset;
	},

	async removeAsset(assetId) {
		const { projectId } = get();
		if (!projectId) throw new Error("No project loaded");
		const result = await nativeBridgeClient.aiEdition.removeAsset(projectId, assetId);
		const document = parseDocument(result.document);
		set({
			document,
			revision: get().revision + 1,
			dirty: false,
			lastSavedAt: new Date(),
		});
	},

	async saveDocument(document, opts) {
		// Snapshot BEFORE the await, while `get().document` is still the pre-edit one.
		// This is where undo history actually comes from: the editor writes through
		// `saveDocument` for every user edit -- add a region, delete one, rename the
		// project, every timeline op -- and `setDocument` is reserved for the handful
		// of live/optimistic paths. Recording only in `setDocument` left `past` empty
		// for everything the user does, so Ctrl+Z was a no-op (#433).
		recordHistory(get().document, document, opts);
		try {
			const result = await nativeBridgeClient.aiEdition.save(document);
			if (!result.success || !result.document) {
				throw new Error(result.error ?? "Failed to save project");
			}
			const parsed = parseDocument(result.document);
			set({
				document: parsed,
				revision: get().revision + 1,
				dirty: false,
				lastSavedAt: new Date(),
			});
			return true;
		} catch (error) {
			// Logged as well as toasted: a toast is gone in five seconds, and "my edit
			// disappeared" gets reported much later than that.
			console.error("[project] failed to save document:", error);
			toast.error(toastText("editor", "project.failedToSave"), {
				description: error instanceof Error ? error.message : String(error),
			});
			// `dirty` is deliberately left alone. It is the only input to the
			// `beforeunload` guard and to `setHasUnsavedChanges`, so clearing it here
			// would let the window close without a prompt on the one path where there is
			// definitely something unsaved.
			return false;
		}
	},

	setDocument(document, opts) {
		recordHistory(get().document, document, opts);
		set({
			document,
			revision: get().revision + 1,
			dirty: true,
		});
	},

	async replaceTimeline(intervals, reason) {
		const doc = get().document;
		if (!doc) throw new Error("No project loaded");
		const next = replaceTimelineOp(doc, intervals, reason);
		await get().saveDocument(next);
	},

	async restoreFullTimeline() {
		const doc = get().document;
		if (!doc) throw new Error("No project loaded");
		const next = restoreFullTimelineOp(doc);
		await get().saveDocument(next);
	},

	setSourceDuration(sec) {
		set({ sourceDurationSec: sec });
	},

	setCurrentTime(sec) {
		set({ currentTimeSec: sec });
	},

	setPlaying(playing) {
		set({ playing });
	},

	clear() {
		set({
			projectId: null,
			document: null,
			revision: 0,
			status: "idle",
			error: null,
			sourceDurationSec: 0,
			currentTimeSec: 0,
			playing: false,
			dirty: false,
			lastSavedAt: null,
		});
	},

	markClean() {
		set({ dirty: false, lastSavedAt: new Date() });
	},
}));
