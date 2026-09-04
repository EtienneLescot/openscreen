// Issue #560, step 5. The lane the captions are read from is a DOCUMENT fact, because it
// decides the text burnt into the exported file — and the path that burns it never runs
// React. These pin that, and the fallback that keeps the pane and the exporter from
// disagreeing about which lane a project even has.

import { describe, expect, it } from "vitest";
import type { AxcutAudioTrack, AxcutClip, AxcutDocument, AxcutTranscript } from "../schema";
import { deriveCaptionCues } from "./cues";
import {
	DEFAULT_CAPTION_SETTINGS,
	getCaptionSettings,
	patchCaptionSettings,
	resolveCaptionLane,
} from "./settings";

const CLIPS: AxcutClip[] = [
	{
		id: "c1",
		assetId: "rec",
		sourceStartSec: 0,
		sourceEndSec: 6,
		timelineStartSec: 0,
		timelineEndSec: 6,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

const VOICE = {
	id: "vo",
	trackId: "vo",
	assetId: "aud",
	kind: "voiceover",
	startMs: 0,
	endMs: 6000,
	durationSec: 6,
	offsetMs: 0,
	gainDb: 0,
	loop: false,
	fadeInMs: 0,
	fadeOutMs: 0,
	muted: false,
	label: "",
	origin: "user",
} as unknown as AxcutAudioTrack;

function words(assetId: string, texts: string[]): AxcutTranscript {
	return {
		assetId,
		language: "en",
		segments: [],
		words: texts.map((text, i) => ({
			id: `${assetId}_w${i}`,
			segmentId: "s",
			text,
			startSec: i,
			endSec: i + 0.9,
		})),
	} as unknown as AxcutTranscript;
}

function doc(over: Partial<AxcutDocument> = {}): AxcutDocument {
	return {
		schemaVersion: 7,
		project: {
			id: "p",
			title: "T",
			createdAt: "2026-06-25T10:00:00.000Z",
			updatedAt: "2026-06-25T10:00:00.000Z",
			primaryAssetId: "rec",
		},
		assets: [],
		transcript: null,
		transcripts: [words("rec", ["filmed", "words"]), words("aud", ["narrated", "words"])],
		timeline: {
			clips: CLIPS,
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [VOICE],
		legacyEditor: null,
		...over,
	} as unknown as AxcutDocument;
}

const on = (lane: "recording" | "voiceover") => ({
	...DEFAULT_CAPTION_SETTINGS,
	enabled: true,
	captionLane: lane,
});

const texts = (d: AxcutDocument, lane: "recording" | "voiceover") =>
	deriveCaptionCues(d, on(lane), {}).map((c) => c.text);

describe("captionLane", () => {
	it("defaults to the recording, and survives a round trip through the document", () => {
		expect(DEFAULT_CAPTION_SETTINGS.captionLane).toBe("recording");
		const next = patchCaptionSettings(doc(), { captionLane: "voiceover" });
		expect(getCaptionSettings(next).captionLane).toBe("voiceover");
	});

	it("refuses a lane the placements would not recognise", () => {
		// A hand-edited passthrough blob cannot inject one: `legacyEditor` is untyped.
		const poisoned = patchCaptionSettings(doc(), {
			captionLane: "sideways" as unknown as "recording",
		});
		expect(getCaptionSettings(poisoned).captionLane).toBe("recording");
	});

	it("reads the chosen lane's own words", () => {
		expect(texts(doc(), "recording")).toContain("filmed words");
		expect(texts(doc(), "voiceover")).toContain("narrated words");
	});

	it("leaves the recording lane's cues untouched by the change", () => {
		// The default path is byte-identical: a project that never opts in sees nothing.
		const withoutAudio = doc({ audioTracks: [] });
		expect(texts(withoutAudio, "recording")).toEqual(texts(doc(), "recording"));
	});

	it("falls back to the recording when the stored lane no longer names anything", () => {
		// The pane used to carry this fallback in React state, and the export path never
		// runs React: this project would have exported ZERO captions while the pane showed
		// the recording's.
		const orphaned = doc({ audioTracks: [] });
		expect(resolveCaptionLane(orphaned, on("voiceover"))).toBe("recording");
		expect(texts(orphaned, "voiceover")).toContain("filmed words");
		// And it is not a blanket fallback: with a take present the choice stands.
		expect(resolveCaptionLane(doc(), on("voiceover"))).toBe("voiceover");
	});

	it("carries a corrected word into the caption", () => {
		const corrected = doc({
			transcripts: [words("rec", ["filmed", "words"]), words("aud", ["Kubernetes", "words"])],
		});
		expect(texts(corrected, "voiceover")).toContain("Kubernetes words");
	});

	it("leaves a take's cues alone when the FILM gains an insertion", () => {
		// An insertion is media inside the clip that carries it, and it lengthens that clip.
		// A take laid over the film keeps its own position on the timeline — the picture
		// slides underneath it — so its cues do not move either. Measured per placement,
		// through the asset the placement actually plays.
		const paused = doc({
			timeline: {
				...doc().timeline,
				insertRanges: [
					{
						id: "i1",
						assetId: "rec",
						atSec: 1,
						durationSec: 1,
						wordId: "x",
						reason: "",
						origin: "user",
					},
					// biome-ignore lint/suspicious/noExplicitAny: fixture, not a schema exercise
				] as any,
			},
		});
		const before = deriveCaptionCues(doc(), on("voiceover"), {});
		const after = deriveCaptionCues(paused, on("voiceover"), {});
		// The insertion names the RECORDING's asset. The take is a different asset laid at
		// its own timeline position, so nothing about this cue changes.
		expect(after[0].startMs).toBe(before[0].startMs);
		expect(after[0].endMs).toBe(before[0].endMs);
	});
});
