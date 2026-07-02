import {
	Brackets,
	Crop,
	LayoutPanelTop,
	MousePointerClick,
	Palette,
	Sliders,
	Sparkles,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { parseCustomPlaybackSpeedInput } from "@/components/video-editor/customPlaybackSpeed";
import {
	MAX_ZOOM_SCALE,
	MIN_ZOOM_SCALE,
	SPEED_OPTIONS,
	ZOOM_DEPTH_SCALES,
	type ZoomDepth,
} from "@/components/video-editor/types";
import type {
	AxcutAnnotationRegion,
	AxcutClip,
	AxcutDocument,
	AxcutTranscript,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import styles from "./NewEditorShell.module.css";
import {
	BackgroundPane,
	CursorPane,
	LayoutPane,
	type RightPaneId,
	TimelinePaneBody,
	TranscriptPane,
	VideoEffectsPane,
} from "./RightPanes";

type RegionKind = "zoom" | "skip" | "annotation" | "speed";

interface RegionHandle {
	kind: RegionKind;
	id: string;
}

interface RightPanelStackProps {
	active: RightPaneId;
	onChange: (id: RightPaneId) => void;
	onCrop: () => void;
	transcript: AxcutTranscript | null;
	clips: AxcutClip[];
	currentTimeSec: number;
	onSeek: (sec: number) => void;
	onDropWordRange: (start: number, end: number) => void;
	onTranscribe: () => void;
	canTranscribe: boolean;
	isTranscribing: boolean;
	selection?: RegionHandle | null;
	onClearSelection?: () => void;
	onRemoveSelection?: (kind: RegionKind, id: string) => void;
}

const RAIL_BUTTONS: Array<{
	id: RightPaneId;
	label: string;
	icon: React.ElementType;
}> = [
	{ id: "background", label: "Background", icon: Palette },
	{ id: "effects", label: "Video effects", icon: Sliders },
	{ id: "layout", label: "Layout", icon: LayoutPanelTop },
	{ id: "cursor", label: "Cursor", icon: MousePointerClick },
	{ id: "timeline", label: "Timeline", icon: Brackets },
	{ id: "transcript", label: "Transcription", icon: Sparkles },
];

export function RightPanelStack({
	active,
	onChange,
	onCrop,
	transcript,
	clips,
	currentTimeSec,
	onSeek,
	onDropWordRange,
	onTranscribe,
	canTranscribe,
	isTranscribing,
	selection,
	onClearSelection,
	onRemoveSelection,
}: RightPanelStackProps) {
	const document = useProjectStore((s) => s.document);

	// Region inspector
	if (selection && onClearSelection && onRemoveSelection && document) {
		return (
			<RegionInspector
				document={document}
				selection={selection}
				onClear={onClearSelection}
				onRemove={onRemoveSelection}
			/>
		);
	}

	return (
		<>
			<div className={`${styles.rightStack}`}>
				{active === "background" ? <BackgroundPane /> : null}
				{active === "transcript" ? (
					<TranscriptPane
						transcript={transcript}
						clips={clips}
						currentTimeSec={currentTimeSec}
						onSeek={onSeek}
						onDropWordRange={onDropWordRange}
						onTranscribe={onTranscribe}
						canTranscribe={canTranscribe}
						isTranscribing={isTranscribing}
					/>
				) : null}
				{active === "effects" ? <VideoEffectsPane /> : null}
				{active === "layout" ? <LayoutPane /> : null}
				{active === "cursor" ? <CursorPane /> : null}
				{active === "timeline" ? <TimelinePaneBody /> : null}
			</div>
			<aside className={`${styles.rail} ${styles.rightRail}`} aria-label="Right tools">
				{RAIL_BUTTONS.map(({ id, label, icon: Icon }) => (
					<button
						type="button"
						key={id}
						title={label}
						aria-label={label}
						aria-pressed={active === id}
						onClick={() => onChange(id)}
					>
						<Icon size={18} />
					</button>
				))}
				<span className={styles.sepH} aria-hidden />
				<button type="button" title="Crop video" aria-label="Crop video" onClick={onCrop}>
					<Crop size={18} />
				</button>
			</aside>
		</>
	);
}

function RegionInspector({
	document,
	selection,
	onClear,
	onRemove,
}: {
	document: AxcutDocument;
	selection: RegionHandle;
	onClear: () => void;
	onRemove: (kind: RegionKind, id: string) => void;
}) {
	const setDocument = useProjectStore((s) => s.setDocument);
	const saveDocument = useProjectStore((s) => s.saveDocument);

	const region =
		selection.kind === "zoom"
			? document.zoomRanges.find((z) => z.id === selection.id)
			: selection.kind === "annotation"
				? document.annotations.find((a) => a.id === selection.id)
				: selection.kind === "speed"
					? (
							(document.legacyEditor as { speedRegions?: Array<{ id: string; speed: number }> })
								?.speedRegions ?? []
						).find((s) => s.id === selection.id)
					: null;

	const depthNames = ["1.25×", "1.5×", "1.8×", "2.2×", "3.5×", "5×"];
	const zoomRegion =
		selection.kind === "zoom"
			? (region as { depth?: ZoomDepth; customScale?: number } | undefined)
			: undefined;
	const zoomDepth = zoomRegion?.depth ?? 3;
	// ponytail: matches main's SettingsPanel `effectiveScale` — a custom slider
	// value overrides the depth preset, so no preset button is highlighted
	// unless the value happens to equal one exactly.
	const effectiveZoomScale = zoomRegion?.customScale ?? ZOOM_DEPTH_SCALES[zoomDepth];
	const currentDepth = depthNames.findIndex(
		(_, i) => ZOOM_DEPTH_SCALES[(i + 1) as ZoomDepth] === effectiveZoomScale,
	);

	const speedValue = selection.kind === "speed" ? ((region as { speed?: number })?.speed ?? 1) : 1;
	// ponytail: mirrors main's CustomSpeedInput — the text field shows a draft
	// string, empty whenever the current value exactly matches a preset (so
	// the input looks "unused" while a preset is active), and only commits on
	// blur/Enter after validating range via parseCustomPlaybackSpeedInput.
	const [speedDraft, setSpeedDraft] = useState("");
	useEffect(() => {
		setSpeedDraft(SPEED_OPTIONS.some((o) => o.speed === speedValue) ? "" : String(speedValue));
	}, [speedValue]);

	// ponytail: keep rapid text edits in local state and flush on blur so we
	// don't push an undo snapshot per keystroke.
	const annot =
		region && selection.kind === "annotation" ? (region as AxcutAnnotationRegion) : null;
	const annotText = annot?.textContent || annot?.content || "";
	const [textDraft, setTextDraft] = useState(annotText);
	useEffect(() => {
		setTextDraft(annotText);
	}, [annotText]);
	const flushText = useCallback(() => {
		if (!annot) return;
		if (textDraft === (annot.textContent || annot.content || "")) return;
		const next = document.annotations.map((a) =>
			a.id === selection.id ? { ...a, textContent: textDraft, content: textDraft } : a,
		);
		setDocument({ ...document, annotations: next });
		void saveDocument({ ...document, annotations: next });
	}, [annot, textDraft, document, selection.id, setDocument, saveDocument]);

	// Shared save path for the inspector's annotation controls (style, figure
	// and blur sub-objects) — one undo snapshot per change.
	const patchAnnotation = useCallback(
		(patch: (a: AxcutAnnotationRegion) => AxcutAnnotationRegion) => {
			const next = document.annotations.map((a) =>
				a.id === selection.id ? patch(a as AxcutAnnotationRegion) : a,
			);
			setDocument({ ...document, annotations: next });
			void saveDocument({ ...document, annotations: next });
		},
		[document, selection.id, setDocument, saveDocument],
	);

	// Speed regions live outside the schema (`legacyEditor.speedRegions`, see
	// useTimeline.ts) — same escape hatch pattern, so patch it directly here.
	const patchSpeed = useCallback(
		(speed: number) => {
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = ((legacy.speedRegions as unknown[]) ?? []) as Array<{
				id: string;
				startMs: number;
				endMs: number;
				speed: number;
			}>;
			const next = {
				...document,
				legacyEditor: {
					...legacy,
					speedRegions: prev.map((s) => (s.id === selection.id ? { ...s, speed } : s)),
				},
			};
			setDocument(next);
			void saveDocument(next);
		},
		[document, selection.id, setDocument, saveDocument],
	);

	return (
		<div style={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
			<header className={styles.paneHead}>
				<h2>{kindLabel(selection.kind)}</h2>
				<span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
					<button
						type="button"
						className={styles.iconBtn}
						title="Deselect"
						aria-label="Deselect"
						onClick={onClear}
					>
						×
					</button>
				</span>
			</header>
			<div className={styles.paneBody}>
				{selection.kind === "zoom" ? (
					<>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "repeat(3, 1fr)",
								gap: 6,
								marginBottom: 12,
							}}
						>
							{depthNames.map((label, i) => (
								<button
									type="button"
									key={label}
									onClick={() => {
										if (!region) return;
										const next = document.zoomRanges.map((z) =>
											z.id === selection.id
												? { ...z, depth: (i + 1) as 1 | 2 | 3 | 4 | 5 | 6, customScale: undefined }
												: z,
										) as AxcutDocument["zoomRanges"];
										// ponytail: single discrete click — go through editor
										// mutation/undo path. Persist immediately to disk.
										setDocument({ ...document, zoomRanges: next });
										void saveDocument({ ...document, zoomRanges: next });
									}}
									style={{
										padding: "6px 8px",
										border: `1px solid ${currentDepth === i ? "var(--accent)" : "var(--border)"}`,
										borderRadius: 8,
										background: currentDepth === i ? "var(--accent-wash)" : "var(--bg)",
										color: "var(--fg-2)",
										font: "500 12px/1 var(--font-mono)",
										cursor: "pointer",
									}}
								>
									{label}
								</button>
							))}
						</div>
						<Field label={`Scale — ${effectiveZoomScale.toFixed(2)}×`}>
							<input
								type="range"
								min={MIN_ZOOM_SCALE}
								max={MAX_ZOOM_SCALE}
								step={0.01}
								value={effectiveZoomScale}
								onChange={(e) => {
									if (!region) return;
									const scale = Number(e.target.value);
									const next = document.zoomRanges.map((z) =>
										z.id === selection.id ? { ...z, customScale: scale } : z,
									) as AxcutDocument["zoomRanges"];
									// ponytail: live-only while dragging — mirrors the
									// zoom-focus-overlay drag fix (setDocument, no IPC
									// save, per pixel). Commits on release below.
									setDocument({ ...document, zoomRanges: next });
								}}
								onMouseUp={() => void saveDocument(document)}
								onTouchEnd={() => void saveDocument(document)}
								style={{ width: "100%" }}
							/>
						</Field>
						{region ? (
							<div
								style={{
									font: "500 11px/1.4 var(--font-mono)",
									color: "var(--muted)",
									padding: "0 4px",
								}}
							>
								{Math.round((region as { startMs: number }).startMs)}ms —{" "}
								{Math.round((region as { endMs: number }).endMs)}ms
							</div>
						) : null}
					</>
				) : selection.kind === "annotation" ? (
					annot ? (
						<>
							<textarea
								value={textDraft}
								onChange={(e) => setTextDraft(e.target.value)}
								onBlur={flushText}
								style={{
									width: "100%",
									minHeight: 80,
									padding: "8px 10px",
									border: "1px solid var(--border)",
									borderRadius: 8,
									background: "var(--bg)",
									color: "var(--fg-2)",
									font: "400 13px/1.5 var(--font-body)",
									outline: "none",
									resize: "vertical",
								}}
							/>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									marginTop: 4,
									marginBottom: 12,
								}}
							>
								<span>{annot.type}</span>
								<span style={{ font: "500 10px/1 var(--font-mono)", color: "var(--muted)" }}>
									{Math.round(annot.startMs)}ms — {Math.round(annot.endMs)}ms
								</span>
							</div>
							<Field label="Text color">
								<input
									type="color"
									value={annot.style?.color ?? "#ffffff"}
									onChange={(e) => {
										const next = document.annotations.map((a) =>
											a.id === selection.id
												? { ...a, style: { ...a.style, color: e.target.value } }
												: a,
										);
										setDocument({ ...document, annotations: next });
										void saveDocument({ ...document, annotations: next });
									}}
									style={{
										width: "100%",
										height: 32,
										border: "1px solid var(--border)",
										borderRadius: 6,
										background: "var(--bg)",
									}}
								/>
							</Field>
							<Field label="Font size">
								<select
									value={String(annot.style?.fontSize ?? 32)}
									onChange={(e) => {
										const next = document.annotations.map((a) =>
											a.id === selection.id
												? { ...a, style: { ...a.style, fontSize: Number(e.target.value) } }
												: a,
										);
										setDocument({ ...document, annotations: next });
										void saveDocument({ ...document, annotations: next });
									}}
									style={selectStyle()}
								>
									{[12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 128].map(
										(n) => (
											<option key={n} value={n}>
												{n} px
											</option>
										),
									)}
								</select>
							</Field>
							<Field label="Animation">
								<select
									value={annot.style?.textAnimation ?? "none"}
									onChange={(e) => {
										const next = document.annotations.map((a) =>
											a.id === selection.id
												? {
														...a,
														style: { ...a.style, textAnimation: e.target.value as never },
													}
												: a,
										);
										setDocument({ ...document, annotations: next });
										void saveDocument({ ...document, annotations: next });
									}}
									style={selectStyle()}
								>
									{["none", "fade", "rise", "pop", "slide-left", "typewriter", "pulse"].map((a) => (
										<option key={a} value={a}>
											{a}
										</option>
									))}
								</select>
							</Field>
							<Field label="Font family">
								<select
									value={annot.style?.fontFamily ?? "Inter"}
									onChange={(e) =>
										patchAnnotation((a) => ({
											...a,
											style: { ...a.style, fontFamily: e.target.value },
										}))
									}
									style={selectStyle()}
								>
									<option value="Inter">Inter</option>
									<option value="JetBrains Mono">Mono</option>
									<option value="Georgia">Serif</option>
								</select>
							</Field>
							{annot.type === "figure" ? (
								<>
									<Field label="Arrow direction">
										<select
											value={annot.figureData?.arrowDirection ?? "right"}
											onChange={(e) =>
												patchAnnotation((a) => ({
													...a,
													figureData: {
														arrowDirection: e.target.value as NonNullable<
															AxcutAnnotationRegion["figureData"]
														>["arrowDirection"],
														color: a.figureData?.color ?? "#34B27B",
														strokeWidth: a.figureData?.strokeWidth ?? 4,
													},
												}))
											}
											style={selectStyle()}
										>
											{[
												"up",
												"down",
												"left",
												"right",
												"up-right",
												"up-left",
												"down-right",
												"down-left",
											].map((d) => (
												<option key={d} value={d}>
													{d}
												</option>
											))}
										</select>
									</Field>
									<Field label={`Stroke width — ${annot.figureData?.strokeWidth ?? 4}px`}>
										<input
											type="range"
											min={1}
											max={16}
											step={1}
											value={annot.figureData?.strokeWidth ?? 4}
											onChange={(e) =>
												patchAnnotation((a) => ({
													...a,
													figureData: {
														arrowDirection: a.figureData?.arrowDirection ?? "right",
														color: a.figureData?.color ?? "#34B27B",
														strokeWidth: Number(e.target.value),
													},
												}))
											}
											style={{ width: "100%" }}
										/>
									</Field>
								</>
							) : null}
							{annot.type === "blur" ? (
								<>
									<Field label="Mode">
										<select
											value={annot.blurData?.type ?? "mosaic"}
											onChange={(e) =>
												patchAnnotation((a) => ({
													...a,
													blurData: {
														type: e.target.value as "blur" | "mosaic",
														shape: a.blurData?.shape ?? "rectangle",
														color: a.blurData?.color ?? "white",
														intensity: a.blurData?.intensity ?? 12,
														blockSize: a.blurData?.blockSize ?? 12,
													},
												}))
											}
											style={selectStyle()}
										>
											<option value="mosaic">Mosaic</option>
											<option value="blur">Blur</option>
										</select>
									</Field>
									{(annot.blurData?.type ?? "mosaic") === "blur" ? (
										<Field label={`Blur radius — ${annot.blurData?.intensity ?? 12}px`}>
											<input
												type="range"
												min={2}
												max={40}
												step={1}
												value={annot.blurData?.intensity ?? 12}
												onChange={(e) =>
													patchAnnotation((a) => ({
														...a,
														blurData: {
															type: a.blurData?.type ?? "mosaic",
															shape: a.blurData?.shape ?? "rectangle",
															color: a.blurData?.color ?? "white",
															intensity: Number(e.target.value),
															blockSize: a.blurData?.blockSize ?? 12,
														},
													}))
												}
												style={{ width: "100%" }}
											/>
										</Field>
									) : (
										<Field label={`Mosaic size — ${annot.blurData?.blockSize ?? 12}px`}>
											<input
												type="range"
												min={4}
												max={48}
												step={2}
												value={annot.blurData?.blockSize ?? 12}
												onChange={(e) =>
													patchAnnotation((a) => ({
														...a,
														blurData: {
															type: a.blurData?.type ?? "mosaic",
															shape: a.blurData?.shape ?? "rectangle",
															color: a.blurData?.color ?? "white",
															intensity: a.blurData?.intensity ?? 12,
															blockSize: Number(e.target.value),
														},
													}))
												}
												style={{ width: "100%" }}
											/>
										</Field>
									)}
								</>
							) : null}
						</>
					) : null
				) : selection.kind === "skip" ? (
					<div
						style={{ font: "500 12px var(--font-body)", color: "var(--muted)", padding: "0 4px" }}
					>
						Trim region — drag the handles in the timeline to resize. Press Del to remove the cut.
					</div>
				) : region ? (
					<>
						<div
							style={{
								font: "500 11px/1.4 var(--font-mono)",
								color: "var(--muted)",
								padding: "0 4px",
								marginBottom: 8,
							}}
						>
							{Math.round((region as { startMs: number }).startMs)}ms —{" "}
							{Math.round((region as { endMs: number }).endMs)}ms
						</div>
						<Field label={`Speed — ${speedValue}×`}>
							<div
								style={{
									display: "grid",
									gridTemplateColumns: "repeat(5, 1fr)",
									gap: 6,
									marginBottom: 8,
								}}
							>
								{SPEED_OPTIONS.map((option) => (
									<button
										type="button"
										key={option.label}
										onClick={() => patchSpeed(option.speed)}
										style={{
											padding: "6px 4px",
											border: `1px solid ${speedValue === option.speed ? "var(--accent)" : "var(--border)"}`,
											borderRadius: 8,
											background: speedValue === option.speed ? "var(--accent-wash)" : "var(--bg)",
											color: "var(--fg-2)",
											font: "500 11px/1 var(--font-mono)",
											cursor: "pointer",
										}}
									>
										{option.label}
									</button>
								))}
							</div>
							<input
								type="text"
								inputMode="decimal"
								placeholder={`${speedValue}×`}
								value={speedDraft}
								onChange={(e) => setSpeedDraft(e.target.value)}
								onBlur={() => {
									const result = parseCustomPlaybackSpeedInput(speedDraft);
									if (result.status === "valid") patchSpeed(result.speed);
									else {
										if (result.status === "too-fast") toast.error("Speed can't exceed 16×.");
										setSpeedDraft(
											SPEED_OPTIONS.some((o) => o.speed === speedValue) ? "" : String(speedValue),
										);
									}
								}}
								onKeyDown={(e) => {
									if (e.key !== "Enter") return;
									const result = parseCustomPlaybackSpeedInput(speedDraft);
									if (result.status === "valid") patchSpeed(result.speed);
									else if (result.status === "too-fast") toast.error("Speed can't exceed 16×.");
									e.currentTarget.blur();
								}}
								style={{ width: "100%" }}
							/>
						</Field>
					</>
				) : null}
				<button
					type="button"
					onClick={() => onRemove(selection.kind, selection.id)}
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						gap: 6,
						width: "100%",
						marginTop: 16,
						padding: "10px 12px",
						border: "1px solid var(--danger)",
						borderRadius: 8,
						background: "var(--danger-soft)",
						color: "var(--danger)",
						font: "600 13px/1 var(--font-body)",
						cursor: "pointer",
					}}
				>
					<Trash2 size={14} />
					Delete {kindLabel(selection.kind).toLowerCase()}
				</button>
			</div>
		</div>
	);
}

function kindLabel(kind: RegionKind): string {
	switch (kind) {
		case "zoom":
			return "Zoom region";
		case "skip":
			return "Trim region";
		case "annotation":
			return "Annotation";
		case "speed":
			return "Speed region";
	}
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div style={{ marginBottom: 8 }}>
			<div
				style={{
					font: "500 10px/1 var(--font-mono)",
					color: "var(--muted)",
					textTransform: "uppercase",
					letterSpacing: "0.06em",
					marginBottom: 4,
				}}
			>
				{label}
			</div>
			{children}
		</div>
	);
}

function selectStyle(): React.CSSProperties {
	return {
		width: "100%",
		padding: "6px 8px",
		border: "1px solid var(--border)",
		borderRadius: 6,
		background: "var(--bg)",
		color: "var(--fg-2)",
		font: "500 12px var(--font-body)",
	};
}
