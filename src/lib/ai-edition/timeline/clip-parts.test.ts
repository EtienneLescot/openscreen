// The rules the writer and the generator both have to agree on. Everything else an
// insertion needs is in `document/insertion.ts` — it is a clip, and clips are already tested.

import { describe, expect, it } from "vitest";
import { extensionAssetId, extensionClipPath, extensionDurationSec } from "./clip-parts";

describe("extensionDurationSec", () => {
	it("is the text's own length at the assumed rate", () => {
		expect(extensionDurationSec("really")).toBeCloseTo(6 / 15, 6);
	});

	it("never returns a span too short to be a clip", () => {
		expect(extensionDurationSec("a")).toBe(0.15);
	});

	it("is nothing at all for nothing at all", () => {
		expect(extensionDurationSec("  ")).toBe(0);
	});
});

/** One backslash, built rather than escaped: the escape is what this test keeps losing. */
const BS = String.fromCharCode(92);

describe("extensionClipPath", () => {
	it("sits beside the recording it belongs to, in a hidden folder", () => {
		expect(extensionClipPath("C:/rec/take.mp4", "synth_2", 3.6)).toBe(
			"C:/rec/.openscreen-extensions/synth_2_3600.mp4",
		);
	});

	it("carries the duration, so a re-typed word asks for a different file", () => {
		expect(extensionClipPath("C:/rec/take.mp4", "synth_2", 3.8)).not.toBe(
			extensionClipPath("C:/rec/take.mp4", "synth_2", 3.6),
		);
	});

	it("is the same rule on a Windows path, so both processes name one file", () => {
		expect(extensionClipPath(`C:${BS}rec${BS}take.mp4`, "w1", 1)).toBe(
			`C:${BS}rec${BS}.openscreen-extensions${BS}w1_1000.mp4`,
		);
	});
});

describe("extensionAssetId", () => {
	it("cannot collide with a real asset id, and says what it is in a log line", () => {
		expect(extensionAssetId("synth_1")).toBe("ext:synth_1");
	});
});
