// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { Preview } from "./Preview";
import type { VideoSource } from "./VirtualPreview";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: {} },
}));

// Stand-in for the real canvas (native compositor, editor settings, a live
// <video>): it only has to report WHICH sources it was handed and let a test
// fire the load failure for one of them, which is the entire contract Preview
// owns.
vi.mock("./PreviewCanvas", () => ({
	PreviewCanvas: ({
		videoSources,
		onVideoError,
	}: {
		videoSources: VideoSource[];
		onVideoError?: (assetId: string) => void;
	}) => (
		<div data-testid="preview-canvas" data-sources={videoSources.map((s) => s.id).join(",")}>
			{videoSources.map((source) => (
				<button
					key={source.id}
					type="button"
					data-testid={`fail-${source.id}`}
					onClick={() => onVideoError?.(source.id)}
				>
					{source.src}
				</button>
			))}
		</div>
	),
}));

function clip(id: string, assetId: string, startSec: number, endSec: number): AxcutClip {
	return {
		id,
		assetId,
		sourceStartSec: 0,
		sourceEndSec: endSec - startSec,
		timelineStartSec: startSec,
		timelineEndSec: endSec,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

function source(id: string): VideoSource {
	return { id, src: `file:///tmp/${id}.mp4`, label: id };
}

function renderPreview(props: {
	videoSources: VideoSource[];
	clips: AxcutClip[];
	hasAsset?: boolean;
	hasProject?: boolean;
}) {
	return render(
		<I18nProvider>
			<Preview
				hasProject={props.hasProject ?? true}
				hasAsset={props.hasAsset ?? true}
				videoSources={props.videoSources}
				clips={props.clips}
				seekTarget={null}
				onTimeChange={vi.fn()}
				onSeek={vi.fn()}
				onLoadedMetadata={vi.fn()}
				onVideoElement={vi.fn()}
				playing={false}
			/>
		</I18nProvider>,
	);
}

const canvas = () => screen.queryByTestId("preview-canvas");
const emptyState = () => screen.queryByText(/add a video to get started/i);

describe("Preview follows the timeline, not the asset list", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	// THE regression: the user imported a file, then moved/deleted it (or removed
	// the clip that used it), leaving a dangling asset in the document. It sorted
	// FIRST in `document.assets`, so it was the source the canvas mounted, its
	// <video> failed, and the whole preview fell back to the empty state — with a
	// perfectly playable clip sitting on the timeline.
	it("never mounts an asset no clip references", () => {
		renderPreview({
			videoSources: [source("dangling"), source("valid")],
			clips: [clip("clip_a", "valid", 0, 24.7)],
		});

		expect(canvas()).toBeInTheDocument();
		expect(canvas()).toHaveAttribute("data-sources", "valid");
		expect(emptyState()).not.toBeInTheDocument();
	});

	// The dead asset can't even report a failure now, but should one arrive for a
	// source that is no longer used, it must not blank a preview built from other
	// sources entirely.
	it("keeps rendering when the unreferenced asset is the only broken one", () => {
		const { rerender } = renderPreview({
			videoSources: [source("dangling")],
			clips: [],
		});
		// No clips yet → fallback to every asset, so the dead one does mount and fail.
		act(() => {
			fireEvent.click(screen.getByTestId("fail-dangling"));
		});
		expect(emptyState()).toBeInTheDocument();

		// A clip lands on a healthy asset: the preview is driven by that clip now,
		// and the earlier failure of an asset nothing references is irrelevant.
		rerender(
			<I18nProvider>
				<Preview
					hasProject={true}
					hasAsset={true}
					videoSources={[source("dangling"), source("valid")]}
					clips={[clip("clip_a", "valid", 0, 24.7)]}
					seekTarget={null}
					onTimeChange={vi.fn()}
					onSeek={vi.fn()}
					onLoadedMetadata={vi.fn()}
					onVideoElement={vi.fn()}
					playing={false}
				/>
			</I18nProvider>,
		);

		expect(canvas()).toHaveAttribute("data-sources", "valid");
	});

	// Mounting index 0 is VirtualPreview's own starting point, so the source list
	// has to lead with the asset the playhead needs at 0:00 — not whatever order
	// the assets happen to be stored in.
	it("orders the sources by timeline position", () => {
		renderPreview({
			videoSources: [source("second"), source("first")],
			clips: [clip("clip_b", "second", 10, 20), clip("clip_a", "first", 0, 10)],
		});

		expect(canvas()).toHaveAttribute("data-sources", "first,second");
	});

	// An asset used by two clips must not be handed over twice — VirtualPreview
	// indexes into this list, and a duplicate entry means two indices for one
	// source (and a pointless <video> remount on the boundary between them).
	it("de-duplicates an asset used by several clips", () => {
		renderPreview({
			videoSources: [source("only")],
			clips: [clip("clip_a", "only", 0, 10), clip("clip_b", "only", 10, 20)],
		});

		expect(canvas()).toHaveAttribute("data-sources", "only");
	});

	// The bootstrap path: `handleLoadedMetadata` mints the very first clip from
	// the <video>'s own metadata, so a just-imported asset has to be mounted
	// while nothing references it yet.
	it("falls back to every asset while the timeline is empty", () => {
		renderPreview({ videoSources: [source("fresh_import")], clips: [] });

		expect(canvas()).toHaveAttribute("data-sources", "fresh_import");
	});
});

describe("Preview still degrades to the empty state on a real failure", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	// The documented intent this fix must not regress: a truncated recording from
	// a bad MediaRecorder capture is referenced by a clip, fails to load, and the
	// user gets the import affordance rather than a broken preview.
	it("shows the empty state when the clip's own asset fails to load", () => {
		renderPreview({
			videoSources: [source("truncated")],
			clips: [clip("clip_a", "truncated", 0, 60)],
		});
		expect(canvas()).toBeInTheDocument();

		act(() => {
			fireEvent.click(screen.getByTestId("fail-truncated"));
		});

		expect(canvas()).not.toBeInTheDocument();
		expect(emptyState()).toBeInTheDocument();
	});

	// Per-source, not a global latch: one dead asset among several used by the
	// timeline leaves the rest renderable (VirtualPreview draws its own overlay
	// over the source that failed).
	it("survives one broken source among several the timeline uses", () => {
		renderPreview({
			videoSources: [source("broken"), source("healthy")],
			clips: [clip("clip_a", "broken", 0, 10), clip("clip_b", "healthy", 10, 20)],
		});

		act(() => {
			fireEvent.click(screen.getByTestId("fail-broken"));
		});
		expect(canvas()).toBeInTheDocument();

		// …and only collapses once nothing is left to render.
		act(() => {
			fireEvent.click(screen.getByTestId("fail-healthy"));
		});
		expect(canvas()).not.toBeInTheDocument();
		expect(emptyState()).toBeInTheDocument();
	});

	// The reset that made the old latch bearable: swapping the media out has to
	// clear the recorded failures, or the empty state would outlive the file that
	// caused it.
	it("clears recorded failures when the source set changes", () => {
		const { rerender } = renderPreview({
			videoSources: [source("truncated")],
			clips: [clip("clip_a", "truncated", 0, 60)],
		});
		act(() => {
			fireEvent.click(screen.getByTestId("fail-truncated"));
		});
		expect(emptyState()).toBeInTheDocument();

		rerender(
			<I18nProvider>
				<Preview
					hasProject={true}
					hasAsset={true}
					videoSources={[source("replacement")]}
					clips={[clip("clip_a", "replacement", 0, 60)]}
					seekTarget={null}
					onTimeChange={vi.fn()}
					onSeek={vi.fn()}
					onLoadedMetadata={vi.fn()}
					onVideoElement={vi.fn()}
					playing={false}
				/>
			</I18nProvider>,
		);

		expect(canvas()).toHaveAttribute("data-sources", "replacement");
	});

	it("shows the empty state when the project has no asset at all", () => {
		renderPreview({ videoSources: [], clips: [], hasAsset: false });

		expect(canvas()).not.toBeInTheDocument();
		expect(emptyState()).toBeInTheDocument();
	});
});
