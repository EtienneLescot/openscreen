import { Check, Languages, NotepadText, Settings } from "lucide-react";
import { memo } from "react";
import { formatTimePadded } from "../../utils/timeUtils";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import {
	CameraIcon,
	CursorIcon,
	getIcon,
	ICON_SIZE,
	MicIcon,
	OpenInEditorIcon,
	OrientationIcon,
	RecordGlyph,
	SourceIcon,
	VolumeIcon,
} from "./HudIcons";
import styles from "./LaunchWindow.module.css";

// Every control below is a `memo` boundary on purpose. The HUD's root re-renders
// once a second for the whole duration of a recording (the elapsed-time counter),
// and without these boundaries each of those ticks rebuilt ~10 Radix tooltip trees
// and ~60 host elements. Props are kept primitive (or stable refs/callbacks from
// the parent) so the boundaries actually hold.

const hudDisabledClasses =
	"disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none";

// Exact values from the design's renderVals() (comfortable density, rounded
// shape, #10b981 accent) — btnSize 34 / btnRadius 10 / containerRadius 17
// (btnRadius + padY) / dividerLen 22. Every control is its own standalone
// transparent icon button (no shared "group" pill background) — grouping
// reads purely from proximity + the divider spans between logical sections.
const hudIconBtnClasses = `flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent cursor-pointer text-[#828c99] transition-all duration-150 hover:bg-[#1a1e25] hover:text-[#f5f7fa] active:scale-95 ${hudDisabledClasses} ${styles.electronNoDrag}`;

const hudAuxIconBtnClasses = `flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent cursor-pointer text-[#828c99] transition-colors duration-150 hover:bg-[#1a1e25] hover:text-[#f5f7fa] ${hudDisabledClasses}`;

const windowBtnClasses = `flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border-0 bg-transparent cursor-pointer text-[#828c99] transition-all duration-150 hover:bg-[#1a1e25] hover:text-[#e9edf3] ${hudDisabledClasses}`;

const closeBtnClasses = `flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border-0 bg-transparent cursor-pointer text-[#828c99] transition-all duration-150 hover:bg-[rgba(248,113,113,0.16)] hover:text-[#f87171] ${hudDisabledClasses}`;

export const HudDivider = memo(function HudDivider({ vertical }: { vertical: boolean }) {
	return (
		<span
			className={`${styles.hudDivider} ${vertical ? styles.hudDividerVertical : styles.hudDividerHorizontal}`}
			aria-hidden
		/>
	);
});

export const HudDragHandle = memo(function HudDragHandle({
	vertical,
	nativeDrag,
	onPointerDown,
	onPointerMove,
	onPointerEnd,
}: {
	vertical: boolean;
	/**
	 * Hand the gesture to the compositor instead of the pointer handlers below.
	 *
	 * Wayland forbids a client from reading or setting its own global position:
	 * `getPosition()` answers [0, 0] and `setPosition()` only updates Electron's
	 * own cache, so the origin+delta scheme the handlers implement cannot move
	 * the window there. `-webkit-app-region: drag` is the one path that does —
	 * it routes to `xdg_toplevel.move` and the compositor performs the move.
	 *
	 * A drag region swallows pointer events, so the two are mutually exclusive:
	 * platforms that can position themselves keep the handler path, which gives
	 * finer control and lets the HUD suppress resizes mid-gesture.
	 */
	nativeDrag: boolean;
	onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
	onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
	onPointerEnd: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
	return (
		<div
			data-testid="hud-drag-handle"
			className={`flex ${vertical ? "h-6 w-8" : "h-8 w-7"} shrink-0 cursor-grab items-center justify-center active:cursor-grabbing ${
				nativeDrag ? styles.electronDrag : styles.electronNoDrag
			}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
		>
			{getIcon("drag", "text-[#333a45]")}
		</div>
	);
});

export const HudTrayLayoutButton = memo(function HudTrayLayoutButton({
	vertical,
	label,
	onClick,
}: {
	vertical: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<Tooltip content={label}>
			<button
				data-testid="launch-tray-layout-button"
				type="button"
				aria-label={label}
				aria-pressed={vertical}
				className={hudIconBtnClasses}
				onClick={onClick}
			>
				<OrientationIcon vertical={vertical} />
			</button>
		</Tooltip>
	);
});

export const HudSourceButton = memo(function HudSourceButton({
	vertical,
	label,
	disabled,
	onClick,
}: {
	vertical: boolean;
	label: string;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			data-testid="launch-source-selector-button"
			className={`flex h-[34px] shrink-0 items-center gap-[7px] rounded-[10px] border-0 bg-transparent text-[#f5f7fa] transition-all duration-150 hover:bg-[#1a1e25] active:scale-[0.97] ${hudDisabledClasses} ${
				vertical ? "w-[34px] justify-center px-0" : "pr-3 pl-2.5"
			} ${styles.electronNoDrag}`}
			onClick={onClick}
			disabled={disabled}
			title={label}
			aria-label={label}
		>
			<SourceIcon className="shrink-0" />
			<span className={`${vertical ? "sr-only" : "max-w-[86px]"} truncate text-[13px] font-medium`}>
				{label}
			</span>
		</button>
	);
});

export const HudSystemAudioButton = memo(function HudSystemAudioButton({
	enabled,
	disabled,
	label,
	onClick,
}: {
	enabled: boolean;
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			data-testid="launch-system-audio-button"
			className={hudIconBtnClasses}
			onClick={onClick}
			disabled={disabled}
			title={label}
		>
			<VolumeIcon muted={!enabled} className={enabled ? "text-[#10b981]" : ""} />
		</button>
	);
});

export const HudMicButton = memo(function HudMicButton({
	enabled,
	disabled,
	label,
	onClick,
}: {
	enabled: boolean;
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			data-testid="launch-microphone-button"
			className={hudIconBtnClasses}
			aria-pressed={enabled}
			onClick={onClick}
			disabled={disabled}
			title={label}
		>
			<MicIcon muted={!enabled} className={enabled ? "text-[#10b981]" : ""} />
		</button>
	);
});

export const HudCameraButton = memo(function HudCameraButton({
	enabled,
	disabled,
	label,
	onClick,
}: {
	enabled: boolean;
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			data-testid="launch-webcam-button"
			className={hudIconBtnClasses}
			aria-pressed={enabled}
			onClick={onClick}
			disabled={disabled}
			title={label}
		>
			<CameraIcon off={!enabled} className={enabled ? "text-[#10b981]" : ""} />
		</button>
	);
});

export const HudSettingsButton = memo(function HudSettingsButton({
	disabled,
	expanded,
	label,
	onClick,
	buttonRef,
}: {
	disabled: boolean;
	expanded: boolean;
	label: string;
	onClick: () => void;
	buttonRef: React.MutableRefObject<HTMLButtonElement | null>;
}) {
	return (
		<Tooltip content={label}>
			<button
				ref={buttonRef}
				type="button"
				data-testid="launch-device-settings-button"
				aria-label={label}
				aria-expanded={expanded}
				aria-haspopup="dialog"
				// Dimmer at rest than the toggles it configures, so it reads as their
				// accessory rather than a fourth peer control.
				className={`${hudIconBtnClasses} text-[#5c6672] ${disabled ? "opacity-30 cursor-not-allowed pointer-events-none" : ""}`}
				onClick={onClick}
				disabled={disabled}
			>
				<Settings size={17} />
			</button>
		</Tooltip>
	);
});

export const HudCursorButton = memo(function HudCursorButton({
	editableOverlay,
	disabled,
	label,
	onClick,
}: {
	editableOverlay: boolean;
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			data-testid="launch-cursor-mode-button"
			className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border-0 cursor-pointer transition-all duration-150 active:scale-95 ${hudDisabledClasses} ${styles.electronNoDrag} ${
				editableOverlay
					? "bg-[#10b981] text-[#08090d] hover:bg-[#0e9e6e]"
					: "bg-transparent text-[#828c99] hover:bg-[#1a1e25] hover:text-[#f5f7fa]"
			}`}
			onClick={onClick}
			disabled={disabled}
			title={label}
		>
			<CursorIcon />
		</button>
	);
});

export const HudRecordButton = memo(function HudRecordButton({
	recording,
	paused,
	saving,
	elapsedSeconds,
	label,
	savingLabel,
	onClick,
}: {
	recording: boolean;
	paused: boolean;
	saving: boolean;
	elapsedSeconds: number;
	label: string;
	savingLabel: string;
	onClick: () => void;
}) {
	return (
		<Tooltip content={label}>
			<button
				data-testid="launch-record-button"
				disabled={saving}
				className={`flex h-[34px] shrink-0 items-center justify-center rounded-[17px] border-0 transition-all duration-150 ${recording || saving ? "min-w-[78px] px-3" : "w-[34px]"} ${styles.electronNoDrag} ${
					saving
						? "bg-transparent opacity-60 cursor-not-allowed"
						: "bg-transparent hover:bg-[rgba(248,113,113,0.16)]"
				}`}
				onClick={onClick}
				title={label}
				aria-label={label}
				style={{ flex: "0 0 auto" }}
			>
				<div className={`flex items-center justify-center ${recording || saving ? "gap-1.5" : ""}`}>
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
						<span className="text-[#f87171] text-xs font-semibold select-none">{savingLabel}</span>
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
	);
});

export const HudStudioButton = memo(function HudStudioButton({
	disabled,
	label,
	onClick,
}: {
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<Tooltip content={label}>
			<button
				data-testid="launch-open-studio-button"
				disabled={disabled}
				className={`${hudIconBtnClasses} ${disabled ? "opacity-30 cursor-not-allowed pointer-events-none" : ""}`}
				onClick={onClick}
			>
				<OpenInEditorIcon />
			</button>
		</Tooltip>
	);
});

export const HudNotesButton = memo(function HudNotesButton({
	disabled,
	label,
	onClick,
}: {
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<Tooltip content={label}>
			<button
				type="button"
				aria-label={label}
				disabled={disabled}
				className={`${hudIconBtnClasses} ${disabled ? "opacity-30 cursor-not-allowed pointer-events-none" : ""}`}
				onClick={onClick}
			>
				<NotepadText size={ICON_SIZE} />
			</button>
		</Tooltip>
	);
});

export const HudRecordingControls = memo(function HudRecordingControls({
	vertical,
	paused,
	saving,
	canPause,
	pauseLabel,
	restartLabel,
	cancelLabel,
	onTogglePause,
	onRestart,
	onCancel,
}: {
	vertical: boolean;
	paused: boolean;
	saving: boolean;
	canPause: boolean;
	pauseLabel: string;
	restartLabel: string;
	cancelLabel: string;
	onTogglePause: () => void;
	onRestart: () => void;
	onCancel: () => void;
}) {
	return (
		<div
			className={`flex items-center gap-0.5 ${vertical ? "flex-col" : ""} ${styles.electronNoDrag}`}
		>
			{canPause && (
				<Tooltip content={pauseLabel}>
					<button className={hudAuxIconBtnClasses} onClick={onTogglePause} disabled={saving}>
						{getIcon(paused ? "resume" : "pause", paused ? "text-amber-400" : "text-white/60")}
					</button>
				</Tooltip>
			)}
			<Tooltip content={restartLabel}>
				<button className={hudAuxIconBtnClasses} onClick={onRestart} disabled={saving}>
					{getIcon("restart", "text-white/60")}
				</button>
			</Tooltip>
			<Tooltip content={cancelLabel}>
				<button className={hudAuxIconBtnClasses} onClick={onCancel} disabled={saving}>
					{getIcon("cancel", "text-white/60")}
				</button>
			</Tooltip>
		</div>
	);
});

export const HudLanguageButton = memo(function HudLanguageButton({
	vertical,
	code,
	label,
	disabled,
	expanded,
	onClick,
	buttonRef,
}: {
	vertical: boolean;
	code: string;
	label: string;
	disabled: boolean;
	expanded: boolean;
	onClick: () => void;
	buttonRef: React.MutableRefObject<HTMLButtonElement | null>;
}) {
	return (
		<button
			ref={buttonRef}
			type="button"
			aria-label={label}
			aria-expanded={expanded}
			aria-haspopup="menu"
			disabled={disabled}
			onClick={onClick}
			title={label}
			className={`flex h-[34px] items-center rounded-[10px] border-0 bg-transparent text-[#828c99] transition-all duration-150 hover:bg-[#1a1e25] hover:text-[#e9edf3] ${
				vertical ? "w-[34px] justify-center px-0" : "gap-1.5 px-2.5"
			} ${styles.electronNoDrag} ${disabled ? "opacity-30 cursor-not-allowed pointer-events-none" : ""}`}
		>
			<Languages size={16} className="shrink-0" />
			<span
				className={`${vertical ? "sr-only" : ""} font-mono text-[11px] font-semibold tracking-wide text-[#f5f7fa]`}
			>
				{code}
			</span>
		</button>
	);
});

export const HudWindowControls = memo(function HudWindowControls({
	vertical,
	disabled,
	hideLabel,
	closeLabel,
	onHide,
	onClose,
}: {
	vertical: boolean;
	disabled: boolean;
	hideLabel: string;
	closeLabel: string;
	onHide: () => void;
	onClose: () => void;
}) {
	return (
		<div className={`flex items-center gap-[5px] ${vertical ? "flex-col" : ""}`}>
			<button className={windowBtnClasses} title={hideLabel} onClick={onHide} disabled={disabled}>
				{getIcon("minimize")}
			</button>
			<button className={closeBtnClasses} title={closeLabel} onClick={onClose} disabled={disabled}>
				{getIcon("close")}
			</button>
		</div>
	);
});

export const HudLanguageMenu = memo(function HudLanguageMenu({
	locales,
	activeLocale,
	getName,
	onSelect,
	panelRef,
	onEnsureInteractive,
}: {
	locales: readonly string[];
	activeLocale: string;
	getName: (locale: string) => string;
	onSelect: (locale: string) => void;
	panelRef: (el: HTMLDivElement | null) => void;
	onEnsureInteractive: () => void;
}) {
	return (
		<div
			ref={panelRef}
			data-hud-interactive="true"
			data-testid="hud-language-menu"
			role="menu"
			className={`${styles.hudPopover} ${styles.hudPopoverScroll} ${styles.hudScrollbar} animate-mic-panel-in ${styles.electronNoDrag}`}
			onPointerDown={(event) => event.stopPropagation()}
			onPointerEnter={onEnsureInteractive}
			onWheel={(event) => {
				onEnsureInteractive();
				event.stopPropagation();
			}}
		>
			{locales.map((loc) => (
				<button
					key={loc}
					type="button"
					role="menuitemradio"
					aria-checked={loc === activeLocale}
					onClick={() => onSelect(loc)}
					className={`${styles.languageMenuItem} ${loc === activeLocale ? styles.languageMenuItemActive : ""}`}
				>
					<span className="truncate">{getName(loc)}</span>
					{loc === activeLocale ? <Check size={11} className="text-white/85" /> : null}
				</button>
			))}
		</div>
	);
});

export const HudNotice = memo(function HudNotice({
	title,
	description,
	dismissLabel,
	confirmLabel,
	onDismiss,
	onConfirm,
}: {
	title: string;
	description: string;
	dismissLabel: string;
	confirmLabel: string;
	onDismiss: () => void;
	onConfirm: () => void;
}) {
	return (
		<div
			data-hud-interactive="true"
			className={`w-full rounded-xl border border-white/15 bg-[rgba(20,20,28,0.95)] p-3 shadow-2xl backdrop-blur-xl text-white animate-in fade-in-0 zoom-in-95 duration-200 ${styles.electronNoDrag}`}
		>
			<div className="text-[13px] font-semibold text-white">{title}</div>
			<div className="mt-1 text-[11px] leading-relaxed text-white/75">{description}</div>
			<div className="mt-3 flex items-center justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onDismiss}
					className="h-7 text-xs text-white/80 hover:bg-white/10 hover:text-white"
				>
					{dismissLabel}
				</Button>
				<Button
					type="button"
					size="sm"
					onClick={onConfirm}
					className="h-7 text-xs bg-white text-[#10121b] hover:bg-white/90"
				>
					{confirmLabel}
				</Button>
			</div>
		</div>
	);
});
