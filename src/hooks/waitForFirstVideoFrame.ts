const FIRST_FRAME_TIMEOUT_MS = 3000;

/**
 * Resolve once `track` has produced a real, decodable frame -- not merely once
 * `track.muted` reads false. On Linux/PipeWire the desktop-capture portal can still be
 * negotiating (DMA-BUF modifier renegotiation, `no_hardware_cursors`, etc.) well after
 * the track reports unmuted, so anchoring recording start to "now" makes MediaRecorder's
 * own internal frame-0 arrive silently late: the declared recording duration (wall time
 * from button-press to stop) ends up longer than the video's real content span (playback
 * jumps to the end early), and cursor telemetry -- anchored to the same "now" -- drifts
 * out of sync with the picture. Waiting for an actual rendered frame here, before
 * `recorder.start()` is ever called, keeps duration accounting, cursor telemetry, and
 * MediaRecorder's timeline all pointing at the same wall-clock instant.
 *
 * Falls back to `Date.now()` after `FIRST_FRAME_TIMEOUT_MS` if no frame arrives (e.g. a
 * genuinely stalled capture), so recording start is never blocked indefinitely.
 */
export function waitForFirstVideoFrame(track: MediaStreamTrack): Promise<number> {
	return new Promise((resolve) => {
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.srcObject = new MediaStream([track]);

		let settled = false;
		const cleanup = () => {
			video.srcObject = null;
			video.remove();
		};
		const finish = (timeMs: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			cleanup();
			resolve(timeMs);
		};

		const timeoutId = setTimeout(() => finish(Date.now()), FIRST_FRAME_TIMEOUT_MS);

		if (typeof video.requestVideoFrameCallback !== "function") {
			// API unavailable (older Chromium); fall back to a short settle delay rather
			// than blocking on the full timeout every time.
			finish(Date.now());
			return;
		}

		video.requestVideoFrameCallback(() => finish(Date.now()));
		void video.play().catch(() => {
			// Autoplay/play() rejection still lets requestVideoFrameCallback or the
			// timeout resolve this promise; nothing else to do here.
		});
	});
}
