import { describe, expect, it } from "vitest";
import {
	describeMediaError,
	formatMediaError,
	MAX_RELOADS_PER_MEDIA,
	mediaErrorDisposition,
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

	// Measured in the field on a corrupted recording: two bad spots 0.47 s apart,
	// each one looking like "progress" past the other, re-armed the budget on
	// every cycle. The ceiling is what makes the reload count finite whatever the
	// re-arming heuristic concludes.
	it("is fatal once the reload ceiling is reached, whatever the budget says", () => {
		expect(mediaErrorDisposition(3, 0, MAX_RELOADS_PER_MEDIA - 1)).toBe("retry");
		expect(mediaErrorDisposition(3, 0, MAX_RELOADS_PER_MEDIA)).toBe("fatal");
		expect(mediaErrorDisposition(2, 0, MAX_RELOADS_PER_MEDIA + 5)).toBe("fatal");
	});

	// …but never for a cancelled load. Making code 1 terminal at the ceiling is
	// exactly how #395 would come back through the side door.
	it("still ignores an aborted load at the ceiling", () => {
		expect(mediaErrorDisposition(1, 0, MAX_RELOADS_PER_MEDIA * 10)).toBe("ignore");
	});
});

describe("retryDelayMs", () => {
	it("backs off, then holds at the last delay", () => {
		expect(retryDelayMs(0)).toBe(RETRY_DELAYS_MS[0]);
		expect(retryDelayMs(1)).toBe(RETRY_DELAYS_MS[1]);
		expect(retryDelayMs(50)).toBe(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
	});
});
