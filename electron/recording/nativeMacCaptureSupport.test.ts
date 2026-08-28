import { describe, expect, it } from "vitest";
import { isNativeMacCaptureOsSupported } from "./nativeMacCaptureSupport";

describe("isNativeMacCaptureOsSupported", () => {
	it("rejects Monterey before probing the macOS 13-only helper", () => {
		expect(isNativeMacCaptureOsSupported("darwin", "12.7.6")).toBe(false);
	});

	it("accepts Ventura and later macOS releases", () => {
		expect(isNativeMacCaptureOsSupported("darwin", "13.0")).toBe(true);
		expect(isNativeMacCaptureOsSupported("darwin", "26.5.1")).toBe(true);
	});

	it("rejects other platforms and malformed macOS versions", () => {
		expect(isNativeMacCaptureOsSupported("win32", "13.0")).toBe(false);
		expect(isNativeMacCaptureOsSupported("darwin", "unknown")).toBe(false);
		expect(isNativeMacCaptureOsSupported("darwin", "")).toBe(false);
	});
});
