import { describe, expect, it } from "vitest";
import { shouldSwallowMainProcessError } from "./main-process-errors";

describe("shouldSwallowMainProcessError", () => {
	it("swallows EPIPE on an Error object", () => {
		const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
		expect(shouldSwallowMainProcessError(err)).toBe(true);
	});

	it("swallows ECONNRESET on an Error object", () => {
		const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
		expect(shouldSwallowMainProcessError(err)).toBe(true);
	});

	it("swallows ERR_STREAM_DESTROYED on an Error object", () => {
		const err = Object.assign(new Error("ERR_STREAM_DESTROYED"), {
			code: "ERR_STREAM_DESTROYED",
		});
		expect(shouldSwallowMainProcessError(err)).toBe(true);
	});

	it("does not swallow a plain Error without an errno code", () => {
		expect(shouldSwallowMainProcessError(new Error("boom"))).toBe(false);
	});

	it("does not swallow an Error with an unrelated code", () => {
		const err = Object.assign(new Error("EBADFOO"), { code: "EBADFOO" });
		expect(shouldSwallowMainProcessError(err)).toBe(false);
	});

	it("does not swallow non-Error values", () => {
		expect(shouldSwallowMainProcessError("EPIPE")).toBe(false);
		expect(shouldSwallowMainProcessError(null)).toBe(false);
		expect(shouldSwallowMainProcessError(undefined)).toBe(false);
		expect(shouldSwallowMainProcessError(42)).toBe(false);
	});
});
