// Live webcam preview overlay. Reads the ACTIVE clip's asset `cameraTrack`
// (P4 — the camera link lives per-asset, not on the document, since a
// project can hold multiple recordings each with their own camera or none)
// and drives a real <video> element at the right source-time. The webcam is
// a derived stream — cuts/zoom/speed come from the main timeline. This
// component only reads; it does not write.
//
// ponytail: the camera plays in parallel with the screen. Source-time mapping
//   cameraTime = clip.sourceStartSec + (currentTimeSec − clip.timelineStartSec)
//   adjustment = (cameraTrack.startMs + cameraTrack.offsetMs) / 1000
//   final      = max(0, cameraTime − adjustment)
// (startMs is when the camera comes online; offsetMs is the early/late delay).
// Because this is resolved from the active clip's asset, the overlay
// naturally disappears when the playhead moves onto a clip whose asset has
// no camera, and reappears when it moves onto one that does.

import { useEffect, useMemo, useRef, useState } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { WebcamLayoutPreset, WebcamMaskShape } from "@/components/video-editor/types";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import { resolveActiveCameraTrack } from "@/lib/ai-edition/timeline/camera";
import {
	CAMERA_SYNC_TOLERANCE_PAUSED_SEC,
	type PlaybackClockRef,
	resolveCameraSyncTarget,
} from "@/lib/ai-edition/timeline/playback-clock";
import { locateVirtualPosition } from "@/lib/ai-edition/timeline/virtual-preview";
import { getCssClipPath } from "@/lib/webcamMaskShapes";
import styles from "./NewEditorShell.module.css";

interface WebcamOverlayProps {
	clips: AxcutClip[];
	currentTimeSec: number;
	onTimeChange: (sec: number) => void;
	isPlaying: boolean;
	// ponytail: container renders without a frame; the <video> is the only
	// thing the user actually sees. Border radius + clip-path therefore
	// belong on the video so they actually round the camera content.
	borderRadius: number;
	webcamMaskShape: WebcamMaskShape;
	layoutPreset: WebcamLayoutPreset;
	// The screen preview's live clock (see playback-clock.ts). When present,
	// sync is driven from this ref on our own rAF tick instead of the
	// currentTimeSec/isPlaying PROPS above — those props still gate whether
	// the camera element renders at all (see cameraTrack below), but the
	// numeric sync target comes straight from the screen's own rAF, this
	// frame, with no React round trip in between.
	clockRef?: PlaybackClockRef;
}

export function WebcamOverlay(props: WebcamOverlayProps) {
	const { settings } = useEditorSettings();
	const assets = useProjectStore((s) => s.document?.assets ?? null);

	const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
	const [hasError, setHasError] = useState(false);

	// Fallback (pre-clockRef / first paint) position from props, used only for
	// the initial correction on loadedmetadata before the rAF loop below has
	// had a chance to run.
	const position = useMemo(
		() => locateVirtualPosition(props.clips, props.currentTimeSec),
		[props.clips, props.currentTimeSec],
	);

	const cameraTrack = useMemo(
		() => resolveActiveCameraTrack(assets ?? [], props.clips, props.currentTimeSec),
		[assets, props.clips, props.currentTimeSec],
	);

	const cameraTime = useMemo(() => {
		if (!cameraTrack?.visible || !position) return null;
		const offsetSec = (cameraTrack.startMs + cameraTrack.offsetMs) / 1000;
		return Math.max(0, position.sourceTimeSec - offsetSec);
	}, [cameraTrack, position]);

	// Refs so the rAF tick below always reads the latest clips/assets without
	// re-creating the loop on every document mutation.
	const clipsRef = useRef(props.clips);
	clipsRef.current = props.clips;
	const assetsRef = useRef(assets);
	assetsRef.current = assets;

	// Drive the camera <video> directly off the shared playback clock: read
	// it every rAF tick, resolve which clip/camera is active THIS frame, and
	// correct time/rate/play-state in one place. This replaces two separate
	// prop-driven effects (time correction + play/pause mirroring), both of
	// which depended on a React state round trip from the screen preview.
	useEffect(() => {
		if (!videoEl || !props.clockRef) return;
		const clockRef = props.clockRef;
		let raf = 0;
		const tick = () => {
			raf = window.requestAnimationFrame(tick);
			const clock = clockRef.current;
			const clipsNow = clipsRef.current;
			const positionNow = locateVirtualPosition(clipsNow, clock.virtualTimeSec);
			const trackNow = resolveActiveCameraTrack(
				assetsRef.current ?? [],
				clipsNow,
				clock.virtualTimeSec,
			);
			const target = resolveCameraSyncTarget(
				clock,
				trackNow,
				positionNow ? positionNow.sourceTimeSec : null,
			);
			if (!target) return;

			if (videoEl.playbackRate !== target.playbackRate) {
				videoEl.playbackRate = target.playbackRate;
			}

			if (Math.abs(videoEl.currentTime - target.targetTimeSec) > target.toleranceSec) {
				try {
					videoEl.currentTime = target.targetTimeSec;
				} catch {
					// ponytail: silent — video not ready yet
				}
			}

			if (target.isPlaying && videoEl.paused) {
				void videoEl.play().catch(() => setHasError(true));
			} else if (!target.isPlaying && !videoEl.paused) {
				videoEl.pause();
			}
		};
		raf = window.requestAnimationFrame(tick);
		return () => window.cancelAnimationFrame(raf);
	}, [videoEl, props.clockRef]);

	// Fallback for when no clockRef is wired up (defensive — all current call
	// sites pass one): keep the old prop-driven correction so the overlay
	// still works, just with the previously-reported latency.
	useEffect(() => {
		if (!videoEl || props.clockRef) return;
		if (cameraTime === null) return;
		if (Math.abs(videoEl.currentTime - cameraTime) > CAMERA_SYNC_TOLERANCE_PAUSED_SEC) {
			try {
				videoEl.currentTime = cameraTime;
			} catch {
				// ponytail: silent — video not ready yet
			}
		}
	}, [videoEl, cameraTime, props.clockRef]);

	useEffect(() => {
		if (!videoEl || props.clockRef) return;
		if (props.isPlaying) {
			void videoEl.play().catch(() => setHasError(true));
		} else {
			videoEl.pause();
		}
	}, [videoEl, props.isPlaying, props.clockRef]);

	if (!cameraTrack?.sourcePath || !cameraTrack.visible) {
		return null;
	}

	const showError = hasError;
	// ponytail: the layout computes the final borderRadius (preset fraction
	// for dual-frame/overlay, 0 for stack, half-circle for circle PiP, etc.).
	// Push it onto the <video> itself so it actually clips the camera
	// content; the container stays a transparent, overflow:hidden wrapper.
	const style: React.CSSProperties = {
		display: showError ? "none" : "block",
		transform: settings.webcamMirrored ? "scaleX(-1)" : undefined,
		clipPath: getCssClipPath(props.webcamMaskShape) ?? undefined,
		borderRadius: `${props.borderRadius}px`,
	};

	return (
		<video
			key={cameraTrack.sourcePath}
			ref={(el) => {
				setVideoEl(el);
				setHasError(false);
			}}
			src={toFileUrl(cameraTrack.sourcePath)}
			className={styles.webcamVideo}
			muted
			playsInline
			preload="metadata"
			onError={() => setHasError(true)}
			onLoadedMetadata={() => {
				if (
					cameraTime !== null &&
					videoEl &&
					Math.abs(videoEl.currentTime - cameraTime) > CAMERA_SYNC_TOLERANCE_PAUSED_SEC
				) {
					try {
						videoEl.currentTime = cameraTime;
					} catch {
						// silent
					}
				}
			}}
			style={style}
		/>
	);
}
