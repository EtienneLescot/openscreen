/**
 * Join path segments with forward slashes. Electron's docs and Node's
 * own internals both accept forward slashes on every platform, and using
 * `node:path`'s `path.join` on Windows would silently rewrite the
 * forward-slashed inputs the tests pass into backslashes - breaking the
 * pure-function contract where identical inputs produce identical outputs
 * regardless of host OS.
 */
function joinPosix(...segments: string[]): string {
	return segments.filter((s) => s.length > 0).join("/");
}

/**
 * Resolves the bundled ffmpeg binary for the export path's hardware-accelerated
 * encoder. The actual subprocess, muxing and bitstream handling live in a
 * separate module; this file only does pure capability detection so the
 * streaming layer can stay focused on I/O and the tests can run without ever
 * spawning a process.
 *
 * The resolution pattern mirrors electron/stt/gpuDetector.ts: a single
 * per-platform binary name (Win32 needs the .exe suffix so the OS image
 * loader can resolve it) and a layered set of candidate paths so the same
 * code works in npm run dev, the electron-builder staging tree and the
 * packaged installer.
 */

/** ffmpeg encoders we know how to drive, best-first per platform. */
export type VideoEncoderId =
	| "h264_nvenc"
	| "h264_qsv"
	| "h264_amf"
	| "h264_videotoolbox"
	| "h264_vaapi"
	/** Media Foundation: reaches AMD/Intel/NVIDIA through the OS rather than a
	 *  vendor SDK. A useful net when the vendor encoder is missing or broken. */
	| "h264_mf"
	/** Cisco's OpenH264 — BSD, so LGPL-safe, and present in our bundled build.
	 *  Software, therefore slow; it exists so that a machine with no usable
	 *  hardware encoder can still export rather than being told it cannot. */
	| "libopenh264";

/**
 * Conventional binary name. Win32's loader requires the .exe suffix; on
 * every other platform ffmpeg is just ffmpeg. The argument exists so tests
 * can drive the function without mutating process.platform.
 */
export const FFMPEG_BINARY_NAME: (platform: NodeJS.Platform) => string = (platform) =>
	platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

/**
 * Encoder preference per platform, best first. The first entry present in
 * `available` wins.
 *
 * Windows prefers NVIDIA, then Intel, then AMD: NVENC is the strongest and most
 * predictable of the three, QSV next, AMF last. AMF being last is about
 * throughput headroom, not quality — measured output was frame-identical to
 * software on the reference machine. Even AMF on an integrated Radeon measured
 * ~165 fps at 1080p versus ~8 fps for WebCodecs, so last place is still ~20x
 * what we shipped before.
 *
 * `h264_mf` (Media Foundation) sits after the vendor encoders as an OS-level
 * net: it reaches AMD/Intel/NVIDIA silicon without their SDKs, so it can save a
 * machine whose vendor path is missing or broken.
 *
 * Every list ends in `libopenh264` — software, BSD-licensed, bundled. It is the
 * floor, not a fallback to somewhere else: there is deliberately no WebCodecs
 * path any more, so a machine with no usable hardware encoder still exports
 * through this same code, mux and all, just slowly. That is why this function
 * cannot return null.
 */
const ENCODER_PREFERENCE: Partial<Record<NodeJS.Platform, readonly VideoEncoderId[]>> = {
	win32: ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libopenh264"],
	darwin: ["h264_videotoolbox", "libopenh264"],
	linux: ["h264_nvenc", "h264_vaapi", "libopenh264"],
};

/** Last resort on an unrecognised platform: if ffmpeg runs at all, this is there. */
const UNIVERSAL_FALLBACK: VideoEncoderId = "libopenh264";

/** Match ffmpeg -encoders flag columns: 6 capability characters from
 *  V/A/S/D plus . (unset) and - (also unset on some builds). The flag
 *  prefix is followed by whitespace, then the encoder name. */
const ENCODER_FLAG_PATTERN = /^[-VASD.]{6}$/;

/** Encoder names are always identifier-shaped; rejects description lines like
 *  "V..... = Video" whose second token is "=". */
const ENCODER_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Where to look for the bundled ffmpeg, in priority order:
 *   1. OPENSCREEN_FFMPEG_EXE env override (debug builds)
 *   2. <appPath>/electron/native/bin/<platform>-<arch>/<name> (dev npm run
 *      dev and electron-builder --dir unpacked staging)
 *   3. <resourcesPath>/electron/native/bin/<platform>-<arch>/<name>
 *      (packaged installer - NSIS / dmg / AppImage put natives under
 *      resources/)
 *   4. here/electron/native/bin/<platform>-<arch>/<name> (older checkout
 *      shape + bare-bones tests)
 *   5. here/electron/native/bin/<name> (cross-arch fallthrough - same name,
 *      no platform tag, lets a single checked-in binary serve every host)
 *
 * ponytail: on Windows we accept both ffmpeg.exe and bare ffmpeg as
 * candidate names so a checkout that pre-dates the suffix fix still resolves
 * to a valid file.
 *
 * Everything is read through the options bag so this function stays pure -
 * the streaming layer injects appPath / resourcesPath from the Electron
 * context, and tests pass literals.
 */
export function candidateFfmpegPaths(
	opts: {
		here?: string;
		platform?: NodeJS.Platform;
		arch?: string;
		appPath?: string | null;
		resourcesPath?: string | null;
		envOverride?: string | null;
	} = {},
): string[] {
	const here = opts.here ?? process.cwd();
	const platform = opts.platform;
	const arch = opts.arch;
	const appPath = opts.appPath ?? null;
	const resourcesPath = opts.resourcesPath ?? null;
	const envOverride = opts.envOverride ?? null;

	const tag = platform && arch ? `${platform}-${arch}` : null;
	const primary = platform ? FFMPEG_BINARY_NAME(platform) : "ffmpeg";
	const names = platform === "win32" ? [primary, "ffmpeg"] : [primary];

	const appPathSegments =
		appPath && tag ? names.map((n) => joinPosix(appPath, "electron", "native", "bin", tag, n)) : [];
	const resourceSegments =
		resourcesPath && tag
			? names.map((n) => joinPosix(resourcesPath, "electron", "native", "bin", tag, n))
			: [];
	const hereSegments = tag
		? names.map((n) => joinPosix(here, "electron", "native", "bin", tag, n))
		: [];

	return [
		...(envOverride ? [envOverride] : []),
		...appPathSegments,
		...resourceSegments,
		...hereSegments,
		// Cross-arch fallthrough: bare name with no platform tag - covers the
		// case where a dev checked in a single ffmpeg for their host only.
		...names.map((n) => joinPosix(here, "electron", "native", "bin", n)),
	];
}

/**
 * Parse ffmpeg -encoders stdout into the set of available encoder names.
 * Returns every encoder (video, audio, subtitle, data) - the caller filters
 * down to the VideoEncoderIds it cares about, so a future codec like
 * hevc_nvenc doesn't require touching this parser.
 *
 * Tolerant of leading whitespace (real ffmpeg output is sometimes
 * space-padded under the banner) and of - in flag positions (some builds
 * render -- instead of .. for unset capabilities).
 */
export function parseAvailableEncoders(stdout: string): Set<string> {
	const available = new Set<string>();
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		const tokens = line.split(/\s+/);
		if (tokens.length < 2) continue;
		if (!ENCODER_FLAG_PATTERN.test(tokens[0])) continue;
		if (!ENCODER_NAME_PATTERN.test(tokens[1])) continue;
		available.add(tokens[1]);
	}
	return available;
}

/**
 * The encoders worth *trying* on `platform`, best first, filtered to those the
 * binary actually carries.
 *
 * **This is a shortlist, not a choice.** `ffmpeg -encoders` reports what was
 * compiled in, which for a portable build is every vendor at once: our own
 * bundled binary offers h264_nvenc, h264_qsv and h264_amf on a machine that has
 * only an AMD GPU, where nvenc dies with "Cannot load nvcuda.dll" and qsv with
 * "Error creating a MFX session". Presence proves nothing about the hardware.
 * Only {@link smokeTestArgs} settles it — see {@link pickWorkingEncoder}.
 *
 * Note we never reach for libx264 even though it is the fastest thing we
 * measured (201 fps). That is a licensing call, not a speed one — it is GPL and
 * would relicense this MIT app (see isLgplBuild). libopenh264 is BSD and costs
 * us nothing but throughput on the rare machine that needs it.
 */
export function candidateVideoEncoders(
	available: ReadonlySet<string>,
	platform: NodeJS.Platform,
): VideoEncoderId[] {
	const order = ENCODER_PREFERENCE[platform] ?? [UNIVERSAL_FALLBACK];
	return order.filter((id) => available.has(id));
}

/**
 * argv for a one-frame encode that answers the only question that matters: does
 * this encoder work *on this machine*? Synthesises its own input (`lavfi`) and
 * throws the output away (`-f null`), so it touches no files and takes ~100 ms.
 */
export function smokeTestArgs(encoder: VideoEncoderId): string[] {
	return [
		"-hide_banner",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"color=c=black:s=320x240:d=0.1",
		"-frames:v",
		"1",
		"-c:v",
		encoder,
		"-f",
		"null",
		"-",
	];
}

/**
 * First encoder in the platform's preference order that survives a real one-frame
 * encode. `runSmokeTest` returns true when ffmpeg exits 0 for the given argv —
 * injected so this stays pure and testable without spawning anything.
 *
 * Returns null only when nothing works, which means the bundled ffmpeg is broken
 * or missing rather than the machine being unsupported: libopenh264 is software
 * and part of the build, so it should always pass. Callers must treat null as a
 * hard error — with no WebCodecs path any more, there is nothing else to try.
 */
export async function pickWorkingEncoder(
	available: ReadonlySet<string>,
	platform: NodeJS.Platform,
	runSmokeTest: (args: string[]) => Promise<boolean> | boolean,
): Promise<VideoEncoderId | null> {
	for (const id of candidateVideoEncoders(available, platform)) {
		if (await runSmokeTest(smokeTestArgs(id))) return id;
	}
	return null;
}

/**
 * External libraries ffmpeg documents as GPL-only. Enabling any one of them
 * relicenses the WHOLE binary to GPL, which would contaminate this MIT app.
 * Belt-and-braces: `--enable-gpl` is *required* to build these, so checking
 * the flag alone should suffice — but a third-party build could be patched,
 * and this is the list that actually decides the licence, so assert on it too.
 * Source: ffmpeg.org/legal.html.
 */
const GPL_EXTERNAL_LIBS = [
	"libx264",
	"libx265",
	"libxvid",
	"libxavs",
	"libxavs2",
	"libdavs2",
	"libvidstab",
	"librubberband",
	"libcdio",
	"frei0r",
	"avisynth",
] as const;

/**
 * Libraries that make the binary *unredistributable* — worse than GPL, since
 * no licence lets us ship the result at all. `libfdk-aac` is the trap here:
 * it is the AAC encoder everyone reaches for, and we encode AAC. Use ffmpeg's
 * native `aac` encoder instead. Source: ffmpeg.org/legal.html.
 */
const NONFREE_LIBS = ["libfdk-aac", "libfdk_aac", "openssl"] as const;

/**
 * True iff the ffmpeg build has NO GPL and NO nonfree component.
 *
 * ffmpeg is LGPL **by default** — there is no `--disable-gpl`; GPL only
 * appears if someone passes `--enable-gpl` (pulling x264/x265/…) or
 * `--enable-nonfree` (fdk-aac, OpenSSL-combined builds). It is all-or-nothing:
 * one GPL component relicenses the entire binary.
 *
 * This exists so CI can fail a build that would relicense the app — the whole
 * reason we build/ship ffmpeg ourselves is that we control these flags.
 *
 * Feed it `ffmpeg -buildconf` output, or the banner's `configuration:` line.
 */
export function isLgplBuild(buildConf: string): boolean {
	// Token-bounded so `--enable-gpl` matches but `--enable-gpl-something` does
	// not. The banner's `configuration:` line and a raw `-buildconf` dump are
	// both space-separated flags.
	if (/(?:^|\s)--enable-(?:gpl|nonfree)(?=\s|$)/.test(buildConf)) return false;

	for (const lib of [...GPL_EXTERNAL_LIBS, ...NONFREE_LIBS]) {
		// Matches --enable-libx264 and the bare token some -buildconf dumps use.
		if (new RegExp(String.raw`(?:^|\s)(?:--enable-)?${lib}(?=\s|$)`).test(buildConf)) {
			return false;
		}
	}
	return true;
}
