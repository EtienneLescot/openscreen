import { afterEach, describe, expect, it } from "vitest";
import { binaryNameForBackend, candidateBinaryPaths, detectGpuBackend } from "./gpuDetector";

describe("gpuDetector", () => {
	afterEach(() => {
		delete process.env.OPENSCREEN_WHISPER_SERVER_EXE;
	});

	it("returns a whisper.cpp backend for the current platform", async () => {
		const result = await detectGpuBackend();
		expect(["whispercpp-metal", "whispercpp-vulkan", "whispercpp-cpu"]).toContain(result.backend);
		expect(typeof result.reason).toBe("string");
		expect(result.reason.length).toBeGreaterThan(0);
	});

	it("binaryNameForBackend returns a single name per platform, with .exe on win32", () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		try {
			expect(binaryNameForBackend("whispercpp-vulkan")).toBe("whisper-stt-server");
			expect(binaryNameForBackend("whispercpp-cpu")).toBe("whisper-stt-server");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			expect(binaryNameForBackend("whispercpp-vulkan")).toBe("whisper-stt-server.exe");
			expect(binaryNameForBackend("whispercpp-cpu")).toBe("whisper-stt-server.exe");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	it("candidateBinaryPaths surfaces bin candidates under the repo root, .exe-aware on win32", () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			const here = "C:/fake/repo";
			const paths = candidateBinaryPaths(here);
			expect(paths.length).toBeGreaterThanOrEqual(2);
			const resolved = paths.map((p) => p.replace(/\\/g, "/"));
			expect(resolved).toContain(`${here}/electron/native/bin/win32-x64/whisper-stt-server.exe`);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	it("candidateBinaryPaths prepends env override when set", () => {
		process.env.OPENSCREEN_WHISPER_SERVER_EXE = "/custom/path/whisper-stt-server";
		const here = "/fake/repo";
		const paths = candidateBinaryPaths(here);
		expect(paths[0]).toBe("/custom/path/whisper-stt-server");
		delete process.env.OPENSCREEN_WHISPER_SERVER_EXE;
	});

	it("candidateBinaryPaths honours OPENSCREEN_WHISPER_SERVER_EXE when set", () => {
		process.env.OPENSCREEN_WHISPER_SERVER_EXE = "/custom/path/whisper-stt-server";
		const paths = candidateBinaryPaths("/fake/repo");
		expect(paths[0]).toBe("/custom/path/whisper-stt-server");
	});
});
