// @vitest-environment jsdom
//
// The output-gain slider is the only audio setting this editor still has, and it survived
// review precisely because it is exactly reproducible: the same `10 ** (dB / 20)` scalar
// drives a GainNode in the preview and a per-sample multiply in `finish_audio`. The timeline
// waveform is the only place that claim is VISIBLE, so these tests pin it there.
//
// The export's half of the same claim lives in crates/compositor/src/audio.rs
// (`output_trim_is_the_same_scalar_the_preview_applies` and
// `output_is_clipped_to_full_scale_and_keeps_its_length`). Together they are what makes
// "the waveform shows what you will hear" checkable rather than asserted.
import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

const VIEWPORT_PX = 900;
const CLIP_SEC = 10;
/** ClipWaveform's own rule: one bar per ~125ms, floored at 20 and capped at 400. */
const BAR_COUNT = Math.min(400, Math.max(20, Math.round(CLIP_SEC * 8)));

const LOUD = 0.5;
const QUIET = 0.1;

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

// Peaks are the SOURCE file's amplitude and never carry the gain — they are disk-cached
// under path+size+mtime, so putting gain in them would be a cache-key redesign for what is
// a scalar multiply. The first half of the recording is loud, the second half quiet, which
// is what lets one render distinguish "scaled" from "clamped".
vi.mock("@/hooks/useAudioPeaks", () => ({
	useAudioPeaks: () => {
		const blocks = 200;
		const peaks = new Float32Array(blocks * 2);
		for (let b = 0; b < blocks; b++) {
			const amp = b < blocks / 2 ? LOUD : QUIET;
			peaks[b * 2] = -amp;
			peaks[b * 2 + 1] = amp;
		}
		return peaks;
	},
}));

let gainDb = 0;
vi.mock("@/lib/ai-edition/store/useEditorSettings", () => ({
	useEditorSettings: () => ({
		settings: { audioGainDb: gainDb },
		hasDocument: true,
		set: vi.fn(),
		setLive: vi.fn(),
		commit: vi.fn(),
	}),
}));

import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { V4Timeline } from "./V4Timeline";

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {
			/* noop */
		}
		unobserve() {
			/* noop */
		}
		disconnect() {
			/* noop */
		}
	} as unknown as typeof ResizeObserver;
	// jsdom reports 0 for every box, which would leave the timeline "unmeasured".
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get: () => VIEWPORT_PX,
	});
	Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
		configurable: true,
		value: () => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: VIEWPORT_PX,
			bottom: 100,
			width: VIEWPORT_PX,
			height: 100,
			toJSON() {
				/* unused by the component */
			},
		}),
	});
});

/** Bar heights as the DOM carries them, in document order. */
function renderBars(atGainDb: number): string[] {
	gainDb = atGainDb;
	const tl = {
		clips: [
			{
				id: "c0",
				assetId: "a1",
				timelineStartSec: 0,
				timelineEndSec: CLIP_SEC,
				sourceStartSec: 0,
				sourceEndSec: CLIP_SEC,
			},
		],
		assets: [{ id: "a1", label: "rec", durationSec: CLIP_SEC }],
		annotationRegions: [],
		speedRegions: [],
		cameraFullscreenRegions: [],
		zoomRegions: [],
		trimRanges: [],
		selection: null,
		multiSelection: [],
		clipSelection: null,
		clearSelection: vi.fn(),
		selectRegion: vi.fn(),
		selectClip: vi.fn(),
		updateAnnotationSpan: vi.fn(async () => undefined),
		addZoom: vi.fn(async () => undefined),
	};
	const view = render(
		<V4Timeline
			tl={tl as unknown as ReturnType<typeof useTimeline>}
			videoSources={[{ id: "a1", src: "file:///tmp/rec.mp4", label: "rec" }]}
			setCurrentTime={vi.fn()}
			playing={false}
			onTogglePlay={vi.fn()}
			onPrevClip={vi.fn()}
			onNextClip={vi.fn()}
			onEditClip={vi.fn()}
		/>,
	);
	const bars = Array.from(
		document.querySelectorAll<HTMLElement>('[class*="tlWave"] span'),
		(span) => span.style.height,
	);
	view.unmount();
	return bars;
}

describe("ClipWaveform output gain", () => {
	it("draws the source amplitude when the gain is unity", () => {
		const bars = renderBars(0);
		expect(bars).toHaveLength(BAR_COUNT);
		expect(bars[0]).toBe("50%");
		expect(bars[BAR_COUNT - 1]).toBe("10%");
	});

	it("scales quiet bars and flattens loud ones when the gain is boosted", () => {
		// +12 dB is x3.98. The loud half would reach 199% — the number the old code
		// computed and merely hid behind the clip's `overflow` — and pins flat at 100%
		// instead, because `finish_audio` clamps the samples it writes to +/-1. The quiet
		// half is nowhere near full scale, so it just gets louder. That difference between
		// the two halves IS clipping, drawn.
		const bars = renderBars(12);
		expect(bars[0]).toBe("100%");
		expect(bars[BAR_COUNT - 1]).toBe("40%");
	});

	it("shrinks the bars when the gain is cut, down to the empty-clip floor", () => {
		// -12 dB is x0.251. The quiet half lands at 2.5%, below the 8% floor that exists so
		// an empty clip still reads as a clip — the floor is not amplitude and is not scaled.
		const bars = renderBars(-12);
		expect(bars[0]).toBe("13%");
		expect(bars[BAR_COUNT - 1]).toBe("8%");
	});
});
