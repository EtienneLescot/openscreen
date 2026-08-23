// @vitest-environment jsdom
// Cases recovered from the deleted `video-editor/backgroundImageUpload.test.ts`, whose
// module was dropped as dead code in the 2026-07-26 reorg — correctly, since only its own
// test imported it, but the empty-MIME fallback it encoded had never been wired into the
// pane that actually handles the upload. These pin the behaviour to the live code path.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { isSupportedBackgroundImage, VideoEffectsPane } from "./RightPanes";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }));

afterEach(() => {
	cleanup();
	toastError.mockClear();
});

describe("background image upload validation", () => {
	it("accepts PNG images for custom backgrounds", () => {
		expect(isSupportedBackgroundImage("image/png", "生成画像1.png")).toBe(true);
	});

	it("accepts PNG images by extension when the browser does not provide a MIME type", () => {
		// The regression this guards: Windows reports no MIME type for some files and
		// locales, and the pane used to drop them silently.
		expect(isSupportedBackgroundImage("", "生成画像1.png")).toBe(true);
	});

	it("keeps rejecting non-image uploads", () => {
		expect(isSupportedBackgroundImage("text/plain", "notes.txt")).toBe(false);
	});

	it("does not allow extension fallback for explicit unsupported MIME types", () => {
		expect(isSupportedBackgroundImage("text/plain", "notes.png")).toBe(false);
	});

	it("accepts jpeg and the non-standard image/jpg some systems emit", () => {
		expect(isSupportedBackgroundImage("image/jpeg", "shot.jpeg")).toBe(true);
		expect(isSupportedBackgroundImage("image/jpg", "shot.jpg")).toBe(true);
	});

	it("ignores case and stray whitespace in either field", () => {
		expect(isSupportedBackgroundImage("  IMAGE/PNG  ", "shot.png")).toBe(true);
		expect(isSupportedBackgroundImage("", "  SHOT.PNG  ")).toBe(true);
	});

	it("rejects a blank type with an extension we do not support", () => {
		expect(isSupportedBackgroundImage("", "clip.webp")).toBe(false);
		expect(isSupportedBackgroundImage("", "noextension")).toBe(false);
	});
});

describe("a rejected upload tells the user", () => {
	function pick(file: File) {
		const { container } = render(
			<I18nProvider>
				<VideoEffectsPane />
			</I18nProvider>,
		);
		const input = container.querySelector('input[type="file"]');
		if (!(input instanceof HTMLInputElement)) throw new Error("no file input rendered");
		// jsdom leaves `files` unwritable, so define it the way a real pick would.
		Object.defineProperty(input, "files", { value: [file], configurable: true });
		fireEvent.change(input);
	}

	it("surfaces an error instead of silently dropping the file", () => {
		// The whole point: this used to `return` with no feedback at all.
		pick(new File(["nope"], "notes.txt", { type: "text/plain" }));

		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError.mock.calls[0]?.[0]).toBe("Unsupported image. Use a JPG or PNG file.");
	});

	it("stays quiet for a file it accepts", () => {
		pick(new File(["x"], "生成画像1.png", { type: "" }));

		expect(toastError).not.toHaveBeenCalled();
	});
});
