import { spawn } from "node:child_process";
import path from "node:path";

import type { SttBackend } from "./transcriptionContract";

/**
 * Picks the `ctranslate2-server` binary variant for the current host.
 *
 * CTranslate2's backend matrix is much smaller than whisper.cpp's:
 *   - CUDA on NVIDIA GPUs (Windows + Linux)
 *   - CPU everywhere (oneDNN/MKL on x86, Apple Accelerate on macOS — no
 *     Metal/MPS backend exists for CTranslate2, see the spec § "Mac GPU
 *     tradeoff, addressed explicitly")
 *
 * ponytail: Vulkan and Metal detection were dropped along with the engine
 * they served. CTranslate2 has no Metal/MPS backend at the time of writing;
 * a Vulkan-shimmed path through oneDNN on Linux exists in CTranslate2 but
 * isn't worth the extra CPU-with-the-wrong-name confusion in gpuDetector —
 * adding it back when someone actually asks for it. Apple Silicon CPU-only
 * is documented and accepted in the spec § "Mac GPU tradeoff".
 *
 * Order of preference (highest first, falls through on probe failure):
 *   1. Linux/Windows + NVIDIA + CUDA binary present → `ctranslate2-cuda`
 *   2. otherwise → `ctranslate2-cpu`
 */

export interface GpuProbeResult {
	backend: SttBackend;
	/** Coarse reason for logs (e.g. "nvidia-smi exit 0", "no nvidia-smi → cpu"). */
	reason: string;
}

/** Resolved locations for the `ctranslate2-server` binary on disk; null until probes complete. */
export interface ResolvedBinary {
	backend: SttBackend;
	path: string | null;
}

/** Spawn with a hard deadline; resolves to `{exitCode}` or `null` (still running). */
function runProbe(
	cmd: string,
	args: string[],
	timeoutMs = 1500,
): Promise<{ exitCode: number | null }> {
	return new Promise((resolve) => {
		let settled = false;
		const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			resolve({ exitCode: null });
		}, timeoutMs);
		child.once("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: null });
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: code });
		});
	});
}

/** `nvidia-smi` returning an exit code (any version) is a positive NVIDIA signal. */
async function probeNvidia(): Promise<boolean> {
	const result = await runProbe("nvidia-smi", ["-L"]);
	return result.exitCode === 0;
}

/**
 * ponytail: CUDA only matters on Linux/Windows. macOS has no CUDA path —
 * Apple Silicon is CPU-only with CTranslate2 (Accelerate backend), x86 Macs
 * likewise fall through to CPU.
 */
export async function detectGpuBackend(): Promise<GpuProbeResult> {
	if (
		(process.platform === "linux" || process.platform === "win32") &&
		(await probeNvidia()) &&
		binaryAvailable("ctranslate2-cuda", process.cwd())
	) {
		return { backend: "ctranslate2-cuda", reason: "nvidia-smi present + binary built → cuda" };
	}
	return { backend: "ctranslate2-cpu", reason: "no cuda backend → cpu" };
}

/** True if at least one of the candidate paths for this backend exists on disk. */
function binaryAvailable(backend: SttBackend, here: string): boolean {
	const paths = candidateBinaryPaths(backend, here);
	return paths.some((p) => {
		try {
			return require("node:fs").existsSync(p);
		} catch {
			return false;
		}
	});
}

/** Conventional bin name for the chosen backend; matches `build-ctranslate2-server.sh`.
 * Includes the `.exe` suffix on Windows so the OS can execute the file — without
 * it, the file may resolve on a bare checkout but `spawn` complains that
 * Win32's image loader can't resolve a bare name to an executable image. */
export function binaryNameForBackend(backend: SttBackend): string {
	const suffix = process.platform === "win32" ? ".exe" : "";
	return `ctranslate2-server-${backend}${suffix}`;
}

/**
 * Where to look for the binary, in priority order:
 *   1. `OPENSCREEN_CT2_SERVER_EXE` env override (debug builds)
 *   2. `<appPath>/electron/native/bin/<os>-<arch>/<binaryName>` (dev `npm run
 *      dev` and `electron-builder --dir` unpacked staging)
 *   3. `<resourcesPath>/electron/native/bin/<os>-<arch>/<binaryName>`
 *      (packaged installer — NSIS / dmg / AppImage put natives under
 *      `resources/`, but `process.cwd()` then points at the install dir or
 *      the user's home dir, so this branch is the one that actually resolves
 *      in production)
 *   4. `here/electron/native/bin/<os>-<arch>/<binaryName>` (older checkout
 *      shape + bare-bones tests)
 *   5. `here/electron/native/bin/<binaryName>` (cross-arch fallthrough)
 *
 * ponytail: on Windows, accept both the .exe-suffixed and bare names so a
 * checkout that pre-dates the suffix fix still resolves to a valid file.
 * The same dual-name trick is applied to each candidate location so the env
 * override can point at either shape.
 */
export function candidateBinaryPaths(backend: SttBackend, here: string = process.cwd()): string[] {
	const tag = `${process.platform}-${process.arch}`;
	const name = binaryNameForBackend(backend);
	const envPath = process.env.OPENSCREEN_CT2_SERVER_EXE?.trim();
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
		...names.map((n) => (envPath ? envPath : n)),
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
		// `require` rather than `import` so we don't pull `electron` in at
		// module-load time — that breaks vitest on the renderer side of the
		// workspace.
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

/** Probe → first existing candidate → null if none.
 *
 * ponytail: verifies each candidate via `existsSync` (sync filesystem probe,
 * no I/O stall). The earlier shape returned the bare env-override path even
 * when no env was set, which is a bare filename that doesn't resolve —
 * causing "is not executable" downstream. Real check, not string-only. */
export async function resolveBinaryPath(here: string = process.cwd()): Promise<ResolvedBinary> {
	const { existsSync } = await import("node:fs");
	const probe = await detectGpuBackend();
	for (const candidate of candidateBinaryPaths(probe.backend, here)) {
		if (candidate && existsSync(candidate)) {
			return { backend: probe.backend, path: candidate };
		}
	}
	return { backend: probe.backend, path: null };
}
