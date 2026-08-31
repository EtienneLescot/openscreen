// Voiceover dialog: record a narration take against the timeline, live from the
// microphone (MediaRecorder → webm/opus, written to the recordings dir by the
// main process), or import a file if the user already has one.
//
// Music and other imports do NOT come through here — they are a plain file
// import on the timeline toolbar (`tl.addAudio`). Recording is the only audio
// gesture that needs a dialog, because it has a live state to show.
//
// The dialog resolves the AUDIO ASSET and its duration, then reports back via
// `onComplete` — placing the track on the timeline (span, anchor, inspector
// selection) is the caller's job, exactly like the other add* flows.

import { Mic, StopCircle, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { useScopedT } from "@/contexts/I18nContext";
import type { AxcutAsset } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { probeAudioDuration } from "@/lib/ai-edition/timeline/duration";
import { ModalShell } from "../Modals";

const RECORDER_MIME_PREFERENCES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function pickRecorderMimeType(): string {
	if (typeof MediaRecorder === "undefined") return "";
	for (const mime of RECORDER_MIME_PREFERENCES) {
		if (MediaRecorder.isTypeSupported(mime)) return mime;
	}
	return "";
}

/** Reuse an already-imported asset over importing the same file twice. */
function findExistingAsset(path: string): AxcutAsset | null {
	const doc = useProjectStore.getState().document;
	if (!doc) return null;
	return (
		doc.assets.find((a) => a.kind === "audio" && a.originalPath === path) ??
		doc.assets.find((a) => a.originalPath === path) ??
		null
	);
}

export function AddAudioLayerDialog({
	open,
	/** Timeline length in seconds — recording stops by itself when reached. */
	maxDurationSec,
	onClose,
	onComplete,
	onRecordingStart,
	onRecordingStop,
}: {
	open: boolean;
	maxDurationSec: number;
	onClose: () => void;
	onComplete: (assetId: string, durationSec: number) => void;
	onRecordingStart: () => void;
	onRecordingStop: () => void;
}) {
	const t = useScopedT("timeline");
	const [busy, setBusy] = useState(false);
	const [recording, setRecording] = useState(false);
	const [elapsedSec, setElapsedSec] = useState(0);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const startedAtRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	// Set when the user cancels (closes the dialog mid-take) — the stop handler
	// then discards the blob instead of importing it as a layer.
	const discardRef = useRef(false);

	// Reset whenever the dialog opens again — a cancelled recording must not
	// leak its stream or timer into the next session.
	useEffect(() => {
		if (open) {
			setBusy(false);
			setRecording(false);
			setElapsedSec(0);
		}
		return () => {
			if (timerRef.current) clearInterval(timerRef.current);
			timerRef.current = null;
			// Stop the RECORDER, not just the stream. Tearing the dialog down
			// mid-take (a project close, a shell unmount) used to drop the take on
			// the floor: `onstop` never fired, so the blob was never flushed and
			// `onRecordingStop` never ran — leaving the video element playing.
			// Discard rather than import: nobody is left to place the layer.
			const recorder = recorderRef.current;
			if (recorder && recorder.state !== "inactive") {
				discardRef.current = true;
				try {
					recorder.stop();
				} catch {
					// already torn down by the browser
				}
			}
			for (const track of streamRef.current?.getTracks() ?? []) track.stop();
			streamRef.current = null;
			recorderRef.current = null;
		};
	}, [open]);

	const stopRecording = useCallback(() => {
		if (timerRef.current) {
			clearInterval(timerRef.current);
			timerRef.current = null;
		}
		const recorder = recorderRef.current;
		// `recorder.onstop` (registered at start) owns the save path.
		if (recorder && recorder.state !== "inactive") {
			recorder.stop();
		}
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
	}, []);

	const cancelRecording = useCallback(() => {
		discardRef.current = true;
		stopRecording();
		onRecordingStop();
		setRecording(false);
		setElapsedSec(0);
	}, [stopRecording, onRecordingStop]);

	const finishWithPath = useCallback(
		async (path: string, durationSec: number) => {
			setBusy(true);
			try {
				const existing = findExistingAsset(path);
				// `addAudioAsset` files it as audio explicitly: a recorded voiceover
				// lands as `.webm`, the same extension as a screen recording, so
				// extension guessing would import it as a video asset.
				const asset = existing ?? (await useProjectStore.getState().addAudioAsset(path));
				if (!asset) {
					toast.error(t("audio.importFailed"));
					return;
				}
				onComplete(asset.id, durationSec);
			} catch (err) {
				toast.error(t("audio.importFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			} finally {
				setBusy(false);
			}
		},
		[onComplete, t],
	);

	const startRecording = useCallback(async () => {
		if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
			toast.error(t("audio.recordingUnavailable"));
			return;
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true },
			});
			streamRef.current = stream;
			const mimeType = pickRecorderMimeType();
			const recorder = mimeType
				? new MediaRecorder(stream, { mimeType })
				: new MediaRecorder(stream);
			recorderRef.current = recorder;
			chunksRef.current = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunksRef.current.push(event.data);
			};
			recorder.onstop = () => {
				const blob = new Blob(chunksRef.current, {
					type: recorder.mimeType || "audio/webm",
				});
				const duration = (performance.now() - startedAtRef.current) / 1000;
				const discarded = discardRef.current;
				discardRef.current = false;
				setRecording(false);
				setElapsedSec(0);
				onRecordingStop();
				if (discarded) return;
				void (async () => {
					try {
						const data = await blob.arrayBuffer();
						const saved = window.electronAPI?.saveRecordedVoiceover
							? await window.electronAPI.saveRecordedVoiceover(data)
							: { success: false as const };
						if (saved.success && saved.path) {
							await finishWithPath(saved.path, duration);
						} else {
							// Browser-mode fallback: no main process to persist the
							// blob, so the layer references the in-memory blob URL —
							// good for the session, gone on reload.
							const url = URL.createObjectURL(blob);
							await finishWithPath(url, duration);
						}
					} catch (err) {
						toast.error(t("audio.saveFailed"), {
							description: err instanceof Error ? err.message : String(err),
						});
					}
				})();
			};
			startedAtRef.current = performance.now();
			discardRef.current = false;
			recorder.start(250);
			setRecording(true);
			setElapsedSec(0);
			onRecordingStart();
			timerRef.current = setInterval(() => {
				setElapsedSec((performance.now() - startedAtRef.current) / 1000);
			}, 200);
		} catch {
			toast.error(t("audio.micDenied"));
		}
	}, [finishWithPath, onRecordingStart, onRecordingStop, t]);

	// Stop by itself at the end of the timeline so a layer can never outlive
	// the video it was recorded over.
	useEffect(() => {
		if (!recording || !Number.isFinite(maxDurationSec) || maxDurationSec <= 0) return;
		if (elapsedSec >= maxDurationSec) {
			stopRecording();
			// `onRecordingStop` fires from the recorder's stop handler.
		}
	}, [recording, elapsedSec, maxDurationSec, stopRecording]);

	// Re-entrancy guard: the shell passes an inline `onComplete` and re-renders on
	// every playhead tick during playback, so a dialog left open while the video
	// plays re-creates this callback constantly. Without the guard a second click
	// (or any caller that fires on re-render) would stack `showOpenDialog` calls.
	const pickerOpenRef = useRef(false);

	const importFile = useCallback(async () => {
		if (pickerOpenRef.current) return;
		pickerOpenRef.current = true;
		try {
			const picker = await window.electronAPI?.openAudioFilePicker?.();
			if (!picker?.success || !picker.path) return;
			const url = toFileUrl(picker.path);
			// The probe needs the real duration to size the layer; when it fails the
			// caller falls back to the default span.
			const duration = (await probeAudioDuration(url)) ?? 0;
			await finishWithPath(picker.path, duration);
		} finally {
			pickerOpenRef.current = false;
		}
	}, [finishWithPath]);

	const buttonStyle: React.CSSProperties = {
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
		padding: "10px 14px",
		borderRadius: 10,
		border: "1px solid var(--border)",
		background: "var(--bg-2)",
		color: "var(--fg-1)",
		font: "600 13px var(--font-display)",
		cursor: "pointer",
	};

	return (
		<ModalShell
			open={open}
			onClose={() => {
				if (recording) cancelRecording();
				onClose();
			}}
			title={t("audio.addVoiceover")}
			subtitle={t("audio.subtitle")}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
				{recording ? (
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							gap: 12,
							padding: "18px 0 8px",
						}}
					>
						<span
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 8,
								color: "var(--danger)",
								font: "600 13px var(--font-display)",
							}}
						>
							<span
								className="animate-pulse"
								style={{
									width: 10,
									height: 10,
									borderRadius: 999,
									background: "var(--danger)",
								}}
							/>
							{t("audio.recording")} {elapsedSec.toFixed(1)}s
						</span>
						<button
							type="button"
							onClick={stopRecording}
							style={{ ...buttonStyle, borderColor: "var(--danger)", color: "var(--danger)" }}
						>
							<StopCircle size={16} />
							{t("audio.stop")}
						</button>
					</div>
				) : (
					<>
						<button type="button" onClick={() => void startRecording()} style={buttonStyle}>
							<Mic size={16} />
							{t("audio.record")}
						</button>
						<button
							type="button"
							onClick={() => void importFile()}
							disabled={busy}
							style={buttonStyle}
						>
							<Upload size={16} />
							{t("audio.importFile")}
						</button>
					</>
				)}
			</div>
		</ModalShell>
	);
}
