import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { getAvailableLocales, getLocaleName } from "@/i18n/loader";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import { nativeBridgeClient } from "@/native";
import { type CameraDevice, useCameraDevices } from "../../hooks/useCameraDevices";
import { type MicrophoneDevice, useMicrophoneDevices } from "../../hooks/useMicrophoneDevices";
import { usePortalOwnsSource } from "../../hooks/usePortalOwnsSource";
import { useScreenRecorder } from "../../hooks/useScreenRecorder";
import { requestCameraAccess } from "../../lib/requestCameraAccess";
import {
	HudCameraButton,
	HudCursorButton,
	HudDivider,
	HudDragHandle,
	HudLanguageButton,
	HudLanguageMenu,
	HudMicButton,
	HudNotesButton,
	HudNotice,
	HudRecordButton,
	HudRecordingControls,
	HudSettingsButton,
	HudSourceButton,
	HudStudioButton,
	HudSystemAudioButton,
	HudTrayLayoutButton,
	HudWindowControls,
} from "./HudControls";
import { HudDeviceSettings, type HudDeviceSettingsLabels } from "./HudDeviceSettings";
import {
	computeHudBarMaxHeight,
	computeHudModalMaxHeight,
	computeHudPopoverMaxHeight,
	computeHudWindowSize,
	HUD_BAR_BOTTOM,
	HUD_GROWTH_RESERVE,
	HUD_POPOVER_GAP,
	HUD_STACK_GAP,
} from "./hudGeometry";
import styles from "./LaunchWindow.module.css";
import { openSourceSelectorWithPermissionRetry } from "./openSourceSelectorFlow";

// Locale list is computed once at module load; keeping the reference stable lets
// the language menu sit behind a memo boundary.
const AVAILABLE_LOCALES = getAvailableLocales();

// Used only when the renderer can't see a real display (tests, headless).
const FALLBACK_SCREEN_HEIGHT = 1080;

/**
 * Work-area height of the display, which is what the HUD's vertical budget is
 * really bounded by. Deliberately NOT `window.innerHeight`: the overlay window's
 * own height is the value this measurement feeds back into, and reading it here
 * is exactly what used to close the resize feedback loop.
 */
function getAvailableScreenHeight(): number {
	const available = typeof window === "undefined" ? 0 : window.screen?.availHeight;
	return available && available > 0 ? available : FALLBACK_SCREEN_HEIGHT;
}

/** Launches the floating recording HUD and its recorder controls. */
export function LaunchWindow() {
	const t = useScopedT("launch");
	// The update-check label is shared with the app menu and the tray, which read it from
	// `common`. A second copy under `launch` drifted from it in en and ar before it ever shipped.
	const tCommon = useScopedT("common");
	const {
		locale,
		setLocale,
		systemLocaleSuggestion,
		acceptSystemLocaleSuggestion,
		dismissSystemLocaleSuggestion,
		resolveSystemLocaleSuggestion,
	} = useI18n();
	const suggestedLanguageName = systemLocaleSuggestion ? getLocaleName(systemLocaleSuggestion) : "";
	const activeLanguageLabel = getLocaleName(locale).split(/\s+/)[0] || locale.toUpperCase();
	// Short mono-font code shown on the button itself (matches the design's
	// "EN"/"FR" treatment) — activeLanguageLabel (the full localized name)
	// stays as the tooltip/aria-label text.
	const languageCode = locale.split("-")[0].toUpperCase();

	const {
		recording,
		paused,
		saving,
		elapsedSeconds,
		toggleRecording,
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
		systemAudioEnabled,
		setSystemAudioEnabled,
		webcamEnabled,
		setWebcamEnabled,
		webcamDeviceId,
		setWebcamDeviceId,
		setWebcamDeviceName,
		cursorCaptureMode,
		setCursorCaptureMode,
		softwareEncoderFallbackNoticeVisible,
		dismissSoftwareEncoderFallbackNotice,
	} = useScreenRecorder();

	// Choosing a device and switching one on are deliberately separate concerns.
	// The mic and camera buttons are plain on/off toggles that use whatever device
	// is currently selected (the system default until the user says otherwise);
	// picking a different device — and checking it actually works — happens in the
	// settings panel. Overloading one button with both jobs is what made turning a
	// camera on take two clicks.
	const [isDeviceSettingsOpen, setIsDeviceSettingsOpen] = useState(false);
	const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
	const [trayLayout, setTrayLayout] = useState<"horizontal" | "vertical">(
		() => loadUserPreferences().trayLayout,
	);
	const [supportsCursorModeToggle, setSupportsCursorModeToggle] = useState(false);
	const [isLinuxHud, setIsLinuxHud] = useState(false);
	// The running version, and whether this copy may offer an update check at all — a
	// Store/Flathub/Snap/Nix install is kept current by its package manager and is offered
	// nothing (electron/install-channel.ts). Asked once: neither answer changes while the app
	// runs, and the HUD is rebuilt for every recording anyway.
	const [appInfo, setAppInfo] = useState<{ version: string; canCheckForUpdates: boolean } | null>(
		null,
	);
	const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);
	/**
	 * Narrower than [`isLinuxHud`] on purpose: without the helper the recorder
	 * falls back to Chromium's capture, which DOES take a source id, so the
	 * in-app picker has to stay for that case.
	 */
	const portalOwnsSource = usePortalOwnsSource();

	const isVertical = trayLayout === "vertical";
	const isPopoverOpen = isLanguageMenuOpen || isDeviceSettingsOpen;
	const controlsLocked = recording || saving;

	const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
	const languageTriggerRef = useRef<HTMLButtonElement | null>(null);
	const hudAnchorRef = useRef<HTMLDivElement | null>(null);
	const hudBarRef = useRef<HTMLDivElement | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const hudNoticesRef = useRef<HTMLDivElement | null>(null);

	// The camera list is enumerated from mount rather than on first open. It costs
	// one enumerateDevices() call and means the picker renders its final content
	// on its very first frame, and that `webcamDeviceId` is already the default
	// device when the button is clicked — so enabling the camera acquires the
	// right stream once instead of acquiring the default and then re-acquiring.
	//
	// Passing `webcamDeviceId` as the preferred device is what keeps the pick the
	// user made in the editor's Rec stage: this window is destroyed and rebuilt
	// for every recording, so the enumeration default would otherwise revert the
	// camera to whatever the OS lists first on each take.
	const {
		devices: cameraDevices,
		selectedDevice: selectedCamera,
		selectedDeviceId: selectedCameraId,
		setSelectedDeviceId: setSelectedCameraId,
		isLoading: isCameraDevicesLoading,
		error: cameraDevicesError,
	} = useCameraDevices(true, webcamDeviceId);
	// The microphone list stays lazy: enumerating it asks for mic permission,
	// which would light the OS "in use" indicator just for opening the HUD.
	const {
		devices: micDevices,
		selectedDeviceId: selectedMicId,
		setSelectedDeviceId: setSelectedMicId,
	} = useMicrophoneDevices(
		microphoneEnabled || isDeviceSettingsOpen,
		microphoneDeviceId,
		microphoneDeviceName,
	);

	useEffect(() => {
		if (selectedMicId && selectedMicId !== "default") {
			setMicrophoneDeviceId(selectedMicId);
			setMicrophoneDeviceName(micDevices.find((d) => d.deviceId === selectedMicId)?.label);
		}
	}, [selectedMicId, micDevices, setMicrophoneDeviceId, setMicrophoneDeviceName]);

	// Keyed on the chosen device's own fields, never on the `cameraDevices` array.
	// That array is rebuilt on every `devicechange`, and mirroring the selection
	// back on each rebuild put this effect in a tug-of-war with the preference
	// adoption inside `useCameraDevices`: the two wrote each other's value on
	// every commit and the HUD spun without ever settling.
	const selectedCameraLabel = selectedCamera?.label;
	useEffect(() => {
		if (selectedCameraId) {
			setWebcamDeviceId(selectedCameraId);
			setWebcamDeviceName(selectedCameraLabel);
		}
	}, [selectedCameraId, selectedCameraLabel, setWebcamDeviceId, setWebcamDeviceName]);

	useEffect(() => {
		let cancelled = false;
		nativeBridgeClient.system
			.getPlatform()
			.then((platform) => {
				if (!cancelled) {
					// Every platform with a native capture helper that can honour the
					// choice, which is now all three. Windows passes `captureCursor`
					// to wgc-capture, macOS passes `hideSystemCursor` to the
					// ScreenCaptureKit helper, and Linux passes `cursorMode` to the
					// PipeWire helper, which asks the ScreenCast portal for METADATA
					// or EMBEDDED. All three genuinely omit the system cursor from
					// the pixels.
					//
					// Linux was excluded here until the helper existed, and the
					// reason is worth keeping: capture went through Chromium, and
					// Chromium offers NO way to suppress the cursor.
					// `DesktopCaptureDevice::Create` wraps every capturer in a
					// `DesktopAndCursorComposer` unconditionally; on Linux WebRTC
					// asks the portal for METADATA mode and then paints the cursor
					// back in itself. So the toggle would have switched the editor's
					// overlay on without changing the pixels — which is exactly how
					// you get two cursors. Verified against a real recording at the
					// time. The helper is what makes the control mean something,
					// because it owns the video and never asks WebRTC for anything.
					setSupportsCursorModeToggle(
						platform === "win32" || platform === "darwin" || platform === "linux",
					);
					setIsLinuxHud(platform === "linux");
				}
			})
			.catch(() => {
				if (!cancelled) {
					setSupportsCursorModeToggle(false);
					setIsLinuxHud(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const getAppInfo = window.electronAPI?.getAppInfo;
		if (!getAppInfo) return;
		let cancelled = false;
		getAppInfo()
			.then((info) => {
				if (!cancelled) setAppInfo(info);
			})
			.catch((error) => {
				// Leaves the About block out entirely rather than showing "Version undefined".
				console.warn("Failed to read app info:", error);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const handleCheckForUpdates = useCallback(() => {
		const checkForUpdates = window.electronAPI?.checkForUpdates;
		if (!checkForUpdates) return;
		setIsCheckingForUpdates(true);
		// Resolves on the verdict, not on the dialogs it leads to — the main process owns
		// those, and a download the user approves must not leave this button spinning.
		checkForUpdates()
			.catch((error) => {
				console.error("Update check failed:", error);
			})
			.finally(() => {
				setIsCheckingForUpdates(false);
			});
	}, []);

	useEffect(() => {
		if (!import.meta.env.DEV) {
			return;
		}

		void requestCameraAccess().catch((error) => {
			console.warn("Failed to trigger camera access request during development:", error);
		});
	}, []);

	// One dismiss handler for both floating surfaces — they're mutually exclusive,
	// so a single pointerdown/Escape/blur listener covers the pair instead of two.
	const closePopovers = useCallback(() => {
		setIsDeviceSettingsOpen(false);
		setIsLanguageMenuOpen(false);
	}, []);

	useEffect(() => {
		if (!isPopoverOpen) return;

		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			const insideTrigger =
				settingsTriggerRef.current?.contains(target) ||
				languageTriggerRef.current?.contains(target);
			if (!insideTrigger && !popoverRef.current?.contains(target)) {
				closePopovers();
			}
		};

		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				closePopovers();
			}
		};

		window.addEventListener("pointerdown", handlePointerDown);
		window.addEventListener("keydown", handleEscape);
		// The third dismiss path, and the one that made issue #435: the HUD's native
		// window is only 904x698, so a click anywhere else on screen reaches this
		// renderer as nothing at all — no pointerdown to hit-test — while still taking
		// keyboard focus away. Escape is then undeliverable here, and the popover was
		// stuck open until the trigger was found again. `blur` is the one signal that
		// crosses, so it closes the pair; after this the "popover open in a window
		// that has no focus" state simply doesn't exist. Bubble phase on purpose:
		// element blur doesn't bubble, so this only ever fires for the window itself
		// and never when focus moves between the menu's own buttons.
		window.addEventListener("blur", closePopovers);

		return () => {
			window.removeEventListener("pointerdown", handlePointerDown);
			window.removeEventListener("keydown", handleEscape);
			window.removeEventListener("blur", closePopovers);
		};
	}, [closePopovers, isPopoverOpen]);

	// ---------------------------------------------------------------------------
	// Overlay window sizing
	//
	// The renderer owns the overlay window's size, so a naive "measure what's on
	// screen and grow to fit" is a feedback loop: the resize changes the viewport,
	// viewport-sized boxes re-layout, the observer fires again. That loop is what
	// made the HUD flicker and jump the first few times each popover was opened.
	//
	// Two rules break it, and both live here:
	//   1. Only the bar is measured. Everything floating above it has a fixed
	//      width and a capped height, so its space is *reserved* from the first
	//      frame — opening a popover costs zero native resizes.
	//   2. No measured box may be sized against the viewport. Caps come from
	//      screen.availHeight (which a window resize can't change) and are pushed
	//      down as CSS custom properties.
	// ---------------------------------------------------------------------------
	const hudAllocatedSizeRef = useRef({ width: 0, height: 0, orientation: trayLayout });
	const isDraggingHudRef = useRef(false);

	useLayoutEffect(() => {
		const anchor = hudAnchorRef.current;
		if (!anchor) return;
		anchor.style.setProperty("--hud-bar-bottom", `${HUD_BAR_BOTTOM}px`);
		anchor.style.setProperty("--hud-popover-gap", `${HUD_POPOVER_GAP}px`);
		anchor.style.setProperty("--hud-stack-gap", `${HUD_STACK_GAP}px`);
		anchor.style.setProperty(
			"--hud-bar-max-h",
			`${computeHudBarMaxHeight(getAvailableScreenHeight())}px`,
		);
	}, []);

	const measureHudSize = useCallback(() => {
		const barEl = hudBarRef.current;
		if (!barEl || !window.electronAPI?.setHudOverlaySize) return;
		// While the user is dragging, a resize would re-anchor the window from its
		// own bounds and fight the position the drag is applying frame by frame.
		// Content is re-measured once the drag ends instead.
		if (isDraggingHudRef.current) return;

		const availableHeight = getAvailableScreenHeight();
		const barRect = barEl.getBoundingClientRect();
		const barWidth = barRect.width || barEl.scrollWidth;
		const barHeight = barRect.height || barEl.scrollHeight;
		const noticeEl = hudNoticesRef.current;
		const noticeHeight = noticeEl
			? noticeEl.getBoundingClientRect().height || noticeEl.scrollHeight
			: 0;

		// The two floating surfaces get their own CSS caps (a 470px-tall language
		// list would look absurd), but the *window* always reserves room for the
		// taller of them. Sizing the reserve to whichever happens to be open would
		// mean the window grows when the panel opens — and since the stack is
		// bottom-anchored, growing upward moves every bit of content down in window
		// coordinates, which the renderer repaints a frame or two after the native
		// resize lands. That gap is visible as exactly the position judder this
		// whole architecture exists to remove. So: reserve the maximum, always.
		const popoverMaxHeight = computeHudPopoverMaxHeight(barHeight, availableHeight);
		const modalMaxHeight = computeHudModalMaxHeight(barHeight, availableHeight);
		const anchorEl = hudAnchorRef.current;
		anchorEl?.style.setProperty("--hud-popover-max-h", `${popoverMaxHeight}px`);
		anchorEl?.style.setProperty("--hud-modal-max-h", `${modalMaxHeight}px`);

		const { required, granted } = computeHudWindowSize({
			barWidth,
			barHeight,
			noticeHeight,
			availableHeight,
			stackMaxHeight: Math.max(popoverMaxHeight, modalMaxHeight),
		});

		const allocated = hudAllocatedSizeRef.current;
		// A different orientation is a different shape entirely (wide-short vs
		// narrow-tall), so the previous allocation says nothing useful.
		const orientationChanged = allocated.orientation !== trayLayout;
		// Grow the moment the content stops fitting. Shrink only once the content
		// has fallen a whole reserve below what was granted — that asymmetry is the
		// hysteresis: the bar can grow into its reserve (recording controls, a
		// longer source name) and back out again without a single native resize,
		// while a one-off bad reading (an unstyled first paint in dev, say) can't
		// leave the overlay permanently oversized.
		const needsResize =
			orientationChanged ||
			required.width > allocated.width ||
			required.height > allocated.height ||
			granted.width + HUD_GROWTH_RESERVE < allocated.width ||
			granted.height + HUD_GROWTH_RESERVE < allocated.height;
		if (!needsResize) {
			return;
		}

		allocated.orientation = trayLayout;
		allocated.width = granted.width;
		allocated.height = granted.height;
		window.electronAPI.setHudOverlaySize(granted.width, granted.height);
	}, [trayLayout]);

	// One persistent observer; elements wire themselves up via callback refs as
	// they mount/unmount. Only the bar and the notice column are observed — the
	// popovers deliberately are not, since their space is already reserved.
	const hudResizeObserverRef = useRef<ResizeObserver | null>(null);
	useEffect(() => {
		const observer = new ResizeObserver(() => measureHudSize());
		hudResizeObserverRef.current = observer;
		if (hudBarRef.current) observer.observe(hudBarRef.current);
		if (hudNoticesRef.current) observer.observe(hudNoticesRef.current);
		measureHudSize();
		return () => {
			observer.disconnect();
			hudResizeObserverRef.current = null;
		};
	}, [measureHudSize]);

	const observeHudElement = useCallback(
		<T extends HTMLElement>(el: T | null, ref: React.MutableRefObject<T | null>) => {
			const observer = hudResizeObserverRef.current;
			if (ref.current && observer) observer.unobserve(ref.current);
			ref.current = el;
			if (el && observer) observer.observe(el);
			measureHudSize();
		},
		[measureHudSize],
	);
	const setHudBarEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, hudBarRef),
		[observeHudElement],
	);
	const setHudNoticesEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, hudNoticesRef),
		[observeHudElement],
	);
	const setPopoverEl = useCallback((el: HTMLDivElement | null) => {
		popoverRef.current = el;
	}, []);

	const hudIgnoreMouseEventsRef = useRef<boolean | undefined>(undefined);
	const setHudMouseEventsEnabled = useCallback(
		(enabled: boolean) => {
			const shouldIgnoreMouseEvents = !enabled && !isLinuxHud;
			if (hudIgnoreMouseEventsRef.current === shouldIgnoreMouseEvents) {
				return;
			}
			hudIgnoreMouseEventsRef.current = shouldIgnoreMouseEvents;
			window.electronAPI?.setHudOverlayIgnoreMouseEvents?.(shouldIgnoreMouseEvents);
		},
		[isLinuxHud],
	);

	useEffect(() => {
		setHudMouseEventsEnabled(false);
		return () => {
			// Through the wrapper, not the bridge under it: the wrapper owns
			// `hudIgnoreMouseEventsRef`, and a raw send here leaves that mirror
			// describing a state the main process has already left. The next run
			// then dedupes against a mirror that is wrong and sends nothing — under
			// StrictMode that is every mount, so the click-through path quietly
			// stops being exercised on the machine it is developed on.
			setHudMouseEventsEnabled(true);
		};
	}, [setHudMouseEventsEnabled]);

	// A popover reaches beyond the bar, and the gap between the two would otherwise
	// flip the window back to click-through mid-travel — so hold the overlay
	// interactive for as long as one is open, and hand control back to the
	// pointer-move tracking once it closes.
	useEffect(() => {
		setHudMouseEventsEnabled(isPopoverOpen);
	}, [isPopoverOpen, setHudMouseEventsEnabled]);

	// The way back out of click-through. Every other route below — pointerenter and
	// pointerdown on the bar, pointermove on the root — needs an event this document
	// stops receiving the moment the window goes input-transparent, which is what left
	// the HUD painted and permanently dead in #266 and again in #385. So the main
	// process samples the OS cursor and pushes it here instead, and the hit test is the
	// one `handleRootPointerMove` already runs, against the same layout: elementFromPoint
	// honours pointer-events, so a point over the transparent reserve resolves to the
	// root and correctly stays click-through.
	//
	// Only ever turns click-through OFF. Turning it back on is the DOM handlers' job,
	// and they are reliable by then — the window is receiving real input again.
	useEffect(() => {
		return window.electronAPI?.onHudOverlayCursor?.((x, y) => {
			if (document.elementFromPoint(x, y)?.closest("[data-hud-interactive='true']")) {
				setHudMouseEventsEnabled(true);
			}
		});
	}, [setHudMouseEventsEnabled]);

	const defaultSourceName = t("sourceSelector.defaultSourceName");
	const [selectedSource, setSelectedSource] = useState(defaultSourceName);
	const [hasSelectedSource, setHasSelectedSource] = useState(false);
	const recordAfterSourceSelectionRef = useRef(false);

	const applySelectedSource = useCallback(
		(source: ProcessedDesktopSource | null) => {
			if (source) {
				setSelectedSource(source.name);
				setHasSelectedSource(true);
				return;
			}

			setSelectedSource(defaultSourceName);
			setHasSelectedSource(false);
		},
		[defaultSourceName],
	);

	// The main process pushes every change through `onSelectedSourceChanged`, so
	// this only needs one read to seed the initial value (plus one on focus, in
	// case a change was missed while this window was gone). The old 500ms poll ran
	// two IPC round-trips a second, forever, for a value that is event-driven.
	useEffect(() => {
		let cancelled = false;

		const refreshSelectedSource = async () => {
			if (!window.electronAPI) {
				return;
			}

			try {
				const source = await window.electronAPI.getSelectedSource();
				if (!cancelled) {
					applySelectedSource(source);
				}
			} catch (error) {
				console.warn("Failed to refresh selected source:", error);
			}
		};

		void refreshSelectedSource();
		window.addEventListener("focus", refreshSelectedSource);

		return () => {
			cancelled = true;
			window.removeEventListener("focus", refreshSelectedSource);
		};
	}, [applySelectedSource]);

	useEffect(() => {
		const cleanupSourceChanged = window.electronAPI?.onSelectedSourceChanged?.((source) => {
			applySelectedSource(source);
			if (!recordAfterSourceSelectionRef.current || recording) {
				return;
			}

			recordAfterSourceSelectionRef.current = false;
			toggleRecording();
		});
		const cleanupSelectorClosed = window.electronAPI?.onSourceSelectorClosed?.(() => {
			recordAfterSourceSelectionRef.current = false;
		});

		return () => {
			cleanupSourceChanged?.();
			cleanupSelectorClosed?.();
		};
	}, [applySelectedSource, recording, toggleRecording]);

	const openSourceSelector = useCallback(async () => {
		if (window.electronAPI) {
			return await openSourceSelectorWithPermissionRetry({
				openSourceSelector: () => window.electronAPI.openSourceSelector(),
				requestScreenAccess: () => window.electronAPI.requestScreenAccess(),
			});
		}

		return { opened: false, reason: "electron-api-unavailable" };
	}, []);

	const handleRecordButtonClick = useCallback(
		(sourceSelectedOverride?: boolean) => {
			if (saving) {
				return;
			}
			// Linux never detours through the in-app picker: there is nothing for
			// it to select, and waiting for a selection that can never arrive left
			// the record button opening a modal instead of recording.
			const sourceSelected = portalOwnsSource || (sourceSelectedOverride ?? hasSelectedSource);
			if (!sourceSelected && !recording) {
				recordAfterSourceSelectionRef.current = true;
				void openSourceSelector()
					.then((result) => {
						if (result.opened) {
							return;
						}
						recordAfterSourceSelectionRef.current = false;
						// The main process is the authority on who owns the choice,
						// and it answers synchronously. `portalOwnsSource` is resolved
						// over IPC, so for a moment after mount it still reads false —
						// and a Record click landing in that window used to open a
						// selector that refused, leaving the click doing nothing at
						// all. Honouring the refusal starts the recording instead,
						// whatever the local state has caught up to.
						if (result.reason === "portal-owns-selection" && !recording) {
							toggleRecording();
						}
					})
					.catch(() => {
						recordAfterSourceSelectionRef.current = false;
					});
				return;
			}

			toggleRecording();
		},
		[hasSelectedSource, portalOwnsSource, openSourceSelector, recording, saving, toggleRecording],
	);
	const handleRecordClick = useCallback(() => handleRecordButtonClick(), [handleRecordButtonClick]);

	// The editor's Rec-mode stage sends this once it hands off to the HUD
	// (source + prefs already persisted via IPC), so the user doesn't have to
	// click Record a second time after "Start recording" reopens this window.
	// The auto-start signal can arrive before this window's own initial
	// `getSelectedSource` round-trip has resolved, so `hasSelectedSource` may
	// still be stale — fetch a fresh value here instead of trusting it, otherwise
	// auto-start can wrongly fall through to opening the source selector.
	const handleRecordButtonClickRef = useRef(handleRecordButtonClick);
	handleRecordButtonClickRef.current = handleRecordButtonClick;
	const hasSelectedSourceRef = useRef(hasSelectedSource);
	hasSelectedSourceRef.current = hasSelectedSource;
	useEffect(() => {
		return window.electronAPI?.onAutoStartRecording?.(() => {
			void (async () => {
				let sourceSelected = hasSelectedSourceRef.current;
				try {
					const source = await window.electronAPI?.getSelectedSource?.();
					sourceSelected = !!source;
					applySelectedSource(source ?? null);
				} catch (error) {
					console.warn("Failed to refresh selected source before auto-start:", error);
				}
				handleRecordButtonClickRef.current(sourceSelected);
			})();
		});
	}, [applySelectedSource]);

	const sendHudOverlayHide = useCallback(() => {
		window.electronAPI?.hudOverlayHide?.();
	}, []);
	const sendHudOverlayClose = useCallback(() => {
		window.electronAPI?.hudOverlayClose?.();
	}, []);
	const openStudio = useCallback(() => {
		if (!saving) window.electronAPI.switchToEditor();
	}, [saving]);
	const openNotes = useCallback(() => {
		if (!saving) window.electronAPI.openNotes();
	}, [saving]);

	/** Switches the HUD between horizontal and vertical tray layouts. */
	const toggleTrayLayout = useCallback(() => {
		// Popovers are laid out relative to the bar, so leaving one open across an
		// orientation flip means resizing and re-flowing in the same frame. Closing
		// first keeps the flip to a single, clean size change.
		closePopovers();
		setTrayLayout((previous) => {
			const nextLayout = previous === "horizontal" ? "vertical" : "horizontal";
			saveUserPreferences({ trayLayout: nextLayout });
			return nextLayout;
		});
	}, [closePopovers]);

	const toggleSystemAudio = useCallback(() => {
		if (controlsLocked) return;
		setSystemAudioEnabled(!systemAudioEnabled);
	}, [controlsLocked, setSystemAudioEnabled, systemAudioEnabled]);

	const toggleCursorMode = useCallback(() => {
		if (controlsLocked) return;
		setCursorCaptureMode(cursorCaptureMode === "editable-overlay" ? "system" : "editable-overlay");
	}, [controlsLocked, cursorCaptureMode, setCursorCaptureMode]);

	const toggleMicrophone = useCallback(() => {
		if (controlsLocked) return;
		setMicrophoneEnabled(!microphoneEnabled);
	}, [controlsLocked, microphoneEnabled, setMicrophoneEnabled]);

	/**
	 * Write a camera choice back to the main-process recording prefs.
	 *
	 * The HUD used to be a reader of that SSOT and never a writer, while being
	 * destroyed and rebuilt for every recording — so a camera picked here lived
	 * exactly as long as one take, and the editor's Rec stage kept showing the
	 * previous device. Best-effort on purpose: failing to persist a preference
	 * must not stop a recording.
	 */
	const persistRecordingPrefs = useCallback(
		(patch: {
			camEnabled?: boolean;
			camDeviceId?: string;
			micDeviceId?: string;
			micDeviceName?: string;
		}) => {
			void window.electronAPI?.setRecordingPrefs?.(patch).catch((error) => {
				console.warn("Failed to persist the device preference:", error);
			});
		},
		[],
	);

	const toggleWebcam = useCallback(() => {
		if (controlsLocked) return;
		const next = !webcamEnabled;
		void setWebcamEnabled(next).then((ok) => {
			if (ok) persistRecordingPrefs({ camEnabled: next });
		});
	}, [controlsLocked, persistRecordingPrefs, setWebcamEnabled, webcamEnabled]);

	// Selecting a device never switches it on. If the device is already live the
	// recorder re-acquires on the id change; if it isn't, this just records which
	// one the next toggle should use.
	const handleSelectMicDevice = useCallback(
		(device: MicrophoneDevice) => {
			setSelectedMicId(device.deviceId);
			setMicrophoneDeviceId(device.deviceId);
			setMicrophoneDeviceName(device.label);
			persistRecordingPrefs({ micDeviceId: device.deviceId, micDeviceName: device.label });
		},
		[persistRecordingPrefs, setMicrophoneDeviceId, setMicrophoneDeviceName, setSelectedMicId],
	);

	const handleSelectCameraDevice = useCallback(
		(device: CameraDevice) => {
			setSelectedCameraId(device.deviceId);
			setWebcamDeviceId(device.deviceId);
			setWebcamDeviceName(device.label);
			persistRecordingPrefs({ camDeviceId: device.deviceId });
		},
		[persistRecordingPrefs, setSelectedCameraId, setWebcamDeviceId, setWebcamDeviceName],
	);

	const toggleDeviceSettings = useCallback(() => {
		if (controlsLocked) return;
		setIsLanguageMenuOpen(false);
		setIsDeviceSettingsOpen((open) => !open);
	}, [controlsLocked]);

	const closeDeviceSettings = useCallback(() => {
		setIsDeviceSettingsOpen(false);
	}, []);

	const toggleLanguageMenu = useCallback(() => {
		if (saving) return;
		setIsDeviceSettingsOpen(false);
		setIsLanguageMenuOpen((open) => !open);
	}, [saving]);

	const handleSelectLocale = useCallback(
		(nextLocale: string) => {
			setLocale(nextLocale as Parameters<typeof setLocale>[0]);
			resolveSystemLocaleSuggestion();
			setIsLanguageMenuOpen(false);
		},
		[resolveSystemLocaleSuggestion, setLocale],
	);

	const enableHudMouseEvents = useCallback(() => {
		setHudMouseEventsEnabled(true);
	}, [setHudMouseEventsEnabled]);

	// ---------------------------------------------------------------------------
	// Dragging
	//
	// Deltas are absolute (total travel since pointerdown), not incremental: the
	// main process pins the window's origin at drag start and every move is
	// `origin + delta`. Accumulating per-frame deltas instead meant every rounded
	// setPosition compounded, and a dropped message drifted permanently. Absolute
	// deltas are self-correcting, and there's no requestAnimationFrame in the path
	// — pointermove is already delivered at most once per frame, so the rAF only
	// ever added a frame of latency to a gesture the user is watching.
	// ---------------------------------------------------------------------------
	const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
	const lastDragDeltaRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

	const handleHudDragPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			event.stopPropagation();
			setHudMouseEventsEnabled(true);
			event.currentTarget.setPointerCapture(event.pointerId);
			dragOriginRef.current = { x: event.screenX, y: event.screenY };
			lastDragDeltaRef.current = { x: 0, y: 0 };
			isDraggingHudRef.current = true;
			window.electronAPI?.beginHudOverlayDrag?.();
		},
		[setHudMouseEventsEnabled],
	);

	const handleHudDragPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		const origin = dragOriginRef.current;
		if (!origin) return;
		const deltaX = event.screenX - origin.x;
		const deltaY = event.screenY - origin.y;
		const last = lastDragDeltaRef.current;
		if (last.x === deltaX && last.y === deltaY) return;
		lastDragDeltaRef.current = { x: deltaX, y: deltaY };
		window.electronAPI?.dragHudOverlayTo?.(deltaX, deltaY);
	}, []);

	const handleHudDragPointerEnd = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (!dragOriginRef.current) return;
			dragOriginRef.current = null;
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			isDraggingHudRef.current = false;
			window.electronAPI?.endHudOverlayDrag?.();
			measureHudSize();
		},
		[measureHudSize],
	);

	const handleRootPointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			// The pointer is captured by the drag handle anyway; skip the DOM walk.
			if (isDraggingHudRef.current) return;
			const target = event.target as HTMLElement | null;
			setHudMouseEventsEnabled(
				isPopoverOpen || Boolean(target?.closest("[data-hud-interactive='true']")),
			);
		},
		[isPopoverOpen, setHudMouseEventsEnabled],
	);

	const handlePointerLeave = useCallback(() => {
		if (!isPopoverOpen) {
			setHudMouseEventsEnabled(false);
		}
	}, [isPopoverOpen, setHudMouseEventsEnabled]);

	const dismissSoftwareFallbackForever = useCallback(() => {
		dismissSoftwareEncoderFallbackNotice(true);
	}, [dismissSoftwareEncoderFallbackNotice]);
	const dismissSoftwareFallbackOnce = useCallback(() => {
		dismissSoftwareEncoderFallbackNotice();
	}, [dismissSoftwareEncoderFallbackNotice]);

	// On Linux the ScreenCast portal owns the choice, so there is no in-app
	// selection to name and none to demand: the idle label says what pressing
	// record will do, and the recording label stays neutral because the portal
	// reports a KIND, never a window title. Naming a source we were never told
	// is what put a window's name on a full-screen recording.
	const recordLabel = saving
		? t("recording.saving")
		: portalOwnsSource
			? recording
				? t("recording.inProgress")
				: t("recording.systemPicker")
			: hasSelectedSource || recording
				? selectedSource
				: t("recording.selectSource");

	// Stable identity, or the panel's memo boundary would break on every parent
	// render — including the once-a-second one during a recording.
	const deviceSettingsLabels = useMemo<HudDeviceSettingsLabels>(
		() => ({
			title: t("deviceSettings.title"),
			done: t("deviceSettings.done"),
			microphone: t("audio.inputDevice"),
			camera: t("webcam.cameraDevice"),
			micLevel: t("deviceSettings.micLevel"),
			micHint: t("deviceSettings.micHint"),
			noMicrophones: t("deviceSettings.noMicrophones"),
			searching: t("webcam.searching"),
			noCameras: t("webcam.noneFound"),
			cameraUnavailable: t("webcam.unavailable"),
			preview: t("deviceSettings.preview"),
			previewUnavailable: t("deviceSettings.previewUnavailable"),
			about: t("deviceSettings.about"),
			checkForUpdates: tCommon("actions.checkForUpdates"),
			checkingForUpdates: t("deviceSettings.checkingForUpdates"),
		}),
		[t, tCommon],
	);

	const versionLabel = appInfo ? t("deviceSettings.version", { version: appInfo.version }) : null;

	const hasNotices = Boolean(systemLocaleSuggestion) || softwareEncoderFallbackNoticeVisible;

	return (
		// Avoid w-screen/h-screen: 100vw can exceed the inner layout width when scrollbars
		// affect the viewport (Windows), causing a horizontal scrollbar (issue #305).
		<div
			// No `electronDrag` here. This root is the whole 820x560 window, nearly all of
			// it invisible, and a drag region is honoured by the compositor whether or not
			// anything is painted there. On Windows/macOS that stayed hidden because
			// `setIgnoreMouseEvents` makes the transparent area input-transparent at the OS
			// level; on Linux that call is a no-op, so pressing empty space next to the bar
			// dragged the HUD from a spot the user was aiming *past*. The drag region
			// belongs on the grab handle, which is where it now lives.
			className="h-full w-full min-w-0 max-w-full overflow-x-hidden overflow-y-hidden bg-transparent"
			onPointerMove={handleRootPointerMove}
			onPointerLeave={handlePointerLeave}
		>
			{/* One bottom-anchored stack: the bar, then whatever floats above it.
			    Everything is laid out by flexbox relative to the bar, so no popover
			    needs a measured position and none of them can move the window. */}
			<div ref={hudAnchorRef} className={styles.hudAnchor}>
				<div
					ref={setHudBarEl}
					data-hud-interactive="true"
					data-tray-layout={trayLayout}
					className={`${styles.hudBar} ${isVertical ? styles.hudBarVertical : styles.hudBarHorizontal}`}
					onPointerEnter={enableHudMouseEvents}
					onPointerDown={enableHudMouseEvents}
					onMouseEnter={enableHudMouseEvents}
					onMouseLeave={handlePointerLeave}
				>
					<HudDragHandle
						vertical={isVertical}
						nativeDrag={isLinuxHud}
						onPointerDown={handleHudDragPointerDown}
						onPointerMove={handleHudDragPointerMove}
						onPointerEnd={handleHudDragPointerEnd}
					/>

					<HudDivider vertical={isVertical} />

					<HudTrayLayoutButton
						vertical={isVertical}
						label={isVertical ? t("tooltips.useHorizontalTray") : t("tooltips.useVerticalTray")}
						onClick={toggleTrayLayout}
					/>

					{/* No source button on Linux: `SelectSources` has no parameter
					    naming a source, so nothing this picker returned could reach
					    the capture. It raised a second portal dialog of its own —
					    via `desktopCapturer.getSources()` — whose grant was then
					    discarded, which is why picking a window here changed
					    nothing. The compositor's picker is the only one that
					    decides, and it appears when recording starts. */}
					{!portalOwnsSource && (
						<HudSourceButton
							vertical={isVertical}
							label={selectedSource}
							disabled={controlsLocked}
							onClick={openSourceSelector}
						/>
					)}

					<HudDivider vertical={isVertical} />

					{/* System audio / mic / camera / cursor — each its own standalone
					    transparent icon button (no shared group pill), matching the
					    design exactly: rest color is muted gray, active/enabled color
					    is the accent green. */}
					<HudSystemAudioButton
						enabled={systemAudioEnabled}
						disabled={controlsLocked}
						label={
							systemAudioEnabled ? t("audio.disableSystemAudio") : t("audio.enableSystemAudio")
						}
						onClick={toggleSystemAudio}
					/>
					{/* The gear configures the two toggles beside it, so the three sit
					    closer together than the bar's normal control spacing — proximity
					    is the design's own grouping device, no extra furniture needed. */}
					<div
						className={`${styles.hudControlGroup} ${isVertical ? styles.hudControlGroupVertical : ""}`}
					>
						<HudMicButton
							enabled={microphoneEnabled}
							disabled={controlsLocked}
							label={microphoneEnabled ? t("audio.disableMicrophone") : t("audio.enableMicrophone")}
							onClick={toggleMicrophone}
						/>
						<HudCameraButton
							enabled={webcamEnabled}
							disabled={controlsLocked}
							label={webcamEnabled ? t("webcam.disableWebcam") : t("webcam.enableWebcam")}
							onClick={toggleWebcam}
						/>
						<HudSettingsButton
							buttonRef={settingsTriggerRef}
							disabled={controlsLocked}
							expanded={isDeviceSettingsOpen}
							label={t("deviceSettings.title")}
							onClick={toggleDeviceSettings}
						/>
					</div>
					{supportsCursorModeToggle && (
						<HudCursorButton
							editableOverlay={cursorCaptureMode === "editable-overlay"}
							disabled={controlsLocked}
							label={
								cursorCaptureMode === "editable-overlay"
									? t("cursor.useSystemCursor")
									: t("cursor.useEditableCursor")
							}
							onClick={toggleCursorMode}
						/>
					)}

					<HudDivider vertical={isVertical} />

					<HudRecordButton
						recording={recording}
						paused={paused}
						saving={saving}
						elapsedSeconds={elapsedSeconds}
						label={recordLabel}
						savingLabel={t("recording.saving")}
						onClick={handleRecordClick}
					/>

					{!recording && (
						<HudStudioButton
							disabled={saving}
							label={t("tooltips.openStudio")}
							onClick={openStudio}
						/>
					)}

					{recording && (
						<HudRecordingControls
							vertical={isVertical}
							paused={paused}
							saving={saving}
							canPause={canPauseRecording}
							pauseLabel={paused ? t("tooltips.resumeRecording") : t("tooltips.pauseRecording")}
							restartLabel={t("tooltips.restartRecording")}
							cancelLabel={t("tooltips.cancelRecording")}
							onTogglePause={togglePaused}
							onRestart={restartRecording}
							onCancel={cancelRecording}
						/>
					)}

					{!isLinuxHud && (
						<HudNotesButton disabled={saving} label={t("tooltips.openNotes")} onClick={openNotes} />
					)}

					<HudDivider vertical={isVertical} />

					{/* Right sidebar controls */}
					<div
						className={`flex items-center gap-[5px] ${isVertical ? "flex-col" : ""} ${styles.electronNoDrag}`}
					>
						<HudLanguageButton
							buttonRef={languageTriggerRef}
							vertical={isVertical}
							code={languageCode}
							label={activeLanguageLabel}
							disabled={saving}
							expanded={isLanguageMenuOpen}
							onClick={toggleLanguageMenu}
						/>

						<HudDivider vertical={isVertical} />

						<HudWindowControls
							vertical={isVertical}
							disabled={saving}
							hideLabel={t("tooltips.hideHUD")}
							closeLabel={t("tooltips.closeApp")}
							onHide={sendHudOverlayHide}
							onClose={sendHudOverlayClose}
						/>
					</div>
				</div>

				{(isPopoverOpen || hasNotices) && (
					// column-reverse: first child sits closest to the bar.
					<div className={styles.hudAbove}>
						{isDeviceSettingsOpen && (
							<HudDeviceSettings
								micDevices={micDevices}
								cameraDevices={cameraDevices}
								activeMicId={microphoneDeviceId || selectedMicId}
								activeCameraId={webcamDeviceId || selectedCameraId}
								cameraLoading={isCameraDevicesLoading}
								cameraError={cameraDevicesError}
								labels={deviceSettingsLabels}
								versionLabel={versionLabel}
								// `canCheckForUpdates` is the install channel's answer, fixed for the
								// process. The recording veto is applied here because the gear is
								// disabled mid-take but a panel already open stays mounted, and the
								// main process refuses the check then — an offered button would be dead.
								canCheckForUpdates={(appInfo?.canCheckForUpdates ?? false) && !recording}
								checkingForUpdates={isCheckingForUpdates}
								onSelectMic={handleSelectMicDevice}
								onSelectCamera={handleSelectCameraDevice}
								onCheckForUpdates={handleCheckForUpdates}
								onClose={closeDeviceSettings}
								panelRef={setPopoverEl}
							/>
						)}

						{isLanguageMenuOpen && (
							<HudLanguageMenu
								locales={AVAILABLE_LOCALES}
								activeLocale={locale}
								getName={getLocaleName as (loc: string) => string}
								onSelect={handleSelectLocale}
								panelRef={setPopoverEl}
								onEnsureInteractive={enableHudMouseEvents}
							/>
						)}

						{hasNotices && (
							<div
								ref={setHudNoticesEl}
								data-testid="hud-notice-column"
								className={styles.hudNoticeColumn}
							>
								{systemLocaleSuggestion && (
									<HudNotice
										title={t("systemLanguagePrompt.title")}
										description={t("systemLanguagePrompt.description", {
											language: suggestedLanguageName,
										})}
										dismissLabel={t("systemLanguagePrompt.keepDefault")}
										confirmLabel={t("systemLanguagePrompt.switch", {
											language: suggestedLanguageName,
										})}
										onDismiss={dismissSystemLocaleSuggestion}
										onConfirm={acceptSystemLocaleSuggestion}
									/>
								)}

								{softwareEncoderFallbackNoticeVisible && (
									<HudNotice
										title={t("softwareEncoderFallback.title")}
										description={t("softwareEncoderFallback.description")}
										dismissLabel={t("softwareEncoderFallback.dontShowAgain")}
										confirmLabel={t("softwareEncoderFallback.dismiss")}
										onDismiss={dismissSoftwareFallbackForever}
										onConfirm={dismissSoftwareFallbackOnce}
									/>
								)}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
