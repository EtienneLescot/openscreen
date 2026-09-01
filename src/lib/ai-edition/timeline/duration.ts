const DEFAULT_TIMEOUT_MS = 5000;

// The duration probe: mount a hidden media element and wait for loadedmetadata.
// Falls back to null on error / timeout / non-finite duration; the caller decides
// whether to use a placeholder (60s) or surface an error.
//
// One function for both <video> and <audio> — only the tag differs, and every
// property touched (preload, style, onloadedmetadata, onerror, duration,
// removeAttribute, load, src) lives on HTMLMediaElement, which both are. Sharing
// it keeps a fix to the settle/cleanup/timeout logic from drifting between the two.
//
// ponytail: probe via a throwaway DOM element rather than VirtualPreview, which
// only mounts once a clip exists — we need the duration BEFORE that, so
// insertClipAt can size the clip correctly on drop.
function probeMediaDuration(
	tag: "video" | "audio",
	src: string,
	timeoutMs: number,
): Promise<number | null> {
	return new Promise((resolve) => {
		if (typeof document === "undefined" || !src) {
			resolve(null);
			return;
		}
		const el = document.createElement(tag);
		el.preload = "metadata";
		el.style.position = "absolute";
		el.style.width = "1px";
		el.style.height = "1px";
		el.style.opacity = "0";
		el.style.pointerEvents = "none";
		el.style.left = "-9999px";
		let settled = false;
		const cleanup = () => {
			el.onloadedmetadata = null;
			el.onerror = null;
			clearTimeout(timer);
			try {
				el.removeAttribute("src");
				el.load();
			} catch {
				// ignore — browser may refuse if already detached
			}
			if (el.parentNode) el.parentNode.removeChild(el);
		};
		const settle = (value: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const timer = setTimeout(() => settle(null), timeoutMs);
		el.onloadedmetadata = () => {
			const d = el.duration;
			settle(Number.isFinite(d) && d > 0 ? d : null);
		};
		el.onerror = () => settle(null);
		// Append to body so some browsers (Firefox) actually fire loadedmetadata
		// for a fully-detached media element.
		document.body.appendChild(el);
		el.src = src;
	});
}

/** Duration of a video file, to size a freshly-inserted clip at its real length. */
export function probeVideoDuration(
	src: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<number | null> {
	return probeMediaDuration("video", src, timeoutMs);
}

/**
 * Duration of an imported audio file (issue #350) — the audio counterpart of
 * `probeVideoDuration`, used to size a voiceover / BGM / SFX track pill on add.
 */
export function probeAudioDuration(
	src: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<number | null> {
	return probeMediaDuration("audio", src, timeoutMs);
}

/** Native pixel dimensions, same probe shape as `probeVideoDuration` (separate DOM element —
 *  cheap, one-shot, not worth merging into a combined probe for the one extra caller that
 *  needs both). `asset.video` was otherwise left permanently unset for most recordings (nothing
 *  else populates it), silently breaking anything that reads it — e.g. the export dialog's
 *  downscale/upscale badges, which need real source dimensions to compare against. */
export function probeVideoDimensions(
	src: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ width: number; height: number } | null> {
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
		const settle = (value: { width: number; height: number } | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const timer = setTimeout(() => settle(null), timeoutMs);
		video.onloadedmetadata = () => {
			const { videoWidth: width, videoHeight: height } = video;
			settle(width > 0 && height > 0 ? { width, height } : null);
		};
		video.onerror = () => settle(null);
		document.body.appendChild(video);
		video.src = src;
	});
}
