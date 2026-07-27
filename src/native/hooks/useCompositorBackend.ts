/**
 * Which backend the native compositor runs on, probed once per session.
 *
 * The answer is a property of the machine, not of a view, so it is cached in a
 * module-level promise: the preview and the export dialog both need it, and neither
 * should pay a second native device creation for it. The native side caches it too.
 *
 * Returns `null` until the probe resolves, so callers render nothing rather than
 * flashing a warning that may not apply.
 */

import { useEffect, useState } from "react";
import { probeCompositorBackend } from "../compositorViewClient";
import type { CompositorBackend } from "../contracts";

let cached: Promise<CompositorBackend> | null = null;

function probeOnce(): Promise<CompositorBackend> {
	if (!cached) {
		cached = probeCompositorBackend();
	}
	return cached;
}

/** Test seam: drops the memoised probe so each test observes its own mock. */
export function resetCompositorBackendProbeForTests(): void {
	cached = null;
}

export function useCompositorBackend(): CompositorBackend | null {
	const [backend, setBackend] = useState<CompositorBackend | null>(null);

	useEffect(() => {
		let disposed = false;
		probeOnce().then((value) => {
			if (!disposed) {
				setBackend(value);
			}
		});
		return () => {
			disposed = true;
		};
	}, []);

	return backend;
}

/**
 * True only when the compositor is running WITHOUT a usable GPU.
 *
 * Deliberately not `backend !== "hardware"`: `"none"` means there is no native compositor
 * at all (pure-web dev, jsdom), which is not a degraded machine and must never raise a
 * warning. `null` (still probing) is not degraded either.
 */
export function useIsCpuCompositor(): boolean {
	return useCompositorBackend() === "cpu";
}
