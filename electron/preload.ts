import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { NativeMacRecordingRequest } from "../src/lib/nativeMacRecording";
import type { NativeWindowsRecordingRequest } from "../src/lib/nativeWindowsRecording";
import type { RecordingSession, StoreRecordedSessionInput } from "../src/lib/recordingSession";
import type { ShortcutBinding } from "../src/lib/shortcuts";
import type { AiEditionChatEvent } from "../src/native/contracts";
import { NATIVE_BRIDGE_CHANNEL, type NativeBridgeRequest } from "../src/native/contracts";
import type { RecordingPrefs } from "./ipc/handlers";
import type {
	SttStatusEvent,
	SttTranscribeRequest,
	SttTranscribeResponse,
} from "./stt/transcriptionContract";

// Asset base URL is passed from the main process via webPreferences.additionalArguments
// (see windows.ts). Sandboxed preloads cannot import node:path / node:url, so we
// can't compute it here.
const ASSET_BASE_URL_ARG_PREFIX = "--asset-base-url=";
const assetBaseUrlArg = process.argv.find((arg) => arg.startsWith(ASSET_BASE_URL_ARG_PREFIX));
const assetBaseUrl = assetBaseUrlArg ? assetBaseUrlArg.slice(ASSET_BASE_URL_ARG_PREFIX.length) : "";

contextBridge.exposeInMainWorld("electronAPI", {
	assetBaseUrl,

	// --- Native export encoder -------------------------------------------------
	// The renderer composites and extracts frames but cannot spawn ffmpeg (it is
	// sandboxed, deliberately), so frames cross to main and it feeds ffmpeg's
	// stdin. Frames go one-way via send(); flow control is the caller's credit
	// window, acked on exportOnFrameAck.
	exportCapabilities: () =>
		ipcRenderer.invoke("export:capabilities") as Promise<{ encoder: string }>,
	exportStart: (req: unknown) =>
		ipcRenderer.invoke("export:start", req) as Promise<{
			sessionId: string;
			encoder: string;
			outputPath: string;
		}>,
	exportWriteFrame: (sessionId: string, frame: ArrayBuffer) => {
		// send() structured-clones, i.e. copies the frame. That is not an oversight
		// and it is not fixable here: Electron's transfer list takes MessagePort[]
		// only, and transferring an ArrayBuffer renderer->main silently drops the
		// whole message (electron#34905 - it works renderer->renderer, not to main).
		// The copy is what caps the crossing at ~390 MB/s, which is why the export
		// ships NV12 (3.0 MB/frame) rather than BGRA (7.9 MB).
		ipcRenderer.send("export:frame", sessionId, frame);
	},
	exportOnFrameAck: (cb: (sessionId: string, error: string | null) => void) => {
		const handler = (_e: unknown, sessionId: string, error: string | null) => cb(sessionId, error);
		ipcRenderer.on("export:frame-ack", handler);
		return () => ipcRenderer.off("export:frame-ack", handler);
	},
	exportFinish: (sessionId: string) =>
		ipcRenderer.invoke("export:finish", sessionId) as Promise<{ outputPath: string }>,
	exportCancel: (sessionId: string) =>
		ipcRenderer.invoke("export:cancel", sessionId) as Promise<void>,
	/** Export bench only (--bench=): tells main the run is over so it can quit. */
	benchFinished: () => ipcRenderer.invoke("bench:finished") as Promise<void>,
	/** Native (D3D) export progress — frames encoded so far, pushed at ~10 Hz max while
	 *  `compositor.export`/`compositor.exportMulti` runs. Distinct from `exportOnFrameAck`
	 *  above, which is the OLD web/CPU pipeline's per-frame ack, not a progress signal. */
	onNativeExportProgress: (cb: (frames: number) => void) => {
		const handler = (_e: unknown, frames: number) => cb(frames);
		ipcRenderer.on("export:native-progress", handler);
		return () => ipcRenderer.off("export:native-progress", handler);
	},
	invokeNativeBridge: <TData>(request: NativeBridgeRequest) => {
		return ipcRenderer.invoke(NATIVE_BRIDGE_CHANNEL, request) as Promise<TData>;
	},
	hudOverlayHide: () => {
		ipcRenderer.send("hud-overlay-hide");
	},
	hudOverlayClose: () => {
		ipcRenderer.send("hud-overlay-close");
	},
	setHudOverlayIgnoreMouseEvents: (ignore: boolean) => {
		ipcRenderer.send("hud-overlay-ignore-mouse-events", ignore);
	},
	moveHudOverlayBy: (deltaX: number, deltaY: number) => {
		ipcRenderer.send("hud-overlay-move-by", deltaX, deltaY);
	},
	setHudOverlaySize: (width: number, height: number) => {
		ipcRenderer.send("hud-overlay-set-size", width, height);
	},
	getSources: async (opts: Electron.SourcesOptions) => {
		return await ipcRenderer.invoke("get-sources", opts);
	},
	switchToEditor: () => {
		return ipcRenderer.invoke("switch-to-editor");
	},
	switchToHud: () => {
		return ipcRenderer.invoke("switch-to-hud");
	},
	startNewRecording: () => {
		return ipcRenderer.invoke("start-new-recording");
	},
	openSourceSelector: () => {
		return ipcRenderer.invoke("open-source-selector");
	},
	openNotes: () => {
		return ipcRenderer.invoke("open-notes");
	},
	selectSource: (source: ProcessedDesktopSource) => {
		return ipcRenderer.invoke("select-source", source);
	},
	getSelectedSource: () => {
		return ipcRenderer.invoke("get-selected-source");
	},
	getRecordingPrefs: () => {
		return ipcRenderer.invoke("get-recording-prefs");
	},
	setRecordingPrefs: (prefs: Partial<RecordingPrefs>) => {
		return ipcRenderer.invoke("set-recording-prefs", prefs);
	},
	onRecordingPrefsChanged: (callback: (prefs: RecordingPrefs) => void) => {
		const listener = (_event: unknown, prefs: RecordingPrefs) => callback(prefs);
		ipcRenderer.on("recording-prefs-changed", listener);
		return () => ipcRenderer.removeListener("recording-prefs-changed", listener);
	},
	onSelectedSourceChanged: (callback: (source: ProcessedDesktopSource) => void) => {
		const listener = (_event: unknown, source: ProcessedDesktopSource) => callback(source);
		ipcRenderer.on("selected-source-changed", listener);
		return () => ipcRenderer.removeListener("selected-source-changed", listener);
	},
	onSourceSelectorClosed: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("source-selector-closed", listener);
		return () => ipcRenderer.removeListener("source-selector-closed", listener);
	},
	onAutoStartRecording: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("hud-auto-start-recording", listener);
		return () => ipcRenderer.removeListener("hud-auto-start-recording", listener);
	},
	requestCameraAccess: () => {
		return ipcRenderer.invoke("request-camera-access");
	},
	requestScreenAccess: () => {
		return ipcRenderer.invoke("request-screen-access");
	},
	requestNativeMacCursorAccess: () => {
		return ipcRenderer.invoke("request-native-mac-cursor-access");
	},
	storeRecordedVideo: (videoData: ArrayBuffer, fileName: string) => {
		return ipcRenderer.invoke("store-recorded-video", videoData, fileName);
	},
	storeRecordedSession: (payload: StoreRecordedSessionInput) => {
		return ipcRenderer.invoke("store-recorded-session", payload);
	},
	openRecordingStream: (fileName: string) => {
		return ipcRenderer.invoke("open-recording-stream", fileName);
	},
	appendRecordingChunk: (fileName: string, chunk: ArrayBuffer) => {
		return ipcRenderer.invoke("append-recording-chunk", fileName, chunk);
	},
	closeRecordingStream: (fileName: string) => {
		return ipcRenderer.invoke("close-recording-stream", fileName);
	},

	getRecordedVideoPath: () => {
		return ipcRenderer.invoke("get-recorded-video-path");
	},
	setRecordingState: (
		recording: boolean,
		recordingId?: number,
		cursorCaptureMode?: import("../src/lib/recordingSession").CursorCaptureMode,
	) => {
		return ipcRenderer.invoke("set-recording-state", recording, recordingId, cursorCaptureMode);
	},
	isNativeWindowsCaptureAvailable: () => {
		return ipcRenderer.invoke("is-native-windows-capture-available");
	},
	isNativeMacCaptureAvailable: () => {
		return ipcRenderer.invoke("is-native-mac-capture-available");
	},
	startNativeWindowsRecording: (request: NativeWindowsRecordingRequest) => {
		return ipcRenderer.invoke("start-native-windows-recording", request);
	},
	stopNativeWindowsRecording: (discard?: boolean) => {
		return ipcRenderer.invoke("stop-native-windows-recording", discard);
	},
	pauseNativeWindowsRecording: () => {
		return ipcRenderer.invoke("pause-native-windows-recording");
	},
	resumeNativeWindowsRecording: () => {
		return ipcRenderer.invoke("resume-native-windows-recording");
	},
	startNativeMacRecording: (request: NativeMacRecordingRequest) => {
		return ipcRenderer.invoke("start-native-mac-recording", request);
	},
	pauseNativeMacRecording: () => {
		return ipcRenderer.invoke("pause-native-mac-recording");
	},
	resumeNativeMacRecording: () => {
		return ipcRenderer.invoke("resume-native-mac-recording");
	},
	stopNativeMacRecording: (discard?: boolean) => {
		return ipcRenderer.invoke("stop-native-mac-recording", discard);
	},
	attachNativeMacWebcamRecording: (payload: {
		screenVideoPath: string;
		recordingId: number;
		webcam: { fileName: string; videoData: ArrayBuffer };
		cursorCaptureMode?: import("../src/lib/recordingSession").CursorCaptureMode;
		webcamOffsetMs?: number;
	}) => {
		return ipcRenderer.invoke("attach-native-mac-webcam-recording", payload);
	},
	getCursorTelemetry: (videoPath?: string) => {
		return ipcRenderer.invoke("get-cursor-telemetry", videoPath);
	},
	discardCursorTelemetry: (recordingId: number) => {
		return ipcRenderer.invoke("discard-cursor-telemetry", recordingId);
	},
	onStopRecordingFromTray: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("stop-recording-from-tray", listener);
		return () => ipcRenderer.removeListener("stop-recording-from-tray", listener);
	},
	openExternalUrl: (url: string) => {
		return ipcRenderer.invoke("open-external-url", url);
	},
	pickExportSavePath: (fileName: string, exportFolder?: string) => {
		return ipcRenderer.invoke("pick-export-save-path", fileName, exportFolder);
	},
	writeExportToPath: (videoData: ArrayBuffer, filePath: string) => {
		return ipcRenderer.invoke("write-export-to-path", videoData, filePath);
	},
	openVideoFilePicker: () => {
		return ipcRenderer.invoke("open-video-file-picker");
	},
	setCurrentVideoPath: (path: string) => {
		return ipcRenderer.invoke("set-current-video-path", path);
	},
	setCurrentRecordingSession: (session: RecordingSession | null) => {
		return ipcRenderer.invoke("set-current-recording-session", session);
	},
	getCurrentVideoPath: () => {
		return ipcRenderer.invoke("get-current-video-path");
	},
	getCurrentRecordingSession: () => {
		return ipcRenderer.invoke("get-current-recording-session");
	},
	findRecordingCamera: (videoPath: string) => {
		return ipcRenderer.invoke("find-recording-camera", videoPath);
	},
	readBinaryFile: (filePath: string) => {
		return ipcRenderer.invoke("read-binary-file", filePath);
	},
	getReadableFileInfo: (filePath: string) => {
		return ipcRenderer.invoke("get-readable-file-info", filePath);
	},
	readFileChunk: (filePath: string, offset: number, length: number) => {
		return ipcRenderer.invoke("read-file-chunk", filePath, offset, length);
	},
	preparePreviewAudioTrack: (filePath: string) => {
		return ipcRenderer.invoke("prepare-preview-audio-track", filePath);
	},
	clearCurrentVideoPath: () => {
		return ipcRenderer.invoke("clear-current-video-path");
	},
	saveProjectFile: (projectData: unknown, suggestedName?: string, existingProjectPath?: string) => {
		return ipcRenderer.invoke("save-project-file", projectData, suggestedName, existingProjectPath);
	},
	loadProjectFile: (projectFolder?: string) => {
		return ipcRenderer.invoke("load-project-file", projectFolder);
	},
	loadProjectFileFromPath: (filePath: string) => {
		return ipcRenderer.invoke("load-project-file-from-path", filePath);
	},
	getPathForFile: (file: File) => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	},
	loadCurrentProjectFile: () => {
		return ipcRenderer.invoke("load-current-project-file");
	},
	onMenuNewProject: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-new-project", listener);
		return () => ipcRenderer.removeListener("menu-new-project", listener);
	},
	onMenuImportVideo: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-import-video", listener);
		return () => ipcRenderer.removeListener("menu-import-video", listener);
	},
	onMenuLoadProject: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-load-project", listener);
		return () => ipcRenderer.removeListener("menu-load-project", listener);
	},
	onMenuSaveProject: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-save-project", listener);
		return () => ipcRenderer.removeListener("menu-save-project", listener);
	},
	onMenuSaveProjectAs: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-save-project-as", listener);
		return () => ipcRenderer.removeListener("menu-save-project-as", listener);
	},
	quitApp: () => {
		ipcRenderer.send("app-quit");
	},
	getPlatform: () => {
		return ipcRenderer.invoke("get-platform");
	},
	revealInFolder: (filePath: string) => {
		return ipcRenderer.invoke("reveal-in-folder", filePath);
	},
	getShortcuts: () => {
		return ipcRenderer.invoke("get-shortcuts");
	},
	saveShortcuts: (shortcuts: unknown) => {
		return ipcRenderer.invoke("save-shortcuts", shortcuts);
	},
	updateGlobalShortcut: (binding: ShortcutBinding) => {
		return ipcRenderer.invoke("update-global-shortcut", binding);
	},
	setLocale: (locale: string) => {
		return ipcRenderer.invoke("set-locale", locale);
	},
	saveDiagnostic: (payload: {
		error: string;
		stack?: string;
		projectState: unknown;
		logs: string[];
	}) => {
		return ipcRenderer.invoke("save-diagnostic", payload);
	},
	setMicrophoneExpanded: (expanded: boolean) => {
		ipcRenderer.send("hud:setMicrophoneExpanded", expanded);
	},
	setHasUnsavedChanges: (hasChanges: boolean) => {
		ipcRenderer.send("set-has-unsaved-changes", hasChanges);
	},
	showCountdownOverlay: (value: number, runId: number) => {
		return ipcRenderer.invoke("countdown-overlay-show", value, runId);
	},
	setCountdownOverlayValue: (value: number, runId: number) => {
		return ipcRenderer.invoke("countdown-overlay-set-value", value, runId);
	},
	hideCountdownOverlay: (runId: number) => {
		return ipcRenderer.invoke("countdown-overlay-hide", runId);
	},
	onCountdownOverlayValue: (callback: (value: number | null) => void) => {
		const listener = (_event: unknown, value: number | null) => callback(value);
		ipcRenderer.on("countdown-overlay-value", listener);
		return () => ipcRenderer.removeListener("countdown-overlay-value", listener);
	},
	onRequestSaveBeforeClose: (callback: () => Promise<boolean> | boolean) => {
		const listener = async () => {
			try {
				const shouldClose = await callback();
				ipcRenderer.send("save-before-close-done", shouldClose);
			} catch {
				ipcRenderer.send("save-before-close-done", false);
			}
		};
		ipcRenderer.on("request-save-before-close", listener);
		return () => ipcRenderer.removeListener("request-save-before-close", listener);
	},
	onRequestCloseConfirm: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("request-close-confirm", listener);
		return () => ipcRenderer.removeListener("request-close-confirm", listener);
	},
	sendCloseConfirmResponse: (choice: "save" | "discard" | "cancel") => {
		ipcRenderer.send("close-confirm-response", choice);
	},
	// ponytail: forward renderer console output to main-process stdout so
	// recorder diagnostics land next to the main-process logs in dev output.
	// One-way fire-and-forget; we deliberately don't await the IPC.
	rendererConsole: (channel: "log" | "warn" | "error", args: unknown[]) => {
		ipcRenderer.send(`renderer-console-${channel}`, ...args);
	},
	onAiEditionChatEvent: (callback: (event: AiEditionChatEvent) => void) => {
		const listener = (_e: unknown, payload: AiEditionChatEvent) => callback(payload);
		ipcRenderer.on("ai-edition.chat-event", listener);
		return () => ipcRenderer.removeListener("ai-edition.chat-event", listener);
	},
	stt: {
		transcribe: (request: SttTranscribeRequest): Promise<SttTranscribeResponse> => {
			return ipcRenderer.invoke("stt:transcribe", request) as Promise<SttTranscribeResponse>;
		},
		onStatus: (callback: (event: SttStatusEvent) => void) => {
			const listener = (_event: unknown, payload: SttStatusEvent) => callback(payload);
			ipcRenderer.on("stt:status", listener);
			return () => ipcRenderer.removeListener("stt:status", listener);
		},
	},
});
