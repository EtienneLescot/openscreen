// @vitest-environment jsdom
// A mixed timeline is the case where "fill frame" cannot keep its promise for every clip, and
// the answer is to let the user say WHICH shape to fill rather than picking the majority
// silently. That choice only renders under conditions the other tests can't reach — a real
// document, with clips of two shapes, and the frame already zeroed — so it gets its own file.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
	it("names the current fill by RESOLUTION, not by ratio token", () => {
		// `16:9` is readable; `683:384` and `64:27` are not. What a user recognises about
		// their own footage is its resolution, so that is what the control says.
		mount(documentWithShapes([[1920, 1080]]));
		expect(screen.getByRole("button", { name: /1920 × 1080/ })).toBeInTheDocument();
	});

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
		fireEvent.click(screen.getByRole("button", { name: /1920 × 1080/ }));

		const menu = screen.getByRole("menu");
		expect(within(menu).getByRole("menuitem", { name: /1920 × 1080.*5/ })).toBeInTheDocument();
		expect(within(menu).getByRole("menuitem", { name: /1080 × 1920.*2/ })).toBeInTheDocument();
	});

	it("offers a way back out of the menu it opened", () => {
		mount(
			documentWithShapes([
				[1920, 1080],
				[1080, 1920],
			]),
		);
		fireEvent.click(screen.getByRole("button", { name: /1920 × 1080/ }));
		expect(
			within(screen.getByRole("menu")).getByRole("menuitem", { name: "Restore the frame" }),
		).toBeInTheDocument();
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

	it("asks nothing when every clip is the same shape — the button just acts", () => {
		mount(
			documentWithShapes([
				[1920, 1080],
				[3840, 2160],
			]),
		);
		// 1920x1080 and 3840x2160 are both 16:9, so they collapse to ONE shape — labelled with
		// the biggest representative, the same rule the ratio menu uses so the label shows the
		// best resolution available. One shape means no menu and no caveat.
		fireEvent.click(screen.getByRole("button", { name: /3840 × 2160/ }));
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
	});
});
