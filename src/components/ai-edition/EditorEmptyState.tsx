// Empty state for the new editor's preview.
//
// Mirrors the legacy `EditorEmptyState` (import video + load project + drag
// drop) but on top of the project store: a "no project" branch offers
// `createProject` + `loadProject`, and a "has project, no asset" branch offers
// the file picker + load (for the rare user who already has a .openscreen
// project without media attached).
//
// ponytail: keeps the existing copy from the legacy component and the same
// drag/drop affordance, but the actions map to project-store operations
// rather than the legacy `nativeBridgeClient.project.*` ones. The two editor
// shells will collapse once we have a single render path; until then the
// "open screen" feature lives here in the new UX and in the legacy
// `EditorEmptyState.tsx` for the deprecated editor.

import { AlertCircle, Film, FolderOpen, Upload, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { nativeBridgeClient } from "@/native";
import styles from "./NewEditorShell.module.css";

type DropError = "unsupported-format" | "load-failed" | null;

interface EditorEmptyStateProps {
	/** True when a project exists (so the copy becomes "add a video" not "no project"). */
	hasProject: boolean;
	/** Show the file dialog (Open Video) and a Load Project button when no project is loaded. */
	showLoadProjectButton?: boolean;
}

export function EditorEmptyState({
	hasProject,
	showLoadProjectButton = true,
}: EditorEmptyStateProps) {
	const [isDraggingOver, setIsDraggingOver] = useState(false);
	const [dropError, setDropError] = useState<DropError>(null);
	const lastDropErrorRef = useRef<Exclude<DropError, null>>("unsupported-format");
	if (dropError !== null) {
		lastDropErrorRef.current = dropError;
	}

	const createProject = useProjectStore((s) => s.createProject);
	const addAsset = useProjectStore((s) => s.addAsset);
	const loadProject = useProjectStore((s) => s.loadProject);

	const ensureProject = useCallback(async (): Promise<string | null> => {
		const existing = useProjectStore.getState().projectId;
		if (existing) return existing;
		const doc = await createProject(`Project ${new Date().toLocaleString()}`);
		return doc.project.id;
	}, [createProject]);

	const handleImportVideo = useCallback(async () => {
		const result = await window.electronAPI?.openVideoFilePicker?.();
		if (!result || result.canceled || !result.success || !result.path) return;
		try {
			const projectId = await ensureProject();
			if (!projectId) return;
			const label = result.path.split(/[\\/]/).pop() || "Recording";
			await addAsset(result.path, label);
		} catch (err) {
			setDropError("load-failed");
			// ponytail: surface as a console message only — the dialog above
			// already tells the user something went wrong.
			console.error("Failed to import video", err);
		}
	}, [addAsset, ensureProject]);

	const handleLoadProject = useCallback(async () => {
		try {
			const result = await window.electronAPI?.loadProjectFile?.();
			if (!result?.success || !result.project) return;
			// ponytail: legacy v2 projects round-trip through the migrator.
			// The bridge expects a v3 AxcutDocument.
			const migrated = migrateProjectDataToAxcutDocument(result.project as never);
			const saved = await nativeBridgeClient.aiEdition.save(migrated);
			if (saved.success && saved.document) {
				await loadProject(migrated.project.id);
			} else {
				setDropError("load-failed");
			}
		} catch {
			setDropError("load-failed");
		}
	}, [loadProject]);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		if (e.dataTransfer.items.length > 0) {
			setIsDraggingOver(true);
		}
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		if (!e.currentTarget.contains(e.relatedTarget as Node)) {
			setIsDraggingOver(false);
		}
	}, []);

	const handleDrop = useCallback(
		async (e: React.DragEvent) => {
			e.preventDefault();
			setIsDraggingOver(false);
			const files = Array.from(e.dataTransfer.files);
			if (files.length === 0) return;
			const projectFile = files.find((f) => f.name.endsWith(".openscreen"));
			if (!projectFile) {
				setDropError("unsupported-format");
				return;
			}
			let filePath: string;
			try {
				filePath = window.electronAPI?.getPathForFile(projectFile) ?? "";
			} catch {
				setDropError("load-failed");
				return;
			}
			if (!filePath) {
				setDropError("load-failed");
				return;
			}
			const result = await window.electronAPI?.loadProjectFileFromPath?.(filePath);
			if (!result?.success || !result.project) {
				setDropError("load-failed");
				return;
			}
			try {
				const migrated = migrateProjectDataToAxcutDocument(result.project as never);
				const saved = await nativeBridgeClient.aiEdition.save(migrated);
				if (saved.success && saved.document) {
					await loadProject(migrated.project.id);
				} else {
					setDropError("load-failed");
				}
			} catch {
				setDropError("load-failed");
			}
		},
		[loadProject],
	);

	return (
		<div
			className={styles.previewEmptyDrop}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{isDraggingOver ? (
				<div className={styles.previewEmptyDropOverlay}>
					<Upload className={styles.previewEmptyDropIcon} />
					<p className={styles.previewEmptyDropLabel}>Drop a .openscreen project file</p>
				</div>
			) : null}

			<Dialog open={dropError !== null} onOpenChange={(open) => !open && setDropError(null)}>
				<DialogContent className={styles.previewEmptyDialog}>
					<DialogHeader className={styles.previewEmptyDialogHeader}>
						<div className={styles.previewEmptyDialogHeaderInner}>
							<img
								src="./openscreen.png"
								alt=""
								aria-hidden="true"
								className={styles.previewEmptyDialogLogo}
							/>
							<DialogTitle className={styles.previewEmptyDialogTitle}>
								{lastDropErrorRef.current === "unsupported-format"
									? "Unsupported format"
									: "Could not open project"}
							</DialogTitle>
						</div>
					</DialogHeader>
					<div className={styles.previewEmptyDialogBody}>
						<div className={styles.previewEmptyDialogIcon}>
							<AlertCircle className={styles.previewEmptyDialogAlertIcon} />
						</div>
						<p className={styles.previewEmptyDialogMessage}>
							{lastDropErrorRef.current === "unsupported-format"
								? "Only .openscreen project files are supported. Drop a recording to import it, or use the buttons above."
								: "We couldn't read that project file. Try re-opening it from the file picker."}
						</p>
					</div>
					<button
						type="button"
						onClick={() => setDropError(null)}
						className={styles.previewEmptyDialogClose}
					>
						<X className={styles.previewEmptyDialogCloseIcon} />
						Close
					</button>
				</DialogContent>
			</Dialog>

			<div className={styles.previewEmptyInner}>
				<img src="./openscreen.png" alt="" aria-hidden="true" className={styles.previewEmptyLogo} />
				<div className={styles.previewEmptyHeading}>
					<h2 className={styles.previewEmptyTitle}>
						{hasProject ? "Add a video to get started" : "No project open"}
					</h2>
					<p className={styles.previewEmptyDescription}>
						{hasProject
							? "Import a recording to begin editing."
							: "Create a new project or open an existing one."}
					</p>
				</div>
				<div className={styles.previewEmptyActions}>
					<button
						type="button"
						onClick={() => void handleImportVideo()}
						className={styles.previewEmptyPrimaryButton}
					>
						<Film className={styles.previewEmptyButtonIcon} />
						{hasProject ? "Import video" : "New project + import video"}
					</button>
					{showLoadProjectButton && !hasProject ? (
						<button
							type="button"
							onClick={() => void handleLoadProject()}
							className={styles.previewEmptySecondaryButton}
						>
							<FolderOpen className={styles.previewEmptyButtonIcon} />
							Open project
						</button>
					) : null}
				</div>
				<p className={styles.previewEmptyHint}>
					Supported formats: MP4, MOV, WebM, MKV, AVI, M4V, WMV.
				</p>
				<p className={styles.previewEmptyDragHint}>
					<Upload className={styles.previewEmptyDragHintIcon} />
					Or drop a .openscreen project file here.
				</p>
			</div>
		</div>
	);
}
