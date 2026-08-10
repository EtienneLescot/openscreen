// electron-builder beforePack hook: refuse to package a compositor addon that is older than its
// Rust sources.
//
// `compositor_view.node` is an untracked build artifact, and plain `npm run build` does NOT rebuild
// it (only `build:win` runs `build:native:compositor`). So a bare `npm run build` — or a fresh
// worktree that inherited a copy from the main checkout — happily ships a `.node` built from
// whatever the sources looked like days ago.
//
// That failure is silent, which is what makes it worth a hard error. Scene fields the app sends are
// `#[serde(default)]` on the Rust side, so an addon predating a contract change does not reject the
// payload: it ignores the unknown key, takes the default, and falls back to older art. The feature
// simply does nothing, with no error in any log — it reads exactly like a bug in the TypeScript, and
// it has already cost one full false-trail investigation (custom cursor themes, 2026-07-27, where
// the shipped addon was 3 days older than the commit adding `cursorSprites`).
//
// ponytail: mtime comparison, not content hashing. A `git checkout` restamps source mtimes, so this
// can fire when the addon is actually fine. That trade is deliberate — the false positive costs one
// rebuild, the false negative ships a broken installer. Switch to hashing the sources into a stamp
// file next to the `.node` if branch-switching makes the noise annoying.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const ADDON = path.join(ROOT, "electron/native/compositor-view/build/compositor_view.node");

// Everything the addon is compiled from. shaders.hlsl lives under src/, so it is covered.
// crates/poc-d3d/ is deliberately absent: nothing links it, so editing the POC cannot
// invalidate the shipped addon.
const SOURCE_PATHS = [
	"crates/compositor/src",
	"crates/compositor-view-napi/src",
	"crates/Cargo.toml",
	"crates/compositor/Cargo.toml",
	"crates/compositor-view-napi/Cargo.toml",
].map((p) => path.join(ROOT, p));

const FIX =
	"Rebuild it with:\n\n    npm run build:native:compositor\n\nor use `npm run build:win`, which does that for you.";

const FIX_MAC =
	"Rebuild it with:\n\n    npm run build:native:compositor:mac\n\nor use `npm run build:mac`, which does that for you.";

const FIX_LINUX =
	"Rebuild it with:\n\n    npm run build:native:compositor:linux\n\nor use `npm run build:linux`, which does that for you.";

const FIX_LINUX_HELPER =
	"Rebuild it with:\n\n    npm run build:native:linux\n\nor use `npm run build:linux`, which does that for you.";

/** Everything the PipeWire capture helper is compiled from. */
const HELPER_SOURCE_PATHS = [
	"electron/native/pipewire-capture/src",
	"electron/native/pipewire-capture/csrc",
	"electron/native/pipewire-capture/build.rs",
	"electron/native/pipewire-capture/Cargo.toml",
].map((p) => path.join(ROOT, p));

/**
 * Everything that has to be inside `electron/native/bin/darwin-<arch>/` for the .app to
 * work, keyed by what breaks when it is absent.
 *
 * This list exists because the macOS deliverable had no guard at all: `beforePack`
 * returned early on any non-win32 platform, so a mac package built without the compositor
 * addon shipped silently — the preview and the export come up dead, with nothing in any
 * log to say why. That is precisely the failure mode the staleness check below was written
 * to prevent, and the platform guard was letting it through on the other OS.
 *
 * `mac.extraResources` ships this directory wholesale (`filter: ["darwin-*​/*"]`), so
 * "present here" is the same thing as "present in the installed app".
 */
const MAC_REQUIRED = [
	{
		match: (name) => name === "compositor_view.node",
		what: "the Metal compositor addon",
		breaks: "the preview and every export render nothing",
		fix: FIX_MAC,
	},
	{
		match: (name) => /^libav(codec|format|util)\.\d+\.dylib$/.test(name),
		what: "the LGPL ffmpeg dylibs the compositor links",
		breaks: "the compositor addon cannot be loaded at all (dyld error at require())",
		fix: FIX_MAC,
		atLeast: 3,
	},
	{
		match: (name) => name === "whisper-stt-server",
		what: "the whisper.cpp STT helper",
		breaks: "transcription and captions fail with a developer error shown to end users",
		fix: "Build it with:\n\n    npm run build:whisper-binaries\n\nor stage CI's with `bash scripts/stage-whisper-stt.sh darwin-<arch>`.",
	},
	{
		match: (name) => /^libggml.*\.dylib$/.test(name),
		what: "the ggml backend dylibs the STT helper links",
		breaks: "whisper-stt-server dies in dyld before main(), so STT times out with no diagnostic",
		fix: "Build it with:\n\n    npm run build:whisper-binaries",
		atLeast: 1,
	},
	{
		match: (name) => name === "openscreen-screencapturekit-helper",
		what: "the ScreenCaptureKit capture helper",
		breaks: "native screen capture is unavailable",
		fix: "Build it with:\n\n    npm run build:native:mac",
	},
];

/**
 * The Linux counterpart of MAC_REQUIRED. It exists for the same reason: until this
 * hook grew a Linux branch, `beforePack` asserted nothing at all on Linux — the
 * comment said "Linux ships no native addon of its own", which stopped being true
 * when the wgpu compositor addon and the PipeWire capture helper landed.
 *
 * `linux.extraResources` ships this directory wholesale (`filter: ["linux-*​/**"]`),
 * so "present here" is the same thing as "present in the installed app".
 *
 * Note the two ffmpeg sets, which is why `helper-ffmpeg/` is required separately below:
 * the `.so` files sitting directly in this directory are the compositor's copies,
 * with every symbol renamed to `osff_*` so the addon cannot bind to Chromium's
 * bundled ffmpeg. The helper needs the *unrenamed* originals, which is what the
 * `helper-ffmpeg/` subdirectory holds.
 */
const LINUX_REQUIRED = [
	{
		match: (name) => name === "compositor_view.node",
		what: "the wgpu/Vulkan compositor addon",
		breaks: "the preview renders nothing and every export falls back to the no-op compositor",
		fix: FIX_LINUX,
	},
	// Une exigence par famille, plutôt qu'`atLeast: 5` sur une regex combinée. Le
	// compte total était satisfait par cinq copies versionnées d'une même
	// bibliothèque — libavcodec.so.58 à .62 laissées par un build précédent —
	// pendant qu'une autre manquait. Le paquet passait alors la garde et le
	// compositeur ne chargeait pas : exactement le mode de panne que cette garde
	// existe pour attraper.
	...["avcodec", "avformat", "avutil", "swresample", "swscale"].map((library) => ({
		match: (name) => new RegExp(`^lib${library}\\.so\\.\\d+$`).test(name),
		what: `the symbol-renamed lib${library} shared object the compositor links`,
		breaks: "the compositor addon cannot be loaded at all (ld.so error at require())",
		fix: FIX_LINUX,
	})),
	{
		match: (name) => name === "openscreen-pipewire-helper",
		what: "the PipeWire screen-capture helper",
		breaks: "Wayland capture is unavailable and cursor recording throws",
		fix: FIX_LINUX_HELPER,
	},
	{
		match: (name) => name === "whisper-stt-server",
		what: "the whisper.cpp STT helper",
		breaks: "transcription and captions fail with a developer error shown to end users",
		fix: "Build it with:\n\n    npm run build:whisper-binaries\n\nor stage CI's with `bash scripts/stage-whisper-stt.sh linux-x64`.",
	},
	{
		match: (name) => /^libggml.*\.so(\.\d+)*$/.test(name),
		what: "the ggml backend shared objects the STT helper links",
		breaks: "whisper-stt-server dies in ld.so before main(), so STT times out with no diagnostic",
		fix: "Build it with:\n\n    npm run build:whisper-binaries",
		atLeast: 1,
	},
];

/** electron-builder passes `context.arch` as a numeric enum; map it to our directory tag. */
function archTagFor(context) {
	const BY_INDEX = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };
	const name = BY_INDEX[context?.arch];
	return name && name !== "universal" ? name : process.arch;
}

/**
 * Shared by the macOS and Linux payload checks — same contract on both: the arch-tagged
 * directory under electron/native/bin/ is what extraResources ships, so a missing entry
 * here is a missing entry in the installed app.
 */
function checkNativePayload({ dir, required, osLabel, bundleNoun, emptyDirFix }) {
	if (!fs.existsSync(dir)) {
		throw new Error(
			`Refusing to package: ${path.relative(ROOT, dir)} does not exist, so ${bundleNoun} would ` +
				"ship with no native modules at all.\n\n" +
				emptyDirFix,
		);
	}

	const present = fs.readdirSync(dir);
	const missing = required.filter(
		(req) => present.filter((name) => req.match(name)).length < (req.atLeast ?? 1),
	);
	if (missing.length === 0) {
		return;
	}

	const detail = missing
		.map(
			(req) =>
				`  - ${req.what}\n      without it: ${req.breaks}\n      ${req.fix.replace(/\n+/g, " ")}`,
		)
		.join("\n");
	throw new Error(
		`Refusing to package an incomplete ${osLabel} payload.\n\n` +
			`  looked in: ${path.relative(ROOT, dir)}\n\n` +
			`Missing:\n${detail}\n\n` +
			"Every one of these fails silently or as an unactionable timeout in the installed\n" +
			"app, which is why this is a hard error at pack time rather than a warning.",
	);
}

/**
 * The Windows addon must sit in the SAME directory as the ffmpeg DLLs it links
 * against, because that is the only arrangement that loads under MSIX.
 *
 * The addon dlopens avcodec/avformat/avutil at require() time. While it shipped from
 * app.asar.unpacked — one directory away from the DLLs — loading it depended on
 * `ensureFfmpegSharedDllsOnPath` prepending their directory to PATH. That works for
 * the NSIS installer and does not work under MSIX, which resolves dependent DLLs
 * through the package graph and ignores PATH. Measured inside a registered package,
 * with the directory correctly on PATH: `require` failed both before and after the
 * PATH was set; with the addon beside its DLLs it loaded with no PATH at all.
 *
 * That shipped as 1.9.0 on the Store: no compositor loaded, so the editor showed no
 * preview at all while audio kept playing — and it looked like an app bug, not a
 * packaging one, because every file was present and the NSIS build of the same commit
 * was fine.
 *
 * `win.extraResources` ships this directory wholesale (filter `win32-*​/*`), so
 * "together here" is the same thing as "together in the installed app".
 */
const WIN_REQUIRED = [
	{
		match: (name) => name === "compositor_view.node",
		what: "the D3D11 compositor addon",
		breaks: "the preview renders nothing and every export falls back to the no-op compositor",
		fix: FIX,
	},
	// One requirement per library, not `atLeast: 3` over a combined regex — the same
	// trap LINUX_REQUIRED documents above. Several versioned copies of one library
	// (avcodec-60/61/62.dll left by an earlier fetch) would satisfy a combined count
	// while another library was missing entirely, and the addon would still fail to
	// load.
	...["avcodec", "avformat", "avutil"].map((library) => ({
		match: (name) => new RegExp(`^${library}-\\d+\\.dll$`).test(name),
		what: `the ${library} DLL the compositor links`,
		breaks: "the addon cannot be loaded at all under MSIX, which ignores PATH",
		fix: "Fetch them with:\n\n    npm run fetch:ffmpeg",
	})),
];

/**
 * DLLs that come from the Visual C++ Redistributable rather than from Windows itself.
 *
 * The `api-ms-win-crt-*` api-sets are deliberately absent: that is the UCRT, which IS
 * part of Windows 10 and later. These are not, and no machine is obliged to have them.
 *
 * `vcomp` and `vcamp` were missing from the first version of this list, and the gap was
 * not academic: ggml-base.dll and ggml-cpu.dll are built with OpenMP and import
 * vcomp140.dll, so the shipped whisper payload still needed the redistributable after
 * 1.9.1 was supposed to have ended that. The guard reported the payload clean because
 * `vcomp` starts with none of msvcp/vcruntime/concrt. Enumerate the family, not the
 * members that happened to bite.
 */
const VC_REDIST_DLL = /^(msvcp|vcruntime|concrt|vcomp|vcamp|mfc)\d+/i;

/**
 * The DLL names a PE binary imports — just enough of the format to walk the import
 * directory, so this needs no dumpbin and therefore no Visual Studio on the runner.
 */
function importedDlls(file) {
	const b = fs.readFileSync(file);
	// Every read below is bounds-checked through this, so a truncated or non-PE file
	// arrives at the message this function means to give rather than at a RangeError
	// from readUInt32LE. The diagnostic is the whole product here: the caller's job is
	// to explain an absence, and "offset is out of bounds" explains nothing.
	const notPe = () => new Error(`${file} is not a PE binary, or is truncated`);
	const u32 = (at) => {
		if (at < 0 || at + 4 > b.length) throw notPe();
		return b.readUInt32LE(at);
	};
	const u16 = (at) => {
		if (at < 0 || at + 2 > b.length) throw notPe();
		return b.readUInt16LE(at);
	};

	if (u16(0) !== 0x5a4d) throw notPe(); // "MZ"
	const pe = u32(0x3c);
	if (u32(pe) !== 0x00004550) throw notPe(); // "PE\0\0"
	const opt = pe + 24;
	// The optional header's fixed part is 96 bytes for PE32 and 112 for PE32+ (five
	// fields widen to 8 bytes); the data directories follow it.
	const dirs = opt + (u16(opt) === 0x20b ? 112 : 96);
	// NumberOfRvaAndSizes is the last field before the directories, so it sits four
	// bytes back whichever the format. Without it, a binary declaring fewer entries
	// than we index would have unrelated header bytes read as an RVA.
	const dirCount = u32(dirs - 4);

	const sections = [];
	for (let i = 0; i < u16(pe + 6); i++) {
		const s = opt + u16(pe + 20) + i * 40;
		sections.push({ va: u32(s + 12), size: u32(s + 16), ptr: u32(s + 20) });
	}
	const fileOffset = (rva) => {
		const s = sections.find((s) => rva >= s.va && rva < s.va + s.size);
		if (!s) throw new Error(`${file}: RVA 0x${rva.toString(16)} is in no section`);
		return s.ptr + (rva - s.va);
	};

	const names = [];
	// Both directories are arrays of fixed-size descriptors ending in an all-zero one,
	// and both hold the DLL name as an RVA at a fixed offset. Reading only the first
	// would miss a delay-loaded dependency entirely — the loader resolves those on
	// first call rather than at load time, so the failure would arrive later and
	// nowhere near the cause, which is worse than the one this guard was written for.
	const walk = (index, stride, nameOffset) => {
		if (dirCount <= index) return;
		const rva = u32(dirs + index * 8);
		if (!rva) return;
		for (let entry = fileOffset(rva); ; entry += stride) {
			const nameRva = u32(entry + nameOffset);
			if (!nameRva) return;
			const at = fileOffset(nameRva);
			names.push(b.subarray(at, b.indexOf(0, at)).toString("latin1"));
		}
	};
	walk(1, 20, 12); // IMAGE_IMPORT_DESCRIPTOR.Name
	walk(13, 32, 4); // ImgDelayDescr.rvaDLLName
	return names;
}

/**
 * Nothing we ship may depend on the Visual C++ Redistributable.
 *
 * This is the one failure this whole hook could not see. Every machine that builds this
 * repo, and most machines that have ever installed a desktop app, carry those DLLs in
 * System32 — so a binary that needs them works in local testing, in CI, and in every
 * package format, while being unloadable on a clean Windows image. There is no way to
 * reproduce it here; only the import table tells the truth.
 *
 * Store certification rejected 1.9.1 for exactly this: the WGC helper was built against
 * the dynamic CRT and died in the loader before main(), so the app reported
 * `Native Windows capture exited before recording started (code=3221225781)`
 * — 0xC0000135, STATUS_DLL_NOT_FOUND — and recording was impossible on the test device.
 * `compositor_view.node` had the same defect and would have failed certification a
 * second time, on the preview, right after the helper was fixed.
 *
 * The fix is per-toolchain, hence the two-part message: /MT for the CMake helpers
 * (electron/native/wgc-capture/CMakeLists.txt), `+crt-static` for the Rust addon
 * (crates/.cargo/config.toml).
 */
function checkWinNoRedistDependency(dir) {
	// Regular files only, and the same list serves both questions below. A directory
	// answers `readdirSync` by name exactly as a file does, and this directory really
	// does hold subdirectories (the vendored ffmpeg SDK), so the distinction is not
	// hypothetical. Without it one named `something.dll` is opened as a binary and the
	// hook dies on a raw `EISDIR` — the build stops, which is right, on a message that
	// names nothing, which is not.
	const files = fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name);

	const scanned = files
		.filter((name) => /\.(exe|dll|node)$/i.test(name))
		.map((name) => ({ name, imports: importedDlls(path.join(dir, name)) }));

	// A guard that silently stops looking is worse than no guard: it reports "clean" for
	// the rest of the project's life. Every native binary imports something — kernel32 at
	// the very least — so an empty result means the parser broke, not that the file is
	// self-contained. Asserted here against the real payload rather than a synthetic PE
	// fixture, which would only ever prove this parser agrees with itself.
	const unread = scanned.filter((entry) => entry.imports.length === 0);
	if (unread.length > 0) {
		throw new Error(
			`Refusing to package: read no imports at all from ${unread.map((e) => e.name).join(", ")}.\n\n` +
				"Every native binary imports at least kernel32, so this is a bug in importedDlls()\n" +
				"(scripts/before-pack.cjs), not a self-contained binary. Fix the parser — leaving it\n" +
				"is how the Visual C++ Redistributable dependency gets back into a shipped build.",
		);
	}

	// The property that matters is not "imports a redistributable DLL", it is "imports a
	// redistributable DLL that will not be there". A copy sitting in this directory WILL
	// be there: it ships, and the loader searches an executable's own directory and, for
	// a .node, the module's — the same colocation that carries the ffmpeg DLLs. Shipping
	// vcomp140.dll beside the ggml libraries is therefore a fix, not an exception, and
	// the check has to be able to say so or it would forbid the remedy it asks for.
	const shipped = new Set(files.map((name) => name.toLowerCase()));
	const offenders = scanned
		.map((entry) => ({
			name: entry.name,
			bad: entry.imports.filter((d) => VC_REDIST_DLL.test(d) && !shipped.has(d.toLowerCase())),
		}))
		.filter((entry) => entry.bad.length > 0);
	if (offenders.length === 0) {
		return;
	}

	throw new Error(
		"Refusing to package binaries that need the Visual C++ Redistributable.\n\n" +
			`  looked in: ${path.relative(ROOT, dir)}\n\n` +
			`${offenders.map((o) => `  - ${o.name} imports ${o.bad.join(", ")}`).join("\n")}\n\n` +
			"Those DLLs are not part of Windows. On a clean image the loader kills the process\n" +
			"before main() (0xC0000135) or fails require(), and the app can only report an exit\n" +
			"code. It works on every developer machine, which is why this is checked here.\n\n" +
			"Build against the static CRT instead:\n" +
			"  - CMake helpers: CMAKE_MSVC_RUNTIME_LIBRARY MultiThreaded (electron/native/wgc-capture)\n" +
			"  - Rust addon:    -C target-feature=+crt-static (crates/.cargo/config.toml)\n\n" +
			"For a prebuilt binary that is not ours to recompile, ship the DLL it needs into this\n" +
			"same directory and the check passes — that is what scripts/stage-vcomp-runtime.mjs\n" +
			"does for the OpenMP runtime the whisper/ggml libraries import.",
	);
}

function checkWinNativePayload() {
	const dir = path.join(ROOT, "electron", "native", "bin", "win32-x64");
	checkNativePayload({
		dir,
		required: WIN_REQUIRED,
		osLabel: "Windows",
		bundleNoun: "the installer",
		emptyDirFix: `${FIX}\n\nThe STT helper and the capture helper are separate builds — see\ntechnical-documentation/engineering/build-and-packaging.md.`,
	});
	checkWinNoRedistDependency(dir);
}

function checkMacNativePayload(context) {
	checkNativePayload({
		dir: path.join(ROOT, "electron", "native", "bin", `darwin-${archTagFor(context)}`),
		required: MAC_REQUIRED,
		osLabel: "macOS",
		bundleNoun: "the .app",
		emptyDirFix: `${FIX_MAC}\n\nThe STT helper and the capture helper are separate builds — see\ntechnical-documentation/engineering/build-and-packaging.md.`,
	});
}

function checkLinuxNativePayload(context) {
	const dir = path.join(ROOT, "electron", "native", "bin", `linux-${archTagFor(context)}`);
	checkNativePayload({
		dir,
		required: LINUX_REQUIRED,
		osLabel: "Linux",
		bundleNoun: "the package",
		emptyDirFix: `${FIX_LINUX}\n\nThe capture helper and the STT helper are separate builds — see\ntechnical-documentation/engineering/build-and-packaging.md.`,
	});

	// Checked apart from LINUX_REQUIRED because "something named ffmpeg exists" is not the
	// property that matters — it has to be a directory holding the *unrenamed* libraries.
	// An empty one, or the wrong kind of entry, passes a name match and still ships a
	// helper that cannot start.
	const helperFfmpeg = path.join(dir, "helper-ffmpeg");
	const isDir = fs.existsSync(helperFfmpeg) && fs.statSync(helperFfmpeg).isDirectory();
	if (fs.existsSync(helperFfmpeg) && !isDir) {
		throw new Error(
			`Refusing to package: ${path.relative(ROOT, helperFfmpeg)} is a file, not a directory.\n\n` +
				"It should hold the PipeWire helper's unrenamed ffmpeg shared objects.\n" +
				"Delete it and re-run:\n\n    npm run build:native:linux",
		);
	}
	const libs = isDir
		? fs.readdirSync(helperFfmpeg).filter((name) => /^lib(av|sw)\w+\.so\.\d+$/.test(name))
		: [];
	if (libs.length === 0) {
		throw new Error(
			"Refusing to package an incomplete Linux payload.\n\n" +
				`  looked in: ${path.relative(ROOT, helperFfmpeg)}\n\n` +
				"Missing:\n  - the PipeWire helper's own ffmpeg shared objects\n" +
				"      without it: openscreen-pipewire-helper dies in ld.so, so capture never starts\n" +
				`      ${FIX_LINUX_HELPER.replace(/\n+/g, " ")}\n\n` +
				"These are deliberately not the copies one level up: those have every symbol\n" +
				"renamed to `osff_*` for the compositor addon, and the helper needs the originals.",
		);
	}

	checkLinuxSymbolVersionFloor(dir);
}

/**
 * The highest versioned symbol a shipped ELF may require, per version prefix.
 *
 * The Linux counterpart of the Windows import-table guard (checkWinNoRedistDependency
 * and importedDlls(), from #321 — this may land first, in which case they arrive with
 * it), and the same failure that hook could not see: the linker binds each symbol to
 * the newest version the BUILD machine
 * offers, so the runner image silently decides the oldest distro the packages run on.
 * It works on every developer machine and in CI by construction, and only the target
 * distro tells the truth.
 *
 * Nothing in the source asks for any of it. Built on ubuntu-latest (24.04) the payload
 * needed GLIBC_2.38 for four `__isoc23_strto*` — glibc 2.38's C23 redirect of `strtol`
 * — GLIBCXX_3.4.32 for `_ZSt21ios_base_library_initv`, which GCC 13.2+ emits into every
 * translation unit that includes <iostream>, and GLIBC_2.35 for one `hypotf`, a symbol
 * that has existed since 2.2.5 and whose newest version Rust's f32::hypot simply took.
 *
 * That shipped: on Ubuntu 22.04, Debian 12 and RHEL 9, whisper-stt-server and the ggml
 * backends died in ld.so before main() (transcription and captions fail with a developer
 * error), and on RHEL 9 compositor_view.node failed require() as well (no preview, and
 * every export falls back to the no-op compositor). The app still LAUNCHES on all of
 * them — Electron itself only needs 2.25 — so it reads as a broken app rather than a
 * broken package, and nothing in any log says otherwise. No package format catches it
 * either: the deb/rpm/pacman `depends` lists are hand-written in electron-builder.json5,
 * and electron-builder passes fpm none of --rpm-autoreq*, so not even dnf generates the
 * `libc.so.6(GLIBC_2.38)` requirement that would have refused the install.
 *
 * The ceiling is what the OLDEST distro the README claims actually provides. Ubuntu
 * 22.04 is the binding one — glibc 2.35, libstdc++6 from GCC 12 — against Debian 12's
 * 2.36 with the same libstdc++. Raising any of these is a decision to drop a distro
 * from the README, not a build detail; the runners are pinned to match (build.yml's
 * build-linux and build-whisper-stt.yml).
 */
const MAX_SYMBOL_VERSION = { GLIBC: "2.35", GLIBCXX: "3.4.30", CXXABI: "1.3.13" };

/** Dotted numeric compare, so 3.4.9 < 3.4.30 and 2.4 < 2.38 rather than by string. */
function compareVersions(a, b) {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
	}
	return 0;
}

/**
 * The highest version an ELF needs per prefix, as `{ GLIBC: "2.38", GLIBCXX: "3.4.32" }`.
 *
 * Reads `.gnu.version_r` (the version NEEDS) and deliberately not `.gnu.version_d` (the
 * version DEFINITIONS): libc and libstdc++ define every version they ever shipped, so
 * reading definitions would report a bundled library as needing itself. Parsed here
 * rather than shelled out to readelf for the same reason importedDlls() does not use
 * dumpbin — binutils is not installed on every machine that packages this.
 *
 * 64-bit little-endian only, which is every arch this ships (x86_64, aarch64).
 */
function neededSymbolVersions(file) {
	const b = fs.readFileSync(file);
	if (b.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${file} is not an ELF binary`);
	if (b[4] !== 2 || b[5] !== 1) throw new Error(`${file} is not 64-bit little-endian ELF`);

	const shoff = Number(b.readBigUInt64LE(0x28));
	const shentsize = b.readUInt16LE(0x3a);
	const SHT_GNU_VERNEED = 0x6ffffffe;

	let section;
	for (let i = 0; i < b.readUInt16LE(0x3c); i++) {
		const sh = shoff + i * shentsize;
		if (b.readUInt32LE(sh + 4) !== SHT_GNU_VERNEED) continue;
		// sh_info is the Verneed count; sh_link is the string table these names live in.
		const strtabHeader = shoff + b.readUInt32LE(sh + 0x28) * shentsize;
		section = {
			offset: Number(b.readBigUInt64LE(sh + 0x18)),
			count: b.readUInt32LE(sh + 0x2c),
			strtab: Number(b.readBigUInt64LE(strtabHeader + 0x18)),
		};
		break;
	}
	// No such section means the binary needs no versioned symbols at all — legitimate
	// for a fully static one, and nothing to check either way.
	if (!section) return {};

	const nameAt = (at) =>
		b.subarray(section.strtab + at, b.indexOf(0, section.strtab + at)).toString("latin1");

	const highest = {};
	let verneed = section.offset;
	for (let i = 0; i < section.count; i++) {
		let vernaux = verneed + b.readUInt32LE(verneed + 8);
		for (let j = 0; j < b.readUInt16LE(verneed + 2); j++) {
			// "GLIBC_2.38" -> prefix GLIBC, version 2.38. Anything not shaped like that
			// (there is none in practice) is skipped rather than guessed at.
			const [, prefix, version] =
				/^(.+)_(\d+(?:\.\d+)*)$/.exec(nameAt(b.readUInt32LE(vernaux + 8))) ?? [];
			if (prefix && (!highest[prefix] || compareVersions(version, highest[prefix]) > 0)) {
				highest[prefix] = version;
			}
			vernaux += b.readUInt32LE(vernaux + 12);
		}
		verneed += b.readUInt32LE(verneed + 12);
	}
	return highest;
}

/** Every ELF under `dir`, recursively — the helper's ffmpeg sits in a subdirectory. */
function elfFilesUnder(dir) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...elfFilesUnder(full));
			continue;
		}
		if (!entry.isFile()) continue;
		// By magic, not by extension: the helpers, whisper-stt-server and ffmpeg have none.
		const magic = Buffer.alloc(4);
		const fd = fs.openSync(full, "r");
		try {
			fs.readSync(fd, magic, 0, 4, 0);
		} finally {
			fs.closeSync(fd);
		}
		if (magic.readUInt32BE(0) === 0x7f454c46) found.push(full);
	}
	return found;
}

/** Nothing we ship may need a newer glibc or libstdc++ than MAX_SYMBOL_VERSION allows. */
function checkLinuxSymbolVersionFloor(dir) {
	const scanned = elfFilesUnder(dir).map((file) => ({
		name: path.relative(dir, file),
		needs: neededSymbolVersions(file),
	}));

	// The same assertion checkWinNoRedistDependency makes, for the same reason: a guard
	// that silently stops looking reports "clean" for the rest of the project's life.
	// Every dynamically linked binary in this payload needs versioned glibc symbols, so
	// finding none anywhere means the parser broke. Asserted across the scan rather than
	// per file, because a genuinely static binary legitimately has no .gnu.version_r.
	if (!scanned.some((entry) => entry.needs.GLIBC)) {
		throw new Error(
			`Refusing to package: read no glibc symbol versions from any of the ${scanned.length} ` +
				`ELF files in ${path.relative(ROOT, dir)}.\n\n` +
				"Every one of them links glibc, so this is a bug in neededSymbolVersions()\n" +
				"(scripts/before-pack.cjs), not a self-contained payload. Fix the parser — leaving\n" +
				"it is how packages that cannot start on the supported distros get shipped again.",
		);
	}

	const offenders = scanned
		.map((entry) => ({
			name: entry.name,
			bad: Object.entries(MAX_SYMBOL_VERSION)
				.filter(
					([prefix, max]) => entry.needs[prefix] && compareVersions(entry.needs[prefix], max) > 0,
				)
				.map(([prefix, max]) => `${prefix}_${entry.needs[prefix]} (max ${prefix}_${max})`),
		}))
		.filter((entry) => entry.bad.length > 0);
	if (offenders.length === 0) {
		return;
	}

	throw new Error(
		"Refusing to package binaries that need a newer glibc or libstdc++ than the oldest\n" +
			"supported distro provides.\n\n" +
			`  looked in: ${path.relative(ROOT, dir)}\n\n` +
			`${offenders.map((o) => `  - ${o.name} needs ${o.bad.join(", ")}`).join("\n")}\n\n` +
			"Almost certainly nothing asked for this: the linker binds each symbol to the newest\n" +
			"version the build machine offers, so this means something was built on a newer image\n" +
			"than the floor. On the target it dies in ld.so before main() or fails require(), while\n" +
			"the app still launches — so it reads as a broken app, and no package format catches it.\n\n" +
			"Build on the pinned runners: ubuntu-22.04 in .github/workflows/build.yml (build-linux)\n" +
			"and build-whisper-stt.yml. To see which symbols pulled a version in:\n\n" +
			"    readelf -V <file>\n" +
			"    readelf -W --dyn-syms <file> | grep @GLIBC_2.38\n\n" +
			"Raising MAX_SYMBOL_VERSION drops a distro the README claims to support.",
	);
}

/** Newest mtime under `target` (file or directory), or 0 if it does not exist. */
function newestMtimeMs(target) {
	let stat;
	try {
		stat = fs.statSync(target);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) {
		return stat.mtimeMs;
	}
	let newest = 0;
	for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
		newest = Math.max(newest, newestMtimeMs(path.join(target, entry.name)));
	}
	return newest;
}

// `label` is a full noun ("D3D11 compositor addon", "PipeWire capture helper"): this now
// guards artifacts that are not all compositor addons.
function checkCompositorAddonFreshness(
	addon = ADDON,
	fix = FIX,
	label = "D3D11 compositor addon",
	sources,
) {
	if (!fs.existsSync(addon)) {
		throw new Error(
			`Refusing to package: the ${label} is missing.\n\n  expected: ${addon}\n\n${fix}`,
		);
	}

	const addonMs = fs.statSync(addon).mtimeMs;
	const stale = (sources ?? SOURCE_PATHS)
		.map((source) => ({ source, ms: newestMtimeMs(source) }))
		.filter((entry) => entry.ms > addonMs);
	if (stale.length === 0) {
		return;
	}

	const newest = stale.reduce((a, b) => (a.ms > b.ms ? a : b));
	throw new Error(
		`Refusing to package a stale ${label}.\n\n` +
			`  addon: ${path.relative(ROOT, addon)}\n` +
			`  addon built: ${new Date(addonMs).toISOString()}\n` +
			`  newer source: ${path.relative(ROOT, newest.source)} (${new Date(newest.ms).toISOString()})\n\n` +
			"Packaging this would silently ship an addon that ignores newer scene fields\n" +
			"(they are #[serde(default)], so it falls back instead of erroring).\n\n" +
			fix,
	);
}

exports.default = async function beforePack(context) {
	const platform = context?.electronPlatformName ?? process.platform;
	if (platform === "win32") {
		// The copy that ships is the arch-tagged one under electron/native/bin/
		// (win.extraResources), beside its ffmpeg DLLs — not the dev copy this hook
		// used to be the sole guardian of. Same reasoning as the darwin branch below.
		const shipped = path.join(
			ROOT,
			"electron",
			"native",
			"bin",
			"win32-x64",
			"compositor_view.node",
		);
		checkWinNativePayload();
		checkCompositorAddonFreshness(shipped, FIX, "D3D11");
		return;
	}
	if (platform === "darwin") {
		// The addon that actually ships is the arch-tagged copy under
		// electron/native/bin/ (mac.extraResources), not the dev copy this hook used to
		// be the sole guardian of — so that is the one whose freshness matters.
		const tag = `darwin-${archTagFor(context)}`;
		const shipped = path.join(ROOT, "electron", "native", "bin", tag, "compositor_view.node");
		checkMacNativePayload(context);
		checkCompositorAddonFreshness(shipped, FIX_MAC, "Metal compositor addon");
		return;
	}
	if (platform === "linux") {
		const tag = `linux-${archTagFor(context)}`;
		const dir = path.join(ROOT, "electron", "native", "bin", tag);
		checkLinuxNativePayload(context);
		checkCompositorAddonFreshness(
			path.join(dir, "compositor_view.node"),
			FIX_LINUX,
			"wgpu/Vulkan compositor addon",
		);
		checkCompositorAddonFreshness(
			path.join(dir, "openscreen-pipewire-helper"),
			FIX_LINUX_HELPER,
			"PipeWire capture helper",
			HELPER_SOURCE_PATHS,
		);
		return;
	}
};

// Runnable on its own for debugging: `node scripts/before-pack.cjs`
if (require.main === module) {
	try {
		if (process.platform === "darwin") {
			checkMacNativePayload({ arch: undefined });
			const tag = `darwin-${process.arch}`;
			checkCompositorAddonFreshness(
				path.join(ROOT, "electron", "native", "bin", tag, "compositor_view.node"),
				FIX_MAC,
				"Metal compositor addon",
			);
			console.log(`macOS native payload complete in electron/native/bin/${tag}, addon up to date.`);
		} else if (process.platform === "linux") {
			// Was falling through to the Windows branch below, so running this on Linux
			// reported a missing D3D11 addon at a win32 path — noise, on the one platform
			// where the hook now has something to say.
			const tag = `linux-${process.arch}`;
			const dir = path.join(ROOT, "electron", "native", "bin", tag);
			checkLinuxNativePayload({ arch: undefined });
			checkCompositorAddonFreshness(
				path.join(dir, "compositor_view.node"),
				FIX_LINUX,
				"wgpu/Vulkan compositor addon",
			);
			checkCompositorAddonFreshness(
				path.join(dir, "openscreen-pipewire-helper"),
				FIX_LINUX_HELPER,
				"PipeWire capture helper",
				HELPER_SOURCE_PATHS,
			);
			console.log(`Linux native payload complete in electron/native/bin/${tag}, addon up to date.`);
		} else if (process.platform === "win32") {
			const shipped = path.join(
				ROOT,
				"electron",
				"native",
				"bin",
				"win32-x64",
				"compositor_view.node",
			);
			checkWinNativePayload();
			checkCompositorAddonFreshness(shipped, FIX, "D3D11");
			console.log(
				"Windows native payload complete in electron/native/bin/win32-x64 (addon beside its ffmpeg DLLs), addon up to date.",
			);
		} else {
			checkCompositorAddonFreshness();
			console.log("compositor addon is up to date with its Rust sources.");
		}
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}
