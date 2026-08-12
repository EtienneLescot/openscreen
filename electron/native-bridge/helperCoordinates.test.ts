import { afterEach, describe, expect, it, vi } from "vitest";
import { toHelperRect } from "./helperCoordinates";

const dipToScreenRect = vi.fn();

vi.mock("electron", () => ({
	screen: {
		get dipToScreenRect() {
			return dipToScreenRect;
		},
	},
}));

/**
 * The bug this pins is invisible at 100% scaling, which is what every dev machine
 * and all of CI runs at — so the assertion cannot be "the numbers come out right",
 * it has to be "the conversion is reached at all, and only where it exists".
 * `dipToScreenRect` is `@platform win32` in Electron: on darwin it is not a
 * function, so calling it unconditionally would throw rather than mis-convert.
 */
describe("toHelperRect", () => {
	const REAL_PLATFORM = process.platform;
	const setPlatform = (value: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value, configurable: true });

	afterEach(() => {
		setPlatform(REAL_PLATFORM);
		dipToScreenRect.mockReset();
	});

	const DIP = { x: 1920, y: 0, width: 2560, height: 1440 };

	it("converts DIP bounds to physical screen pixels on Windows", () => {
		const physical = { x: 3840, y: 0, width: 5120, height: 2880 };
		dipToScreenRect.mockReturnValue(physical);
		setPlatform("win32");

		expect(toHelperRect(DIP)).toEqual(physical);
		// `null` as the window: scale relative to the display nearest the rect,
		// which is the part that holds up on a mixed-DPI desktop.
		expect(dipToScreenRect).toHaveBeenCalledWith(null, DIP);
	});

	it.each(["darwin", "linux"] as const)("passes the rect through on %s", (platform) => {
		setPlatform(platform);

		expect(toHelperRect(DIP)).toBe(DIP);
		expect(dipToScreenRect).not.toHaveBeenCalled();
	});
});
