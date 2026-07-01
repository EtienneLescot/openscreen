import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeVideoDuration } from "./duration";

interface FakeVideo {
	duration: number;
	onloadedmetadata: ((ev: Event) => unknown) | null;
	onerror: ((ev: Event) => unknown) | null;
}

describe("probeVideoDuration", () => {
	let created: FakeVideo[];
	let originalCreate: typeof document.createElement;
	let appendSpy: ReturnType<typeof vi.spyOn> | null;

	beforeEach(() => {
		vi.useFakeTimers();
		created = [];
		originalCreate = document.createElement;
		document.createElement = ((tag: string) => {
			const node = originalCreate.call(document, tag);
			if (tag === "video") {
				const fake: FakeVideo = {
					duration: Number.NaN,
					onloadedmetadata: null,
					onerror: null,
				};
				created.push(fake);
				// jsdom appendChild validates Node; return the real element but
				// mirror handlers/duration onto the fake so the test can drive it.
				Object.defineProperty(node, "duration", {
					configurable: true,
					get: () => fake.duration,
				});
				const origOnLoadedSetter = (v: typeof fake.onloadedmetadata) => {
					fake.onloadedmetadata = v;
				};
				const origOnErrorSetter = (v: typeof fake.onerror) => {
					fake.onerror = v;
				};
				Object.defineProperty(node, "onloadedmetadata", {
					configurable: true,
					get: () => fake.onloadedmetadata,
					set: origOnLoadedSetter,
				});
				Object.defineProperty(node, "onerror", {
					configurable: true,
					get: () => fake.onerror,
					set: origOnErrorSetter,
				});
				return node;
			}
			return node;
		}) as typeof document.createElement;
	});
	afterEach(() => {
		document.createElement = originalCreate;
		appendSpy?.mockRestore();
		appendSpy = null;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns null when src is empty", async () => {
		await expect(probeVideoDuration("")).resolves.toBeNull();
	});

	it("returns duration on loadedmetadata", async () => {
		const p = probeVideoDuration("file:///tmp/clip.mp4");
		await vi.advanceTimersByTimeAsync(0);
		const v = created[0];
		v.duration = 12.5;
		v.onloadedmetadata?.(new Event("loadedmetadata"));
		await expect(p).resolves.toBe(12.5);
	});

	it("returns null on error", async () => {
		const p = probeVideoDuration("file:///missing.mp4");
		await vi.advanceTimersByTimeAsync(0);
		created[0].onerror?.(new Event("error"));
		await expect(p).resolves.toBeNull();
	});

	it("returns null on timeout", async () => {
		const p = probeVideoDuration("file:///slow.mp4", 1000);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(2000);
		await expect(p).resolves.toBeNull();
	});

	it("returns null for non-finite duration", async () => {
		for (const d of [Number.POSITIVE_INFINITY, Number.NaN, -1, 0]) {
			const p = probeVideoDuration("file:///x.mp4");
			await vi.advanceTimersByTimeAsync(0);
			const v = created[created.length - 1];
			v.duration = d;
			v.onloadedmetadata?.(new Event("loadedmetadata"));
			await expect(p).resolves.toBeNull();
		}
	});
});
