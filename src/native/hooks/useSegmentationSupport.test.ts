// @vitest-environment jsdom
/**
 * The camera-background control must appear only where a mask can actually reach the shader.
 *
 * The failure worth guarding is the false POSITIVE, and it is the mirror of the CPU-notice
 * one next door: here, offering the control is the damage. Every non-`"ready"` answer means
 * the user would click a setting, watch it persist and highlight, and see nothing change —
 * in the preview and in the exported file alike.
 *
 * This replaced a `process.platform` guess that was wrong in both directions: it hid the
 * control on Linux builds that could segment, and showed it on Intel Macs, for which
 * upstream publishes no ONNX Runtime binary at all.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ probeSegmentationSupport: vi.fn() }));

vi.mock("../compositorViewClient", () => ({
	probeSegmentationSupport: mocks.probeSegmentationSupport,
}));

import {
	resetSegmentationSupportProbeForTests,
	useCanSegmentCamera,
	useSegmentationSupport,
} from "./useSegmentationSupport";

describe("useSegmentationSupport", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetSegmentationSupportProbeForTests();
	});

	it("offers the control when the machine can segment", async () => {
		mocks.probeSegmentationSupport.mockResolvedValue("ready");
		const { result } = renderHook(() => useCanSegmentCamera());
		await waitFor(() => expect(result.current).toBe(true));
	});

	// The three ways it silently cannot, each of which has actually happened: no ONNX Runtime
	// (Intel Mac, dev checkout, `--dir` build), no model (not lifted out of app.asar), no addon
	// (pure-web dev). None of them fails loudly, which is exactly why the probe exists.
	it.each([
		"no-runtime",
		"no-model",
		"none",
	] as const)("hides the control when the answer is %s", async (answer) => {
		mocks.probeSegmentationSupport.mockResolvedValue(answer);
		const { result } = renderHook(() => useCanSegmentCamera());
		await waitFor(() => expect(mocks.probeSegmentationSupport).toHaveBeenCalled());
		expect(result.current).toBe(false);
	});

	it("reports the reason, not just the verdict", async () => {
		mocks.probeSegmentationSupport.mockResolvedValue("no-runtime");
		const { result } = renderHook(() => useSegmentationSupport());
		// Which one it is decides whether staging is missing or the model is — the difference
		// between a build bug and a packaging bug.
		await waitFor(() => expect(result.current).toBe("no-runtime"));
	});

	it("hides the control until the probe answers", () => {
		mocks.probeSegmentationSupport.mockReturnValue(new Promise(() => {}));
		const { result } = renderHook(() => useCanSegmentCamera());
		// Fails closed: no flash of a control that is about to disappear.
		expect(result.current).toBe(false);
	});

	it("probes once for the whole session, however many consumers ask", async () => {
		mocks.probeSegmentationSupport.mockResolvedValue("ready");
		const a = renderHook(() => useCanSegmentCamera());
		const b = renderHook(() => useCanSegmentCamera());
		await waitFor(() => expect(a.result.current).toBe(true));
		await waitFor(() => expect(b.result.current).toBe(true));
		expect(mocks.probeSegmentationSupport).toHaveBeenCalledTimes(1);
	});
});
