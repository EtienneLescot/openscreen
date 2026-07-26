import { describe, expect, it } from "vitest";
import type { AxcutDocument, AxcutTranscript } from "../schema";
import { captionCuesToTextRegions, deriveCaptionCues } from "./cues";
import {
	captionBackgroundCss,
	captionBandRect,
	DEFAULT_CAPTION_SETTINGS,
	getCaptionSettings,
	patchCaptionSettings,
} from "./settings";
import {
	getCaptionTranslations,
	putCaptionTranslation,
	removeCaptionTranslation,
	translationCoverage,
	untranslatedSegments,
} from "./translations";

function transcript(): AxcutTranscript {
	return {
		assetId: "asset-1",
		language: "en",
		segments: [
			{
				id: "seg_1",
				kind: "speech",
				startSec: 0,
				endSec: 2,
				text: "hello there friend",
				wordIds: ["w1", "w2", "w3"],
			},
			{
				id: "seg_2",
				kind: "speech",
				startSec: 4,
				endSec: 6,
				text: "goodbye now",
				wordIds: ["w4", "w5"],
			},
		],
		words: [
			{ id: "w1", segmentId: "seg_1", startSec: 0, endSec: 0.6, text: "hello" },
			{ id: "w2", segmentId: "seg_1", startSec: 0.6, endSec: 1.2, text: "there" },
			{ id: "w3", segmentId: "seg_1", startSec: 1.2, endSec: 2, text: "friend" },
			{ id: "w4", segmentId: "seg_2", startSec: 4, endSec: 5, text: "goodbye" },
			{ id: "w5", segmentId: "seg_2", startSec: 5, endSec: 6, text: "now" },
		],
	};
}

function doc(overrides: Partial<AxcutDocument> = {}): AxcutDocument {
	return {
		schemaVersion: 5,
		project: {
			id: "p1",
			title: "Test",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			primaryAssetId: "asset-1",
		},
		assets: [],
		transcript: null,
		transcripts: [transcript()],
		timeline: {
			clips: [
				{
					id: "clip-1",
					assetId: "asset-1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek", revision: 0 },
		export: { preset: "final-balanced", lastJobId: null },
		history: { revisions: [] },
		...overrides,
	} as AxcutDocument;
}

const ON = { ...DEFAULT_CAPTION_SETTINGS, enabled: true };

describe("caption settings", () => {
	it("defaults to hidden so an existing project doesn't sprout captions on upgrade", () => {
		expect(getCaptionSettings(doc()).enabled).toBe(false);
	});

	it("round-trips a patch through the legacyEditor envelope", () => {
		const next = patchCaptionSettings(doc(), { enabled: true, fontSize: 44, offsetY: -10 });
		expect(getCaptionSettings(next)).toMatchObject({ enabled: true, fontSize: 44, offsetY: -10 });
	});

	it("keeps an explicit null language instead of falling back to the default", () => {
		const translated = patchCaptionSettings(doc(), { language: "fr" });
		expect(getCaptionSettings(translated).language).toBe("fr");
		expect(getCaptionSettings(patchCaptionSettings(translated, { language: null })).language).toBe(
			null,
		);
	});

	it("swaps min/max words when they are set the wrong way round", () => {
		const next = patchCaptionSettings(doc(), { minWordsPerLine: 9, maxWordsPerLine: 3 });
		expect(getCaptionSettings(next)).toMatchObject({ minWordsPerLine: 3, maxWordsPerLine: 9 });
	});

	it("keeps the band inside the frame however far the offset is pushed", () => {
		const rect = captionBandRect({ ...ON, verticalPosition: "bottom", offsetY: 45 });
		expect(rect.y + rect.height).toBeLessThanOrEqual(100);
		const top = captionBandRect({ ...ON, verticalPosition: "top", offsetY: -45 });
		expect(top.y).toBeGreaterThanOrEqual(0);
	});

	it("folds the opacity into the background colour, and reports 'transparent' when off", () => {
		expect(
			captionBackgroundCss({ ...ON, backgroundColor: "#10b981", backgroundOpacity: 0.5 }),
		).toBe("rgba(16, 185, 129, 0.5)");
		expect(captionBackgroundCss({ ...ON, backgroundEnabled: false })).toBe("transparent");
	});
});

describe("deriveCaptionCues", () => {
	it("returns nothing while the layer is hidden", () => {
		expect(deriveCaptionCues(doc(), DEFAULT_CAPTION_SETTINGS, {})).toEqual([]);
	});

	it("derives cues from the transcript with no stored caption data", () => {
		const cues = deriveCaptionCues(doc(), { ...ON, minWordsPerLine: 2, maxWordsPerLine: 3 }, {});
		expect(cues.length).toBeGreaterThan(0);
		expect(cues.map((c) => c.text).join(" ")).toContain("hello there");
		// Timings come from the words, in ms on the ruler.
		expect(cues[0].startMs).toBe(0);
	});

	it("maps source time onto the ruler through the clip's in-point", () => {
		const shifted = doc({
			timeline: {
				...doc().timeline,
				clips: [
					{
						id: "clip-1",
						assetId: "asset-1",
						sourceStartSec: 4,
						sourceEndSec: 10,
						timelineStartSec: 0,
						timelineEndSec: 6,
						wordRefs: [],
						origin: "user",
						reason: "",
					},
				],
			},
		} as Partial<AxcutDocument>);

		const cues = deriveCaptionCues(shifted, ON, {});
		// The first two seconds of speech are cut away by the clip in-point; what
		// survives starts at 4s in the source, i.e. 0s on the ruler.
		expect(cues).toHaveLength(1);
		expect(cues[0]).toMatchObject({ startMs: 0, text: "goodbye now" });
	});

	it("drops cues whose source range no clip plays", () => {
		const cut = doc({
			timeline: {
				...doc().timeline,
				clips: [
					{
						id: "clip-1",
						assetId: "asset-1",
						sourceStartSec: 7,
						sourceEndSec: 10,
						timelineStartSec: 0,
						timelineEndSec: 3,
						wordRefs: [],
						origin: "user",
						reason: "",
					},
				],
			},
		} as Partial<AxcutDocument>);
		expect(deriveCaptionCues(cut, ON, {})).toEqual([]);
	});

	it("shows the translation for a translated segment and the original for the rest", () => {
		const translations = {
			fr: {
				language: "fr",
				label: "Français",
				updatedAt: "2026-01-01T00:00:00.000Z",
				byAsset: { "asset-1": { seg_1: "bonjour mon ami" } },
			},
		};
		const cues = deriveCaptionCues(doc(), { ...ON, language: "fr" }, translations);
		const text = cues.map((c) => c.text).join(" | ");
		expect(text).toContain("bonjour");
		// seg_2 has no translation, so its original words still play.
		expect(text).toContain("goodbye");
	});

	it("keeps the translated line inside its own segment's span", () => {
		const translations = {
			fr: {
				language: "fr",
				label: "Français",
				updatedAt: "",
				byAsset: { "asset-1": { seg_1: "bonjour", seg_2: "au revoir" } },
			},
		};
		const cues = deriveCaptionCues(doc(), { ...ON, language: "fr" }, translations);
		const second = cues.find((c) => c.text.includes("revoir"));
		expect(second).toBeDefined();
		expect(second?.startMs).toBeGreaterThanOrEqual(4000);
		expect(second?.endMs).toBeLessThanOrEqual(6000);
	});

	it("never leaves two cues on screen at the same instant", () => {
		const cues = deriveCaptionCues(doc(), ON, {});
		for (let i = 1; i < cues.length; i++) {
			expect(cues[i - 1].endMs).toBeLessThanOrEqual(cues[i].startMs);
		}
	});
});

describe("captionCuesToTextRegions", () => {
	it("emits plain text regions with no annotationSource marker", () => {
		const regions = captionCuesToTextRegions(deriveCaptionCues(doc(), ON, {}), ON);
		expect(regions.length).toBeGreaterThan(0);
		for (const region of regions) {
			expect(region.type).toBe("text");
			expect("annotationSource" in region).toBe(false);
			expect(region.zIndex).toBeGreaterThan(1000);
		}
	});

	it("carries the settings' style onto every region", () => {
		const settings = {
			...ON,
			color: "#fde047",
			fontSize: 40,
			textAlign: "left" as const,
			backgroundEnabled: false,
		};
		const [region] = captionCuesToTextRegions(deriveCaptionCues(doc(), settings, {}), settings);
		expect(region.style).toMatchObject({
			color: "#fde047",
			fontSize: 40,
			textAlign: "left",
			backgroundColor: "transparent",
		});
	});
});

describe("caption translations", () => {
	it("stores a translation without touching the transcript", () => {
		const before = doc();
		const after = putCaptionTranslation(before, {
			language: "fr",
			label: "Français",
			assetId: "asset-1",
			segments: { seg_1: "bonjour" },
		});
		expect(after.transcripts).toEqual(before.transcripts);
		expect(getCaptionTranslations(after).fr.byAsset["asset-1"]).toEqual({ seg_1: "bonjour" });
	});

	it("merges a second run into the same language layer", () => {
		let d = putCaptionTranslation(doc(), {
			language: "fr",
			label: "Français",
			assetId: "asset-1",
			segments: { seg_1: "bonjour" },
		});
		d = putCaptionTranslation(d, {
			language: "fr",
			label: "Français",
			assetId: "asset-1",
			segments: { seg_2: "au revoir" },
		});
		expect(getCaptionTranslations(d).fr.byAsset["asset-1"]).toEqual({
			seg_1: "bonjour",
			seg_2: "au revoir",
		});
	});

	it("reports only the segments still missing a translation", () => {
		const d = putCaptionTranslation(doc(), {
			language: "fr",
			label: "Français",
			assetId: "asset-1",
			segments: { seg_1: "bonjour" },
		});
		const pending = untranslatedSegments(transcript(), getCaptionTranslations(d), "fr");
		expect(pending.map((s) => s.id)).toEqual(["seg_2"]);
		expect(translationCoverage(transcript(), getCaptionTranslations(d), "fr")).toEqual({
			translated: 1,
			total: 2,
		});
	});

	it("removing a language leaves the transcript and other languages intact", () => {
		let d = putCaptionTranslation(doc(), {
			language: "fr",
			label: "Français",
			assetId: "asset-1",
			segments: { seg_1: "bonjour" },
		});
		d = putCaptionTranslation(d, {
			language: "es",
			label: "Español",
			assetId: "asset-1",
			segments: { seg_1: "hola" },
		});
		const after = removeCaptionTranslation(d, "fr");
		expect(Object.keys(getCaptionTranslations(after))).toEqual(["es"]);
		expect(after.transcripts).toEqual(doc().transcripts);
	});
});
