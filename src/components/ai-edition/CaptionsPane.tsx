// The Captions facet of the floating inspector.
//
// Captions have nothing to do with annotations any more: there is no "generate"
// step that stamps text onto the timeline, because the caption layer IS the
// transcript, read through this panel's settings. So every control here changes
// how the transcript is *shown* — never what it says.
//
// The one exception is the translation row, and even that is additive: a
// translation is stored beside the transcript, keyed by segment id, and picking
// "Original" goes straight back to the SSOT text.

import { Captions as CaptionsIcon, Languages, Loader2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type { CaptionTextAlign, CaptionVerticalPosition } from "@/lib/ai-edition/captions";
import { untranslatedUnits } from "@/lib/ai-edition/captions";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	useTimelineTranscriptGate,
	useTranscriptionStore,
} from "@/lib/ai-edition/store/transcriptionStore";
import { useCaptions } from "@/lib/ai-edition/store/useCaptions";
import { nativeBridgeClient } from "@/native";
import { ColorField } from "./ColorField";
import styles from "./NewEditorShell.module.css";
import { SliderCell, Toggle } from "./RightPanes";

/** The families `src/index.css` already loads for on-canvas text — anything else
 *  would render in the preview but fall back to a default in the export canvas. */
const CAPTION_FONTS = [
	"Inter",
	"Geist",
	"DM Sans",
	"Plus Jakarta Sans",
	"Manrope",
	"Space Grotesk",
	"Sora",
	"IBM Plex Sans",
	"Oswald",
	"Bebas Neue",
	"Lora",
	"Merriweather",
	"Playfair Display",
	"Caveat",
	"Permanent Marker",
	"Fira Code",
	"IBM Plex Mono",
] as const;

/** Offered as translation targets. Codes double as the storage key. */
const TRANSLATION_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
	{ code: "en", label: "English" },
	{ code: "fr", label: "Français" },
	{ code: "es", label: "Español" },
	{ code: "de", label: "Deutsch" },
	{ code: "it", label: "Italiano" },
	{ code: "pt", label: "Português" },
	{ code: "nl", label: "Nederlands" },
	{ code: "pl", label: "Polski" },
	{ code: "tr", label: "Türkçe" },
	{ code: "ru", label: "Русский" },
	{ code: "ar", label: "العربية" },
	{ code: "hi", label: "हिन्दी" },
	{ code: "ja", label: "日本語" },
	{ code: "ko", label: "한국어" },
	{ code: "zh", label: "中文" },
];

export function CaptionsPane() {
	const t = useScopedT("settings");
	const te = useScopedT("editor");
	const {
		settings,
		translations,
		cues,
		hasDocument,
		hasTranscript,
		set,
		setLive,
		commit,
		saveTranslation,
		deleteTranslation,
	} = useCaptions();
	const document = useProjectStore((s) => s.document);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	// Captions are a view of the transcript, and the transcript arrives on its
	// own (transcriptionStore's background pass). The pane reads that state
	// straight from the store rather than being handed a busy flag: it is the
	// same answer everywhere, and "Transcribe" here is only ever a retry.
	//
	// Resolved over the timeline's assets, not the primary one: `hasTranscript`
	// below is already timeline-scoped (useCaptions), and mixing the two scopes
	// is what let a silent primary asset dead-end this button for a project whose
	// actual footage had speech.
	const gate = useTimelineTranscriptGate();
	const requestTimelineTranscripts = useTranscriptionStore((s) => s.requestTimelineTranscripts);
	const isTranscribing = gate.state === "pending";
	const silentMedia = gate.state === "blocked" && gate.reason === "no-audio";
	const engineError = gate.state === "blocked" && gate.reason === "failed" ? gate.message : null;

	const [target, setTarget] = useState<string>(TRANSLATION_LANGUAGES[1].code);
	const [translating, setTranslating] = useState(false);
	const [translateError, setTranslateError] = useState<string | null>(null);

	// Documents made by the old "generate captions" flow carry caption text as
	// real annotations. They'd now render *on top of* the derived layer, so the
	// pane offers to clear them — explicitly, since they are the user's data.
	const legacyCaptionAnnotations = useMemo(
		() => (document?.annotations ?? []).filter((a) => a.annotationSource === "auto-caption"),
		[document],
	);

	const disabled = !hasDocument;
	const languageOptions = useMemo(() => Object.values(translations), [translations]);

	const handleTranslate = async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		const label = TRANSLATION_LANGUAGES.find((l) => l.code === target)?.label ?? target;
		setTranslating(true);
		setTranslateError(null);
		try {
			// Only the assets actually on the timeline, and only the units that aren't
			// translated yet — a re-run after adding footage costs just the new
			// material instead of the whole video. Units, not segments: a Whisper
			// transcript is one segment per word, and translating single words gives
			// nonsense in any language that reorders or agrees differently.
			const assetIds = new Set(doc.timeline.clips.map((c) => c.assetId));
			let translatedAny = false;
			for (const transcript of doc.transcripts) {
				if (!assetIds.has(transcript.assetId)) continue;
				const pending = untranslatedUnits(transcript, translations, target);
				if (pending.length === 0) {
					translatedAny = true;
					continue;
				}
				const result = await nativeBridgeClient.aiEdition.translateCaptions({
					segments: pending.map((s) => ({ id: s.id, text: s.text })),
					targetLanguage: label,
					sourceLanguage: transcript.language,
				});
				if (Object.keys(result.segments).length > 0) {
					await saveTranslation({
						language: target,
						label,
						assetId: transcript.assetId,
						segments: result.segments,
						model: result.model,
					});
					translatedAny = true;
				}
				if (!result.success) {
					setTranslateError(result.error ?? t("captions.translateFailed"));
					return;
				}
			}
			if (translatedAny) await set({ language: target, enabled: true });
			else setTranslateError(t("captions.noTranscript"));
		} catch (error) {
			setTranslateError(error instanceof Error ? error.message : String(error));
		} finally {
			setTranslating(false);
		}
	};

	const clearLegacyCaptionAnnotations = async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		await saveDocument({
			...doc,
			annotations: doc.annotations.filter((a) => a.annotationSource !== "auto-caption"),
		});
	};

	return (
		<div className={`${styles.pane} ${styles.isActive}`}>
			<header className={styles.paneHead}>
				<h2>{t("facets.captions")}</h2>
				<span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
					<CaptionsIcon size={14} style={{ color: "var(--muted)" }} />
				</span>
			</header>
			<div className={styles.paneBody} style={{ padding: 0 }}>
				<div className={styles.paneRow}>
					<span className="label">{t("captions.show")}</span>
					<Toggle
						checked={settings.enabled}
						disabled={disabled || !hasTranscript}
						onChange={(next) => void set({ enabled: next })}
					/>
				</div>

				{!hasTranscript ? (
					<div
						style={{
							margin: "0 var(--sp-4) 12px",
							padding: "14px",
							border: "1px dashed var(--border-hi)",
							borderRadius: 10,
							display: "flex",
							flexDirection: "column",
							gap: 10,
						}}
					>
						<p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--muted)" }}>
							{silentMedia ? te("mediaStage.noAudioTrackHint") : t("captions.noTranscript")}
						</p>
						{engineError ? (
							<p
								style={{
									margin: 0,
									font: "400 11.5px/1.5 var(--font-body)",
									color: "var(--danger)",
								}}
							>
								{engineError}
							</p>
						) : null}
						<button
							type="button"
							className={`${styles.btn} ${styles.btnPrimary}`}
							// A media with no audio track has nothing to transcribe — the
							// button would fail the same way every time it is pressed.
							disabled={disabled || isTranscribing || silentMedia}
							onClick={() => void requestTimelineTranscripts()}
						>
							{isTranscribing ? <Loader2 size={14} className="animate-spin" /> : null}
							{isTranscribing ? t("captions.transcribing") : t("captions.transcribe")}
						</button>
					</div>
				) : (
					<p
						style={{
							margin: "0 var(--sp-4) 12px",
							font: "400 11.5px/1.5 var(--font-body)",
							color: "var(--meta)",
						}}
					>
						{/* The cue count is only meaningful while the layer is on — deriving
						    cues short-circuits when it's off, so a "0 lines" reading there
						    would say the transcript is empty when it isn't. */}
						{settings.enabled
							? t("captions.derivedFromTranscript", { count: cues.length })
							: t("captions.hiddenHint")}
					</p>
				)}

				{legacyCaptionAnnotations.length > 0 ? (
					<div
						style={{
							margin: "0 var(--sp-4) 12px",
							padding: "12px 14px",
							border: "1px solid var(--border)",
							borderRadius: 10,
							background: "var(--surface-warm)",
							display: "flex",
							flexDirection: "column",
							gap: 8,
						}}
					>
						<p style={{ margin: 0, font: "400 11.5px/1.5 var(--font-body)", color: "var(--fg-2)" }}>
							{t("captions.legacyAnnotations", { count: legacyCaptionAnnotations.length })}
						</p>
						<button
							type="button"
							className={`${styles.btn} ${styles.btnSecondary}`}
							onClick={() => void clearLegacyCaptionAnnotations()}
						>
							<Trash2 size={13} />
							{t("captions.removeLegacyAnnotations")}
						</button>
					</div>
				) : null}

				{/* ── Language ───────────────────────────────────────────── */}
				<div className={styles.sectionLabel}>{t("captions.language")}</div>
				<div className={styles.paneRow}>
					<span className="label">{t("captions.displayLanguage")}</span>
					<select
						value={settings.language ?? ""}
						disabled={disabled}
						onChange={(e) => void set({ language: e.target.value || null })}
						style={selectStyle}
					>
						<option value="">{t("captions.original")}</option>
						{languageOptions.map((entry) => (
							<option key={entry.language} value={entry.language}>
								{entry.label}
							</option>
						))}
					</select>
				</div>

				<div
					style={{
						margin: "0 var(--sp-4) 12px",
						display: "flex",
						alignItems: "center",
						gap: 8,
					}}
				>
					<select
						value={target}
						disabled={disabled || translating}
						onChange={(e) => setTarget(e.target.value)}
						style={{ ...selectStyle, flex: 1 }}
					>
						{TRANSLATION_LANGUAGES.map((language) => (
							<option key={language.code} value={language.code}>
								{language.label}
							</option>
						))}
					</select>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						disabled={disabled || translating || !hasTranscript}
						onClick={() => void handleTranslate()}
						title={t("captions.translateHint")}
					>
						{translating ? <Loader2 size={13} className="animate-spin" /> : <Languages size={13} />}
						{translating ? t("captions.translating") : t("captions.translate")}
					</button>
				</div>
				{settings.language ? (
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						style={{ margin: "0 var(--sp-4) 12px" }}
						disabled={disabled}
						onClick={() => void deleteTranslation(settings.language as string)}
					>
						<Trash2 size={13} />
						{t("captions.deleteTranslation")}
					</button>
				) : null}
				{translateError ? (
					<p
						style={{
							margin: "0 var(--sp-4) 12px",
							font: "400 11.5px/1.5 var(--font-body)",
							color: "var(--danger)",
						}}
					>
						{translateError}
					</p>
				) : null}
				<p
					style={{
						margin: "0 var(--sp-4) 14px",
						font: "400 11px/1.5 var(--font-body)",
						color: "var(--meta)",
					}}
				>
					{t("captions.translationIsNonDestructive")}
				</p>

				{/* ── Text ───────────────────────────────────────────────── */}
				<div className={styles.sectionLabel}>{t("captions.text")}</div>
				<div className={styles.paneRow}>
					<span className="label">{t("captions.font")}</span>
					<select
						value={settings.fontFamily}
						disabled={disabled}
						onChange={(e) => void set({ fontFamily: e.target.value })}
						style={selectStyle}
					>
						{CAPTION_FONTS.map((font) => (
							<option key={font} value={font} style={{ fontFamily: font }}>
								{font}
							</option>
						))}
					</select>
				</div>
				<div className={styles.paneRow}>
					<span className="label">{t("captions.bold")}</span>
					<Toggle
						checked={settings.fontWeight === "bold"}
						disabled={disabled}
						onChange={(next) => void set({ fontWeight: next ? "bold" : "normal" })}
					/>
				</div>
				<div className={styles.sliderGrid}>
					<SliderCell
						label={t("captions.fontSize")}
						value={settings.fontSize}
						min={16}
						max={140}
						suffix="px"
						disabled={disabled}
						onChange={(v) => setLive({ fontSize: v })}
						onCommit={() => void commit()}
					/>
				</div>
				<div className={styles.paneRow}>
					<span className="label">{t("captions.textColor")}</span>
					<ColorField
						label={t("captions.textColor")}
						value={settings.color}
						disabled={disabled}
						onChange={(color) => setLive({ color })}
						onCommit={() => void commit()}
					/>
				</div>

				{/* ── Background ─────────────────────────────────────────── */}
				<div className={styles.sectionLabel}>{t("captions.background")}</div>
				{/* Colour + switch on one row, exactly like the annotation pane's text
				    background: the swatch keeps showing the remembered colour while the
				    plate is off, because that is what turning it back on will draw. */}
				<div className={styles.paneRow}>
					<span className="label">{t("captions.background")}</span>
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<ColorField
							label={t("captions.backgroundColor")}
							value={settings.backgroundColor}
							disabled={disabled}
							onChange={(backgroundColor) => setLive({ backgroundColor })}
							onCommit={() => void commit()}
						/>
						<Toggle
							checked={settings.backgroundEnabled}
							disabled={disabled}
							onChange={(next) => void set({ backgroundEnabled: next })}
						/>
					</div>
				</div>
				{settings.backgroundEnabled ? (
					<div className={styles.sliderGrid}>
						<SliderCell
							label={t("captions.backgroundOpacity")}
							value={Math.round(settings.backgroundOpacity * 100)}
							min={0}
							max={100}
							suffix="%"
							disabled={disabled}
							onChange={(v) => setLive({ backgroundOpacity: v / 100 })}
							onCommit={() => void commit()}
						/>
					</div>
				) : null}

				{/* ── Placement ──────────────────────────────────────────── */}
				<div className={styles.sectionLabel}>{t("captions.position")}</div>
				<Segmented<CaptionVerticalPosition>
					value={settings.verticalPosition}
					disabled={disabled}
					options={[
						{ value: "top", label: t("captions.positionTop") },
						{ value: "middle", label: t("captions.positionMiddle") },
						{ value: "bottom", label: t("captions.positionBottom") },
					]}
					onChange={(verticalPosition) => void set({ verticalPosition })}
				/>
				<Segmented<CaptionTextAlign>
					value={settings.textAlign}
					disabled={disabled}
					options={[
						{ value: "left", label: t("captions.alignLeft") },
						{ value: "center", label: t("captions.alignCenter") },
						{ value: "right", label: t("captions.alignRight") },
					]}
					onChange={(textAlign) => void set({ textAlign })}
				/>
				<div className={styles.sliderGrid}>
					<SliderCell
						label={t("captions.verticalOffset")}
						value={settings.offsetY}
						min={-45}
						max={45}
						suffix="%"
						disabled={disabled}
						onChange={(v) => setLive({ offsetY: v })}
						onCommit={() => void commit()}
					/>
					<SliderCell
						label={t("captions.width")}
						value={settings.width}
						min={20}
						max={100}
						suffix="%"
						disabled={disabled}
						onChange={(v) => setLive({ width: v })}
						onCommit={() => void commit()}
					/>
				</div>

				{/* ── Line length ────────────────────────────────────────── */}
				<div className={styles.sectionLabel}>{t("captions.lineLength")}</div>
				<div className={styles.paneRow}>
					<span className="label">{t("captions.minWords")}</span>
					<select
						value={settings.minWordsPerLine}
						disabled={disabled}
						onChange={(e) => void set({ minWordsPerLine: Number(e.target.value) })}
						style={selectStyle}
					>
						{WORD_COUNTS.map((n) => (
							<option key={n} value={n}>
								{n}
							</option>
						))}
					</select>
				</div>
				<div className={styles.paneRow} style={{ marginBottom: 16 }}>
					<span className="label">{t("captions.maxWords")}</span>
					<select
						value={settings.maxWordsPerLine}
						disabled={disabled}
						onChange={(e) => void set({ maxWordsPerLine: Number(e.target.value) })}
						style={selectStyle}
					>
						{WORD_COUNTS.map((n) => (
							<option key={n} value={n} disabled={n < settings.minWordsPerLine}>
								{n}
							</option>
						))}
					</select>
				</div>
			</div>
		</div>
	);
}

const WORD_COUNTS = Array.from({ length: 12 }, (_, i) => i + 1);

const selectStyle: React.CSSProperties = {
	height: 32,
	padding: "0 8px",
	borderRadius: 8,
	border: "1px solid var(--border)",
	background: "var(--surface)",
	color: "var(--fg)",
	font: "500 12.5px var(--font-body)",
	maxWidth: 160,
};

/**
 * One "label + swatch" row that opens the app's standard `ColorPicker` (wheel /
 * palette / hex) in a popover.
 *
 * The pane used to carry its own hard-coded caption swatches. That was a third
 * private palette in the app, and it meant the caption colours behaved unlike
 * every other colour surface — so it's gone: this defers to the shared
 * `COLOR_PALETTE` and the shared picker instead.
 */
function Segmented<T extends string>({
	value,
	options,
	disabled,
	onChange,
}: {
	value: T;
	options: ReadonlyArray<{ value: T; label: string }>;
	disabled?: boolean;
	onChange: (next: T) => void;
}) {
	return (
		<div className={styles.paneTabs}>
			{options.map((option) => (
				<button
					type="button"
					key={option.value}
					className={value === option.value ? styles.isActive : ""}
					aria-pressed={value === option.value}
					disabled={disabled}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
