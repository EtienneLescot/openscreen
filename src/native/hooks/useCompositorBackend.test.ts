// @vitest-environment jsdom
/**
 * The CPU-backend notice must fire on a degraded GPU and stay silent everywhere else.
 *
 * The failure worth guarding is the false positive: `"none"` means there is no native
 * compositor at all (pure-web `npm run dev`, jsdom, an addon that failed to load), which
 * is the normal state in development — warning there would put "no compatible GPU" in
 * front of every developer on every run. Only `"cpu"` is a real degraded machine.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ probeCompositorBackend: vi.fn() }));

vi.mock("../compositorViewClient", () => ({
	probeCompositorBackend: mocks.probeCompositorBackend,
}));

import {
	resetCompositorBackendProbeForTests,
	useCompositorBackend,
	useIsCpuCompositor,
} from "./useCompositorBackend";

describe("useCompositorBackend", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetCompositorBackendProbeForTests();
	});

	it("reports the degraded machine", async () => {
		mocks.probeCompositorBackend.mockResolvedValue("cpu");
		const { result } = renderHook(() => useIsCpuCompositor());
		await waitFor(() => expect(result.current).toBe(true));
	});

	it("stays silent on a normal GPU", async () => {
		mocks.probeCompositorBackend.mockResolvedValue("hardware");
		const { result } = renderHook(() => useCompositorBackend());
		await waitFor(() => expect(result.current).toBe("hardware"));
		expect(result.current === "cpu").toBe(false);
	});

	it("stays silent when there is no native compositor at all", async () => {
		mocks.probeCompositorBackend.mockResolvedValue("none");
		const { result } = renderHook(() => useIsCpuCompositor());
		await waitFor(() => expect(mocks.probeCompositorBackend).toHaveBeenCalled());
		expect(result.current).toBe(false);
	});

	it("starts silent, before the probe resolves", () => {
		mocks.probeCompositorBackend.mockReturnValue(new Promise(() => {}));
		const { result } = renderHook(() => useIsCpuCompositor());
		// No flash of "no compatible GPU" on a machine that turns out to have one.
		expect(result.current).toBe(false);
	});

	it("probes once for the whole session, however many consumers ask", async () => {
		mocks.probeCompositorBackend.mockResolvedValue("cpu");
		const a = renderHook(() => useIsCpuCompositor());
		const b = renderHook(() => useIsCpuCompositor());
		await waitFor(() => expect(a.result.current).toBe(true));
		await waitFor(() => expect(b.result.current).toBe(true));
		// Creating a D3D11 device is not free; the preview and the export dialog share one.
		expect(mocks.probeCompositorBackend).toHaveBeenCalledTimes(1);
	});
});
