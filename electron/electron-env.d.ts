/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
	interface ProcessEnv {
		/**
		 * The built directory structure
		 *
		 * ```tree
		 * ├─┬─┬ dist
		 * │ │ └── index.html
		 * │ │
		 * │ ├─┬ dist-electron
		 * │ │ ├── main.js
		 * │ │ └── preload.js
		 * │
		 * ```
		 */
		APP_ROOT: string;
		/** /dist/ or /public/ */
		VITE_PUBLIC: string;
	}
}

// Used in Renderer process, expose in `preload.ts`
interface Window {
	electronAPI: {
		invokeNativeBridge: <TData = unknown>(
			request: import("../src/native/contracts").NativeBridgeRequest,
		) => Promise<import("../src/native/contracts").NativeBridgeResponse<TData>>;
		/** Export bench only (--bench=): tells main the run is over so it can quit. */
		benchFinished?: () => Promise<void>;
		getSources: (opts: Electron.SourcesOptions) => Promise<ProcessedDesktopSource[]>;
		switchToEditor: () => Promise<void>;
		switchToHud: () => Promise<void>;
		startNewRecording: () => Promise<{ success: boolean; error?: string }>;
		openSourceSelector: () => Promise<{
			opened: boolean;
			reason?: string;
			access?: {
				success: boolean;
				granted: boolean;
				status: string;
				error?: string;
			};
		}>;
		openNotes: () => Promise<{
			opened: boolean;
			reason?: string;
		}>;
		selectSource: (source: ProcessedDesktopSource) => Promise<ProcessedDesktopSource | null>;
		getSelectedSource: () => Promise<ProcessedDesktopSource | null>;
		onSelectedSourceChanged: (callback: (source: ProcessedDesktopSource) => void) => () => void;
		getRecordingPrefs: () => Promise<import("./ipc/handlers").RecordingPrefs>;
		setRecordingPrefs: (
			prefs: Partial<import("./ipc/handlers").RecordingPrefs>,
		) => Promise<import("./ipc/handlers").RecordingPrefs>;
		onRecordingPrefsChanged: (
			callback: (prefs: import("./ipc/handlers").RecordingPrefs) => void,
		) => () => void;
		onSourceSelectorClosed: (callback: () => void) => () => void;
		onAutoStartRecording: (callback: () => void) => () => void;
		onAiEditionChatEvent: (
			callback: (event: import("../src/native/contracts").AiEditionChatEvent) => void,
		) => () => void;
		requestCameraAccess: () => Promise<{
			success: boolean;
			granted: boolean;
			status: string;
			error?: string;
		}>;
		requestScreenAccess: () => Promise<{
			success: boolean;
			granted: boolean;
			status: string;
			error?: string;
		}>;
		requestNativeMacCursorAccess: () => Promise<{
			success: boolean;
			granted: boolean;
			status: string;
			error?: string;
		}>;
		assetBaseUrl: string;
		storeRecordedVideo: (
			videoData: ArrayBuffer,
			fileName: string,
		) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			error?: string;
		}>;
		storeRecordedSession: (
			payload: import("../src/lib/recordingSession").StoreRecordedSessionInput,
		) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			error?: string;
		}>;
		openRecordingStream: (fileName: string) => Promise<{ success: boolean; error?: string }>;
		appendRecordingChunk: (
			fileName: string,
			chunk: ArrayBuffer,
		) => Promise<{ success: boolean; error?: string }>;
		closeRecordingStream: (fileName: string) => Promise<{ success: boolean; error?: string }>;
		getRecordedVideoPath: () => Promise<{
			success: boolean;
			path?: string;
			message?: string;
			error?: string;
		}>;
		setRecordingState: (
			recording: boolean,
			recordingId?: number,
			cursorCaptureMode?: import("../src/lib/recordingSession").CursorCaptureMode,
		) => Promise<void>;
		isNativeWindowsCaptureAvailable: () => Promise<{
			success: boolean;
			available: boolean;
			helperPath?: string;
			reason?: string;
			error?: string;
		}>;
		isNativeMacCaptureAvailable: () => Promise<{
			success: boolean;
			available: boolean;
			helperPath?: string;
			reason?: "unsupported-platform" | "missing-helper" | string;
			error?: string;
		}>;
		startNativeWindowsRecording: (
			request: import("../src/lib/nativeWindowsRecording").NativeWindowsRecordingRequest,
		) => Promise<import("../src/lib/nativeWindowsRecording").NativeWindowsRecordingStartResult>;
		stopNativeWindowsRecording: (discard?: boolean) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			discarded?: boolean;
			error?: string;
		}>;
		pauseNativeWindowsRecording: () => Promise<{
			success: boolean;
			error?: string;
		}>;
		resumeNativeWindowsRecording: () => Promise<{
			success: boolean;
			error?: string;
		}>;
		startNativeMacRecording: (
			request: import("../src/lib/nativeMacRecording").NativeMacRecordingRequest,
		) => Promise<import("../src/lib/nativeMacRecording").NativeMacRecordingStartResult>;
		pauseNativeMacRecording: () => Promise<{
			success: boolean;
			error?: string;
		}>;
		resumeNativeMacRecording: () => Promise<{
			success: boolean;
			error?: string;
		}>;
		stopNativeMacRecording: (discard?: boolean) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			discarded?: boolean;
			error?: string;
		}>;
		attachNativeMacWebcamRecording: (payload: {
			screenVideoPath: string;
			recordingId: number;
			webcam: import("../src/lib/recordingSession").RecordedVideoAssetInput;
			cursorCaptureMode?: import("../src/lib/recordingSession").CursorCaptureMode;
		}) => Promise<{
			success: boolean;
			path?: string;
			session?: import("../src/lib/recordingSession").RecordingSession;
			message?: string;
			error?: string;
		}>;
		discardCursorTelemetry: (recordingId: number) => Promise<void>;
		getCursorTelemetry: (videoPath?: string) => Promise<{
			success: boolean;
			samples: CursorTelemetryPoint[];
			clicks: number[];
			message?: string;
			error?: string;
		}>;
		onStopRecordingFromTray: (callback: () => void) => () => void;
		openExternalUrl: (url: string) => Promise<{ success: boolean; error?: string }>;
		pickExportSavePath: (
			fileName: string,
			exportFolder?: string,
		) => Promise<{
			success: boolean;
			path?: string;
			message?: string;
			canceled?: boolean;
			error?: string;
		}>;
		writeExportToPath: (
			videoData: ArrayBuffer,
			filePath: string,
		) => Promise<{
			success: boolean;
			path?: string;
			message?: string;
			error?: string;
		}>;
		openVideoFilePicker: () => Promise<{
			success: boolean;
			path?: string;
			// Browser-mode shim only: a blob: URL has no meaningful basename, so
			// the shim carries the picked File's real name here for the label.
			name?: string;
			canceled?: boolean;
		}>;
		setCurrentVideoPath: (path: string) => Promise<{ success: boolean }>;
		setCurrentRecordingSession: (
			session: import("../src/lib/recordingSession").RecordingSession | null,
		) => Promise<{
			success: boolean;
			session?: import("../src/lib/recordingSession").RecordingSession;
		}>;
		getCurrentVideoPath: () => Promise<{ success: boolean; path?: string }>;
		getCurrentRecordingSession: () => Promise<{
			success: boolean;
			session?: RecordingSession | null;
			canceled?: boolean;
		}>;
		findRecordingCamera: (videoPath: string) => Promise<{
			success: boolean;
			webcamVideoPath?: string;
			offsetMs?: number;
			error?: string;
		}>;
		readBinaryFile: (filePath: string) => Promise<{
			success: boolean;
			data?: ArrayBuffer;
			path?: string;
			message?: string;
			error?: string;
		}>;
		getReadableFileInfo: (filePath: string) => Promise<{
			success: boolean;
			size?: number;
			mtimeMs?: number;
			path?: string;
			message?: string;
			error?: string;
		}>;
		readFileChunk: (
			filePath: string,
			offset: number,
			length: number,
		) => Promise<{
			success: boolean;
			data?: ArrayBuffer;
			bytesRead?: number;
			message?: string;
			error?: string;
		}>;
		preparePreviewAudioTrack: (filePath: string) => Promise<{
			success: boolean;
			path?: string | null;
			message?: string;
			error?: string;
		}>;
		clearCurrentVideoPath: () => Promise<{ success: boolean }>;
		saveProjectFile: (
			projectData: unknown,
			suggestedName?: string,
			existingProjectPath?: string,
		) => Promise<{
			success: boolean;
			path?: string;
			message?: string;
			canceled?: boolean;
			error?: string;
		}>;
		loadProjectFile: (projectFolder?: string) => Promise<{
			success: boolean;
			path?: string;
			project?: unknown;
			message?: string;
			canceled?: boolean;
			error?: string;
		}>;
		loadCurrentProjectFile: () => Promise<{
			success: boolean;
			path?: string;
			project?: unknown;
			message?: string;
			canceled?: boolean;
			error?: string;
		}>;
		getPathForFile: (file: File) => string;
		loadProjectFileFromPath: (filePath: string) => Promise<{
			success: boolean;
			path?: string;
			project?: unknown;
			message?: string;
			canceled?: boolean;
			error?: string;
		}>;
		onMenuNewProject: (callback: () => void) => () => void;
		onMenuImportVideo: (callback: () => void) => () => void;
		onMenuLoadProject: (callback: () => void) => () => void;
		onMenuSaveProject: (callback: () => void) => () => void;
		onMenuSaveProjectAs: (callback: () => void) => () => void;
		quitApp: () => void;
		getPlatform: () => Promise<string>;
		revealInFolder: (
			filePath: string,
		) => Promise<{ success: boolean; error?: string; message?: string }>;
		getShortcuts: () => Promise<Record<string, unknown> | null>;
		saveShortcuts: (shortcuts: unknown) => Promise<{ success: boolean; error?: string }>;
		updateGlobalShortcut: (binding: {
			key: string;
			ctrl?: boolean;
			shift?: boolean;
			alt?: boolean;
		}) => Promise<{ success: boolean }>;
		hudOverlayHide: () => void;
		hudOverlayClose: () => void;
		setHudOverlayIgnoreMouseEvents: (ignore: boolean) => void;
		moveHudOverlayBy: (deltaX: number, deltaY: number) => void;
		setHudOverlaySize: (width: number, height: number) => void;
		showCountdownOverlay: (value: number, runId: number) => Promise<void>;
		setCountdownOverlayValue: (value: number, runId: number) => Promise<void>;
		hideCountdownOverlay: (runId: number) => Promise<void>;
		onCountdownOverlayValue: (callback: (value: number | null) => void) => () => void;
		setMicrophoneExpanded: (expanded: boolean) => void;
		setHasUnsavedChanges: (hasChanges: boolean) => void;
		onRequestSaveBeforeClose: (callback: () => Promise<boolean> | boolean) => () => void;
		onRequestCloseConfirm: (callback: () => void) => () => void;
		sendCloseConfirmResponse: (choice: "save" | "discard" | "cancel") => void;
		stt: {
			transcribe: (
				request: import("./stt/transcriptionContract").SttTranscribeRequest,
			) => Promise<import("./stt/transcriptionContract").SttTranscribeResponse>;
			onStatus: (
				callback: (event: import("./stt/transcriptionContract").SttStatusEvent) => void,
			) => () => void;
		};
		setLocale: (locale: string) => Promise<void>;
		saveDiagnostic: (payload: {
			error: string;
			stack?: string;
			projectState: unknown;
			logs: string[];
		}) => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>;
	};
}

interface ProcessedDesktopSource {
	id: string;
	name: string;
	display_id: string;
	thumbnail: string | null;
	appIcon: string | null;
}

interface CursorTelemetryPoint {
	timeMs: number;
	cx: number;
	cy: number;
}
