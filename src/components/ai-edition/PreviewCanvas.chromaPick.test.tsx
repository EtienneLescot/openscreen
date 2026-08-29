// @vitest-environment jsdom
/**
 * The eyedropper's click, end to end through `PreviewCanvas`.
 *
 * What is NOT covered anywhere else: the native pushes. The live preview builds
 * its params from `setNativeParam` and never re-reads the scene, so a pick that
 * only writes the setting leaves the native window keying on the OLD colour —
 * a bug that is invisible to every pure test in `webcamEyedropper.test.ts`,
 * because it is not in the maths, it is in the wiring. `Preview.test.tsx` cannot
 * catch it either: it mocks this component out entirely.
 *
 * The pushes have to land BEFORE `commit()`, which is what pins the shape of the
 * handler: `commit` awaits a disk write, and a colour that reaches the compositor
 * only after it would flash the old key for the length of that write.
 *
 * The geometry and the sampling are stubbed — both have their own unit tests, and
 * jsdom reports a zero-sized slot and a zero-sized video, so the real ones would
 * bail before any of this ran. What is left is exactly the wiring.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import { axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { startChromaPick, stopChromaPick } from "@/lib/ai-edition/store/chromaPickStore";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { EyedropperCrop } from "@/lib/ai-edition/webcamEyedropper";

const mocks = vi.hoisted(() => ({
	isNativeCompositorActive: vi.fn<() => boolean>(() => true),
	setNativeParam: vi.fn<(key: string, value: unknown) => void>(),
	mapSlotPointToVideoPixel: vi.fn<() => { x: number; y: number } | null>(() => ({ x: 42, y: 24 })),
	sampleVideoPixelHex: vi.fn<() => string | null>(() => "#00b140"),
	saveDocument: vi.fn(async () => true),
	/** Every native push and every commit, in the order they actually happened. */
	order: [] as string[],
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: {} },
}));

vi.mock("@/native/nativeCompositorStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/native/nativeCompositorStore")>()),
	isNativeCompositorActive: mocks.isNativeCompositorActive,
	setNativeParam: mocks.setNativeParam,
}));

vi.mock("@/lib/ai-edition/webcamEyedropper", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ai-edition/webcamEyedropper")>()),
	mapSlotPointToVideoPixel: mocks.mapSlotPointToVideoPixel,
	sampleVideoPixelHex: mocks.sampleVideoPixelHex,
}));

// The pixel sources are irrelevant here and expensive to boot: the native canvas
// wants a GPU view, the two <video>s want real media. Only the camera stand-in
// carries a contract this test needs — it is what hands the handler its element.
vi.mock("./NativeCompositorOverlay", () => ({
	NativeCompositorOverlay: () => <div data-testid="native-overlay" />,
}));

vi.mock("./VirtualPreview", () => ({
	VirtualPreview: () => <div data-testid="virtual-preview" />,
}));

vi.mock("./WebcamOverlay", () => ({
	WebcamOverlay: ({
		onVideoElement,
	}: {
		onVideoElement?: (el: HTMLVideoElement | null) => void;
	}) => (
		<video
			data-testid="webcam-video"
			ref={(el) => {
				onVideoElement?.(el);
			}}
		/>
	),
}));

import { PreviewCanvas } from "./PreviewCanvas";

const CLIP: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 0,
	sourceEndSec: 5,
	timelineStartSec: 0,
	timelineEndSec: 5,
	wordRefs: [],
	origin: "system",
	reason: "",
};

function makeDocument(): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "proj_test",
			title: "Test",
			createdAt: "2026-08-29T10:00:00.000Z",
			updatedAt: "2026-08-29T10:00:00.000Z",
			primaryAssetId: "asset_1",
		},
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "a1",
				originalPath: "/screen-1.mp4",
				// The slot only renders for a clip whose asset has a visible camera —
				// no camera, no eyedropper target.
				cameraTrack: { sourcePath: "/cam-1.mp4", startMs: 0, offsetMs: 0, visible: true },
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [CLIP],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	};
}

function renderCanvas() {
	return render(
		<I18nProvider>
			<PreviewCanvas
				videoSources={[{ id: "asset_1", src: "file:///tmp/screen-1.mp4", label: "a1" }]}
				clips={[CLIP]}
				seekTarget={null}
				currentTimeSec={1}
				onTimeChange={() => undefined}
				onSeek={() => undefined}
				onLoadedMetadata={() => undefined}
				onVideoElement={() => undefined}
			/>
		</I18nProvider>,
	);
}

/** The PiP hitbox, which is also the eyedropper's target. */
function webcamSlot(): HTMLElement {
	return screen.getByLabelText("Webcam preview (drag to reposition)");
}

// jsdom implements no pointer capture, and the drag handler the slot falls back
// to once the eyedropper is disarmed calls it — without these the last test below
// dies in an event listener instead of asserting.
beforeEach(() => {
	Element.prototype.setPointerCapture ??= () => undefined;
	Element.prototype.releasePointerCapture ??= () => undefined;
	mocks.order.length = 0;
	mocks.setNativeParam.mockImplementation((key) => {
		mocks.order.push(`param:${key}`);
	});
	mocks.saveDocument.mockImplementation(async () => {
		mocks.order.push("commit");
		return true;
	});
	mocks.isNativeCompositorActive.mockReturnValue(true);
	mocks.mapSlotPointToVideoPixel.mockReturnValue({ x: 42, y: 24 });
	mocks.sampleVideoPixelHex.mockReturnValue("#00b140");
	useProjectStore.setState({
		projectId: "proj_test",
		document: makeDocument(),
		revision: 1,
		status: "ready",
		error: null,
		sourceDurationSec: 5,
		currentTimeSec: 1,
		dirty: false,
		lastSavedAt: new Date(),
		saveDocument: mocks.saveDocument,
	});
	startChromaPick();
});

afterEach(() => {
	stopChromaPick();
	cleanup();
	vi.clearAllMocks();
	useProjectStore.getState().clear();
});

describe("PreviewCanvas chroma pick", () => {
	it("pushes the sampled colour to the native compositor before committing", () => {
		renderCanvas();
		fireEvent.pointerDown(webcamSlot(), { clientX: 20, clientY: 30 });

		expect(mocks.setNativeParam).toHaveBeenCalledWith("webcamChromaColor", "#00b140");
		// The pick ARMS the key as well as colouring it — the setting write says
		// `enabled: true`, so the compositor has to hear that too or the preview
		// stays un-keyed until the toggle is touched.
		expect(mocks.setNativeParam).toHaveBeenCalledWith("webcamChromaEnabled", true);
		// Ordering is the point: `commit` awaits a disk write, and pushing after it
		// would show the old key for the length of that write.
		expect(mocks.order).toEqual(["param:webcamChromaColor", "param:webcamChromaEnabled", "commit"]);
	});

	it("writes the colour into the document as well as the compositor", () => {
		// Both roads or the feature is half-wired: the export reads the scene, the
		// live preview reads the pushes.
		renderCanvas();
		fireEvent.pointerDown(webcamSlot(), { clientX: 20, clientY: 30 });

		const key = useProjectStore.getState().document?.legacyEditor?.webcamChromaKey as
			| { color: string; enabled: boolean }
			| undefined;
		expect(key?.color).toBe("#00b140");
		expect(key?.enabled).toBe(true);
	});

	it("samples through the same mirror and crop the user is looking at", () => {
		// The element carries the crop as an `object-view-box` and the mirror as a
		// `scaleX(-1)`; dropping either from this call is what makes a zoomed camera
		// sample the pixel next to the one that was clicked.
		renderCanvas();
		fireEvent.pointerDown(webcamSlot(), { clientX: 20, clientY: 30 });

		const [, , , mirrored, crop] = mocks.mapSlotPointToVideoPixel.mock.calls[0] as unknown as [
			unknown,
			unknown,
			unknown,
			boolean,
			EyedropperCrop,
		];
		expect(mirrored).toBe(false); // settings.webcamMirrored
		expect(crop).toEqual({ x: 0, y: 0, width: 1, height: 1 }); // settings.webcamCropRegion
	});

	it("skips the pushes when no native view is mounted, but still commits", () => {
		// `setNativeParam` memoises for replay even with no view, so pushing
		// unconditionally would seed a colour the user never picked in the browser
		// build. The guard is deliberate; this pins it.
		mocks.isNativeCompositorActive.mockReturnValue(false);
		renderCanvas();
		fireEvent.pointerDown(webcamSlot(), { clientX: 20, clientY: 30 });

		expect(mocks.setNativeParam).not.toHaveBeenCalled();
		expect(mocks.order).toEqual(["commit"]);
	});

	it("pushes nothing when the frame cannot be sampled", () => {
		// A video with no decoded frame yet returns null. Nothing should move —
		// not the compositor, not the document.
		mocks.sampleVideoPixelHex.mockReturnValue(null);
		renderCanvas();
		fireEvent.pointerDown(webcamSlot(), { clientX: 20, clientY: 30 });

		expect(mocks.setNativeParam).not.toHaveBeenCalled();
		expect(mocks.order).toEqual([]);
	});

	it("disarms the eyedropper on the click, sampled or not", () => {
		// An eyedropper still armed after a click reads as a frozen editor: the
		// preview keeps showing the raw camera and the next click re-picks.
		mocks.sampleVideoPixelHex.mockReturnValue(null);
		renderCanvas();
		fireEvent.pointerDown(webcamSlot(), { clientX: 20, clientY: 30 });

		// Disarmed means the slot is a drag hitbox again, not a colour target: the
		// second press goes to the reposition handler and samples nothing.
		fireEvent.pointerDown(webcamSlot(), { clientX: 20, clientY: 30 });
		expect(mocks.sampleVideoPixelHex).toHaveBeenCalledTimes(1);
	});
});
