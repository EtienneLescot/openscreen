// @vitest-environment jsdom
/**
 * The eyedropper's armed flag lives at module scope, and two components that never
 * see each other read it: the button in the Layout pane arms it, the preview
 * consumes the click and disarms it. So the behaviour worth pinning is not the
 * boolean — it is that a change on one side REACHES the other, and that a
 * redundant call does not fire a render on every component watching.
 *
 * jsdom, because the only subscriber path out of this module is the hook: the
 * `subscribe` half is deliberately private, and testing the flag without it would
 * leave the actual wiring — the part that breaks — uncovered.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isChromaPicking,
	startChromaPick,
	stopChromaPick,
	useChromaPicking,
} from "./chromaPickStore";

// Module state outlives the test that set it; every test starts disarmed.
afterEach(() => {
	stopChromaPick();
});

describe("chromaPickStore", () => {
	it("starts disarmed", () => {
		expect(isChromaPicking()).toBe(false);
	});

	it("arms and disarms", () => {
		startChromaPick();
		expect(isChromaPicking()).toBe(true);
		stopChromaPick();
		expect(isChromaPicking()).toBe(false);
	});

	it("pushes both transitions to a mounted consumer", () => {
		const { result } = renderHook(() => useChromaPicking());
		expect(result.current).toBe(false);

		act(() => startChromaPick());
		expect(result.current).toBe(true);

		act(() => stopChromaPick());
		expect(result.current).toBe(false);
	});

	it("does not re-render on a redundant call", () => {
		// `PreviewCanvas` disarms on every pick AND on Escape AND on unmount, so the
		// no-op path is the common one; emitting there would re-render the whole
		// inspector for nothing.
		const renders = vi.fn();
		renderHook(() => {
			renders();
			return useChromaPicking();
		});
		const initial = renders.mock.calls.length;

		act(() => stopChromaPick()); // already disarmed
		expect(renders.mock.calls.length).toBe(initial);

		act(() => startChromaPick());
		const armed = renders.mock.calls.length;
		expect(armed).toBeGreaterThan(initial);

		act(() => startChromaPick()); // already armed
		expect(renders.mock.calls.length).toBe(armed);
	});

	it("stops notifying an unmounted consumer", () => {
		// The pane unmounts with the eyedropper still armed whenever the user switches
		// facets; a listener left in the set would keep a dead tree subscribed.
		const renders = vi.fn();
		const { unmount } = renderHook(() => {
			renders();
			return useChromaPicking();
		});
		unmount();
		const after = renders.mock.calls.length;

		act(() => startChromaPick());
		act(() => stopChromaPick());
		expect(renders.mock.calls.length).toBe(after);
	});
});
