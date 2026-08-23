// @vitest-environment jsdom
// A mixed timeline is the case where "fill frame" cannot keep its promise for every clip, and
// the answer is to let the user say WHICH shape to fill rather than picking the majority
// silently. That choice only renders under conditions the other tests can't reach — a real
// document, with clips of two shapes, and the frame already zeroed — so it gets its own file.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
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
		// Deliberately NOT the fitted state, and not any shape the timeline holds: an
		// assertion that the action produced 16:9 + zeros proves nothing if the document
		// started there. These are the shipped defaults, which is what a real project opens
		// with anyway.
		legacyEditor: {
			padding: 50,
			borderRadius: 40,
			shadowIntensity: 0.2,
			aspectRatio: "1:1",
		},
	} as unknown as AxcutDocument;
}

function mount(doc: AxcutDocument, locale?: string) {
	if (locale) localStorage.setItem(LOCALE_STORAGE_KEY, locale);
	useProjectStore.setState({ document: doc });
	return render(
		<I18nProvider>
			<VideoEffectsPane />
		</I18nProvider>,
	);
}

/** What the action actually wrote, read back off the document it wrote to. */
function frameSettings() {
	const legacy = useProjectStore.getState().document?.legacyEditor as
		| Record<string, unknown>
		| undefined;
	return {
		aspectRatio: legacy?.aspectRatio,
		padding: legacy?.padding,
		borderRadius: legacy?.borderRadius,
		shadowIntensity: legacy?.shadowIntensity,
	};
}

beforeEach(() => {
	localStorage.clear();
	useProjectStore.setState({ document: null });
});
afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("fitting a clip is an action, and a choice only when there is one", () => {
	it("acts without asking when the timeline holds one shape", async () => {
		mount(documentWithShapes([[1920, 1080]]));
		fireEvent.click(screen.getByRole("button", { name: "Fit" }));

		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		// The whole point of the button, and what none of these cases used to check: not that
		// a menu did or did not open, but that the four frame settings actually moved.
		await waitFor(() =>
			expect(frameSettings()).toEqual({
				aspectRatio: "16:9",
				padding: 0,
				borderRadius: 0,
				shadowIntensity: 0,
			}),
		);
	});

	it("applies the shape the user picked, not the majority one", async () => {
		// Five landscape clips, two portrait. Picking the minority must win over the default,
		// or the menu is decoration.
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
		fireEvent.click(screen.getByRole("button", { name: "Fit" }));
		fireEvent.click(
			within(screen.getByRole("menu")).getByRole("menuitem", { name: /1080 × 1920/ }),
		);

		await waitFor(() =>
			expect(frameSettings()).toEqual({
				aspectRatio: "9:16",
				padding: 0,
				borderRadius: 0,
				shadowIntensity: 0,
			}),
		);
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
		fireEvent.click(screen.getByRole("button", { name: "Fit" }));

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
		fireEvent.click(screen.getByRole("button", { name: "Fit" }));
		const menu = screen.getByRole("menu");
		expect(
			within(menu).getByRole("menuitem", { name: /1080 × 1920.*1 clip$/ }),
		).toBeInTheDocument();
		expect(
			within(menu).getByRole("menuitem", { name: /1920 × 1080.*2 clips/ }),
		).toBeInTheDocument();
	});

	it("counts in Russian with the form the count actually needs", () => {
		// Russian has four plural categories, and 2-4 takes "клипа". Mapping everything that
		// is not `one` onto a single plural rendered "2 клипов", which is wrong rather than
		// merely coarse — the reason the count goes through Intl.PluralRules and not
		// `count === 1`.
		mount(
			documentWithShapes([
				[1920, 1080],
				[1920, 1080],
				[1080, 1920],
			]),
			"ru",
		);
		fireEvent.click(screen.getByRole("button", { name: "Подогнать" }));
		const menu = screen.getByRole("menu");
		expect(
			within(menu).getByRole("menuitem", { name: /1920 × 1080.*2 клипа/ }),
		).toBeInTheDocument();
		expect(
			within(menu).getByRole("menuitem", { name: /1080 × 1920.*1 клип$/ }),
		).toBeInTheDocument();
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
		expect(screen.getByRole("button", { name: "Fit" })).toBeInTheDocument();
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
	});
});
