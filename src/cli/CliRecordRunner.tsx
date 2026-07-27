// Hidden-window runner for `openscreen record`. Reuses the full recording
// pipeline via useScreenRecorder (native macOS/Windows helpers with browser
// fallback), driven by the CLI controller instead of the HUD.

import { useEffect, useRef, useState } from "react";
import {
	normalizeProjectEditor,
	PROJECT_VERSION,
} from "@/components/video-editor/projectPersistence";
import { useScreenRecorder } from "@/hooks/useScreenRecorder";
import type { CliRecordRequest } from "@/lib/cliContracts";

type Phase = "init" | "recording" | "stopping" | "done";

async function pickSource(request: CliRecordRequest): Promise<ProcessedDesktopSource> {
	const sources = await window.electronAPI.getSources({
		types: ["screen", "window"],
		thumbnailSize: { width: 32, height: 18 },
	});

	if (request.windowTitle) {
		const needle = request.windowTitle.toLowerCase();
		const match = sources.find(
			(source) => source.id.startsWith("window:") && source.name.toLowerCase().includes(needle),
		);
		if (!match) {
			const windows = sources
				.filter((s) => s.id.startsWith("window:"))
				.map((s) => `  - ${s.name}`)
				.join("\n");
			throw new Error(
				`No window title contains "${request.windowTitle}". Open windows:\n${windows}`,
			);
		}
		return match;
	}

	const screens = sources.filter((source) => source.id.startsWith("screen:"));
	const screen = screens[request.displayIndex];
	if (!screen) {
		throw new Error(
			`Display index ${request.displayIndex} not found (${screens.length} screen(s) available)`,
		);
	}
	return screen;
}

async function resolveMicDeviceId(deviceNameFilter: string | null): Promise<{
	deviceId: string | undefined;
	deviceName: string | undefined;
}> {
	if (!deviceNameFilter) return { deviceId: undefined, deviceName: undefined };

	// Labels require an active permission grant; a short-lived stream unlocks them.
	let probeStream: MediaStream | null = null;
	try {
		probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch {
		// Enumeration below may still work with empty labels.
	}
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		const needle = deviceNameFilter.toLowerCase();
		const match = devices.find(
			(device) => device.kind === "audioinput" && device.label.toLowerCase().includes(needle),
		);
		if (!match) {
			const labels = devices
				.filter((d) => d.kind === "audioinput" && d.label)
				.map((d) => `  - ${d.label}`)
				.join("\n");
			throw new Error(`No microphone label contains "${deviceNameFilter}". Devices:\n${labels}`);
		}
		return { deviceId: match.deviceId, deviceName: match.label };
	} finally {
		probeStream?.getTracks().forEach((track) => track.stop());
	}
}

/** A minimal .openscreen project referencing the finished recording, with all
 * editor settings at their defaults — ready for `openscreen export` or the GUI. */
function buildDefaultProject(session: {
	screenVideoPath: string;
	webcamVideoPath?: string;
	cursorCaptureMode?: string;
}) {
	return {
		version: PROJECT_VERSION,
		media: {
			screenVideoPath: session.screenVideoPath,
			...(session.webcamVideoPath ? { webcamVideoPath: session.webcamVideoPath } : {}),
			...(session.cursorCaptureMode ? { cursorCaptureMode: session.cursorCaptureMode } : {}),
		},
		editor: normalizeProjectEditor({}),
	};
}

export function CliRecordRunner() {
	const recorder = useScreenRecorder();
	const startedRef = useRef(false);
	const requestRef = useRef<CliRecordRequest | null>(null);
	// Re-render trigger once the bootstrap has applied all recorder settings;
	// the start effect below cannot rely on recorder state deps alone because
	// default-valued settings (no mic, no system audio) never change.
	const [requestReady, setRequestReady] = useState<CliRecordRequest | null>(null);
	const phaseRef = useRef<Phase>("init");
	const recordingStartedAtRef = useRef<number | null>(null);
	// A stop (SIGINT/stdin) can land while the capture helper is still starting;
	// remember it and apply as soon as recording flips on.
	const stopRequestedRef = useRef(false);
	const [status, setStatus] = useState("Preparing recording…");

	const {
		recording,
		saving,
		startRecordingImmediately,
		toggleRecording,
		setMicrophoneEnabled,
		setMicrophoneDeviceId,
		setMicrophoneDeviceName,
		setSystemAudioEnabled,
		setCursorCaptureMode,
	} = recorder;

	// Keep latest values in refs for the stop/finish effects.
	const toggleRecordingRef = useRef(toggleRecording);
	const recordingRef = useRef(recording);
	useEffect(() => {
		toggleRecordingRef.current = toggleRecording;
		recordingRef.current = recording;
	});

	const fail = async (error: unknown) => {
		phaseRef.current = "done";
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		await window.electronAPI.cliDone({ success: false, error: message });
	};

	// Bootstrap: pick source, configure recorder, start.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional run-once bootstrap; startedRef guards re-entry
	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;

		void (async () => {
			try {
				// The recorder hook surfaces some failures via blocking alert(); a
				// hidden window must never show (or hang on) a modal.
				window.alert = (message?: unknown) => {
					window.electronAPI.cliLog("error", `Recorder: ${String(message)}`);
				};

				const request = (await window.electronAPI.cliGetRequest()) as CliRecordRequest;
				if (request.kind !== "record") {
					throw new Error(`cli-record window received a ${request.kind} request`);
				}
				requestRef.current = request;

				const source = await pickSource(request);
				await window.electronAPI.selectSource(source);
				window.electronAPI.cliLog("info", `Recording source: ${source.name}`);

				if (request.mic) {
					const mic = await resolveMicDeviceId(request.micDevice);
					setMicrophoneEnabled(true);
					setMicrophoneDeviceId(mic.deviceId);
					setMicrophoneDeviceName(mic.deviceName);
					if (mic.deviceName) {
						window.electronAPI.cliLog("info", `Microphone: ${mic.deviceName}`);
					}
				}
				setSystemAudioEnabled(request.systemAudio);
				setCursorCaptureMode(request.cursorMode);
				setStatus("Starting recording…");
				setRequestReady(request);
			} catch (error) {
				await fail(error);
			}
		})();
	}, []);

	// The setters above land on the *next* render; start only once they have.
	const configuredRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fires when recorder settings match the request; other referenced values are stable refs/callbacks
	useEffect(() => {
		const request = requestReady;
		if (!request || configuredRef.current || phaseRef.current !== "init") return;
		const micReady = !request.mic || recorder.microphoneEnabled;
		const systemAudioReady = recorder.systemAudioEnabled === request.systemAudio;
		const cursorReady = recorder.cursorCaptureMode === request.cursorMode;
		if (!micReady || !systemAudioReady || !cursorReady) return;

		configuredRef.current = true;
		phaseRef.current = "recording";
		void (async () => {
			try {
				await startRecordingImmediately();
				// The hook reports start failures via toast/console, not by
				// rejecting — without a deadline a failed start would hang the
				// CLI forever.
				setTimeout(() => {
					if (recordingStartedAtRef.current === null && phaseRef.current === "recording") {
						void fail(
							new Error(
								"Recording did not start within 30s — see stderr for the underlying capture error",
							),
						);
					}
				}, 30_000);
			} catch (error) {
				await fail(error);
			}
		})();
	}, [
		requestReady,
		recorder.microphoneEnabled,
		recorder.systemAudioEnabled,
		recorder.cursorCaptureMode,
	]);

	// Recording state transitions: report start and arm the duration timer.
	useEffect(() => {
		const request = requestRef.current;
		if (recording && recordingStartedAtRef.current === null) {
			recordingStartedAtRef.current = Date.now();
			setStatus("Recording…");
			window.electronAPI.cliLog("info", "Recording started");

			if (stopRequestedRef.current) {
				phaseRef.current = "stopping";
				setStatus("Stopping…");
				toggleRecordingRef.current();
				return;
			}

			if (request?.durationMs) {
				const timer = setTimeout(() => {
					if (recordingRef.current && phaseRef.current === "recording") {
						phaseRef.current = "stopping";
						window.electronAPI.cliLog("info", `Duration reached (${request.durationMs}ms)`);
						toggleRecordingRef.current();
					}
				}, request.durationMs);
				return () => clearTimeout(timer);
			}
		}
	}, [recording]);

	// External stop (SIGINT / stdin via main process).
	useEffect(() => {
		return window.electronAPI.onCliStopRecording(() => {
			if (recordingRef.current && phaseRef.current === "recording") {
				phaseRef.current = "stopping";
				setStatus("Stopping…");
				toggleRecordingRef.current();
			} else {
				// Capture is still starting; stop as soon as it comes up.
				stopRequestedRef.current = true;
			}
		});
	}, []);

	// Completion: recording flipped off and the session finished saving.
	// biome-ignore lint/correctness/useExhaustiveDependencies: completion is keyed on recording/saving; fail is stable
	useEffect(() => {
		if (recordingStartedAtRef.current === null) return;
		if (recording || saving) return;
		if (phaseRef.current === "done") return;
		phaseRef.current = "done";

		void (async () => {
			try {
				const sessionResult = await window.electronAPI.getCurrentRecordingSession();
				const session = sessionResult?.session;
				if (!session?.screenVideoPath) {
					throw new Error("Recording finished but no session manifest was stored");
				}
				const durationMs = Date.now() - (recordingStartedAtRef.current ?? Date.now());
				const request = requestRef.current;
				await window.electronAPI.cliDone({
					success: true,
					screenVideoPath: session.screenVideoPath,
					webcamVideoPath: session.webcamVideoPath,
					cursorDataPath: `${session.screenVideoPath}.cursor.json`,
					durationMs,
					...(request?.projectOut ? { projectData: buildDefaultProject(session) } : {}),
				});
			} catch (error) {
				await fail(error);
			}
		})();
	}, [recording, saving]);

	return (
		<div className="flex h-screen items-center justify-center bg-[#09090b] text-white/60 text-sm">
			{status}
		</div>
	);
}

export default CliRecordRunner;
