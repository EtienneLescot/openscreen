import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { EditorProjectData } from "@/components/video-editor/projectPersistence";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { useEditorDialogActions } from "@/contexts/EditorDialogsContext";
import { useScopedT } from "@/contexts/I18nContext";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import {
	migrateProjectDataToAxcutDocument,
	migrateRawDocumentToCurrent,
} from "@/lib/ai-edition/document/migrate";
import {
	applyProbedDuration,
	replaceTimeline as replaceTimelineOp,
} from "@/lib/ai-edition/document/timeline";
import { isModalOpen } from "@/lib/ai-edition/modalGuard";
import { type AxcutClip, documentSchema } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	useAssetTranscriptions,
	useAutoTranscription,
	useTimelineTranscriptGate,
	useTranscriptionStore,
} from "@/lib/ai-edition/store/transcriptionStore";
import { useUndoRedoShortcuts } from "@/lib/ai-edition/store/undo";
import { useSequentialTimelineOps } from "@/lib/ai-edition/store/useSequentialTimelineOps";
import { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { newRegionDurationSec } from "@/lib/ai-edition/timeline/newRegionDuration";
import { matchesShortcut } from "@/lib/shortcuts";
import { nativeBridgeClient } from "@/native";
import type { AiEditionProjectSummary } from "@/native/contracts";
import { resolveVisibleClips } from "@/native/sceneDescription";
import { useNativePlaybackSync } from "@/native/useNativePlaybackSync";
import { ExportDialog } from "./ExportDialog";
import { ChatStripPanel } from "./LeftPanel";
import {
	EditClipModal,
	NewProjectModal,
	OpenProjectModal,
	type StartingPoint,
	UnsavedChangesModal,
	type UnsavedChoice,
} from "./Modals";
import { Preview } from "./Preview";
import type { TrimTarget } from "./RightPanes";
import { importPendingRecording } from "./recordingImport";
import v4 from "./v4/EditorShellV4.module.css";
import { type EditorMode, EditorTopBar } from "./v4/EditorTopBar";
import { type Facet, FloatingInspector } from "./v4/FloatingInspector";
import { MediaStage } from "./v4/MediaStage";
import { RecStage } from "./v4/RecStage";
import { V4Timeline } from "./v4/V4Timeline";

interface SeekTarget {
	timeSec: number;
	isSource?: boolean;
	requestId: number;
}

/**
 * Renders nothing. Exists purely so the per-frame `currentTimeSec` subscription
 * that feeds the native transport lives in a LEAF instead of in the shell.
 *
 * `currentTimeSec` is rewritten on every animation frame during playback
 * (VirtualPreview's rAF tick → onTimeChange → setCurrentTime). Reading it
 * directly in NewEditorShell re-rendered the entire editor — timeline, clips,
 * waveforms, inspector, preview — 60×/s, which is what made the playhead and
 * the transcript cue point stutter: the whole tree had to commit before the
 * playhead's own DOM node moved. Everything that genuinely needs the live
 * playhead now subscribes to it where it is actually rendered (PlayheadOverlay,
 * TransportBar, Preview, TranscriptPane, NativeCompositorOverlay, and this
 * component); the shell itself reads it imperatively via getState() in the
 * handlers that need it. The store write cadence is unchanged — `currentTimeSec`
 * is still the source of truth, still updated every frame.
 */
function NativePlaybackSync({
	visibleClips,
	clips,
}: {
	visibleClips: AxcutClip[];
	clips: AxcutClip[];
}) {
	const playing = useProjectStore((s) => s.playing);
	const currentTimeSec = useProjectStore((s) => s.currentTimeSec);
	// visibleClips = trim-compressed native stream; `clips` = RAW layout currentTimeSec
	// is measured against. resolveNativePosition needs both (see timelineMap).
	useNativePlaybackSync(playing, currentTimeSec, visibleClips, clips);
	return null;
}

export function NewEditorShell() {
	const te = useScopedT("editor");
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const dirty = useProjectStore((s) => s.dirty);
	const createProject = useProjectStore((s) => s.createProject);
	const setCurrentTime = useProjectStore((s) => s.setCurrentTime);
	const setSourceDuration = useProjectStore((s) => s.setSourceDuration);
	const loadProject = useProjectStore((s) => s.loadProject);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	// Single source of truth for transport state (was local useState here AND, separately
	// and unused, in VirtualPreview — two copies independently wired to the same <video>
	// events could disagree, see the "stops at clip end" fix history). Anything that needs
	// to know or drive playback reads/writes this store field now, not a component-local copy.
	const playing = useProjectStore((s) => s.playing);
	const setPlaying = useProjectStore((s) => s.setPlaying);

	const [seekTarget, setSeekTarget] = useState<SeekTarget | null>(null);
	const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
	// v4 shell: three modes (Media / Edit / Rec), a collapsible agent (chat)
	// column, and a floating facet inspector over the stage.
	const [mode, setMode] = useState<EditorMode>("edit");
	const [chatOpen, setChatOpen] = useState(true);
	const [chatWidthPx, setChatWidthPx] = useState(
		() => Number(localStorage.getItem("os-editor-chat-width")) || 392,
	);
	const [timelineHeightPx, setTimelineHeightPx] = useState(
		() => Number(localStorage.getItem("os-editor-timeline-height")) || 308,
	);
	const [inspectorOpen, setInspectorOpen] = useState(true);
	const [facet, setFacet] = useState<Facet>("effects");
	const [openProjectOpen, setOpenProjectOpen] = useState(false);
	const [newProjectOpen, setNewProjectOpen] = useState(false);
	// Crop + trim in/out both live in EditClipModal now (per-clip), reachable
	// from the timeline (double-click / pencil icon) and the inspector's
	// "Edit clip" rail button — a single shell-level instance instead of one
	// mounted per trigger site.
	const [editClipTarget, setEditClipTarget] = useState<AxcutClip | null>(null);
	const [exportOpen, setExportOpen] = useState(false);
	const [unsavedPrompt, setUnsavedPrompt] = useState<{
		action: "close" | "new" | "open" | "record";
		resolve: (choice: UnsavedChoice) => void;
	} | null>(null);
	const { shortcuts, isMac, openConfig: openShortcutsConfig } = useShortcuts();
	// The actions half of the dialog context, not the section: this component only ever *opens*
	// one, and subscribing it to the open state would re-render the whole editor — timeline,
	// preview, transport — twice per dialog interaction. Whether a dialog is open is a question
	// for `isModalOpen`, which answers for every modal rather than for this context's one.
	const { openDialog } = useEditorDialogActions();
	// Transcription is local and every transcript-driven feature (Smart cuts,
	// captions, the transcript pane) needs one, so the editor produces them by
	// itself instead of waiting for the user to find the button. This hook is
	// the ONLY place the background pass is driven from — see transcriptionStore.
	useAutoTranscription();
	const requestTimelineTranscripts = useTranscriptionStore((s) => s.requestTimelineTranscripts);
	// Resolved over the assets the TIMELINE plays, not over the primary asset: in
	// a recording project the primary asset is the screen capture, which is
	// routinely silent, and keying the transcript pane off it made the pane claim
	// "no audio track" for a project whose actual footage was mid-transcription.
	const transcriptGate = useTimelineTranscriptGate();
	// Per asset, for the transcript pane: only the block whose transcript is
	// actually being rewritten goes read-only. The gate answers "may a
	// transcript-dependent ACTION run?", which is a different question.
	const transcriptions = useAssetTranscriptions();
	const busyAssetIds = useMemo(
		() =>
			Object.values(transcriptions)
				.filter((v) => v.status === "running" || v.status === "queued")
				.map((v) => v.assetId),
		[transcriptions],
	);
	const tl = useTimeline();
	// An undo only puts the restored document back in the store and marks it dirty,
	// so without this the reverted state never reached disk: close the window and the
	// edit the user just undid came back. `history: false` is load-bearing — a
	// recording save here would push the restored document straight back onto the
	// stack and clear the redo the undo had just created.
	const { runUndo, runRedo } = useUndoRedoShortcuts(() => {
		const doc = useProjectStore.getState().document;
		if (doc) void useProjectStore.getState().saveDocument(doc, { history: false });
	});
	const [copiedClipId, setCopiedClipId] = useState<string | null>(null);
	const [projectSummaries, setProjectSummaries] = useState<AiEditionProjectSummary[]>([]);
	const seekSeqRef = useRef(0);
	const initRef = useRef(false);

	// Dev-only: expose the project store so the browser preview harness can
	// seed a populated document for design QA. Tree-shaken out of prod builds.
	if (import.meta.env.DEV) {
		(window as unknown as { __osProjectStore?: typeof useProjectStore }).__osProjectStore =
			useProjectStore;
	}

	// ponytail: serialise timeline-edit saves so two rapid Backspaces
	// don't race each other's save and overwrite one another in the
	// store. The hook reads the doc inside the chain (after awaiting the
	// previous save) — see its source for the race this fixes.
	const { apply: applyTimelineOp, enqueue: enqueueTimelineWrite } = useSequentialTimelineOps({
		fallbackDocument: document,
		saveDocument,
	});

	const promptUnsaved = useCallback(
		(action: "close" | "new" | "open" | "record"): Promise<UnsavedChoice> => {
			if (!dirty) return Promise.resolve("discard");
			return new Promise<UnsavedChoice>((resolve) => {
				setUnsavedPrompt({ action, resolve });
			});
		},
		[dirty],
	);

	const primaryAssetPath =
		document?.assets.find((a) => a.id === document.project.primaryAssetId)?.originalPath ?? null;
	void primaryAssetPath;
	const clips: AxcutClip[] = document?.timeline.clips ?? [];
	const visibleClips = useMemo(() => (document ? resolveVisibleClips(document) : []), [document]);
	const hasProject = Boolean(document);
	const hasAsset = projectId !== null && (document?.assets.length ?? 0) > 0;
	const project = document?.project
		? {
				id: document.project.id,
				title: document.project.title,
				updatedAt: new Date().toISOString(),
			}
		: null;

	// refresh project list when the Open Project modal is open
	useEffect(() => {
		if (!openProjectOpen) return;
		void (async () => {
			try {
				const next = await nativeBridgeClient.aiEdition.listProjects();
				setProjectSummaries(next);
			} catch {
				// ponytail: silent
			}
		})();
	}, [openProjectOpen]);

	// Auto-load project recording session on mount
	useEffect(() => {
		if (initRef.current) return;
		initRef.current = true;
		void (async () => {
			if (!window.electronAPI) return;
			try {
				if (await importPendingRecording()) {
					toast.success("Recording added to a new project");
					return;
				}
			} catch (err) {
				toast.error("Could not auto-create project from recording", {
					description: err instanceof Error ? err.message : String(err),
				});
				return;
			}
			// ponytail: no recording waiting — restore the user's most recent
			// project. The browser-shim's listProjects returns the seeded
			// `browser-shim-projects` entries, so e2e tests can land directly in a
			// populated editor; for real Electron users this is the expected "open
			// last project on launch" UX — and, now that the recording hand-off is
			// consumed on import, it is also what reopening the editor after a
			// recording lands on: the project that recording went into, settings and
			// all, instead of a second project on the same file.
			try {
				const projects = await nativeBridgeClient.aiEdition.listProjects();
				console.info("[editor] listProjects returned", projects);
				if (projects.length > 0) {
					console.info("[editor] auto-loading project", projects[0].id);
					await loadProject(projects[0].id);
					const state = useProjectStore.getState();
					console.info(
						"[editor] post-loadProject status=",
						state.status,
						"error=",
						JSON.stringify(state.error),
						"doc=",
						state.document ? "loaded" : "null",
					);
				}
			} catch (e) {
				console.warn("[editor] auto-load failed", e);
			}
		})();
	}, [loadProject]);

	// Warn on close when dirty
	useEffect(() => {
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			if (useProjectStore.getState().dirty) {
				e.preventDefault();
				e.returnValue = "";
			}
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, []);

	// Electron close interception
	useEffect(() => {
		if (!window.electronAPI) return;

		// 1. Sync dirty state to Electron main process
		window.electronAPI.setHasUnsavedChanges(dirty);
	}, [dirty]);

	useEffect(() => {
		if (!window.electronAPI) return;

		// 2. Handle request-close-confirm from Electron
		const unsubCloseConfirm = window.electronAPI.onRequestCloseConfirm(() => {
			void (async () => {
				const choice = await promptUnsaved("close");
				if (choice === "discard") {
					window.electronAPI.sendCloseConfirmResponse("discard");
				} else if (choice === "save") {
					window.electronAPI.sendCloseConfirmResponse("save");
				} else {
					window.electronAPI.sendCloseConfirmResponse("cancel");
				}
			})();
		});

		// 3. Handle request-save-before-close from Electron
		const unsubSaveBeforeClose = window.electronAPI.onRequestSaveBeforeClose(async () => {
			const doc = useProjectStore.getState().document;
			// The store already toasted the reason; answering false is what keeps the
			// window open on top of it.
			if (doc) return await saveDocument(doc, { history: true });
			return true;
		});

		return () => {
			unsubCloseConfirm?.();
			unsubSaveBeforeClose?.();
		};
	}, [promptUnsaved, saveDocument]);

	const videoSources = useMemo(() => {
		if (!document) return [];
		return document.assets.map((asset) => ({
			id: asset.id,
			filePath: /^(https?|blob|data):/.test(asset.originalPath) ? undefined : asset.originalPath,
			// Real Electron assets are filesystem paths and go through toFileUrl.
			// In the browser preview an asset can already point at an http(s)/
			// blob/data URL served by Vite; toFileUrl would mangle those into a
			// broken file:// URL, so pass web URLs through untouched.
			src: /^(https?|blob|data):/.test(asset.originalPath)
				? asset.originalPath
				: toFileUrl(asset.originalPath),
			label: asset.label,
		}));
	}, [document]);

	const handleLoadedMetadata = useCallback(
		(durationSec: number, assetId: string) => {
			// ponytail: WebM recordings from MediaRecorder report NaN/Infinity
			// until the main-process EBML fix lands. Fall back to a 60s seed if
			// duration is unknown so the timeline never gets stuck on an empty
			// placeholder. All store reads go through getState() to avoid
			// stale-closure bugs.
			const known = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 60;
			const state = useProjectStore.getState();
			setSourceDuration(known);
			const doc = state.document;
			if (!doc || doc.assets.length === 0) return;
			if (doc.timeline.clips.length === 0) {
				// ponytail: replaceTimeline derives clip length from
				// asset.durationSec, which import never populates — without this
				// patch the first auto-created clip silently comes out empty
				// (normalizeIntervals clamps against a 0 duration and drops it).
				const primaryAssetId = doc.project.primaryAssetId ?? doc.assets[0]?.id;
				const docWithDuration = primaryAssetId
					? {
							...doc,
							assets: doc.assets.map((a) =>
								a.id === primaryAssetId ? { ...a, durationSec: known } : a,
							),
						}
					: doc;
				const next = replaceTimelineOp(
					docWithDuration,
					[{ startSec: 0, endSec: known }],
					"Auto-created full-duration clip",
				);
				// `history: false` for both writes in this callback: they are the probed
				// duration being folded into the document on load, not something the user
				// did — an undo landing on one of them would empty their timeline.
				void state.saveDocument(next, { history: false });
				return;
			}
			// Hand the probed duration to the pure document layer: it patches only the
			// clips of THIS asset that are still waiting for a real length (the
			// pre-probe placeholder, or the extent-less clip a legacy v2 import mints),
			// shifts what follows, and brings the modifiers along — anchoring the ones
			// migration had to leave unanchored. Returns the document untouched when
			// nothing is waiting, so there is nothing to guard here.
			const next = applyProbedDuration(doc, assetId, known);
			if (next !== doc) {
				void state.saveDocument(next, { history: false });
			}
		},
		[setSourceDuration],
	);

	const handleSeek = useCallback(
		(timeSec: number) => {
			setCurrentTime(timeSec);
			setSeekTarget({ timeSec, isSource: false, requestId: ++seekSeqRef.current });
		},
		[setCurrentTime],
	);

	const handleTimeChange = useCallback(
		(timeSec: number) => {
			setCurrentTime(timeSec);
		},
		[setCurrentTime],
	);

	// Same race as `useSequentialTimelineOps` — see that file's header. `insertClipAt` is a
	// read-modify-write of the whole document, so two adds in flight at once both read the
	// pre-insert doc and the second `saveDocument` clobbers the first, silently dropping a
	// clip. Two adds is one double-click on **Add to timeline** (the button has no pending
	// state) or two quick drags.
	//
	// It goes on that hook's queue rather than one of its own: a second queue serialises
	// adds against adds and nothing else, so an add still clobbers a trim landing at the
	// same moment. It can't route through `apply()` — inserting a clip is not an
	// AxcutTimelineOperation, it carries its own background duration probe — hence
	// `enqueue`, which is the same chain without that constraint.
	//
	// The append index is read INSIDE the chain for the same reason the doc is: off the
	// closure, `clips.length` stays frozen at the last render, so the second add lands
	// before the first instead of after it.
	const handleDropAsset = useCallback(
		(assetId: string) =>
			enqueueTimelineWrite(() => {
				const at = useProjectStore.getState().document?.timeline.clips.length ?? 0;
				return tl.insertClipAt(assetId, at);
			}).catch((error) => {
				toast.error(te("mediaStage.couldNotAddAsset"), {
					description: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}),
		[tl, te, enqueueTimelineWrite],
	);

	// Ref so the 'ended' listener below always sees the latest clips without tearing
	// down and re-registering the DOM listener on every document change. (The playhead
	// it also needs is read straight off the store at call time — see NativePlaybackSync
	// above for why nothing in this component subscribes to it.)
	const clipsForEndedRef = useRef(clips);
	clipsForEndedRef.current = clips;

	// ponytail: the transport bar (play/pause, prev/next, loop, fullscreen)
	// lives in the timeline header now, not under the preview canvas — it
	// needs the video element, so this state/these handlers moved up here
	// from Preview.tsx to be shared with Bottombar.
	useEffect(() => {
		const el = videoElement;
		if (!el) return;
		const onPlay = () => setPlaying(true);
		const onPause = () => setPlaying(false);
		// BUG corrigé : ce listener écoutait le même événement DOM natif 'ended' que le
		// onEnded interne de VirtualPreview.tsx, sans la moindre logique multi-clip — il
		// mettait TOUJOURS `playing` à false, y compris quand VirtualPreview venait
		// juste d'enchaîner sur le clip suivant (les deux listeners réagissent au même
		// événement, indépendamment). Deux endroits qui décident chacun de leur côté si
		// la lecture doit s'arrêter = exactement le genre de duplication qui casse selon
		// le chemin UX emprunté. On applique ici le même critère "y a-t-il un clip
		// suivant ?" déjà utilisé par handleNextClip juste au-dessus — seul point de
		// vérité pour "y a-t-il encore de la timeline à jouer".
		const onEnded = () => {
			const playhead = useProjectStore.getState().currentTimeSec;
			const hasNextClip = clipsForEndedRef.current.some((c) => c.timelineStartSec > playhead + 0.1);
			if (!hasNextClip) setPlaying(false);
		};
		el.addEventListener("play", onPlay);
		el.addEventListener("pause", onPause);
		el.addEventListener("ended", onEnded);
		setPlaying(!el.paused);
		return () => {
			el.removeEventListener("play", onPlay);
			el.removeEventListener("pause", onPause);
			el.removeEventListener("ended", onEnded);
		};
		// setPlaying is a stable Zustand action reference (never recreated), so listing it
		// here doesn't cause this effect to re-subscribe on every playhead tick.
	}, [videoElement, setPlaying]);

	const togglePlay = useCallback(() => {
		if (!videoElement) return;
		if (videoElement.paused) {
			// Same catch as VirtualPreview's: `play()` rejects on the autoplay policy
			// or when a new load interrupts it, and the store's `playing` flag is
			// driven by the element's own play/pause listeners above — so a rejection
			// leaves nothing to reconcile, it just must not escape unhandled.
			void videoElement.play().catch(() => {
				// swallow: rejection just means playback never started
			});
		} else {
			videoElement.pause();
		}
	}, [videoElement]);

	const handlePrevClip = useCallback(() => {
		if (clips.length === 0) return;
		// ponytail: navigate in virtual timeline space, not source-media time.
		const playhead = useProjectStore.getState().currentTimeSec;
		let prevStart = 0;
		for (let i = clips.length - 1; i >= 0; i--) {
			const c = clips[i];
			if (c.timelineEndSec <= playhead - 0.1) {
				prevStart = c.timelineStartSec;
				break;
			}
		}
		handleSeek(prevStart);
		handleTimeChange(prevStart);
	}, [clips, handleSeek, handleTimeChange]);

	const handleNextClip = useCallback(() => {
		if (clips.length === 0) return;
		const playhead = useProjectStore.getState().currentTimeSec;
		const next = clips.find((c) => c.timelineStartSec > playhead + 0.1);
		if (!next) return;
		handleSeek(next.timelineStartSec);
		handleTimeChange(next.timelineStartSec);
	}, [clips, handleSeek, handleTimeChange]);

	// "Transcribe now" from the transcript pane. The run itself belongs to the
	// transcription store (it owns the queue, the toasts and the failure
	// bookkeeping) — all the shell adds is bringing the transcript into view
	// once it lands.
	const handleTranscribe = useCallback(async () => {
		const before = useProjectStore.getState().document?.transcripts.length ?? 0;
		await requestTimelineTranscripts();
		if ((useProjectStore.getState().document?.transcripts.length ?? 0) > before) {
			setMode("edit");
			setFacet("transcript");
			setInspectorOpen(true);
		}
	}, [requestTimelineTranscripts]);

	const handleBrowseProject = useCallback(async () => {
		try {
			const result = await window.electronAPI?.loadProjectFile();
			if (!result?.success || !result.project) return;
			const raw = result.project as unknown;
			// A current project file already carries its own `schemaVersion` (v3/v4
			// AxcutDocument); an older legacy export is EditorProjectData and must be
			// migrated. Discriminate on the version field so a current document is
			// never fed to the legacy migrator (which reads `.media`/`.editor` and
			// would yield an empty doc).
			const isAxcutDocument =
				typeof raw === "object" && raw !== null && "schemaVersion" in raw && "timeline" in raw;
			const doc = isAxcutDocument
				? documentSchema.parse(migrateRawDocumentToCurrent(raw)) // disk-load: upgrade v3/v4 → v5, then validate
				: migrateProjectDataToAxcutDocument(raw as EditorProjectData);
			const saved = await nativeBridgeClient.aiEdition.save(doc);
			if (saved.success && saved.document) {
				await loadProject(doc.project.id);
				toast.success(isAxcutDocument ? "Project opened" : "Legacy project migrated and loaded");
			} else {
				toast.error(saved.error ?? "Failed to open project");
			}
		} catch (err) {
			toast.error("Could not load project", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [loadProject]);

	// ponytail: transcript-pane → timeline skip ranges. The right pane's
	// contentEditable region converts user Backspace/Delete into a new
	// trimRange (NOT a destructive word removal — the source text stays
	// intact, the word is just hidden by the skip overlay). Mirrors
	// axcut's `queueAddTrimRange` / `queueRemoveTrimRange` callbacks in
	// apps/web/src/App.tsx. The serialised save + inside-the-chain doc
	// read is owned by `useSequentialTimelineOps` above.
	const handleAddTrimRange = useCallback(
		(target: TrimTarget, startSec: number, endSec: number, reason: string) => {
			// `clipId` is what keeps the cut on the block the user typed in: with two clips
			// over the same media, an asset-only trim showed up on both (see `trimAppliesToClip`).
			void applyTimelineOp(
				{
					type: "add_trim_range",
					assetId: target.assetId,
					clipId: target.clipId,
					startSec,
					endSec,
					reason,
				},
				{ history: true },
			);
		},
		[applyTimelineOp],
	);

	const handleRemoveTrimRange = useCallback(
		(trimId: string) => {
			void applyTimelineOp(
				{
					type: "remove_trim_range",
					trimId,
					reason: "Restored from transcript pane.",
				},
				{ history: true },
			);
		},
		[applyTimelineOp],
	);

	const handleSelectProject = useCallback(
		async (id: string) => {
			try {
				await loadProject(id);
			} catch (err) {
				toast.error("Could not open project", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[loadProject],
	);

	// The dialog's starting point picks the tab the fresh project opens on:
	// "import" → Media (browse/drop assets), "screen-recording" → Rec (capture).
	const handleCreateProject = useCallback(
		async (title: string, startingPoint: StartingPoint) => {
			try {
				await createProject(title);
				setMode(startingPoint === "screen-recording" ? "rec" : "media");
			} catch (err) {
				toast.error("Could not create project", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[createProject],
	);

	// The only way to get rid of a project short of deleting its file by hand.
	// Media is left alone on purpose: a recording can back several projects, and
	// the dialog says so before it asks.
	const handleDeleteProject = useCallback(async (id: string) => {
		try {
			const result = await nativeBridgeClient.aiEdition.delete(id);
			if (!result.success) throw new Error(result.error ?? "Failed to delete project");
			setProjectSummaries((prev) => prev.filter((p) => p.id !== id));
			// Deleting the project that is open leaves the editor pointing at a file
			// that no longer exists — any save from there would recreate it.
			if (useProjectStore.getState().projectId === id) {
				useProjectStore.getState().clear();
			}
			toast.success("Project deleted");
		} catch (err) {
			toast.error("Could not delete project", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, []);

	const handleSave = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		if (await saveDocument(doc, { history: true })) toast.success("Project saved");
	}, [saveDocument]);

	// Native File menu (electron/main.ts) → v4 actions. The menu is shown via
	// Menu.setApplicationMenu and dispatches these IPC events; the old editor
	// listened to them, but the v4 shell replaced it, leaving the File items
	// dead. Wire them to the same handlers the top-bar buttons use so the
	// File/Edit/View menu bar works again (the View items still use Electron roles).
	// The v4 editor has no separate "Save As" location, so it maps to Save.
	//
	// Edit > Undo/Redo are here too, and not roles: on macOS the menu's Cmd+Z key
	// equivalent is matched by AppKit before the key event reaches the renderer, so
	// this subscription is the ONLY thing that makes Ctrl+Z work there. See
	// `electron/edit-menu.ts`.
	useEffect(() => {
		const api = window.electronAPI;
		if (!api) return;
		const unsubscribers = [
			api.onMenuNewProject?.(() => setNewProjectOpen(true)),
			api.onMenuLoadProject?.(() => setOpenProjectOpen(true)),
			api.onMenuSaveProject?.(() => void handleSave()),
			api.onMenuSaveProjectAs?.(() => void handleSave()),
			api.onMenuUndo?.(runUndo),
			api.onMenuRedo?.(runRedo),
		];
		return () => {
			for (const unsub of unsubscribers) unsub?.();
		};
	}, [handleSave, runUndo, runRedo]);

	const handleRenameProject = useCallback(
		async (title: string) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			if (title === doc.project.title) return;
			await saveDocument({ ...doc, project: { ...doc.project, title } }, { history: true });
		},
		[saveDocument],
	);

	const handleConfirmUnsaved = useCallback(
		(choice: UnsavedChoice) => {
			if (!unsavedPrompt) return;
			const { action, resolve } = unsavedPrompt;
			setUnsavedPrompt(null);
			// ponytail: resolve the action when the user picks save / discard.
			// The "continue with action" path is handled below in handleNewRecording /
			// the open-project branch. We resolve the promise once the work is done
			// (or cancelled).
			void (async () => {
				if (choice === "cancel") {
					resolve("cancel");
					return;
				}
				if (choice === "save") {
					const doc = useProjectStore.getState().document;
					// A failed save cancels the action that prompted this dialog. The store has
					// already said why -- which is what the bare `catch {}` here used to swallow,
					// leaving the window refusing to close with nothing on screen explaining it.
					if (doc && !(await saveDocument(doc, { history: true }))) {
						resolve("cancel");
						return;
					}
				}
				if (action === "record") {
					void window.electronAPI?.startNewRecording?.().catch((err) => {
						console.warn("[editor] failed to start a new recording:", err);
					});
				}
				resolve(choice);
			})();
		},
		[saveDocument, unsavedPrompt],
	);

	const handleNewRecording = useCallback(async () => {
		const choice = await promptUnsaved("record");
		if (choice !== "cancel") {
			void window.electronAPI?.startNewRecording?.().catch((err) => {
				console.warn("[editor] failed to start a new recording:", err);
			});
		}
	}, [promptUnsaved]);

	const handleExport = useCallback(() => {
		if (!hasAsset) {
			toast.info("Add a video to the project before exporting.");
			return;
		}
		setExportOpen(true);
	}, [hasAsset]);

	const handleOpenSettings = useCallback(() => {
		openShortcutsConfig();
	}, [openShortcutsConfig]);

	// Both hand off to the main process rather than rendering anything here: the About box and
	// the update dialogs are native message boxes owned by a window (see showMessageBox in
	// electron/main.ts), which is what keeps them from opening behind the always-on-top HUD.
	// Errors are swallowed on purpose — the main process is the one that reports them, and a
	// rejection here would only surface as an unhandled promise in the renderer.
	const handleShowAbout = useCallback(() => {
		void window.electronAPI?.showAbout?.().catch(() => {
			// Swallowed: see above.
		});
	}, []);

	const handleCheckForUpdates = useCallback(() => {
		void window.electronAPI?.checkForUpdates?.().catch(() => {
			// Swallowed: see above.
		});
	}, []);

	const pasteRegion = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		const { pasteClipboard } = await import("@/lib/ai-edition/store/regionClipboard");
		const snapshot = pasteClipboard();
		if (!snapshot) return;

		// A copied trim is just a length: recreate one of that length at the
		// playhead, through the same call the toolbar's cut button uses (which
		// resolves the timeline span down to the carrying clip's source time).
		if (snapshot.kind === "trim") {
			await tl.addTrim(snapshot.region.durationSec);
			toast.success("Region pasted");
			return;
		}

		const { anchorRegionsWithDerivedMs } = await import("@/lib/ai-edition/timeline/timelineMap");
		const { createId } = await import("@/lib/ai-edition/document/ids");

		// Land it at the playhead, keeping the copied length.
		const timeMs = Math.round(useProjectStore.getState().currentTimeSec * 1000);
		const src = snapshot.region as { startMs: number; endMs: number };
		const prefix = snapshot.kind === "annotation" ? "ann" : snapshot.kind;
		const pasted = {
			...snapshot.region,
			id: createId(prefix),
			startMs: timeMs,
			endMs: timeMs + (Number(src.endMs) - Number(src.startMs)),
		};
		// Anchor to the clip(s) it covers, exactly like every add* does. Pasting
		// used to store a bare startMs/endMs, so the region survived until the
		// first clip reorder or trim and then drifted off its content — see
		// technical-documentation/architecture/timeline-model.md.
		const anchored = anchorRegionsWithDerivedMs(
			[pasted as unknown as { id: string; startMs: number; endMs: number }],
			doc.timeline.clips,
			() => createId(prefix),
		);

		if (snapshot.kind === "zoom") {
			await saveDocument(
				{
					...doc,
					zoomRanges: [...doc.zoomRanges, ...anchored] as typeof doc.zoomRanges,
				},
				{ history: true },
			);
		} else if (snapshot.kind === "annotation") {
			await saveDocument(
				{
					...doc,
					annotations: [...doc.annotations, ...anchored] as typeof doc.annotations,
				},
				{ history: true },
			);
		} else {
			// speed and cameraFullscreen are both plain spans on legacyEditor.
			const key = snapshot.kind === "speed" ? "speedRegions" : "cameraFullscreenRegions";
			const legacy = (doc.legacyEditor as Record<string, unknown>) ?? {};
			const prev = (legacy[key] as unknown[]) ?? [];
			await saveDocument(
				{
					...doc,
					legacyEditor: { ...legacy, [key]: [...prev, ...anchored] },
				},
				{ history: true },
			);
		}
		toast.success("Region pasted");
		// `tl` belongs here now that the trim branch calls tl.addTrim: useTimeline
		// returns a fresh object each render, so memoizing on saveDocument alone
		// would paste through a callback holding a stale document.
	}, [saveDocument, tl]);

	// Copy the SELECTED pill. Reads the same arrays the lanes render, so what gets
	// copied is what the user is looking at — the old version dug into the raw
	// document with a ternary chain that mapped a trim to "zoom" and sent
	// cameraFullscreen down the speed branch, where neither could ever be found.
	const handleCopyRegion = useCallback(async () => {
		const sel = tl.selection;
		if (!sel) return;
		const { copyRegion } = await import("@/lib/ai-edition/store/regionClipboard");

		// A trim is stored in SOURCE time against a clip anchor, so there is no
		// row to clone — but there is nothing to clone either: what the user means
		// by copying a cut is its LENGTH. Paste then makes a fresh trim of that
		// length at the playhead, which is the same deal every other kind gets
		// (properties kept, position taken from the playhead).
		if (sel.kind === "trim") {
			const { coalescedTrimGroups } = await import("@/lib/ai-edition/timeline/trim-mapping");
			const group = coalescedTrimGroups(tl.trimRanges, tl.clips).find((g) =>
				g.ids.includes(sel.id),
			);
			if (!group) return;
			copyRegion({ kind: "trim", region: { durationSec: group.end - group.start } });
			setCopiedClipId(null);
			toast.success("Region copied");
			return;
		}

		const source =
			sel.kind === "zoom"
				? tl.zoomRegions
				: sel.kind === "annotation"
					? tl.annotationRegions
					: sel.kind === "speed"
						? tl.speedRegions
						: tl.cameraFullscreenRegions;
		const region = (source as Array<{ id: string }>).find((r) => r.id === sel.id);
		if (!region) return;
		copyRegion({ kind: sel.kind, region: region as unknown as Record<string, unknown> });
		// One clipboard wins at a time: a copied pill retires the copied clip.
		setCopiedClipId(null);
		toast.success("Region copied");
	}, [tl]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
			if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
			// A modal owns the screen. Its own controls are buttons, not text fields, so the two
			// guards above let every editor shortcut through underneath it: Delete destroyed the
			// selected region behind the backdrop, Ctrl+O stacked a second `aria-modal` dialog on
			// top, and `?` stacked the shortcuts dialog. One question about the screen, not one
			// flag per dialog — the flag version knew only about the two dialogs whose open state
			// happened to live in a context, so Z/T/C kept adding regions under Export (#434).
			if (isModalOpen()) return;
			const ctrl = e.ctrlKey || e.metaKey;
			if (ctrl && e.key === "s") {
				e.preventDefault();
				void handleSave();
				return;
			}
			if (ctrl && e.key === "n") {
				e.preventDefault();
				void (async () => {
					const choice = await promptUnsaved("new");
					if (choice === "cancel") return;
					if (choice === "save") {
						const doc = useProjectStore.getState().document;
						// Stay put if the save did not land -- the store has already said why.
						if (doc && !(await saveDocument(doc, { history: true }))) return;
					}
					setNewProjectOpen(true);
				})();
				return;
			}
			if (ctrl && e.key === "o") {
				e.preventDefault();
				void (async () => {
					const choice = await promptUnsaved("open");
					if (choice === "cancel") return;
					if (choice === "save") {
						const doc = useProjectStore.getState().document;
						// Stay put if the save did not land -- the store has already said why.
						if (doc && !(await saveDocument(doc, { history: true }))) return;
					}
					setOpenProjectOpen(true);
				})();
				return;
			}
			if (!hasProject && e.key !== "?") return;
			if (ctrl && (e.key === "z" || e.key.toLowerCase() === "y")) return;
			if (e.key === "?" || (e.shiftKey && e.key === "/")) {
				e.preventDefault();
				openShortcutsConfig();
				return;
			}

			const deleteSelection = () => {
				// F2.7 — a shift-click multi-selection deletes as one batch (one
				// undo snapshot); a single selection keeps the original path.
				if (tl.multiSelection.length > 1) {
					void tl.removeRegions(tl.multiSelection);
					return;
				}
				if (tl.selection) {
					void tl.removeRegion(tl.selection.kind, tl.selection.id);
				}
			};

			// F2.9 — configurable actions read the user's saved bindings instead
			// of hardcoded keys, so rebinding in the shortcuts dialog actually
			// changes runtime behavior.
			if (matchesShortcut(e, shortcuts.copySelected, isMac)) {
				// A pill and a clip can no longer both be selected (see selectRegion /
				// selectClip), so this reads the one the user actually picked instead
				// of preferring clips whatever was clicked last.
				if (tl.selection) {
					e.preventDefault();
					void handleCopyRegion();
					return;
				}
				if (tl.clipSelection) {
					e.preventDefault();
					setCopiedClipId(tl.clipSelection);
					// A copied clip retires the copied pill — see clearRegionClipboard.
					void import("@/lib/ai-edition/store/regionClipboard").then((m) =>
						m.clearRegionClipboard(),
					);
					return;
				}
			}
			if (ctrl && e.key.toLowerCase() === "x") {
				// F2.8 — cut: remember the region in the clipboard, then remove it.
				// Trims included now that copying one means copying its length.
				if (tl.selection) {
					e.preventDefault();
					const cut = tl.selection;
					void handleCopyRegion().then(() => tl.removeRegion(cut.kind, cut.id));
					return;
				}
			}
			if (matchesShortcut(e, shortcuts.paste, isMac)) {
				e.preventDefault();
				// Paste what was COPIED. It used to fall back to `tl.clipSelection`,
				// so a clip merely being selected hijacked the paste — and since
				// `copiedClipId` was never cleared, one Ctrl+C on a clip turned every
				// later Ctrl+V into a clip duplication for the rest of the session,
				// whatever the user copied afterwards.
				if (copiedClipId) {
					void tl.duplicateClip(copiedClipId);
					return;
				}
				void pasteRegion();
				return;
			}
			if (matchesShortcut(e, shortcuts.playPause, isMac)) {
				e.preventDefault();
				togglePlay();
				return;
			}
			if (matchesShortcut(e, shortcuts.deleteSelected, isMac)) {
				e.preventDefault();
				deleteSelection();
				return;
			}
			if (e.key === "Delete" || e.key === "Backspace") {
				e.preventDefault();
				deleteSelection();
				return;
			}
			// Same size on screen as the toolbar buttons produce — these shortcuts are
			// what the empty lanes advertise ("Press Z to add zoom"), so they are the
			// way most regions get created. Left on the flat default they came out
			// under two pixels on a 30-minute recording, hidden behind the playhead
			// they were created at. See timeline/newRegionDuration.
			if (matchesShortcut(e, shortcuts.addZoom, isMac)) {
				e.preventDefault();
				void tl.addZoom(newRegionDurationSec());
				return;
			}
			if (matchesShortcut(e, shortcuts.addTrim, isMac)) {
				e.preventDefault();
				void tl.addTrim(newRegionDurationSec());
				return;
			}
			if (matchesShortcut(e, shortcuts.addAnnotation, isMac)) {
				e.preventDefault();
				void tl.addAnnotation(newRegionDurationSec());
				return;
			}
			if (matchesShortcut(e, shortcuts.addSpeed, isMac)) {
				e.preventDefault();
				void tl.addSpeed(newRegionDurationSec());
				return;
			}
			if (matchesShortcut(e, shortcuts.addCameraFullscreen, isMac)) {
				e.preventDefault();
				void tl.addCameraFullscreen(newRegionDurationSec());
				return;
			}

			// Fixed (non-configurable) shortcuts advertised in the shortcuts dialog.
			if (e.key === "Tab") {
				const annotations = [...tl.annotationRegions].sort((a, b) => a.startMs - b.startMs);
				if (annotations.length > 0) {
					e.preventDefault();
					const direction = e.shiftKey ? -1 : 1;
					const currentId = tl.selection?.kind === "annotation" ? tl.selection.id : null;
					const currentIndex = currentId ? annotations.findIndex((a) => a.id === currentId) : -1;
					const nextIndex =
						currentIndex === -1
							? direction === 1
								? 0
								: annotations.length - 1
							: (currentIndex + direction + annotations.length) % annotations.length;
					tl.selectRegion("annotation", annotations[nextIndex].id);
				}
				return;
			}
			if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
				e.preventDefault();
				const frameStepSec = 1 / 60;
				const direction = e.key === "ArrowLeft" ? -1 : 1;
				const playhead = useProjectStore.getState().currentTimeSec;
				handleSeek(Math.max(0, playhead + direction * frameStepSec));
				return;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [
		hasProject,
		handleCopyRegion,
		handleSave,
		pasteRegion,
		tl,
		promptUnsaved,
		saveDocument,
		copiedClipId,
		openShortcutsConfig,
		shortcuts,
		isMac,
		togglePlay,
		handleSeek,
	]);

	const showTimeline = mode !== "rec";
	const timelineRow = mode === "media" ? "188px" : `${timelineHeightPx}px`;
	const bodyColumns = mode === "edit" && chatOpen ? `${chatWidthPx}px 1fr` : "1fr";

	// Drag the chat/stage divider (col-resize) or the timeline's top edge
	// (row-resize) to resize. Pointer-driven like V4Timeline's pill/nav/clip
	// drags — pointerdown arms a window-level pointermove/pointerup pair, no
	// drag library. Persisted to localStorage (a UI layout preference, not
	// project content, so it doesn't belong in the document/useEditorSettings
	// round-trip).
	const startChatResize = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			const startX = e.clientX;
			const startWidth = chatWidthPx;
			let latest = startWidth;
			const move = (ev: PointerEvent) => {
				latest = Math.min(560, Math.max(280, startWidth + (ev.clientX - startX)));
				setChatWidthPx(latest);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				localStorage.setItem("os-editor-chat-width", String(latest));
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[chatWidthPx],
	);

	const startTimelineResize = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			const startY = e.clientY;
			const startHeight = timelineHeightPx;
			let latest = startHeight;
			const move = (ev: PointerEvent) => {
				// Dragging the handle up (negative clientY delta) enlarges the
				// timeline, since it sits below the handle.
				latest = Math.min(480, Math.max(160, startHeight - (ev.clientY - startY)));
				setTimelineHeightPx(latest);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				localStorage.setItem("os-editor-timeline-height", String(latest));
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[timelineHeightPx],
	);

	const transcriptProps = {
		clips,
		transcripts: document?.transcripts ?? [],
		assets: document?.assets ?? [],
		trimRanges: document?.timeline?.trimRanges ?? [],
		busyAssetIds,
		onSeek: handleSeek,
		onAddTrimRange: handleAddTrimRange,
		onRemoveTrimRange: handleRemoveTrimRange,
		onTranscribe: handleTranscribe,
		canTranscribe: hasAsset,
		isTranscribing: transcriptGate.state === "pending",
		blocked:
			transcriptGate.state === "blocked" && transcriptGate.reason
				? { reason: transcriptGate.reason, message: transcriptGate.message }
				: undefined,
	};

	return (
		<div
			className={v4.app}
			style={{ gridTemplateRows: `58px 1fr ${showTimeline ? timelineRow : "0px"}` }}
		>
			<NativePlaybackSync visibleClips={visibleClips} clips={clips} />
			<EditorTopBar
				mode={mode}
				onModeChange={setMode}
				projectTitle={project?.title ?? null}
				dirty={dirty}
				canExport={hasAsset}
				chatOpen={chatOpen}
				actions={{
					openProject: () => setOpenProjectOpen(true),
					newProject: () => setNewProjectOpen(true),
					save: () => void handleSave(),
					export: handleExport,
					openSettings: handleOpenSettings,
					renameProject: handleRenameProject,
					toggleChat: () => setChatOpen((v) => !v),
					openProviderSettings: () => openDialog("providers"),
					showAbout: handleShowAbout,
					checkForUpdates: handleCheckForUpdates,
				}}
			/>

			<div className={v4.body} style={{ gridTemplateColumns: bodyColumns }}>
				{mode === "edit" && chatOpen ? (
					<>
						<aside className={v4.agent} aria-label={te("shell.aiEditor")}>
							<ChatStripPanel />
						</aside>
						<div
							className={v4.chatResizeHandle}
							style={{ left: chatWidthPx }}
							role="separator"
							aria-orientation="vertical"
							aria-label={te("shell.resizeChatPanel")}
							onPointerDown={startChatResize}
						/>
					</>
				) : null}

				<section className={v4.stage} aria-label={te("shell.previewStage")}>
					{mode === "edit" ? (
						<>
							<div
								style={{
									position: "absolute",
									inset: 0,
									// Right padding reserves just enough room for the floating
									// inspector (facet rail ~74px, or the full panel ~320px when
									// open) so the video resizes into the remaining space instead
									// of sitting underneath it. Nothing floats over the other
									// edges — playback transport lives in the timeline header
									// (TransportBar, rendered from V4Timeline) instead of
									// overlaying the preview — so top/bottom/left only need a
									// thin margin off the stage's rounded corners, not a large
									// fixed chunk that dwarfs the card on smaller windows.
									//
									// Native compositor: the D3D overlay is an opaque, always-on-top
									// design lets the translucent panel float over the video, but the
									// preview is now a plain in-DOM <canvas> (no OS window/airspace
									// issue) — still reserve the inspector's real footprint (right:20 +
									// rail:50 + gap:10 + panel:300 ≈ 380, +a small gap) so it doesn't
									// draw its own translucent panel flush against the canvas edge.
									padding: `16px ${inspectorOpen ? 400 : 74}px 16px 16px`,
									boxSizing: "border-box",
								}}
							>
								<Preview
									hasProject={hasProject}
									hasAsset={hasAsset}
									videoSources={videoSources}
									clips={clips}
									zoomRegions={tl.zoomRegions}
									speedRegions={tl.speedRegions}
									cameraFullscreenRegions={tl.cameraFullscreenRegions}
									trimRanges={tl.trimRanges}
									selectedZoomRegionId={tl.selection?.kind === "zoom" ? tl.selection.id : null}
									onZoomFocusChange={tl.updateZoomFocusLive}
									onZoomFocusCommit={() => void tl.commitZoomFocus()}
									annotationRegions={tl.annotationRegions}
									selectedAnnotationId={
										tl.selection?.kind === "annotation" ? tl.selection.id : null
									}
									onSelectAnnotation={(id) => tl.selectRegion("annotation", id)}
									onAnnotationPositionChange={(id, position) => {
										// Live seulement : appelé à chaque mouvement de souris pour que le
										// compositeur natif suive le geste. L'écriture disque se fait une fois,
										// au relâchement, via `onAnnotationCommit`.
										tl.updateAnnotationLive(id, { position });
									}}
									onAnnotationSizeChange={(id, size) => {
										tl.updateAnnotationLive(id, { size });
									}}
									onAnnotationBlurDataChange={(id, blurData) =>
										tl.updateAnnotationLive(id, { blurData })
									}
									onAnnotationCommit={() => void tl.commitAnnotationChange()}
									seekTarget={seekTarget}
									onTimeChange={handleTimeChange}
									onSeek={handleSeek}
									onLoadedMetadata={handleLoadedMetadata}
									onVideoElement={setVideoElement}
									playing={playing}
								/>
							</div>
							<FloatingInspector
								facet={facet}
								open={inspectorOpen}
								tl={tl}
								onFacetChange={(f) => {
									setFacet(f);
									setInspectorOpen(true);
								}}
								onToggleOpen={() => setInspectorOpen((v) => !v)}
								clips={tl.clips}
								onEditClip={setEditClipTarget}
								transcriptProps={transcriptProps}
							/>
						</>
					) : mode === "media" ? (
						<MediaStage onAddToTimeline={handleDropAsset} />
					) : (
						<RecStage
							onStartRecording={() => void handleNewRecording()}
							onClose={() => setMode("edit")}
						/>
					)}
				</section>
			</div>

			{/* Timeline footer (hidden in Rec mode) — rebuilt from the v4 design. */}
			{showTimeline ? (
				<div
					style={{
						position: "relative",
						gridRow: 3,
						minHeight: 0,
						background: "var(--surface)",
						borderTop: "1px solid var(--border)",
					}}
				>
					{mode !== "media" ? (
						<div
							className={v4.timelineResizeHandle}
							role="separator"
							aria-orientation="horizontal"
							aria-label={te("shell.resizeTimeline")}
							onPointerDown={startTimelineResize}
						/>
					) : null}
					<V4Timeline
						tl={tl}
						setCurrentTime={handleSeek}
						variant={mode === "media" ? "media" : "edit"}
						onDropAsset={handleDropAsset}
						videoSources={videoSources}
						playing={playing}
						onTogglePlay={togglePlay}
						onPrevClip={handlePrevClip}
						onNextClip={handleNextClip}
						onEditClip={setEditClipTarget}
					/>
				</div>
			) : null}

			{/* Modals */}
			<OpenProjectModal
				open={openProjectOpen}
				onClose={() => setOpenProjectOpen(false)}
				projects={projectSummaries}
				activeProjectId={projectId}
				onSelect={handleSelectProject}
				onDelete={handleDeleteProject}
				onBrowse={handleBrowseProject}
			/>
			<NewProjectModal
				open={newProjectOpen}
				onClose={() => setNewProjectOpen(false)}
				onCreate={handleCreateProject}
			/>
			<EditClipModal
				open={editClipTarget !== null}
				onClose={() => setEditClipTarget(null)}
				clip={editClipTarget}
				assetMeta={
					editClipTarget
						? {
								label:
									document?.assets.find((a) => a.id === editClipTarget.assetId)?.label ??
									editClipTarget.assetId,
								durationSec: document?.assets.find((a) => a.id === editClipTarget.assetId)
									?.durationSec,
							}
						: null
				}
				videoSources={videoSources}
				onApply={(sStart, sEnd, cropRegion) => {
					if (!editClipTarget) return;
					const clipId = editClipTarget.id;
					// One user action, one document, one save. This used to be two calls —
					// `updateClipSourceRange` then `updateClipCrop` — each building its next
					// document from the same pre-Apply one, so the second write clobbered the
					// first and one of the two edits vanished silently (#355). It goes on the
					// shared write queue for the same reason every other timeline edit does:
					// so it can't clobber, or be clobbered by, a save already in flight.
					void enqueueTimelineWrite(() => tl.applyClipEdit(clipId, sStart, sEnd, cropRegion));
					setEditClipTarget(null);
				}}
			/>
			<UnsavedChangesModal
				open={unsavedPrompt !== null}
				onClose={() => {
					unsavedPrompt?.resolve("cancel");
					setUnsavedPrompt(null);
				}}
				action={unsavedPrompt?.action ?? "new"}
				onChoose={handleConfirmUnsaved}
			/>
			<ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} document={document} />
		</div>
	);
}
