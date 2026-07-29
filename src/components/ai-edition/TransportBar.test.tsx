import "@testing-library/jest-dom";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { TransportBar } from "./TransportBar";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: {} },
}));

const clips = [
	{
		id: "clip_a",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 30,
		timelineStartSec: 0,
		timelineEndSec: 30,
		wordRefs: [],
		origin: "user" as const,
		reason: "",
	},
];

const noop = vi.fn();

describe("TransportBar reads the playhead from the store", () => {
	beforeEach(() => {
		useProjectStore.setState({ currentTimeSec: 0 });
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	// The counterpart to useTimeline.test.ts's "not re-rendered by playhead ticks":
	// now that the editor shell no longer subscribes to the playhead, the pieces that
	// DO display it have to pick it up themselves. Nothing here re-renders the parent
	// — the store write alone must move the timecode.
	it("updates the timecode on a store write, with no parent re-render", () => {
		let parentRenders = 0;
		function Parent() {
			parentRenders++;
			return (
				<TransportBar
					playing={false}
					overrideTimeSec={null}
					clips={clips}
					onTogglePlay={noop}
					onPrevClip={noop}
					onNextClip={noop}
					onSeek={noop}
				/>
			);
		}

		render(
			<I18nProvider>
				<Parent />
			</I18nProvider>,
		);
		const rendersAfterMount = parentRenders;
		expect(screen.getByText("0:00.0")).toBeInTheDocument();

		act(() => {
			useProjectStore.getState().setCurrentTime(12.3);
		});

		expect(screen.getByText("0:12.3")).toBeInTheDocument();
		expect(parentRenders).toBe(rendersAfterMount);
	});

	// A timeline scrub drag writes the store on a rAF, so for the frame in between the
	// pointer position is only in `overrideTimeSec` — it has to win over the store.
	it("prefers the live scrub override over the store value", () => {
		useProjectStore.setState({ currentTimeSec: 12.3 });
		render(
			<I18nProvider>
				<TransportBar
					playing={false}
					overrideTimeSec={4.5}
					clips={clips}
					onTogglePlay={noop}
					onPrevClip={noop}
					onNextClip={noop}
					onSeek={noop}
				/>
			</I18nProvider>,
		);
		expect(screen.getByText("0:04.5")).toBeInTheDocument();
	});
});
