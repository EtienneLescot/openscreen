import { fixWebmDuration } from "@fix-webm-duration/fix";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { MIC_GAIN_BOOST, mixAudioTracks } from "@/lib/audioMix";
import {
	type NativeLinuxRecordingRequest,
	portalOwnsSourceSelection,
} from "@/lib/nativeLinuxRecording";
import {
	type NativeMacRecordingRequest,
	parseMacDisplayIdFromSourceId,
	parseMacWindowIdFromSourceId,
} from "@/lib/nativeMacRecording";
import {
	type NativeWindowsRecordingRequest,
	parseWindowHandleFromSourceId,
} from "@/lib/nativeWindowsRecording";
import type { CursorCaptureMode, RecordedVideoAssetInput } from "@/lib/recordingSession";
import { requestCameraAccess } from "@/lib/requestCameraAccess";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import { createRecorderHandle, type RecorderHandle } from "./recorderHandle";
import { webcamDeviceIdentityFrom } from "./webcamDeviceIdentity";

const TARGET_FRAME_RATE = 60;
const MIN_FRAME_RATE = 30;
const TARGET_WIDTH = 3840;
const TARGET_HEIGHT = 2160;
const FOUR_K_PIXELS = TARGET_WIDTH * TARGET_HEIGHT;
const QHD_WIDTH = 2560;
const QHD_HEIGHT = 1440;
const QHD_PIXELS = QHD_WIDTH * QHD_HEIGHT;

const BITRATE_4K = 45_000_000;
const BITRATE_QHD = 28_000_000;
const BITRATE_BASE = 18_000_000;
const HIGH_FRAME_RATE_THRESHOLD = 60;
const HIGH_FRAME_RATE_BOOST = 1.7;

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

const CODEC_ALIGNMENT = 2;

const BITS_PER_MEGABIT = 1_000_000;
const CHROME_MEDIA_SOURCE = "desktop";
const RECORDING_FILE_PREFIX = "recording-";
const VIDEO_FILE_EXTENSION = ".webm";
const WEBCAM_FILE_SUFFIX = "-webcam";

/**
 * The cursor mode a BROWSER-pipeline take can actually honour, which is not always the
 * one the user picked.
 *
 * Only win32 reaches that pipeline through `getDisplayMedia`, the sole browser API here
 * that can exclude the system cursor (`cursor: "never"`). Everywhere else the
 * desktop-capture stream bakes the real cursor into the pixels, so keeping
 * "editable-overlay" would start cursor telemetry and have the editor composite a
 * SECOND, synthetic cursor on top of it.
 *
 * This only bites when a platform falls back to browser capture with the editable cursor
 * selected — on macOS 12 that is now the normal path (#515), and on Linux it is the
 * no-PipeWire path, where the same latent defect lives.
 *
 * One function rather than the expression inlined twice: the mode reported to the main
 * process at start and the mode persisted at finalize have to agree, and they are ~1200
 * lines apart.
 */
function effectiveBrowserCursorMode(
	platform: string,
	requested: CursorCaptureMode,
): CursorCaptureMode {
	return platform === "win32" ? requested : "system";
}

const AUDIO_BITRATE_VOICE = 128_000;
const AUDIO_BITRATE_SYSTEM = 192_000;

const WEBCAM_TARGET_FRAME_RATE = 30;

type UseScreenRecorderReturn = {
	recording: boolean;
	paused: boolean;
	saving: boolean;
	elapsedSeconds: number;
	toggleRecording: () => void;
	/** Starts recording with no countdown overlay. Used by the headless CLI runner. */
	startRecordingImmediately: () => Promise<void>;
	togglePaused: () => void;
	canPauseRecording: boolean;
	restartRecording: () => void;
	cancelRecording: () => void;
	microphoneEnabled: boolean;
	setMicrophoneEnabled: (enabled: boolean) => void;
	microphoneDeviceId: string | undefined;
	setMicrophoneDeviceId: (deviceId: string | undefined) => void;
	microphoneDeviceName: string | undefined;
	setMicrophoneDeviceName: (deviceName: string | undefined) => void;
	webcamDeviceId: string | undefined;
	setWebcamDeviceId: (deviceId: string | undefined) => void;
	webcamDeviceName: string | undefined;
	setWebcamDeviceName: (deviceName: string | undefined) => void;
	systemAudioEnabled: boolean;
	setSystemAudioEnabled: (enabled: boolean) => void;
	webcamEnabled: boolean;
	setWebcamEnabled: (enabled: boolean) => Promise<boolean>;
	cursorCaptureMode: CursorCaptureMode;
	setCursorCaptureMode: (mode: CursorCaptureMode) => void;
	softwareEncoderFallbackNoticeVisible: boolean;
	dismissSoftwareEncoderFallbackNotice: (dontShowAgain?: boolean) => void;
};

type NativeWindowsRecordingHandle = {
	recordingId: number;
	finalizing: boolean;
	paused: boolean;
};

type NativeMacRecordingHandle = {
	recordingId: number;
	finalizing: boolean;
	paused: boolean;
	/**
	 * Milliseconds the browser-recorded webcam clip started before the native
	 * macOS helper confirmed its screen recording actually began (negative --
	 * the webcam MediaRecorder starts immediately in the renderer, but the
	 * ScreenCaptureKit helper needs to spawn a process and start capturing
	 * before its own recording truly starts). `null` if webcam wasn't
	 * recorded via the browser sidecar for this session.
	 */
	webcamOffsetMs: number | null;
};

type NativeLinuxRecordingHandle = {
	recordingId: number;
	finalizing: boolean;
	paused: boolean;
	/**
	 * As on macOS: the webcam MediaRecorder starts immediately in the renderer,
	 * while the helper has to spawn, negotiate a portal session and WAIT FOR THE
	 * USER to answer a picker before its first frame exists. That last part makes
	 * the gap here unbounded rather than merely a process spawn, so trimming it
	 * matters more than it does on macOS. `null` when no webcam was recorded.
	 */
	webcamOffsetMs: number | null;
};

/**
 * How far AHEAD of the native screen recording the browser-recorded webcam
 * started, in whole milliseconds (negative, since the webcam always starts
 * first). `null` when this session recorded no webcam.
 *
 * WHOLE milliseconds on purpose. Both timestamps come from `performance.now()`,
 * whose resolution is 100 µs, so the raw subtraction is almost never an integer
 * — and this number ends up in `cameraTrack.offsetMs`, which the document schema
 * declares as an int. A fractional value failed validation, the camera link was
 * dropped as if the recording had no camera, and the editor drew the screen
 * video in the camera's place. Rounding loses nothing: one frame at 60 fps is
 * 16.7 ms.
 */
export function webcamOffsetMsFrom(
	webcamRecorder: RecorderHandle | null,
	webcamStartedAtMs: number | null,
	nativeStartedAtMs: number,
): number | null {
	if (!webcamRecorder || webcamStartedAtMs === null) {
		return null;
	}
	return -Math.round(nativeStartedAtMs - webcamStartedAtMs);
}

/**
 * Turn a finished webcam recorder into the asset the native attach IPC wants, or
 * into the reason it cannot be saved. Shared by the macOS and Linux finalizers,
 * which differ only in the name they log under.
 *
 * A streamed recording resolves an empty blob by design — its bytes are already
 * on disk — so it hands over the file name alone and the main process closes the
 * stream and patches the duration there. Only a buffered recording is read into
 * memory, and flattening one of those into a single ArrayBuffer is exactly what
 * used to throw past ~2 GB and cost the user the whole camera track (#253).
 *
 * Never resolves to "nothing happened": every failure comes back with a reason,
 * because the screen recording still saves and a silent drop just opens the
 * editor with the camera mysteriously absent.
 */
export async function finalizeWebcamAsset(
	webcamRecorder: RecorderHandle,
	fileName: string,
	durationMs: number,
	platformLabel: string,
): Promise<{ asset?: RecordedVideoAssetInput; error?: string }> {
	try {
		if (webcamRecorder.recorder.state !== "inactive") {
			webcamRecorder.recorder.stop();
		}
		// Rejects on a mid-stream write failure, so a truncated recording lands in
		// the catch below rather than passing for a good one.
		const webcamBlob = await webcamRecorder.recordedBlobPromise;
		if (webcamRecorder.isStreaming()) {
			return { asset: { videoData: new ArrayBuffer(0), fileName } };
		}
		if (!webcamBlob || webcamBlob.size === 0) {
			return { error: "the webcam produced no data" };
		}
		const fixedWebcamBlob = await fixWebmDuration(webcamBlob, durationMs);
		return { asset: { videoData: await fixedWebcamBlob.arrayBuffer(), fileName } };
	} catch (error) {
		console.error(`Failed to finalize native ${platformLabel} webcam recording:`, error);
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export function useScreenRecorder(): UseScreenRecorderReturn {
	const t = useScopedT("editor");
	/**
	 * `t` through a ref, for the callbacks that must not be rebuilt when it
	 * changes identity.
	 *
	 * `finalizeNativeWindowsRecording` is one of them: it sits in the dependency
	 * array of the unmount effect below, whose cleanup bumps `countdownRunId` and
	 * discards any native recording in flight. Recreating that callback therefore
	 * re-runs the effect, and its cleanup silently cancels the countdown a
	 * recording is starting from — the take never begins, with nothing logged.
	 */
	const tRef = useRef(t);
	// In an effect, not during render: a render React discards still leaves a ref
	// written there, and a later recording error would then be worded by a UI that
	// never reached the screen.
	useEffect(() => {
		tRef.current = t;
	}, [t]);
	const [recording, setRecording] = useState(false);
	const [paused, setPaused] = useState(false);
	const [saving, setSaving] = useState(false);
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
	const [microphoneDeviceId, setMicrophoneDeviceId] = useState<string | undefined>(undefined);
	const [microphoneDeviceName, setMicrophoneDeviceName] = useState<string | undefined>(undefined);
	const [webcamDeviceId, setWebcamDeviceId] = useState<string | undefined>(undefined);
	const [webcamDeviceName, setWebcamDeviceName] = useState<string | undefined>(undefined);
	const [systemAudioEnabled, setSystemAudioEnabled] = useState(false);
	const [webcamEnabled, setWebcamEnabledState] = useState(false);
	const [cursorCaptureMode, setCursorCaptureMode] = useState<CursorCaptureMode>("editable-overlay");
	const [softwareEncoderFallbackNoticeVisible, setSoftwareEncoderFallbackNoticeVisible] =
		useState(false);

	// Seed from the main-process recording-prefs SSOT on mount, so choices
	// made in the editor's Rec-mode stage (a different renderer window) carry
	// over instead of this hook silently reverting to its own hardcoded
	// defaults every time startNewRecording() switches to the HUD window.
	useEffect(() => {
		let cancelled = false;
		void window.electronAPI
			?.getRecordingPrefs?.()
			.then((prefs) => {
				if (cancelled || !prefs) return;
				setMicrophoneEnabled(prefs.micEnabled);
				if (prefs.micDeviceId) setMicrophoneDeviceId(prefs.micDeviceId);
				// The name matters as much as the id: the native Windows helper picks
				// the microphone by NAME, and falls back to the Windows default
				// endpoint when it is empty. Seeding only the id left an auto-started
				// recording racing this window's own device enumeration for it, and
				// losing (getopenscreen/openscreen#404).
				if (prefs.micDeviceName) setMicrophoneDeviceName(prefs.micDeviceName);
				setWebcamEnabledState(prefs.camEnabled);
				if (prefs.camDeviceId) setWebcamDeviceId(prefs.camDeviceId);
				setSystemAudioEnabled(prefs.systemAudioEnabled);
				setCursorCaptureMode(prefs.cursorCaptureMode);
			})
			.catch((err) => {
				// Bare ipcRenderer.invoke — rejects if the main handler throws. Falling
				// back to this hook's own defaults is acceptable; an unhandled rejection
				// on every HUD mount is not.
				console.warn("Failed to seed the recording prefs:", err);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const screenRecorder = useRef<RecorderHandle | null>(null);
	const webcamRecorder = useRef<RecorderHandle | null>(null);
	const nativeWindowsRecording = useRef<NativeWindowsRecordingHandle | null>(null);
	const nativeMacRecording = useRef<NativeMacRecordingHandle | null>(null);
	const nativeLinuxRecording = useRef<NativeLinuxRecordingHandle | null>(null);
	const stream = useRef<MediaStream | null>(null);
	const screenStream = useRef<MediaStream | null>(null);
	const microphoneStream = useRef<MediaStream | null>(null);
	const webcamStream = useRef<MediaStream | null>(null);
	const mixingContext = useRef<AudioContext | null>(null);
	const recordingId = useRef<number>(0);
	const accumulatedDurationMs = useRef(0);
	const segmentStartedAt = useRef<number | null>(null);
	const finalizingRecordingId = useRef<number | null>(null);
	const allowAutoFinalize = useRef(false);
	const discardRecordingId = useRef<number | null>(null);
	const restarting = useRef(false);
	const countdownRunId = useRef(0);
	const [countdownActive, setCountdownActive] = useState(false);
	const webcamReady = useRef(false);
	const webcamAcquireId = useRef(0);
	const canPauseRecording =
		recording &&
		Boolean(
			(nativeWindowsRecording.current && !nativeWindowsRecording.current.finalizing) ||
				(nativeMacRecording.current && !nativeMacRecording.current.finalizing) ||
				(nativeLinuxRecording.current && !nativeLinuxRecording.current.finalizing) ||
				(screenRecorder.current && screenRecorder.current.recorder.state !== "inactive"),
		);

	const getRecordingDurationMs = useCallback(() => {
		const segmentDuration =
			segmentStartedAt.current === null ? 0 : Date.now() - segmentStartedAt.current;
		return accumulatedDurationMs.current + segmentDuration;
	}, []);

	const selectMimeType = () => {
		// H.264 first: hardware-accelerated, so sharp real-time output. AV1/VP9 are
		// better for distribution but too CPU-heavy for live 60 fps capture (software
		// encoder falls behind and produces blurry frames).
		const preferred = [
			"video/webm;codecs=h264",
			"video/webm;codecs=vp8",
			"video/webm;codecs=vp9",
			"video/webm;codecs=av1",
			"video/webm",
		];

		return preferred.find((type) => MediaRecorder.isTypeSupported(type)) ?? "video/webm";
	};

	const computeBitrate = (width: number, height: number) => {
		const pixels = width * height;
		const highFrameRateBoost =
			TARGET_FRAME_RATE >= HIGH_FRAME_RATE_THRESHOLD ? HIGH_FRAME_RATE_BOOST : 1;

		if (pixels >= FOUR_K_PIXELS) {
			return Math.round(BITRATE_4K * highFrameRateBoost);
		}

		if (pixels >= QHD_PIXELS) {
			return Math.round(BITRATE_QHD * highFrameRateBoost);
		}

		return Math.round(BITRATE_BASE * highFrameRateBoost);
	};

	const teardownMedia = useCallback(() => {
		if (stream.current) {
			stream.current.getTracks().forEach((track) => track.stop());
			stream.current = null;
		}
		if (screenStream.current) {
			screenStream.current.getTracks().forEach((track) => track.stop());
			screenStream.current = null;
		}
		if (microphoneStream.current) {
			microphoneStream.current.getTracks().forEach((track) => track.stop());
			microphoneStream.current = null;
		}
		if (mixingContext.current) {
			mixingContext.current.close().catch(() => {
				// Ignore close errors during recorder teardown.
			});
			mixingContext.current = null;
		}
	}, []);

	/**
	 * The camera to name in a native capture request. See
	 * `webcamDeviceIdentityFrom` for why it is read off the live track rather than
	 * off this hook's two separate pieces of state. Must be called before
	 * `stopWebcamPreviewStream()`, which is why the Windows path captures it up
	 * front instead of at the point of use.
	 */
	const readWebcamDeviceIdentity = useCallback(
		() => webcamDeviceIdentityFrom(webcamStream.current, webcamDeviceId, webcamDeviceName),
		[webcamDeviceId, webcamDeviceName],
	);

	const stopWebcamPreviewStream = useCallback(() => {
		if (!webcamStream.current) {
			return;
		}

		webcamAcquireId.current++;
		webcamStream.current.getTracks().forEach((track) => {
			track.onended = null;
			track.stop();
		});
		webcamStream.current = null;
		webcamReady.current = true;
	}, []);

	const setWebcamEnabled = useCallback(
		async (enabled: boolean) => {
			if (!enabled) {
				setWebcamEnabledState(false);
				return true;
			}

			const accessResult = await requestCameraAccess();
			if (!accessResult.success) {
				toast.error(t("recording.failedCameraAccess"));
				return false;
			}

			if (!accessResult.granted) {
				toast.error(t("recording.cameraBlocked"));
				return false;
			}

			setWebcamEnabledState(true);
			return true;
		},
		[t],
	);

	useEffect(() => {
		if (!webcamEnabled) return;

		let cancelled = false;
		let acquiredStream: MediaStream | null = null;
		const thisAcquireId = ++webcamAcquireId.current;
		webcamReady.current = false;

		const acquire = async () => {
			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					audio: false,
					video: webcamDeviceId
						? {
								deviceId: { exact: webcamDeviceId },
								frameRate: { ideal: WEBCAM_TARGET_FRAME_RATE, max: WEBCAM_TARGET_FRAME_RATE },
							}
						: {
								frameRate: { ideal: WEBCAM_TARGET_FRAME_RATE, max: WEBCAM_TARGET_FRAME_RATE },
							},
				});

				if (cancelled || thisAcquireId !== webcamAcquireId.current) {
					stream.getTracks().forEach((track) => {
						track.onended = null;
						track.stop();
					});
					return;
				}

				acquiredStream = stream;
				stream.getVideoTracks().forEach((track) => {
					track.onended = () => {
						webcamStream.current = null;
						if (!restarting.current) {
							setWebcamEnabledState(false);
							toast.error(t("recording.cameraDisconnected"));
						}
					};
				});
				webcamStream.current = stream;
				webcamReady.current = true;
			} catch (cameraError) {
				if (!cancelled) {
					console.warn("Failed to get webcam access:", cameraError);
					setWebcamEnabledState(false);
					const isDeviceError =
						cameraError instanceof DOMException &&
						[
							"NotFoundError",
							"DevicesNotFoundError",
							"OverconstrainedError",
							"NotReadableError",
						].includes(cameraError.name);
					toast.error(t(isDeviceError ? "recording.cameraNotFound" : "recording.cameraBlocked"));
					webcamReady.current = true;
				}
			}
		};

		void acquire();

		return () => {
			cancelled = true;
			webcamReady.current = false;
			if (acquiredStream) {
				acquiredStream.getTracks().forEach((track) => {
					track.onended = null;
					track.stop();
				});
				webcamStream.current = null;
			}
		};
	}, [webcamEnabled, webcamDeviceId, t]);

	const finalizeRecording = useCallback(
		(
			activeScreenRecorder: RecorderHandle,
			activeWebcamRecorder: RecorderHandle | null,
			duration: number,
			activeRecordingId: number,
		) => {
			if (finalizingRecordingId.current === activeRecordingId) {
				return;
			}
			finalizingRecordingId.current = activeRecordingId;
			// Only show the "Saving…" spinner for genuine saves — not for cancel/restart
			// flows where discardRecordingId has already been set.
			const isDiscarded = discardRecordingId.current === activeRecordingId;
			if (!isDiscarded) {
				setSaving(true);
			}

			if (screenRecorder.current === activeScreenRecorder) {
				screenRecorder.current = null;
			}
			if (activeWebcamRecorder && webcamRecorder.current === activeWebcamRecorder) {
				webcamRecorder.current = null;
			}

			teardownMedia();
			setRecording(false);
			setPaused(false);
			setElapsedSeconds(0);
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = null;
			window.electronAPI?.setRecordingState(false);

			void (async () => {
				// Each disk stream must end up either saved or explicitly discarded.
				// store-recorded-session finalizes the streams included in a successful
				// save; the finally block discards everything else.
				let storeSucceeded = false;
				let webcamIncludedInSave = false;
				try {
					const screenBlob = await activeScreenRecorder.recordedBlobPromise;
					if (discardRecordingId.current === activeRecordingId) {
						window.electronAPI?.discardCursorTelemetry(activeRecordingId);
						return;
					}
					// When streaming succeeded the blob is empty; the data is already on disk.
					if (!activeScreenRecorder.isStreaming() && screenBlob.size === 0) {
						return;
					}

					const screenFileName = `${RECORDING_FILE_PREFIX}${activeRecordingId}${VIDEO_FILE_EXTENSION}`;
					const webcamFileName = `${RECORDING_FILE_PREFIX}${activeRecordingId}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`;

					// Only fix duration / convert to ArrayBuffer for in-memory data;
					// streamed recordings are patched on disk by the main process.
					let screenVideoData: ArrayBuffer = new ArrayBuffer(0);
					if (!activeScreenRecorder.isStreaming() && screenBlob.size > 0) {
						const fixedScreenBlob = await fixWebmDuration(screenBlob, duration);
						screenVideoData = await fixedScreenBlob.arrayBuffer();
					}

					let webcamVideoData: ArrayBuffer | undefined;
					if (activeWebcamRecorder) {
						const webcamBlob = await activeWebcamRecorder.recordedBlobPromise.catch(() => null);
						if (!activeWebcamRecorder.isStreaming() && webcamBlob && webcamBlob.size > 0) {
							const fixedWebcamBlob = await fixWebmDuration(webcamBlob, duration);
							webcamVideoData = await fixedWebcamBlob.arrayBuffer();
						} else if (activeWebcamRecorder.isStreaming()) {
							webcamVideoData = new ArrayBuffer(0);
						}
					}
					webcamIncludedInSave = webcamVideoData !== undefined;

					const result = await window.electronAPI.storeRecordedSession({
						screen: {
							videoData: screenVideoData,
							fileName: screenFileName,
						},
						webcam:
							webcamVideoData !== undefined
								? { videoData: webcamVideoData, fileName: webcamFileName }
								: undefined,
						createdAt: activeRecordingId,
						// What this take actually did, not what was requested. Only the browser
						// pipeline reaches this finalizer (stopRecording returns earlier for all
						// three native paths), and off win32 it cannot exclude the system cursor
						// — so the mode reported to the main process was forced to "system" and
						// the stored metadata has to agree. It is user-visible: `openscreen
						// project show` prints it.
						cursorCaptureMode: effectiveBrowserCursorMode(
							window.electronAPI.getPlatform(),
							cursorCaptureMode,
						),
						durationMs: duration,
					});

					if (!result.success) {
						console.error("Failed to store recording session:", result.message);
						return;
					}
					// store-recorded-session has flushed and closed the saved streams.
					storeSucceeded = true;

					if (result.session) {
						await window.electronAPI.setCurrentRecordingSession(result.session);
					} else if (result.path) {
						await window.electronAPI.setCurrentVideoPath(result.path);
					}

					await window.electronAPI.switchToEditor();
				} catch (error) {
					console.error("Error saving recording:", error);
				} finally {
					// Discard any recorder whose data wasn't part of a successful save (discarded
					// run, failed save, or a webcam whose disk write failed while the screen still
					// saved) so no stream or partial file is left open or orphaned.
					if (!storeSucceeded) {
						await activeScreenRecorder.discard().catch(() => undefined);
					}
					if (activeWebcamRecorder && !(storeSucceeded && webcamIncludedInSave)) {
						await activeWebcamRecorder.discard().catch(() => undefined);
					}
					if (finalizingRecordingId.current === activeRecordingId) {
						finalizingRecordingId.current = null;
					}
					if (discardRecordingId.current === activeRecordingId) {
						discardRecordingId.current = null;
					}
					setSaving(false);
				}
			})();
		},
		[cursorCaptureMode, teardownMedia],
	);

	const finalizeNativeWindowsRecording = useCallback(async (discard = false) => {
		const activeNativeRecording = nativeWindowsRecording.current;
		if (!activeNativeRecording || activeNativeRecording.finalizing) {
			return false;
		}

		activeNativeRecording.finalizing = true;
		if (!discard) {
			setSaving(true);
		}

		const clearNativeRecordingState = () => {
			nativeWindowsRecording.current = null;
			setRecording(false);
			setPaused(false);
			setElapsedSeconds(0);
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = null;
		};

		try {
			const result = await window.electronAPI.stopNativeWindowsRecording(discard);
			if (discard || result.discarded) {
				clearNativeRecordingState();
				return true;
			}
			if (!result.success) {
				console.error("Failed to stop native Windows recording:", result.error);
				toast.error(result.error ?? "Failed to stop native Windows recording");
				// Clear anyway. The main process releases its helper handle
				// unconditionally, so holding on here left the two sides
				// disagreeing about whether anything was recording: the HUD kept
				// showing a stop button, and pressing it sent a second stop that
				// came back "Native Windows capture is not running." (issue #252).
				// Reaching here now means the take really is unreadable -- a failed
				// stop that left a playable fragmented file comes back `success`
				// with a session and takes the editor path below, so this branch no
				// longer decides the fate of a recoverable recording.
				clearNativeRecordingState();
				return true;
			}

			clearNativeRecordingState();
			// The other way a camera goes missing, and the quieter one: the device
			// opened, so nothing warned at start, but it never produced a frame and
			// the file it left behind was empty. Say so before the editor opens
			// without a camera and leaves the user to work out why. Through `tRef`
			// because this callback has to stay referentially stable — see the ref's
			// own comment.
			if (result.webcamDropped) {
				toast.error(tRef.current("recording.cameraCaptureUnavailable"));
			}
			if (result.session) {
				await window.electronAPI.setCurrentRecordingSession(result.session);
			} else if (result.path) {
				await window.electronAPI.setCurrentVideoPath(result.path);
			}

			await window.electronAPI.switchToEditor();
			return true;
		} catch (error) {
			console.error("Error saving native Windows recording:", error);
			toast.error(
				error instanceof Error ? error.message : "Failed to save native Windows recording",
			);
			clearNativeRecordingState();
			return true;
		} finally {
			if (discardRecordingId.current === activeNativeRecording.recordingId) {
				discardRecordingId.current = null;
			}
			setSaving(false);
		}
	}, []);

	const finalizeNativeMacRecording = useCallback(
		async (discard = false) => {
			const activeNativeRecording = nativeMacRecording.current;
			if (!activeNativeRecording || activeNativeRecording.finalizing) {
				return false;
			}

			activeNativeRecording.finalizing = true;
			if (!discard) {
				setSaving(true);
			}
			const duration = Math.max(0, getRecordingDurationMs());
			const activeWebcamRecorder = webcamRecorder.current;
			if (activeWebcamRecorder && webcamRecorder.current === activeWebcamRecorder) {
				webcamRecorder.current = null;
			}
			// The webcam MediaRecorder started before the native recording did (see
			// webcamOffsetMs on NativeMacRecordingHandle), so its real content is
			// longer than the screen's active `duration` by that same head start.
			// Patching the WebM's declared duration to the screen's shorter duration
			// would make that extra leading footage unseekable in a standard <video>
			// element (which trusts the container's declared duration/seek range) --
			// exactly the footage the editor needs to skip into to compensate for
			// webcamOffsetMs, so it must stay reachable.
			const webcamHeadStartMs = Math.max(0, -(activeNativeRecording.webcamOffsetMs ?? 0));
			const webcamDurationMs = duration + webcamHeadStartMs;
			const webcamFileName = `${RECORDING_FILE_PREFIX}${activeNativeRecording.recordingId}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`;
			const webcamResultPromise: Promise<{
				asset?: RecordedVideoAssetInput;
				error?: string;
			}> = activeWebcamRecorder
				? finalizeWebcamAsset(activeWebcamRecorder, webcamFileName, webcamDurationMs, "macOS")
				: Promise.resolve({});

			const clearNativeRecordingState = () => {
				nativeMacRecording.current = null;
				setRecording(false);
				setPaused(false);
				setElapsedSeconds(0);
				accumulatedDurationMs.current = 0;
				segmentStartedAt.current = null;
			};

			let webcamSaved = false;
			try {
				const result = await window.electronAPI.stopNativeMacRecording(discard);
				const webcamResult = await webcamResultPromise;
				if (discard || result.discarded) {
					clearNativeRecordingState();
					return true;
				}
				if (!result.success) {
					console.error("Failed to stop native macOS recording:", result.error);
					toast.error(result.error ?? "Failed to stop native macOS recording");
					// See the Windows finalizer: the main process has already
					// released its helper handle, so keeping ours leaves the HUD
					// stuck in a recording state the app can never be stopped out
					// of (issue #252).
					clearNativeRecordingState();
					return true;
				}

				if (webcamResult.asset && result.path) {
					const attachResult = await window.electronAPI.attachNativeMacWebcamRecording({
						screenVideoPath: result.path,
						recordingId: activeNativeRecording.recordingId,
						webcam: webcamResult.asset,
						cursorCaptureMode,
						durationMs: webcamDurationMs,
						...(typeof activeNativeRecording.webcamOffsetMs === "number"
							? { webcamOffsetMs: activeNativeRecording.webcamOffsetMs }
							: {}),
					});
					if (attachResult.success) {
						result.session = attachResult.session;
						webcamSaved = true;
					} else {
						console.error("Failed to attach native macOS webcam recording:", attachResult.error);
						toast.error(attachResult.error ?? "Failed to store webcam recording");
					}
				} else if (webcamResult.error) {
					// The screen recording still saves, so without this the editor just
					// opens with the camera missing and nothing said about it (#253).
					toast.error(`Webcam not saved (${webcamResult.error}). The screen recording was kept.`);
				}

				clearNativeRecordingState();
				if (result.session) {
					await window.electronAPI.setCurrentRecordingSession(result.session);
				} else if (result.path) {
					await window.electronAPI.setCurrentVideoPath(result.path);
				}

				await window.electronAPI.switchToEditor();
				return true;
			} catch (error) {
				console.error("Error saving native macOS recording:", error);
				toast.error(
					error instanceof Error ? error.message : "Failed to save native macOS recording",
				);
				clearNativeRecordingState();
				return true;
			} finally {
				// A webcam stream that wasn't folded into a saved session has to be closed
				// and its partial file removed, or a discarded or failed take orphans a
				// half-written .webm now that the bytes go to disk as they arrive.
				if (activeWebcamRecorder && !webcamSaved) {
					await activeWebcamRecorder.discard().catch(() => undefined);
				}
				if (discardRecordingId.current === activeNativeRecording.recordingId) {
					discardRecordingId.current = null;
				}
				setSaving(false);
			}
		},
		[cursorCaptureMode, getRecordingDurationMs],
	);

	/**
	 * The Linux twin of `finalizeNativeMacRecording`. Same shape, because the two
	 * platforms make the same split: helper owns screen and audio, renderer owns
	 * the webcam, and the two are reconciled here.
	 */
	const finalizeNativeLinuxRecording = useCallback(
		async (discard = false) => {
			const activeNativeRecording = nativeLinuxRecording.current;
			if (!activeNativeRecording || activeNativeRecording.finalizing) {
				return false;
			}

			activeNativeRecording.finalizing = true;
			if (!discard) {
				setSaving(true);
			}
			const duration = Math.max(0, getRecordingDurationMs());
			const activeWebcamRecorder = webcamRecorder.current;
			if (activeWebcamRecorder && webcamRecorder.current === activeWebcamRecorder) {
				webcamRecorder.current = null;
			}
			// See the identical comment in finalizeNativeMacRecording: the
			// leading footage recorded while the portal picker was up must
			// stay seekable, so the declared duration includes it.
			const webcamHeadStartMs = Math.max(0, -(activeNativeRecording.webcamOffsetMs ?? 0));
			const webcamDurationMs = duration + webcamHeadStartMs;
			const webcamFileName = `${RECORDING_FILE_PREFIX}${activeNativeRecording.recordingId}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`;
			const webcamResultPromise: Promise<{
				asset?: RecordedVideoAssetInput;
				error?: string;
			}> = activeWebcamRecorder
				? finalizeWebcamAsset(activeWebcamRecorder, webcamFileName, webcamDurationMs, "Linux")
				: Promise.resolve({});

			const clearNativeRecordingState = () => {
				nativeLinuxRecording.current = null;
				setRecording(false);
				setPaused(false);
				setElapsedSeconds(0);
				accumulatedDurationMs.current = 0;
				segmentStartedAt.current = null;
			};

			let webcamSaved = false;
			try {
				const result = await window.electronAPI.stopNativeLinuxRecording(discard);
				const webcamResult = await webcamResultPromise;
				if (discard || result.discarded) {
					clearNativeRecordingState();
					return true;
				}
				if (!result.success) {
					console.error("Failed to stop native Linux recording:", result.error);
					toast.error(result.error ?? "Failed to stop native Linux recording");
					// See the Windows finalizer: the main process has already
					// released its helper handle, so keeping ours leaves the HUD
					// stuck in a recording state the app can never be stopped out
					// of (issue #252).
					clearNativeRecordingState();
					return true;
				}

				if (webcamResult.asset && result.path) {
					const attachResult = await window.electronAPI.attachNativeLinuxWebcamRecording({
						screenVideoPath: result.path,
						recordingId: activeNativeRecording.recordingId,
						webcam: webcamResult.asset,
						cursorCaptureMode,
						durationMs: webcamDurationMs,
						...(typeof activeNativeRecording.webcamOffsetMs === "number"
							? { webcamOffsetMs: activeNativeRecording.webcamOffsetMs }
							: {}),
					});
					if (attachResult.success) {
						result.session = attachResult.session;
						webcamSaved = true;
					} else {
						console.error("Failed to attach native Linux webcam recording:", attachResult.error);
						toast.error(attachResult.error ?? "Failed to store webcam recording");
					}
				} else if (webcamResult.error) {
					// The screen recording still saves, so without this the editor just
					// opens with the camera missing and nothing said about it (#253).
					toast.error(`Webcam not saved (${webcamResult.error}). The screen recording was kept.`);
				}

				clearNativeRecordingState();
				if (result.session) {
					await window.electronAPI.setCurrentRecordingSession(result.session);
				} else if (result.path) {
					await window.electronAPI.setCurrentVideoPath(result.path);
				}

				await window.electronAPI.switchToEditor();
				return true;
			} catch (error) {
				console.error("Error saving native Linux recording:", error);
				toast.error(
					error instanceof Error ? error.message : "Failed to save native Linux recording",
				);
				clearNativeRecordingState();
				return true;
			} finally {
				// A webcam stream that wasn't folded into a saved session has to be closed
				// and its partial file removed, or a discarded or failed take orphans a
				// half-written .webm now that the bytes go to disk as they arrive.
				if (activeWebcamRecorder && !webcamSaved) {
					await activeWebcamRecorder.discard().catch(() => undefined);
				}
				if (discardRecordingId.current === activeNativeRecording.recordingId) {
					discardRecordingId.current = null;
				}
				setSaving(false);
			}
		},
		[cursorCaptureMode, getRecordingDurationMs],
	);

	const stopRecording = useRef(() => {
		if (nativeWindowsRecording.current) {
			void finalizeNativeWindowsRecording(false);
			return;
		}
		if (nativeMacRecording.current) {
			void finalizeNativeMacRecording(false);
			return;
		}
		if (nativeLinuxRecording.current) {
			void finalizeNativeLinuxRecording(false);
			return;
		}

		const activeScreenRecorder = screenRecorder.current;
		if (!activeScreenRecorder) {
			return;
		}

		const activeWebcamRecorder = webcamRecorder.current;
		const duration = getRecordingDurationMs();
		const activeRecordingId = recordingId.current;

		finalizeRecording(
			activeScreenRecorder,
			activeWebcamRecorder ?? null,
			duration,
			activeRecordingId,
		);

		if (
			activeScreenRecorder.recorder.state === "recording" ||
			activeScreenRecorder.recorder.state === "paused"
		) {
			try {
				activeScreenRecorder.recorder.stop();
			} catch {
				// Recorder may already be stopping.
			}
		}
		if (activeWebcamRecorder) {
			if (
				activeWebcamRecorder.recorder.state === "recording" ||
				activeWebcamRecorder.recorder.state === "paused"
			) {
				try {
					activeWebcamRecorder.recorder.stop();
				} catch {
					// Recorder may already be stopping.
				}
			}
		}
	});

	const safeHideCountdownOverlay = useCallback(async (runId: number) => {
		try {
			await window.electronAPI.hideCountdownOverlay(runId);
		} catch (error) {
			console.warn("Failed to hide countdown overlay:", error);
		}
	}, []);

	useEffect(() => {
		let cleanup: (() => void) | undefined;

		if (window.electronAPI?.onStopRecordingFromTray) {
			cleanup = window.electronAPI.onStopRecordingFromTray(() => {
				stopRecording.current();
			});
		}

		return () => {
			const activeRunId = countdownRunId.current;
			if (cleanup) cleanup();
			countdownRunId.current += 1;
			void safeHideCountdownOverlay(activeRunId);
			allowAutoFinalize.current = false;
			restarting.current = false;
			discardRecordingId.current = null;
			if (nativeWindowsRecording.current) {
				void finalizeNativeWindowsRecording(true);
			}
			if (nativeMacRecording.current) {
				void finalizeNativeMacRecording(true);
			}
			if (nativeLinuxRecording.current) {
				void finalizeNativeLinuxRecording(true);
			}

			if (
				screenRecorder.current?.recorder.state === "recording" ||
				screenRecorder.current?.recorder.state === "paused"
			) {
				try {
					screenRecorder.current.recorder.stop();
				} catch {
					// Ignore recorder teardown errors during cleanup.
				}
			}
			if (
				webcamRecorder.current?.recorder.state === "recording" ||
				webcamRecorder.current?.recorder.state === "paused"
			) {
				try {
					webcamRecorder.current.recorder.stop();
				} catch {
					// Ignore recorder teardown errors during cleanup.
				}
			}
			screenRecorder.current = null;
			webcamRecorder.current = null;
			teardownMedia();
		};
	}, [
		teardownMedia,
		safeHideCountdownOverlay,
		finalizeNativeWindowsRecording,
		finalizeNativeMacRecording,
		finalizeNativeLinuxRecording,
	]);

	const safeShowCountdownOverlay = async (value: number, runId: number) => {
		try {
			await window.electronAPI.showCountdownOverlay(value, runId);
			return true;
		} catch (error) {
			console.warn("Failed to show countdown overlay:", error);
			return false;
		}
	};

	const cancelCountdown = () => {
		const activeRunId = countdownRunId.current;
		countdownRunId.current += 1;
		setCountdownActive(false);
		void safeHideCountdownOverlay(activeRunId);
	};

	const safeSetCountdownOverlayValue = async (value: number, runId: number) => {
		try {
			await window.electronAPI.setCountdownOverlayValue(value, runId);
		} catch (error) {
			console.warn("Failed to update countdown overlay value:", error);
		}
	};

	const isCountdownRunActive = (runId?: number) =>
		runId === undefined || countdownRunId.current === runId;

	const waitForWebcamReady = async () => {
		if (webcamReady.current) {
			return;
		}

		await new Promise<void>((resolve) => {
			const interval = setInterval(() => {
				if (webcamReady.current) {
					clearInterval(interval);
					resolve();
				}
			}, 50);
			setTimeout(() => {
				clearInterval(interval);
				resolve();
			}, 5000);
		});
	};

	const startNativeWindowsRecordingIfAvailable = async (
		selectedSource: ProcessedDesktopSource,
		countdownRunToken?: number,
	) => {
		try {
			const platform = window.electronAPI.getPlatform();
			if (platform !== "win32") {
				return false;
			}

			const availability = await window.electronAPI.isNativeWindowsCaptureAvailable();
			if (!availability.success || !availability.available) {
				if (availability.reason === "unsupported-os") {
					return false;
				}
				if (availability.reason === "missing-helper") {
					console.warn("Native Windows capture helper is not available; using browser capture.");
					return false;
				}

				throw new Error(availability.error ?? "Native Windows capture is not available.");
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				return true;
			}

			const activeRecordingId = Date.now();
			const displayId = Number(selectedSource.display_id);
			const sourceType = selectedSource.id.startsWith("window:") ? "window" : "display";
			const windowHandle = parseWindowHandleFromSourceId(selectedSource.id);
			let webcamIdentity = { deviceId: webcamDeviceId, deviceName: webcamDeviceName };
			if (webcamEnabled) {
				await waitForWebcamReady();
				if (!isCountdownRunActive(countdownRunToken)) {
					return true;
				}
				// Read the device off the live track before letting go of it: this is
				// the only moment where the id and the name are known to describe the
				// same camera (see readWebcamDeviceIdentity).
				webcamIdentity = readWebcamDeviceIdentity();
				// Release the renderer-side validation stream before asking the native
				// helper to open the same device: most webcams only allow one exclusive
				// capture session, and native (Media Foundation/DirectShow) now owns
				// webcam capture directly, sharing the same recording-start clock as
				// screen video and audio instead of racing a separately-started browser
				// MediaRecorder against the helper's own process-spawn/WGC-init latency.
				stopWebcamPreviewStream();
			}
			const request: NativeWindowsRecordingRequest = {
				recordingId: activeRecordingId,
				preferSoftwareEncoder: loadUserPreferences().preferSoftwareEncoder,
				source: {
					type: sourceType,
					sourceId: selectedSource.id,
					...(Number.isFinite(displayId) ? { displayId } : {}),
					...(windowHandle ? { windowHandle } : {}),
				},
				video: {
					fps: TARGET_FRAME_RATE,
					width: TARGET_WIDTH,
					height: TARGET_HEIGHT,
				},
				audio: {
					system: {
						enabled: systemAudioEnabled,
					},
					microphone: {
						enabled: microphoneEnabled,
						deviceId: microphoneDeviceId,
						deviceName: microphoneDeviceName,
						gain: MIC_GAIN_BOOST,
					},
				},
				webcam: {
					enabled: webcamEnabled,
					deviceId: webcamIdentity.deviceId,
					deviceName: webcamIdentity.deviceName,
					width: 0,
					height: 0,
					fps: WEBCAM_TARGET_FRAME_RATE,
				},
				cursor: {
					mode: cursorCaptureMode,
				},
			};
			const result = await window.electronAPI.startNativeWindowsRecording(request);
			if (!result.success || !result.recordingId) {
				throw new Error(result.error ?? "Native Windows capture failed.");
			}

			// The take goes on without the camera rather than failing, so this is the
			// only moment the user can learn about it while it is still cheap to stop
			// and retry. Left unsaid, the camera's absence was discovered in the
			// editor, long after the moment was gone.
			if (result.webcamUnavailable) {
				toast.error(t("recording.cameraCaptureUnavailable"));
			}
			if (result.microphoneDefaulted) {
				toast.error(t("recording.microphoneDefaulted"));
			}

			// Tell the user when the helper silently switched away from the default
			// GPU encoder; an explicit software-preferred selection needs no notice.
			setSoftwareEncoderFallbackNoticeVisible(
				result.videoEncoderSelection === "software-fallback" &&
					!loadUserPreferences().hideSoftwareEncoderFallbackNotice,
			);

			recordingId.current = result.recordingId;
			nativeWindowsRecording.current = {
				recordingId: result.recordingId,
				finalizing: false,
				paused: false,
			};
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = Date.now();
			allowAutoFinalize.current = true;
			setRecording(true);
			setPaused(false);
			setElapsedSeconds(0);
			return true;
		} catch (error) {
			console.error("Native Windows capture failed:", error);
			throw error;
		}
	};

	const startNativeMacRecordingIfAvailable = async (
		selectedSource: ProcessedDesktopSource,
		countdownRunToken?: number,
	) => {
		try {
			const platform = window.electronAPI.getPlatform();
			if (platform !== "darwin") {
				return false;
			}

			const availability = await window.electronAPI.isNativeMacCaptureAvailable();
			if (!availability.success || !availability.available) {
				if (availability.reason === "unsupported-platform") {
					return false;
				}

				// macOS 12: the helper is present but ScreenCaptureKit capture is gated to
				// 13+, so fall back to the browser pipeline rather than refusing to record.
				// Windows does the same at the equivalent branch above, and Linux below.
				if (availability.reason === "unsupported-os") {
					console.warn("Native macOS capture needs macOS 13 or later; using browser capture.");
					return false;
				}

				throw new Error(
					availability.reason === "missing-helper"
						? "Native macOS capture helper is not available."
						: (availability.error ?? "Native macOS capture is not available."),
				);
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				return true;
			}

			const activeRecordingId = Date.now();
			const sourceType = selectedSource.id.startsWith("window:") ? "window" : "display";
			const displayId =
				Number(selectedSource.display_id) || parseMacDisplayIdFromSourceId(selectedSource.id);
			const windowId = parseMacWindowIdFromSourceId(selectedSource.id);
			let nativeWebcamRecorder: RecorderHandle | null = null;
			// createRecorderHandle() calls MediaRecorder.start() synchronously, so the
			// webcam clip's first frame is captured right now -- before the native
			// ScreenCaptureKit helper below has even been spawned. Stamp that instant
			// so the gap to the helper's confirmed start can be trimmed from the
			// webcam asset later instead of leaving the camera looking like it lags
			// behind screen/audio (see webcamOffsetMs on NativeMacRecordingHandle).
			let nativeWebcamRecorderStartedAtMs: number | null = null;
			if (webcamEnabled) {
				if (!webcamReady.current) {
					await new Promise<void>((resolve) => {
						const interval = setInterval(() => {
							if (webcamReady.current) {
								clearInterval(interval);
								resolve();
							}
						}, 50);
						setTimeout(() => {
							clearInterval(interval);
							resolve();
						}, 5000);
					});
				}
				if (!isCountdownRunActive(countdownRunToken)) {
					return true;
				}
				if (webcamStream.current) {
					nativeWebcamRecorderStartedAtMs = performance.now();
					// Stream to disk. Buffered in memory, a long take had to be flattened
					// into one ArrayBuffer at finalize -- past ~2GB that throws, and the
					// camera was dropped without a word (#253). The main process reuses the
					// recordingId we send here, so this name is the one finalize rebuilds.
					nativeWebcamRecorder = createRecorderHandle(
						webcamStream.current,
						{
							mimeType: selectMimeType(),
							videoBitsPerSecond: BITRATE_BASE,
						},
						`${RECORDING_FILE_PREFIX}${activeRecordingId}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`,
					);
				} else {
					webcamAcquireId.current++;
					setWebcamEnabledState(false);
				}
			}
			if (!isCountdownRunActive(countdownRunToken)) {
				return true;
			}
			const request: NativeMacRecordingRequest = {
				schemaVersion: 1,
				recordingId: activeRecordingId,
				source: {
					type: sourceType,
					sourceId: selectedSource.id,
					...(displayId ? { displayId } : {}),
					...(windowId ? { windowId } : {}),
				},
				video: {
					fps: TARGET_FRAME_RATE,
					width: TARGET_WIDTH,
					height: TARGET_HEIGHT,
					bitrate: computeBitrate(TARGET_WIDTH, TARGET_HEIGHT),
					hideSystemCursor: cursorCaptureMode === "editable-overlay",
				},
				audio: {
					system: {
						enabled: systemAudioEnabled,
					},
					microphone: {
						enabled: microphoneEnabled,
						deviceId: microphoneDeviceId,
						deviceName: microphoneDeviceName,
						gain: MIC_GAIN_BOOST,
					},
				},
				webcam: {
					enabled: webcamEnabled,
					// Same pairing rule as the Windows path; here the stream is still
					// open, so the identity can be read at the point of use.
					...readWebcamDeviceIdentity(),
					width: 0,
					height: 0,
					fps: WEBCAM_TARGET_FRAME_RATE,
				},
				cursor: {
					mode: cursorCaptureMode,
				},
				outputs: {
					screenPath: "",
				},
			};
			const result = await window.electronAPI.startNativeMacRecording(request);
			if (!result.success || !result.recordingId) {
				throw new Error(result.error ?? "Native macOS capture failed.");
			}
			if (!isCountdownRunActive(countdownRunToken)) {
				await window.electronAPI.stopNativeMacRecording(true);
				return true;
			}

			// The IPC call above only resolves once the helper's stdout confirms its
			// screen capture has truly started (see waitForNativeMacCaptureStart in
			// electron/ipc/handlers.ts), so this is a reliable proxy for the native
			// recording's real t=0 in the same clock the webcam timestamp used above.
			const nativeRecordingConfirmedStartedAtMs = performance.now();
			recordingId.current = result.recordingId;
			nativeMacRecording.current = {
				recordingId: result.recordingId,
				finalizing: false,
				paused: false,
				webcamOffsetMs: webcamOffsetMsFrom(
					nativeWebcamRecorder,
					nativeWebcamRecorderStartedAtMs,
					nativeRecordingConfirmedStartedAtMs,
				),
			};
			webcamRecorder.current = nativeWebcamRecorder;
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = Date.now();
			allowAutoFinalize.current = true;
			setRecording(true);
			setPaused(false);
			setElapsedSeconds(0);
			return true;
		} catch (error) {
			console.error("Native macOS capture failed:", error);
			throw error;
		}
	};

	/**
	 * The Linux native path.
	 *
	 * Two things make it shorter than its Windows and macOS siblings, and both
	 * come from Wayland rather than from anything being unfinished:
	 *
	 *   * No `source`. The ScreenCast portal raises its OWN picker and the
	 *     compositor decides what it hands over. `selectedSource` is a
	 *     placeholder there, so passing it along would be passing a guess.
	 *   * The IPC call does not resolve until the user has answered that picker,
	 *     which has no upper bound. That is also what makes the returned instant
	 *     a trustworthy t=0 for the webcam offset below.
	 */
	/**
	 * The helper request, built in ONE place because it is now sent TWICE: once
	 * to negotiate the portal before the countdown, once to start recording after
	 * it. The two must describe the same capture — the session armed at the end
	 * is the one negotiated at the start, so a divergence in audio or cursor
	 * settings would record something the second call never asked for.
	 */
	const buildNativeLinuxRequest = (recordingId?: number): NativeLinuxRecordingRequest => ({
		...(recordingId === undefined ? {} : { recordingId }),
		video: {
			// No bitrate on purpose. TARGET_WIDTH/HEIGHT are the app's 4K ceiling,
			// not the capture size — on Wayland nobody knows that until the portal
			// has negotiated it, and the user may well have picked a single window.
			// Sending computeBitrate() of the ceiling asked for 76.5 Mbit/s for a
			// 1080p capture. The helper derives it from the size it actually got.
			fps: TARGET_FRAME_RATE,
		},
		audio: {
			system: { enabled: systemAudioEnabled },
			microphone: {
				enabled: microphoneEnabled,
				// The device LABEL, not the id. Chromium's deviceId is an opaque
				// per-origin hash that means nothing to PipeWire, whereas on a
				// PipeWire system the label IS the node's `node.description` — which
				// is what the helper matches against the graph it enumerates.
				// Sending nothing here is what made a user who picked their built-in
				// microphone get the empty headphone jack recorded, because the
				// helper then fell back to the session default source.
				...(microphoneDeviceName ? { deviceName: microphoneDeviceName } : {}),
				gain: MIC_GAIN_BOOST,
			},
		},
		cursor: { mode: cursorCaptureMode },
	});

	const startNativeLinuxRecordingIfAvailable = async (
		countdownRunToken?: number,
		preparedRecordingId?: number | null,
	) => {
		try {
			const platform = window.electronAPI.getPlatform();
			if (platform !== "linux") {
				return false;
			}

			const availability = await window.electronAPI.isNativeLinuxCaptureAvailable();
			if (!availability.success || !availability.available) {
				if (availability.reason === "unsupported-platform") {
					return false;
				}
				if (availability.reason === "missing-helper") {
					// The browser path still works, just without hardware encode,
					// cursor telemetry or a single picker. Falling back beats
					// refusing to record.
					console.warn("Native Linux capture helper is not available; using browser capture.");
					return false;
				}
				throw new Error(availability.error ?? "Native Linux capture is not available.");
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				return true;
			}

			// Reuse the prepared recording's id, or the main process cannot match
			// the session it is holding to the recording being started and would
			// discard it — negotiating a second portal session, and raising a
			// second picker, for a grant it already had.
			const activeRecordingId = preparedRecordingId ?? Date.now();
			let nativeWebcamRecorder: RecorderHandle | null = null;
			let nativeWebcamRecorderStartedAtMs: number | null = null;
			if (webcamEnabled) {
				await waitForWebcamReady();
				if (!isCountdownRunActive(countdownRunToken)) {
					return true;
				}
				if (webcamStream.current) {
					nativeWebcamRecorderStartedAtMs = performance.now();
					// See the identical comment in the macOS path: stream to disk so a long
					// take is never flattened into one ArrayBuffer at finalize (#253).
					nativeWebcamRecorder = createRecorderHandle(
						webcamStream.current,
						{
							mimeType: selectMimeType(),
							videoBitsPerSecond: BITRATE_BASE,
						},
						`${RECORDING_FILE_PREFIX}${activeRecordingId}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`,
					);
				} else {
					webcamAcquireId.current++;
					setWebcamEnabledState(false);
				}
			}

			const result = await window.electronAPI.startNativeLinuxRecording(
				buildNativeLinuxRequest(activeRecordingId),
			);
			if (!result.success || !result.recordingId) {
				throw new Error(result.error ?? "Native Linux capture failed.");
			}
			if (!isCountdownRunActive(countdownRunToken)) {
				await window.electronAPI.stopNativeLinuxRecording(true);
				return true;
			}

			// Resolved only after the helper's first encoded frame, so this is the
			// native recording's real t=0 in the same clock the webcam used above.
			const nativeRecordingConfirmedStartedAtMs = performance.now();
			recordingId.current = result.recordingId;
			nativeLinuxRecording.current = {
				recordingId: result.recordingId,
				finalizing: false,
				paused: false,
				webcamOffsetMs: webcamOffsetMsFrom(
					nativeWebcamRecorder,
					nativeWebcamRecorderStartedAtMs,
					nativeRecordingConfirmedStartedAtMs,
				),
			};
			webcamRecorder.current = nativeWebcamRecorder;
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = Date.now();
			allowAutoFinalize.current = true;
			setRecording(true);
			setPaused(false);
			setElapsedSeconds(0);
			return true;
		} catch (error) {
			console.error("Native Linux capture failed:", error);
			throw error;
		}
	};

	const startRecordCountdown = async () => {
		if (countdownActive || recording) {
			return;
		}

		const runId = countdownRunId.current + 1;
		countdownRunId.current = runId;

		let selectedSource: ProcessedDesktopSource | null = null;
		try {
			selectedSource = await window.electronAPI.getSelectedSource();
		} catch (error) {
			console.warn("Failed to read selected source before countdown:", error);
		}

		// Resolved before the liveness check below so every await stays ahead of it.
		const portalOwnsSource = await portalOwnsSourceSelection(window.electronAPI);

		if (!isCountdownRunActive(runId)) {
			return;
		}

		// The countdown's OWN source gate, distinct from the one in
		// `startRecording`. On Linux the portal has not been asked anything yet —
		// its picker is raised when capture starts, several steps after this — so
		// there is nothing to have selected, and refusing here blocked recording
		// outright once the in-app picker was removed.
		if (!selectedSource && !portalOwnsSource) {
			if (countdownRunId.current === runId) {
				setCountdownActive(false);
			}
			alert(t("recording.selectSource"));
			return;
		}

		try {
			const platform = window.electronAPI.getPlatform();
			if (platform === "darwin" && cursorCaptureMode === "editable-overlay") {
				// Stop before the countdown ONLY when the user genuinely denied
				// Accessibility — the main process is showing them a dialog that
				// deep-links to the settings pane, so pressing record again after
				// granting it will work.
				//
				// When the helper simply could not run (missing from the build, killed
				// by the loader, crashed, hung) there is nothing for the user to grant,
				// and blocking here is what left macOS 12 unable to record at all
				// (#515). Recording degrades on its own: the session falls back to
				// position-only cursor telemetry and the editor draws the cursor from
				// its bundled sprites, so only the pointer/text shape hints are lost.
				const access = await window.electronAPI.requestNativeMacCursorAccess();
				if (!access.granted && access.status === "not-determined") {
					return;
				}
				if (!access.granted) {
					console.warn(
						`Editable cursor unavailable (${access.status}); recording with position-only cursor telemetry.`,
					);
				}
			}
		} catch (error) {
			console.warn("Failed to preflight macOS cursor accessibility before countdown:", error);
		}

		// THE PICKER GOES BEFORE THE COUNTDOWN. On Wayland the compositor's dialog
		// is the source chooser, and it only appears once the portal session is
		// started — so counting down first meant counting down before the user had
		// been asked anything, then freezing the overlay while they read a dialog
		// that has no time limit. Kooha does the same in the same order: session,
		// then timer, then play.
		//
		// Best-effort on purpose. A failure here is not a failure to record: the
		// start below still negotiates the portal itself, which is exactly the
		// behaviour that shipped before this existed.
		let preparedRecordingId: number | null = null;
		if (portalOwnsSource) {
			try {
				const prepared = await window.electronAPI.prepareNativeLinuxRecording(
					buildNativeLinuxRequest(),
				);
				if (prepared.success && typeof prepared.recordingId === "number") {
					preparedRecordingId = prepared.recordingId;
				} else if (prepared.reason) {
					console.info(`Native Linux capture was not prepared: ${prepared.reason}`);
				}
			} catch (error) {
				console.warn("Failed to prepare the native Linux capture:", error);
			}
			// The user can dismiss the picker, or answer it slower than they change
			// their mind about recording at all.
			if (!isCountdownRunActive(runId)) {
				void window.electronAPI.cancelNativeLinuxPrepare?.();
				return;
			}
		}

		if (!isCountdownRunActive(runId)) {
			return;
		}

		setCountdownActive(true);

		let overlayHiddenBeforeStart = false;
		try {
			const values = [3, 2, 1];
			const overlayShown = await safeShowCountdownOverlay(values[0], runId);

			if (countdownRunId.current !== runId) {
				return;
			}

			for (const value of values) {
				if (countdownRunId.current !== runId) {
					return;
				}

				if (overlayShown && value !== values[0]) {
					await safeSetCountdownOverlayValue(value, runId);

					if (countdownRunId.current !== runId) {
						return;
					}
				}

				await new Promise((resolve) => window.setTimeout(resolve, 1000));
			}

			if (countdownRunId.current !== runId) {
				return;
			}

			setCountdownActive(false);
			await safeHideCountdownOverlay(runId);
			overlayHiddenBeforeStart = true;

			if (countdownRunId.current !== runId) {
				return;
			}

			await startRecording(runId, preparedRecordingId);
		} finally {
			if (!overlayHiddenBeforeStart && countdownRunId.current === runId) {
				setCountdownActive(false);
				await safeHideCountdownOverlay(runId);
			}
			// Unconditional, and safe: a start that used the prepared session
			// already claimed it, so this is a no-op there. Every OTHER way out of
			// this block — cancelled countdown, an overlay that threw, a source
			// that vanished — would otherwise leave a live ScreenCast session and
			// the compositor's sharing indicator up with nothing recording.
			if (portalOwnsSource) {
				void window.electronAPI.cancelNativeLinuxPrepare?.();
			}
		}
	};

	const startRecording = async (
		countdownRunToken?: number,
		preparedRecordingId?: number | null,
	) => {
		const platform = window.electronAPI.getPlatform();
		const browserCursorCaptureMode = effectiveBrowserCursorMode(platform, cursorCaptureMode);

		try {
			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			// BEFORE THE SOURCE GATE, on purpose. On Wayland the portal raises its
			// own picker and is the only thing that can choose a source, so there
			// is nothing for the app to have selected — and the helper needs no
			// `selectedSource` to run. Gating here demanded an answer to a
			// question this platform never asks the app. It returns false when the
			// native helper is missing, and the browser fallback below does need a
			// source, so the gate still guards the path that uses one.
			if (await startNativeLinuxRecordingIfAvailable(countdownRunToken, preparedRecordingId)) {
				return;
			}

			const selectedSource = await window.electronAPI.getSelectedSource();
			if (!selectedSource) {
				alert(t("recording.selectSource"));
				return;
			}

			if (await startNativeWindowsRecordingIfAvailable(selectedSource, countdownRunToken)) {
				return;
			}
			if (await startNativeMacRecordingIfAvailable(selectedSource, countdownRunToken)) {
				return;
			}

			// Capture screen + microphone in parallel: the gap between the two
			// `getUserMedia` calls is the dominant source of the mic-vs-video lag at the
			// start of the recording (issue #57).
			const screenCapture = (async (): Promise<MediaStream> => {
				if (platform === "win32") {
					// getDisplayMedia + setDisplayMediaRequestHandler (main.ts) supplies the
					// pre-selected source. Editable cursor mode excludes the system cursor so
					// the editor can render a replacement; system mode bakes it into the video.
					return navigator.mediaDevices.getDisplayMedia({
						video: {
							cursor: cursorCaptureMode === "editable-overlay" ? "never" : "always",
							width: { max: TARGET_WIDTH },
							height: { max: TARGET_HEIGHT },
							frameRate: { ideal: TARGET_FRAME_RATE },
						} as MediaTrackConstraints,
						audio: systemAudioEnabled,
					} as DisplayMediaStreamOptions);
				}

				const videoConstraints = {
					mandatory: {
						chromeMediaSource: CHROME_MEDIA_SOURCE,
						chromeMediaSourceId: selectedSource.id,
						maxWidth: TARGET_WIDTH,
						maxHeight: TARGET_HEIGHT,
						maxFrameRate: TARGET_FRAME_RATE,
						minFrameRate: MIN_FRAME_RATE,
					},
				};

				if (systemAudioEnabled) {
					try {
						return navigator.mediaDevices.getUserMedia({
							audio: {
								mandatory: {
									chromeMediaSource: CHROME_MEDIA_SOURCE,
									chromeMediaSourceId: selectedSource.id,
								},
							},
							video: videoConstraints,
						} as unknown as MediaStreamConstraints);
					} catch (audioErr) {
						console.warn("System audio capture failed, falling back to video-only:", audioErr);
						toast.error(t("recording.systemAudioUnavailable"));
						return navigator.mediaDevices.getUserMedia({
							audio: false,
							video: videoConstraints,
						} as unknown as MediaStreamConstraints);
					}
				}

				return navigator.mediaDevices.getUserMedia({
					audio: false,
					video: videoConstraints,
				} as unknown as MediaStreamConstraints);
			})();

			const micCapture: Promise<MediaStream | null> = microphoneEnabled
				? (async () => {
						try {
							return await navigator.mediaDevices.getUserMedia({
								audio: microphoneDeviceId
									? {
											deviceId: { exact: microphoneDeviceId },
											echoCancellation: true,
											noiseSuppression: true,
											autoGainControl: true,
										}
									: {
											echoCancellation: true,
											noiseSuppression: true,
											autoGainControl: true,
										},
								video: false,
							});
						} catch (audioError) {
							console.warn("Failed to get microphone access:", audioError);
							toast.error(t("recording.microphoneDenied"));
							setMicrophoneEnabled(false);
							return null;
						}
					})()
				: Promise.resolve(null);

			// Await both in-flight captures. If the screen capture rejects it would
			// otherwise orphan a mic stream that resolved in parallel (leaving the
			// screen/mic indicator on), so stop that stream before rethrowing.
			let screenMediaStream: MediaStream;
			try {
				screenMediaStream = await screenCapture;
			} catch (error) {
				void micCapture
					.then((micStream) => micStream?.getTracks().forEach((track) => track.stop()))
					.catch(() => {
						// Mic capture itself failed too; nothing left to stop.
					});
				throw error;
			}
			const micMediaStream = await micCapture;

			// Assign the refs before the cancellation check below so teardownMedia() can
			// stop the freshly acquired streams if the countdown was cancelled mid-capture.
			screenStream.current = screenMediaStream;
			microphoneStream.current = micMediaStream;

			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			if (webcamEnabled) {
				if (!webcamReady.current) {
					await new Promise<void>((resolve) => {
						const interval = setInterval(() => {
							if (webcamReady.current) {
								clearInterval(interval);
								resolve();
							}
						}, 50);
						setTimeout(() => {
							clearInterval(interval);
							resolve();
						}, 5000);
					});
				}
				if (!webcamStream.current) {
					webcamAcquireId.current++;
					setWebcamEnabledState(false);
				}
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			stream.current = new MediaStream();
			const videoTrack = screenMediaStream.getVideoTracks()[0];
			if (!videoTrack) {
				throw new Error("Video track is not available.");
			}
			stream.current.addTrack(videoTrack);

			const systemAudioTrack = screenMediaStream.getAudioTracks()[0];
			const micAudioTrack = microphoneStream.current?.getAudioTracks()[0];

			const { context: mixingCtx, track: mixedTrack } = mixAudioTracks({
				systemAudioTrack,
				micAudioTrack,
			});
			if (mixingCtx) {
				mixingContext.current = mixingCtx;
			}
			if (mixedTrack) {
				stream.current.addTrack(mixedTrack);
			}

			try {
				await videoTrack.applyConstraints({
					frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
					width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
					height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
				});
			} catch (constraintError) {
				console.warn(
					"Unable to lock 4K/60fps constraints, using best available track settings.",
					constraintError,
				);
			}

			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			let {
				width = DEFAULT_WIDTH,
				height = DEFAULT_HEIGHT,
				frameRate = TARGET_FRAME_RATE,
			} = videoTrack.getSettings();

			width = Math.floor(width / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;
			height = Math.floor(height / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;

			const videoBitsPerSecond = computeBitrate(width, height);
			const mimeType = selectMimeType();

			console.log(
				`Recording at ${width}x${height} @ ${frameRate ?? TARGET_FRAME_RATE}fps using ${mimeType} / ${Math.round(
					videoBitsPerSecond / BITS_PER_MEGABIT,
				)} Mbps`,
			);

			const hasAudio = stream.current.getAudioTracks().length > 0;
			if (!isCountdownRunActive(countdownRunToken)) {
				teardownMedia();
				return;
			}

			recordingId.current = Date.now();
			const activeRecordingId = recordingId.current;
			screenRecorder.current = createRecorderHandle(
				stream.current,
				{
					mimeType,
					videoBitsPerSecond,
					...(hasAudio
						? { audioBitsPerSecond: systemAudioTrack ? AUDIO_BITRATE_SYSTEM : AUDIO_BITRATE_VOICE }
						: {}),
				},
				`${RECORDING_FILE_PREFIX}${activeRecordingId}${VIDEO_FILE_EXTENSION}`,
			);
			screenRecorder.current.recorder.addEventListener(
				"error",
				() => {
					setRecording(false);
				},
				{ once: true },
			);

			if (webcamStream.current) {
				webcamRecorder.current = createRecorderHandle(
					webcamStream.current,
					{ mimeType, videoBitsPerSecond: Math.min(videoBitsPerSecond, BITRATE_BASE) },
					`${RECORDING_FILE_PREFIX}${activeRecordingId}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`,
				);
			}

			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = Date.now();
			allowAutoFinalize.current = true;
			setRecording(true);
			setPaused(false);
			setElapsedSeconds(0);
			window.electronAPI?.setRecordingState(true, recordingId.current, browserCursorCaptureMode);

			const activeScreenRecorder = screenRecorder.current;
			const activeWebcamRecorder = webcamRecorder.current;
			if (activeScreenRecorder) {
				activeScreenRecorder.recorder.addEventListener(
					"stop",
					() => {
						if (!allowAutoFinalize.current) {
							return;
						}
						finalizeRecording(
							activeScreenRecorder,
							activeWebcamRecorder ?? null,
							Math.max(0, getRecordingDurationMs()),
							activeRecordingId,
						);
					},
					{ once: true },
				);
			}
		} catch (error) {
			console.error("Failed to start recording:", error);
			const errorMsg = error instanceof Error ? error.message : "Failed to start recording";
			if (errorMsg.includes("Permission denied") || errorMsg.includes("NotAllowedError")) {
				toast.error(t("recording.permissionDenied"));
			} else {
				toast.error(errorMsg);
			}
			setRecording(false);
			setPaused(false);
			setElapsedSeconds(0);
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = null;
			screenRecorder.current = null;
			webcamRecorder.current = null;
			teardownMedia();
		}
	};

	const togglePaused = () => {
		const activeNativeWindowsRecording = nativeWindowsRecording.current;
		if (activeNativeWindowsRecording && !activeNativeWindowsRecording.finalizing) {
			void (async () => {
				try {
					if (activeNativeWindowsRecording.paused) {
						const result = await window.electronAPI.resumeNativeWindowsRecording();
						if (!result.success) {
							throw new Error(result.error ?? "Failed to resume native Windows recording");
						}
						activeNativeWindowsRecording.paused = false;
						segmentStartedAt.current = Date.now();
						setPaused(false);
						return;
					}

					const pausedAtMs = getRecordingDurationMs();
					const result = await window.electronAPI.pauseNativeWindowsRecording();
					if (!result.success) {
						throw new Error(result.error ?? "Failed to pause native Windows recording");
					}
					activeNativeWindowsRecording.paused = true;
					accumulatedDurationMs.current = pausedAtMs;
					segmentStartedAt.current = null;
					setElapsedSeconds(Math.floor(accumulatedDurationMs.current / 1000));
					setPaused(true);
				} catch (error) {
					console.error("Failed to toggle native Windows pause state:", error);
					toast.error(error instanceof Error ? error.message : "Failed to toggle pause state");
				}
			})();
			return;
		}

		const activeNativeMacRecording = nativeMacRecording.current;
		if (activeNativeMacRecording && !activeNativeMacRecording.finalizing) {
			void (async () => {
				const activeWebcamRecorder = webcamRecorder.current?.recorder;
				try {
					if (activeNativeMacRecording.paused) {
						const result = await window.electronAPI.resumeNativeMacRecording();
						if (!result.success) {
							throw new Error(result.error ?? "Failed to resume native macOS recording");
						}
						if (activeWebcamRecorder?.state === "paused") {
							activeWebcamRecorder.resume();
						}
						activeNativeMacRecording.paused = false;
						segmentStartedAt.current = Date.now();
						setPaused(false);
						return;
					}

					const pausedAtMs = getRecordingDurationMs();
					const result = await window.electronAPI.pauseNativeMacRecording();
					if (!result.success) {
						throw new Error(result.error ?? "Failed to pause native macOS recording");
					}
					if (activeWebcamRecorder?.state === "recording") {
						activeWebcamRecorder.pause();
					}
					activeNativeMacRecording.paused = true;
					accumulatedDurationMs.current = pausedAtMs;
					segmentStartedAt.current = null;
					setElapsedSeconds(Math.floor(accumulatedDurationMs.current / 1000));
					setPaused(true);
				} catch (error) {
					console.error("Failed to toggle native macOS pause state:", error);
					toast.error(error instanceof Error ? error.message : "Failed to toggle pause state");
				}
			})();
			return;
		}

		const activeNativeLinuxRecording = nativeLinuxRecording.current;
		if (activeNativeLinuxRecording && !activeNativeLinuxRecording.finalizing) {
			void (async () => {
				const activeWebcamRecorder = webcamRecorder.current?.recorder;
				try {
					if (activeNativeLinuxRecording.paused) {
						const result = await window.electronAPI.resumeNativeLinuxRecording();
						if (!result.success) {
							throw new Error(result.error ?? "Failed to resume native Linux recording");
						}
						if (activeWebcamRecorder?.state === "paused") {
							activeWebcamRecorder.resume();
						}
						activeNativeLinuxRecording.paused = false;
						segmentStartedAt.current = Date.now();
						setPaused(false);
						return;
					}

					const pausedAtMs = getRecordingDurationMs();
					const result = await window.electronAPI.pauseNativeLinuxRecording();
					if (!result.success) {
						throw new Error(result.error ?? "Failed to pause native Linux recording");
					}
					if (activeWebcamRecorder?.state === "recording") {
						activeWebcamRecorder.pause();
					}
					activeNativeLinuxRecording.paused = true;
					accumulatedDurationMs.current = pausedAtMs;
					segmentStartedAt.current = null;
					setElapsedSeconds(Math.floor(accumulatedDurationMs.current / 1000));
					setPaused(true);
				} catch (error) {
					console.error("Failed to toggle native Linux pause state:", error);
					toast.error(error instanceof Error ? error.message : "Failed to toggle pause state");
				}
			})();
			return;
		}

		const activeScreenRecorder = screenRecorder.current?.recorder;
		if (!activeScreenRecorder || activeScreenRecorder.state === "inactive") {
			return;
		}

		const activeWebcamRecorder = webcamRecorder.current?.recorder;

		if (activeScreenRecorder.state === "paused") {
			try {
				activeScreenRecorder.resume();
				if (activeWebcamRecorder?.state === "paused") {
					activeWebcamRecorder.resume();
				}
				segmentStartedAt.current = Date.now();
				setPaused(false);
			} catch (error) {
				console.error("Failed to resume recording:", error);
			}
			return;
		}

		if (activeScreenRecorder.state !== "recording") {
			return;
		}

		try {
			accumulatedDurationMs.current = getRecordingDurationMs();
			segmentStartedAt.current = null;
			setElapsedSeconds(Math.floor(accumulatedDurationMs.current / 1000));
			activeScreenRecorder.pause();
			if (activeWebcamRecorder?.state === "recording") {
				activeWebcamRecorder.pause();
			}
			setPaused(true);
		} catch (error) {
			console.error("Failed to pause recording:", error);
		}
	};

	const toggleRecording = () => {
		if (recording) {
			stopRecording.current();
			return;
		}

		if (countdownActive) {
			cancelCountdown();
			return;
		}

		void startRecordCountdown();
	};

	const restartRecording = async () => {
		if (restarting.current) return;

		if (nativeWindowsRecording.current) {
			const activeRecordingId = recordingId.current;
			restarting.current = true;
			discardRecordingId.current = activeRecordingId;
			try {
				await finalizeNativeWindowsRecording(true);
				await startRecording();
			} finally {
				restarting.current = false;
			}
			return;
		}
		if (nativeMacRecording.current) {
			const activeRecordingId = recordingId.current;
			restarting.current = true;
			discardRecordingId.current = activeRecordingId;
			try {
				await finalizeNativeMacRecording(true);
				await startRecording();
			} finally {
				restarting.current = false;
			}
			return;
		}
		if (nativeLinuxRecording.current) {
			const activeRecordingId = recordingId.current;
			restarting.current = true;
			discardRecordingId.current = activeRecordingId;
			try {
				await finalizeNativeLinuxRecording(true);
				await startRecording();
			} finally {
				restarting.current = false;
			}
			return;
		}

		const activeScreenRecorder = screenRecorder.current;
		if (!activeScreenRecorder || activeScreenRecorder.recorder.state === "inactive") return;

		const activeWebcamRecorder = webcamRecorder.current;
		const activeRecordingId = recordingId.current;

		restarting.current = true;
		discardRecordingId.current = activeRecordingId;

		const stopPromises = [
			new Promise<void>((resolve) => {
				activeScreenRecorder.recorder.addEventListener("stop", () => resolve(), { once: true });
			}),
		];

		if (
			activeWebcamRecorder?.recorder.state === "recording" ||
			activeWebcamRecorder?.recorder.state === "paused"
		) {
			stopPromises.push(
				new Promise<void>((resolve) => {
					activeWebcamRecorder.recorder.addEventListener("stop", () => resolve(), {
						once: true,
					});
				}),
			);
		}

		stopRecording.current();
		await Promise.all(stopPromises);

		try {
			await startRecording();
		} finally {
			restarting.current = false;
		}
	};

	useEffect(() => {
		if (!recording) {
			setElapsedSeconds(0);
			return;
		}

		setElapsedSeconds(Math.floor(getRecordingDurationMs() / 1000));
		if (paused) {
			return;
		}

		const interval = window.setInterval(() => {
			setElapsedSeconds(Math.floor(getRecordingDurationMs() / 1000));
		}, 250);

		return () => window.clearInterval(interval);
	}, [getRecordingDurationMs, paused, recording]);

	const cancelRecording = () => {
		if (nativeWindowsRecording.current) {
			const activeRecordingId = recordingId.current;
			discardRecordingId.current = activeRecordingId;
			allowAutoFinalize.current = false;
			void finalizeNativeWindowsRecording(true);
			return;
		}
		if (nativeMacRecording.current) {
			const activeRecordingId = recordingId.current;
			discardRecordingId.current = activeRecordingId;
			allowAutoFinalize.current = false;
			void finalizeNativeMacRecording(true);
			return;
		}
		if (nativeLinuxRecording.current) {
			const activeRecordingId = recordingId.current;
			discardRecordingId.current = activeRecordingId;
			allowAutoFinalize.current = false;
			void finalizeNativeLinuxRecording(true);
			return;
		}

		const activeScreenRecorder = screenRecorder.current;
		if (
			activeScreenRecorder?.recorder.state === "recording" ||
			activeScreenRecorder?.recorder.state === "paused"
		) {
			const activeRecordingId = recordingId.current;
			discardRecordingId.current = activeRecordingId;
			allowAutoFinalize.current = false;

			stopRecording.current();
			return;
		}

		if (countdownActive) {
			cancelCountdown();
			return;
		}
	};

	const dismissSoftwareEncoderFallbackNotice = (dontShowAgain = false) => {
		if (dontShowAgain) {
			saveUserPreferences({ hideSoftwareEncoderFallbackNotice: true });
		}
		setSoftwareEncoderFallbackNoticeVisible(false);
	};

	return {
		recording,
		paused,
		saving,
		elapsedSeconds,
		toggleRecording,
		startRecordingImmediately: () => startRecording(),
		togglePaused,
		canPauseRecording,
		restartRecording,
		cancelRecording,
		microphoneEnabled,
		setMicrophoneEnabled,
		microphoneDeviceId,
		setMicrophoneDeviceId,
		microphoneDeviceName,
		setMicrophoneDeviceName,
		webcamDeviceId,
		setWebcamDeviceId,
		webcamDeviceName,
		setWebcamDeviceName,
		systemAudioEnabled,
		setSystemAudioEnabled,
		webcamEnabled,
		setWebcamEnabled,
		cursorCaptureMode,
		setCursorCaptureMode,
		softwareEncoderFallbackNoticeVisible,
		dismissSoftwareEncoderFallbackNotice,
	};
}
