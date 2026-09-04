// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The regression under test is geometric, so the environment has to have a size:
// jsdom reports 0 for every box, which would leave `pxPerSec` at 0 (the
// "unmeasured" case) and hide exactly the thing being checked.
const VIEWPORT_PX = 900;
const TOTAL_SEC = 1800; // a 30-minute recording, as in the report

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
// The audio lane's pill renders a ClipWaveform; no decode in this geometry suite.
vi.mock("@/hooks/useAudioPeaks", () => ({ useAudioPeaks: () => null }));

import { ShortcutsProvider } from "@/contexts/ShortcutsContext";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { DEFAULT_SHORTCUTS, formatBinding } from "@/lib/shortcuts";
import { V4Timeline } from "./V4Timeline";

beforeAll(() => {
	globalThis.ResizeObserver = class {
		// jsdom has none, and the width it would report is stubbed below anyway.
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

function clip(startSec: number, endSec: number) {
	return {
		id: `c@${startSec}`,
		assetId: "a1",
		timelineStartSec: startSec,
		timelineEndSec: endSec,
		sourceStartSec: 0,
		sourceEndSec: endSec - startSec,
	};
}

/** The asset every clip above points at. No `cameraTrack`: this recording has no webcam,
 *  which is what the Full Camera button is gated on. */
const NO_CAMERA_ASSET = { id: "a1", label: "rec", durationSec: TOTAL_SEC };

/** By default one 30-minute clip carrying a single one-second annotation. */
function renderTimeline(
	clips = [clip(0, TOTAL_SEC)],
	annotation = { id: "ann1", startMs: 10_000, endMs: 11_000 },
	assets: Array<Record<string, unknown>> = [NO_CAMERA_ASSET],
) {
	const tl = {
		clips,
		// Marks for added words are read straight off the transcript (see the pane's
		// amber words) — no project here has any.
		transcripts: [],
		assets,
		annotationRegions: [annotation],
		speedRegions: [],
		cameraFullscreenRegions: [],
		zoomRegions: [],
		trimRanges: [],
		selection: null,
		multiSelection: [],
		clipSelection: null,
		audioTracks: [],
		selectedAudioTrackId: null,
		selectAudioTrack: vi.fn(),
		clearSelection: vi.fn(),
		selectRegion: vi.fn(),
		selectClip: vi.fn(),
		updateAnnotationSpan: vi.fn(async () => {
			/* the drag only awaits it */
		}),
		addZoom: vi.fn(async () => {
			/* the toolbar only awaits it */
		}),
	};
	render(
		<ShortcutsProvider>
			<V4Timeline
				// Only the members the lanes and the clip row read are mocked; the prop
				// stays typed as the real API rather than widened to `any` (AGENTS.md).
				tl={tl as unknown as ReturnType<typeof useTimeline>}
				setCurrentTime={vi.fn()}
				playing={false}
				onTogglePlay={vi.fn()}
				onPrevClip={vi.fn()}
				onNextClip={vi.fn()}
				onEditClip={vi.fn()}
				onAddVoiceover={vi.fn()}
			/>
		</ShortcutsProvider>,
	);
	return {
		pill: screen.getByTitle("toolbar.newAnnotation"),
		clipEls: Array.from(document.querySelectorAll<HTMLElement>("[data-clip-id]")),
		tl,
	};
}

/** Drag a handle by `dxPx`. The move/up listeners live on `window`, so the drag
 *  is driven by pointer deltas alone — the handle may re-mount under it. */
function dragHandle(handle: Element, dxPx: number) {
	fireEvent.pointerDown(handle, { clientX: 0 });
	window.dispatchEvent(new MouseEvent("pointermove", { clientX: dxPx }));
	window.dispatchEvent(new MouseEvent("pointerup", { clientX: dxPx }));
}

/** Ctrl+wheel up = zoom in; the handler is a native listener, so dispatch real events.
 *  Takes the target element so a test can prove the listener isn't confined to the
 *  lanes — it fires from wherever in the pane the cursor happens to be. */
function wheelZoomOn(el: HTMLElement, notches: number) {
	for (let i = 0; i < notches; i++) {
		fireEvent.wheel(el, { ctrlKey: true, deltaY: -100, clientX: 0 });
	}
}
function zoomIn(notches: number) {
	wheelZoomOn(document.querySelector("[class*=tlTracks]") as HTMLElement, notches);
}

describe("V4Timeline lane pills", () => {
	it("draws a pill exactly as wide as its region, at any zoom", () => {
		// 1 s of 1800 s. The old `Math.max(1.5, …)` floor drew this as 1.5% — 27
		// seconds of ruler for a one-second annotation — and did it at every zoom,
		// since the floor was a percentage of the timeline rather than of the screen.
		const { pill } = renderTimeline();
		const expected = (1 / TOTAL_SEC) * 100;
		expect(Number.parseFloat(pill.style.width)).toBeCloseTo(expected, 6);

		// The canvas is what scales with zoom, so the pill's share of it must not
		// move at all — only the chrome inside it may react (below).
		zoomIn(40);
		expect(Number.parseFloat(pill.style.width)).toBeCloseTo(expected, 6);
	});

	it("keeps both resize handles reachable when the pill is thinner than they are", () => {
		// 0.5 px wide at this zoom: the handles cannot sit inside the box without
		// swallowing it whole, so they mount outside it and the body stays a move
		// target. Resizing a hairline stays possible — it is the pointer precision
		// that is coarse there, not the affordance that is missing.
		const { pill } = renderTimeline();
		const [left, right] = Array.from(pill.querySelectorAll("span"));
		expect(left.style.left).toBe("-10px");
		expect(right.style.right).toBe("-10px");
		// Nothing legible fits, so no icon/label is rendered (the title attribute
		// still carries the value on hover).
		expect(pill.textContent).toBe("");

		// Zoomed to the 50× ceiling the same second is 25 px wide and hosts its own
		// chrome again.
		zoomIn(40);
		expect(left.style.left).toBe("0px");
		expect(right.style.right).toBe("0px");
	});

	it("grows and shrinks a hairline pill from its outside handles", () => {
		// Growing is unbounded by the pill's own size: 90 px right of a 900 px canvas
		// is a tenth of the 1800 s timeline, so the 10–11 s annotation ends at 191 s.
		// The chrome re-flows inside the box as it crosses PILL_HANDLES_MIN_PX
		// mid-drag, which the gesture never notices — the deltas come from the
		// pointer and the listeners live on `window`, not on the handle.
		const { pill, tl } = renderTimeline();
		const [left, right] = Array.from(pill.querySelectorAll("span"));
		dragHandle(right, 90);
		expect(tl.updateAnnotationSpan).toHaveBeenCalledWith("ann1", 10_000, 191_000);

		// Shrinking stops at the storage grid (1 ms), not at the old flat 200 ms
		// floor that refused the last fifth of a second however far you zoomed in.
		dragHandle(left, 90_000);
		expect(tl.updateAnnotationSpan).toHaveBeenLastCalledWith("ann1", 10_999, 11_000);

		// 18 s short of the timeline end: 9 px away on screen, so it stays where it
		// was dropped. The snap radius used to be 1.2% of the timeline — a 21-second
		// magnet here — which is what made a grown edge jump to a clip boundary it
		// was nowhere near, the more so the longer the recording.
		dragHandle(right, 885.5);
		expect(tl.updateAnnotationSpan).toHaveBeenLastCalledWith("ann1", 10_000, 1_782_000);
	});
});

describe("V4Timeline lane pill keyboard", () => {
	// A pill carries `role="button"` and `tabIndex={0}`, so it is reachable by Tab and
	// announced as activatable. Selection was pointer-only, which meant a keyboard user
	// could focus a region and then reach nothing that acts on a selection — Delete,
	// copy/paste and the inspector all key off `tl.selection`.
	it("selects the focused pill on Enter", () => {
		const { pill, tl } = renderTimeline();
		fireEvent.keyDown(pill, { key: "Enter" });
		expect(tl.selectRegion).toHaveBeenCalledWith("annotation", "ann1", { additive: false });
	});

	it("selects it on Space too, the other key a button answers to", () => {
		const { pill, tl } = renderTimeline();
		fireEvent.keyDown(pill, { key: " " });
		expect(tl.selectRegion).toHaveBeenCalledWith("annotation", "ann1", { additive: false });
	});

	it("adds to the selection when Shift is held, matching shift-click", () => {
		const { pill, tl } = renderTimeline();
		fireEvent.keyDown(pill, { key: "Enter", shiftKey: true });
		expect(tl.selectRegion).toHaveBeenCalledWith("annotation", "ann1", { additive: true });
	});

	it("leaves every other key to the shell's shortcut handler", () => {
		// The editor binds single letters (Z adds a zoom, T a trim, D deletes). Swallowing
		// them here would silently disable every shortcut while a pill has focus.
		const { pill, tl } = renderTimeline();
		for (const key of ["z", "t", "d", "Escape", "ArrowRight"]) {
			fireEvent.keyDown(pill, { key });
		}
		expect(tl.selectRegion).not.toHaveBeenCalled();
	});

	it("stops Enter and Space reaching the window listener", () => {
		// Space is bound to play/pause on WINDOW, above React's root container. Without
		// stopping the NATIVE event the same keystroke would select the pill and toggle
		// playback; the synthetic `stopPropagation` alone does not reach that far.
		const onWindowKey = vi.fn();
		window.addEventListener("keydown", onWindowKey);
		try {
			const { pill } = renderTimeline();
			fireEvent.keyDown(pill, { key: " " });
			fireEvent.keyDown(pill, { key: "Enter" });
			expect(onWindowKey).not.toHaveBeenCalled();

			// A key the pill ignores still gets there, or the shortcuts would be dead.
			fireEvent.keyDown(pill, { key: "z" });
			expect(onWindowKey).toHaveBeenCalledTimes(1);
		} finally {
			window.removeEventListener("keydown", onWindowKey);
		}
	});
});

describe("V4Timeline create-from-toolbar", () => {
	// The button asks for a DURATION worth a fixed number of pixels at the current
	// zoom, so the pill you get is always the same size on screen — which is what
	// the flat 2 s could not do: on this 30-minute fixture zoomed out it is one
	// pixel. (It used to look fine only because the removed 1.5% minimum width
	// inflated it in the rendering.)
	const durationOf = (tl: { addZoom: ReturnType<typeof vi.fn> }) =>
		tl.addZoom.mock.calls.at(-1)?.[0] as number;

	it("scales the new region's duration with the zoom", () => {
		const { tl } = renderTimeline();
		fireEvent.click(screen.getByLabelText("buttons.addZoom"));
		// 900px viewport / 1800 s = 0.5 px per second, so a 96px pill is 192 s.
		expect(durationOf(tl)).toBeCloseTo(192, 3);

		// Zoomed to the 50x ceiling the same 96px is worth 3.84 s: same pill on
		// screen, a region 50x shorter.
		zoomIn(40);
		fireEvent.click(screen.getByLabelText("buttons.addZoom"));
		expect(durationOf(tl)).toBeCloseTo(3.84, 3);
	});

	it("zooms from a wheel over the ruler too, not just the lanes", () => {
		// The ruler row is pinned above .tlTracks (so its ticks don't scroll away
		// with the lanes) and isn't a descendant of it. The wheel listener used to
		// live on .tlTracks alone, so Ctrl/Shift+scrolling anywhere else in the
		// pane — the ruler included — silently did nothing.
		const { tl } = renderTimeline();
		const ruler = document.querySelector("[class*=tlRulerRow]") as HTMLElement;
		wheelZoomOn(ruler, 40);
		fireEvent.click(screen.getByLabelText("buttons.addZoom"));
		expect(durationOf(tl)).toBeCloseTo(3.84, 3);
	});

	it("pans from a wheel over the ruler too, not just the lanes", () => {
		// Same gap as the zoom case above, but for the Shift+wheel pan path.
		// Panning is a no-op fully zoomed out (nav already spans the whole
		// timeline, so there is nowhere to pan to), so zoom in first — from the
		// ruler too — to open up room to pan within.
		renderTimeline();
		const ruler = document.querySelector("[class*=tlRulerRow]") as HTMLElement;
		wheelZoomOn(ruler, 40);
		const navWindow = document.querySelector("[class*=tlNavWindow]") as HTMLElement;
		const before = navWindow.style.left;
		fireEvent.wheel(ruler, { shiftKey: true, deltaY: 100, clientX: 0 });
		expect(navWindow.style.left).not.toBe(before);
	});

	it("never asks for a slice too short to be worth creating", () => {
		// Past ~30x on a short timeline the pixels are worth hundredths of a
		// second; the region would be born unusable, so the duration floors.
		const { tl } = renderTimeline([clip(0, 3)]);
		zoomIn(40);
		fireEvent.click(screen.getByLabelText("buttons.addZoom"));
		expect(durationOf(tl)).toBeCloseTo(0.25, 3);
	});

	// #353. A camera-fullscreen region grows the webcam overlay, so with no webcam on the
	// timeline it renders nothing in the preview and nothing in the export — the region is
	// stored and forgotten. `addCameraFullscreen` now refuses to write one; the button says
	// so before it is clicked instead of looking like it worked.
	it("disables Add Full Camera when no clip on the timeline has a camera", () => {
		renderTimeline();
		expect(screen.getByLabelText("buttons.addCameraFullscreen")).toBeDisabled();
	});

	it("enables Add Full Camera as soon as a clip's asset carries one", () => {
		renderTimeline(undefined, undefined, [
			{
				...NO_CAMERA_ASSET,
				cameraTrack: { sourcePath: "/tmp/cam.webm", startMs: 0, offsetMs: 0, visible: true },
			},
		]);
		expect(screen.getByLabelText("buttons.addCameraFullscreen")).toBeEnabled();
	});

	// The disabled button is only half the promise: an empty lane advertises the shortcut
	// that fills it, so on a camera-less project it was still inviting a `C` press that
	// `addCameraFullscreen` now refuses. It borrows the Layout pane's "No Webcam" wording
	// instead, so the two surfaces agree about the same project.
	it("does not advertise the C shortcut on a lane that cannot be filled", () => {
		renderTimeline();
		expect(screen.getByText("layout.noWebcam")).toBeInTheDocument();
		expect(screen.queryByText("hints.pressCameraFullscreen")).not.toBeInTheDocument();
	});

	it("advertises it again once a camera is on the timeline", () => {
		renderTimeline(undefined, undefined, [
			{
				...NO_CAMERA_ASSET,
				cameraTrack: { sourcePath: "/tmp/cam.webm", startMs: 0, offsetMs: 0, visible: true },
			},
		]);
		expect(screen.getByText("hints.pressCameraFullscreen")).toBeInTheDocument();
		expect(screen.queryByText("layout.noWebcam")).not.toBeInTheDocument();
	});
});

describe("V4Timeline clip row", () => {
	// Three clips = two junctions. As a flex row with `gap: 6px`, each junction
	// added 6px while every clip shrank proportionally to pay for it, so a clip's
	// left edge missed its true start: measured in a browser on this very fixture,
	// clip 2 by +2px and clip 3 by +6px, while the pills and ruler above them sat
	// at the true position. Being a fixed px error in a proportional layout, it was
	// worth 5 s and 15 s of timeline zoomed out but a fraction of a second zoomed
	// in — which is what reads as "the pills move when I zoom".
	const CLIPS = [clip(0, 600), clip(600, 900), clip(900, TOTAL_SEC)];
	const startsAt = (sec: number) => `${(sec / TOTAL_SEC) * 100}%`;

	it("anchors every clip to its own start time, and keeps it there under zoom", () => {
		// The annotation starts exactly where the second clip does, so the pill and
		// the clip edge under it must resolve to the very same coordinate.
		const { clipEls, pill } = renderTimeline(CLIPS, {
			id: "ann1",
			startMs: 600_000,
			endMs: 601_000,
		});
		expect(clipEls.map((el) => el.style.left)).toEqual([startsAt(0), startsAt(600), startsAt(900)]);
		expect(pill.style.left).toBe(clipEls[1].style.left);

		// Zoom scales the canvas these coordinates live in, so the coordinates
		// themselves must not move: same values, same agreement with the pill.
		zoomIn(40);
		expect(clipEls.map((el) => el.style.left)).toEqual([startsAt(0), startsAt(600), startsAt(900)]);
		expect(pill.style.left).toBe(clipEls[1].style.left);
	});

	it("takes the card gutter out of each clip's own width", () => {
		// The 6px is what separates two cards. Taken off the clip's width it stays
		// local to that clip; inserted between them (a flex gap) it displaced every
		// clip that followed. The 1px floor keeps a clip shorter than the gutter
		// from collapsing to nothing on a long timeline.
		const { clipEls } = renderTimeline(CLIPS);
		const widths = clipEls.map((el) => el.style.width);
		// (jsdom re-serialises the percentage to 4 decimals, hence the numeric read)
		expect(widths.map((w) => w.endsWith("- 6px)"))).toEqual([true, true, true]);
		for (const [i, durSec] of [600, 300, 900].entries()) {
			expect(Number.parseFloat(widths[i].slice("calc(".length))).toBeCloseTo(
				(durSec / TOTAL_SEC) * 100,
				3,
			);
		}
	});
});

// Issue #350 — dragging an imported audio track on its lane. The pixel→second
// math and the single-write commit are what these pin; the clamp/guard math is
// covered by document/audioTracks.test.ts.
describe("V4Timeline audio lane drag", () => {
	const AUDIO_ASSET = { id: "aud", label: "voiceover", originalPath: "/vo.mp3", durationSec: 60 };
	// A 60s track whose head sits at raw 100s.
	const makeTrack = () => ({
		id: "trk1",
		assetId: "aud",
		kind: "music" as const,
		startMs: 100_000,
		endMs: 160_000,
		durationSec: 60,
		offsetMs: 0,
		gainDb: 0,
		loop: false,
		fadeInMs: 0,
		fadeOutMs: 0,
		muted: false,
		label: "vo",
		origin: "user" as const,
	});

	function renderAudioTracks(tracks: Array<ReturnType<typeof makeTrack>>) {
		return renderAudio({}, {}, tracks);
	}

	function renderAudio(
		trackOverrides: Partial<ReturnType<typeof makeTrack>> = {},
		props: { onAddVoiceover?: () => void } = {},
		tracks?: Array<ReturnType<typeof makeTrack>>,
	) {
		const placeAudioTrack = vi.fn(
			async (_id: string, _span: { startMs: number; endMs: number; offsetMs?: number }) => {
				/* the drag only awaits it */
			},
		);
		const selectAudioTrack = vi.fn();
		const tl = {
			clips: [clip(0, TOTAL_SEC)],
			assets: [AUDIO_ASSET],
			annotationRegions: [],
			speedRegions: [],
			cameraFullscreenRegions: [],
			zoomRegions: [],
			trimRanges: [],
			selection: null,
			multiSelection: [],
			clipSelection: null,
			audioTracks: tracks ?? [{ ...makeTrack(), ...trackOverrides }],
			// The lane reads these for the amber added-word marks (#540); this fixture
			// is about audio geometry, so it has none.
			transcripts: [],
			selectedAudioTrackId: null,
			selectAudioTrack,
			placeAudioTrack,
			clearSelection: vi.fn(),
			selectRegion: vi.fn(),
			selectClip: vi.fn(),
			updateAnnotationSpan: vi.fn(async () => undefined),
			addZoom: vi.fn(async () => undefined),
		};
		const { container } = render(
			<ShortcutsProvider>
				<V4Timeline
					tl={tl as unknown as ReturnType<typeof useTimeline>}
					setCurrentTime={vi.fn()}
					playing={false}
					onTogglePlay={vi.fn()}
					onPrevClip={vi.fn()}
					onNextClip={vi.fn()}
					onEditClip={vi.fn()}
					onAddVoiceover={props.onAddVoiceover ?? vi.fn()}
				/>
			</ShortcutsProvider>,
		);
		// `pill` is a getter: the multi-track cases render no "vo" pill, and an
		// eager lookup would throw before their own assertions ran.
		return {
			get pill() {
				return screen.getByTitle((t) => t.startsWith("vo "));
			},
			container,
			placeAudioTrack,
			selectAudioTrack,
		};
	}

	// 900px / 1800s = 0.5 px per second, so +90px is +180s.
	const secForPx = (px: number) => (px / VIEWPORT_PX) * TOTAL_SEC;

	it("offers both audio paths behind one toolbar button", () => {
		// A mic and a music note side by side both just said "audio"; one button
		// with a named menu is what tells a first-time user the two paths apart.
		const onAddVoiceover = vi.fn();
		renderAudio({}, { onAddVoiceover });
		fireEvent.click(screen.getByLabelText("toolbar.addAudioTooltip"));
		fireEvent.click(screen.getByText("audio.addVoiceover"));
		expect(onAddVoiceover).toHaveBeenCalledTimes(1);
	});

	it("teaches the key that does the same thing", () => {
		// Read off the live bindings rather than hardcoded here, so a rebind in the
		// shortcuts dialog moves the menu with it instead of teaching a stale key.
		renderAudio();
		fireEvent.click(screen.getByLabelText("toolbar.addAudioTooltip"));
		const keys = Array.from(document.querySelectorAll("kbd"), (k) => k.textContent);
		expect(keys).toEqual([
			formatBinding(DEFAULT_SHORTCUTS.addVoiceover, false),
			formatBinding(DEFAULT_SHORTCUTS.addAudio, false),
		]);
	});

	it("marks where a looping track starts its file over", () => {
		// A 60s file under a 180s span repeats twice more after the first pass, so
		// there are two boundaries to show — at a third and two thirds.
		const { pill } = renderAudio({ loop: true, endMs: 100_000 + 180_000 });
		expect(pill.querySelectorAll('[data-testid="audio-loop-mark"]')).toHaveLength(2);
	});

	it("draws no loop marks when the track fits inside its source", () => {
		const { pill } = renderAudio({ loop: true });
		expect(pill.querySelectorAll('[data-testid="audio-loop-mark"]')).toHaveLength(0);
	});

	it("stacks overlapping tracks on separate rows", () => {
		// Three takes over the same stretch used to draw at the same height, one
		// hiding the next — you could not tell which pill you were about to drag.
		const { container } = renderAudioTracks([
			{ ...makeTrack(), id: "a", label: "a", startMs: 0, endMs: 60_000 },
			{ ...makeTrack(), id: "b", label: "b", startMs: 10_000, endMs: 70_000 },
			{ ...makeTrack(), id: "c", label: "c", startMs: 20_000, endMs: 80_000 },
		]);
		const tops = ["a", "b", "c"].map(
			(l) => (screen.getByTitle((t) => t.startsWith(`${l} `)) as HTMLElement).style.top,
		);
		expect(new Set(tops).size).toBe(3);
		// ...and the lane grew to hold them rather than clipping.
		const lane = container.querySelector('[class*="tlLaneAudio"]') as HTMLElement;
		expect(Number.parseInt(lane.style.height, 10)).toBeGreaterThan(60);
	});

	it("keeps non-overlapping tracks on one row", () => {
		renderAudioTracks([
			{ ...makeTrack(), id: "a", label: "a", startMs: 0, endMs: 10_000 },
			{ ...makeTrack(), id: "b", label: "b", startMs: 20_000, endMs: 30_000 },
		]);
		const tops = ["a", "b"].map(
			(l) => (screen.getByTitle((t) => t.startsWith(`${l} `)) as HTMLElement).style.top,
		);
		expect(new Set(tops).size).toBe(1);
	});

	it("selects the track on pointer-down before any movement", () => {
		const { pill, selectAudioTrack } = renderAudio();
		fireEvent.pointerDown(pill, { clientX: 0 });
		window.dispatchEvent(new MouseEvent("pointerup", { clientX: 0 }));
		expect(selectAudioTrack).toHaveBeenCalledWith("trk1");
	});

	it("body drag slides the head and commits once, trims untouched", () => {
		const { pill, placeAudioTrack } = renderAudio();
		fireEvent.pointerDown(pill, { clientX: 0 });
		window.dispatchEvent(new MouseEvent("pointermove", { clientX: 90 }));
		window.dispatchEvent(new MouseEvent("pointerup", { clientX: 90 }));
		expect(placeAudioTrack).toHaveBeenCalledTimes(1);
		const [id, placement] = placeAudioTrack.mock.calls[0];
		expect(id).toBe("trk1");
		// The span slides whole: head moves, length is unchanged.
		expect(placement.startMs / 1000).toBeCloseTo(100 + secForPx(90), 3);
		expect((placement.endMs - placement.startMs) / 1000).toBeCloseTo(60, 3);
	});

	it("left-handle drag trims into the source instead of sliding the audio", () => {
		// A left-edge drag is a trim IN: the head moves right by N seconds and the
		// same N is skipped in the file, so what plays under the pill stays put.
		// Committing the span alone left `offsetMs` untouched, which just slid the
		// whole track along — the "my music starts five seconds late" symptom.
		const { pill, placeAudioTrack } = renderAudio();
		const handle = pill.firstElementChild as Element;
		fireEvent.pointerDown(handle, { clientX: 0 });
		window.dispatchEvent(new MouseEvent("pointermove", { clientX: 15 }));
		window.dispatchEvent(new MouseEvent("pointerup", { clientX: 15 }));
		expect(placeAudioTrack).toHaveBeenCalledTimes(1);
		const [, placement] = placeAudioTrack.mock.calls[0];
		const movedSec = placement.startMs / 1000 - 100;
		expect(movedSec).toBeGreaterThan(0);
		// The head moved and the source in-point advanced by the same amount.
		expect((placement.offsetMs ?? 0) / 1000).toBeCloseTo(movedSec, 3);
		// The tail is untouched, so the span shortens by exactly what was trimmed.
		expect((placement.endMs - placement.startMs) / 1000).toBeCloseTo(60 - movedSec, 3);
	});

	it("a plain move leaves the source in-point alone", () => {
		const { pill, placeAudioTrack } = renderAudio();
		fireEvent.pointerDown(pill, { clientX: 0 });
		window.dispatchEvent(new MouseEvent("pointermove", { clientX: 90 }));
		window.dispatchEvent(new MouseEvent("pointerup", { clientX: 90 }));
		const [, placement] = placeAudioTrack.mock.calls[0];
		expect(placement.offsetMs).toBe(0);
	});

	it("caps the out-point at the source length when the track does not loop", () => {
		// A non-looping track has nothing to play past the end of its file, so the
		// right edge stops there however far the pointer goes.
		const { pill, placeAudioTrack } = renderAudio();
		const handle = pill.lastElementChild as Element;
		fireEvent.pointerDown(handle, { clientX: 0 });
		window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }));
		window.dispatchEvent(new MouseEvent("pointerup", { clientX: 400 }));
		const [, placement] = placeAudioTrack.mock.calls[0];
		expect((placement.endMs - placement.startMs) / 1000).toBeCloseTo(60, 3);
	});

	it("lets a looping track be pulled out past the end of its file", () => {
		// This is what makes the loop toggle mean anything: the span has to be able
		// to EXCEED the source, or the audio always plays exactly once and turning
		// loop on does nothing at all.
		const { pill, placeAudioTrack } = renderAudio({ loop: true });
		const handle = pill.lastElementChild as Element;
		fireEvent.pointerDown(handle, { clientX: 0 });
		window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }));
		window.dispatchEvent(new MouseEvent("pointerup", { clientX: 400 }));
		const [, placement] = placeAudioTrack.mock.calls[0];
		expect((placement.endMs - placement.startMs) / 1000).toBeGreaterThan(60);
	});

	it("right-handle drag pulls the out-point in, head fixed", () => {
		const { pill, placeAudioTrack } = renderAudio();
		// The right resize handle is the last child of the pill.
		const handle = pill.lastElementChild as Element;
		fireEvent.pointerDown(handle, { clientX: 0 });
		window.dispatchEvent(new MouseEvent("pointermove", { clientX: -30 }));
		window.dispatchEvent(new MouseEvent("pointerup", { clientX: -30 }));
		expect(placeAudioTrack).toHaveBeenCalledTimes(1);
		const [, placement] = placeAudioTrack.mock.calls[0];
		// The head is pinned; only the tail comes in, so the span gets shorter.
		expect(placement.startMs).toBe(100_000);
		expect(placement.endMs - placement.startMs).toBeLessThan(60_000);
	});
});
