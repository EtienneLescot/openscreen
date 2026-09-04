import { describe, expect, it } from "vitest";
import type { AxcutDocument, AxcutTranscript } from "../schema";
import { captionCuesToTextRegions, deriveCaptionCues } from "./cues";
import type { CaptionSettings } from "./settings";
import {
	captionBackgroundCss,
	captionBoxRect,
	captionSafeColumn,
	DEFAULT_CAPTION_SETTINGS,
	defaultCaptionInsetX,
	defaultCaptionInsetY,
	getCaptionSettings,
	patchCaptionSettings,
} from "./settings";
import {
	captionTranslationUnits,
	getCaptionTranslations,
	putCaptionTranslation,
	removeCaptionTranslation,
	translationCoverage,
	untranslatedUnits,
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
		...overrides,
	} as AxcutDocument;
}

const ON = { ...DEFAULT_CAPTION_SETTINGS, enabled: true };
const LANDSCAPE = 16 / 9;
const PORTRAIT = 9 / 16;

/** Where the DRAWN block's edges land, given the box and the edge it is pinned to.
 *  The renderers put the block flush against the anchored edge of the box, so this
 *  is the same arithmetic the rasterizers do — expressed once, here, so the tests
 *  assert the thing the viewer sees rather than the box it lives in. */
function drawnEdges(settings: typeof ON, aspect: number, blockHeightPct: number) {
	const box = captionBoxRect(settings, aspect);
	const top = box.verticalAlign === "bottom" ? box.y + box.height - blockHeightPct : box.y;
	return { top, bottom: top + blockHeightPct };
}

describe("caption settings", () => {
	it("defaults to hidden so an existing project doesn't sprout captions on upgrade", () => {
		expect(getCaptionSettings(doc()).enabled).toBe(false);
	});

	it("round-trips a patch through the legacyEditor envelope", () => {
		const next = patchCaptionSettings(doc(), { enabled: true, fontSize: 44, insetY: 12 });
		expect(getCaptionSettings(next)).toMatchObject({ enabled: true, fontSize: 44, insetY: 12 });
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

	it("folds the opacity into the background colour, and reports 'transparent' when off", () => {
		expect(
			captionBackgroundCss({ ...ON, backgroundColor: "#10b981", backgroundOpacity: 0.5 }),
		).toBe("rgba(16, 185, 129, 0.5)");
		expect(captionBackgroundCss({ ...ON, backgroundEnabled: false })).toBe("transparent");
	});
});

describe("caption anchoring", () => {
	// THE invariant of the redesign, asserted as a property rather than as numbers.
	// The old model placed a fixed 22% band and let each renderer centre the ink in it,
	// so the drawn block's edges moved with the font size, the background, the wrap —
	// which is why widening the band shifted the caption vertically and why the offset
	// had to be a signed number clamped against an estimate.
	it("pins the anchored edge for every font size, background state and inset", () => {
		for (const anchorV of ["bottom", "top"] as const) {
			for (const insetY of [0, 0.5, 5, 12.5, 33.3, 50]) {
				for (const fontSize of [12, 48, 120, 200]) {
					for (const backgroundEnabled of [true, false]) {
						const settings = { ...ON, anchorV, insetY, fontSize, backgroundEnabled };
						const box = captionBoxRect(settings, LANDSCAPE);
						const pinned = anchorV === "bottom" ? box.y + box.height : box.y;
						expect(pinned).toBeCloseTo(anchorV === "bottom" ? 100 - insetY : insetY, 6);
						// And the box itself never leaves the frame, so there is no overhang to
						// compensate for and no negative `y` for the schema to reject.
						expect(box.y).toBeGreaterThanOrEqual(-1e-9);
						expect(box.y + box.height).toBeLessThanOrEqual(100 + 1e-9);
					}
				}
			}
		}
	});

	it("holds the anchored edge still while the block grows — the complaint this fixes", () => {
		// One line vs three, same settings: the anchored edge must not move. Under the
		// old geometry the block was centred, so BOTH edges moved and the subtitle
		// visibly drifted whenever its text wrapped.
		const bottom = { ...ON, anchorV: "bottom" as const, insetY: 5 };
		expect(drawnEdges(bottom, LANDSCAPE, 6).bottom).toBeCloseTo(
			drawnEdges(bottom, LANDSCAPE, 18).bottom,
			6,
		);
		const top = { ...ON, anchorV: "top" as const, insetY: 5 };
		expect(drawnEdges(top, LANDSCAPE, 6).top).toBeCloseTo(drawnEdges(top, LANDSCAPE, 18).top, 6);
	});

	it("tells the compositor which edge to pin", () => {
		expect(captionBoxRect({ ...ON, anchorV: "bottom" }, LANDSCAPE).verticalAlign).toBe("bottom");
		expect(captionBoxRect({ ...ON, anchorV: "top" }, LANDSCAPE).verticalAlign).toBe("top");
	});

	it("keeps the vertical placement independent of everything on the other axis", () => {
		// The old `width` slider moved the caption vertically, because a narrower band
		// wrapped more, and more lines grew a centred block in both directions.
		const base = { ...ON, anchorV: "bottom" as const, insetY: 8 };
		const pinned = (s: typeof base) => {
			const b = captionBoxRect(s, LANDSCAPE);
			return b.y + b.height;
		};
		expect(pinned({ ...base, anchorH: "left", insetX: 0 })).toBeCloseTo(pinned(base), 6);
		expect(pinned({ ...base, anchorH: "right", insetX: 25 })).toBeCloseTo(pinned(base), 6);
	});
});

describe("caption horizontal anchoring", () => {
	it("pins the named edge, and centres between the column when asked to", () => {
		const column = captionSafeColumn(LANDSCAPE);

		const left = captionBoxRect({ ...ON, anchorH: "left", insetX: 4 }, LANDSCAPE);
		expect(left.x).toBeCloseTo(4, 6);

		const right = captionBoxRect({ ...ON, anchorH: "right", insetX: 4 }, LANDSCAPE);
		expect(right.x + right.width).toBeCloseTo(96, 6);

		const centre = captionBoxRect({ ...ON, anchorH: "center" }, LANDSCAPE);
		expect(centre.x).toBeCloseTo((100 - column.width) / 2, 6);
		expect(centre.width).toBeCloseTo(column.width, 6);
	});

	it("ignores insetX entirely when centred — there is no edge to measure from", () => {
		const a = captionBoxRect({ ...ON, anchorH: "center", insetX: 0 }, LANDSCAPE);
		const b = captionBoxRect({ ...ON, anchorH: "center", insetX: 25 }, LANDSCAPE);
		expect(a).toEqual(b);
	});

	it("narrows the box rather than pushing it off-frame", () => {
		// A 90%-wide portrait column pushed 25% in would otherwise end at 115%.
		const box = captionBoxRect({ ...ON, anchorH: "left", insetX: 25 }, PORTRAIT);
		expect(box.x + box.width).toBeLessThanOrEqual(100 + 1e-9);
		expect(box.width).toBeCloseTo(75, 6);
	});
});

describe("caption safe column", () => {
	it("follows the BBC line-length table, and stays inside title-safe", () => {
		expect(captionSafeColumn(LANDSCAPE)).toEqual({ x: 16, width: 68 });
		expect(captionSafeColumn(PORTRAIT)).toEqual({ x: 5, width: 90 });
		for (const aspect of [LANDSCAPE, 1, PORTRAIT]) {
			const c = captionSafeColumn(aspect);
			expect(c.x + c.width).toBeCloseTo(100 - c.x, 6);
		}
	});

	it("defaults a vertical export well clear of the platform chrome", () => {
		// The landscape values are eyeballed against the editor's default padding; the
		// portrait one answers a different question — TikTok/Reels/Shorts draw their own
		// chrome over the bottom eighth of a 9:16 export, so the same 1.5% would put the
		// caption behind a UI.
		expect(defaultCaptionInsetY(LANDSCAPE)).toBe(1.5);
		expect(defaultCaptionInsetX(LANDSCAPE)).toBe(10);
		expect(defaultCaptionInsetY(PORTRAIT)).toBeGreaterThan(10);
	});
});

describe("migrating a pre-anchor document", () => {
	// The rule is reproduce the PIXELS, not the fields: the old band was a fixed 22%
	// box with the ink centred in it, so where the caption was drawn is recoverable,
	// and the nearer edge becomes the anchor. A migrated project must not visibly move.
	const legacy = (captions: Record<string, unknown>) =>
		getCaptionSettings(
			doc({ legacyEditor: { captions: { enabled: true, ...captions } } } as Partial<AxcutDocument>),
			LANDSCAPE,
		);

	it("keeps a default bottom caption at the bottom", () => {
		const s = legacy({ verticalPosition: "bottom", offsetY: 0 });
		expect(s.anchorV).toBe("bottom");
		// The old band sat at y=75 and its ink — 48px × (2 lines × 1.4em + 0.2em of
		// plate) = 13.33% of frame height — was centred in the 22% box, so the drawn
		// block ended at 92.67%. The migrated inset must reproduce exactly that edge.
		expect(s.insetY).toBeCloseTo(7.333, 2);
	});

	it("flips the anchor for a caption that had been dragged to the top", () => {
		const s = legacy({ verticalPosition: "bottom", offsetY: -79.333 });
		expect(s.anchorV).toBe("top");
		expect(s.insetY).toBeCloseTo(0, 1);
	});

	it("keeps a top caption at the top", () => {
		const s = legacy({ verticalPosition: "top", offsetY: 0 });
		expect(s.anchorV).toBe("top");
	});

	it("maps the old band+textAlign pair onto the single horizontal anchor", () => {
		expect(legacy({ width: 80, offsetX: 0, textAlign: "center" }).anchorH).toBe("center");
		expect(legacy({ width: 40, offsetX: -30, textAlign: "left" }).anchorH).toBe("left");
		expect(legacy({ width: 40, offsetX: 30, textAlign: "right" }).anchorH).toBe("right");
	});

	it("reproduces the horizontal distance too, instead of snapping to the frame edge", () => {
		// The old band's own left edge, not 0: `width: 40` centres its anchor at 30, so
		// an offset of −25 put the band at 5% — and that is where the caption must stay.
		const left = legacy({ width: 40, offsetX: -25, textAlign: "left" });
		expect(left.anchorH).toBe("left");
		expect(left.insetX).toBeCloseTo(5, 6);

		// Mirrored: the band ends at 95%, so the distance from the right edge is 5%.
		const right = legacy({ width: 40, offsetX: 25, textAlign: "right" });
		expect(right.anchorH).toBe("right");
		expect(right.insetX).toBeCloseTo(5, 6);
	});

	it("lets a stored anchor win, so the migration runs once and then stays out of the way", () => {
		const s = legacy({ verticalPosition: "top", offsetY: 0, anchorV: "bottom", insetY: 9 });
		expect(s.anchorV).toBe("bottom");
		expect(s.insetY).toBe(9);
	});

	it("gives a document with no caption settings the aspect-appropriate default", () => {
		expect(getCaptionSettings(doc(), LANDSCAPE).insetY).toBe(1.5);
		expect(getCaptionSettings(doc(), LANDSCAPE).insetX).toBe(10);
		expect(getCaptionSettings(doc(), PORTRAIT).insetY).toBe(12.5);
	});

	it("freezes the PORTRAIT defaults on the first write to a vertical project", () => {
		// The first patch is what materialises the defaults into the document, so it
		// has to know the aspect too. Patching without it stored the landscape inset
		// into a 9:16 project and the stored value then won for good — putting the
		// caption under the platform's own chrome, the exact failure the
		// aspect-derived default exists to prevent.
		const first = patchCaptionSettings(doc(), { enabled: true }, PORTRAIT);
		const stored = (first.legacyEditor as { captions: CaptionSettings }).captions;
		expect(stored.insetY).toBe(12.5);
		expect(stored.insetX).toBe(defaultCaptionInsetX(PORTRAIT));

		// And it stays: a later patch reads what is stored rather than re-deriving.
		const later = patchCaptionSettings(first, { fontSize: 60 }, PORTRAIT);
		expect(getCaptionSettings(later, PORTRAIT).insetY).toBe(12.5);
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

	it("shows the translation for a translated unit and the original for the rest", () => {
		const translations = {
			fr: {
				language: "fr",
				label: "Français",
				updatedAt: "2026-01-01T00:00:00.000Z",
				byAsset: { "asset-1": { "u:seg_1": "bonjour mon ami" } },
			},
		};
		const cues = deriveCaptionCues(doc(), { ...ON, language: "fr" }, translations);
		const text = cues.map((c) => c.text).join(" | ");
		expect(text).toContain("bonjour");
		// seg_2 has no translation, so its original words still play.
		expect(text).toContain("goodbye");
	});

	it("keeps the translated line inside its own unit's span", () => {
		const translations = {
			fr: {
				language: "fr",
				label: "Français",
				updatedAt: "",
				byAsset: { "asset-1": { "u:seg_1": "bonjour", "u:seg_2": "au revoir" } },
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
		const regions = captionCuesToTextRegions(deriveCaptionCues(doc(), ON, {}), ON, LANDSCAPE);
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
			anchorH: "left" as const,
			backgroundEnabled: false,
		};
		const [region] = captionCuesToTextRegions(
			deriveCaptionCues(doc(), settings, {}),
			settings,
			LANDSCAPE,
		);
		expect(region.style).toMatchObject({
			color: "#fde047",
			fontSize: 40,
			// One horizontal control: the anchor IS the text alignment the rasterizer gets.
			textAlign: "left",
			backgroundColor: "transparent",
		});
	});

	it("tells the compositor which edge to pin, on every region", () => {
		// Without this the rasterizers centre the block in the box, which is the whole
		// bug: the caption would drift vertically every time its text wrapped.
		const settings = { ...ON, anchorV: "top" as const };
		const regions = captionCuesToTextRegions(
			deriveCaptionCues(doc(), settings, {}),
			settings,
			LANDSCAPE,
		);
		expect(regions.length).toBeGreaterThan(0);
		for (const region of regions) expect(region.verticalAlign).toBe("top");
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

	it("reports only the units still missing a translation", () => {
		const d = putCaptionTranslation(doc(), {
			language: "fr",
			label: "Français",
			assetId: "asset-1",
			segments: { "u:seg_1": "bonjour" },
		});
		const pending = untranslatedUnits(transcript(), getCaptionTranslations(d), "fr");
		expect(pending.map((u) => u.id)).toEqual(["u:seg_2"]);
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

// The bug this suite exists for: a Whisper transcript stores ONE SEGMENT PER
// WORD (see document/transcribe.ts). Translating and laying out per segment
// therefore translated word by word and put one word on screen at a time.
function wordPerSegmentTranscript(): AxcutTranscript {
	const tokens = ["Bienvenue", "dans", "OpenScreen", "le", "logiciel", "de", "capture"];
	const segments: AxcutTranscript["segments"] = [];
	const words: AxcutTranscript["words"] = [];
	let t = 0;
	tokens.forEach((text, i) => {
		const id = `seg_${i + 1}`;
		const wordId = `w_${i + 1}`;
		words.push({ id: wordId, segmentId: id, startSec: t, endSec: t + 0.4, text });
		segments.push({
			id,
			kind: "speech",
			startSec: t,
			endSec: t + 0.4,
			text,
			wordIds: [wordId],
		});
		t += 0.45;
	});
	return { assetId: "asset-1", language: "fr", segments, words };
}

function wordPerSegmentDoc(): AxcutDocument {
	return doc({ transcripts: [wordPerSegmentTranscript()] } as Partial<AxcutDocument>);
}

describe("captionTranslationUnits", () => {
	it("joins a word-per-segment transcript into phrase-sized units", () => {
		const units = captionTranslationUnits(wordPerSegmentTranscript());
		expect(units).toHaveLength(1);
		expect(units[0].text).toBe("Bienvenue dans OpenScreen le logiciel de capture");
		expect(units[0].segmentIds).toHaveLength(7);
	});

	it("starts a new unit after a real pause", () => {
		const t = wordPerSegmentTranscript();
		// Push the last two words out past the pause threshold.
		t.segments[5].startSec += 2;
		t.segments[5].endSec += 2;
		t.segments[6].startSec += 2;
		t.segments[6].endSec += 2;
		expect(captionTranslationUnits(t)).toHaveLength(2);
	});

	it("keys units so they cannot be confused with a bare segment id", () => {
		const units = captionTranslationUnits(wordPerSegmentTranscript());
		expect(units[0].id).toBe("u:seg_1");
		expect(units[0].id).not.toBe(units[0].segmentIds[0]);
	});
});

describe("translated caption layout", () => {
	const withTranslation = (text: string) => ({
		fr2: {
			language: "fr2",
			label: "Test",
			updatedAt: "",
			byAsset: { "asset-1": { "u:seg_1": text } },
		},
	});

	it("groups translated words into lines instead of one word per line", () => {
		const translations = withTranslation("Welcome to OpenScreen the screen capture app");
		const cues = deriveCaptionCues(
			wordPerSegmentDoc(),
			{ ...ON, language: "fr2", minWordsPerLine: 2, maxWordsPerLine: 4 },
			translations,
		);

		expect(cues.length).toBeGreaterThan(0);
		for (const cue of cues) {
			expect(cue.text.split(" ").length).toBeGreaterThan(1);
			expect(cue.text.split(" ").length).toBeLessThanOrEqual(4);
		}
		expect(cues.map((c) => c.text).join(" ")).toBe("Welcome to OpenScreen the screen capture app");
	});

	it("lays the original out the same way, so switching language only swaps text", () => {
		const settings = { ...ON, minWordsPerLine: 2, maxWordsPerLine: 4 };
		const original = deriveCaptionCues(wordPerSegmentDoc(), settings, {});
		for (const cue of original) {
			expect(cue.text.split(" ").length).toBeGreaterThan(1);
		}
		const translated = deriveCaptionCues(
			wordPerSegmentDoc(),
			{ ...settings, language: "fr2" },
			withTranslation("Welcome to OpenScreen the screen capture app"),
		);
		// Same word count in, same number of lines out.
		expect(translated).toHaveLength(original.length);
	});

	it("keeps translated cues inside the unit's own span", () => {
		const cues = deriveCaptionCues(
			wordPerSegmentDoc(),
			{ ...ON, language: "fr2" },
			withTranslation("Welcome to OpenScreen the screen capture app"),
		);
		const unit = captionTranslationUnits(wordPerSegmentTranscript())[0];
		expect(cues[0].startMs).toBeGreaterThanOrEqual(Math.round(unit.startSec * 1000));
		expect(cues.at(-1)?.endMs).toBeLessThanOrEqual(Math.round(unit.endSec * 1000) + 1);
	});

	it("falls back to the original words for a unit with no translation", () => {
		const cues = deriveCaptionCues(wordPerSegmentDoc(), { ...ON, language: "nope" }, {});
		expect(cues.map((c) => c.text).join(" ")).toBe(
			"Bienvenue dans OpenScreen le logiciel de capture",
		);
	});
});

// ─── Captions across an added word's pause ───────────────────────
// The pause lengthens the ruler, so every line after it slides — and the line the pause
// exists FOR has to stay on screen through it rather than going dark over the one moment
// an added word is there for.

describe("captions and a pause", () => {
	function withPause(): AxcutDocument {
		const base = doc();
		return {
			...base,
			timeline: {
				...base.timeline,
				insertRanges: [
					{
						id: "ins_1",
						assetId: "asset-1",
						// Inside "hello there friend" (0–2s), so the line covers it.
						atSec: 1.2,
						durationSec: 0.5,
						wordId: "synth_1",
						reason: "",
						origin: "user" as const,
					},
				],
			},
		};
	}

	it("keeps the covering line up through the pause instead of cutting it short", () => {
		const before = deriveCaptionCues(doc(), ON, {});
		const after = deriveCaptionCues(withPause(), ON, {});
		const line = (cues: typeof before) => cues.find((cue) => cue.text.includes("hello"));
		expect(line(after)?.startMs).toBe(line(before)?.startMs);
		// Half a second longer: exactly the pause it now spans.
		expect((line(after)?.endMs ?? 0) - (line(before)?.endMs ?? 0)).toBe(500);
	});

	it("slides everything after the pause along by it", () => {
		const before = deriveCaptionCues(doc(), ON, {});
		const after = deriveCaptionCues(withPause(), ON, {});
		const later = (cues: typeof before) => cues.find((cue) => cue.text.includes("goodbye"));
		expect((later(after)?.startMs ?? 0) - (later(before)?.startMs ?? 0)).toBe(500);
	});

	it("is unchanged when the project has no pauses", () => {
		expect(deriveCaptionCues(doc(), ON, {})).toEqual(deriveCaptionCues(doc(), ON, {}));
	});
});

// ─── An added word is spoken over the media it inserted ─────────────────────
// Lines are grouped by word count and by silences, in SOURCE time. An added word barely
// takes up source time — the seconds it is spoken in are the INSERTION that follows it —
// so it was swallowed into the line of the words before it and inherited their start. On
// screen the added words appeared while the recorded picture was still playing, a whole
// insertion early (issue #560).

describe("a caption line never mixes recorded words with added ones", () => {
	function docWithAddedWord(): AxcutDocument {
		const t = transcript();
		// "really" typed in after "friend", which ends at source 2. An added word takes up NO
		// source time — the seconds it is spoken in are the insertion it buys, which is how
		// the real documents store it — so its span is degenerate at the moment it follows.
		// The next recorded word begins at the added word's own second — the shape every
		// real document has, because an added word is anchored at the END of the word it
		// follows and the transcript's next word starts there.
		t.words = [
			...t.words.slice(0, 3),
			{
				id: "synth_1",
				segmentId: "seg_1",
				startSec: 2,
				endSec: 2,
				text: "really",
				source: "synth",
				// biome-ignore lint/suspicious/noExplicitAny: fixture, not a schema exercise
			} as any,
			// Begins at the added word's own second — that adjacency is the whole defect.
			...t.words.slice(3).map((w) => ({ ...w, startSec: w.startSec - 2, endSec: w.endSec - 2 })),
		];
		const base = doc();
		return {
			...base,
			transcripts: [t],
			timeline: {
				...base.timeline,
				clips: [{ ...base.timeline.clips[0], timelineEndSec: 12 }],
				insertRanges: [
					{
						id: "i1",
						assetId: "asset-1",
						atSec: 2,
						durationSec: 2,
						wordId: "synth_1",
						reason: "",
						origin: "user",
					},
					// biome-ignore lint/suspicious/noExplicitAny: fixture, not a schema exercise
				] as any,
			},
		};
	}

	const settings: CaptionSettings = { ...DEFAULT_CAPTION_SETTINGS, enabled: true };

	it("gives the added word its own cue, starting where the recorded words stop", () => {
		const cues = deriveCaptionCues(docWithAddedWord(), settings, {});
		const added = cues.filter((c) => c.text.includes("really"));
		expect(added).toHaveLength(1);
		// It must not carry the recorded words with it — that is the whole defect.
		expect(added[0].text.toLowerCase()).not.toContain("hello");
		// And it opens at the recorded words' end, not at their start.
		expect(added[0].startMs).toBeGreaterThanOrEqual(2000);
	});

	it("lays the three lines out end to end across the insertion", () => {
		// The whole rule in one assertion set: the recorded line stops where the added one
		// begins, the added one spans the media it bought, and what follows is pushed along
		// by exactly that length.
		const cues = deriveCaptionCues(docWithAddedWord(), settings, {});
		const recorded = cues.find((c) => c.text.toLowerCase().includes("hello"));
		const added = cues.find((c) => c.text.includes("really"));
		const after = cues.find((c) => c.text.includes("goodbye"));
		expect(recorded).toBeDefined();
		expect(added).toBeDefined();
		expect(after).toBeDefined();
		// The insertion opens at ruler 2000 and runs 2000ms. Three consecutive facts:
		// the recorded line STOPS there, the added line COVERS it, and what follows is
		// pushed along by exactly its length.
		expect(recorded?.endMs).toBe(2000);
		expect(added?.startMs).toBe(2000);
		expect(added?.endMs).toBe(4000);
		expect(after?.startMs).toBe(4000);
	});

	it("leaves the recorded line ending before the added one begins", () => {
		const cues = deriveCaptionCues(docWithAddedWord(), settings, {});
		const recorded = cues.find((c) => c.text.toLowerCase().includes("hello"));
		const added = cues.find((c) => c.text.includes("really"));
		expect(recorded).toBeDefined();
		expect(added).toBeDefined();
		expect(recorded?.text).not.toContain("really");
		expect(added?.startMs ?? 0).toBeGreaterThanOrEqual((recorded?.startMs ?? 0) + 1);
	});

	it("never prints two cues at once", () => {
		// The symptom this whole rule exists for: the recorded line that follows an added
		// word begins at the added word's own source second, so mapped before the insertion
		// it landed inside it and the two were drawn on top of each other.
		const cues = [...deriveCaptionCues(docWithAddedWord(), settings, {})].sort(
			(a, b) => a.startMs - b.startMs,
		);
		expect(cues.length).toBeGreaterThan(1);
		for (const [i, cue] of cues.slice(0, -1).entries()) {
			expect(cue.endMs).toBeLessThanOrEqual(cues[i + 1].startMs);
		}
	});

	it("changes nothing when the transcript has no added words", () => {
		const before = deriveCaptionCues(doc(), settings, {});
		expect(before.some((c) => c.text.toLowerCase().includes("hello"))).toBe(true);
		expect(before.every((c) => !c.text.includes("really"))).toBe(true);
	});
});
