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

describe("fitting a clip is an action, and a choice only when there is one", () => {
	it("labels the button for the single-shape case and acts without asking", () => {
		mount(documentWithShapes([[1920, 1080]]));
		fireEvent.click(screen.getByRole("button", { name: "Fit the clip" }));
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});

	it("asks which clip when the timeline holds more than one shape", () => {
		// Five landscape clips and two portrait inserts: picking the majority silently would
		// mean the portrait ones can never be fitted.
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
		fireEvent.click(screen.getByRole("button", { name: "Fit a clip" }));

		const menu = screen.getByRole("menu");
		// Resolution leads — `683:384` and `64:27` mean nothing to a user, `1920 × 1080` does.
		expect(
			within(menu).getByRole("menuitem", { name: /1920 × 1080.*5 clips/ }),
		).toBeInTheDocument();
		expect(
			within(menu).getByRole("menuitem", { name: /1080 × 1920.*2 clips/ }),
		).toBeInTheDocument();
	});

	it('counts one clip as "1 clip"', () => {
		mount(
			documentWithShapes([
				[1920, 1080],
				[1920, 1080],
				[1080, 1920],
			]),
		);
		fireEvent.click(screen.getByRole("button", { name: "Fit a clip" }));
		const menu = screen.getByRole("menu");
		expect(
			within(menu).getByRole("menuitem", { name: /1080 × 1920.*1 clip$/ }),
		).toBeInTheDocument();
		expect(
			within(menu).getByRole("menuitem", { name: /1920 × 1080.*2 clips/ }),
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

	it("collapses same-shape clips to one entry, labelled with the biggest", () => {
		mount(
			documentWithShapes([
				[1920, 1080],
				[3840, 2160],
			]),
		);
		// Both are 16:9, so there is one shape and nothing to arbitrate — and the ratio menu's
		// rule applies: the label shows the best resolution available.
		expect(screen.getByRole("button", { name: "Fit the clip" })).toBeInTheDocument();
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
	});
});
