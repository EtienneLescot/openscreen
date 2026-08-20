import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args";

const CWD = path.resolve("/work");
const inCwd = (name: string) => path.resolve(CWD, name);

function parse(args: string[]) {
	return parseCliArgs(["electron", "app-path", ...args], 2, CWD);
}

describe("parseCliArgs", () => {
	it("returns null when no subcommand is present (GUI launch)", () => {
		expect(parse([])).toBeNull();
		expect(parse(["--some-chromium-flag"])).toBeNull();
	});

	it("skips leading Chromium switches before the subcommand (AppImage --no-sandbox)", () => {
		expect(parse(["--no-sandbox", "export", "demo.openscreen"])).toMatchObject({
			kind: "export",
			projectPath: inCwd("demo.openscreen"),
		});
		expect(parse(["--no-sandbox", "--enable-unsafe-swiftshader", "record"])).toMatchObject({
			kind: "record",
		});
		expect(parse(["--no-sandbox", "--help"])).toMatchObject({ kind: "help" });
		expect(parse(["--no-sandbox"])).toBeNull();
	});

	it("parses a minimal export command and resolves relative paths", () => {
		const cmd = parse(["export", "demo.openscreen"]);
		expect(cmd).toMatchObject({
			kind: "export",
			projectPath: inCwd("demo.openscreen"),
			outPath: null,
			format: null,
		});
	});

	it("parses export options and infers format from --out extension", () => {
		const cmd = parse([
			"export",
			"/p/demo.openscreen",
			"-o",
			"out.gif",
			"--gif-fps",
			"20",
			"--json",
		]);
		expect(cmd).toMatchObject({
			kind: "export",
			outPath: inCwd("out.gif"),
			format: "gif",
			gifFrameRate: 20,
			json: true,
		});
	});

	it("rejects a --format that conflicts with the --out extension", () => {
		const cmd = parse(["export", "a.openscreen", "-o", "x.mp4", "--format", "gif"]);
		expect(cmd).toMatchObject({ kind: "error" });
	});

	it("rejects export without a project path", () => {
		expect(parse(["export"])).toMatchObject({ kind: "error" });
	});

	it("parses voiceover audio options", () => {
		const cmd = parse([
			"export",
			"a.openscreen",
			"--audio",
			"voice.mp3",
			"--audio-mode",
			"replace",
			"--audio-offset",
			"1.5",
		]);
		expect(cmd).toMatchObject({
			kind: "export",
			audioPath: inCwd("voice.mp3"),
			audioMode: "replace",
			audioOffsetSec: 1.5,
		});
	});

	it("defaults audio mode to mix and rejects --audio with gif", () => {
		expect(parse(["export", "a.openscreen", "--audio", "v.mp3"])).toMatchObject({
			audioMode: "mix",
			audioOffsetSec: 0,
		});
		expect(parse(["export", "a.openscreen", "--audio", "v.mp3", "--format", "gif"])).toMatchObject({
			kind: "error",
		});
		// gif inferred from --out, with no explicit --format
		expect(parse(["export", "a.openscreen", "--audio", "v.mp3", "-o", "out.gif"])).toMatchObject({
			kind: "error",
		});
		expect(parse(["export", "a.openscreen", "--audio-offset", "-1"])).toMatchObject({
			kind: "error",
		});
	});

	it("parses record defaults", () => {
		expect(parse(["record"])).toMatchObject({
			kind: "record",
			displayIndex: 0,
			windowTitle: null,
			mic: false,
			systemAudio: false,
			cursorMode: "editable-overlay",
			durationMs: null,
		});
	});

	it("parses record options", () => {
		const cmd = parse([
			"record",
			"--display",
			"1",
			"--mic-device",
			"MacBook",
			"--system-audio",
			"--duration",
			"12.5",
			"--project",
			"demo.openscreen",
		]);
		expect(cmd).toMatchObject({
			kind: "record",
			displayIndex: 1,
			mic: true,
			micDevice: "MacBook",
			systemAudio: true,
			durationMs: 12500,
			projectOut: inCwd("demo.openscreen"),
		});
	});

	it("rejects invalid record values", () => {
		expect(parse(["record", "--duration", "0"])).toMatchObject({ kind: "error" });
		expect(parse(["record", "--cursor", "off"])).toMatchObject({ kind: "error" });
		expect(parse(["record", "--project", "demo.json"])).toMatchObject({ kind: "error" });
	});

	it("parses --auto-zoom", () => {
		expect(parse(["export", "a.openscreen", "--auto-zoom"])).toMatchObject({
			kind: "export",
			autoZoom: true,
		});
		expect(parse(["export", "a.openscreen"])).toMatchObject({ autoZoom: false });
	});

	it("parses sources", () => {
		expect(parse(["sources", "--json"])).toMatchObject({ kind: "sources", json: true });
		expect(parse(["sources", "--bogus"])).toMatchObject({ kind: "error" });
		expect(parse(["sources", "extra-arg"])).toMatchObject({ kind: "error" });
	});

	it("parses the sources output file, resolved against cwd", () => {
		expect(parse(["sources", "-o", "s.json"])).toMatchObject({
			kind: "sources",
			jsonOutPath: inCwd("s.json"),
		});
		expect(parse(["sources", "--json", "--out", "s.json"])).toMatchObject({
			kind: "sources",
			json: true,
			jsonOutPath: inCwd("s.json"),
		});
		// The flag is optional; absent means stdout stays the only channel.
		expect(parse(["sources"])).toMatchObject({ kind: "sources", jsonOutPath: undefined });
		expect(parse(["sources", "--out"])).toMatchObject({ kind: "error" });
	});

	it("rejects an empty flag value rather than resolving it to cwd", () => {
		// `openscreen sources -o "$OUT"` with OUT unset arrives as an empty
		// argument. resolvePath would turn it into cwd, which only fails later as
		// EISDIR from the write; the omitted-value spelling is the same mistake and
		// must get the same answer.
		expect(parse(["sources", "-o", ""])).toMatchObject({ kind: "error" });
		// takeValue is shared, so every flag that takes a value gets this.
		expect(parse(["pack", "demo.openscreen", "--out", ""])).toMatchObject({ kind: "error" });
		expect(parse(["export", "demo.openscreen", "-o", ""])).toMatchObject({ kind: "error" });
	});

	it("parses pack", () => {
		expect(parse(["pack", "demo.openscreen", "--out", "bundle"])).toMatchObject({
			kind: "pack",
			projectPath: inCwd("demo.openscreen"),
			outDir: inCwd("bundle"),
		});
		expect(parse(["pack", "demo.openscreen"])).toMatchObject({ kind: "error" });
		expect(parse(["pack", "--out", "bundle"])).toMatchObject({ kind: "error" });
		expect(parse(["pack", "demo.openscreen", "--out", "bundle", "--bogus"])).toMatchObject({
			kind: "error",
		});
		expect(parse(["pack", "a.openscreen", "b.openscreen", "--out", "bundle"])).toMatchObject({
			kind: "error",
		});
	});

	it("parses captions", () => {
		expect(
			parse(["captions", "demo.openscreen", "--min-words", "1", "--max-words", "5"]),
		).toMatchObject({
			kind: "captions",
			projectPath: inCwd("demo.openscreen"),
			minWordsPerCaption: 1,
			maxWordsPerCaption: 5,
		});
		expect(parse(["captions", "demo.openscreen"])).toMatchObject({
			minWordsPerCaption: 2,
			maxWordsPerCaption: 7,
		});
		expect(
			parse(["captions", "a.openscreen", "--min-words", "9", "--max-words", "3"]),
		).toMatchObject({ kind: "error" });
	});

	it("parses info and help", () => {
		expect(parse(["info", "demo.openscreen", "--json"])).toMatchObject({
			kind: "info",
			projectPath: inCwd("demo.openscreen"),
			json: true,
		});
		expect(parse(["help"])).toMatchObject({ kind: "help" });
		expect(parse(["--help"])).toMatchObject({ kind: "help" });
	});
});
