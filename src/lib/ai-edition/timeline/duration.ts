// Probe a video file's actual duration by mounting a hidden <video> and
// waiting for loadedmetadata. Used by the timeline store to size
// freshly-inserted clips at the real source duration, so the user sees
// the correct clip width immediately on drop instead of the placeholder.
//
// Falls back to null on error / timeout / non-finite duration. Caller
// decides whether to fall back to a placeholder (60s) or surface an error.
//
// ponytail: probe via DOM <video> rather than the existing VirtualPreview.
// We need this BEFORE the clip is on the timeline (so insertClipAt can
// size it correctly), but VirtualPreview only mounts once a clip exists.
// A throwaway <video> is the cleanest no-extra-component solution.

const DEFAULT_TIMEOUT_MS = 5000;

export function probeVideoDuration(
	src: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<number | null> {
	return new Promise((resolve) => {
		if (typeof document === "undefined" || !src) {
			resolve(null);
			return;
		}
		const video = document.createElement("video");
		video.preload = "metadata";
		video.style.position = "absolute";
		video.style.width = "1px";
		video.style.height = "1px";
		video.style.opacity = "0";
		video.style.pointerEvents = "none";
		video.style.left = "-9999px";
		let settled = false;
		const cleanup = () => {
			video.onloadedmetadata = null;
			video.onerror = null;
			clearTimeout(timer);
			try {
				video.removeAttribute("src");
				video.load();
			} catch {
				// ignore — browser may refuse if already detached
			}
			if (video.parentNode) video.parentNode.removeChild(video);
		};
		const settle = (value: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const timer = setTimeout(() => settle(null), timeoutMs);
		video.onloadedmetadata = () => {
			const d = video.duration;
			settle(Number.isFinite(d) && d > 0 ? d : null);
		};
		video.onerror = () => settle(null);
		// ponytail: append to body so some browsers (Firefox) actually fire
		// loadedmetadata for fully-detached <video> elements.
		document.body.appendChild(video);
		video.src = src;
	});
}
