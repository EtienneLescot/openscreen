// One place that turns an `AssetTranscriptionView` into words and a colour.
//
// The media list (left panel), the media stage and the source-transcript modal
// all report the same six states; before auto-transcription each of them
// spelled its own dot colours and labels out inline, and they had already
// drifted (the left panel knew about "pending", the stage only ever showed a
// spinner). Keeping the vocabulary here means a new state shows up everywhere
// at once.

import { Loader2 } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import {
	type AssetTranscriptionView,
	isCpuBackend,
	progressFraction,
	realtimeSpeed,
} from "@/lib/ai-edition/transcription/status";

/** Human-readable state of one asset's transcript, in the user's language. */
export function useTranscriptionLabel(): (view: AssetTranscriptionView) => string {
	const t = useScopedT("editor");
	return (view) => {
		switch (view.status) {
			case "ready":
				return t("mediaStage.transcriptReady");
			case "queued":
				return t("mediaStage.pendingTranscription");
			case "running": {
				// The first-run model download is a 253 MB wait with nothing else on
				// screen to explain it, so it gets its own words rather than being
				// labelled "Transcribing" — this is the phase most often mistaken for
				// a hang, and the one `phase` was carried through the store for.
				if (view.phase === "loading-model") return t("mediaStage.downloadingModel");
				// Transcribing a long recording runs for minutes. A bare
				// "Transcribing…" for that whole time is indistinguishable from a
				// hang, so append the percentage as soon as the main process reports
				// chunk progress — and only then (see `TranscriptionProgressBar`).
				const fraction = progressFraction(view.progress);
				const head =
					fraction === null
						? t("mediaStage.transcribing")
						: `${t("mediaStage.transcribing")} ${Math.round(fraction * 100)}%`;
				// Two things only the run itself knows: which device is doing the work,
				// and how fast. "CPU" appears on the slow path ONLY — naming the GPU
				// backend on every healthy run would be noise, whereas landing on CPU
				// costs about half the throughput and happens through fallbacks that are
				// otherwise completely silent. The speed shows on any backend: "is this
				// moving, and how fast" is the same question at 5× as at 0.9×.
				const suffix: string[] = [];
				if (isCpuBackend(view.backend)) suffix.push("CPU");
				const speed = realtimeSpeed(view.rtf);
				if (speed !== null) suffix.push(`${speed.toFixed(1)}×`);
				return suffix.length === 0 ? head : `${head} · ${suffix.join(" · ")}`;
			}
			case "empty":
				return t("mediaStage.noSpeechDetected");
			case "failed":
				return view.failure?.kind === "error"
					? t("mediaStage.transcriptionFailed")
					: t("mediaStage.noAudioTrack");
			default:
				return t("mediaStage.noTranscript");
		}
	};
}

const DOT_COLOR: Record<AssetTranscriptionView["status"], { fill: string; halo: string }> = {
	ready: { fill: "var(--success)", halo: "0 0 0 3px var(--success-soft)" },
	queued: { fill: "#f59e0b", halo: "0 0 0 3px rgba(245, 158, 11, 0.2)" },
	running: { fill: "var(--accent)", halo: "0 0 0 3px rgba(16, 185, 129, 0.2)" },
	// A silent media is not a bug — it just has nothing to say. Amber, not red.
	empty: { fill: "#f59e0b", halo: "0 0 0 3px rgba(245, 158, 11, 0.2)" },
	failed: { fill: "var(--danger)", halo: "0 0 0 3px rgba(239, 68, 68, 0.2)" },
	idle: { fill: "var(--dim)", halo: "none" },
};

/** Compact status marker: a spinner while a run is in flight, a dot otherwise. */
export function TranscriptionStatusDot({
	view,
	size = 8,
}: {
	view: AssetTranscriptionView;
	size?: number;
}) {
	const t = useScopedT("editor");
	const label = useTranscriptionLabel()(view);
	// The label says "CPU"; this says what that costs. It has to be a <title>
	// CHILD rather than the `title` attribute the dot below uses — lucide renders
	// children inside its <svg>, and SVG has no tooltip-bearing `title` attribute.
	const cpuHint = isCpuBackend(view.backend) ? t("mediaStage.cpuBackendHint") : null;
	if (view.status === "running" || view.status === "queued") {
		return (
			<Loader2
				size={size + 5}
				className="animate-spin"
				style={{ color: "var(--accent)", flexShrink: 0 }}
				aria-label={label}
			>
				<title>{cpuHint ? `${label} — ${cpuHint}` : label}</title>
			</Loader2>
		);
	}
	const { fill, halo } = DOT_COLOR[view.status];
	return (
		<span
			style={{
				width: size,
				height: size,
				borderRadius: "50%",
				background: fill,
				boxShadow: halo,
				flexShrink: 0,
			}}
			aria-label={label}
			title={view.failure?.message ? `${label} — ${view.failure.message}` : label}
		/>
	);
}

/**
 * Determinate progress bar for a running transcription. Renders nothing unless
 * the job actually reports measurable progress — a job that is queued,
 * extracting audio or downloading the model has no meaningful fraction, and a
 * bar pinned at 0% reads as "stuck" where the spinner reads as "working".
 *
 * It owns its own spacing on purpose. A wrapper in the caller cannot render
 * itself away with the bar, and in a flex column (where margins don't collapse)
 * an empty one still takes its margins — 8px of dead gap under every media card
 * that isn't transcribing.
 */
export function TranscriptionProgressBar({ view }: { view: AssetTranscriptionView }) {
	const label = useTranscriptionLabel();
	const fraction = view.status === "running" ? progressFraction(view.progress) : null;
	if (fraction === null) return null;
	return (
		<div
			role="progressbar"
			aria-label={label(view)}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(fraction * 100)}
			style={{
				height: 4,
				margin: "-8px 0 16px",
				borderRadius: 999,
				background: "var(--surface-3)",
				overflow: "hidden",
			}}
		>
			<div
				style={{
					height: "100%",
					width: `${fraction * 100}%`,
					background: "var(--accent)",
					transition: "width 200ms linear",
				}}
			/>
		</div>
	);
}
