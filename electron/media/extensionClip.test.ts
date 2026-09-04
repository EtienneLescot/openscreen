// The one thing worth pinning: the command says what we mean. Running ffmpeg in a unit test
// would test ffmpeg, not us — the arguments are where a mistake actually lives.

import { describe, expect, it } from "vitest";
import { extensionClipPath } from "../../src/lib/ai-edition/timeline/clip-parts";
import { extensionClipArgs } from "./extensionClip";

const SPEC = { durationSec: 3.6, fps: 30, width: 1920, height: 1080 };

describe("extensionClipArgs", () => {
	const args = extensionClipArgs(SPEC, "C:/out/w1_3600.mp4");
	const filter = (prefix: string) => args.find((a) => a.startsWith(prefix)) ?? "";

	it("draws a test pattern, so generated media is unmistakable on screen", () => {
		// A held frame from the recording looked exactly like a decoder stuck at the end of
		// a clip — which is the bug it hid for three rounds.
		expect(filter("testsrc2=")).toContain("size=1920x1080");
		expect(filter("testsrc2=")).toContain("rate=30");
	});

	it("carries an audible noise track rather than silence", () => {
		expect(filter("anoisesrc=")).toContain("a=0.2");
		expect(args).toContain("1:a");
	});

	it("reads the recording not at all — nothing to seek, nothing to decode", () => {
		expect(args.filter((a) => a === "-i")).toHaveLength(2);
		expect(args).not.toContain("-ss");
		expect(args.some((a) => a.endsWith(".mp4") && a !== "C:/out/w1_3600.mp4")).toBe(false);
	});

	it("runs for exactly the duration asked for, on both streams and the output", () => {
		expect(filter("testsrc2=")).toContain("duration=3.600");
		expect(filter("anoisesrc=")).toContain("d=3.600");
		expect(args[args.indexOf("-t") + 1]).toBe("3.600");
		expect(args[args.length - 1]).toBe("C:/out/w1_3600.mp4");
	});

	it("uses an encoder the bundled LGPL ffmpeg actually has", () => {
		// `libx264` is GPL and absent: the first real run failed with "Unknown encoder".
		expect(args).toContain("libopenh264");
		expect(args).not.toContain("libx264");
	});

	it("still has a geometry when the asset does not know its own", () => {
		// The live project's asset carries `fps: 0` — the probe never filled it in.
		const blind = extensionClipArgs({ ...SPEC, fps: 0, width: 0, height: 0 }, "out.mp4");
		expect(blind.find((a) => a.startsWith("testsrc2="))).toContain("size=1920x1080");
		expect(blind.find((a) => a.startsWith("testsrc2="))).toContain("rate=30");
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
