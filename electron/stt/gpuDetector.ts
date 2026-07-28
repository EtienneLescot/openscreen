import path from "node:path";

import type { SttBackend } from "./transcriptionContract";

/**
 * Resolves the `whisper-stt-server` binary for the current host.
 *
 * whisper.cpp selects the actual backend at runtime (Metal on Apple Silicon,
 * Vulkan on Windows/Linux, CPU fallback when no GPU/driver is available), so
 * this module no longer probes for GPUs. It only picks the correct
 * per-platform binary name and searches the standard locations.
 *
 * The *real* backend that ran is reported by the helper in its `/inference`
 * JSON `backend` field and is more accurate than any OS-side guess.
 */

export interface GpuProbeResult {
	backend: SttBackend;
	/** Coarse reason for logs (e.g. "macOS arm64 → metal binary"). */
	reason: string;
}

/** Resolved locations for the `whisper-stt-server` binary on disk; null until probes complete. */
export interface ResolvedBinary {
	backend: SttBackend;
	path: string | null;
}

/**
 * Return the platform's default binary backend tag. This is only used for
 * logging and as a fallback; the helper's response corrects it at runtime.
 */
export async function detectGpuBackend(): Promise<GpuProbeResult> {
	switch (process.platform) {
		case "darwin":
			return process.arch === "arm64"
				? { backend: "whispercpp-metal", reason: "macOS arm64 → metal binary" }
				: { backend: "whispercpp-cpu", reason: "macOS x64 → cpu binary" };
		case "win32":
			return {
				backend: "whispercpp-vulkan",
				reason: "Windows → vulkan binary (CPU fallback at runtime)",
			};
		case "linux":
			return {
				backend: "whispercpp-vulkan",
				reason: "Linux → vulkan binary (CPU fallback at runtime)",
			};
		default:
			return { backend: "whispercpp-cpu", reason: "unknown platform → cpu binary" };
	}
}

/**
 * Conventional bin name; a single binary per platform handles all backends via
 * whisper.cpp's runtime device selection. The `.exe` suffix on Windows is
 * required so Win32's image loader can resolve the file.
 */
export function binaryNameForBackend(_backend: SttBackend): string {
	const suffix = process.platform === "win32" ? ".exe" : "";
	return `whisper-stt-server${suffix}`;
}

/**
 * Where to look for the binary, in priority order:
 *   1. `OPENSCREEN_WHISPER_SERVER_EXE` env override (debug builds)
 *   2. `<appPath>/electron/native/bin/<os>-<arch>/<binaryName>` (dev `npm run
 *      dev` and `electron-builder --dir` unpacked staging)
 *   3. `<resourcesPath>/electron/native/bin/<os>-<arch>/<binaryName>`
 *      (packaged installer — NSIS / dmg / AppImage put natives under
 *      `resources/`)
 *   4. `here/electron/native/bin/<os>-<arch>/<binaryName>` (older checkout
 *      shape + bare-bones tests)
 *   5. `here/electron/native/bin/<binaryName>` (cross-arch fallthrough)
 *
 * ponytail: on Windows, accept both the .exe-suffixed and bare names so a
 * checkout that pre-dates the suffix fix still resolves to a valid file.
 */
export function candidateBinaryPaths(here: string = process.cwd()): string[] {
	const tag = `${process.platform}-${process.arch}`;
	const name = binaryNameForBackend("whispercpp-cpu");
	const envPath = process.env.OPENSCREEN_WHISPER_SERVER_EXE?.trim();
	const appPath = readAppPath();
	const resourcePath = readResourcesPath();
	const names = name.endsWith(".exe") ? [name, name.replace(/\.exe$/, "")] : [name];
	const appPathSegments = appPath
		? names.map((n) => path.join(appPath, "electron", "native", "bin", tag, n))
		: [];
	const resourceSegments = resourcePath
		? names.map((n) => path.join(resourcePath, "electron", "native", "bin", tag, n))
		: [];
	return [
		...(envPath ? [envPath] : []),
		...appPathSegments,
		...resourceSegments,
		...names.map((n) => path.join(here, "electron", "native", "bin", tag, n)),
		...names.map((n) => path.join(here, "electron", "native", "bin", n)),
	].filter((p): p is string => Boolean(p));
}

/** Resolve `app.getAppPath()` lazily so this module stays importable from
 * contexts where Electron's `app` is not yet ready (e.g. unit tests). */
function readAppPath(): string | null {
	try {
		const { app } = require("electron") as typeof import("electron");
		return typeof app?.getAppPath === "function" ? app.getAppPath() : null;
	} catch {
		return null;
	}
}

/** Same lazy pattern for `process.resourcesPath` (it only exists when packaged). */
function readResourcesPath(): string | null {
	const candidate = process.resourcesPath;
	if (typeof candidate === "string" && candidate.length > 0) {
		return candidate;
	}
	return null;
}

/** Probe → first existing candidate → null if none. */
export async function resolveBinaryPath(here: string = process.cwd()): Promise<ResolvedBinary> {
	const { existsSync } = await import("node:fs");
	const probe = await detectGpuBackend();
	for (const candidate of candidateBinaryPaths(here)) {
		if (candidate && existsSync(candidate)) {
			return { backend: probe.backend, path: candidate };
		}
	}
	return { backend: probe.backend, path: null };
}
