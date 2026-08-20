import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.fn();
const dipToScreenRect = vi.fn();

vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawn(...args) }));
vi.mock("electron", () => ({
	app: { getAppPath: () => "C:\\app", isPackaged: false },
	screen: {
		dipToScreenRect: (...args: unknown[]) => dipToScreenRect(...args),
		screenToDipPoint: (p: unknown) => p,
		getDisplayNearestPoint: () => ({ scaleFactor: 1, bounds: DIP_BOUNDS }),
		getPrimaryDisplay: () => ({ bounds: DIP_BOUNDS }),
	},
}));

import { WindowsNativeRecordingSession } from "./windowsNativeRecordingSession";

/** A 1920x1080 panel at 187.5%, the arrangement measured while fixing #346. */
const DIP_BOUNDS = { x: 0, y: 0, width: 1024, height: 576 };
const PHYSICAL_BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };

function fakeHelper() {
	// Push-only streams: the test feeds them, so `_read` has nothing to do.
	const noPull = () => undefined;
	const stdout = new Readable({ read: noPull });
	const stderr = new Readable({ read: noPull });
	const child = Object.assign(new EventEmitter(), { stdout, stderr, pid: 4242, kill: vi.fn() });
	return { child, stdout };
}

/**
 * The unit test on `toHelperRect` proves the conversion works; it cannot prove
 * this file still calls it. That is the half that broke in #346 — the recorder
 * and the cursor telemetry each decided for themselves which space they were in
 * — so pin the two branches that decision has.
 */
describe("WindowsNativeRecordingSession bounds handling", () => {
	const REAL_PLATFORM = process.platform;
	const setPlatform = (value: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value, configurable: true });

	beforeEach(() => {
		setPlatform("win32");
		// First candidate in the lookup, so nothing has to exist on disk but this.
		process.env.OPENSCREEN_CURSOR_SAMPLER_EXE = __filename;
		dipToScreenRect.mockReturnValue(PHYSICAL_BOUNDS);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
	});

	afterEach(() => {
		setPlatform(REAL_PLATFORM);
		process.env.OPENSCREEN_CURSOR_SAMPLER_EXE = undefined;
		spawn.mockReset();
		dipToScreenRect.mockReset();
		vi.restoreAllMocks();
	});

	const run = async (sample: Record<string, unknown>) => {
		const { child, stdout } = fakeHelper();
		spawn.mockReturnValue(child);
		const session = new WindowsNativeRecordingSession({
			getDisplayBounds: () => DIP_BOUNDS,
			maxSamples: 10,
			sampleIntervalMs: 33,
			startTimeMs: 1000,
		});
		const started = session.start();
		stdout.push(`${JSON.stringify({ type: "ready", timestampMs: 1000 })}\n`);
		await started;
		stdout.push(`${JSON.stringify(sample)}\n`);
		await new Promise((resolve) => setImmediate(resolve));
		return (await session.stop()).samples;
	};

	it("normalizes a display capture against the physical rect, not the DIP one", async () => {
		const samples = await run({
			type: "sample",
			timestampMs: 1100,
			x: 1440,
			y: 538,
			visible: true,
			handle: null,
			asset: null,
		});

		expect(dipToScreenRect).toHaveBeenCalledWith(null, DIP_BOUNDS);
		// 1440/1920, not 1440/1024 — the latter is 1.40625 and lands off-frame.
		expect(samples[0].cx).toBeCloseTo(0.75, 5);
		expect(samples[0].cy).toBeCloseTo(538 / 1080, 5);
	});

	it("uses the sampler's own bounds as-is for a window capture", async () => {
		const samples = await run({
			type: "sample",
			timestampMs: 1100,
			x: 900,
			y: 500,
			visible: true,
			handle: "0x10003",
			bounds: { x: 100, y: 100, width: 800, height: 600 },
			asset: null,
		});

		// GetWindowRect is already physical, so converting it again would be wrong.
		expect(dipToScreenRect).not.toHaveBeenCalled();
		expect(samples[0].cx).toBeCloseTo((900 - 100) / 800, 5);
		expect(samples[0].cy).toBeCloseTo((500 - 100) / 600, 5);
	});
});
