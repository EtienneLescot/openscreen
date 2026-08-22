import { ArrowDown, Film, Plus, RotateCw, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import type { AxcutAsset, TranscriptLanguageCode } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	useAssetTranscriptions,
	useTranscriptionStore,
} from "@/lib/ai-edition/store/transcriptionStore";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import {
	languageLabel,
	sortedLanguageOptions,
} from "@/lib/ai-edition/transcription/languageLabels";
import type {
	AssetTranscriptionStatus,
	AssetTranscriptionView,
} from "@/lib/ai-edition/transcription/status";
import { formatBytes } from "@/utils/formatBytes";
import {
	TranscriptionProgressBar,
	TranscriptionStatusDot,
	useTranscriptionLabel,
} from "../TranscriptionStatus";
import styles from "./EditorShellV4.module.css";

const ASSET_MIME = "application/x-axcut-asset";
const THUMB_GRADIENTS = [
	"linear-gradient(135deg, #fb7185, #f97316)",
	"linear-gradient(135deg, #10b981, #0d986a)",
	"linear-gradient(135deg, #fbbf24, #f59e0b)",
	"linear-gradient(135deg, #38bdf8, #6366f1)",
];

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

export async function addSelectedAssetToTimeline(
	selected: Pick<AxcutAsset, "id" | "label" | "originalPath"> | null,
	onAddToTimeline: (assetId: string) => Promise<void>,
	onSuccess: (label: string) => void,
): Promise<void> {
	if (!selected) return;
	await onAddToTimeline(selected.id);
	onSuccess(selected.label || basename(selected.originalPath));
}

export function MediaStage({
	onAddToTimeline,
}: {
	onAddToTimeline: (assetId: string) => Promise<void>;
}) {
	const t = useScopedT("editor");
	const { locale } = useI18n();
	const projectId = useProjectStore((s) => s.projectId);
	const document = useProjectStore((s) => s.document);
	const addAsset = useProjectStore((s) => s.addAsset);
	// Transcripts are produced in the background as soon as a media lands here
	// (see transcriptionStore) — this stage only reports where each one is at,
	// and lets the user force a re-run in another language.
	const transcriptions = useAssetTranscriptions();
	const requestTranscription = useTranscriptionStore((s) => s.request);
	const transcriptionLabel = useTranscriptionLabel();
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [lang, setLang] = useState<TranscriptLanguageCode>("auto");
	const regenLanguageOptions = useMemo(
		() => sortedLanguageOptions(locale, t("mediaStage.auto")),
		[locale, t],
	);

	const assets = document?.assets ?? [];
	const filtered = useMemo(
		() =>
			assets.filter((a) => {
				if (!query) return true;
				return `${a.label} ${a.originalPath}`.toLowerCase().includes(query.toLowerCase());
			}),
		[assets, query],
	);
	const selected = assets.find((a) => a.id === selectedId) ?? null;
	const transcript = selected
		? (document?.transcripts?.find((t) => t.assetId === selected.id) ?? null)
		: null;
	const selectedTranscription: AssetTranscriptionView = selected
		? (transcriptions[selected.id] ?? { assetId: selected.id, status: "idle" })
		: { assetId: "", status: "idle" };
	const selectedBusy =
		selectedTranscription.status === "running" || selectedTranscription.status === "queued";

	const handleImport = async () => {
		if (!projectId) {
			toast.error(t("mediaStage.openProjectFirst"));
			return;
		}
		const picker = await window.electronAPI?.openVideoFilePicker();
		if (!picker?.success || !picker.path) return;
		setBusy(true);
		try {
			const label = picker.name || basename(picker.path);
			await addAsset(picker.path, label);
			toast.success(t("mediaStage.added", { label }));
		} catch (err) {
			toast.error(t("mediaStage.couldNotAddAsset"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	};

	const openDetail = (asset: AxcutAsset) => {
		setSelectedId(asset.id);
		setDetailOpen(true);
	};

	const addSelectedToTimeline = () => {
		void addSelectedAssetToTimeline(selected, onAddToTimeline, (label) => {
			toast.success(t("mediaStage.addedToTimeline", { label }));
		}).catch(() => undefined);
	};

	return (
		<div className={styles.mediaStage}>
			<div className={styles.mediaInner} style={{ maxWidth: detailOpen ? 1120 : 900 }}>
				<div className={styles.mediaSearchRow}>
					<Search size={16} style={{ color: "var(--muted)", flexShrink: 0 }} />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("mediaStage.searchPlaceholder")}
					/>
				</div>
				<div className={styles.mediaCols}>
					<div className={styles.mediaListCol}>
						<div
							className={styles.mediaGrid}
							style={{ gridTemplateColumns: detailOpen ? "repeat(2,1fr)" : "repeat(3,1fr)" }}
						>
							{filtered.map((asset, i) => {
								const transcription = transcriptions[asset.id] ?? {
									assetId: asset.id,
									status: "idle" as AssetTranscriptionStatus,
								};
								return (
									<button
										type="button"
										key={asset.id}
										draggable
										className={`${styles.mediaCard}${
											asset.id === selectedId ? ` ${styles.selected}` : ""
										}`}
										title={asset.originalPath}
										onDragStart={(e) => {
											e.dataTransfer.setData(ASSET_MIME, asset.id);
											e.dataTransfer.effectAllowed = "copy";
										}}
										onClick={() => openDetail(asset)}
									>
										<div
											className={styles.mediaThumb}
											style={{ background: THUMB_GRADIENTS[i % THUMB_GRADIENTS.length] }}
										>
											<Film size={30} strokeWidth={1.8} />
										</div>
										<div className={styles.mediaCardMeta}>
											{asset.id === selectedId ? (
												<span
													aria-hidden
													style={{
														width: 6,
														height: 6,
														borderRadius: "50%",
														background: "var(--accent)",
														flexShrink: 0,
													}}
												/>
											) : null}
											<div className={styles.body}>
												<div className={styles.mediaCardName}>
													{asset.label || basename(asset.originalPath)}
												</div>
												<div className={styles.mediaCardStats}>
													<span className={styles.dur}>
														{formatSeconds(asset.durationSec ?? 0)}
													</span>
													<span className={styles.size}>{formatBytes(asset.sizeBytes)}</span>
												</div>
											</div>
											<TranscriptionStatusDot view={transcription} />
										</div>
									</button>
								);
							})}
						</div>
						{assets.length > 0 ? (
							<div className={styles.mediaHint}>
								<ArrowDown size={12} />
								{t("mediaStage.dragHint")}
							</div>
						) : (
							<div className={styles.mediaHint}>{t("mediaStage.emptyHint")}</div>
						)}
						<button
							type="button"
							className={styles.importBtn}
							onClick={handleImport}
							disabled={!projectId || busy}
						>
							<Plus size={14} />
							{t("mediaStage.importMedia")}
						</button>
					</div>

					{detailOpen && selected ? (
						<div className={styles.mediaDetail}>
							<div
								style={{
									display: "flex",
									alignItems: "flex-start",
									justifyContent: "space-between",
									gap: 10,
									marginBottom: 4,
								}}
							>
								<h2
									style={{
										margin: 0,
										fontSize: 16.5,
										fontWeight: 700,
										color: "var(--fg-emphasis)",
										letterSpacing: "-0.01em",
									}}
								>
									{t("mediaStage.sourceTranscript")}
								</h2>
								<button
									type="button"
									title={t("mediaStage.close")}
									aria-label={t("mediaStage.close")}
									onClick={() => setDetailOpen(false)}
									style={{
										width: 26,
										height: 26,
										display: "grid",
										placeItems: "center",
										borderRadius: 8,
										color: "var(--muted)",
										background: "transparent",
										border: 0,
										cursor: "pointer",
										flexShrink: 0,
									}}
								>
									<X size={15} />
								</button>
							</div>
							<div
								style={{
									fontSize: 12,
									color: "var(--muted)",
									marginBottom: 10,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{selected.label || basename(selected.originalPath)}
							</div>
							<button
								type="button"
								onClick={addSelectedToTimeline}
								style={{
									width: "100%",
									height: 36,
									display: "inline-flex",
									alignItems: "center",
									justifyContent: "center",
									gap: 7,
									marginBottom: 16,
									borderRadius: 9,
									border: "1px solid var(--accent)",
									background: "var(--accent)",
									color: "var(--accent-on)",
									fontSize: 12.5,
									fontWeight: 650,
									cursor: "pointer",
								}}
							>
								<Plus size={14} />
								{t("mediaStage.addToTimeline")}
							</button>

							<div style={{ marginBottom: 16 }}>
								<span
									style={{
										display: "inline-flex",
										alignItems: "center",
										gap: 6,
										padding: "5px 10px 5px 8px",
										borderRadius: 9999,
										background:
											selectedTranscription.status === "failed"
												? "var(--danger-soft)"
												: selectedTranscription.status === "ready"
													? "var(--success-soft)"
													: "var(--accent-soft)",
										color:
											selectedTranscription.status === "failed"
												? "var(--danger)"
												: selectedTranscription.status === "ready"
													? "var(--success)"
													: "var(--accent)",
										fontSize: 11.5,
										fontWeight: 600,
									}}
								>
									<TranscriptionStatusDot view={selectedTranscription} size={5} />
									{transcriptionLabel(selectedTranscription)}
								</span>
								{/* The language whisper resolved on the first chunk, which every later
								    chunk was then pinned to. Its only pill used to live in the v3 left
								    panel's transcript modal, which nothing mounted, so the value was
								    reaching the document and being displayed nowhere. It belongs next to
								    "Regenerate as" below in any case: that selector is the control
								    you set BECAUSE of what was detected. */}
								{transcript?.language && transcript.language !== "auto" ? (
									<span
										style={{
											display: "inline-flex",
											alignItems: "center",
											marginLeft: 8,
											padding: "5px 10px",
											borderRadius: 9999,
											background: "var(--success-soft)",
											color: "var(--success)",
											fontSize: 11.5,
											fontWeight: 600,
										}}
									>
										{t("mediaStage.detectedLanguage", {
											language: languageLabel(transcript.language, locale),
										})}
									</span>
								) : null}
							</div>

							{/* Renders itself away — spacing included — unless the run reports progress. */}
							<TranscriptionProgressBar view={selectedTranscription} />

							{selectedTranscription.failure ? (
								<p
									style={{
										margin: "-8px 0 16px",
										fontSize: 11.5,
										lineHeight: 1.5,
										color: "var(--muted)",
									}}
								>
									{selectedTranscription.failure.kind === "error"
										? selectedTranscription.failure.message
										: t("mediaStage.noAudioTrackHint")}
								</p>
							) : null}

							<div style={{ marginBottom: 12 }}>
								<div
									style={{
										fontSize: 11.5,
										fontWeight: 600,
										color: "var(--fg-2)",
										marginBottom: 6,
									}}
								>
									{t("mediaStage.regenerateAs")}
								</div>
								<div style={{ display: "flex", gap: 8 }}>
									<select
										value={lang}
										onChange={(e) => setLang(e.target.value as TranscriptLanguageCode)}
										style={{
											flex: 1,
											minWidth: 0,
											height: 36,
											padding: "0 10px",
											borderRadius: 9,
											border: "1px solid var(--border)",
											background: "var(--surface-2)",
											color: "var(--fg)",
											fontSize: 12.5,
											fontWeight: 500,
											outline: "none",
										}}
									>
										{regenLanguageOptions.map(({ code, label }) => (
											<option key={code} value={code}>
												{label}
											</option>
										))}
									</select>
									<button
										type="button"
										title={t("mediaStage.regenerate")}
										aria-label={t("mediaStage.regenerate")}
										disabled={selectedBusy}
										onClick={() => void requestTranscription(selected.id, lang)}
										style={{
											width: 36,
											height: 36,
											flexShrink: 0,
											display: "grid",
											placeItems: "center",
											borderRadius: 9,
											color: "var(--fg-2)",
											background: "var(--surface-2)",
											border: "1px solid var(--border)",
											cursor: selectedBusy ? "not-allowed" : "pointer",
											opacity: selectedBusy ? 0.6 : 1,
										}}
									>
										<RotateCw size={14} className={selectedBusy ? "animate-spin" : undefined} />
									</button>
								</div>
							</div>

							<div
								style={{
									padding: "16px",
									border: "1px solid var(--border)",
									borderRadius: 12,
									background: "var(--surface)",
									fontSize: 12.5,
									lineHeight: 1.7,
									color: "var(--fg-2)",
									maxHeight: 360,
									overflowY: "auto",
								}}
							>
								{transcript ? (
									(transcript.segments ?? [])
										.map((seg) => (seg as { text?: string }).text ?? "")
										.join(" ") || t("mediaStage.transcriptEmpty")
								) : (
									<span style={{ color: "var(--muted)" }}>
										{selectedBusy
											? t("mediaStage.transcribingEllipsis")
											: selectedTranscription.status === "failed"
												? t("mediaStage.generationFailedHint")
												: t("mediaStage.notGeneratedHint")}
									</span>
								)}
							</div>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
