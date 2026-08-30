/**
 * Whether this machine can segment the camera, probed once per session.
 *
 * A property of the installation, not of a view: the same three things have to line up
 * whatever is on screen — the native addon, the ONNX Runtime library, and the model. So it
 * is memoised in a module-level promise, exactly as `useCompositorBackend` is.
 *
 * Returns `null` until the probe resolves, so callers render nothing rather than flashing a
 * control that may be about to disappear.
 */

import { useEffect, useState } from "react";
import { probeSegmentationSupport } from "../compositorViewClient";
import type { SegmentationSupport } from "../contracts";

let cached: Promise<SegmentationSupport> | null = null;

function probeOnce(): Promise<SegmentationSupport> {
	if (!cached) {
		cached = probeSegmentationSupport();
	}
	return cached;
}

/** Test seam: drops the memoised probe so each test observes its own mock. */
export function resetSegmentationSupportProbeForTests(): void {
	cached = null;
}

export function useSegmentationSupport(): SegmentationSupport | null {
	const [support, setSupport] = useState<SegmentationSupport | null>(null);

	useEffect(() => {
		let disposed = false;
		probeOnce().then((value) => {
			if (!disposed) {
				setSupport(value);
			}
		});
		return () => {
			disposed = true;
		};
	}, []);

	return support;
}

/**
 * True only once the machine has answered that it CAN segment.
 *
 * Fails closed on purpose. `null` (still probing) is not capability, and neither is
 * `"no-runtime"` / `"no-model"` / `"none"` — the whole point is that a control which cannot
 * do anything must not be offered. Showing it and having it do nothing is the failure this
 * replaces: the previous gate read `process.platform`, which hid the control on Linux builds
 * that could segment and showed it on Intel Macs, for which upstream publishes no ONNX
 * binary at all.
 */
export function useCanSegmentCamera(): boolean {
	return useSegmentationSupport() === "ready";
}
