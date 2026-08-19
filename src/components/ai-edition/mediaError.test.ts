import { describe, expect, it } from "vitest";
import {
	describeMediaError,
	formatMediaError,
	mediaErrorDisposition,
	pruneReloads,
	RELOAD_WINDOW_MS,
	RETRY_DELAYS_MS,
	retryDelayMs,
} from "./mediaError";

describe("describeMediaError", () => {
	it("names a known code", () => {
		expect(describeMediaError({ code: 3, message: "PIPELINE_ERROR_DECODE" })).toEqual({
			code: 3,
			name: "MEDIA_ERR_DECODE",
			message: "PIPELINE_ERROR_DECODE",
		});
	});

	// An `error` event can arrive with no MediaError attached; the caller still has to
	// decide something, so this must not throw or produce `undefined` fields.
	it("survives a missing error object", () => {
		expect(describeMediaError(null)).toEqual({
			code: null,
			name: "MEDIA_ERR_UNKNOWN",
			message: "",
		});
		expect(describeMediaError({ code: 99 }).name).toBe("MEDIA_ERR_UNKNOWN");
	});

	it("formats a line a bug report can carry", () => {
		expect(formatMediaError(describeMediaError({ code: 2, message: "boom" }))).toBe(
			"MEDIA_ERR_NETWORK (2) — boom",
		);
		expect(formatMediaError(describeMediaError({ code: 2 }))).toBe("MEDIA_ERR_NETWORK (2)");
		expect(formatMediaError(describeMediaError(null))).toBe("MEDIA_ERR_UNKNOWN");
	});
});

describe("mediaErrorDisposition", () => {
	// THE regression (issue #395): a cancelled load is not a broken file. Every
	// cross-asset clip boundary remounts the <video> and every reload calls load() on
	// a possibly-loading element, so acting on code 1 — even just counting it — is what
	// let a healthy editor talk itself into an error screen.
	it("always ignores MEDIA_ERR_ABORTED, at any attempt count", () => {
		for (const attempts of [0, 1, 2, 3, 99]) {
			expect(mediaErrorDisposition(1, attempts)).toBe("ignore");
		}
	});

	it("retries a decode or network failure, then gives up", () => {
		for (const code of [2, 3]) {
			expect(mediaErrorDisposition(code, 0)).toBe("retry");
			expect(mediaErrorDisposition(code, 1)).toBe("retry");
			expect(mediaErrorDisposition(code, 2)).toBe("fatal");
		}
	});

	// A recording the capture process is still writing reports as "unsupported", so the
	// code gets one look — but only one, because it is also what a genuinely unplayable
	// file reports and re-reading that is pure latency.
	it("gives an unsupported source exactly one retry", () => {
		expect(mediaErrorDisposition(4, 0)).toBe("retry");
		expect(mediaErrorDisposition(4, 1)).toBe("fatal");
	});

	it("treats an unknown failure as transient", () => {
		expect(mediaErrorDisposition(null, 0)).toBe("retry");
		expect(mediaErrorDisposition(null, RETRY_DELAYS_MS.length)).toBe("fatal");
	});

	// The budget counts reloads inside a window, so a long session cannot
	// exhaust it: the confirmed cause of #395 is our own seek storm, which
	// recurs across an editing session and heals every time. A lifetime count
	// would eventually show a card on media a 400 ms reload always repairs.
	it("is fatal only once the window is full", () => {
		expect(mediaErrorDisposition(3, RETRY_DELAYS_MS.length - 1)).toBe("retry");
		expect(mediaErrorDisposition(3, RETRY_DELAYS_MS.length)).toBe("fatal");
	});

	// Without this, a dead file reloads every time the window empties, flashes
	// back on the metadata that always parses, and loses the card behind it.
	it("stays fatal once it has given up, however empty the window", () => {
		expect(mediaErrorDisposition(3, 0, true)).toBe("fatal");
		expect(mediaErrorDisposition(2, 0, true)).toBe("fatal");
	});

	// …but never for a cancelled load, even then. Making code 1 terminal is
	// exactly how #395 would come back through the side door.
	it("still ignores an aborted load after giving up", () => {
		expect(mediaErrorDisposition(1, 99, true)).toBe("ignore");
	});
});

describe("pruneReloads", () => {
	it("keeps only what is still inside the window", () => {
		const now = 1_000_000;
		const timestamps = [
			now - RELOAD_WINDOW_MS - 1, // expired
			now - RELOAD_WINDOW_MS, // expired, boundary is exclusive
			now - RELOAD_WINDOW_MS + 1,
			now,
		];
		expect(pruneReloads(timestamps, now)).toEqual([now - RELOAD_WINDOW_MS + 1, now]);
		expect(pruneReloads([], now)).toEqual([]);
	});
});

describe("retryDelayMs", () => {
	it("backs off, then holds at the last delay", () => {
		expect(retryDelayMs(0)).toBe(RETRY_DELAYS_MS[0]);
		expect(retryDelayMs(1)).toBe(RETRY_DELAYS_MS[1]);
		expect(retryDelayMs(50)).toBe(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
	});
});
