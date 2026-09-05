// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { HUD_BAR_BOTTOM, HUD_POPOVER_GAP, HUD_POPOVER_MAX_HEIGHT } from "./hudGeometry";
import { LaunchWindow } from "./LaunchWindow";

type SelectedSourceChangedListener = Parameters<
	Window["electronAPI"]["onSelectedSourceChanged"]
>[0];

const platformState = vi.hoisted(() => ({ value: "darwin" }));
const linuxHelperAvailable = vi.hoisted(() => ({ value: true }));
const resizeCallbacks = vi.hoisted(() => [] as Array<ResizeObserverCallback>);

class StubResizeObserver {
	observe() {
		return undefined;
	}
	unobserve() {
		return undefined;
	}
	disconnect() {
		return undefined;
	}
}

class CapturingResizeObserver extends StubResizeObserver {
	constructor(callback: ResizeObserverCallback) {
		super();
		resizeCallbacks.push(callback);
	}
}

const recorderState = vi.hoisted(() => ({
	value: {
		recording: false,
		paused: false,
		saving: false,
		elapsedSeconds: 0,
		toggleRecording: vi.fn(),
		togglePaused: vi.fn(),
		canPauseRecording: false,
		restartRecording: vi.fn(),
		cancelRecording: vi.fn(),
		microphoneEnabled: false,
		setMicrophoneEnabled: vi.fn(),
		microphoneDeviceId: undefined,
		setMicrophoneDeviceId: vi.fn(),
		setMicrophoneDeviceName: vi.fn(),
		webcamEnabled: false,
		setWebcamEnabled: vi.fn(async () => true),
		webcamDeviceId: undefined,
		setWebcamDeviceId: vi.fn(),
		setWebcamDeviceName: vi.fn(),
		systemAudioEnabled: false,
		setSystemAudioEnabled: vi.fn(),
		cursorCaptureMode: "editable-overlay",
		setCursorCaptureMode: vi.fn(),
		softwareEncoderFallbackNoticeVisible: false,
		dismissSoftwareEncoderFallbackNotice: vi.fn(),
	},
}));

let hudCursorListeners: Array<(x: number, y: number) => void> = [];
let selectedSourceChangedListeners: SelectedSourceChangedListener[] = [];
let sourceSelectorClosedListeners: Array<() => void> = [];

vi.mock("../../hooks/useScreenRecorder", () => ({
	useScreenRecorder: () => recorderState.value,
}));

const micDevicesState = vi.hoisted(() => ({
	value: [] as Array<{ deviceId: string; label: string; groupId: string }>,
}));

vi.mock("../../hooks/useMicrophoneDevices", () => ({
	useMicrophoneDevices: () => ({
		devices: micDevicesState.value,
		selectedDeviceId: "default",
		setSelectedDeviceId: vi.fn(),
	}),
}));

vi.mock("../../hooks/useCameraDevices", () => ({
	useCameraDevices: () => ({
		devices: [],
		selectedDeviceId: "",
		setSelectedDeviceId: vi.fn(),
		isLoading: false,
		error: null,
	}),
}));

vi.mock("../../hooks/useAudioLevelMeter", () => ({
	useAudioLevelMeter: () => ({ level: 0 }),
}));

vi.mock("../../hooks/useCameraPreviewStream", () => ({
	useCameraPreviewStream: () => ({ stream: null, error: null }),
}));

vi.mock("../../lib/requestCameraAccess", () => ({
	requestCameraAccess: vi.fn(async () => ({ success: true, granted: true, status: "granted" })),
}));

vi.mock("@/native", () => ({
	nativeBridgeClient: {
		system: {
			getPlatform: vi.fn(async () => platformState.value),
		},
	},
}));

const appInfoState = vi.hoisted(() => ({
	value: { version: "1.9.6", canCheckForUpdates: true },
}));
const updateCheckMock = vi.hoisted(() => vi.fn(async () => undefined));

const i18nState = vi.hoisted(() => ({
	value: {
		locale: "en",
		setLocale: vi.fn(),
		systemLocaleSuggestion: null as string | null,
		acceptSystemLocaleSuggestion: vi.fn(),
		dismissSystemLocaleSuggestion: vi.fn(),
		resolveSystemLocaleSuggestion: vi.fn(),
	},
}));

vi.mock("@/i18n/loader", () => ({
	getAvailableLocales: () => ["en"],
	getLocaleName: () => "English",
}));

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => i18nState.value,
	useScopedT: () => (key: string, vars?: Record<string, string | number>) => {
		const translations: Record<string, string> = {
			"sourceSelector.defaultSourceName": "Screen",
			"recording.selectSource": "Please select a source to record",
			"recording.systemPicker": "Your system will ask what to share",
			"recording.inProgress": "Recording",
			"tooltips.useVerticalTray": "Use vertical tray",
			"tooltips.useHorizontalTray": "Use horizontal tray",
			"audio.enableSystemAudio": "Enable system audio",
			"audio.disableSystemAudio": "Disable system audio",
			"audio.enableMicrophone": "Enable microphone",
			"audio.disableMicrophone": "Disable microphone",
			"audio.defaultMicrophone": "Default Microphone",
			"webcam.enableWebcam": "Enable webcam",
			"webcam.disableWebcam": "Disable webcam",
			"webcam.defaultCamera": "Default Camera",
			"webcam.searching": "Searching...",
			"webcam.noneFound": "No camera found",
			"webcam.unavailable": "Camera unavailable",
			"deviceSettings.title": "Device settings",
			"deviceSettings.done": "Done",
			"deviceSettings.micLevel": "Input level",
			"deviceSettings.micHint": "Speak to check your microphone",
			"deviceSettings.noMicrophones": "No microphone found",
			"deviceSettings.preview": "Preview",
			"deviceSettings.previewUnavailable": "Preview unavailable",
			"deviceSettings.about": "About",
			"deviceSettings.version": "Version {{version}}",
			"actions.checkForUpdates": "Check for updates",
			"deviceSettings.checkingForUpdates": "Checking…",
			"audio.inputDevice": "Input device",
			"webcam.cameraDevice": "Camera device",
			"cursor.useEditableCursor": "Use editable cursor",
			"cursor.useSystemCursor": "Use system cursor",
			"tooltips.openStudio": "Open Studio",
			"tooltips.hideHUD": "Hide HUD",
			"tooltips.closeApp": "Close App",
			language: "Language",
			"systemLanguagePrompt.title": "Use your system language?",
			"systemLanguagePrompt.description":
				"We detected English as your system language. Do you want to switch OpenScreen to English?",
			"systemLanguagePrompt.keepDefault": "Keep current language",
			"systemLanguagePrompt.switch": "Switch to English",
			"softwareEncoderFallback.title": "Switched to software encoding",
			"softwareEncoderFallback.description":
				"The default GPU encoder failed to start, so OpenScreen fell back to software H.264 encoding. Recording should continue as normal, but CPU usage may be higher.",
			"softwareEncoderFallback.dismiss": "Got it",
			"softwareEncoderFallback.dontShowAgain": "Don't show again",
		};
		const value = translations[key] ?? key;
		if (!vars) return value;
		return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
			String(vars[name] ?? `{{${name}}}`),
		);
	},
}));

function renderLaunchWindow() {
	return render(
		<TooltipProvider>
			<LaunchWindow />
		</TooltipProvider>,
	);
}

function stubElectronAPI(getSelectedSource: Window["electronAPI"]["getSelectedSource"]) {
	window.electronAPI = {
		...window.electronAPI,
		getSelectedSource,
		openSourceSelector: vi.fn(async () => ({ opened: true })),
		requestScreenAccess: vi.fn(async () => ({
			success: true,
			granted: true,
			status: "granted",
		})),
		// Follows the platform under test. Pinned to "darwin" before, which was
		// invisible while only `nativeBridgeClient` was consulted for it — and
		// silently wrong the moment anything read the platform through here.
		getPlatform: vi.fn(() => platformState.value),
		// Only the Linux tests read this; the helper being present is what hands
		// source selection to the portal.
		isNativeLinuxCaptureAvailable: vi.fn(async () => ({
			success: true,
			available: linuxHelperAvailable.value,
		})),
		getAppInfo: vi.fn(async () => appInfoState.value),
		checkForUpdates: updateCheckMock,
		showFloatingSelfView: vi.fn(async () => ({ success: true })),
		hideFloatingSelfView: vi.fn(async () => ({ success: true })),
		getFloatingSelfViewState: vi.fn(async () => ({ open: false })),
		onFloatingSelfViewStateChanged: vi.fn(() => () => undefined),
		setHudOverlaySize: vi.fn(),
		setHudOverlayIgnoreMouseEvents: vi.fn(),
		onHudOverlayCursor: vi.fn((callback) => {
			hudCursorListeners.push(callback);
			return () => {
				hudCursorListeners = hudCursorListeners.filter((listener) => listener !== callback);
			};
		}),
		beginHudOverlayDrag: vi.fn(),
		dragHudOverlayTo: vi.fn(),
		endHudOverlayDrag: vi.fn(),
		hudOverlayHide: vi.fn(),
		hudOverlayClose: vi.fn(),
		openNotes: vi.fn(),
		switchToEditor: vi.fn(async () => undefined),
		onSelectedSourceChanged: vi.fn((callback) => {
			selectedSourceChangedListeners.push(callback);
			return () => {
				selectedSourceChangedListeners = selectedSourceChangedListeners.filter(
					(listener) => listener !== callback,
				);
			};
		}),
		onSourceSelectorClosed: vi.fn((callback) => {
			sourceSelectorClosedListeners.push(callback);
			return () => {
				sourceSelectorClosedListeners = sourceSelectorClosedListeners.filter(
					(listener) => listener !== callback,
				);
			};
		}),
	} as typeof window.electronAPI;
}

const displayOneSource = {
	id: "screen:1:0",
	name: "Display 1",
	display_id: "1",
	thumbnail: null,
	appIcon: null,
} satisfies ProcessedDesktopSource;

async function waitForSourceSelectionSubscription() {
	await waitFor(() => {
		expect(selectedSourceChangedListeners.length).toBeGreaterThan(0);
	});
}

function emitSelectedSourceChanged(source: ProcessedDesktopSource) {
	act(() => {
		selectedSourceChangedListeners.forEach((listener) => listener(source));
	});
}

function emitSourceSelectorClosed() {
	act(() => {
		sourceSelectorClosedListeners.forEach((listener) => listener());
	});
}

function resetLaunchMocks() {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	recorderState.value.toggleRecording.mockClear();
	recorderState.value.softwareEncoderFallbackNoticeVisible = false;
	recorderState.value.dismissSoftwareEncoderFallbackNotice.mockClear();
	recorderState.value.recording = false;
	recorderState.value.microphoneEnabled = false;
	recorderState.value.setMicrophoneEnabled.mockClear();
	recorderState.value.setMicrophoneDeviceId.mockClear();
	recorderState.value.webcamEnabled = false;
	recorderState.value.setWebcamEnabled.mockClear();
	micDevicesState.value = [];
	hudCursorListeners = [];
	selectedSourceChangedListeners = [];
	sourceSelectorClosedListeners = [];
	i18nState.value.systemLocaleSuggestion = null;
	i18nState.value.acceptSystemLocaleSuggestion.mockClear();
	i18nState.value.dismissSystemLocaleSuggestion.mockClear();
	i18nState.value.resolveSystemLocaleSuggestion.mockClear();
	i18nState.value.setLocale.mockClear();
	linuxHelperAvailable.value = true;
	appInfoState.value = { version: "1.9.6", canCheckForUpdates: true };
	updateCheckMock.mockReset();
	updateCheckMock.mockResolvedValue(undefined);
	stubElectronAPI(vi.fn(async () => null));
}

describe("LaunchWindow record button", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("opens the source selector instead of disabling the primary action when no source is selected", async () => {
		renderLaunchWindow();

		const recordButton = await screen.findByTestId("launch-record-button");

		expect(recordButton).toBeEnabled();
		expect(recordButton).toHaveAttribute("title", "Please select a source to record");

		fireEvent.click(recordButton);

		await waitFor(() => {
			expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1);
		});
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("records immediately after source selection when the record button opened the picker", async () => {
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		fireEvent.click(await screen.findByTestId("launch-record-button"));
		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1);
		});
		expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
	});

	it("does not record after manual source selection", async () => {
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
		});
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("clears record-after-selection intent when the source picker closes without a selection", async () => {
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		fireEvent.click(await screen.findByTestId("launch-record-button"));
		emitSourceSelectorClosed();
		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
		});
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("clears record-after-selection intent when opening the source picker fails", async () => {
		window.electronAPI.openSourceSelector = vi.fn(async () => {
			throw new Error("source selector failed");
		});

		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		fireEvent.click(await screen.findByTestId("launch-record-button"));

		await waitFor(() => {
			expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1);
		});

		await act(async () => {
			await Promise.resolve();
		});

		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
		});
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("handles selected source polling failures", async () => {
		const error = new Error("selected source unavailable");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		stubElectronAPI(
			vi.fn(async () => {
				throw error;
			}),
		);

		renderLaunchWindow();

		await waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith("Failed to refresh selected source:", error);
		});

		warnSpy.mockRestore();
	});

	it("starts recording when a source is already selected", async () => {
		stubElectronAPI(vi.fn(async () => displayOneSource));

		renderLaunchWindow();

		const recordButton = await screen.findByTestId("launch-record-button");
		await waitFor(() => {
			expect(recordButton).toHaveAttribute("title", "Display 1");
		});

		fireEvent.click(recordButton);

		expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1);
		expect(window.electronAPI.openSourceSelector).not.toHaveBeenCalled();
	});

	// The #385 regression, and #266 before it. A HUD that has gone click-through
	// receives no pointer event of any kind, so every DOM route back — pointerenter,
	// pointerdown, pointermove — is unreachable by construction. This test therefore
	// fires NO pointer events at all: it delivers only the cursor position the main
	// process pushes, which is the one signal that survives input-transparency, and
	// requires that to be enough to make the bar clickable again.
	it("leaves click-through on a pushed cursor position alone, with no pointer event", async () => {
		platformState.value = "win32";

		renderLaunchWindow();

		await waitFor(() => {
			expect(window.electronAPI.setHudOverlayIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
		});
		expect(hudCursorListeners).not.toHaveLength(0);

		// jsdom has no layout and does not implement elementFromPoint at all, so it is
		// defined here to return what each point resolves to in a browser. The assertion
		// is that the pushed cursor drives the hit test, not that jsdom can hit-test.
		const bar = document.querySelector("[data-hud-interactive='true']");
		expect(bar).not.toBeNull();
		const elementFromPoint = vi.fn((_x: number, _y: number): Element | null => document.body);
		Object.defineProperty(document, "elementFromPoint", {
			value: elementFromPoint,
			configurable: true,
		});
		const setIgnore = vi.mocked(window.electronAPI.setHudOverlayIgnoreMouseEvents);

		try {
			// The transparent reserve goes FIRST, while the window is still click-through.
			// Do it after the bar has claimed input back and the assertion is vacuous: the
			// renderer dedupes, so a point that wrongly enabled input would send no IPC at
			// all and "still false" would hold either way. Here a wrong answer is an IPC.
			setIgnore.mockClear();
			for (const listener of hudCursorListeners) listener(10, 10);
			expect(setIgnore).not.toHaveBeenCalled();

			// And the bar hands input back.
			elementFromPoint.mockReturnValue(bar);
			for (const listener of hudCursorListeners) listener(410, 540);

			expect(elementFromPoint).toHaveBeenCalledWith(410, 540);
			expect(setIgnore).toHaveBeenCalledWith(false);
		} finally {
			Reflect.deleteProperty(document, "elementFromPoint");
		}
	});

	// The mount effect's cleanup used to send `ignore=false` straight down the
	// bridge, bypassing the wrapper that owns `hudIgnoreMouseEventsRef`. That left
	// the mirror claiming the HUD was click-through while the main process had just
	// been told the opposite, and the next run then deduped against the stale value
	// and sent nothing at all — so the HUD stayed interactive with no way for the
	// renderer to ask again. StrictMode runs mount → cleanup → mount on every mount,
	// which makes dev the one environment where the click-through path never ran.
	it("keeps the main process and the renderer's mirror in step across a remount", async () => {
		platformState.value = "win32";

		render(
			<StrictMode>
				<TooltipProvider>
					<LaunchWindow />
				</TooltipProvider>
			</StrictMode>,
		);

		// The whole sequence, not its tail: because the wrapper dedupes, a cleanup
		// that is deleted outright and a cleanup that asks for the wrong value both
		// collapse to a lone [true] and would satisfy an assertion on the last call.
		// Only mount → hand input back → mount again distinguishes the three.
		await waitFor(() => {
			expect(vi.mocked(window.electronAPI.setHudOverlayIgnoreMouseEvents).mock.calls).toEqual([
				[true],
				[false],
				[true],
			]);
		});
	});

	it("unsubscribes from the pushed cursor when the HUD unmounts", async () => {
		platformState.value = "win32";

		const { unmount } = renderLaunchWindow();

		await waitFor(() => {
			expect(hudCursorListeners).not.toHaveLength(0);
		});

		unmount();

		expect(hudCursorListeners).toHaveLength(0);
	});

	it("keeps the HUD interactive on Linux so the drag handle can receive pointer events", async () => {
		platformState.value = "linux";

		renderLaunchWindow();

		await waitFor(() => {
			expect(window.electronAPI.setHudOverlayIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
		});
	});

	// The ScreenCast portal has no parameter naming a source, so nothing this
	// picker returned could ever reach the capture — it only raised a second
	// portal dialog whose grant was discarded. On Linux the compositor's own
	// picker, shown when recording starts, is the only thing that decides.
	it("hides the in-app source button on Linux", async () => {
		platformState.value = "linux";

		renderLaunchWindow();

		// The helper-availability answer arrives asynchronously, so the button is
		// still there on the first frame — wait for it to go rather than race it.
		await waitFor(() => {
			expect(screen.queryByTestId("launch-source-selector-button")).toBeNull();
		});
	});

	it("records straight away on Linux instead of demanding a source that cannot be selected", async () => {
		platformState.value = "linux";

		renderLaunchWindow();

		const recordButton = await screen.findByTestId("launch-record-button");
		expect(recordButton).toBeEnabled();
		await waitFor(() => {
			expect(recordButton).toHaveAttribute("title", "Your system will ask what to share");
		});

		fireEvent.click(recordButton);

		await waitFor(() => {
			expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1);
		});
		expect(window.electronAPI.openSourceSelector).not.toHaveBeenCalled();
	});

	// The portal reports a KIND, never a window title, so naming the source here
	// could only ever be a guess — and guessing is what put a window's name on a
	// recording of the whole screen.
	/**
	 * Without the helper the recorder falls back to Chromium's capture, which
	 * DOES consume a source id. Hiding the picker there would leave no way to
	 * start a recording at all.
	 */
	it("keeps the in-app source button on Linux when the native helper is missing", async () => {
		platformState.value = "linux";
		linuxHelperAvailable.value = false;

		renderLaunchWindow();

		expect(await screen.findByTestId("launch-source-selector-button")).toBeInTheDocument();
		expect(screen.getByTestId("launch-record-button")).toHaveAttribute(
			"title",
			"Please select a source to record",
		);
	});

	/**
	 * `portalOwnsSource` is resolved over IPC, so for a moment after mount it
	 * still reads false on Linux. A Record click landing in that window opened a
	 * selector the main process refuses — and the click used to be swallowed,
	 * doing nothing at all. The refusal is authoritative and answers immediately,
	 * so it starts the recording instead.
	 */
	it("records when the picker refuses because the portal owns the choice", async () => {
		platformState.value = "linux";
		// Forces the click down the open-the-selector path, as an unresolved
		// portal check does.
		linuxHelperAvailable.value = false;
		window.electronAPI.openSourceSelector = vi.fn(async () => ({
			opened: false,
			reason: "portal-owns-selection",
		})) as unknown as Window["electronAPI"]["openSourceSelector"];

		renderLaunchWindow();
		fireEvent.click(await screen.findByTestId("launch-record-button"));

		await waitFor(() => {
			expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1);
		});
	});

	it("does not name a source while recording on Linux", async () => {
		platformState.value = "linux";
		recorderState.value.recording = true;

		renderLaunchWindow();

		const recordButton = await screen.findByTestId("launch-record-button");
		await waitFor(() => {
			expect(recordButton).toHaveAttribute("title", "Recording");
		});
	});
});

/** jsdom reports zero layout, so fake a rendered box for the elements we measure. */
function stubBox(element: HTMLElement, width: number, height: number) {
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
		top: 0,
		left: 0,
		right: width,
		bottom: height,
		width,
		height,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	});
	Object.defineProperty(element, "scrollWidth", { value: width, configurable: true });
	Object.defineProperty(element, "scrollHeight", { value: height, configurable: true });
}

async function flushResizeObservers() {
	await act(async () => {
		for (const callback of resizeCallbacks) {
			callback([], {} as ResizeObserver);
		}
	});
}

function lastRequestedHudSize(): [number, number] {
	const sizeMock = window.electronAPI.setHudOverlaySize as unknown as {
		mock: { calls: Array<[number, number]> };
	};
	return sizeMock.mock.calls[sizeMock.mock.calls.length - 1];
}

describe("LaunchWindow overlay sizing", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
		resizeCallbacks.length = 0;
		vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("reserves room for a popover before one is ever opened", async () => {
		renderLaunchWindow();

		const bar = (await screen.findByTestId("hud-drag-handle")).closest(
			"[data-tray-layout]",
		) as HTMLElement;
		stubBox(bar, 400, 56);
		await flushResizeObservers();

		await waitFor(() => {
			expect(window.electronAPI.setHudOverlaySize).toHaveBeenCalled();
		});

		const [, height] = lastRequestedHudSize();
		// The window is already tall enough for a full-height popover, so opening one
		// costs no native resize -- that is what stops the HUD jumping on first open.
		expect(height).toBeGreaterThanOrEqual(
			HUD_BAR_BOTTOM + 56 + HUD_POPOVER_GAP + HUD_POPOVER_MAX_HEIGHT,
		);
	});

	it("reclaims the overlay once the content drops well below what was granted", async () => {
		renderLaunchWindow();

		const bar = (await screen.findByTestId("hud-drag-handle")).closest(
			"[data-tray-layout]",
		) as HTMLElement;
		// A bogus oversized reading (e.g. an unstyled first paint in dev) must not
		// leave the overlay permanently inflated.
		stubBox(bar, 1400, 700);
		await flushResizeObservers();
		const [inflatedWidth, inflatedHeight] = lastRequestedHudSize();

		stubBox(bar, 400, 56);
		await flushResizeObservers();

		const [width, height] = lastRequestedHudSize();
		expect(width).toBeLessThan(inflatedWidth);
		expect(height).toBeLessThan(inflatedHeight);
	});

	it("does not resize the overlay when a popover opens", async () => {
		renderLaunchWindow();

		const bar = (await screen.findByTestId("hud-drag-handle")).closest(
			"[data-tray-layout]",
		) as HTMLElement;
		stubBox(bar, 400, 56);
		await flushResizeObservers();

		const sizeMock = window.electronAPI.setHudOverlaySize as unknown as {
			mockClear: () => void;
		};
		sizeMock.mockClear();

		fireEvent.click(screen.getByRole("button", { name: "English" }));
		await screen.findByTestId("hud-language-menu");
		await flushResizeObservers();

		expect(window.electronAPI.setHudOverlaySize).not.toHaveBeenCalled();
	});

	it("does not resize the overlay when the device-settings panel opens", async () => {
		renderLaunchWindow();

		const bar = (await screen.findByTestId("hud-drag-handle")).closest(
			"[data-tray-layout]",
		) as HTMLElement;
		stubBox(bar, 400, 56);
		await flushResizeObservers();

		const sizeMock = window.electronAPI.setHudOverlaySize as unknown as {
			mockClear: () => void;
		};
		sizeMock.mockClear();

		// The panel is the tallest floating surface, so the window reserves room for
		// it up front. Growing on open would shift the bottom-anchored stack and
		// show up as position judder — the exact thing the reserve model prevents.
		fireEvent.click(screen.getByTestId("launch-device-settings-button"));
		await screen.findByTestId("hud-device-settings");
		await flushResizeObservers();

		expect(window.electronAPI.setHudOverlaySize).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId("launch-device-settings-button"));
		await waitFor(() => {
			expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
		});
		await flushResizeObservers();

		expect(window.electronAPI.setHudOverlaySize).not.toHaveBeenCalled();
	});

	it("grows the HUD overlay tall enough to fit the system language prompt", async () => {
		i18nState.value.systemLocaleSuggestion = "zh-CN";

		renderLaunchWindow();

		expect(await screen.findByText("Use your system language?")).toBeInTheDocument();

		const bar = (await screen.findByTestId("hud-drag-handle")).closest(
			"[data-tray-layout]",
		) as HTMLElement;
		stubBox(bar, 400, 56);
		const noticeHeight = 130;
		stubBox(screen.getByTestId("hud-notice-column"), 360, noticeHeight);
		await flushResizeObservers();

		await waitFor(() => {
			expect(window.electronAPI.setHudOverlaySize).toHaveBeenCalled();
		});

		const [, height] = lastRequestedHudSize();
		// Bar + popover reserve + the notice stacked above it, all of it on screen.
		expect(height).toBeGreaterThanOrEqual(
			HUD_BAR_BOTTOM + 56 + HUD_POPOVER_GAP + HUD_POPOVER_MAX_HEIGHT + noticeHeight,
		);
	});
});

describe("LaunchWindow language menu", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("sizes the menu from CSS instead of the overlay window's own height", async () => {
		renderLaunchWindow();

		fireEvent.click(await screen.findByRole("button", { name: "English" }));

		const menu = await screen.findByTestId("hud-language-menu");
		// A measured maxHeight/bottom is what used to truncate the list to whatever
		// the (initially tiny) overlay window could fit, then let it grow later when
		// the window grew for an unrelated reason -- e.g. after dragging the HUD.
		expect(menu.style.maxHeight).toBe("");
		expect(menu.style.bottom).toBe("");
		// And it lives inside the HUD stack, not portaled out to the document body.
		expect(menu.closest("[data-tray-layout]")).toBeNull();
		expect(menu.parentElement?.parentElement).toContainElement(
			screen.getByTestId("hud-drag-handle"),
		);
	});
});

describe("LaunchWindow popover dismissal", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	/** Opens the language menu the way a user does, and hands back its panel. */
	async function openLanguageMenu() {
		fireEvent.click(await screen.findByRole("button", { name: "English" }));
		return await screen.findByTestId("hud-language-menu");
	}

	/** Same for the device-settings panel. */
	async function openDeviceSettings() {
		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		return await screen.findByTestId("hud-device-settings");
	}

	it("closes the language menu on Escape without changing the locale", async () => {
		renderLaunchWindow();
		await openLanguageMenu();

		fireEvent.keyDown(window, { key: "Escape" });

		await waitFor(() => {
			expect(screen.queryByTestId("hud-language-menu")).not.toBeInTheDocument();
		});
		// Escape dismisses; it must never pick whatever entry happened to be under
		// the cursor or focused.
		expect(i18nState.value.setLocale).not.toHaveBeenCalled();
		expect(i18nState.value.resolveSystemLocaleSuggestion).not.toHaveBeenCalled();
	});

	it("closes the language menu on a pointerdown outside the trigger and the panel", async () => {
		renderLaunchWindow();
		await openLanguageMenu();

		// The HUD window is mostly empty reserve above the bar; a press there is a
		// real DOM pointerdown on the root, and it has to dismiss.
		fireEvent.pointerDown(document.body);

		await waitFor(() => {
			expect(screen.queryByTestId("hud-language-menu")).not.toBeInTheDocument();
		});
		expect(i18nState.value.setLocale).not.toHaveBeenCalled();
	});

	it("keeps the language menu open for a pointerdown inside the panel", async () => {
		renderLaunchWindow();
		const menu = await openLanguageMenu();

		fireEvent.pointerDown(menu);

		expect(screen.getByTestId("hud-language-menu")).toBeInTheDocument();
	});

	it("closes the language menu when the HUD window loses focus", async () => {
		renderLaunchWindow();
		await openLanguageMenu();

		// A click that lands beyond the HUD's native window produces no pointerdown
		// in this renderer at all — the only signal it gets is the window blur. And
		// once focus is gone, Escape can no longer be delivered here either, so this
		// is the one listener that can unstick that state (issue #435).
		fireEvent.blur(window);

		await waitFor(() => {
			expect(screen.queryByTestId("hud-language-menu")).not.toBeInTheDocument();
		});
		expect(i18nState.value.setLocale).not.toHaveBeenCalled();
	});

	it("closes the device-settings panel on Escape", async () => {
		renderLaunchWindow();
		await openDeviceSettings();

		fireEvent.keyDown(window, { key: "Escape" });

		await waitFor(() => {
			expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
		});
	});

	it("closes the device-settings panel on a pointerdown outside the trigger and the panel", async () => {
		renderLaunchWindow();
		await openDeviceSettings();

		fireEvent.pointerDown(document.body);

		await waitFor(() => {
			expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
		});
	});

	it("closes the device-settings panel when the HUD window loses focus", async () => {
		renderLaunchWindow();
		await openDeviceSettings();

		fireEvent.blur(window);

		await waitFor(() => {
			expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
		});
	});

	it("leaves a key that is not Escape alone", async () => {
		renderLaunchWindow();
		await openLanguageMenu();

		fireEvent.keyDown(window, { key: "a" });

		expect(screen.getByTestId("hud-language-menu")).toBeInTheDocument();
	});
});

describe("LaunchWindow device buttons", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("turns the microphone on with a single click, without opening anything", async () => {
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-microphone-button"));

		expect(recorderState.value.setMicrophoneEnabled).toHaveBeenCalledWith(true);
		expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
	});

	it("turns the microphone off with a single click when it is already on", async () => {
		recorderState.value.microphoneEnabled = true;

		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-microphone-button"));

		expect(recorderState.value.setMicrophoneEnabled).toHaveBeenCalledWith(false);
	});

	it("turns the camera on with a single click, without opening anything", async () => {
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-webcam-button"));

		await waitFor(() => {
			expect(recorderState.value.setWebcamEnabled).toHaveBeenCalledWith(true);
		});
		expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
	});

	it("turns the camera off with a single click when it is already on", async () => {
		recorderState.value.webcamEnabled = true;

		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-webcam-button"));

		await waitFor(() => {
			expect(recorderState.value.setWebcamEnabled).toHaveBeenCalledWith(false);
		});
	});
});

describe("LaunchWindow device settings", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("opens from the settings button and closes again from its own Done control", async () => {
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const panel = await screen.findByTestId("hud-device-settings");
		expect(panel).toBeInTheDocument();

		fireEvent.click(within(panel).getByRole("button", { name: "Done" }));

		await waitFor(() => {
			expect(screen.queryByTestId("hud-device-settings")).not.toBeInTheDocument();
		});
	});

	it("selects a device without switching it on", async () => {
		micDevicesState.value = [
			{ deviceId: "mic-a", label: "Mic A", groupId: "g" },
			{ deviceId: "mic-b", label: "Mic B", groupId: "g" },
		];

		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const panel = await screen.findByTestId("hud-device-settings");

		fireEvent.click(within(panel).getByRole("menuitemradio", { name: /Mic B/ }));

		// Selection is a preference, not an activation — that separation is the
		// whole reason the picker moved out of the mic button.
		expect(recorderState.value.setMicrophoneDeviceId).toHaveBeenCalledWith("mic-b");
		expect(recorderState.value.setMicrophoneEnabled).not.toHaveBeenCalled();
	});

	// The gear is disabled while recording, but a panel that was already open stays mounted —
	// and the main process refuses the check for the length of a take. Offering the button then
	// would give the user a click that does nothing at all: no dialog, no error, no feedback.
	it("withdraws the update check when a recording starts under an open panel", async () => {
		const { rerender } = renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const panel = await screen.findByTestId("hud-device-settings");
		expect(await within(panel).findByTestId("hud-check-for-updates")).toBeInTheDocument();

		recorderState.value.recording = true;
		rerender(
			<TooltipProvider>
				<LaunchWindow />
			</TooltipProvider>,
		);

		// The version stays: "what am I running" is exactly the question a take does not change.
		expect(within(panel).queryByTestId("hud-check-for-updates")).not.toBeInTheDocument();
		expect(within(panel).getByText("Version 1.9.6")).toBeInTheDocument();
	});

	it("is unavailable while recording, when devices can't be changed anyway", async () => {
		recorderState.value.recording = true;

		renderLaunchWindow();

		expect(await screen.findByTestId("launch-device-settings-button")).toBeDisabled();
	});

	it("shows the running version and hands the update check to the main process", async () => {
		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const panel = await screen.findByTestId("hud-device-settings");

		expect(await within(panel).findByText("Version 1.9.6")).toBeInTheDocument();

		fireEvent.click(within(panel).getByTestId("hud-check-for-updates"));

		expect(updateCheckMock).toHaveBeenCalledTimes(1);
	});

	// A Microsoft Store, Flathub, Snap or Nix copy is kept current by its package manager, and
	// pointing its user at a GitHub download starts a second, parallel install that then drifts
	// forever. The version still shows — it is the answer to "what am I running?", not an offer.
	it("offers no update check where a package manager owns the update", async () => {
		appInfoState.value = { version: "1.9.6", canCheckForUpdates: false };

		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const panel = await screen.findByTestId("hud-device-settings");

		expect(await within(panel).findByText("Version 1.9.6")).toBeInTheDocument();
		expect(within(panel).queryByTestId("hud-check-for-updates")).not.toBeInTheDocument();
	});

	it("reads as checking until the main process reports a verdict", async () => {
		let settleCheck: (() => void) | undefined;
		updateCheckMock.mockImplementation(
			() =>
				new Promise<undefined>((resolve) => {
					settleCheck = () => resolve(undefined);
				}),
		);

		renderLaunchWindow();

		fireEvent.click(await screen.findByTestId("launch-device-settings-button"));
		const panel = await screen.findByTestId("hud-device-settings");
		const button = await within(panel).findByTestId("hud-check-for-updates");

		fireEvent.click(button);

		await waitFor(() => {
			expect(button).toBeDisabled();
		});
		expect(button).toHaveTextContent("Checking…");

		await act(async () => {
			settleCheck?.();
		});

		expect(button).toBeEnabled();
		expect(button).toHaveTextContent("Check for updates");
	});
});

describe("LaunchWindow HUD drag", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
		resizeCallbacks.length = 0;
		vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
		// jsdom doesn't implement the Pointer Capture API; stub it so the drag handlers
		// (which call set/has/releasePointerCapture) don't throw.
		HTMLElement.prototype.setPointerCapture = vi.fn();
		HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
		HTMLElement.prototype.releasePointerCapture = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("sends the pointer's total travel, not per-frame deltas", async () => {
		renderLaunchWindow();

		const dragHandle = await screen.findByTestId("hud-drag-handle");

		fireEvent.pointerDown(dragHandle, { screenX: 100, screenY: 100 });
		expect(window.electronAPI.beginHudOverlayDrag).toHaveBeenCalledTimes(1);

		fireEvent.pointerMove(dragHandle, { screenX: 140, screenY: 130 });
		fireEvent.pointerMove(dragHandle, { screenX: 150, screenY: 140 });

		// Absolute offsets from the drag origin: the main process applies them to the
		// position it pinned at pointerdown, so nothing accumulates or drifts.
		expect(window.electronAPI.dragHudOverlayTo).toHaveBeenNthCalledWith(1, 40, 30);
		expect(window.electronAPI.dragHudOverlayTo).toHaveBeenNthCalledWith(2, 50, 40);

		fireEvent.pointerUp(dragHandle, { screenX: 150, screenY: 140 });
		expect(window.electronAPI.endHudOverlayDrag).toHaveBeenCalledTimes(1);
	});

	it("suppresses ResizeObserver-driven measurement while dragging, and measures once on release", async () => {
		renderLaunchWindow();

		const dragHandle = await screen.findByTestId("hud-drag-handle");

		// A bar wide enough that it genuinely outgrows the reserved window width, so a
		// measurement would produce a `setHudOverlaySize` call if it weren't suppressed.
		const bar = dragHandle.closest("[data-tray-layout]") as HTMLElement;
		stubBox(bar, 900, 56);

		const sizeMock = window.electronAPI.setHudOverlaySize as unknown as {
			mockClear: () => void;
		};
		sizeMock.mockClear();

		fireEvent.pointerDown(dragHandle, { screenX: 100, screenY: 100 });

		await flushResizeObservers();
		expect(window.electronAPI.setHudOverlaySize).not.toHaveBeenCalled();

		fireEvent.pointerMove(dragHandle, { screenX: 140, screenY: 130 });
		fireEvent.pointerUp(dragHandle, { screenX: 140, screenY: 130 });

		// Content is re-measured once the drag ends, so a real size change made mid-drag
		// still gets picked up promptly.
		await waitFor(() => {
			expect(window.electronAPI.setHudOverlaySize).toHaveBeenCalled();
		});
	});
});

describe("LaunchWindow software encoder fallback notice", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("stays hidden while the recorder reports no fallback", () => {
		renderLaunchWindow();

		expect(screen.queryByText("Switched to software encoding")).not.toBeInTheDocument();
	});

	it("shows the notice when the recorder reports a software fallback", async () => {
		recorderState.value.softwareEncoderFallbackNoticeVisible = true;

		renderLaunchWindow();

		expect(await screen.findByText("Switched to software encoding")).toBeInTheDocument();
		expect(screen.getByText(/fell back to software H\.264 encoding/)).toBeInTheDocument();
	});

	it("dismisses the notice without persisting when Got it is clicked", async () => {
		recorderState.value.softwareEncoderFallbackNoticeVisible = true;

		renderLaunchWindow();

		fireEvent.click(await screen.findByRole("button", { name: "Got it" }));

		expect(recorderState.value.dismissSoftwareEncoderFallbackNotice).toHaveBeenCalledTimes(1);
		expect(recorderState.value.dismissSoftwareEncoderFallbackNotice).toHaveBeenCalledWith();
	});

	it("persists the suppression when Don't show again is clicked", async () => {
		recorderState.value.softwareEncoderFallbackNoticeVisible = true;

		renderLaunchWindow();

		fireEvent.click(await screen.findByRole("button", { name: "Don't show again" }));

		expect(recorderState.value.dismissSoftwareEncoderFallbackNotice).toHaveBeenCalledTimes(1);
		expect(recorderState.value.dismissSoftwareEncoderFallbackNotice).toHaveBeenCalledWith(true);
	});
});
