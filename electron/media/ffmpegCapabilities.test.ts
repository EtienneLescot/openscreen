import { describe, expect, it } from "vitest";
import {
	candidateFfmpegPaths,
	candidateVideoEncoders,
	FFMPEG_BINARY_NAME,
	isLgplBuild,
	parseAvailableEncoders,
	pickWorkingEncoder,
	smokeTestArgs,
} from "./ffmpegCapabilities";

// Realistic slice of `ffmpeg -encoders` output (truncated for the test):
// header, capability description, separator, then a mix of video / audio /
// subtitle / data encoders. The parser must return every real encoder name
// and nothing from the header / separator / description rows.
const REALISTIC_ENCODERS_OUTPUT = [
	"Encoders:",
	" V..... = Video",
	" A..... = Audio",
	" S..... = Subtitle",
	" D..... = Data",
	"------",
	" V..... h264_qsv             H.264 / AVC (Intel Quick Sync Video acceleration) (codec h264)",
	" V....D h264_amf             AMD AMF H.264 Encoder (codec h264)",
	" V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)",
	" V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)",
	" A....D aac                  AAC (Advanced Audio Coding)",
	" D..... bintext              Binary text",
	" S..... ass                  ASS (Advanced SSA Subtitle)",
	" V..... h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)",
	" V....D h264_vaapi           H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264) (deprecated)",
].join("\n");

describe("ffmpegCapabilities", () => {
	describe("parseAvailableEncoders", () => {
		it("parses every encoder from the realistic ffmpeg -encoders fixture", () => {
			const encoders = parseAvailableEncoders(REALISTIC_ENCODERS_OUTPUT);
			expect(encoders.has("h264_qsv")).toBe(true);
			expect(encoders.has("h264_amf")).toBe(true);
			expect(encoders.has("h264_nvenc")).toBe(true);
			expect(encoders.has("libx264")).toBe(true);
			expect(encoders.has("aac")).toBe(true);
			expect(encoders.has("ass")).toBe(true);
			expect(encoders.has("bintext")).toBe(true);
			expect(encoders.has("h264_videotoolbox")).toBe(true);
			expect(encoders.has("h264_vaapi")).toBe(true);
		});

		it("ignores header, separator and capability-description rows", () => {
			const encoders = parseAvailableEncoders(REALISTIC_ENCODERS_OUTPUT);
			// Header word itself must not be treated as an encoder.
			expect(encoders.has("Encoders")).toBe(false);
			// Second token of description lines is "=", never added.
			expect(encoders.has("=")).toBe(false);
			// Capability nouns at the end of description lines must not leak.
			expect(encoders.has("Video")).toBe(false);
			expect(encoders.has("Audio")).toBe(false);
			expect(encoders.has("Subtitle")).toBe(false);
			expect(encoders.has("Data")).toBe(false);
			// Exactly the 9 real encoders from the fixture, nothing else.
			expect(encoders.size).toBe(9);
		});

		it("returns an empty set for empty / no-encoder input", () => {
			expect(parseAvailableEncoders("").size).toBe(0);
			expect(parseAvailableEncoders("\n").size).toBe(0);
			expect(parseAvailableEncoders("Encoders:\n------").size).toBe(0);
		});

		it("tolerates leading whitespace and - in flag positions", () => {
			const stdout = [
				"   V----D h264_nvenc  something",
				"\tA....D aac\t\t\tAAC (Advanced Audio Coding)",
				"  V....D libx264      libx264 (codec h264)",
			].join("\n");
			const encoders = parseAvailableEncoders(stdout);
			expect(encoders.has("h264_nvenc")).toBe(true);
			expect(encoders.has("aac")).toBe(true);
			expect(encoders.has("libx264")).toBe(true);
		});

		it("accepts CRLF line endings", () => {
			const encoders = parseAvailableEncoders("V....D h264_nvenc\r\nA....D aac\r\n");
			expect(encoders.has("h264_nvenc")).toBe(true);
			expect(encoders.has("aac")).toBe(true);
			expect(encoders.size).toBe(2);
		});
	});

	describe("candidateVideoEncoders", () => {
		// libopenh264 is bundled in our LGPL ffmpeg, so it is present everywhere and
		// sits at the floor of every list. There is no WebCodecs path any more, so a
		// machine with no hardware must still export - just slowly.
		const SW = "libopenh264";

		it("win32 orders nvidia, intel, amd, then the OS, then software", () => {
			const all = new Set(["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", SW]);
			expect(candidateVideoEncoders(all, "win32")).toEqual([
				"h264_nvenc",
				"h264_qsv",
				"h264_amf",
				"h264_mf",
				SW,
			]);
		});

		it("drops what the build does not carry", () => {
			expect(candidateVideoEncoders(new Set(["h264_amf", SW]), "win32")).toEqual(["h264_amf", SW]);
		});

		it("darwin is videotoolbox then software", () => {
			expect(candidateVideoEncoders(new Set(["h264_videotoolbox", SW]), "darwin")).toEqual([
				"h264_videotoolbox",
				SW,
			]);
		});

		it("linux is nvenc, vaapi, then software", () => {
			expect(candidateVideoEncoders(new Set(["h264_nvenc", "h264_vaapi", SW]), "linux")).toEqual([
				"h264_nvenc",
				"h264_vaapi",
				SW,
			]);
		});

		it("falls back to software on a platform we have no list for", () => {
			expect(candidateVideoEncoders(new Set([SW]), "freebsd")).toEqual([SW]);
		});

		it("never offers libx264, the fastest thing we measured, because it is GPL", () => {
			expect(candidateVideoEncoders(new Set(["libx264", "libx265"]), "win32")).toEqual([]);
		});
	});

	describe("pickWorkingEncoder", () => {
		const ALL = new Set(["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libopenh264"]);
		const encoderIn = (args: string[]) => args[args.indexOf("-c:v") + 1];

		it("skips encoders the build carries but the machine cannot run", async () => {
			// The real failure this exists to prevent: our bundled binary lists
			// nvenc/qsv/amf on every machine, so on an AMD box nvenc is present and
			// dies with "Cannot load nvcuda.dll". Presence is not capability.
			const works = new Set(["h264_amf", "h264_mf", "libopenh264"]);
			const picked = await pickWorkingEncoder(ALL, "win32", (args) => works.has(encoderIn(args)));
			expect(picked).toBe("h264_amf");
		});

		it("takes the first that works, in preference order", async () => {
			const picked = await pickWorkingEncoder(ALL, "win32", () => true);
			expect(picked).toBe("h264_nvenc");
		});

		it("lands on software when no hardware encoder runs", async () => {
			const picked = await pickWorkingEncoder(
				ALL,
				"win32",
				(args) => encoderIn(args) === "libopenh264",
			);
			expect(picked).toBe("libopenh264");
		});

		it("returns null when nothing works - the bundled ffmpeg is broken, not the machine", async () => {
			expect(await pickWorkingEncoder(ALL, "win32", () => false)).toBeNull();
		});

		it("stops probing once one passes", async () => {
			const tried: string[] = [];
			await pickWorkingEncoder(ALL, "win32", (args) => {
				tried.push(encoderIn(args));
				return encoderIn(args) === "h264_qsv";
			});
			expect(tried).toEqual(["h264_nvenc", "h264_qsv"]);
		});

		it("awaits an async probe", async () => {
			const picked = await pickWorkingEncoder(ALL, "win32", async (args) => {
				await new Promise((r) => setTimeout(r, 1));
				return encoderIn(args) === "h264_mf";
			});
			expect(picked).toBe("h264_mf");
		});
	});

	describe("smokeTestArgs", () => {
		it("encodes one synthetic frame to nowhere, so it touches no files", () => {
			const a = smokeTestArgs("h264_amf");
			expect(a[a.indexOf("-f") + 1]).toBe("lavfi");
			expect(a[a.indexOf("-c:v") + 1]).toBe("h264_amf");
			expect(a[a.indexOf("-frames:v") + 1]).toBe("1");
			expect(a.slice(-3)).toEqual(["-f", "null", "-"]);
		});
	});

	describe("isLgplBuild", () => {
		it("rejects a build configured with --enable-gpl", () => {
			const buildConf = "--prefix=/usr --enable-shared --enable-gpl --enable-version3";
			expect(isLgplBuild(buildConf)).toBe(false);
		});

		it("rejects a build configured with --enable-nonfree", () => {
			const buildConf = "--prefix=/usr --enable-shared --enable-nonfree";
			expect(isLgplBuild(buildConf)).toBe(false);
		});

		it("accepts a clean LGPL build (no gpl or nonfree)", () => {
			const buildConf = "--prefix=/usr --enable-shared --enable-version3 --enable-libvpx";
			expect(isLgplBuild(buildConf)).toBe(true);
		});

		it("does not match --enable-gpl as a substring of another flag", () => {
			// gpl-something is a different flag entirely - not the one we care about.
			expect(isLgplBuild("--enable-gpl-something")).toBe(true);
			expect(isLgplBuild("--enable-nonfree-extra")).toBe(true);
		});

		it("accepts the ffmpeg banner `configuration:` line for a clean build", () => {
			const banner = "configuration: --prefix=/usr --enable-shared --enable-version3";
			expect(isLgplBuild(banner)).toBe(true);
		});

		it("rejects the ffmpeg banner `configuration:` line when --enable-gpl is present", () => {
			const banner = "configuration: --prefix=/usr --enable-gpl --enable-version3 --enable-libx264";
			expect(isLgplBuild(banner)).toBe(false);
		});

		it("rejects the ffmpeg banner `configuration:` line when --enable-nonfree is present", () => {
			const banner = "configuration: --enable-shared --enable-nonfree --enable-libfdk-aac";
			expect(isLgplBuild(banner)).toBe(false);
		});

		it("returns true for an empty / whitespace-only build configuration", () => {
			expect(isLgplBuild("")).toBe(true);
			expect(isLgplBuild("   ")).toBe(true);
		});
	});

	describe("candidateFfmpegPaths", () => {
		it("prepends the env override when set", () => {
			const paths = candidateFfmpegPaths({
				here: "/fake/repo",
				platform: "linux",
				arch: "x64",
				envOverride: "/custom/ffmpeg",
			});
			expect(paths[0]).toBe("/custom/ffmpeg");
			expect(paths).toContain("/fake/repo/electron/native/bin/linux-x64/ffmpeg");
		});

		it("emits ffmpeg.exe under <platform>-<arch> on win32", () => {
			const paths = candidateFfmpegPaths({
				here: "C:/fake/repo",
				platform: "win32",
				arch: "x64",
			});
			const resolved = paths.map((p) => p.replace(/\\/g, "/"));
			expect(resolved).toContain("C:/fake/repo/electron/native/bin/win32-x64/ffmpeg.exe");
			expect(resolved).toContain("C:/fake/repo/electron/native/bin/ffmpeg.exe");
		});

		it("emits bare ffmpeg on linux (no .exe anywhere)", () => {
			const paths = candidateFfmpegPaths({
				here: "/fake/repo",
				platform: "linux",
				arch: "x64",
			});
			expect(paths).toContain("/fake/repo/electron/native/bin/linux-x64/ffmpeg");
			expect(paths).toContain("/fake/repo/electron/native/bin/ffmpeg");
			expect(paths.every((p) => !p.endsWith(".exe"))).toBe(true);
		});

		it("emits bare ffmpeg on darwin (no .exe anywhere)", () => {
			const paths = candidateFfmpegPaths({
				here: "/fake/repo",
				platform: "darwin",
				arch: "arm64",
			});
			expect(paths).toContain("/fake/repo/electron/native/bin/darwin-arm64/ffmpeg");
			expect(paths.every((p) => !p.endsWith(".exe"))).toBe(true);
		});

		it("orders candidates: env > appPath > resourcesPath > here-tagged > here-bare", () => {
			const paths = candidateFfmpegPaths({
				here: "/fake/repo",
				platform: "linux",
				arch: "x64",
				appPath: "/app",
				resourcesPath: "/res",
				envOverride: "/env",
			});
			// Priority 1: env override comes first.
			expect(paths[0]).toBe("/env");
			// Priority 2: appPath-tagged candidate is present.
			expect(paths).toContain("/app/electron/native/bin/linux-x64/ffmpeg");
			// Priority 3: resourcesPath-tagged candidate is present.
			expect(paths).toContain("/res/electron/native/bin/linux-x64/ffmpeg");
			// Priority 4: here-tagged candidate is present.
			expect(paths).toContain("/fake/repo/electron/native/bin/linux-x64/ffmpeg");
			// Priority 5: cross-arch fallthrough with no platform tag is present.
			expect(paths).toContain("/fake/repo/electron/native/bin/ffmpeg");

			// Order is consistent across the layered candidates.
			const envIdx = paths.indexOf("/env");
			const appIdx = paths.indexOf("/app/electron/native/bin/linux-x64/ffmpeg");
			const resIdx = paths.indexOf("/res/electron/native/bin/linux-x64/ffmpeg");
			const hereIdx = paths.indexOf("/fake/repo/electron/native/bin/linux-x64/ffmpeg");
			const bareIdx = paths.indexOf("/fake/repo/electron/native/bin/ffmpeg");
			expect(envIdx).toBeLessThan(appIdx);
			expect(appIdx).toBeLessThan(resIdx);
			expect(resIdx).toBeLessThan(hereIdx);
			expect(hereIdx).toBeLessThan(bareIdx);
		});

		it("omits appPath / resourcesPath candidates when those inputs are null", () => {
			const paths = candidateFfmpegPaths({
				here: "/fake/repo",
				platform: "linux",
				arch: "x64",
				appPath: null,
				resourcesPath: null,
			});
			expect(paths.some((p) => p.startsWith("/app/"))).toBe(false);
			expect(paths.some((p) => p.startsWith("/res/"))).toBe(false);
			expect(paths).toContain("/fake/repo/electron/native/bin/linux-x64/ffmpeg");
			expect(paths).toContain("/fake/repo/electron/native/bin/ffmpeg");
		});

		it("skips platform-tagged candidates when platform or arch is missing", () => {
			const paths = candidateFfmpegPaths({ here: "/fake/repo" });
			// Only the cross-arch fallthrough is emitted without a platform tag.
			expect(paths).toEqual(["/fake/repo/electron/native/bin/ffmpeg"]);
		});
	});

	describe("FFMPEG_BINARY_NAME", () => {
		it("returns ffmpeg.exe on win32", () => {
			expect(FFMPEG_BINARY_NAME("win32")).toBe("ffmpeg.exe");
		});

		it("returns bare ffmpeg on every other platform", () => {
			expect(FFMPEG_BINARY_NAME("linux")).toBe("ffmpeg");
			expect(FFMPEG_BINARY_NAME("darwin")).toBe("ffmpeg");
			expect(FFMPEG_BINARY_NAME("freebsd")).toBe("ffmpeg");
		});
	});
});

// Added after research surfaced the real GPL/nonfree surface (ffmpeg.org/legal.html):
// checking --enable-gpl alone is not the whole gate.
describe("isLgplBuild — GPL externals and nonfree traps", () => {
	it("rejects each GPL-only external library", () => {
		for (const lib of [
			"libx264",
			"libx265",
			"libxvid",
			"libvidstab",
			"librubberband",
			"frei0r",
			"avisynth",
		]) {
			expect(isLgplBuild(`--prefix=/x --enable-${lib} --enable-shared`)).toBe(false);
		}
	});

	it("rejects libfdk-aac — nonfree makes the binary unredistributable, and we encode AAC", () => {
		expect(isLgplBuild("--prefix=/x --enable-libfdk-aac")).toBe(false);
	});

	it("accepts a hardware-only LGPL build with the native aac encoder", () => {
		expect(
			isLgplBuild(
				"--prefix=/x --enable-shared --enable-amf --enable-nvenc --enable-libsvtav1 --enable-videotoolbox",
			),
		).toBe(true);
	});

	it("does not false-positive on a lib whose name merely contains a GPL one", () => {
		expect(isLgplBuild("--enable-libx264-shim-not-real")).toBe(true);
	});
});
