import { describe, expect, it, vi } from "vitest";
import {
	planBackgroundUpdate,
	runUnblockedDownloadAndInstall,
	shouldQuitAndInstallAfterRestartPrompt,
	shouldStartBackgroundUpdateTimer,
} from "./background-update";

describe("background update policy", () => {
	it("starts no timer on a Store / non-owning channel", () => {
		expect(shouldStartBackgroundUpdateTimer({ isPackaged: true, ownsItsUpdates: false })).toBe(
			false,
		);
		expect(shouldStartBackgroundUpdateTimer({ isPackaged: false, ownsItsUpdates: true })).toBe(
			false,
		);
		expect(shouldStartBackgroundUpdateTimer({ isPackaged: true, ownsItsUpdates: true })).toBe(true);
	});

	it("does not plan a current-version dialog on the background path", () => {
		expect(planBackgroundUpdate({ outcome: { kind: "current" }, mode: "notify" })).toEqual({
			action: "none",
		});
		expect(
			planBackgroundUpdate({ outcome: { kind: "unsupported" }, mode: "download-and-install" }),
		).toEqual({ action: "none" });
	});

	it("plans notify / download / download-and-install from an available update", () => {
		const outcome = { kind: "downloaded" as const, version: "1.10.0" };
		expect(planBackgroundUpdate({ outcome, mode: "notify" })).toEqual({
			action: "notify-available",
			version: "1.10.0",
		});
		expect(planBackgroundUpdate({ outcome, mode: "download" })).toEqual({
			action: "download",
			version: "1.10.0",
		});
		expect(planBackgroundUpdate({ outcome, mode: "download-and-install" })).toEqual({
			action: "download-and-install",
			version: "1.10.0",
		});
	});

	it("does not call quitAndInstall until Restart Now returns 0", async () => {
		const install = vi.fn();
		const cancelled = await runUnblockedDownloadAndInstall({
			download: async () => ({ kind: "downloaded", version: "1.10.0" }),
			blocked: () => null,
			confirmRestart: async () => 1,
			install,
		});
		expect(cancelled).toEqual({ status: "cancelled" });
		expect(install).not.toHaveBeenCalled();
		expect(shouldQuitAndInstallAfterRestartPrompt(1)).toBe(false);

		const installed = await runUnblockedDownloadAndInstall({
			download: async () => ({ kind: "downloaded", version: "1.10.0" }),
			blocked: () => null,
			confirmRestart: async () => 0,
			install,
		});
		expect(installed).toEqual({ status: "installed" });
		expect(install).toHaveBeenCalledTimes(1);
		expect(shouldQuitAndInstallAfterRestartPrompt(0)).toBe(true);
	});

	it("hands the download error back so the dialog can show its message", async () => {
		const error = new Error("ECONNRESET mid-download");
		const failed = await runUnblockedDownloadAndInstall({
			download: async () => ({ kind: "failed", error }),
			blocked: () => null,
			confirmRestart: async () => 0,
			install: vi.fn(),
		});
		expect(failed).toEqual({ status: "failed", error });
	});

	it("never reaches the restart prompt without a downloaded update", async () => {
		// downloadSelfUpdate cannot return these today, but the type admits
		// them; a current/unsupported outcome must not prompt or install.
		for (const kind of ["current", "unsupported"] as const) {
			const confirmRestart = vi.fn(async () => 0);
			const install = vi.fn();
			const result = await runUnblockedDownloadAndInstall({
				download: async () => ({ kind }),
				blocked: () => null,
				confirmRestart,
				install,
			});
			expect(result).toEqual({ status: "unavailable" });
			expect(confirmRestart).not.toHaveBeenCalled();
			expect(install).not.toHaveBeenCalled();
		}
	});
});
