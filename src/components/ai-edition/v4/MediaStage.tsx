import { ArrowDown, Film, Plus, RotateCw, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import type { AxcutAsset } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
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

function formatTimecode(sec: number | undefined): string {
	if (!sec || !Number.isFinite(sec)) return "0:00.0";
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = (sec % 60).toFixed(1);
	return h > 0
		? `${h}:${m.toString().padStart(2, "0")}:${s.padStart(4, "0")}`
		: `${m}:${s.padStart(4, "0")}`;
}

function formatSize(bytes: number | undefined): string {
	if (!bytes || !Number.isFinite(bytes)) return "—";
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function MediaStage({
	assetStatuses,
	onRegenerateAsset,
}: {
	assetStatuses?: Record<string, "pending" | "running" | "failed">;
	onRegenerateAsset?: (assetId: string, language: string) => Promise<void>;
}) {
	const t = useScopedT("editor");
	const projectId = useProjectStore((s) => s.projectId);
	const document = useProjectStore((s) => s.document);
	const addAsset = useProjectStore((s) => s.addAsset);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [lang, setLang] = useState("auto");

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
								const status = assetStatuses?.[asset.id] ?? "idle";
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
													<span className={styles.dur}>{formatTimecode(asset.durationSec)}</span>
													<span className={styles.size}>{formatSize(asset.sizeBytes)}</span>
												</div>
											</div>
											{status === "running" ? (
												<RotateCw
													size={13}
													className="animate-spin"
													style={{ color: "var(--accent)", flexShrink: 0 }}
												/>
											) : null}
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
									marginBottom: 16,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{selected.label || basename(selected.originalPath)}
							</div>

							<div style={{ marginBottom: 16 }}>
								<span
									style={{
										display: "inline-flex",
										alignItems: "center",
										gap: 6,
										padding: "5px 10px 5px 8px",
										borderRadius: 9999,
										background: transcript ? "var(--success-soft)" : "var(--accent-soft)",
										color: transcript ? "var(--success)" : "var(--accent)",
										fontSize: 11.5,
										fontWeight: 600,
									}}
								>
									<span
										style={{
											width: 5,
											height: 5,
											borderRadius: "50%",
											background: transcript ? "var(--success)" : "var(--accent)",
										}}
									/>
									{transcript ? t("mediaStage.transcriptReady") : t("mediaStage.notGeneratedYet")}
								</span>
							</div>

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
										onChange={(e) => setLang(e.target.value)}
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
										<option value="auto">{t("mediaStage.auto")}</option>
										<option value="en">English</option>
										<option value="fr">Français</option>
										<option value="es">Español</option>
									</select>
									<button
										type="button"
										title={t("mediaStage.regenerate")}
										aria-label={t("mediaStage.regenerate")}
										disabled={!onRegenerateAsset || assetStatuses?.[selected.id] === "running"}
										onClick={() => {
											if (onRegenerateAsset) void onRegenerateAsset(selected.id, lang);
										}}
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
											cursor: "pointer",
										}}
									>
										<RotateCw size={14} />
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
									<span style={{ color: "var(--muted)" }}>{t("mediaStage.notGeneratedHint")}</span>
								)}
							</div>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
