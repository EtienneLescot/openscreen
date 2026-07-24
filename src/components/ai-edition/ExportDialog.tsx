// Export dialog for the new editor. Wires together:
// 1. pickExportSavePath (native save dialog)
// 2. exportAxcutDocument (renders frames + muxes mp4/gif)
// 3. writeExportToPath (writes the resulting buffer to disk)
//
// Format/quality/GIF options live in the dialog's local state. The
// legacy `ExportDialog` (in components/video-editor) is the rich version
// used by the legacy VideoEditor; this one is a compact surface tuned for
// the new shell's modal style.

import { Download, FileVideo, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import {
	collectEffectiveClipDims,
	type Dims,
	pickExtremeDims,
	resolveAspectRatioValue,
} from "@/lib/ai-edition/document/outputFormat";
import {
	type DocumentExportOptions,
	type ExportVideoCodec,
	exportAxcutDocument,
} from "@/lib/ai-edition/exporter/documentExporter";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { resolveClipSourceEndSec } from "@/lib/ai-edition/timeline/clipDuration";
import {
	type ExportFormat,
	type ExportProgress,
	type ExportQuality,
	GIF_FRAME_RATES,
	GIF_SIZE_PRESETS,
	type GifFrameRate,
	type GifSizePreset,
} from "@/lib/exporter";
import { calculateMp4ExportSettings } from "@/lib/exporter/mp4ExportSettings";
import { exportMultiNative, exportNative } from "@/native";
import { nativeBridgeClient } from "@/native/client";
import type { CompositorClipInput } from "@/native/contracts";
import { buildSceneDescription, resolveVisibleClips } from "@/native/sceneDescription";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

type Phase = "idle" | "configuring" | "rendering" | "writing" | "done" | "error";

/** hh:mm:ss (always shows hours, unlike the shared mm:ss `formatTimePadded`) — exports can run
 *  past an hour on either axis (video duration or render wall-time). */
function formatHms(totalSeconds: number): string {
	const s = Math.max(0, Math.round(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return [h, m, sec].map((v) => v.toString().padStart(2, "0")).join(":");
}

/** Maps the document's timeline to the native multiclip export contract: ordered,
 *  trim-narrowed clips (`resolveVisibleClips` — shared with `buildSceneDescription` and
 *  `NativeCompositorOverlay`, so export/preview/scene all see the exact same clip stream),
 *  each with its asset's screen file + camera file (falls back to the screen when a clip has
 *  no camera — the no-webcam layout is a later step) and its source trim. */
function buildNativeClipList(document: AxcutDocument): CompositorClipInput[] {
	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	return resolveVisibleClips(document).flatMap((clip) => {
		const asset = assetById.get(clip.assetId);
		if (!asset?.originalPath) {
			return [];
		}
		const cam = asset.cameraTrack;
		// sourceEndSec is optional in the schema (unknown until probed) — fall back through
		// the single canonical precedence used by every consumer (clip.probe → asset.duration
		// → timeline-length guess). See `resolveClipSourceEndSec` for the full order.
		const sourceEndSec = resolveClipSourceEndSec(clip, asset);
		// ponytail: matches the rule in `buildSceneDescription` — screen recordings
		// from this app always carry a decodable audio track (the webcam path
		// never does), so the only clips that reach this branch already have audio.
		// If a per-asset audio-probe flag lands on the schema later, swap to
		// `Boolean(asset.audio)` here too and keep these two derivation paths in
		// lock-step with `buildSceneDescription` in src/native/sceneDescription.ts.
		return [
			{
				screenPath: asset.originalPath,
				webcamPath: cam?.sourcePath ?? asset.originalPath,
				sourceStartSec: clip.sourceStartSec,
				sourceEndSec,
				webcamOffsetSec: cam ? (cam.startMs + cam.offsetMs) / 1000 : 0,
				hasAudio: true,
			},
		];
	});
}

// Target short side (px) for the two fixed quality tiers -- mirrors the legacy
// editor's SettingsPanel (MP4_EXPORT_SHORT_SIDES), used only to decide whether
// picking that tier would upscale past the source's actual resolution.
const MEDIUM_SHORT_SIDE = 720;
const HIGH_SHORT_SIDE = 1080;

const QUALITY_OPTIONS: Array<{
	value: ExportQuality;
	labelKey: string;
	/** Target short side for the upscale check; undefined for "source" (no fixed target). */
	targetShortSide?: number;
}> = [
	{ value: "medium", labelKey: "exportQuality.low", targetShortSide: MEDIUM_SHORT_SIDE },
	{ value: "good", labelKey: "exportQuality.medium", targetShortSide: HIGH_SHORT_SIDE },
	{ value: "source", labelKey: "exportQuality.high" },
];

interface ExportDialogProps {
	open: boolean;
	onClose: () => void;
	document: AxcutDocument | null;
}

export function ExportDialog({ open, onClose, document }: ExportDialogProps) {
	const t = useScopedT("editor");
	const ts = useScopedT("settings");
	const [format, setFormat] = useState<ExportFormat>("mp4");
	const [quality, setQuality] = useState<ExportQuality>("good");
	const [fps, setFps] = useState<24 | 30 | 60>(60);
	const [codec, setCodec] = useState<ExportVideoCodec>("h264");
	const [gifFrameRate, setGifFrameRate] = useState<GifFrameRate>(15);
	const [gifSize, setGifSize] = useState<GifSizePreset>("medium");
	const [gifLoop, setGifLoop] = useState(true);
	const [phase, setPhase] = useState<Phase>("idle");
	const [progress, setProgress] = useState<ExportProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [savedPath, setSavedPath] = useState<string | null>(null);
	const cancelRef = useRef<{ cancel: () => void } | null>(null);

	// (Old behavior: the native compositor overlay used to be a top-level OS window outside the
	//  Chromium surface, so we'd hide it here to put this modal in front. The compositor now
	//  streams into a normal `<canvas>` inside the DOM — CSS z-index handles stacking naturally
	//  and there's no OS window to hide. The hide/show dance is now dead code; removed.)

	// Source dimensions come straight off `asset.video`. This dialog used to probe missing ones
	// into local state as a fallback for recordings that were never probed; `useTimeline` now
	// backfills them on editor load (before this dialog can open) and persists them, so every
	// consumer reads the one populated source instead of each re-probing on its own.
	const primaryAsset = useMemo(
		() =>
			document
				? (document.assets.find((a) => a.id === document.project.primaryAssetId) ??
					document.assets[0])
				: null,
		[document],
	);

	// Per-clip EFFECTIVE (post-crop) dims — single source of truth for both the "largest"
	// and "smallest" picks below, computed once instead of two near-identical hand-rolled
	// reduce+fallback loops. Crop is per-clip, so this must iterate clips, not assets: the
	// same recording can be cropped differently in two different clips on the timeline.
	const effectiveClipDims = useMemo<Dims[]>(
		() => (document ? collectEffectiveClipDims(document) : []),
		[document],
	);
	// Largest clip's true (cropped) footprint — used only by the GIF export path below (its
	// own, separate sizing option), which sizes to the best available footage the same way
	// this dialog always has.
	const referenceSource = useMemo(
		() => pickExtremeDims(effectiveClipDims, "largest"),
		[effectiveClipDims],
	);

	// Smallest clip's true (cropped) footprint on the timeline — a multiclip timeline can mix
	// crops/resolutions, so this is what "Source" quality actually targets: sizing to the
	// SMALLEST clip's own resolution means no clip on the timeline is ever upscaled past its
	// true footprint by picking Source, which is why Source shows no upscale/downscale badge
	// at all any more (see the tier badges below) — it's upscale-proof by construction. The
	// fixed 720p/1080p tiers don't have that property (they can still upscale a small clip),
	// so `smallestShortSide` below still feeds their upscale badge.
	const smallestSource = useMemo(
		() => pickExtremeDims(effectiveClipDims, "smallest"),
		[effectiveClipDims],
	);
	const smallestShortSide = smallestSource
		? Math.min(smallestSource.width, smallestSource.height)
		: null;

	// Aspect the export normalizes to: the timeline's selected ratio (mirrors documentExporter),
	// so the sizes shown match what the export produces. Read through `getEditorSettings` — the
	// same typed façade the ratio dropdown writes through and `buildSceneDescription` reads — so
	// this dialog can't drift from the compositor if the storage ever moves. `resolveAspectRatioValue`
	// owns the legacy "native" case (uncropped reference asset), previously hand-rolled here.
	const EXPORT_ASPECT = useMemo(
		() => resolveAspectRatioValue(document, getEditorSettings(document).aspectRatio),
		[document],
	);
	// Output dimensions the export will produce for a given tier, from the (crop-aware)
	// SMALLEST clip on the timeline — see `smallestSource` above for why. Only "Source"
	// quality actually uses these as its target size; 720p/1080p target a fixed short side
	// regardless (`calculateDimensionsForShortSide`), so this only changes what "Source"
	// resolves to.
	const tierOutputDims = (value: ExportQuality) =>
		smallestSource
			? calculateMp4ExportSettings({
					quality: value,
					sourceWidth: smallestSource.width,
					sourceHeight: smallestSource.height,
					aspectRatioValue: EXPORT_ASPECT,
				})
			: null;

	useEffect(() => {
		if (!open) {
			setPhase("idle");
			setProgress(null);
			setError(null);
			setSavedPath(null);
			cancelRef.current = null;
		}
	}, [open]);

	const handleClose = () => {
		if (phase === "rendering" || phase === "writing") return;
		onClose();
	};

	const handleStart = async () => {
		if (!document) return;
		const asset = primaryAsset;
		if (!asset) {
			setError(t("exportDialog.addVideoBeforeExporting"));
			setPhase("error");
			return;
		}

		const safeName = (document.project.title || "OpenScreen")
			.replace(/[^a-z0-9-_]+/gi, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 60);
		const suggested = `${safeName || "export"}${format === "gif" ? ".gif" : ".mp4"}`;

		setPhase("configuring");
		setError(null);
		setProgress(null);
		setSavedPath(null);

		let pickedPath: string | undefined;
		try {
			const picker = await window.electronAPI?.pickExportSavePath?.(suggested);
			pickedPath = picker && "path" in picker ? picker.path : undefined;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
			return;
		}
		if (!pickedPath) {
			setPhase("idle");
			return;
		}

		// MP4: the native D3D exporter is the only path (no CPU/web fallback — that
		// path silently regressed to an ultra-slow CPU render once, which is exactly
		// the failure mode a flag-gated fallback invites). Background/layout/webcam/
		// cursor/effects come from the same scene as the live preview.
		if (format === "mp4") {
			setPhase("rendering");
			// Render the real timeline when there are clips; else fall back to the fixture.
			const clips = buildNativeClipList(document);
			// Total frames the encoder will produce, known upfront from the timeline (sum of
			// each clip's trimmed source duration) — the native side only reports frames
			// AFTER encoding one (onNativeExportProgress), it doesn't know/send a total, so
			// this is computed here to turn that raw count into a percentage.
			const totalDurationSec = clips.reduce(
				(sum, c) => sum + Math.max(0, c.sourceEndSec - c.sourceStartSec),
				0,
			);
			const totalFrames = Math.max(1, Math.round(totalDurationSec * fps));
			const startedAt = Date.now();
			const unsubscribeProgress = window.electronAPI?.onNativeExportProgress?.((frames) => {
				const elapsedS = (Date.now() - startedAt) / 1000;
				const fractionDone = Math.min(1, frames / totalFrames);
				const estimatedTimeRemaining = fractionDone > 0 ? elapsedS / fractionDone - elapsedS : 0;
				setProgress({
					currentFrame: frames,
					totalFrames,
					percentage: fractionDone * 100,
					estimatedTimeRemaining,
				});
			});
			try {
				const sceneJson = JSON.stringify(buildSceneDescription(document));
				const outDims = tierOutputDims(quality);
				const stats =
					clips.length > 0
						? await exportMultiNative(clips, pickedPath, sceneJson, {
								width: outDims?.width,
								height: outDims?.height,
								fps,
								codec,
							})
						: await exportNative(pickedPath);
				setSavedPath(pickedPath);
				setPhase("done");
				toast.success(t("exportDialog.exportedVideo"), {
					description: `${pickedPath} · ${formatHms(stats.videoDurationS)} ${t("exportDialog.exportedVideoOf")} ${formatHms(stats.wallS)}`,
					action: {
						label: t("exportDialog.showInFolder"),
						onClick: () => {
							void window.electronAPI?.revealInFolder?.(pickedPath);
						},
					},
				});
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setPhase("error");
				toast.error(t("exportDialog.exportFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			} finally {
				unsubscribeProgress?.();
			}
			return;
		}

		// GIF: no native encoder for this format yet, so this is the only
		// implementation — not a fallback for MP4, a distinct code path.
		setPhase("rendering");
		const options: DocumentExportOptions = {
			format,
			quality,
			frameRate: fps,
			codec,
			gifFrameRate,
			gifLoop,
			gifSizePreset: gifSize,
			// Size the output to the largest clip on the timeline (see referenceSource),
			// not just the primary asset, so "Source" matches the shown size.
			sourceWidth: referenceSource?.width ?? asset.video?.width,
			sourceHeight: referenceSource?.height ?? asset.video?.height,
			onProgress: (p) => setProgress(p),
		};

		try {
			const result = await exportAxcutDocument(document, options);
			if (!result.success || !result.blob) {
				throw new Error(result.error ?? t("exportDialog.exportFailed"));
			}
			setPhase("writing");
			const arrayBuffer = await result.blob.arrayBuffer();
			const writeResult = await window.electronAPI?.writeExportToPath?.(arrayBuffer, pickedPath);
			if (!writeResult?.success) {
				throw new Error(writeResult?.error ?? t("exportDialog.failedToWriteFile"));
			}
			setSavedPath(pickedPath);
			setPhase("done");
			toast.success(t("exportDialog.exportedGif"), {
				description: pickedPath,
				action: {
					label: t("exportDialog.showInFolder"),
					onClick: () => {
						void window.electronAPI?.revealInFolder?.(pickedPath);
					},
				},
			});
			// Touch the bridge so it stays referenced even when export
			// is invoked from a non-Electron shim.
			void nativeBridgeClient.aiEdition.llmGetSnapshot;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
			toast.error(t("exportDialog.exportFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const isBusy = phase === "rendering" || phase === "writing" || phase === "configuring";
	const pct = progress?.percentage ?? 0;
	const gifSizeLabel = GIF_SIZE_PRESETS[gifSize].label;

	return (
		<ModalShell
			open={open}
			onClose={handleClose}
			title={t("exportDialog.title")}
			subtitle={t("exportDialog.subtitle")}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr 1fr",
						gap: 8,
					}}
				>
					<FormatToggle
						active={format === "mp4"}
						label={ts("exportFormat.mp4")}
						icon={<FileVideo size={18} />}
						onClick={() => setFormat("mp4")}
						disabled={isBusy}
					/>
					<FormatToggle
						active={format === "gif"}
						label={ts("exportFormat.gif")}
						icon={<Download size={18} />}
						onClick={() => setFormat("gif")}
						disabled={isBusy}
					/>
				</div>

				{format === "mp4" ? (
					<section>
						<div
							style={{
								font: "500 11px/1 var(--font-body)",
								textTransform: "uppercase",
								letterSpacing: "0.06em",
								color: "var(--muted)",
								marginBottom: 8,
							}}
						>
							{t("exportDialog.quality")}
						</div>
						<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
							{QUALITY_OPTIONS.map((q) => (
								<button
									type="button"
									key={q.value}
									disabled={isBusy}
									onClick={() => setQuality(q.value)}
									style={{
										display: "flex",
										flexDirection: "column",
										gap: 2,
										padding: "10px 12px",
										border: `1px solid ${quality === q.value ? "var(--accent)" : "var(--border)"}`,
										borderRadius: 10,
										background: quality === q.value ? "var(--accent-wash)" : "var(--surface)",
										color: "var(--fg-2)",
										cursor: "pointer",
										font: "500 13px/1 var(--font-body)",
									}}
								>
									<span style={{ color: "var(--fg)", fontWeight: 600 }}>{ts(q.labelKey)}</span>
									{(() => {
										const dims = tierOutputDims(q.value);
										if (!dims) return null;
										// Downscale badge removed everywhere — restated what picking a lower
										// tier already means, not actionable. Upscale badge removed only for
										// "Source": it's upscale-proof by construction now (targets the
										// smallest clip), so the warning never meant anything there. The fixed
										// 720p/1080p tiers can still genuinely upscale a small clip, so that
										// badge stays relevant for them.
										const outShortSide = Math.min(dims.width, dims.height);
										const isUpscale =
											q.value !== "source" &&
											smallestShortSide !== null &&
											outShortSide > smallestShortSide;
										return (
											<span
												style={{
													font: "500 11px var(--font-body)",
													color: isUpscale ? "var(--warn)" : "var(--muted)",
												}}
											>
												{dims.width} × {dims.height}
												{isUpscale ? ` · ${t("exportDialog.qualityUpscaleWarning")}` : ""}
											</span>
										);
									})()}
								</button>
							))}
						</div>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "1fr 1fr",
								gap: 12,
								marginTop: 12,
							}}
						>
							<div>
								<div
									style={{
										font: "500 11px/1 var(--font-body)",
										textTransform: "uppercase",
										letterSpacing: "0.06em",
										color: "var(--muted)",
										marginBottom: 8,
									}}
								>
									{t("exportDialog.frameRate")}
								</div>
								<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
									{([24, 30, 60] as const).map((r) => (
										<button
											type="button"
											key={r}
											disabled={isBusy}
											onClick={() => setFps(r)}
											style={segStyle(fps === r)}
										>
											{r}
										</button>
									))}
								</div>
							</div>
							<div>
								<div
									style={{
										font: "500 11px/1 var(--font-body)",
										textTransform: "uppercase",
										letterSpacing: "0.06em",
										color: "var(--muted)",
										marginBottom: 8,
									}}
								>
									{t("exportDialog.codec")}
								</div>
								<div
									style={{
										display: "grid",
										gridTemplateColumns: "repeat(2, 1fr)",
										gap: 6,
									}}
								>
									{(
										[
											["h264", "H.264"],
											["h265", "H.265"],
											// VP9 has no AMF hardware encoder on this GPU — the native pipeline
											// (the only MP4 export path now) rejects it outright (tested: a
											// software libvpx-vp9 fallback worked but was too slow to ship).
											// Hidden here rather than left selectable-then-erroring.
										] as Array<[ExportVideoCodec, string]>
									).map(([value, label]) => (
										<button
											type="button"
											key={value}
											disabled={isBusy}
											onClick={() => setCodec(value)}
											style={segStyle(codec === value)}
											title={
												value === "h264"
													? t("exportDialog.codecBestCompatibility")
													: t("exportDialog.codecMaySupportVary")
											}
										>
											{label}
										</button>
									))}
								</div>
							</div>
						</div>
					</section>
				) : (
					<section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
						<div>
							<div
								style={{
									font: "500 11px/1 var(--font-body)",
									textTransform: "uppercase",
									letterSpacing: "0.06em",
									color: "var(--muted)",
									marginBottom: 8,
								}}
							>
								{t("exportDialog.frameRate")}
							</div>
							<div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
								{GIF_FRAME_RATES.map((r) => (
									<button
										type="button"
										key={r.value}
										disabled={isBusy}
										onClick={() => setGifFrameRate(r.value)}
										style={segStyle(gifFrameRate === r.value)}
									>
										{r.value} FPS
									</button>
								))}
							</div>
						</div>
						<div>
							<div
								style={{
									font: "500 11px/1 var(--font-body)",
									textTransform: "uppercase",
									letterSpacing: "0.06em",
									color: "var(--muted)",
									marginBottom: 8,
								}}
							>
								{t("exportDialog.size")}
							</div>
							<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
								{(Object.keys(GIF_SIZE_PRESETS) as GifSizePreset[]).map((s) => (
									<button
										type="button"
										key={s}
										disabled={isBusy}
										onClick={() => setGifSize(s)}
										style={segStyle(gifSize === s)}
									>
										{GIF_SIZE_PRESETS[s].label}
									</button>
								))}
							</div>
						</div>
						<div className={styles.paneRow} style={{ margin: 0 }}>
							<span className="label">{t("exportDialog.loopGif")}</span>
							<button
								type="button"
								className={`${styles.toggle} ${gifLoop ? styles.isOn : ""}`}
								aria-pressed={gifLoop}
								disabled={isBusy}
								onClick={() => setGifLoop((v) => !v)}
							/>
						</div>
						<div
							style={{
								font: "500 11px/1.4 var(--font-mono)",
								color: "var(--muted)",
								letterSpacing: "0.04em",
							}}
						>
							{gifFrameRate} FPS · {gifSizeLabel} ·{" "}
							{gifLoop ? t("exportDialog.loopOn") : t("exportDialog.loopOff")}
						</div>
					</section>
				)}

				<ProgressBlock
					phase={phase}
					progress={progress}
					error={error}
					pct={pct}
					savedPath={savedPath}
				/>

				<div
					style={{
						display: "flex",
						justifyContent: "flex-end",
						gap: 8,
						paddingTop: 12,
						borderTop: "1px solid var(--border-soft)",
					}}
				>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={handleClose}
						disabled={isBusy}
					>
						{phase === "done" ? t("exportDialog.close") : t("exportDialog.cancel")}
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={handleStart}
						disabled={isBusy || !document}
					>
						{isBusy ? (
							<>
								<Loader2 size={14} className="animate-spin" />
								{phase === "rendering"
									? t("exportDialog.rendering")
									: phase === "writing"
										? t("exportDialog.saving")
										: t("exportDialog.starting")}
							</>
						) : (
							<>
								<Download size={14} />
								{format === "gif" ? t("exportDialog.exportGif") : t("exportDialog.exportMp4")}
							</>
						)}
					</button>
				</div>
			</div>
		</ModalShell>
	);
}

function FormatToggle({
	active,
	label,
	icon,
	onClick,
	disabled,
}: {
	active: boolean;
	label: string;
	icon: React.ReactNode;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 8,
				padding: "12px 16px",
				border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
				borderRadius: 10,
				background: active ? "var(--accent-wash)" : "var(--surface)",
				// Selection is conveyed by border + wash background (like the quality
				// cards below), not by swapping text color -- `--accent-on` is meant
				// for text on a SOLID accent fill, and paired with the near-transparent
				// `--accent-wash` it read as near-invisible dark-on-dark text.
				color: "var(--fg)",
				cursor: "pointer",
				font: "600 14px/1 var(--font-body)",
			}}
		>
			{icon}
			{label}
		</button>
	);
}

function ProgressBlock({
	phase,
	progress,
	error,
	pct,
	savedPath,
}: {
	phase: Phase;
	progress: ExportProgress | null;
	error: string | null;
	pct: number;
	savedPath: string | null;
}) {
	const t = useScopedT("editor");
	if (phase === "idle" || phase === "configuring") {
		return (
			<div
				style={{
					padding: "16px",
					border: "1px solid var(--border)",
					borderRadius: 10,
					background: "var(--surface-1)",
					color: "var(--muted)",
					font: "500 12px var(--font-body)",
					textAlign: "center",
				}}
			>
				{t("exportDialog.pickFormatAndExport")}
			</div>
		);
	}
	if (phase === "done") {
		return (
			<div
				style={{
					padding: "16px",
					border: "1px solid var(--brand)",
					borderRadius: 10,
					background: "var(--success-soft)",
					color: "var(--fg-2)",
					font: "500 12px var(--font-body)",
				}}
			>
				{t("exportDialog.savedTo")}{" "}
				<span style={{ fontFamily: "var(--font-mono)" }}>{savedPath}</span>
			</div>
		);
	}
	if (phase === "error") {
		return (
			<div
				style={{
					padding: "16px",
					border: "1px solid var(--danger)",
					borderRadius: 10,
					background: "var(--danger-soft)",
					color: "var(--danger)",
					font: "500 12px var(--font-body)",
				}}
			>
				{error ?? t("exportDialog.exportFailedGeneric")}
			</div>
		);
	}
	const current = progress?.currentFrame ?? 0;
	const total = progress?.totalFrames ?? 0;
	const eta = progress?.estimatedTimeRemaining ?? 0;
	return (
		<div
			style={{
				padding: "12px 14px",
				border: "1px solid var(--border)",
				borderRadius: 10,
				background: "var(--surface-1)",
				display: "flex",
				flexDirection: "column",
				gap: 8,
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}
			>
				<span style={{ font: "500 12px var(--font-body)", color: "var(--fg-2)" }}>
					{phase === "writing" ? t("exportDialog.writingFile") : t("exportDialog.renderingFrames")}
				</span>
				<span
					style={{
						font: "500 12px/1 var(--font-mono)",
						color: "var(--brand)",
					}}
				>
					{Math.round(pct)}%
				</span>
			</div>
			<div
				style={{
					position: "relative",
					height: 8,
					background: "var(--surface-3)",
					borderRadius: 999,
					overflow: "hidden",
				}}
			>
				<div
					style={{
						position: "absolute",
						inset: 0,
						width: `${Math.max(0, Math.min(100, pct))}%`,
						background: "var(--brand)",
						transition: "width 200ms var(--ease)",
					}}
				/>
			</div>
			<div
				style={{
					font: "500 11px/1.4 var(--font-mono)",
					color: "var(--muted)",
					letterSpacing: "0.04em",
				}}
			>
				{total > 0
					? t("exportDialog.framesEta", { current, total, eta: Math.max(0, Math.round(eta)) })
					: t("exportDialog.preparingEncoder")}
			</div>
		</div>
	);
}

function segStyle(active: boolean): React.CSSProperties {
	return {
		padding: "8px 10px",
		border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
		borderRadius: 8,
		background: active ? "var(--brand)" : "var(--bg)",
		color: active ? "var(--accent-on)" : "var(--fg-2)",
		cursor: "pointer",
		font: "500 12px/1 var(--font-body)",
	};
}
