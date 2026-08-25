import { describe, expect, it } from "vitest";
import { fidelity, getScenario, SCENARIOS, TARGET_OUTPUT } from "./index.mjs";

describe("scenario targets", () => {
	it("pins 60 fps, the only rate every app in the set can hit", () => {
		// OpenScreen's MP4 export is fixed at 60 (MP4_EXPORT_FPS); pinning 30 would make
		// "force identical output" impossible rather than merely inconvenient.
		expect(TARGET_OUTPUT.fps).toBe(60);
	});

	it("rejects an unknown id instead of silently measuring nothing", () => {
		expect(() => getScenario("nope")).toThrow(/Unknown scenario/);
	});
});

describe("fidelity", () => {
	const full = SCENARIOS["full-demo"];

	it("scores an app that applied everything as full", () => {
		const f = fidelity(full, [
			"background",
			"padding",
			"cornerRadius",
			"shadow",
			"zooms",
			"targetResolution",
			"targetFps",
		]);
		expect(f.full).toBe(true);
		expect(f.missing).toEqual([]);
		expect(f.score).toBe(1);
	});

	it("names what a partial app skipped, so its row cannot be read as a win", () => {
		const f = fidelity(full, ["targetResolution", "targetFps"]);
		expect(f.full).toBe(false);
		expect(f.missing).toEqual(["background", "padding", "cornerRadius", "shadow", "zooms"]);
		expect(f.score).toBeCloseTo(2 / 7, 3);
	});

	it("treats an app that claims nothing as having applied nothing", () => {
		expect(fidelity(full, undefined).score).toBeCloseTo(0, 3);
	});

	it("does not demand effects the scenario never asked for", () => {
		const f = fidelity(SCENARIOS.passthrough, ["targetResolution", "targetFps"]);
		expect(f.full).toBe(true);
	});
});
