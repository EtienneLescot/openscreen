import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HyprlandCursorRecordingSession } from "./hyprlandCursorRecordingSession";

const { queryHyprlandCursorPosMock } = vi.hoisted(() => ({
	queryHyprlandCursorPosMock: vi.fn(),
}));

vi.mock("electron", () => ({
	screen: {
		getDisplayNearestPoint: vi.fn(() => ({ bounds: { x: 0, y: 0, width: 1, height: 1 } })),
	},
}));

vi.mock("./hyprlandCursorIpc", () => ({
	queryHyprlandCursorPos: queryHyprlandCursorPosMock,
	resolveHyprlandSocketPath: vi.fn(() => null),
}));

const DISPLAY_BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };

function createSession() {
	return new HyprlandCursorRecordingSession({
		getDisplayBounds: () => DISPLAY_BOUNDS,
		maxSamples: 3,
		sampleIntervalMs: 100,
		socketPath: "/fake/.socket.sock",
	});
}

describe("HyprlandCursorRecordingSession", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		queryHyprlandCursorPosMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("captures an immediate sample on start and normalizes/clamps it to display bounds", async () => {
		queryHyprlandCursorPosMock.mockResolvedValue({ x: 960, y: 540 });
		const session = createSession();

		await session.start();
		const data = await session.stop();

		expect(data.samples).toHaveLength(1);
		expect(data.samples[0]).toMatchObject({ cx: 0.5, cy: 0.5, visible: true });
	});

	it("clamps positions outside the display bounds to [0, 1]", async () => {
		queryHyprlandCursorPosMock.mockResolvedValue({ x: -100, y: 5000 });
		const session = createSession();

		await session.start();
		const data = await session.stop();

		expect(data.samples[0]).toMatchObject({ cx: 0, cy: 1 });
	});

	it("samples again on each interval tick", async () => {
		queryHyprlandCursorPosMock.mockResolvedValue({ x: 0, y: 0 });
		const session = createSession();

		await session.start();
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		const data = await session.stop();

		expect(queryHyprlandCursorPosMock).toHaveBeenCalledTimes(3);
		expect(data.samples).toHaveLength(3);
	});

	it("evicts the oldest sample once maxSamples is exceeded", async () => {
		queryHyprlandCursorPosMock.mockResolvedValue({ x: 0, y: 0 });
		const session = createSession();

		await session.start();
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		const data = await session.stop();

		expect(data.samples).toHaveLength(3);
	});

	it("stops the sampling interval so no further samples are captured after stop", async () => {
		queryHyprlandCursorPosMock.mockResolvedValue({ x: 0, y: 0 });
		const session = createSession();

		await session.start();
		await session.stop();
		queryHyprlandCursorPosMock.mockClear();
		await vi.advanceTimersByTimeAsync(500);

		expect(queryHyprlandCursorPosMock).not.toHaveBeenCalled();
	});

	it("waits for an in-flight capture before returning from stop", async () => {
		let releaseQuery: (value: { x: number; y: number }) => void = () => undefined;
		queryHyprlandCursorPosMock
			.mockImplementationOnce(() => Promise.resolve({ x: 0, y: 0 })) // start()'s immediate capture
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						releaseQuery = resolve;
					}),
			);
		const session = createSession();

		await session.start();
		await vi.advanceTimersByTimeAsync(100); // kicks off the second, still-pending capture
		await vi.advanceTimersByTimeAsync(100); // this tick must be skipped (isSampling), not
		// replace captureInFlight with a trivial resolved promise

		const stopPromise = session.stop();
		let stopped = false;
		void stopPromise.then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false); // must not resolve while the in-flight capture is pending

		releaseQuery({ x: 1920, y: 1080 });
		const data = await stopPromise;

		expect(stopped).toBe(true);
		expect(data.samples).toHaveLength(2);
	});

	it("returns a snapshot that later captures can't mutate", async () => {
		queryHyprlandCursorPosMock.mockResolvedValue({ x: 0, y: 0 });
		const session = createSession();

		await session.start();
		const data = await session.stop();
		const originalLength = data.samples.length;

		// Directly invoke another capture cycle as if a stray timer fired; the
		// previously returned snapshot must stay untouched either way.
		await vi.advanceTimersByTimeAsync(1000);

		expect(data.samples).toHaveLength(originalLength);
	});
});
