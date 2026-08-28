// Audio-layer playback: renders nothing, and plays the document's voiceover
// and music layers against the timeline clock. One <audio> element per region
// (imperatively created — they are not React nodes, so nothing re-renders at
// 60 Hz), steered by a store subscription: every `currentTimeSec` write (the
// rAF tick during playback, a scrub while paused) re-positions each element to
// its layer's local position and ramps its volume through the fades.
//
// Deliberately OUTSIDE VirtualPreview: the preview syncs its own audio to the
// SOURCE clock of the underlying <video>, while a layer lives in TIMELINE time
// — `currentTimeSec`, the same coordinate the ruler and the pills use. Mixing
// the two in one component would have coupled layer playback to the active
// video asset swap.

import { useEffect, useMemo, useRef } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { AxcutAsset, AxcutAudioRegion } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";

const SYNC_EPSILON_SEC = 0.03;

interface LayerElement {
	region: AxcutAudioRegion;
	assetId: string;
	element: HTMLAudioElement;
}

function gainScalar(gainDb: number): number {
	return 10 ** (gainDb / 20);
}

/** Fraction 0..1 of the full volume at `t` (seconds into the layer's span),
 *  applying the fade in/out ramps. */
export function layerVolumeAt(region: AxcutAudioRegion, localSec: number): number {
	if (region.muted) return 0;
	let v = 1;
	if (region.fadeInMs > 0) {
		const fadeInSec = region.fadeInMs / 1000;
		if (localSec < fadeInSec) v = Math.min(v, localSec / fadeInSec);
	}
	if (region.fadeOutMs > 0) {
		const spanSec = (region.endMs - region.startMs) / 1000;
		const fadeOutSec = region.fadeOutMs / 1000;
		const remaining = spanSec - localSec;
		if (remaining < fadeOutSec) v = Math.min(v, Math.max(0, remaining / fadeOutSec));
	}
	return v;
}

/**
 * Local source position (seconds) for a layer at `timelineSec`. Loop folds the
 * position back into the source — over `sourceDuration - offset`, the same
 * window the export's `planLayerIterations` repeats, so a looping layer with a
 * start offset stays in phase with the mix. Without looping the position
 * clamps to the source length. `sourceDurationSec` comes from the element's
 * real metadata.
 */
export function layerSourcePosition(
	region: AxcutAudioRegion,
	timelineSec: number,
	sourceDurationSec: number,
): number {
	const offset = region.offsetMs / 1000;
	const local = Math.max(0, timelineSec - region.startMs / 1000);
	const raw = offset + local;
	if (sourceDurationSec <= 0) return raw;
	if (region.loop) {
		const loopLen = sourceDurationSec - offset;
		if (loopLen > 0) return offset + (local % loopLen);
		// The offset is at/after the end of the file: nothing left to loop.
		return sourceDurationSec;
	}
	return Math.min(raw, sourceDurationSec);
}

export function AudioLayersPlayback({
	regions,
	assets,
}: {
	regions: AxcutAudioRegion[];
	assets: AxcutAsset[];
}) {
	const elementsRef = useRef<LayerElement[]>([]);
	const assetPathById = useMemo(() => new Map(assets.map((a) => [a.id, a.originalPath])), [assets]);

	// Rebuild the element set only when the layer LIST changes (or an asset's
	// path does) — payload edits (gain, fades) are read live from `regions`
	// through the ref below, never through element re-creation.
	useEffect(() => {
		const existing = new Map(elementsRef.current.map((l) => [l.region.id, l]));
		const next: LayerElement[] = [];
		for (const region of regions) {
			const path = assetPathById.get(region.assetId);
			if (!path) continue;
			const kept = existing.get(region.id);
			if (kept && kept.assetId === region.assetId) {
				kept.region = region;
				next.push(kept);
				existing.delete(region.id);
				continue;
			}
			const element = new Audio(toFileUrl(path));
			element.preload = "auto";
			element.volume = 0;
			next.push({ region, assetId: region.assetId, element });
		}
		// Drop layers that no longer exist (or lost their asset).
		for (const stale of existing.values()) {
			stale.element.pause();
			stale.element.removeAttribute("src");
			try {
				stale.element.load();
			} catch {
				// ignore — element is being released
			}
		}
		elementsRef.current = next;
	}, [regions, assetPathById]);

	// Live payload + playhead sync. The store writes `currentTimeSec` every rAF
	// during playback, so this subscription fires at frame rate — direct DOM
	// mutation, no React state anywhere in the loop.
	useEffect(() => {
		const unsubscribe = useProjectStore.subscribe((state, prev) => {
			const timeSec = state.currentTimeSec;
			const playing = state.playing;
			if (timeSec === prev.currentTimeSec && playing === prev.playing) return;
			for (const { region, element } of elementsRef.current) {
				const startSec = region.startMs / 1000;
				const endSec = region.endMs / 1000;
				const active = timeSec >= startSec && timeSec < endSec;
				if (!active) {
					if (!element.paused) element.pause();
					continue;
				}
				const sourceDuration = Number.isFinite(element.duration) ? element.duration : 0;
				const target = layerSourcePosition(region, timeSec, sourceDuration);
				if (Math.abs(element.currentTime - target) > SYNC_EPSILON_SEC) {
					try {
						element.currentTime = target;
					} catch {
						// metadata not ready yet
					}
				}
				// Clamped to 1: an HTML element cannot boost past 0 dB. The export
				// applies the full scalar; the preview is the approximation.
				element.volume = Math.min(
					1,
					gainScalar(region.gainDb) * layerVolumeAt(region, timeSec - startSec),
				);
				// A layer whose source has run out (non-looping file shorter than
				// its span, or a loop offset past the end) sits silent instead of
				// restarting: `play()` on an ended element seeks it to 0, and the
				// next tick would reposition it back to the end — a 60 Hz
				// restart/stutter loop. Hold it paused at the end.
				const exhausted = sourceDuration > 0 && target >= sourceDuration - SYNC_EPSILON_SEC;
				if (playing && !exhausted && element.paused) {
					const play = element.play();
					if (play) void play.catch(() => undefined);
				} else if ((!playing || exhausted) && !element.paused) {
					element.pause();
				}
				// A looping layer that reached the file's end between two ticks
				// (the `ended` event pauses it before the fold catches up):
				// reposition and resume in the same tick.
				if (playing && region.loop && element.ended) {
					try {
						element.currentTime = target;
					} catch {
						// metadata not ready yet
					}
					void element.play().catch(() => undefined);
				}
			}
		});
		return unsubscribe;
	}, []);

	// Release everything on unmount.
	useEffect(() => {
		return () => {
			for (const { element } of elementsRef.current) {
				element.pause();
				element.removeAttribute("src");
				try {
					element.load();
				} catch {
					// ignore
				}
			}
			elementsRef.current = [];
		};
	}, []);

	return null;
}
