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
// <video>): it only has to report WHICH sources it was handed, let a test fire
// the terminal failure and the recovery for one of them, and show what retry
// token it was given — which is the entire contract Preview owns.
vi.mock("./PreviewCanvas", () => ({
	PreviewCanvas: ({
		videoSources,
		onVideoError,
		onVideoRecovered,
		retryToken,
	}: {
		videoSources: VideoSource[];
		onVideoError?: (assetId: string, detail: string) => void;
		onVideoRecovered?: (assetId: string) => void;
		retryToken?: number;
	}) => (
		<div
			data-testid="preview-canvas"
			data-sources={videoSources.map((s) => s.id).join(",")}
			data-retry-token={retryToken}
		>
			{videoSources.map((source) => (
				<div key={source.id}>
					<button
						type="button"
						data-testid={`fail-${source.id}`}
						onClick={() => onVideoError?.(source.id, "MEDIA_ERR_DECODE (3)")}
					>
						{source.src}
					</button>
					<button
						type="button"
						data-testid={`recover-${source.id}`}
						onClick={() => onVideoRecovered?.(source.id)}
					>
						recover
					</button>
				</div>
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

function previewProps(props: {
	videoSources: VideoSource[];
	clips: AxcutClip[];
	hasAsset?: boolean;
	hasProject?: boolean;
}) {
	return (
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
		</I18nProvider>
	);
}

function renderPreview(props: Parameters<typeof previewProps>[0]) {
	return render(previewProps(props));
}

const canvas = () => screen.queryByTestId("preview-canvas");
const emptyState = () => screen.queryByText(/add a video to get started/i);
const errorCard = () => screen.queryByTestId("preview-error-card");
const click = (testId: string) =>
	act(() => {
		fireEvent.click(screen.getByTestId(testId));
	});

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

	// A clip landing on a healthy asset takes over the preview regardless of what
	// happened to the asset that was mounted before it.
	it("switches to the asset a new clip references", () => {
		const { rerender } = renderPreview({ videoSources: [source("dangling")], clips: [] });
		click("fail-dangling");

		rerender(
			previewProps({
				videoSources: [source("dangling"), source("valid")],
				clips: [clip("clip_a", "valid", 0, 24.7)],
			}),
		);

		expect(canvas()).toHaveAttribute("data-sources", "valid");
	});
});

// Issue #395. Every test below used to assert the opposite — that a media
// failure collapsed the stage to the import screen. The intent was right (say
// something, offer a way out); the verdict was wrong, because the failure is
// recoverable, the project is intact, and the native canvas is still painting.
describe("Preview keeps the stage when the media fails", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("shows a retry card over the canvas instead of the empty state", () => {
		renderPreview({
			videoSources: [source("truncated")],
			clips: [clip("clip_a", "truncated", 0, 60)],
		});

		click("fail-truncated");

		expect(canvas()).toBeInTheDocument();
		expect(errorCard()).toBeInTheDocument();
		expect(emptyState()).not.toBeInTheDocument();
	});

	// The MediaError code is the one thing that makes a user's report actionable;
	// it used to be discarded entirely.
	it("puts the media error on the card", () => {
		renderPreview({ videoSources: [source("truncated")], clips: [] });
		click("fail-truncated");

		expect(errorCard()).toHaveTextContent("MEDIA_ERR_DECODE (3)");
	});

	// The whole point of the fix: a dead source is not a dead editor, and the
	// stage must stay mounted no matter how many sources report failure.
	it("keeps the canvas when every source the timeline uses fails", () => {
		renderPreview({
			videoSources: [source("broken"), source("healthy")],
			clips: [clip("clip_a", "broken", 0, 10), clip("clip_b", "healthy", 10, 20)],
		});

		click("fail-broken");
		click("fail-healthy");

		expect(canvas()).toBeInTheDocument();
		expect(emptyState()).not.toBeInTheDocument();
	});

	// Self-healing: VirtualPreview reports a decoded frame, so the card must go —
	// otherwise it outlives its own failure, which is the latch again in a
	// quieter form.
	it("drops the card when the source decodes again", () => {
		renderPreview({ videoSources: [source("flaky")], clips: [] });

		click("fail-flaky");
		expect(errorCard()).toBeInTheDocument();

		click("recover-flaky");
		expect(errorCard()).not.toBeInTheDocument();
	});

	// …including when the healthy report comes from a DIFFERENT asset. Only one
	// source is mounted at a time, so that report means the playhead has moved
	// onto a clip that plays — and a "Preview stopped" card over a picture that
	// is visibly fine is the #395 latch again, quieter. Scrubbing back onto the
	// dead asset remounts it and brings the card back on its own.
	it("drops the card when the playhead moves onto a healthy asset", () => {
		renderPreview({
			videoSources: [source("moved"), source("fresh")],
			clips: [clip("clip_a", "moved", 0, 10), clip("clip_b", "fresh", 10, 20)],
		});

		click("fail-moved");
		expect(errorCard()).toBeInTheDocument();

		click("recover-fresh");
		expect(errorCard()).not.toBeInTheDocument();
		expect(canvas()).toBeInTheDocument();
	});

	it("bumps the retry token and clears the card when the user retries", () => {
		renderPreview({ videoSources: [source("truncated")], clips: [] });
		expect(canvas()).toHaveAttribute("data-retry-token", "0");

		click("fail-truncated");
		act(() => {
			fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		});

		expect(canvas()).toHaveAttribute("data-retry-token", "1");
		expect(errorCard()).not.toBeInTheDocument();
	});

	// Taking the card's own advice — import a replacement — grows the source list
	// without touching the dead <video>: it is not remounted, nothing re-fires
	// `error`, and dropping the card here would leave a frozen stage with no
	// explanation and no Retry button.
	it("keeps the card when an unrelated source joins the timeline", () => {
		const { rerender } = renderPreview({
			videoSources: [source("moved")],
			clips: [clip("clip_a", "moved", 0, 60)],
		});
		click("fail-moved");
		expect(errorCard()).toBeInTheDocument();

		rerender(
			previewProps({
				videoSources: [source("moved"), source("fresh")],
				clips: [clip("clip_a", "moved", 0, 60), clip("clip_b", "fresh", 60, 90)],
			}),
		);

		expect(errorCard()).toBeInTheDocument();
	});

	// Swapping the media out has to clear the failure, or the card would outlive
	// the file that caused it.
	it("clears the failure when the failed asset leaves the timeline", () => {
		const { rerender } = renderPreview({
			videoSources: [source("truncated")],
			clips: [clip("clip_a", "truncated", 0, 60)],
		});
		click("fail-truncated");
		expect(errorCard()).toBeInTheDocument();

		rerender(
			previewProps({
				videoSources: [source("replacement")],
				clips: [clip("clip_a", "replacement", 0, 60)],
			}),
		);

		expect(canvas()).toHaveAttribute("data-sources", "replacement");
		expect(errorCard()).not.toBeInTheDocument();
	});
});

describe("Preview shows the empty state only when there is nothing to show", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("shows the empty state when the project has no asset at all", () => {
		renderPreview({ videoSources: [], clips: [], hasAsset: false });

		expect(canvas()).not.toBeInTheDocument();
		expect(emptyState()).toBeInTheDocument();
	});

	it("shows the empty state when the project has no usable source", () => {
		renderPreview({ videoSources: [], clips: [] });

		expect(canvas()).not.toBeInTheDocument();
		expect(emptyState()).toBeInTheDocument();
	});

	it("shows the empty state when there is no project", () => {
		renderPreview({ videoSources: [], clips: [], hasProject: false, hasAsset: false });

		expect(emptyState()).not.toBeInTheDocument();
		expect(screen.getByText(/no project open/i)).toBeInTheDocument();
	});

	// The guard for #395 itself: no failure, however reported, may reach the
	// branch that tells a user with media loaded that they have none.
	it("never reaches the empty state while the project has media", () => {
		renderPreview({
			videoSources: [source("a"), source("b")],
			clips: [clip("clip_a", "a", 0, 10), clip("clip_b", "b", 10, 20)],
		});

		for (const id of ["a", "b"]) {
			click(`fail-${id}`);
			expect(emptyState()).not.toBeInTheDocument();
			expect(canvas()).toBeInTheDocument();
		}
	});
});
