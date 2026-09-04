// The one thing worth pinning: the command says what we mean. Running ffmpeg in a unit test
// would test ffmpeg, not us — the arguments are where a mistake actually lives.

import { describe, expect, it } from "vitest";
import { extensionClipPath } from "../../src/lib/ai-edition/timeline/clip-parts";
import { extensionClipArgs } from "./extensionClip";

const SPEC = {
	sourcePath: "C:/rec/take.mp4",
	atSec: 5.3,
	durationSec: 3.6,
	fps: 30,
	width: 1920,
	height: 1080,
};

describe("extensionClipArgs", () => {
	const args = extensionClipArgs(SPEC, "C:/out/w1_3600.mp4");
	const at = (flag: string) => args[args.indexOf(flag) + 1];

	it("seeks BEFORE the input, so ffmpeg does not decode up to the moment", () => {
		expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
		expect(at("-ss")).toBe("5.300");
	});

	it("holds exactly the frozen frame for the whole duration", () => {
		const filter = at("-filter_complex");
		expect(filter).toContain("trim=end_frame=1");
		expect(filter).toContain("loop=loop=-1:size=1:start=0");
		expect(filter).toContain("trim=duration=3.600");
	});

	it("matches the recording's geometry, so the two concatenate downstream", () => {
		expect(at("-filter_complex")).toContain("fps=30");
		expect(at("-filter_complex")).toContain("scale=1920:1080");
	});

	it("carries an audio track rather than none — silence reads as a broken file", () => {
		expect(args.some((a) => a.startsWith("anoisesrc="))).toBe(true);
		expect(args).toContain("1:a");
	});

	it("bounds the output, so a looping filter cannot run away", () => {
		// `-t` appears twice on purpose: once on the noise input, once on the output.
		expect(args.filter((a) => a === "-t")).toHaveLength(2);
		expect(args[args.length - 1]).toBe("C:/out/w1_3600.mp4");
	});
});

/** One backslash, built rather than escaped: the escape is what this test keeps losing. */
const BS = String.fromCharCode(92);

describe("extensionClipPath", () => {
	it("sits beside the recording it was cut from, in a hidden folder", () => {
		expect(extensionClipPath("C:/rec/take.mp4", "synth_2", 3.6)).toBe(
			"C:/rec/.openscreen-extensions/synth_2_3600.mp4",
		);
	});

	it("carries the word and the duration, so a re-typed word asks for a different file", () => {
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

describe("the two things reality imposed", () => {
	it("uses an encoder the bundled LGPL ffmpeg actually has", () => {
		// `libx264` is GPL and absent: the first real run failed with "Unknown encoder".
		const args = extensionClipArgs(SPEC, "out.mp4");
		expect(args).toContain("libopenh264");
		expect(args).not.toContain("libx264");
	});

	it("still has a frame rate when the asset does not know its own", () => {
		// The live project's asset carries `fps: 0` — the probe never filled it in, and a
		// loop filter with no rate produces nothing.
		const args = extensionClipArgs({ ...SPEC, fps: 0 }, "out.mp4");
		expect(args[args.indexOf("-filter_complex") + 1]).toContain("fps=30");
	});
});
