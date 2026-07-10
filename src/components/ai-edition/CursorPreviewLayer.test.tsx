import "@testing-library/jest-dom";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { CursorPreviewLayer } from "./CursorPreviewLayer";

const bridgeMocks = vi.hoisted(() => ({
	getRecordingData: vi.fn(),
	getTelemetry: vi.fn(),
}));

class StubResizeObserver {
	private callback: ResizeObserverCallback;
	private target: Element | null = null;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
	}
	observe(target: Element) {
		this.target = target;
		return undefined;
	}
	unobserve() {
		return undefined;
	}
	disconnect() {
		return undefined;
	}
}

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		cursor: {
			getRecordingData: bridgeMocks.getRecordingData,
			getTelemetry: bridgeMocks.getTelemetry,
		},
	},
}));

vi.mock("@/lib/cursor/pixiCursorRenderer", () => ({
	DEFAULT_CURSOR_CONFIG: { dotRadius: 28, smoothingFactor: 0, motionBlur: 0, clickBounce: 1 },
	preloadCursorAssets: vi.fn(async () => undefined),
	PixiCursorOverlay: class {
		public container = { label: "" };
		// ponytail: no-op stubs — the test asserts on the React boundary,
		// not on Pixi internals.
		update() {
			/* no-op */
		}
		setDotRadius() {
			/* no-op */
		}
		setSmoothingFactor() {
			/* no-op */
		}
		setMotionBlur() {
			/* no-op */
		}
		setClickBounce() {
			/* no-op */
		}
		reset() {
			/* no-op */
		}
		destroy() {
			/* no-op */
		}
	},
}));

vi.mock("pixi.js", () => ({
	Application: class {
		public canvas = document.createElement("canvas");
		public stage = { addChild: vi.fn() };
		public ticker = { maxFPS: 60 };
		public renderer = {};
		// ponytail: no-op stubs — the test asserts on the React boundary,
		// not on Pixi internals.
		async init() {
			/* no-op */
		}
		destroy() {
			/* no-op */
		}
	},
	Container: class {},
}));

const SAMPLE_DOC = {
	schemaVersion: 3,
	project: {
		id: "proj_test",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
	},
	assets: [],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRegions: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	legacyEditor: null,
	agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
	preview: { strategy: "seek", revision: 0 },
	export: { preset: "final-balanced", lastJobId: null },
	history: { revisions: [] },
};

function renderWithVideo(): { host: HTMLDivElement; video: HTMLVideoElement } {
	const stage = document.createElement("div");
	const video = document.createElement("video");
	stage.appendChild(video);
	document.body.appendChild(stage);
	vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		width: 1920,
		height: 1080,
		top: 0,
		right: 1920,
		bottom: 1080,
		left: 0,
		toJSON: () => "",
	});

	const host = document.createElement("div");
	stage.appendChild(host);
	act(() => {
		render(
			<CursorPreviewLayer videoPath="/tmp/recording.mp4" currentTimeSec={0.5} isPlaying={false} />,
			{ container: host },
		);
	});
	return { host: stage, video };
}

describe("CursorPreviewLayer (shared)", () => {
	beforeEach(() => {
		Object.defineProperty(window, "ResizeObserver", {
			writable: true,
			value: StubResizeObserver,
		});
		useProjectStore.getState().clear();
		useProjectStore.setState({
			projectId: "proj_test",
			document: SAMPLE_DOC,
			revision: 1,
			status: "ready",
			error: null,
			sourceDurationSec: 0,
			currentTimeSec: 0,
			dirty: false,
			lastSavedAt: new Date(),
		});
		for (const mock of Object.values(bridgeMocks)) {
			mock.mockReset();
		}
	});

	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
	});

	it("renders nothing when videoPath is null", () => {
		bridgeMocks.getRecordingData.mockResolvedValue(null);
		bridgeMocks.getTelemetry.mockResolvedValue([]);
		const host = document.createElement("div");
		document.body.appendChild(host);
		act(() => {
			render(<CursorPreviewLayer videoPath={null} currentTimeSec={0} isPlaying={false} />, {
				container: host,
			});
		});
		expect(host.querySelector("img")).toBeNull();
	});

	it("queries the native bridge for cursor data when videoPath is set", async () => {
		bridgeMocks.getRecordingData.mockImplementation(async () => null);
		bridgeMocks.getTelemetry.mockImplementation(async () => []);
		renderWithVideo();

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(bridgeMocks.getRecordingData).toHaveBeenCalledWith("/tmp/recording.mp4");
		expect(bridgeMocks.getTelemetry).toHaveBeenCalledWith("/tmp/recording.mp4");
	});

	it("hides the native cursor <img> when settings.cursorShow is false", async () => {
		bridgeMocks.getRecordingData.mockImplementation(async () => null);
		bridgeMocks.getTelemetry.mockImplementation(async () => []);
		const document = useProjectStore.getState().document;
		useProjectStore.setState({
			document: { ...document!, legacyEditor: { cursorShow: false } },
		});
		const { host } = renderWithVideo();

		// ponytail: let the rAF tick fire + flush.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 16));
		});

		const img = host.querySelector("img");
		expect(img).toBeTruthy();
		expect((img as HTMLImageElement).style.display).toBe("none");
	});
});
