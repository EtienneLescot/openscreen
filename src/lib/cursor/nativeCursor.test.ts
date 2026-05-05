import { describe, expect, it } from "vitest";
import {
	getNativeCursorClickBounceProgress,
	getNativeCursorClickBounceScale,
} from "./nativeCursor";

describe("native cursor click bounce", () => {
	it("keeps click progress visible across several frames", () => {
		const recordingData = {
			version: 2,
			provider: "native" as const,
			assets: [],
			samples: [
				{ timeMs: 0, cx: 0.5, cy: 0.5, interactionType: "move" as const },
				{ timeMs: 100, cx: 0.5, cy: 0.5, interactionType: "click" as const },
				{ timeMs: 133, cx: 0.5, cy: 0.5, interactionType: "move" as const },
				{ timeMs: 166, cx: 0.5, cy: 0.5, interactionType: "move" as const },
				{ timeMs: 200, cx: 0.5, cy: 0.5, interactionType: "move" as const },
				{ timeMs: 300, cx: 0.5, cy: 0.5, interactionType: "move" as const },
			],
		};

		expect(getNativeCursorClickBounceProgress(recordingData, 133)).toBeGreaterThan(0);
		expect(getNativeCursorClickBounceProgress(recordingData, 200)).toBeGreaterThan(0);
		expect(getNativeCursorClickBounceProgress(recordingData, 400)).toBe(0);
	});

	it("applies a visible press and rebound scale at high intensity", () => {
		expect(getNativeCursorClickBounceScale(5, 1)).toBe(1);
		expect(getNativeCursorClickBounceScale(5, 0.82)).toBeLessThan(0.9);
		expect(getNativeCursorClickBounceScale(5, 0.28)).toBeGreaterThan(1.05);
		expect(getNativeCursorClickBounceScale(5, 0)).toBe(1);
	});
});
