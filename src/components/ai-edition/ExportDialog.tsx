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
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type DocumentExportOptions,
	type ExportVideoCodec,
	exportAxcutDocument,
} from "@/lib/ai-edition/exporter/documentExporter";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import {
	type ExportFormat,
	type ExportProgress,
	type ExportQuality,
	GIF_FRAME_RATES,
	GIF_SIZE_PRESETS,
	type GifFrameRate,
	type GifSizePreset,
} from "@/lib/exporter";
import { nativeBridgeClient } from "@/native/client";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

type Phase = "idle" | "configuring" | "rendering" | "writing" | "done" | "error";

const QUALITY_OPTIONS: Array<{
	value: ExportQuality;
	label: string;
	hint: string;
}> = [
	{ value: "medium", label: "720p", hint: "Smaller file" },
	{ value: "good", label: "1080p", hint: "Recommended" },
	{ value: "source", label: "Source", hint: "Match recording" },
];

interface ExportDialogProps {
	open: boolean;
	onClose: () => void;
	document: AxcutDocument | null;
}

export function ExportDialog({ open, onClose, document }: ExportDialogProps) {
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
		const asset =
			document.assets.find((a) => a.id === document.project.primaryAssetId) ?? document.assets[0];
		if (!asset) {
			setError("Add a video before exporting.");
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

		setPhase("rendering");
		const options: DocumentExportOptions = {
			format,
			quality,
			frameRate: fps,
			codec,
			gifFrameRate,
			gifLoop,
			gifSizePreset: gifSize,
			sourceWidth: asset.video?.width,
			sourceHeight: asset.video?.height,
			onProgress: (p) => setProgress(p),
		};

		try {
			const result = await exportAxcutDocument(document, options);
			if (!result.success || !result.blob) {
				throw new Error(result.error ?? "Export failed");
			}
			setPhase("writing");
			const arrayBuffer = await result.blob.arrayBuffer();
			const writeResult = await window.electronAPI?.writeExportToPath?.(arrayBuffer, pickedPath);
			if (!writeResult?.success) {
				throw new Error(writeResult?.error ?? "Failed to write file");
			}
			setSavedPath(pickedPath);
			setPhase("done");
			toast.success(`${format === "gif" ? "GIF" : "Video"} exported`, {
				description: pickedPath,
				action: {
					label: "Show in folder",
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
			toast.error("Export failed", {
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
			title="Export"
			subtitle="Render the timeline to a file"
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
						label="MP4"
						icon={<FileVideo size={18} />}
						onClick={() => setFormat("mp4")}
						disabled={isBusy}
					/>
					<FormatToggle
						active={format === "gif"}
						label="GIF"
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
							Quality
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
									<span style={{ color: "var(--fg)", fontWeight: 600 }}>{q.label}</span>
									<span style={{ font: "500 11px var(--font-body)", color: "var(--muted)" }}>
										{q.hint}
									</span>
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
									Frame rate
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
									Codec
								</div>
								<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
									{(
										[
											["h264", "H.264"],
											["h265", "H.265"],
											["vp9", "VP9"],
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
													? "Best compatibility"
													: "May not be supported by every system encoder"
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
								Frame rate
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
								Size
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
							<span className="label">Loop GIF</span>
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
							{gifFrameRate} FPS · {gifSizeLabel} · {gifLoop ? "Loop on" : "Loop off"}
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
						{phase === "done" ? "Close" : "Cancel"}
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
									? "Rendering…"
									: phase === "writing"
										? "Saving…"
										: "Starting…"}
							</>
						) : (
							<>
								<Download size={14} />
								Export {format === "gif" ? "GIF" : "MP4"}
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
				color: active ? "var(--accent-on)" : "var(--fg-2)",
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
				Pick a format and press Export to start.
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
				Saved to <span style={{ fontFamily: "var(--font-mono)" }}>{savedPath}</span>
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
				{error ?? "Export failed."}
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
					{phase === "writing" ? "Writing file…" : "Rendering frames"}
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
					? `${current} / ${total} frames · ETA ${Math.max(0, Math.round(eta))}s`
					: "Preparing encoder…"}
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
