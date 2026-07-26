import { Loader2 } from "lucide-react";
import { BsPauseCircle, BsPlayCircle } from "react-icons/bs";
import { FaFolderOpen } from "react-icons/fa6";
import { FiMinus, FiX } from "react-icons/fi";
import { MdCancel, MdRestartAlt, MdVideoFile } from "react-icons/md";
import { RxDragHandleDots2 } from "react-icons/rx";

export const ICON_SIZE = 20;

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

export type IconName = keyof typeof ICON_CONFIG;

/** Renders the configured icon for a HUD control. */
export function getIcon(name: IconName, className?: string) {
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

export function OrientationIcon({
	vertical,
	className,
}: {
	vertical: boolean;
	className?: string;
}) {
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

export function SourceIcon({ className }: { className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<rect x="2.5" y="4.5" width="19" height="13" rx="2.2" />
			<path d="M8.5 21h7M12 17.5v3.3" />
		</svg>
	);
}

export function VolumeIcon({ muted, className }: { muted: boolean; className?: string }) {
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

export function MicIcon({ muted, className }: { muted: boolean; className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<rect x="9" y="3" width="6" height="11" rx="3" />
			<path d="M18.5 11a6.5 6.5 0 0 1-13 0" />
			<path d="M12 17.5v3" />
			{muted ? <path d="M4 4l16 16" /> : null}
		</svg>
	);
}

export function CameraIcon({ off, className }: { off: boolean; className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<rect x="3" y="6.5" width="13" height="11" rx="2.4" />
			<path d="M16 10.3 21 7v10l-5-3.3" />
			{off ? <path d="M4 4l16 16" /> : null}
		</svg>
	);
}

export function CursorIcon({ className }: { className?: string }) {
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

export function RecordGlyph({ recording, className }: { recording: boolean; className?: string }) {
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

export function OpenInEditorIcon({ className }: { className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
			<path d="m6.2 5.3 3.1 5.4" />
			<path d="m12.4 3.4 3.1 5.4" />
			<path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
		</svg>
	);
}
