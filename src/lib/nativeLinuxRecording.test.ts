import { afterEach, describe, expect, it, vi } from "vitest";
import { portalOwnsSourceSelection } from "./nativeLinuxRecording";

function probe(platform: string, available: boolean | Error) {
	return {
		getPlatform: () => platform,
		isNativeLinuxCaptureAvailable: vi.fn(async () => {
			if (available instanceof Error) {
				throw available;
			}
			return { success: true, available };
		}),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("portalOwnsSourceSelection", () => {
	/**
	 * The regression. The recorder asks this question in two places — before the
	 * countdown and before capture — and the countdown's gate was missed, so the
	 * HUD offered no way to pick a source and then refused to record without one.
	 */
	it("is true on Linux when the native helper is available", async () => {
		await expect(portalOwnsSourceSelection(probe("linux", true))).resolves.toBe(true);
	});

	it("is false on Linux without the helper, where the browser fallback needs a source id", async () => {
		await expect(portalOwnsSourceSelection(probe("linux", false))).resolves.toBe(false);
	});

	it.each([
		"darwin",
		"win32",
	])("is false on %s, which targets a window directly", async (platform) => {
		const api = probe(platform, true);

		await expect(portalOwnsSourceSelection(api)).resolves.toBe(false);
		// Not merely false — the question is never asked off Linux.
		expect(api.isNativeLinuxCaptureAvailable).not.toHaveBeenCalled();
	});

	it("keeps the gate when the availability check fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {
			// Expected: the failure is reported, not swallowed silently.
		});

		await expect(portalOwnsSourceSelection(probe("linux", new Error("IPC is gone")))).resolves.toBe(
			false,
		);
	});

	it("keeps the gate when the helper reports failure rather than availability", async () => {
		await expect(
			portalOwnsSourceSelection({
				getPlatform: () => "linux",
				isNativeLinuxCaptureAvailable: async () => ({ success: false, available: true }),
			}),
		).resolves.toBe(false);
	});
});
