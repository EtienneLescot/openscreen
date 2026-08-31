import { toast } from "sonner";
import { create } from "zustand";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { toastText } from "@/i18n/toastText";
import { nativeBridgeClient } from "@/native/client";
import { type Interval, replaceTimeline as replaceTimelineOp } from "../document/timeline";
import { type AxcutAsset, type AxcutDocument, documentSchema } from "../schema";
import { probeVideoDimensions } from "../timeline/duration";
import { clearHistory, currentWriteEpoch, pushHistory } from "./undoStack";

// ponytail: thin Zustand wrapper over the native-bridge client. Keeps the
// current project + revision counter in renderer memory; mutations round-trip
// through the main process via the bridge so disk state stays authoritative.

export type ProjectStatus = "idle" | "loading" | "ready" | "error";

export interface DocumentWriteOptions {
	/**
	 * Record the outgoing document on the undo stack.
	 *
	 * REQUIRED, and deliberately not defaulted either way. A default is a decision
	 * nobody makes: defaulting to `true` let `probeAndCorrectClip` push a background
	 * probe's document onto the stack simply by not mentioning it, so the first
	 * Ctrl+Z after a drop snapped the clip back to its 60s placeholder instead of
	 * removing it -- and defaulting to `false` would recreate #433 itself the next
	 * time somebody added an edit. Making it a compile error to omit is the only
	 * version a new call site cannot get wrong by saying nothing.
	 *
	 * `true` for anything the user did. `false` for writes they never asked for:
	 * probe backfills, transcripts arriving from a background job, the camera
	 * auto-link, the optimistic half of an optimistic-write-then-save pair, and the
	 * persist an undo itself triggers (which would otherwise undo the undo).
	 */
	history: boolean;
	/**
	 * The document Ctrl+Z should return to, when it is NOT the one the store holds
	 * at the moment of the write.
	 *
	 * A live drag writes every pointermove straight into the store with
	 * `history: false`, so by the time the pointerup commit runs, the "previous"
	 * document the store holds is the dragged one -- recording that would make the
	 * gesture un-undoable. The commit passes the PRE-DRAG document here instead, and
	 * because `saveDocument` records only after the write succeeded, a failed commit
	 * records nothing at all and its rollback has nothing to pop.
	 *
	 * `null` means "there is no state to go back to" and records nothing. Omitting
	 * the field falls back to the store's current document, which is what an
	 * ordinary edit wants.
	 */
	historyBase?: AxcutDocument | null;
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
	 * Write the document to disk. Resolves `true` when it took effect, `false` when it
	 * did not.
	 *
	 * `false` means one of two things, and neither needs the caller to say anything:
	 * the write FAILED, which has already been reported to the user and logged; or an
	 * undo / redo / project switch happened while it was in flight, which the user did
	 * on purpose and can see on screen. Either way the store does not hold what was
	 * asked for, so a caller that reacts to `false` by undoing its own optimistic write
	 * must check the store still holds that write first -- see `agentDocumentApply`.
	 *
	 * It never rejects, by design. Every save in the app funnels through here and
	 * almost all of them are `void`-ed from a click handler, so a rejection here was
	 * an unhandled rejection in the renderer with no toast, no log and no clue --
	 * change a caption font on a read-only project and the edit was simply gone.
	 */
	saveDocument: (document: AxcutDocument, opts: DocumentWriteOptions) => Promise<boolean>;
	setDocument: (document: AxcutDocument, opts: DocumentWriteOptions) => void;
	/**
	 * Rebuild the timeline from `intervals` and save it.
	 *
	 * `opts` is NOT optional and NOT defaulted, for the same reason `history` itself is
	 * not: this used to hardcode `{ history: true }`, and because the option was invisible
	 * in this signature, no compile error could reach the one caller. That caller is the
	 * unattended recording import, which runs on editor mount -- so the user arrived in a
	 * brand-new project with `past.length === 1`, and their first Ctrl+Z emptied the
	 * timeline. A wrapper that writes has to let its caller decide, or it decides wrong on
	 * that caller's behalf.
	 */
	replaceTimeline: (
		intervals: Interval[],
		reason: string,
		opts: DocumentWriteOptions,
	) => Promise<void>;
	setSourceDuration: (sec: number) => void;
	setCurrentTime: (sec: number) => void;
	setPlaying: (playing: boolean) => void;
	markClean: () => void;
	/**
	 * Drop the open project. Clears the undo history and supersedes every in-flight
	 * write, the same as `loadProject` and `createProject` — this is a project
	 * switch too, just one with nothing on the other side of it.
	 */
	clear: () => void;
}

function parseDocument(value: unknown): AxcutDocument {
	return documentSchema.parse(value);
}

/**
 * The document a write should record as the state Ctrl+Z returns to. Read
 * SYNCHRONOUSLY, before any await: after one, `get().document` is whatever the
 * write installed.
 */
function historyBaseFor(opts: DocumentWriteOptions, current: AxcutDocument | null) {
	return opts.historyBase !== undefined ? opts.historyBase : current;
}

/**
 * Push `prev` onto the undo stack, unless the caller opted out or this write is
 * not a change (`commit`-style re-saves hand back the very object the store
 * already holds, and an optimistic `setDocument` then `saveDocument` pair would
 * otherwise take two undos to reverse one edit).
 *
 * Synchronous on purpose -- see the header of `undoStack.ts` for what the
 * deferred `import("./undo")` this replaced did to redo.
 */
function recordHistory(
	prev: AxcutDocument | null,
	next: AxcutDocument,
	opts: DocumentWriteOptions,
) {
	if (!opts.history) return;
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
		// Everything below awaits: the native add, a camera lookup, a dimension probe and a
		// save. `clear()` and `loadProject()` can all land in those gaps, and the store write
		// at the end is unconditional — so without this it can reinstall a deleted project's
		// document, or drop one project's asset into the one the user switched to. Same pair
		// `saveDocument` samples: the id says WHICH project, the epoch says whether anything
		// superseded the write while it was in flight.
		const epoch = currentWriteEpoch();
		const superseded = () => get().projectId !== projectId || currentWriteEpoch() !== epoch;
		const result = await nativeBridgeClient.aiEdition.addAsset(projectId, path, label);
		if (superseded()) return null;
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

		if (superseded()) return null;
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
		// Read BEFORE the await, while `get().document` is still the pre-edit one.
		// This is where undo history actually comes from: the editor writes through
		// `saveDocument` for every user edit -- add a region, delete one, rename the
		// project, every timeline op -- and `setDocument` is reserved for the handful
		// of live/optimistic paths. Recording only in `setDocument` left `past` empty
		// for everything the user does, so Ctrl+Z was a no-op (#433).
		const base = historyBaseFor(opts, get().document);
		// Read alongside it, and for the same reason: both describe the world this write
		// is building on, and the await is where that world can change underneath it.
		const epoch = currentWriteEpoch();
		try {
			const result = await nativeBridgeClient.aiEdition.save(document);
			if (!result.success || !result.document) {
				throw new Error(result.error ?? "Failed to save project");
			}
			// The undo wins, and this write is dropped -- store and history both. It was
			// in flight when the user pressed Ctrl+Z (or switched projects), so its document
			// is the one they just asked to leave: installing it reverted the undo on screen,
			// and recording it put a FORWARD state on `past` and cleared `future`, so the
			// redo they had just earned was gone.
			//
			// Dropped rather than reverted, because reverting is not this write's to do: the
			// bytes are already on disk, and it is the undo's own persist -- issued from
			// `useUndoRedoShortcuts`'s `onAfter` the moment it ran, so ordered after this one
			// on the same IPC channel -- that puts the restored document back over them.
			// `dirty` is deliberately left set for exactly that reason.
			if (currentWriteEpoch() !== epoch) return false;
			const parsed = parseDocument(result.document);
			set({
				document: parsed,
				revision: get().revision + 1,
				dirty: false,
				lastSavedAt: new Date(),
			});
			// Recorded HERE, below the write, and not above it. `saveDocument` resolves
			// false on a handled failure (a read-only project) and callers read that as
			// "the edit did not happen". Recording first left `past` holding a snapshot
			// identical to the live document and `future` wiped, so the next Ctrl+Z
			// visibly did nothing and redo was gone -- #433's own symptom, re-created by
			// the fix for it. Nothing between the `set` above and this line awaits, so no
			// undo can observe the half-applied state.
			recordHistory(base, document, opts);
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
		// No await to sit above: this write cannot fail, so recording it up front is
		// the same thing as recording it afterwards.
		recordHistory(historyBaseFor(opts, get().document), document, opts);
		set({
			document,
			revision: get().revision + 1,
			dirty: true,
		});
	},

	async replaceTimeline(intervals, reason, opts) {
		const doc = get().document;
		if (!doc) throw new Error("No project loaded");
		const next = replaceTimelineOp(doc, intervals, reason);
		await get().saveDocument(next, opts);
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
		// The epoch bump inside `clearHistory` is the load-bearing half, not the stack
		// drop. `clear()`'s one production caller deletes the project that is open
		// (`NewEditorShell`), and a background save issued a moment earlier -- a
		// transcript, a duration probe, a dimension backfill -- was still in flight. On
		// resolving it installed its document and set `dirty: false, lastSavedAt: now`,
		// so the editor that had just shown the empty state and toasted "Project
		// deleted" put the deleted project's document back on screen with
		// `projectId: null`, claiming it was freshly saved. Superseding those writes is
		// exactly what this moment means.
		//
		// Dropping the stacks is hygiene by comparison: `undo` already refuses a
		// snapshot whose `projectId` does not match the store's, and after this `set`
		// there is no `projectId` at all -- so a stale stack could only leak up to
		// MAX_HISTORY cloned documents until the next project load, never restore one.
		clearHistory();
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
