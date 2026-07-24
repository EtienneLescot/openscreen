import { describe, expect, it } from "vitest";
import {
	computeCameraFullscreenRect,
	computeCompositeLayout,
	isWebcamBlockLayout,
	resolveWebcamReactiveZoom,
	type StyledRenderRect,
} from "./compositeLayout";

describe("resolveWebcamReactiveZoom", () => {
	it("honours the stored setting for picture-in-picture", () => {
		expect(resolveWebcamReactiveZoom("picture-in-picture", true)).toBe(true);
		expect(resolveWebcamReactiveZoom("picture-in-picture", false)).toBe(false);
	});

	it("forces shrink-on-zoom off for the block layouts", () => {
		// The camera box is welded to the screen there, so shrinking it mid-zoom
		// would tear a hole in the block. The UI hides the toggle to match.
		expect(resolveWebcamReactiveZoom("dual-frame", true)).toBe(false);
		expect(resolveWebcamReactiveZoom("vertical-stack", true)).toBe(false);
		expect(isWebcamBlockLayout("dual-frame")).toBe(true);
		expect(isWebcamBlockLayout("vertical-stack")).toBe(true);
		expect(isWebcamBlockLayout("picture-in-picture")).toBe(false);
	});
});

describe("computeCompositeLayout", () => {
	it("anchors the overlay in the lower-right corner", () => {
		const layout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 1280, height: 720 },
		});

		expect(layout).not.toBeNull();
		expect(layout!.webcamRect).not.toBeNull();
		expect(layout!.webcamRect!.x + layout!.webcamRect!.width).toBeLessThanOrEqual(1920);
		expect(layout!.webcamRect!.y + layout!.webcamRect!.height).toBeLessThanOrEqual(1080);
		expect(layout!.webcamRect!.x).toBeGreaterThan(1920 / 2);
		expect(layout!.webcamRect!.y).toBeGreaterThan(1080 / 2);
	});

	it("scales small screen content up to the export canvas when no padding is applied", () => {
		const layout = computeCompositeLayout({
			canvasSize: { width: 1280, height: 720 },
			screenSize: { width: 854, height: 480 },
		});

		expect(layout).not.toBeNull();
		expect(layout!.screenRect).toEqual({
			x: 0,
			y: 0,
			width: 1280,
			height: 720,
		});
	});

	it("keeps the overlay within the configured stage fraction while preserving aspect ratio", () => {
		const layout = computeCompositeLayout({
			canvasSize: { width: 1280, height: 720 },
			screenSize: { width: 1280, height: 720 },
			webcamSize: { width: 1920, height: 1080 },
		});

		const refDim = Math.sqrt(1280 * 720);
		const defaultFraction = 25 / 100; // DEFAULT_WEBCAM_SIZE_PRESET = 25
		expect(layout).not.toBeNull();
		expect(layout!.webcamRect).not.toBeNull();
		expect(layout!.webcamRect!.width).toBeLessThanOrEqual(Math.round(refDim * defaultFraction) + 1);
		expect(layout!.webcamRect!.height).toBeLessThanOrEqual(
			Math.round(refDim * defaultFraction) + 1,
		);
		expect(
			Math.abs(layout!.webcamRect!.width * 1080 - layout!.webcamRect!.height * 1920),
		).toBeLessThanOrEqual(1920);
	});

	it("produces consistent webcam size across landscape and portrait aspect ratios", () => {
		const webcamSize = { width: 1280, height: 720 };
		const landscape = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize,
			webcamSizePreset: 50,
		});
		const portrait = computeCompositeLayout({
			canvasSize: { width: 1080, height: 1920 },
			screenSize: { width: 1080, height: 1920 },
			webcamSize,
			webcamSizePreset: 50,
		});

		expect(landscape).not.toBeNull();
		expect(portrait).not.toBeNull();
		// Same total pixel count, so webcam area should be comparable.
		const landscapeArea = landscape!.webcamRect!.width * landscape!.webcamRect!.height;
		const portraitArea = portrait!.webcamRect!.width * portrait!.webcamRect!.height;
		expect(landscapeArea).toBe(portraitArea);
	});

	it("keeps the webcam a modest fraction of a narrow (9:16) frame's own width", () => {
		// Reported bug: dragging the webcam PiP felt stuck in a wide "dead band" near each
		// edge on a 9:16 preview. Root cause was sizing off sqrt(canvasWidth*canvasHeight)
		// (the geometric mean, which barely shrinks at an extreme aspect ratio even though the
		// actual narrow axis is much smaller than that mean) instead of the narrow axis itself.
		// These are the exact dims logged from a live repro: a 230x408 frame at a 34% size
		// preset produced a 104px-wide box -- 45% of the frame's own width.
		const layout = computeCompositeLayout({
			canvasSize: { width: 230, height: 408 },
			screenSize: { width: 230, height: 408 },
			webcamSize: { width: 960, height: 720 },
			webcamSizePreset: 34,
		});
		expect(layout.webcamRect).not.toBeNull();
		const widthFraction = layout.webcamRect!.width / 230;
		expect(widthFraction).toBeLessThan(0.4);
	});

	it("scales the webcam proportionally as webcamSizePreset increases", () => {
		const canvasSize = { width: 1920, height: 1080 };
		const screenSize = { width: 1920, height: 1080 };
		const webcamSize = { width: 1280, height: 720 };

		const small = computeCompositeLayout({
			canvasSize,
			screenSize,
			webcamSize,
			webcamSizePreset: 10,
		});
		const medium = computeCompositeLayout({
			canvasSize,
			screenSize,
			webcamSize,
			webcamSizePreset: 25,
		});
		const large = computeCompositeLayout({
			canvasSize,
			screenSize,
			webcamSize,
			webcamSizePreset: 50,
		});

		expect(small!.webcamRect!.width).toBeLessThan(medium!.webcamRect!.width);
		expect(medium!.webcamRect!.width).toBeLessThan(large!.webcamRect!.width);
		expect(small!.webcamRect!.height).toBeLessThan(medium!.webcamRect!.height);
		expect(medium!.webcamRect!.height).toBeLessThan(large!.webcamRect!.height);
	});

	it("clamps webcamSizePreset to the valid range (10–50)", () => {
		const canvasSize = { width: 1920, height: 1080 };
		const screenSize = { width: 1920, height: 1080 };
		const webcamSize = { width: 1280, height: 720 };

		const atMin = computeCompositeLayout({
			canvasSize,
			screenSize,
			webcamSize,
			webcamSizePreset: 10,
		});
		const belowMin = computeCompositeLayout({
			canvasSize,
			screenSize,
			webcamSize,
			webcamSizePreset: 1,
		});
		const atMax = computeCompositeLayout({
			canvasSize,
			screenSize,
			webcamSize,
			webcamSizePreset: 50,
		});
		const aboveMax = computeCompositeLayout({
			canvasSize,
			screenSize,
			webcamSize,
			webcamSizePreset: 100,
		});

		expect(belowMin!.webcamRect!.width).toBe(atMin!.webcamRect!.width);
		expect(belowMin!.webcamRect!.height).toBe(atMin!.webcamRect!.height);
		expect(aboveMax!.webcamRect!.width).toBe(atMax!.webcamRect!.width);
		expect(aboveMax!.webcamRect!.height).toBe(atMax!.webcamRect!.height);
	});

	it("snaps rounding-only source aspect gaps to the full canvas", () => {
		const layout = computeCompositeLayout({
			canvasSize: { width: 319, height: 199 },
			maxContentSize: { width: 319, height: 199 },
			screenSize: { width: 1680, height: 1050 },
		});

		expect(layout?.screenRect).toEqual({
			x: 0,
			y: 0,
			width: 319,
			height: 199,
		});
	});

	// ─── block layouts: geometry shared by both presets ────────────────────────

	// The three constraints, asserted directly: screen keeps its ratio, the couple
	// is contained in the scene, and the camera tends toward square.
	const CAPTURES = [
		{ label: "21:9", size: { width: 2560, height: 1080 } },
		{ label: "16:9", size: { width: 1920, height: 1080 } },
		{ label: "4:3", size: { width: 1440, height: 1080 } },
		{ label: "1:1", size: { width: 1080, height: 1080 } },
		{ label: "4:5", size: { width: 1080, height: 1350 } },
		{ label: "9:16", size: { width: 1080, height: 1920 } },
	];
	const SCENES = [
		{ label: "16:9", size: { width: 1920, height: 1080 } },
		{ label: "9:16", size: { width: 1080, height: 1920 } },
		{ label: "1:1", size: { width: 1080, height: 1080 } },
		{ label: "4:5", size: { width: 1080, height: 1350 } },
		{ label: "21:9", size: { width: 2560, height: 1080 } },
	];
	// A 4:3 source camera, to prove the camera box is cut from the block, not the
	// camera's own aspect ratio.
	const CAM = { width: 960, height: 720 };

	for (const preset of ["dual-frame", "vertical-stack"] as const) {
		for (const capture of CAPTURES) {
			for (const scene of SCENES) {
				it(`${preset}: capture ${capture.label} in scene ${scene.label} — screen ratio kept, block contained, camera near square`, () => {
					const layout = computeCompositeLayout({
						canvasSize: scene.size,
						maxContentSize: scene.size, // padding 0
						screenSize: capture.size,
						webcamSize: CAM,
						layoutPreset: preset,
					})!;
					const screen = layout.screenRect;
					const cam = layout.webcamRect!;

					// 1. Screen keeps the capture's own aspect ratio.
					expect(screen.width / screen.height).toBeCloseTo(
						capture.size.width / capture.size.height,
						1,
					);

					// 2. The whole block is contained in the scene — nothing overflows.
					for (const r of [screen, cam]) {
						expect(r.x).toBeGreaterThanOrEqual(-1);
						expect(r.y).toBeGreaterThanOrEqual(-1);
						expect(r.x + r.width).toBeLessThanOrEqual(scene.size.width + 1);
						expect(r.y + r.height).toBeLessThanOrEqual(scene.size.height + 1);
					}

					// 3. The camera tends toward square: its aspect stays within the
					// tolerance band (4:5 … 5:4), never an extreme slice.
					const camAspect = cam.width / cam.height;
					expect(camAspect).toBeGreaterThanOrEqual(1 / 1.25 - 0.02);
					expect(camAspect).toBeLessThanOrEqual(1.25 + 0.02);

					// The camera keeps the block solid: aligned with the screen on the
					// shared edge, sitting after it with a gap, no overlap.
					if (preset === "dual-frame") {
						expect(cam.height).toBeCloseTo(screen.height, 0);
						expect(cam.x).toBeGreaterThanOrEqual(screen.x + screen.width);
					} else {
						expect(cam.width).toBeCloseTo(screen.width, 0);
						expect(cam.y).toBeGreaterThanOrEqual(screen.y + screen.height);
					}
				});
			}
		}
	}

	it("fills the scene exactly (block aspect == scene aspect) when a near-square camera allows it", () => {
		// A 16:9 screen stacked top/bottom in a portrait-ish scene: the square-ish
		// camera that fills the scene is reachable inside the band, so the block
		// touches all four edges and the camera lands close to square.
		const scene = { width: 1000, height: 1587 };
		const layout = computeCompositeLayout({
			canvasSize: scene,
			maxContentSize: scene,
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 960, height: 720 },
			layoutPreset: "vertical-stack",
		})!;
		const screen = layout.screenRect;
		const cam = layout.webcamRect!;
		const blockW = Math.max(screen.x + screen.width, cam.x + cam.width) - Math.min(screen.x, cam.x);
		const blockH =
			Math.max(screen.y + screen.height, cam.y + cam.height) - Math.min(screen.y, cam.y);
		// Block matches the scene aspect → contains with (near) zero bars.
		expect(blockW / blockH).toBeCloseTo(scene.width / scene.height, 1);
		expect(cam.width / cam.height).toBeCloseTo(1, 1); // ~square
	});

	it("makes the camera squarer for a landscape capture top/bottom than the old fixed 50/50 did", () => {
		// Regression guard for the reported issue: a 16:9 capture used to give a
		// 1.78:1 camera strip in Top / bottom. It must now be markedly squarer.
		const layout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			maxContentSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 960, height: 720 },
			layoutPreset: "vertical-stack",
		})!;
		const cam = layout.webcamRect!;
		expect(cam.width).toBeCloseTo(layout.screenRect.width, 0); // still full width
		expect(cam.width / cam.height).toBeLessThan(1.3); // was 1.78
	});

	it("keeps both block presets' frames sharing one corner radius", () => {
		for (const layoutPreset of ["dual-frame", "vertical-stack"] as const) {
			const layout = computeCompositeLayout({
				canvasSize: { width: 1920, height: 1080 },
				maxContentSize: { width: 1920, height: 1080 },
				screenSize: { width: 1920, height: 1080 },
				webcamSize: { width: 960, height: 720 },
				layoutPreset,
			})!;
			expect(layout.screenBorderRadius).toBe(layout.webcamRect!.borderRadius);
			expect(layout.screenBorderRadius).toBeGreaterThan(0);
		}
	});

	// ─── block layouts: padding & fallback ─────────────────────────────────────

	it.each([
		"vertical-stack",
		"dual-frame",
	] as const)("insets the whole %s block by the padding, keeping it centered", (layoutPreset) => {
		const args = {
			canvasSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 960, height: 720 },
			layoutPreset,
		};
		const flush = computeCompositeLayout({
			...args,
			maxContentSize: { width: 1920, height: 1080 },
		})!;
		// maxContentSize = canvasSize × paddingFit(=0.8) — i.e. padding 50%.
		const padded = computeCompositeLayout({
			...args,
			maxContentSize: { width: 1536, height: 864 },
		})!;

		// Screen and camera shrink together by the same factor: the block moves
		// as one piece, so their ratio to each other is untouched.
		expect(padded.screenRect.width / flush.screenRect.width).toBeCloseTo(0.8, 2);
		expect(padded.webcamRect!.width / flush.webcamRect!.width).toBeCloseTo(0.8, 2);
		expect(padded.webcamRect!.height / flush.webcamRect!.height).toBeCloseTo(0.8, 2);

		// Still centered in the canvas.
		const blockLeft = Math.min(padded.screenRect.x, padded.webcamRect!.x);
		const blockRight = Math.max(
			padded.screenRect.x + padded.screenRect.width,
			padded.webcamRect!.x + padded.webcamRect!.width,
		);
		const blockTop = Math.min(padded.screenRect.y, padded.webcamRect!.y);
		const blockBottom = Math.max(
			padded.screenRect.y + padded.screenRect.height,
			padded.webcamRect!.y + padded.webcamRect!.height,
		);
		expect(blockLeft).toBeCloseTo(1920 - blockRight, 0);
		expect(blockTop).toBeCloseTo(1080 - blockBottom, 0);
	});

	it.each([
		"vertical-stack",
		"dual-frame",
	] as const)("contain-fits the %s block into a portrait scene without overflowing", (layoutPreset) => {
		const layout = computeCompositeLayout({
			canvasSize: { width: 1080, height: 1920 },
			maxContentSize: { width: 1080, height: 1920 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 960, height: 720 },
			layoutPreset,
		})!;

		for (const rect of [layout.screenRect, layout.webcamRect!]) {
			expect(rect.x).toBeGreaterThanOrEqual(0);
			expect(rect.y).toBeGreaterThanOrEqual(0);
			expect(rect.x + rect.width).toBeLessThanOrEqual(1080);
			expect(rect.y + rect.height).toBeLessThanOrEqual(1920);
		}
		// The screen still carries the capture's own ratio in a scene whose
		// ratio is nothing like it.
		expect(layout.screenRect.width / layout.screenRect.height).toBeCloseTo(1920 / 1080, 2);
	});

	it.each([
		"vertical-stack",
		"dual-frame",
	] as const)("falls back to the screen alone in %s when the clip has no camera", (layoutPreset) => {
		const layout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			maxContentSize: { width: 1536, height: 864 },
			screenSize: { width: 1920, height: 1080 },
			layoutPreset,
		});

		expect(layout?.webcamRect).toBeNull();
		// Contain-fit into the padded area, like every other preset.
		expect(layout?.screenRect).toEqual({ x: 192, y: 108, width: 1536, height: 864 });
	});

	it("forces circular and square masks to use square dimensions", () => {
		const circularLayout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 1280, height: 720 },
			webcamMaskShape: "circle",
		});
		const squareLayout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 1280, height: 720 },
			webcamMaskShape: "square",
		});

		expect(circularLayout?.webcamRect).not.toBeNull();
		expect(squareLayout?.webcamRect).not.toBeNull();
		expect(circularLayout?.webcamRect?.width).toBe(circularLayout?.webcamRect?.height);
		expect(squareLayout?.webcamRect?.width).toBe(squareLayout?.webcamRect?.height);
		expect(circularLayout?.webcamRect?.maskShape).toBe("circle");
		expect(squareLayout?.webcamRect?.maskShape).toBe("square");
	});

	it("applies larger rounding for the rounded webcam mask", () => {
		const roundedLayout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 1280, height: 720 },
			webcamMaskShape: "rounded",
		});
		const rectangleLayout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 1280, height: 720 },
			webcamMaskShape: "rectangle",
		});

		expect(roundedLayout?.webcamRect).not.toBeNull();
		expect(rectangleLayout?.webcamRect).not.toBeNull();
		expect(roundedLayout?.webcamRect?.borderRadius).toBeGreaterThan(
			rectangleLayout?.webcamRect?.borderRadius ?? 0,
		);
		expect(roundedLayout?.webcamRect?.maskShape).toBe("rounded");
	});
});

describe("computeCameraFullscreenRect", () => {
	const CANVAS = { width: 1920, height: 1080 };
	const pip = (over: Partial<StyledRenderRect> = {}): StyledRenderRect => ({
		x: 1520,
		y: 740,
		width: 360,
		height: 270,
		borderRadius: 24,
		maskShape: "rectangle",
		...over,
	});

	it("is the whole frame at full progress — no margin, no rounding, no mask", () => {
		const rect = computeCameraFullscreenRect(pip(), CANVAS, 1);

		expect(rect).toEqual({
			x: 0,
			y: 0,
			width: CANVAS.width,
			height: CANVAS.height,
			borderRadius: 0,
			maskShape: "rectangle",
		});
	});

	it("leaves the layout rect untouched at zero progress", () => {
		const base = pip();
		const rect = computeCameraFullscreenRect(base, CANVAS, 0);

		expect(rect.x).toBe(base.x);
		expect(rect.y).toBe(base.y);
		expect(rect.width).toBe(base.width);
		expect(rect.height).toBe(base.height);
		expect(rect.borderRadius).toBe(base.borderRadius);
	});

	it("takes the frame whatever the canvas' own aspect ratio", () => {
		const portrait = { width: 1080, height: 1920 };
		const rect = computeCameraFullscreenRect(pip(), portrait, 1);

		expect(rect.width).toBe(portrait.width);
		expect(rect.height).toBe(portrait.height);
	});

	it("dissolves a circle mask through its radius instead of popping it to a rectangle", () => {
		// computeCompositeLayout gives a circle a square box and a radius of half its
		// side, so a rounded rect at that radius IS that circle — the mask can flatten
		// to "rectangle" on frame one and the shape still eases out continuously.
		const circle = pip({ width: 270, height: 270, borderRadius: 135, maskShape: "circle" });

		const start = computeCameraFullscreenRect(circle, CANVAS, 0);
		expect(start.borderRadius).toBe(Math.min(circle.width, circle.height) / 2);
		expect(start.maskShape).toBe("rectangle");

		const mid = computeCameraFullscreenRect(circle, CANVAS, 0.5);
		expect(mid.borderRadius).toBeCloseTo(circle.borderRadius / 2, 5);
		expect(computeCameraFullscreenRect(circle, CANVAS, 1).borderRadius).toBe(0);
	});

	it("moves monotonically toward the frame, so the growth never doubles back", () => {
		const base = pip();
		let prevArea = base.width * base.height;
		for (const t of [0.25, 0.5, 0.75, 1]) {
			const rect = computeCameraFullscreenRect(base, CANVAS, t);
			const area = rect.width * rect.height;
			expect(area).toBeGreaterThan(prevArea);
			expect(rect.x).toBeGreaterThanOrEqual(0);
			expect(rect.y).toBeGreaterThanOrEqual(0);
			prevArea = area;
		}
	});

	it("clamps progress outside 0..1 instead of overshooting the frame", () => {
		expect(computeCameraFullscreenRect(pip(), CANVAS, 2)).toEqual(
			computeCameraFullscreenRect(pip(), CANVAS, 1),
		);
		expect(computeCameraFullscreenRect(pip(), CANVAS, -1)).toEqual(
			computeCameraFullscreenRect(pip(), CANVAS, 0),
		);
	});
});
