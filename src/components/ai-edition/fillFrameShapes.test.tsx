// @vitest-environment jsdom
// A mixed timeline is the case where "fill frame" cannot keep its promise for every clip, and
// the answer is to let the user say WHICH shape to fill rather than picking the majority
// silently. That choice only renders under conditions the other tests can't reach — a real
// document, with clips of two shapes, and the frame already zeroed — so it gets its own file.

import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { VideoEffectsPane } from "./RightPanes";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

/** A timeline whose clips carry the given pixel shapes, one clip per entry. */
function documentWithShapes(shapes: Array<[number, number]>): AxcutDocument {
	const base = createEmptyDocument({ title: "T", projectId: "p1" });
	return {
		...base,
		assets: shapes.map(([width, height], i) => ({
			id: `asset_${i}`,
			kind: "video" as const,
			label: `Clip ${i}`,
			originalPath: `/tmp/clip${i}.mp4`,
			durationSec: 10,
			cameraTrack: null,
			video: { width, height },
		})),
		timeline: {
			...base.timeline,
			clips: shapes.map((_, i) => ({
				id: `clip_${i}`,
				assetId: `asset_${i}`,
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: i * 10,
				timelineEndSec: (i + 1) * 10,
				wordRefs: [],
				origin: "user" as const,
				reason: "",
			})),
		},
		// The frame already zeroed, so the switch reads ON and the choice is live.
		legacyEditor: {
			padding: 0,
			borderRadius: 0,
			shadowIntensity: 0,
			aspectRatio: "16:9",
		},
	} as unknown as AxcutDocument;
}

function mount(doc: AxcutDocument) {
	useProjectStore.setState({ document: doc });
	return render(
		<I18nProvider>
			<VideoEffectsPane />
		</I18nProvider>,
	);
}

beforeEach(() => {
	useProjectStore.setState({ document: null });
});
afterEach(cleanup);

describe("a mixed timeline gets a shape to choose, not a shape imposed", () => {
	it("offers every distinct shape, with the clip count behind each", () => {
		// Five landscape clips and two portrait inserts: picking the majority silently would
		// mean the portrait ones can never be made to fill.
		mount(
			documentWithShapes([
				[1920, 1080],
				[1920, 1080],
				[1920, 1080],
				[1920, 1080],
				[1920, 1080],
				[1080, 1920],
				[1080, 1920],
			]),
		);

		expect(screen.getByRole("button", { name: /16:9/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /9:16/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /16:9\s*5/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /9:16\s*2/ })).toBeInTheDocument();
	});

	it("says the other shapes still show the background", () => {
		mount(
			documentWithShapes([
				[1920, 1080],
				[1080, 1920],
			]),
		);
		expect(screen.getByRole("note")).toHaveTextContent(
			"Clips in another shape still show the background.",
		);
	});

	it("offers no choice when every clip is the same shape — there is nothing to arbitrate", () => {
		mount(
			documentWithShapes([
				[1920, 1080],
				[3840, 2160],
			]),
		);
		// 1920x1080 and 3840x2160 are both 16:9: one shape, so no chooser and no caveat.
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
		expect(screen.queryByRole("group")).not.toBeInTheDocument();
	});
});
