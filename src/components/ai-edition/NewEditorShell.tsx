import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { EditorProjectData } from "@/components/video-editor/projectPersistence";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import { replaceTimeline as replaceTimelineOp } from "@/lib/ai-edition/document/timeline";
import { transcribeAsset } from "@/lib/ai-edition/document/transcribe";
import { type AxcutClip, documentSchema } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useUndoRedoShortcuts } from "@/lib/ai-edition/store/undo";
import { PLACEHOLDER_DURATION_SEC, useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { matchesShortcut } from "@/lib/shortcuts";
import { nativeBridgeClient } from "@/native";
import type { AiEditionProjectSummary } from "@/native/contracts";
import { useNativePlaybackSync } from "@/native/useNativePlaybackSync";
import { ExportDialog } from "./ExportDialog";
import { LeftPanel } from "./LeftPanel";
import {
	AutoCaptionsModal,
	EditClipModal,
	NewProjectModal,
	OpenProjectModal,
	UnsavedChangesModal,
	type UnsavedChoice,
} from "./Modals";
import { Preview } from "./Preview";
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

export function NewEditorShell() {
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const currentTimeSec = useProjectStore((s) => s.currentTimeSec);
	const dirty = useProjectStore((s) => s.dirty);
	const createProject = useProjectStore((s) => s.createProject);
	const addAsset = useProjectStore((s) => s.addAsset);
	const setTranscript = useProjectStore((s) => s.setTranscript);
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
	const [isTranscribing, setIsTranscribing] = useState(false);
	const [assetStatuses, setAssetStatuses] = useState<
		Record<string, "pending" | "running" | "failed">
	>({});
	const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
	const [loop, setLoop] = useState(false);
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
	const tl = useTimeline();
	useUndoRedoShortcuts(() => {
		// ponytail: placeholder, wire when undo stack merges with history
	});
	const [captionsOpen, setCaptionsOpen] = useState(false);
	const [captionsMinW, setCaptionsMinW] = useState(2);
	const [captionsMaxW, setCaptionsMaxW] = useState(7);
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
	// don't race each other's IPC save and overwrite one another in the
	// store. Each new save chains off the previous one, so the store is
	// always updated in the order the user issued the trims.
	const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

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
	// Mirror transport/playhead onto the native compositor view (no-op if inactive). The hook
	// maps absolute timeline time into the active clip's trimmed source-media clock.
	useNativePlaybackSync(playing, currentTimeSec, clips);
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
				const result = await window.electronAPI.getCurrentRecordingSession();
				if (!result.success || !result.session?.screenVideoPath) {
					// ponytail: no active recording — try to restore the user's
					// most recent project. The browser-shim's listProjects
					// returns the seeded `browser-shim-projects` entries, so
					// e2e tests can land directly in a populated editor; for
					// real Electron users this is the expected "open last
					// project on launch" UX.
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
					return;
				}
				const screenPath = result.session.screenVideoPath;
				const label = screenPath.split(/[\\/]/).pop() || "Recording";
				await createProject(`Recording ${new Date().toLocaleString()}`);
				await addAsset(screenPath, label);
				// ponytail: MediaRecorder WebMs ship with duration = NaN until
				// fix-webm-duration patches the EBML header; until that flows
				// through the asset, drop a default 60s clip into the timeline
				// so the editor isn't stuck on "No clips yet" the moment the
				// user lands in the project. Real duration overwrites this
				// when handleLoadedMetadata fires with a finite value.
				const doc = useProjectStore.getState().document;
				if (doc && doc.timeline.clips.length === 0 && doc.assets.length > 0) {
					await useProjectStore
						.getState()
						.replaceTimeline([{ startSec: 0, endSec: 60 }], "Auto-imported recording");
				}
				toast.success("Recording added to a new project");
			} catch (err) {
				toast.error("Could not auto-create project from recording", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		})();
	}, [addAsset, createProject, loadProject]);

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
			if (doc) {
				try {
					await saveDocument(doc);
					return true;
				} catch {
					toast.error("Failed to save before closing");
					return false;
				}
			}
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
				void state.saveDocument(next);
				return;
			}
			// Only correct clips belonging to the asset that actually fired this
			// event, and only while they still sit at the pre-probe 0..60s
			// placeholder — never a clip the user has since trimmed. Patching by
			// array index (the previous behavior) clobbered clip[0]'s duration
			// whenever a *different* asset's video element loaded, e.g. right
			// after dropping a second clip onto the timeline.
			const isPlaceholder = (c: (typeof doc.timeline.clips)[number]) =>
				c.assetId === assetId &&
				c.sourceStartSec === 0 &&
				Math.abs((c.sourceEndSec ?? 0) - PLACEHOLDER_DURATION_SEC) < 0.01;
			if (Math.abs(known - PLACEHOLDER_DURATION_SEC) < 0.01) return;
			if (!doc.timeline.clips.some(isPlaceholder)) return;

			let shiftSec = 0;
			const nextClips = doc.timeline.clips.map((c) => {
				const shifted = { ...c, timelineStartSec: c.timelineStartSec + shiftSec };
				if (!isPlaceholder(c)) {
					shifted.timelineEndSec = c.timelineEndSec + shiftSec;
					return shifted;
				}
				const delta = known - PLACEHOLDER_DURATION_SEC;
				shifted.sourceEndSec = known;
				shifted.timelineEndSec = shifted.timelineStartSec + known;
				shiftSec += delta;
				return shifted;
			});
			void state.saveDocument({
				...doc,
				timeline: { ...doc.timeline, clips: nextClips },
			});
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

	// Refs so the 'ended' listener below always sees the latest clips/playhead without
	// tearing down and re-registering the DOM listener on every rAF-driven currentTimeSec
	// update (which would happen every tick during playback if they were plain deps).
	const clipsForEndedRef = useRef(clips);
	clipsForEndedRef.current = clips;
	const currentTimeSecRef = useRef(currentTimeSec);
	currentTimeSecRef.current = currentTimeSec;

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
			const hasNextClip = clipsForEndedRef.current.some(
				(c) => c.timelineStartSec > currentTimeSecRef.current + 0.1,
			);
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
			void videoElement.play();
		} else {
			videoElement.pause();
		}
	}, [videoElement]);

	const handlePrevClip = useCallback(() => {
		if (clips.length === 0) return;
		// ponytail: navigate in virtual timeline space, not source-media time.
		let prevStart = 0;
		for (let i = clips.length - 1; i >= 0; i--) {
			const c = clips[i];
			if (c.timelineEndSec <= currentTimeSec - 0.1) {
				prevStart = c.timelineStartSec;
				break;
			}
		}
		handleSeek(prevStart);
		handleTimeChange(prevStart);
	}, [clips, currentTimeSec, handleSeek, handleTimeChange]);

	const handleNextClip = useCallback(() => {
		if (clips.length === 0) return;
		const next = clips.find((c) => c.timelineStartSec > currentTimeSec + 0.1);
		if (!next) return;
		handleSeek(next.timelineStartSec);
		handleTimeChange(next.timelineStartSec);
	}, [clips, currentTimeSec, handleSeek, handleTimeChange]);

	const handleToggleLoop = useCallback(() => {
		setLoop((v) => {
			const next = !v;
			if (videoElement) videoElement.loop = next;
			return next;
		});
	}, [videoElement]);

	const handleExpand = useCallback(() => {
		const el = videoElement?.parentElement;
		if (!el) return;
		if (globalThis.document.fullscreenElement) {
			void globalThis.document.exitFullscreen();
		} else {
			void el.requestFullscreen?.();
		}
	}, [videoElement]);

	const handleTranscribe = useCallback(async () => {
		if (!document || !document.project.primaryAssetId) return;
		const assetId = document.project.primaryAssetId;
		setIsTranscribing(true);
		setAssetStatuses((prev) => ({ ...prev, [assetId]: "running" }));
		try {
			const transcript = await transcribeAsset(document, assetId, {
				onStatus: (s) => toast.loading(`Transcribing: ${s}`, { id: "transcribe" }),
			});
			toast.dismiss("transcribe");
			await setTranscript(transcript);
			setMode("edit");
			setFacet("transcript");
			setInspectorOpen(true);
			toast.success("Transcript ready");
			setAssetStatuses((prev) => {
				const next = { ...prev };
				delete next[assetId];
				return next;
			});
		} catch (err) {
			toast.dismiss("transcribe");
			toast.error("Transcription failed", {
				description: err instanceof Error ? err.message : String(err),
			});
			setAssetStatuses((prev) => ({ ...prev, [assetId]: "failed" }));
		} finally {
			setIsTranscribing(false);
		}
	}, [document, setTranscript]);

	// Per-asset regenerate fired from the Source Transcript modal. Same
	// pipeline as `handleTranscribe` but takes any assetId + a target
	// language — `transcribeAsset` already accepts `language` and `setTranscript`
	// replaces the matching entry in `doc.transcripts`.
	const handleRegenerateAsset = useCallback(
		async (assetId: string, language: string) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			setAssetStatuses((prev) => ({ ...prev, [assetId]: "running" }));
			toast.loading(`Regenerating: ${language}`, { id: `regen-${assetId}` });
			try {
				const transcript = await transcribeAsset(doc, assetId, {
					language,
					onStatus: (s) => toast.loading(`Regenerating: ${s}`, { id: `regen-${assetId}` }),
				});
				await setTranscript(transcript);
				setAssetStatuses((prev) => {
					const next = { ...prev };
					delete next[assetId];
					return next;
				});
				toast.dismiss(`regen-${assetId}`);
				toast.success("Transcript regenerated");
			} catch (err) {
				toast.dismiss(`regen-${assetId}`);
				toast.error("Transcription failed", {
					description: err instanceof Error ? err.message : String(err),
				});
				setAssetStatuses((prev) => ({ ...prev, [assetId]: "failed" }));
			}
		},
		[setTranscript],
	);

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
				? documentSchema.parse(raw) // validates + upgrades v3 → v4
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
	// apps/web/src/App.tsx.
	const handleAddTrimRange = useCallback(
		(assetId: string, startSec: number, endSec: number, reason: string) => {
			// ponytail: read the latest document from the store, not the
			// closure. The closure captures the document at render time; if
			// the user fires two rapid Backspaces before React re-renders,
			// the second call would see the same stale document and add the
			// second skip to a base that already has the first skip's
			// pending-state. Then the two saveDocument calls race and the
			// last one to call set() wins. Reading from getState() always
			// returns the latest committed value.
			const doc = useProjectStore.getState().document ?? document;
			if (!doc) return;
			// ponytail: serialise via saveQueueRef so two rapid trims
			// can't race each other's IPC save and overwrite one another.
			const queued = saveQueueRef.current
				.then(() => import("@/lib/ai-edition/document/operations"))
				.then(({ applyTimelineOperation }) =>
					applyTimelineOperation(doc, {
						type: "add_trim_range",
						assetId,
						startSec,
						endSec,
						reason,
					}),
				)
				.then((next) => saveDocument(next.document));
			saveQueueRef.current = queued.then(
				() => undefined,
				() => undefined,
			);
			return queued;
		},
		[document, saveDocument],
	);

	const handleRemoveTrimRange = useCallback(
		(trimId: string) => {
			const doc = useProjectStore.getState().document ?? document;
			if (!doc) return;
			const queued = saveQueueRef.current
				.then(() => import("@/lib/ai-edition/document/operations"))
				.then(({ applyTimelineOperation }) =>
					applyTimelineOperation(doc, {
						type: "remove_trim_range",
						trimId,
						reason: "Restored from transcript pane.",
					}),
				)
				.then((next) => saveDocument(next.document));
			saveQueueRef.current = queued.then(
				() => undefined,
				() => undefined,
			);
			return queued;
		},
		[document, saveDocument],
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

	const handleCreateProject = useCallback(
		async (title: string) => {
			try {
				await createProject(title);
			} catch (err) {
				toast.error("Could not create project", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[createProject],
	);

	const handleSave = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		try {
			await saveDocument(doc);
			toast.success("Project saved");
		} catch (err) {
			toast.error("Save failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [saveDocument]);

	// Native File menu (electron/main.ts) → v4 actions. The menu is shown via
	// Menu.setApplicationMenu and dispatches these IPC events; the old editor
	// listened to them, but the v4 shell replaced it, leaving the File items
	// dead. Wire them to the same handlers the top-bar buttons use so the
	// File/Edit/View menu bar works again (Edit/View items use Electron roles).
	// The v4 editor has no separate "Save As" location, so it maps to Save.
	useEffect(() => {
		const api = window.electronAPI;
		if (!api) return;
		const unsubscribers = [
			api.onMenuNewProject?.(() => setNewProjectOpen(true)),
			api.onMenuLoadProject?.(() => setOpenProjectOpen(true)),
			api.onMenuSaveProject?.(() => void handleSave()),
			api.onMenuSaveProjectAs?.(() => void handleSave()),
		];
		return () => {
			for (const unsub of unsubscribers) unsub?.();
		};
	}, [handleSave]);

	const handleRenameProject = useCallback(
		async (title: string) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			if (title === doc.project.title) return;
			try {
				await saveDocument({ ...doc, project: { ...doc.project, title } });
			} catch (err) {
				toast.error("Rename failed", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
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
					if (doc) {
						try {
							await saveDocument(doc);
						} catch {
							resolve("cancel");
							return;
						}
					}
				}
				if (action === "record") {
					void window.electronAPI?.startNewRecording?.();
				}
				resolve(choice);
			})();
		},
		[saveDocument, unsavedPrompt],
	);

	const handleNewRecording = useCallback(async () => {
		const choice = await promptUnsaved("record");
		if (choice !== "cancel") {
			void window.electronAPI?.startNewRecording?.();
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

	const pasteRegion = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		const { pasteClipboard } = await import("@/lib/ai-edition/store/regionClipboard");
		const clip = pasteClipboard();
		if (!clip) return;
		const timeMs = Math.round(currentTimeSec * 1000);
		const region = { ...clip.region, id: crypto.randomUUID() };
		if (clip.kind === "zoom") {
			const zoom = region as unknown as (typeof doc.zoomRanges)[number];
			const duration = zoom.endMs - zoom.startMs;
			zoom.startMs = timeMs;
			zoom.endMs = timeMs + duration;
			await saveDocument({ ...doc, zoomRanges: [...doc.zoomRanges, zoom] });
		} else if (clip.kind === "annotation") {
			const annotation = region as unknown as (typeof doc.annotations)[number];
			const duration = annotation.endMs - annotation.startMs;
			annotation.startMs = timeMs;
			annotation.endMs = timeMs + duration;
			await saveDocument({ ...doc, annotations: [...doc.annotations, annotation] });
		} else if (clip.kind === "speed") {
			const speedRegions =
				(doc.legacyEditor as { speedRegions?: Array<Record<string, unknown>> })?.speedRegions ?? [];
			const speed = region as unknown as (typeof speedRegions)[number];
			const duration = Number(speed.endMs) - Number(speed.startMs);
			speed.startMs = timeMs;
			speed.endMs = timeMs + duration;
			await saveDocument({
				...doc,
				legacyEditor: {
					...doc.legacyEditor,
					speedRegions: [...speedRegions, speed],
				},
			});
		}
		toast.success("Region pasted");
	}, [currentTimeSec, saveDocument]);

	const handleCopyRegion = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc || !tl.selection) return;
		const { copyRegion } = await import("@/lib/ai-edition/store/regionClipboard");
		const region =
			tl.selection.kind === "zoom"
				? doc.zoomRanges.find((z) => z.id === tl.selection?.id)
				: tl.selection.kind === "annotation"
					? (doc.annotations as unknown[]).find(
							(a) => (a as { id: string }).id === tl.selection?.id,
						)
					: ((doc.legacyEditor as { speedRegions?: unknown[] } | null)?.speedRegions ?? []).find(
							(s) => (s as { id: string }).id === tl.selection?.id,
						);
		if (region) {
			copyRegion({
				kind: tl.selection.kind === "trim" ? "zoom" : tl.selection.kind,
				region: region as Record<string, unknown>,
			});
			toast.success("Region copied");
		}
	}, [tl]);

	const handleCaptions = useCallback(() => {
		if (!document?.project.primaryAssetId) {
			toast.info("Add a video to the project before generating captions.");
			return;
		}
		setCaptionsOpen(true);
	}, [document]);

	const handleGenerateCaptions = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		const assetId = doc.project.primaryAssetId;
		if (!assetId) {
			toast.error("Add a video to the project before generating captions.");
			return;
		}

		setCaptionsOpen(false);
		try {
			let transcript = doc.transcript;
			if (!transcript) {
				toast.loading("Transcribing first…", { id: "captions-gen" });
				setAssetStatuses((prev) => ({ ...prev, [assetId]: "running" }));
				try {
					transcript = await transcribeAsset(doc, assetId, {
						onStatus: (s) => toast.loading(`Transcribing: ${s}`, { id: "captions-gen" }),
					});
					toast.dismiss("captions-gen");
					await setTranscript(transcript);
					setAssetStatuses((prev) => {
						const next = { ...prev };
						delete next[assetId];
						return next;
					});
				} catch (err) {
					setAssetStatuses((prev) => ({ ...prev, [assetId]: "failed" }));
					throw err;
				}
			}

			const { captionSegmentsToAnnotationRegions } = await import(
				"@/lib/captioning/annotationsFromCaptions"
			);
			toast.loading("Generating captions…", { id: "captions-gen" });
			const segments =
				((transcript as Record<string, unknown>).segments as Array<Record<string, unknown>>) ?? [];
			const { regions } = captionSegmentsToAnnotationRegions(
				segments as never,
				doc.annotations.length + 1,
				doc.annotations.length + 1,
				{
					minWordsPerCaption: captionsMinW,
					maxWordsPerCaption: captionsMaxW,
					timestampGranularity: "word",
				},
			);
			const latestDoc = useProjectStore.getState().document ?? doc;
			const next = {
				...latestDoc,
				annotations: [...latestDoc.annotations, ...(regions as never)],
			};
			await saveDocument(next);
			toast.dismiss("captions-gen");
			toast.success(`Added ${regions.length} captions`);
		} catch (err) {
			toast.dismiss("captions-gen");
			toast.error("Caption generation failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [captionsMinW, captionsMaxW, saveDocument, setTranscript]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
			if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
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
						if (doc) {
							try {
								await saveDocument(doc);
							} catch {
								return;
							}
						}
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
						if (doc) {
							try {
								await saveDocument(doc);
							} catch {
								return;
							}
						}
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
				if (tl.clipSelection) {
					e.preventDefault();
					setCopiedClipId(tl.clipSelection);
					return;
				}
				if (tl.selection) {
					e.preventDefault();
					void handleCopyRegion();
					return;
				}
			}
			if (ctrl && e.key.toLowerCase() === "x") {
				// F2.8 — cut: remember the region in the clipboard, then remove it.
				if (tl.selection && tl.selection.kind !== "trim") {
					e.preventDefault();
					const cut = tl.selection;
					void handleCopyRegion().then(() => tl.removeRegion(cut.kind, cut.id));
					return;
				}
			}
			if (matchesShortcut(e, shortcuts.paste, isMac)) {
				e.preventDefault();
				// A selected/copied clip takes priority — pasting with a clip in
				// hand is unambiguously "duplicate this clip", even if a region
				// was copied earlier in the session.
				const clipToDuplicate = copiedClipId ?? tl.clipSelection;
				if (clipToDuplicate) {
					void tl.duplicateClip(clipToDuplicate);
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
			if (matchesShortcut(e, shortcuts.addZoom, isMac)) {
				e.preventDefault();
				void tl.addZoom();
				return;
			}
			if (matchesShortcut(e, shortcuts.addTrim, isMac)) {
				e.preventDefault();
				void tl.addTrim();
				return;
			}
			if (matchesShortcut(e, shortcuts.addAnnotation, isMac)) {
				e.preventDefault();
				void tl.addAnnotation();
				return;
			}
			if (matchesShortcut(e, shortcuts.addSpeed, isMac)) {
				e.preventDefault();
				void tl.addSpeed();
				return;
			}
			if (matchesShortcut(e, shortcuts.addCameraFullscreen, isMac)) {
				e.preventDefault();
				void tl.addCameraFullscreen();
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
				handleSeek(Math.max(0, currentTimeSec + direction * frameStepSec));
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
		currentTimeSec,
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
		busy: isTranscribing,
		currentTimeSec,
		onSeek: handleSeek,
		onAddTrimRange: handleAddTrimRange,
		onRemoveTrimRange: handleRemoveTrimRange,
		onTranscribe: handleTranscribe,
		canTranscribe: hasAsset,
		isTranscribing,
	};

	return (
		<div
			className={v4.app}
			style={{ gridTemplateRows: `58px 1fr ${showTimeline ? timelineRow : "0px"}` }}
		>
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
				}}
			/>

			<div className={v4.body} style={{ gridTemplateColumns: bodyColumns }}>
				{mode === "edit" && chatOpen ? (
					<>
						<aside className={v4.agent} aria-label="AI editor">
							<LeftPanel
								active="chat"
								assetStatuses={assetStatuses}
								onRegenerateAsset={handleRegenerateAsset}
							/>
						</aside>
						<div
							className={v4.chatResizeHandle}
							style={{ left: chatWidthPx }}
							role="separator"
							aria-orientation="vertical"
							aria-label="Resize chat panel"
							onPointerDown={startChatResize}
						/>
					</>
				) : null}

				<section className={v4.stage} aria-label="Preview stage">
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
										tl.updateAnnotationLive(id, { position });
										void tl.commitAnnotationChange();
									}}
									onAnnotationSizeChange={(id, size) => {
										tl.updateAnnotationLive(id, { size });
										void tl.commitAnnotationChange();
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
									currentTimeSec={currentTimeSec}
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
								onCaptions={handleCaptions}
								transcriptProps={transcriptProps}
							/>
						</>
					) : mode === "media" ? (
						<MediaStage assetStatuses={assetStatuses} onRegenerateAsset={handleRegenerateAsset} />
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
							aria-label="Resize timeline"
							onPointerDown={startTimelineResize}
						/>
					) : null}
					<V4Timeline
						tl={tl}
						currentTimeSec={currentTimeSec}
						setCurrentTime={(sec) => {
							handleSeek(sec);
						}}
						variant={mode === "media" ? "media" : "edit"}
						onDropAsset={(assetId) => void tl.insertClipAt(assetId, clips.length)}
						videoSources={videoSources}
						playing={playing}
						loop={loop}
						onTogglePlay={togglePlay}
						onPrevClip={handlePrevClip}
						onNextClip={handleNextClip}
						onToggleLoop={handleToggleLoop}
						onExpand={handleExpand}
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
					void tl.updateClipSourceRange(editClipTarget.id, sStart, sEnd);
					if (cropRegion !== undefined) void tl.updateClipCrop(editClipTarget.id, cropRegion);
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
			<AutoCaptionsModal
				open={captionsOpen}
				onClose={() => setCaptionsOpen(false)}
				minWords={captionsMinW}
				maxWords={captionsMaxW}
				onMinWords={setCaptionsMinW}
				onMaxWords={setCaptionsMaxW}
				onGenerate={handleGenerateCaptions}
			/>
		</div>
	);
}
