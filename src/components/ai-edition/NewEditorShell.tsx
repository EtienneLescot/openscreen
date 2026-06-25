import { EyeOff, Film, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { EditorProjectData } from "@/components/video-editor/projectPersistence";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { CropRegion } from "@/components/video-editor/types";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import { transcribeAsset } from "@/lib/ai-edition/document/transcribe";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useUndoRedoShortcuts } from "@/lib/ai-edition/store/undo";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { nativeBridgeClient } from "@/native";
import type { AiEditionProjectSummary } from "@/native/contracts";
import { Bottombar } from "./Bottombar";
import { ExportDialog } from "./ExportDialog";
import { LeftPanel, LeftRail, type LeftTab } from "./LeftPanel";
import {
	AutoCaptionsModal,
	CropModal,
	InsertSourceModal,
	NewProjectModal,
	OpenProjectModal,
	UnsavedChangesModal,
	type UnsavedChoice,
} from "./Modals";
import styles from "./NewEditorShell.module.css";
import { Preview } from "./Preview";
import { RightPanelStack } from "./RightPanelStack";
import type { RightPaneId } from "./RightPanes";
import { Titlebar } from "./Titlebar";

interface SeekTarget {
	timeSec: number;
	isSource?: boolean;
	requestId: number;
}

const COLLAPSE_INITIAL = {
	left: false,
	right: true,
	bottom: false,
};

export function NewEditorShell() {
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const sourceDurationSec = useProjectStore((s) => s.sourceDurationSec);
	const currentTimeSec = useProjectStore((s) => s.currentTimeSec);
	const dirty = useProjectStore((s) => s.dirty);
	const lastSavedAt = useProjectStore((s) => s.lastSavedAt);
	const createProject = useProjectStore((s) => s.createProject);
	const addAsset = useProjectStore((s) => s.addAsset);
	const replaceTimeline = useProjectStore((s) => s.replaceTimeline);
	const setTranscript = useProjectStore((s) => s.setTranscript);
	const setCurrentTime = useProjectStore((s) => s.setCurrentTime);
	const setSourceDuration = useProjectStore((s) => s.setSourceDuration);
	const loadProject = useProjectStore((s) => s.loadProject);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const markClean = useProjectStore((s) => s.markClean);

	const [seekTarget, setSeekTarget] = useState<SeekTarget | null>(null);
	const [isTranscribing, setIsTranscribing] = useState(false);
	const [assetStatuses, setAssetStatuses] = useState<
		Record<string, "pending" | "running" | "failed">
	>({});
	const [, setVideoElement] = useState<HTMLVideoElement | null>(null);
	const [leftTab, setLeftTab] = useState<LeftTab>("media");
	const [rightPane, setRightPane] = useState<RightPaneId>("background");
	const [leftCollapsed, setLeftCollapsed] = useState(COLLAPSE_INITIAL.left);
	const [rightCollapsed, setRightCollapsed] = useState(COLLAPSE_INITIAL.right);
	const [bottomCollapsed, setBottomCollapsed] = useState(COLLAPSE_INITIAL.bottom);
	const [openProjectOpen, setOpenProjectOpen] = useState(false);
	const [newProjectOpen, setNewProjectOpen] = useState(false);
	const [cropOpen, setCropOpen] = useState(false);
	const [exportOpen, setExportOpen] = useState(false);
	const [unsavedPrompt, setUnsavedPrompt] = useState<{
		action: "new" | "open" | "record";
		resolve: (choice: UnsavedChoice) => void;
	} | null>(null);
	const { settings: editorSettings, set: setEditorSettings } = useEditorSettings();
	const tl = useTimeline();
	useUndoRedoShortcuts(() => {
		// ponytail: placeholder, wire when undo stack merges with history
	});
	const [captionsOpen, setCaptionsOpen] = useState(false);
	const [captionsMinW, setCaptionsMinW] = useState(2);
	const [captionsMaxW, setCaptionsMaxW] = useState(7);
	const [insertAssetId, setInsertAssetId] = useState<string | null>(null);
	const [projectSummaries, setProjectSummaries] = useState<AiEditionProjectSummary[]>([]);
	const seekSeqRef = useRef(0);
	const initRef = useRef(false);

	const promptUnsaved = useCallback(
		(action: "new" | "open" | "record"): Promise<UnsavedChoice> => {
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
				if (!result.success || !result.session?.screenVideoPath) return;
				const screenPath = result.session.screenVideoPath;
				const label = screenPath.split(/[\\/]/).pop() || "Recording";
				await createProject(`Recording ${new Date().toLocaleString()}`);
				await addAsset(screenPath, label);
				toast.success("Recording added to a new project");
			} catch (err) {
				toast.error("Could not auto-create project from recording", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		})();
	}, [addAsset, createProject]);

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
				const choice = await promptUnsaved("new"); // Use "new" as a generic action for close
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
			src: toFileUrl(asset.originalPath),
			label: asset.label,
		}));
	}, [document]);

	const handleLoadedMetadata = useCallback(
		(durationSec: number) => {
			setSourceDuration(durationSec);
			if (document && document.assets.length > 0 && document.timeline.clips.length === 0) {
				const asset =
					document.assets.find((a) => a.id === document.project.primaryAssetId) ??
					document.assets[0];
				if (asset) {
					void replaceTimeline(
						[{ startSec: 0, endSec: durationSec }],
						"Auto-created full-duration clip",
					);
				}
			}
		},
		[document, replaceTimeline, setSourceDuration],
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

	const handleReplaceTimeline = useCallback(
		(intervals: Array<{ startSec: number; endSec: number }>, reason: string) => {
			void replaceTimeline(intervals, reason);
		},
		[replaceTimeline],
	);

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
			setRightPane("transcript");
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

	const handleLoadLegacyProject = useCallback(async () => {
		try {
			const result = await window.electronAPI?.loadProjectFile();
			if (!result?.success || !result.project) return;
			const legacy = result.project as EditorProjectData;
			const migrated = migrateProjectDataToAxcutDocument(legacy);
			const saved = await nativeBridgeClient.aiEdition.save(migrated);
			if (saved.success && saved.document) {
				await loadProject(migrated.project.id);
				toast.success("Legacy project migrated and loaded");
			} else {
				toast.error(saved.error ?? "Failed to save migrated project");
			}
		} catch (err) {
			toast.error("Could not load project", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [loadProject]);

	const handleDropWordRange = useCallback(
		async (startSec: number, endSec: number) => {
			if (!document) return;
			const { subtractInterval, timelineIntervals: getIntervals } = await import(
				"@/lib/ai-edition/document/timeline"
			);
			const intervals = getIntervals(document);
			const next = subtractInterval(intervals, { startSec, endSec });
			await replaceTimeline(
				next,
				`Dropped word range ${startSec.toFixed(1)}s-${endSec.toFixed(1)}s`,
			);
		},
		[document, replaceTimeline],
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

	const handleSaveAs = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		try {
			const result = await nativeBridgeClient.aiEdition.save(doc);
			if (!result.success || !result.document) {
				throw new Error(result.error ?? "Failed to save project");
			}
			const title = window.prompt("Save project as", doc.project.title);
			if (!title || title === doc.project.title) {
				markClean();
				toast.success("Project saved");
				return;
			}
			const renamed = { ...doc, project: { ...doc.project, title } };
			await saveDocument(renamed);
			toast.success(`Saved as "${title}"`);
		} catch (err) {
			toast.error("Save failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [markClean, saveDocument]);

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

	const handleReturnToRecorder = useCallback(() => {
		void window.electronAPI?.switchToHud?.();
	}, []);

	const handleExport = useCallback(() => {
		if (!hasAsset) {
			toast.info("Add a video to the project before exporting.");
			return;
		}
		setExportOpen(true);
	}, [hasAsset]);

	const handlePreviewSource = useCallback((sec: number) => {
		setSeekTarget({ timeSec: sec, isSource: true, requestId: ++seekSeqRef.current });
	}, []);

	const handleOpenSettings = useCallback(() => {
		toast.info(
			"Open the right rail to access Background, Effects, Layout, Cursor, and Timeline settings.",
		);
	}, []);

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
				kind: tl.selection.kind === "skip" ? "zoom" : tl.selection.kind,
				region: region as Record<string, unknown>,
			});
			toast.success("Region copied");
		}
	}, [tl]);

	const handleDropOnTimeline = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		const assetId = e.dataTransfer.getData("application/x-axcut-asset");
		if (assetId) setInsertAssetId(assetId);
	}, []);

	const handleInsertBefore = useCallback(async () => {
		if (!insertAssetId) return;
		setInsertAssetId(null);
		await tl.addClipBefore(insertAssetId);
	}, [insertAssetId, tl]);

	const handleInsertAfter = useCallback(async () => {
		if (!insertAssetId) return;
		setInsertAssetId(null);
		await tl.addClipAfter(insertAssetId);
	}, [insertAssetId, tl]);

	const handleInsertSplit = useCallback(async () => {
		if (!insertAssetId) return;
		setInsertAssetId(null);
		await tl.splitAndInsert(insertAssetId, currentTimeSec);
	}, [insertAssetId, currentTimeSec, tl]);

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
			if (ctrl && e.key === "z") return;
			if (e.key === "?" || (e.shiftKey && e.key === "/")) {
				e.preventDefault();
				window.dispatchEvent(new CustomEvent("openscreen:open-shortcuts"));
				return;
			}
			if (ctrl && e.key.toLowerCase() === "c" && tl.selection) {
				e.preventDefault();
				void handleCopyRegion();
				return;
			}
			if (ctrl && e.key.toLowerCase() === "v") {
				e.preventDefault();
				void pasteRegion();
				return;
			}
			if (e.key === " ") {
				const v = window.document.querySelector("video");
				if (v) {
					e.preventDefault();
					if (v.paused) {
						void v.play();
					} else {
						v.pause();
					}
				}
				return;
			}
			if (e.key === "Delete" || e.key === "Backspace") {
				if (tl.selection) {
					e.preventDefault();
					void tl.removeRegion(tl.selection.kind, tl.selection.id);
				}
				return;
			}
			switch (e.key.toLowerCase()) {
				case "z":
					if (!ctrl) {
						e.preventDefault();
						void tl.addZoom();
					}
					break;
				case "t":
					e.preventDefault();
					void tl.addSkip();
					break;
				case "a":
					e.preventDefault();
					void tl.addAnnotation();
					break;
				case "s":
					e.preventDefault();
					void tl.addSpeed();
					break;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [hasProject, handleCopyRegion, handleSave, pasteRegion, tl, promptUnsaved, saveDocument]);

	const collapseAttr = useMemo(() => {
		const list: string[] = [];
		if (leftCollapsed) list.push("left");
		if (rightCollapsed) list.push("right");
		if (bottomCollapsed) list.push("bottom");
		return list.join(" ");
	}, [leftCollapsed, rightCollapsed, bottomCollapsed]);

	return (
		<div className={styles.app} data-collapse={collapseAttr || undefined}>
			<Titlebar
				project={project}
				dirty={dirty}
				lastSavedAt={lastSavedAt}
				canExport={hasAsset}
				leftCollapsed={leftCollapsed}
				rightCollapsed={rightCollapsed}
				bottomCollapsed={bottomCollapsed}
				actions={{
					openProject: () => setOpenProjectOpen(true),
					newProject: () => setNewProjectOpen(true),
					save: () => void handleSave(),
					saveAs: () => void handleSaveAs(),
					newRecording: () => void handleNewRecording(),
					recorder: handleReturnToRecorder,
					export: handleExport,
					toggleLeft: () => setLeftCollapsed((v) => !v),
					toggleRight: () => setRightCollapsed((v) => !v),
					toggleBottom: () => setBottomCollapsed((v) => !v),
					openSettings: handleOpenSettings,
					renameProject: handleRenameProject,
				}}
			/>

			<main
				className={styles.workbench}
				onDragOver={(e) => {
					e.preventDefault();
					e.dataTransfer.dropEffect = "copy";
				}}
				onDrop={handleDropOnTimeline}
			>
				{/* Left rail */}
				<LeftRail active={leftTab} onChange={setLeftTab} />

				{/* Left content panel */}
				{!leftCollapsed ? (
					<div className={styles.leftPanel}>
						<LeftPanel active={leftTab} assetStatuses={assetStatuses} />
					</div>
				) : null}

				{/* Resize handle: left */}
				<div
					className={`${styles.handle} ${styles.handleCol} ${styles.handleLeft}`}
					aria-label="Resize left panel"
					onPointerDown={(e) => startResize(e, "left")}
				/>

				{/* Preview center */}
				<Preview
					hasProject={hasProject}
					hasAsset={hasAsset}
					videoSources={videoSources}
					clips={clips}
					seekTarget={seekTarget}
					onTimeChange={handleTimeChange}
					onSeek={handleSeek}
					onLoadedMetadata={handleLoadedMetadata}
					onVideoElement={setVideoElement}
					currentTimeSec={currentTimeSec}
				/>

				{/* Resize handle: right */}
				<div
					className={`${styles.handle} ${styles.handleCol} ${styles.handleRight}`}
					aria-label="Resize right panel"
					onPointerDown={(e) => startResize(e, "right")}
				/>

				{/* Right panel stack + rail */}
				{!rightCollapsed ? (
					<RightPanelStack
						active={rightPane}
						onChange={setRightPane}
						onCrop={() => setCropOpen(true)}
						transcript={document?.transcript ?? null}
						clips={clips}
						currentTimeSec={currentTimeSec}
						onSeek={handleSeek}
						onDropWordRange={handleDropWordRange}
						onTranscribe={handleTranscribe}
						canTranscribe={hasAsset}
						isTranscribing={isTranscribing}
						selection={tl.selection}
						onClearSelection={tl.clearSelection}
						onRemoveSelection={(kind, id) => void tl.removeRegion(kind, id)}
					/>
				) : (
					<aside className={`${styles.rail} ${styles.rightRail}`} aria-label="Right tools">
						<RightRailCompact onChange={setRightPane} onCrop={() => setCropOpen(true)} />
					</aside>
				)}
			</main>

			{/* Resize handle: bottom */}
			<div
				className={`${styles.handle} ${styles.handleRow} ${styles.handleBottom}`}
				aria-label="Resize timeline"
				onPointerDown={(e) => startResize(e, "bottom")}
			/>

			{/* Bottom timeline */}
			{!bottomCollapsed ? (
				<Bottombar
					clips={clips}
					currentTimeSec={currentTimeSec}
					sourceDurationSec={sourceDurationSec}
					onPreviewSource={handlePreviewSource}
					onReplaceTimeline={handleReplaceTimeline}
					zoomRegions={tl.zoomRegions}
					skipRanges={tl.skipRanges}
					annotationRegions={tl.annotationRegions}
					speedRegions={tl.speedRegions}
					selection={tl.selection}
					hasDoc={tl.hasDoc}
					onAddZoom={() => void tl.addZoom()}
					onAddSkip={() => void tl.addSkip()}
					onAddAnnotation={() => void tl.addAnnotation()}
					onAddSpeed={() => void tl.addSpeed()}
					onSelectRegion={(kind, id) => tl.selectRegion(kind, id)}
					onRemoveRegion={(kind, id) => void tl.removeRegion(kind, id)}
					onCaptions={handleCaptions}
				/>
			) : null}

			{/* Modals */}
			<OpenProjectModal
				open={openProjectOpen}
				onClose={() => setOpenProjectOpen(false)}
				projects={projectSummaries}
				activeProjectId={projectId}
				onSelect={handleSelectProject}
				onBrowse={handleLoadLegacyProject}
			/>
			<NewProjectModal
				open={newProjectOpen}
				onClose={() => setNewProjectOpen(false)}
				onCreate={handleCreateProject}
			/>
			<CropModal
				open={cropOpen}
				onClose={() => setCropOpen(false)}
				initialRegion={editorSettings.cropRegion}
				onApply={(region: CropRegion) => void setEditorSettings({ cropRegion: region })}
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
			<InsertSourceModal
				open={insertAssetId !== null}
				onClose={() => setInsertAssetId(null)}
				assetLabel={document?.assets.find((a) => a.id === insertAssetId)?.label ?? ""}
				canAddBefore
				canAddAfter
				canSplit={document !== null}
				onAddBefore={() => void handleInsertBefore()}
				onAddAfter={() => void handleInsertAfter()}
				onSplit={() => void handleInsertSplit()}
			/>
		</div>
	);
}

function RightRailCompact({
	onChange,
	onCrop,
}: {
	onChange: (id: RightPaneId) => void;
	onCrop: () => void;
}) {
	const buttons: Array<{ id: RightPaneId; label: string; icon: React.ElementType }> = [
		{ id: "background", label: "Background", icon: Sparkles },
		{ id: "effects", label: "Video effects", icon: Film },
	];
	return (
		<>
			{buttons.map(({ id, label, icon: Icon }) => (
				<button
					type="button"
					key={id}
					title={label}
					aria-label={label}
					onClick={() => onChange(id)}
				>
					<Icon size={18} />
				</button>
			))}
			<button type="button" title="Crop" aria-label="Crop" onClick={onCrop}>
				<EyeOff size={18} />
			</button>
		</>
	);
}

function startResize(e: React.PointerEvent<HTMLDivElement>, axis: "left" | "right" | "bottom") {
	e.preventDefault();
	const target = e.currentTarget;
	target.setPointerCapture(e.pointerId);
	target.classList.add(styles.isDragging);
	document.body.style.cursor = axis === "bottom" ? "row-resize" : "col-resize";

	const root = document.documentElement;
	const varName =
		axis === "left" ? "--panel-w-left" : axis === "right" ? "--panel-w-right" : "--bottom-h";
	const min = axis === "bottom" ? 140 : 200;
	const cap = axis === "bottom" ? 0.65 : 0.55;
	const max = axis === "bottom" ? window.innerHeight * cap : window.innerWidth * cap;
	const startVal = parseFloat(getComputedStyle(root).getPropertyValue(varName)) || 0;
	const startX = e.clientX;
	const startY = e.clientY;

	const onMove = (ev: PointerEvent) => {
		let next: number;
		if (axis === "left") next = startVal + (ev.clientX - startX);
		else if (axis === "right") next = startVal - (ev.clientX - startX);
		else next = startVal + (startY - ev.clientY);
		next = Math.max(min, Math.min(next, max));
		root.style.setProperty(varName, `${next}px`);
	};
	const onUp = () => {
		target.classList.remove(styles.isDragging);
		document.body.style.cursor = "";
		target.removeEventListener("pointermove", onMove);
		target.removeEventListener("pointerup", onUp);
		target.removeEventListener("pointercancel", onUp);
	};
	target.addEventListener("pointermove", onMove);
	target.addEventListener("pointerup", onUp);
	target.addEventListener("pointercancel", onUp);
}
