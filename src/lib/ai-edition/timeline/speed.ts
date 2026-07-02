// Port of `findActiveSpeedRegion` from
// `src/components/video-editor/videoPlayback/videoEventHandlers.ts` — main
// applies speed by literally setting `<video>.playbackRate` every frame from
// whichever region contains the current time (first match wins on overlap),
// leaving the browser to do the actual time-warping. No virtual-timeline
// remap: a sped-up region still occupies its original span on the ruler,
// it's just played through faster — same behavior ported here.

export interface SpeedRegion {
	id: string;
	startMs: number;
	endMs: number;
	speed: number;
}

export function findActiveSpeedRegion(regions: SpeedRegion[], timeMs: number): SpeedRegion | null {
	return regions.find((region) => timeMs >= region.startMs && timeMs < region.endMs) ?? null;
}
