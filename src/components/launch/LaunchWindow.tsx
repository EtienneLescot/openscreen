import { Check, Languages, Loader2, NotepadText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BsPauseCircle, BsPlayCircle } from "react-icons/bs";
import { FaFolderOpen } from "react-icons/fa6";
import { FiMinus, FiX } from "react-icons/fi";
import { MdCancel, MdRestartAlt, MdVideoFile } from "react-icons/md";
import { RxDragHandleDots2 } from "react-icons/rx";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { getAvailableLocales, getLocaleName } from "@/i18n/loader";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import { nativeBridgeClient } from "@/native";
import { useCameraDevices } from "../../hooks/useCameraDevices";
import { useMicrophoneDevices } from "../../hooks/useMicrophoneDevices";
import { useScreenRecorder } from "../../hooks/useScreenRecorder";
import { requestCameraAccess } from "../../lib/requestCameraAccess";
import { formatTimePadded } from "../../utils/timeUtils";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import styles from "./LaunchWindow.module.css";
import { openSourceSelectorWithPermissionRetry } from "./openSourceSelectorFlow";

const ICON_SIZE = 20;

// Vertical tray gap (px): bar's `bottom-5` (20px) plus an 8px gap.
const HUD_DEVICE_POPUP_GAP = 28;
// Horizontal layout: mirrors the `bottom-[68px]` class on the popup element.
const HUD_DEVICE_POPUP_HORIZONTAL_BOTTOM = 68;
// Cap on the language list's own height so it doesn't stretch to fill the whole
// screen above the widget -- it should size to its content, like the other popovers.
const LANGUAGE_MENU_MAX_HEIGHT = 320;

const ICON_CONFIG = {
	drag: { icon: RxDragHandleDots2, size: ICON_SIZE },
	pause: { icon: BsPauseCircle, size: ICON_SIZE },
	resume: { icon: BsPlayCircle, size: ICON_SIZE },
	restart: { icon: MdRestartAlt, size: ICON_SIZE },
	cancel: { icon: MdCancel, size: ICON_SIZE },
	videoFile: { icon: MdVideoFile, size: ICON_SIZE },
	folder: { icon: FaFolderOpen, size: ICON_SIZE },
	minimize: { icon: FiMinus, size: ICON_SIZE },
	close: { icon: FiX, size: ICON_SIZE },
	spinner: { icon: Loader2, size: ICON_SIZE },
} as const;

type IconName = keyof typeof ICON_CONFIG;

/** Renders the configured icon for a HUD control. */
function getIcon(name: IconName, className?: string) {
	const { icon: Icon, size } = ICON_CONFIG[name];
	return <Icon size={size} className={className} />;
}

// Custom glyphs matching the Claude Design "OpenScreen Recording Widget"
// spec exactly (source/audio/mic/camera/cursor/record) — these are the
// controls most visible in the collapsed toolbar, so the design's own paths
// are used verbatim rather than the closest lucide/react-icons stand-in.
const HUD_SVG_PROPS = {
	width: ICON_SIZE,
	height: ICON_SIZE,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.6,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

function OrientationIcon({ vertical, className }: { vertical: boolean; className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			{vertical ? (
				<>
					<rect x="3" y="7" width="18" height="10" rx="3" />
					<path d="M12 7v10" />
				</>
			) : (
				<>
					<rect x="7" y="3" width="10" height="18" rx="3" />
					<path d="M7 12h10" />
				</>
			)}
		</svg>
	);
}

function SourceIcon({ className }: { className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<rect x="2.5" y="4.5" width="19" height="13" rx="2.2" />
			<path d="M8.5 21h7M12 17.5v3.3" />
		</svg>
	);
}

function VolumeIcon({ muted, className }: { muted: boolean; className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<path
				d="M10.2 5.6 5.6 9H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2.6l4.6 3.4a.6.6 0 0 0 1-.48V6.08a.6.6 0 0 0-1-.48Z"
				fill="currentColor"
				stroke="none"
			/>
			{muted ? (
				<path d="M15.2 9.3 19.4 14.7M19.4 9.3l-4.2 5.4" />
			) : (
				<>
					<path d="M15.5 8.5a5 5 0 0 1 0 7" />
					<path d="M18 6a9 9 0 0 1 0 12" />
				</>
			)}
		</svg>
	);
}

function MicIcon({ muted, className }: { muted: boolean; className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<rect x="9" y="3" width="6" height="11" rx="3" />
			<path d="M18.5 11a6.5 6.5 0 0 1-13 0" />
			<path d="M12 17.5v3" />
			{muted ? <path d="M4 4l16 16" /> : null}
		</svg>
	);
}

function CameraIcon({ off, className }: { off: boolean; className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<rect x="3" y="6.5" width="13" height="11" rx="2.4" />
			<path d="M16 10.3 21 7v10l-5-3.3" />
			{off ? <path d="M4 4l16 16" /> : null}
		</svg>
	);
}

function CursorIcon({ className }: { className?: string }) {
	return (
		<svg
			width={ICON_SIZE}
			height={ICON_SIZE}
			viewBox="0 0 24 24"
			fill="currentColor"
			stroke="none"
			className={className}
			aria-hidden="true"
		>
			<path d="M6.7 3.3 6.7 18.3 10.3 14.8 12.7 20.7 15.1 19.7 12.7 13.8 17.3 13.8Z" />
		</svg>
	);
}

function RecordGlyph({ recording, className }: { recording: boolean; className?: string }) {
	return (
		<svg
			width={ICON_SIZE}
			height={ICON_SIZE}
			viewBox="0 0 24 24"
			className={className}
			aria-hidden="true"
		>
			{recording ? (
				<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" />
			) : (
				<circle cx="12" cy="12" r="7.5" fill="currentColor" />
			)}
		</svg>
	);
}

function OpenInEditorIcon({ className }: { className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
			<path d="m6.2 5.3 3.1 5.4" />
			<path d="m12.4 3.4 3.1 5.4" />
			<path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
		</svg>
	);
}

const hudDisabledClasses =
	"disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none";

// Exact values from the design's renderVals() (comfortable density, rounded
// shape, #10b981 accent) — btnSize 34 / btnRadius 10 / containerRadius 17
// (btnRadius + padY) / dividerLen 22. Every control is its own standalone
// transparent icon button (no shared "group" pill background) — grouping
// reads purely from proximity + the divider spans between logical sections.
const hudIconBtnClasses = `flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent cursor-pointer text-[#828c99] transition-all duration-150 hover:bg-[#1a1e25] hover:text-[#f5f7fa] active:scale-95 ${hudDisabledClasses}`;

const hudAuxIconBtnClasses = `flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent cursor-pointer text-[#828c99] transition-colors duration-150 hover:bg-[#1a1e25] hover:text-[#f5f7fa] ${hudDisabledClasses}`;

const windowBtnClasses = `flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border-0 bg-transparent cursor-pointer text-[#828c99] transition-all duration-150 hover:bg-[#1a1e25] hover:text-[#e9edf3] ${hudDisabledClasses}`;

const closeBtnClasses = `flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border-0 bg-transparent cursor-pointer text-[#828c99] transition-all duration-150 hover:bg-[rgba(248,113,113,0.16)] hover:text-[#f87171] ${hudDisabledClasses}`;

const hudSidebarClasses = "flex items-center gap-[5px]";
const hudSidebarVerticalClasses = "flex flex-col items-center gap-[5px]";

/** Launches the floating recording HUD and its recorder controls. */
export function LaunchWindow() {
	const t = useScopedT("launch");
	const availableLocales = getAvailableLocales();
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

	// Device-picker popovers (mic / camera only — system audio has no device
	// list to pick from, so it's a plain direct toggle) are click-to-open,
	// mutually exclusive with each other and with the language menu. Unlike
	// the design's mockup, picking a device IS the activation step and
	// re-clicking an already-enabled icon disables it directly — no separate
	// "turn on" popover step, since that was a redundant extra click.
	const [activeDeviceMenu, setActiveDeviceMenu] = useState<"mic" | "camera" | null>(null);
	const micTriggerRef = useRef<HTMLButtonElement | null>(null);
	const camTriggerRef = useRef<HTMLButtonElement | null>(null);
	const deviceMenuTriggerRefsRef = useRef({
		mic: micTriggerRef,
		camera: camTriggerRef,
	});
	const deviceMenuTriggerRefs = deviceMenuTriggerRefsRef.current;
	const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
	const [trayLayout, setTrayLayout] = useState<"horizontal" | "vertical">(
		() => loadUserPreferences().trayLayout,
	);
	const [supportsCursorModeToggle, setSupportsCursorModeToggle] = useState(false);
	const [isLinuxHud, setIsLinuxHud] = useState(false);
	const languageTriggerRef = useRef<HTMLButtonElement | null>(null);
	const languageMenuPanelRef = useRef<HTMLDivElement | null>(null);
	const hudBarRef = useRef<HTMLDivElement | null>(null);
	const deviceSelectorRef = useRef<HTMLDivElement | null>(null);
	const systemLocalePromptRef = useRef<HTMLDivElement | null>(null);
	const softwareFallbackNoticeRef = useRef<HTMLDivElement | null>(null);
	// Measured bar height, anchors the popups above the tall vertical tray so they don't overlap it.
	const [hudBarHeight, setHudBarHeight] = useState(0);
	const [languageMenuStyle, setLanguageMenuStyle] = useState<{
		right: number;
		bottom: number;
		maxHeight: number;
	}>({
		right: 12,
		bottom: 12,
		maxHeight: LANGUAGE_MENU_MAX_HEIGHT,
	});

	// These hooks only enumerate devices while their `enabled` arg is true, but the
	// device-picker popover now opens precisely while the mic/camera is OFF (picking
	// a device is what turns it on) -- so it must also enumerate while its own menu
	// is open, or the picker would always render empty.
	const {
		devices: micDevices,
		selectedDeviceId: selectedMicId,
		setSelectedDeviceId: setSelectedMicId,
	} = useMicrophoneDevices(microphoneEnabled || activeDeviceMenu === "mic");
	const {
		devices: cameraDevices,
		selectedDeviceId: selectedCameraId,
		setSelectedDeviceId: setSelectedCameraId,
		isLoading: isCameraDevicesLoading,
		error: cameraDevicesError,
	} = useCameraDevices(webcamEnabled || activeDeviceMenu === "camera");

	useEffect(() => {
		if (selectedMicId && selectedMicId !== "default") {
			setMicrophoneDeviceId(selectedMicId);
			setMicrophoneDeviceName(micDevices.find((d) => d.deviceId === selectedMicId)?.label);
		}
	}, [selectedMicId, micDevices, setMicrophoneDeviceId, setMicrophoneDeviceName]);

	useEffect(() => {
		if (selectedCameraId) {
			setWebcamDeviceId(selectedCameraId);
			setWebcamDeviceName(cameraDevices.find((d) => d.deviceId === selectedCameraId)?.label);
		}
	}, [selectedCameraId, cameraDevices, setWebcamDeviceId, setWebcamDeviceName]);

	useEffect(() => {
		let cancelled = false;
		nativeBridgeClient.system
			.getPlatform()
			.then((platform) => {
				if (!cancelled) {
					setSupportsCursorModeToggle(platform === "win32" || platform === "darwin");
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
		if (!import.meta.env.DEV) {
			return;
		}

		void requestCameraAccess().catch((error) => {
			console.warn("Failed to trigger camera access request during development:", error);
		});
	}, []);

	useEffect(() => {
		if (!isLanguageMenuOpen) return;

		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			const clickedTrigger = languageTriggerRef.current?.contains(target);
			const clickedMenu = languageMenuPanelRef.current?.contains(target);
			if (!clickedTrigger && !clickedMenu) {
				setIsLanguageMenuOpen(false);
			}
		};

		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setIsLanguageMenuOpen(false);
			}
		};

		window.addEventListener("pointerdown", handlePointerDown);
		window.addEventListener("keydown", handleEscape);

		return () => {
			window.removeEventListener("pointerdown", handlePointerDown);
			window.removeEventListener("keydown", handleEscape);
		};
	}, [isLanguageMenuOpen]);

	useEffect(() => {
		if (!activeDeviceMenu) return;

		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			const clickedTrigger = deviceMenuTriggerRefs[activeDeviceMenu].current?.contains(target);
			const clickedMenu = deviceSelectorRef.current?.contains(target);
			if (!clickedTrigger && !clickedMenu) {
				setActiveDeviceMenu(null);
			}
		};

		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setActiveDeviceMenu(null);
			}
		};

		window.addEventListener("pointerdown", handlePointerDown);
		window.addEventListener("keydown", handleEscape);

		return () => {
			window.removeEventListener("pointerdown", handlePointerDown);
			window.removeEventListener("keydown", handleEscape);
		};
	}, [activeDeviceMenu, deviceMenuTriggerRefs]);

	useEffect(() => {
		if (!isLanguageMenuOpen || !languageTriggerRef.current) return;

		const updatePosition = () => {
			if (!languageTriggerRef.current) return;
			const rect = languageTriggerRef.current.getBoundingClientRect();
			const gap = 8;
			const viewportPadding = 8;
			// Space between the viewport top and the trigger, in case the screen is too
			// short for the full LANGUAGE_MENU_MAX_HEIGHT -- clamp to whatever fits.
			const availableHeight = Math.max(80, rect.top - viewportPadding - gap);

			setLanguageMenuStyle({
				right: Math.max(viewportPadding, window.innerWidth - rect.right),
				bottom: Math.max(viewportPadding, window.innerHeight - rect.top + gap),
				maxHeight: Math.min(LANGUAGE_MENU_MAX_HEIGHT, availableHeight),
			});
		};

		updatePosition();
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);

		return () => {
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [isLanguageMenuOpen]);

	useEffect(() => {
		if (!isLanguageMenuOpen || !languageMenuPanelRef.current) return;
		const id = requestAnimationFrame(() => {
			if (languageMenuPanelRef.current) {
				languageMenuPanelRef.current.scrollTop = 0;
			}
		});
		return () => cancelAnimationFrame(id);
	}, [isLanguageMenuOpen]);

	// Resize the overlay window to fit content, else the taller vertical tray gets clipped
	// and scrolls. Measure from the window's bottom-centre (the anchor the main process
	// preserves) so fixed bottom/centre offsets keep this stable and it doesn't oscillate.
	//
	// Only ever GROWS the window (a high-water mark), reset when the orientation changes.
	// Even with an eased tween, a native OS window resize on every content change (record
	// starting/stopping, a device popover opening, mic/cam toggling) reads as constant
	// jitter -- there's no way to make that many resizes-per-minute look smooth. Since the
	// window is transparent and the bar is centred within it, an oversized window is
	// invisible: once the widest/tallest state for this orientation has been seen, later
	// content changes just reflow inside the already-big-enough window via ordinary CSS
	// (instant, GPU-composited, no native resize at all), and only a genuinely new maximum
	// triggers the animated resize -- rare enough that its motion is acceptable.
	const hudAllocatedSizeRef = useRef({ width: 0, height: 0, orientation: trayLayout });
	const measureHudSize = useCallback(() => {
		const barEl = hudBarRef.current;
		if (!barEl || !window.electronAPI?.setHudOverlaySize) return;

		// Breathing room so the drop shadow isn't clipped. TOP_MARGIN must also exceed the
		// slack in the bar's `max-h: calc(100vh - 2.5rem)` cap (40px reserved - 20px bottom
		// gap = 20px) so the window stays tall enough that the cap never engages and adds a scrollbar.
		const SIDE_MARGIN = 24;
		const TOP_MARGIN = 24;
		// Wide enough that the language menu (11rem) never clips, even when the bar is narrow.
		const MIN_WIDTH = 220;

		const viewportHeight = window.innerHeight;
		const centerX = window.innerWidth / 2;

		// Use natural (scroll) size, not the clipped box: vertical mode's max-h cap is a
		// small-screen fallback, and reading clipped height would pin the window to it.
		// scrollHeight gives full content height; the cap only engages when the main process clamps to screen.
		let topFromBottom = viewportHeight - barEl.getBoundingClientRect().bottom + barEl.scrollHeight;
		let halfWidth = barEl.scrollWidth / 2;

		// Popups drive both dimensions too. Their vertical anchor depends on bar height,
		// which is fed back through React state and lags by a frame, so derive their top
		// edge from the bar's natural height instead of the stale rendered position. Keeps
		// one measurement pass authoritative and avoids a feedback re-measure.
		if (deviceSelectorRef.current) {
			const rect = deviceSelectorRef.current.getBoundingClientRect();
			if (rect.width !== 0 || rect.height !== 0) {
				const popupBottomOffset =
					trayLayout === "vertical"
						? barEl.scrollHeight + HUD_DEVICE_POPUP_GAP
						: HUD_DEVICE_POPUP_HORIZONTAL_BOTTOM;
				topFromBottom = Math.max(topFromBottom, popupBottomOffset + rect.height);
				halfWidth = Math.max(halfWidth, rect.width / 2);
			}
		}

		// The language menu scrolls within available height, so it only influences width.
		// Its presence in the DOM means it's open.
		if (languageMenuPanelRef.current) {
			const rect = languageMenuPanelRef.current.getBoundingClientRect();
			halfWidth = Math.max(halfWidth, centerX - rect.left, rect.right - centerX);
		}

		// Prompt sits at `fixed top-8`; grow the window to fit it so its buttons don't clip (issue #30).
		if (systemLocalePromptRef.current) {
			const rect = systemLocalePromptRef.current.getBoundingClientRect();
			const promptHeight = rect.height || systemLocalePromptRef.current.scrollHeight;
			if (promptHeight > 0) {
				topFromBottom = Math.max(topFromBottom, rect.top + promptHeight);
			}
			halfWidth = Math.max(halfWidth, centerX - rect.left, rect.right - centerX);
		}

		// The software-encoder fallback notice shares the prompt's fixed top-8 slot and needs
		// the same treatment so its buttons stay clickable.
		if (softwareFallbackNoticeRef.current) {
			const rect = softwareFallbackNoticeRef.current.getBoundingClientRect();
			const noticeHeight = rect.height || softwareFallbackNoticeRef.current.scrollHeight;
			if (noticeHeight > 0) {
				topFromBottom = Math.max(topFromBottom, rect.top + noticeHeight);
			}
			halfWidth = Math.max(halfWidth, centerX - rect.left, rect.right - centerX);
		}

		setHudBarHeight((prev) => {
			const next = Math.round(barEl.scrollHeight);
			return Math.abs(prev - next) > 1 ? next : prev;
		});

		const requiredWidth = Math.max(MIN_WIDTH, Math.ceil(halfWidth * 2) + SIDE_MARGIN);
		const requiredHeight = Math.ceil(topFromBottom) + TOP_MARGIN;

		const allocated = hudAllocatedSizeRef.current;
		if (allocated.orientation !== trayLayout) {
			// Different shape entirely (wide-short vs narrow-tall) -- the old high-water
			// mark doesn't apply, start fresh so we don't carry a stale huge footprint
			// from the other orientation.
			allocated.width = 0;
			allocated.height = 0;
			allocated.orientation = trayLayout;
		}

		const width = Math.max(requiredWidth, allocated.width);
		const height = Math.max(requiredHeight, allocated.height);
		if (width === allocated.width && height === allocated.height) {
			return;
		}
		allocated.width = width;
		allocated.height = height;
		window.electronAPI.setHudOverlaySize(width, height);
	}, [trayLayout]);

	// One persistent observer; elements wire themselves up via callback refs as they
	// mount/unmount so measurement re-runs without recreating it or threading mount state through deps.
	const hudResizeObserverRef = useRef<ResizeObserver | null>(null);
	useEffect(() => {
		const observer = new ResizeObserver(() => measureHudSize());
		hudResizeObserverRef.current = observer;
		if (hudBarRef.current) observer.observe(hudBarRef.current);
		if (deviceSelectorRef.current) observer.observe(deviceSelectorRef.current);
		// Backfill refs set before the observer existed (e.g. the prompt or language menu).
		if (systemLocalePromptRef.current) observer.observe(systemLocalePromptRef.current);
		if (softwareFallbackNoticeRef.current) observer.observe(softwareFallbackNoticeRef.current);
		if (languageMenuPanelRef.current) observer.observe(languageMenuPanelRef.current);
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
	const setDeviceSelectorEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, deviceSelectorRef),
		[observeHudElement],
	);
	const setLanguageMenuPanelEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, languageMenuPanelRef),
		[observeHudElement],
	);
	const setSystemLocalePromptEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, systemLocalePromptRef),
		[observeHudElement],
	);
	const setSoftwareFallbackNoticeEl = useCallback(
		(el: HTMLDivElement | null) => observeHudElement(el, softwareFallbackNoticeRef),
		[observeHudElement],
	);

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
			window.electronAPI?.setHudOverlayIgnoreMouseEvents?.(false);
		};
	}, [setHudMouseEventsEnabled]);

	useEffect(() => {
		setHudMouseEventsEnabled(isLanguageMenuOpen);
	}, [isLanguageMenuOpen, setHudMouseEventsEnabled]);

	const defaultSourceName = t("sourceSelector.defaultSourceName");
	const [selectedSource, setSelectedSource] = useState(defaultSourceName);
	const [hasSelectedSource, setHasSelectedSource] = useState(false);
	const [, setRecordPointerDownCount] = useState(0);
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

	useEffect(() => {
		const checkSelectedSource = async () => {
			if (!window.electronAPI) {
				return;
			}

			try {
				const source = await window.electronAPI.getSelectedSource();
				applySelectedSource(source);
			} catch (error) {
				console.warn("Failed to refresh selected source:", error);
			}
		};

		checkSelectedSource();

		const interval = setInterval(checkSelectedSource, 500);
		return () => clearInterval(interval);
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

	const openSourceSelector = async () => {
		if (window.electronAPI) {
			return await openSourceSelectorWithPermissionRetry({
				openSourceSelector: () => window.electronAPI.openSourceSelector(),
				requestScreenAccess: () => window.electronAPI.requestScreenAccess(),
			});
		}

		return { opened: false, reason: "electron-api-unavailable" };
	};

	const handleRecordButtonClick = (sourceSelectedOverride?: boolean) => {
		if (saving) {
			return;
		}
		const sourceSelected = sourceSelectedOverride ?? hasSelectedSource;
		if (!sourceSelected && !recording) {
			recordAfterSourceSelectionRef.current = true;
			void openSourceSelector()
				.then((result) => {
					if (!result.opened) {
						recordAfterSourceSelectionRef.current = false;
					}
				})
				.catch(() => {
					recordAfterSourceSelectionRef.current = false;
				});
			return;
		}

		toggleRecording();
	};

	// The editor's Rec-mode stage sends this once it hands off to the HUD
	// (source + prefs already persisted via IPC), so the user doesn't have to
	// click Record a second time after "Start recording" reopens this window.
	// The auto-start signal can arrive before this window's own
	// `checkSelectedSource` poll (above) has resolved its first round-trip, so
	// `hasSelectedSource` may still be stale — fetch a fresh value here instead
	// of trusting it, otherwise auto-start can wrongly fall through to opening
	// the source selector instead of actually starting the recording.
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

	const sendHudOverlayHide = () => {
		if (window.electronAPI && window.electronAPI.hudOverlayHide) {
			window.electronAPI.hudOverlayHide();
		}
	};
	const sendHudOverlayClose = () => {
		if (window.electronAPI && window.electronAPI.hudOverlayClose) {
			window.electronAPI.hudOverlayClose();
		}
	};
	/** Switches the HUD between horizontal and vertical tray layouts. */
	const toggleTrayLayout = () => {
		const nextLayout = trayLayout === "horizontal" ? "vertical" : "horizontal";
		setTrayLayout(nextLayout);
		saveUserPreferences({ trayLayout: nextLayout });
	};

	const toggleMicrophone = () => {
		if (!recording && !saving) {
			setMicrophoneEnabled(!microphoneEnabled);
		}
	};
	const dragLastPositionRef = useRef<{ x: number; y: number } | null>(null);
	const dragAnimationFrameRef = useRef<number | null>(null);
	const pendingDragDeltaRef = useRef({ x: 0, y: 0 });
	const flushHudDragMove = useCallback(() => {
		dragAnimationFrameRef.current = null;
		const { x, y } = pendingDragDeltaRef.current;
		pendingDragDeltaRef.current = { x: 0, y: 0 };
		if (x === 0 && y === 0) return;
		window.electronAPI?.moveHudOverlayBy?.(x, y);
	}, []);
	const scheduleHudDragMove = useCallback(
		(deltaX: number, deltaY: number) => {
			pendingDragDeltaRef.current = {
				x: pendingDragDeltaRef.current.x + deltaX,
				y: pendingDragDeltaRef.current.y + deltaY,
			};

			if (dragAnimationFrameRef.current === null) {
				dragAnimationFrameRef.current = window.requestAnimationFrame(flushHudDragMove);
			}
		},
		[flushHudDragMove],
	);
	const flushPendingHudDragMove = useCallback(() => {
		if (dragAnimationFrameRef.current !== null) {
			window.cancelAnimationFrame(dragAnimationFrameRef.current);
			dragAnimationFrameRef.current = null;
		}
		const { x, y } = pendingDragDeltaRef.current;
		pendingDragDeltaRef.current = { x: 0, y: 0 };
		if (x === 0 && y === 0) return;
		window.electronAPI?.moveHudOverlayBy?.(x, y);
	}, []);
	useEffect(() => {
		return () => {
			if (dragAnimationFrameRef.current !== null) {
				window.cancelAnimationFrame(dragAnimationFrameRef.current);
			}
		};
	}, []);
	const handleHudDragPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		event.stopPropagation();
		setHudMouseEventsEnabled(true);
		event.currentTarget.setPointerCapture(event.pointerId);
		dragLastPositionRef.current = { x: event.screenX, y: event.screenY };
	};
	const handleHudDragPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const lastPosition = dragLastPositionRef.current;
		if (!lastPosition) return;
		const deltaX = event.screenX - lastPosition.x;
		const deltaY = event.screenY - lastPosition.y;
		dragLastPositionRef.current = { x: event.screenX, y: event.screenY };
		scheduleHudDragMove(deltaX, deltaY);
	};
	const handleHudDragPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
		dragLastPositionRef.current = null;
		flushPendingHudDragMove();
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		setHudMouseEventsEnabled(false);
	};

	return (
		// Avoid w-screen/h-screen: 100vw can exceed the inner layout width when scrollbars
		// affect the viewport (Windows), causing a horizontal scrollbar (issue #305).
		<div
			className={`h-full w-full min-w-0 max-w-full overflow-x-hidden overflow-y-hidden bg-transparent ${styles.electronDrag}`}
			onPointerMove={(event) => {
				const target = event.target as HTMLElement | null;
				const shouldCapture =
					isLanguageMenuOpen || Boolean(target?.closest("[data-hud-interactive='true']"));
				setHudMouseEventsEnabled(shouldCapture);
			}}
			onPointerLeave={() => {
				if (!isLanguageMenuOpen) {
					setHudMouseEventsEnabled(false);
				}
			}}
		>
			{/* Top-center notices share one fixed column so they stack instead of overlapping */}
			{(systemLocaleSuggestion || softwareEncoderFallbackNoticeVisible) && (
				<div className="fixed top-8 left-1/2 z-30 flex w-[calc(100vw-1rem)] max-w-[520px] -translate-x-1/2 flex-col gap-2">
					{systemLocaleSuggestion && (
						<div
							ref={setSystemLocalePromptEl}
							data-hud-interactive="true"
							className={`w-full rounded-xl border border-white/15 bg-[rgba(20,20,28,0.95)] p-3 shadow-2xl backdrop-blur-xl text-white animate-in fade-in-0 zoom-in-95 duration-200 ${styles.electronNoDrag}`}
						>
							<div className="text-[13px] font-semibold text-white">
								{t("systemLanguagePrompt.title")}
							</div>
							<div className="mt-1 text-[11px] leading-relaxed text-white/75">
								{t("systemLanguagePrompt.description", {
									language: suggestedLanguageName,
								})}
							</div>
							<div className="mt-3 flex items-center justify-end gap-2">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={dismissSystemLocaleSuggestion}
									className="h-7 text-xs text-white/80 hover:bg-white/10 hover:text-white"
								>
									{t("systemLanguagePrompt.keepDefault")}
								</Button>
								<Button
									type="button"
									size="sm"
									onClick={acceptSystemLocaleSuggestion}
									className="h-7 text-xs bg-white text-[#10121b] hover:bg-white/90"
								>
									{t("systemLanguagePrompt.switch", {
										language: suggestedLanguageName,
									})}
								</Button>
							</div>
						</div>
					)}

					{softwareEncoderFallbackNoticeVisible && (
						<div
							ref={setSoftwareFallbackNoticeEl}
							data-hud-interactive="true"
							className={`w-full rounded-xl border border-white/15 bg-[rgba(20,20,28,0.95)] p-3 shadow-2xl backdrop-blur-xl text-white animate-in fade-in-0 zoom-in-95 duration-200 ${styles.electronNoDrag}`}
						>
							<div className="text-[13px] font-semibold text-white">
								{t("softwareEncoderFallback.title")}
							</div>
							<div className="mt-1 text-[11px] leading-relaxed text-white/75">
								{t("softwareEncoderFallback.description")}
							</div>
							<div className="mt-3 flex items-center justify-end gap-2">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => dismissSoftwareEncoderFallbackNotice(true)}
									className="h-7 text-xs text-white/80 hover:bg-white/10 hover:text-white"
								>
									{t("softwareEncoderFallback.dontShowAgain")}
								</Button>
								<Button
									type="button"
									size="sm"
									onClick={() => dismissSoftwareEncoderFallbackNotice()}
									className="h-7 text-xs bg-white text-[#10121b] hover:bg-white/90"
								>
									{t("softwareEncoderFallback.dismiss")}
								</Button>
							</div>
						</div>
					)}
				</div>
			)}

			{/* Device pickers: mic / camera only (system audio has no device list,
			    it's a plain toggle). This popover ONLY ever opens while the device
			    is disabled — picking a device turns it on and closes the popover
			    immediately; toggling off happens with a single click on the icon
			    itself (see the trigger buttons below), no popover involved. Fixed
			    above the HUD bar (or beside it in vertical layout), viewport-
			    relative, never clipped -- reuses the same measured-position wiring
			    the old combined mic/webcam panel used (deviceSelectorRef feeds
			    measureHudSize so the overlay window grows to fit whichever popover
			    is open). Only one popover is open at a time (see activeDeviceMenu). */}
			{activeDeviceMenu && (
				<div
					ref={setDeviceSelectorEl}
					data-hud-interactive="true"
					className={`fixed left-1/2 w-[220px] -translate-x-1/2 rounded-[15px] border border-white/10 bg-[#1a1e25] p-1.5 shadow-[0_20px_44px_-14px_rgba(0,0,0,0.6),0_4px_12px_rgba(0,0,0,0.4)] backdrop-blur-2xl animate-mic-panel-in ${trayLayout === "vertical" ? "" : "bottom-[68px]"} ${styles.electronNoDrag}`}
					style={
						trayLayout === "vertical"
							? // Sit above the tall vertical tray, anchored to the measured bar
								// height. Matches the offset in measureHudSize.
								{ bottom: hudBarHeight + HUD_DEVICE_POPUP_GAP }
							: undefined
					}
				>
					{activeDeviceMenu === "mic" && (
						<>
							<div className={styles.hudMenuSectionLabel}>{t("audio.inputDevice")}</div>
							{micDevices.map((device) => {
								const isActive = device.deviceId === (microphoneDeviceId || selectedMicId);
								return (
									<button
										key={device.deviceId}
										type="button"
										role="menuitemradio"
										aria-checked={isActive}
										onClick={() => {
											setSelectedMicId(device.deviceId);
											setMicrophoneDeviceId(device.deviceId);
											setMicrophoneDeviceName(device.label);
											setMicrophoneEnabled(true);
											setActiveDeviceMenu(null);
										}}
										className={`${styles.languageMenuItem} ${isActive ? styles.languageMenuItemActive : ""}`}
									>
										<span className="truncate">{device.label}</span>
										{isActive ? <Check size={11} className="text-white/85" /> : null}
									</button>
								);
							})}
						</>
					)}

					{activeDeviceMenu === "camera" && (
						<>
							<div className={styles.hudMenuSectionLabel}>{t("webcam.cameraDevice")}</div>
							{isCameraDevicesLoading ? (
								<div className="px-2.5 py-2 text-[11px] italic text-white/40">
									{t("webcam.searching")}
								</div>
							) : cameraDevicesError ? (
								<div className="px-2.5 py-2 text-[11px] italic text-white/40">
									{t("webcam.unavailable")}
								</div>
							) : cameraDevices.length === 0 ? (
								<div className="px-2.5 py-2 text-[11px] italic text-white/40">
									{t("webcam.noneFound")}
								</div>
							) : (
								cameraDevices.map((device) => {
									const isActive = device.deviceId === (webcamDeviceId || selectedCameraId);
									return (
										<button
											key={device.deviceId}
											type="button"
											role="menuitemradio"
											aria-checked={isActive}
											onClick={async () => {
												setSelectedCameraId(device.deviceId);
												setWebcamDeviceId(device.deviceId);
												setWebcamDeviceName(device.label);
												await setWebcamEnabled(true);
												setActiveDeviceMenu(null);
											}}
											className={`${styles.languageMenuItem} ${isActive ? styles.languageMenuItemActive : ""}`}
										>
											<span className="truncate">{device.label}</span>
											{isActive ? <Check size={11} className="text-white/85" /> : null}
										</button>
									);
								})
							)}
						</>
					)}
				</div>
			)}

			{/* HUD bar, fixed at bottom center, viewport-relative, never moves */}
			<div
				ref={setHudBarEl}
				data-hud-interactive="true"
				data-tray-layout={trayLayout}
				className={`fixed bottom-5 left-1/2 -translate-x-1/2 flex rounded-[17px] border border-[#242932] bg-[#14171c] shadow-[0_2px_6px_-2px_rgba(0,0,0,0.35)] backdrop-blur-2xl backdrop-saturate-[140%] ${
					trayLayout === "vertical"
						? "max-h-[calc(100vh-2.5rem)] flex-col items-center gap-[5px] overflow-y-auto px-[7px] py-[9px]"
						: "items-center gap-[5px] px-[9px] py-[7px]"
				}`}
				onPointerEnter={() => setHudMouseEventsEnabled(true)}
				onPointerDown={() => setHudMouseEventsEnabled(true)}
				onMouseEnter={() => setHudMouseEventsEnabled(true)}
				onMouseLeave={() => {
					if (!isLanguageMenuOpen) {
						setHudMouseEventsEnabled(false);
					}
				}}
			>
				{/* Drag handle */}
				<div
					className={`flex ${trayLayout === "vertical" ? "h-6 w-8" : "h-8 w-7"} shrink-0 cursor-grab items-center justify-center active:cursor-grabbing ${styles.electronNoDrag}`}
					onPointerDown={handleHudDragPointerDown}
					onPointerMove={handleHudDragPointerMove}
					onPointerUp={handleHudDragPointerEnd}
					onPointerCancel={handleHudDragPointerEnd}
				>
					{getIcon("drag", "text-[#333a45]")}
				</div>

				<span
					className={`${styles.hudDivider} ${trayLayout === "vertical" ? styles.hudDividerVertical : styles.hudDividerHorizontal}`}
					aria-hidden
				/>

				<Tooltip
					content={
						trayLayout === "horizontal"
							? t("tooltips.useVerticalTray")
							: t("tooltips.useHorizontalTray")
					}
				>
					<button
						data-testid="launch-tray-layout-button"
						type="button"
						aria-label={
							trayLayout === "horizontal"
								? t("tooltips.useVerticalTray")
								: t("tooltips.useHorizontalTray")
						}
						aria-pressed={trayLayout === "vertical"}
						className={`${hudIconBtnClasses} ${styles.electronNoDrag}`}
						onClick={toggleTrayLayout}
					>
						<OrientationIcon vertical={trayLayout === "vertical"} />
					</button>
				</Tooltip>

				{/* Source selector — transparent at rest, same hover treatment
				    (background only, no border) as every other toolbar button. */}
				<button
					data-testid="launch-source-selector-button"
					className={`flex h-[34px] shrink-0 items-center gap-[7px] rounded-[10px] border-0 bg-transparent text-[#f5f7fa] transition-all duration-150 hover:bg-[#1a1e25] active:scale-[0.97] ${hudDisabledClasses} ${
						trayLayout === "vertical" ? "w-[34px] justify-center px-0" : "pr-3 pl-2.5"
					} ${styles.electronNoDrag}`}
					onClick={openSourceSelector}
					disabled={recording || saving}
					title={selectedSource}
					aria-label={selectedSource}
				>
					<SourceIcon className="shrink-0" />
					<span
						className={`${trayLayout === "vertical" ? "sr-only" : "max-w-[86px]"} truncate text-[13px] font-medium`}
					>
						{selectedSource}
					</span>
				</button>

				<span
					className={`${styles.hudDivider} ${trayLayout === "vertical" ? styles.hudDividerVertical : styles.hudDividerHorizontal}`}
					aria-hidden
				/>

				{/* System audio / mic / camera / cursor — each its own standalone
				    transparent icon button (no shared group pill), matching the
				    design exactly: rest color is muted gray, active/enabled color
				    is the accent green. */}
				<button
					data-testid="launch-system-audio-button"
					className={`${hudIconBtnClasses} ${styles.electronNoDrag}`}
					onClick={() => !(recording || saving) && setSystemAudioEnabled(!systemAudioEnabled)}
					disabled={recording || saving}
					title={systemAudioEnabled ? t("audio.disableSystemAudio") : t("audio.enableSystemAudio")}
				>
					<VolumeIcon
						muted={!systemAudioEnabled}
						className={systemAudioEnabled ? "text-[#10b981]" : ""}
					/>
				</button>
				<button
					ref={micTriggerRef}
					data-testid="launch-microphone-button"
					className={`${hudIconBtnClasses} ${styles.electronNoDrag}`}
					aria-expanded={activeDeviceMenu === "mic"}
					aria-haspopup={microphoneEnabled ? undefined : "menu"}
					onClick={() => {
						if (recording || saving) return;
						// Already on: a single click just turns it off, no popover.
						// Already off: open the device picker — selecting a device
						// (or the mic already having one) is what turns it on.
						if (microphoneEnabled) {
							toggleMicrophone();
							return;
						}
						setIsLanguageMenuOpen(false);
						setActiveDeviceMenu((prev) => (prev === "mic" ? null : "mic"));
					}}
					disabled={recording || saving}
					title={microphoneEnabled ? t("audio.disableMicrophone") : t("audio.enableMicrophone")}
					onPointerDown={() => {
						setRecordPointerDownCount((count) => count + 1);
					}}
				>
					<MicIcon
						muted={!microphoneEnabled}
						className={microphoneEnabled ? "text-[#10b981]" : ""}
					/>
				</button>
				<button
					ref={camTriggerRef}
					data-testid="launch-webcam-button"
					className={`${hudIconBtnClasses} ${styles.electronNoDrag}`}
					aria-expanded={activeDeviceMenu === "camera"}
					aria-haspopup={webcamEnabled ? undefined : "menu"}
					onClick={() => {
						if (recording || saving) return;
						if (webcamEnabled) {
							void setWebcamEnabled(false);
							return;
						}
						setIsLanguageMenuOpen(false);
						setActiveDeviceMenu((prev) => (prev === "camera" ? null : "camera"));
					}}
					disabled={recording || saving}
					title={webcamEnabled ? t("webcam.disableWebcam") : t("webcam.enableWebcam")}
				>
					<CameraIcon off={!webcamEnabled} className={webcamEnabled ? "text-[#10b981]" : ""} />
				</button>
				{supportsCursorModeToggle && (
					<button
						data-testid="launch-cursor-mode-button"
						className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border-0 cursor-pointer transition-all duration-150 active:scale-95 ${hudDisabledClasses} ${styles.electronNoDrag} ${
							cursorCaptureMode === "editable-overlay"
								? "bg-[#10b981] text-[#08090d] hover:bg-[#0e9e6e]"
								: "bg-transparent text-[#828c99] hover:bg-[#1a1e25] hover:text-[#f5f7fa]"
						}`}
						onClick={() =>
							!(recording || saving) &&
							setCursorCaptureMode(
								cursorCaptureMode === "editable-overlay" ? "system" : "editable-overlay",
							)
						}
						disabled={recording || saving}
						title={
							cursorCaptureMode === "editable-overlay"
								? t("cursor.useSystemCursor")
								: t("cursor.useEditableCursor")
						}
					>
						<CursorIcon />
					</button>
				)}

				<span
					className={`${styles.hudDivider} ${trayLayout === "vertical" ? styles.hudDividerVertical : styles.hudDividerHorizontal}`}
					aria-hidden
				/>

				{/* Record/Stop group */}
				<Tooltip
					content={
						saving
							? t("recording.saving")
							: hasSelectedSource || recording
								? selectedSource
								: t("recording.selectSource")
					}
				>
					<button
						data-testid="launch-record-button"
						disabled={saving}
						className={`flex h-[34px] shrink-0 items-center justify-center rounded-[17px] border-0 transition-all duration-150 ${recording || saving ? "min-w-[78px] px-3" : "w-[34px]"} ${styles.electronNoDrag} ${
							saving
								? "bg-transparent opacity-60 cursor-not-allowed"
								: "bg-transparent hover:bg-[rgba(248,113,113,0.16)]"
						}`}
						onClick={() => handleRecordButtonClick()}
						title={
							saving
								? t("recording.saving")
								: hasSelectedSource || recording
									? selectedSource
									: t("recording.selectSource")
						}
						aria-label={
							saving
								? t("recording.saving")
								: hasSelectedSource || recording
									? selectedSource
									: t("recording.selectSource")
						}
						style={{ flex: "0 0 auto" }}
					>
						<div
							className={`flex items-center justify-center ${recording || saving ? "gap-1.5" : ""}`}
						>
							{saving ? (
								<div className="animate-spin flex items-center justify-center">
									{getIcon("spinner", "text-[#f87171]")}
								</div>
							) : (
								<RecordGlyph
									recording={recording}
									className={paused ? "text-amber-400" : "text-[#f87171]"}
								/>
							)}
							{saving && (
								<span className="text-[#f87171] text-xs font-semibold select-none">
									{t("recording.saving")}
								</span>
							)}
							{recording && (
								<span
									className={`${paused ? "text-amber-400" : "text-[#f87171]"} inline-block w-[34px] text-left text-xs font-semibold tabular-nums`}
								>
									{formatTimePadded(elapsedSeconds)}
								</span>
							)}
						</div>
					</button>
				</Tooltip>

				{!recording && (
					<Tooltip content={t("tooltips.openStudio")}>
						<button
							data-testid="launch-open-studio-button"
							disabled={saving}
							className={`${hudIconBtnClasses} ${styles.electronNoDrag} ${saving ? "opacity-30 cursor-not-allowed pointer-events-none" : ""}`}
							onClick={() => !saving && window.electronAPI.switchToEditor()}
						>
							<OpenInEditorIcon />
						</button>
					</Tooltip>
				)}

				{recording && (
					<div
						className={`flex items-center gap-0.5 ${trayLayout === "vertical" ? "flex-col" : ""} ${styles.electronNoDrag}`}
					>
						{canPauseRecording && (
							<Tooltip
								content={paused ? t("tooltips.resumeRecording") : t("tooltips.pauseRecording")}
							>
								<button
									className={hudAuxIconBtnClasses}
									onClick={() => !saving && togglePaused()}
									disabled={saving}
								>
									{getIcon(
										paused ? "resume" : "pause",
										paused ? "text-amber-400" : "text-white/60",
									)}
								</button>
							</Tooltip>
						)}
						<Tooltip content={t("tooltips.restartRecording")}>
							<button
								className={hudAuxIconBtnClasses}
								onClick={() => !saving && restartRecording()}
								disabled={saving}
							>
								{getIcon("restart", "text-white/60")}
							</button>
						</Tooltip>
						<Tooltip content={t("tooltips.cancelRecording")}>
							<button
								className={hudAuxIconBtnClasses}
								onClick={() => !saving && cancelRecording()}
								disabled={saving}
							>
								{getIcon("cancel", "text-white/60")}
							</button>
						</Tooltip>
					</div>
				)}

				{!isLinuxHud && (
					<Tooltip content={t("tooltips.openNotes")}>
						<button
							type="button"
							aria-label={t("tooltips.openNotes")}
							disabled={saving}
							className={`${hudIconBtnClasses} ${styles.electronNoDrag} ${saving ? "opacity-30 cursor-not-allowed pointer-events-none" : ""}`}
							onClick={() => !saving && window.electronAPI.openNotes()}
						>
							<NotepadText size={ICON_SIZE} />
						</button>
					</Tooltip>
				)}

				<span
					className={`${styles.hudDivider} ${trayLayout === "vertical" ? styles.hudDividerVertical : styles.hudDividerHorizontal}`}
					aria-hidden
				/>

				{/* Right sidebar controls */}
				<div
					className={`${trayLayout === "vertical" ? hudSidebarVerticalClasses : hudSidebarClasses} ${styles.electronNoDrag}`}
				>
					<div className={`${styles.languageMenuContainer} ${styles.electronNoDrag}`}>
						<button
							ref={languageTriggerRef}
							type="button"
							aria-label={activeLanguageLabel}
							aria-expanded={isLanguageMenuOpen}
							aria-haspopup="menu"
							disabled={saving}
							onClick={() => {
								if (saving) return;
								setActiveDeviceMenu(null);
								setIsLanguageMenuOpen((open) => !open);
							}}
							title={activeLanguageLabel}
							className={`flex h-[34px] items-center rounded-[10px] border-0 bg-transparent text-[#828c99] transition-all duration-150 hover:bg-[#1a1e25] hover:text-[#e9edf3] ${
								trayLayout === "vertical" ? "w-[34px] justify-center px-0" : "gap-1.5 px-2.5"
							} ${styles.electronNoDrag} ${saving ? "opacity-30 cursor-not-allowed pointer-events-none" : ""}`}
						>
							<Languages size={16} className="shrink-0" />
							<span
								className={`${trayLayout === "vertical" ? "sr-only" : ""} font-mono text-[11px] font-semibold tracking-wide text-[#f5f7fa]`}
							>
								{languageCode}
							</span>
						</button>
					</div>

					{isLanguageMenuOpen
						? createPortal(
								<div
									ref={setLanguageMenuPanelEl}
									data-hud-interactive="true"
									role="menu"
									className={`${styles.languageMenuPanel} ${styles.languageMenuScroll} ${styles.electronNoDrag}`}
									style={
										{
											WebkitAppRegion: "no-drag",
											pointerEvents: "auto",
											right: `${languageMenuStyle.right}px`,
											bottom: `${languageMenuStyle.bottom}px`,
											maxHeight: `${languageMenuStyle.maxHeight}px`,
										} as React.CSSProperties
									}
									onPointerDown={(event) => event.stopPropagation()}
									onPointerEnter={() => setHudMouseEventsEnabled(true)}
									onPointerMove={() => setHudMouseEventsEnabled(true)}
									onWheel={(event) => {
										setHudMouseEventsEnabled(true);
										event.stopPropagation();
									}}
								>
									{availableLocales.map((loc) => (
										<button
											key={loc}
											type="button"
											role="menuitemradio"
											aria-checked={loc === locale}
											onClick={() => {
												setLocale(loc);
												resolveSystemLocaleSuggestion();
												setIsLanguageMenuOpen(false);
											}}
											className={`${styles.languageMenuItem} ${loc === locale ? styles.languageMenuItemActive : ""}`}
										>
											<span className="truncate">{getLocaleName(loc)}</span>
											{loc === locale ? <Check size={11} className="text-white/85" /> : null}
										</button>
									))}
								</div>,
								document.body,
							)
						: null}

					<span
						className={`${styles.hudDivider} ${trayLayout === "vertical" ? styles.hudDividerVertical : styles.hudDividerHorizontal}`}
						aria-hidden
					/>

					{/* Window controls */}
					<div
						className={`flex items-center gap-[5px] ${trayLayout === "vertical" ? "flex-col" : ""}`}
					>
						<button
							className={windowBtnClasses}
							title={t("tooltips.hideHUD")}
							onClick={sendHudOverlayHide}
							disabled={saving}
						>
							{getIcon("minimize")}
						</button>
						<button
							className={closeBtnClasses}
							title={t("tooltips.closeApp")}
							onClick={sendHudOverlayClose}
							disabled={saving}
						>
							{getIcon("close")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
