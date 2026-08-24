import { useCallback, useEffect, useRef, useState } from "react";

export interface FloatingSelfViewResult {
	videoRef: React.MutableRefObject<HTMLVideoElement | null>;
	supported: boolean;
	ready: boolean;
	open: boolean;
	show: () => Promise<boolean>;
	hide: () => Promise<void>;
	toggle: () => Promise<void>;
}

interface FloatingSelfViewOptions {
	recording: boolean;
	webcamEnabled: boolean;
	stream: MediaStream | null;
	autoShowEnabled: boolean;
	isMac: boolean;
	onUnavailable?: () => void;
}

export interface FloatingSelfViewRequestResult {
	success: boolean;
	error?: "unsupported" | "not-ready" | "request-rejected";
}

function hasLiveVideo(stream: MediaStream | null): boolean {
	return Boolean(stream?.getVideoTracks().some((track) => track.readyState === "live"));
}

/**
 * Owns the native video PiP lifecycle while borrowing (never stopping) the
 * recorder's camera stream. The setting controls only automatic opening;
 * manual show/hide remains available for the whole recording.
 */
export function useFloatingSelfView({
	recording,
	webcamEnabled,
	stream,
	autoShowEnabled,
	isMac,
	onUnavailable,
}: FloatingSelfViewOptions): FloatingSelfViewResult {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const [ready, setReady] = useState(false);
	const [open, setOpen] = useState(false);
	const previousRecording = useRef(recording);
	const pendingAutoOpen = useRef(false);
	const autoOpenAttempted = useRef(false);

	const supported =
		isMac &&
		typeof document !== "undefined" &&
		document.pictureInPictureEnabled !== false &&
		typeof HTMLVideoElement !== "undefined" &&
		typeof HTMLVideoElement.prototype.requestPictureInPicture === "function";

	const request = useCallback(async (): Promise<FloatingSelfViewRequestResult> => {
		const video = videoRef.current;
		if (!supported) return { success: false, error: "unsupported" };
		if (!video || !ready || !hasLiveVideo(stream)) {
			return { success: false, error: "not-ready" };
		}
		if (document.pictureInPictureElement === video) return { success: true };

		try {
			await video.requestPictureInPicture();
			return { success: true };
		} catch {
			return { success: false, error: "request-rejected" };
		}
	}, [ready, stream, supported]);
	const requestRef = useRef(request);
	requestRef.current = request;

	const show = useCallback(async () => {
		const result = await request();
		if (!result.success) onUnavailable?.();
		return result.success;
	}, [onUnavailable, request]);

	const hide = useCallback(async () => {
		const video = videoRef.current;
		if (video && document.pictureInPictureElement === video) {
			try {
				await document.exitPictureInPicture();
			} catch {
				// PiP may already have been closed by the system.
			}
		}
	}, []);

	const toggle = useCallback(async () => {
		if (open) await hide();
		else await show();
	}, [hide, open, show]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;

		setReady(false);
		video.srcObject = stream;
		const markReady = () => {
			setReady(hasLiveVideo(stream));
			void video.play().catch(() => undefined);
		};
		const markOpen = () => setOpen(true);
		const markClosed = () => setOpen(false);

		video.addEventListener("loadedmetadata", markReady);
		video.addEventListener("canplay", markReady);
		video.addEventListener("enterpictureinpicture", markOpen);
		video.addEventListener("leavepictureinpicture", markClosed);
		if (video.readyState >= HTMLMediaElement.HAVE_METADATA) markReady();

		return () => {
			video.removeEventListener("loadedmetadata", markReady);
			video.removeEventListener("canplay", markReady);
			video.removeEventListener("enterpictureinpicture", markOpen);
			video.removeEventListener("leavepictureinpicture", markClosed);
			video.srcObject = null;
			setReady(false);
		};
	}, [stream]);

	useEffect(() => {
		const started = recording && !previousRecording.current;
		previousRecording.current = recording;
		if (started) {
			pendingAutoOpen.current = autoShowEnabled;
			autoOpenAttempted.current = false;
		}
		if (!recording) {
			pendingAutoOpen.current = false;
			autoOpenAttempted.current = false;
			void hide();
		}
	}, [autoShowEnabled, hide, recording]);

	useEffect(() => {
		if (
			!pendingAutoOpen.current ||
			autoOpenAttempted.current ||
			!recording ||
			!webcamEnabled ||
			!ready ||
			!hasLiveVideo(stream) ||
			!supported
		) {
			return;
		}

		autoOpenAttempted.current = true;
		pendingAutoOpen.current = false;
		void window.electronAPI
			.requestFloatingSelfViewAutoOpen()
			.then((result) => {
				if (!result.success) onUnavailable?.();
			})
			.catch(() => onUnavailable?.());
	}, [onUnavailable, ready, recording, stream, supported, webcamEnabled]);

	useEffect(() => {
		if (!recording || !webcamEnabled || !hasLiveVideo(stream)) void hide();
	}, [hide, recording, stream, webcamEnabled]);

	useEffect(() => {
		const globalRequest = () => requestRef.current();
		const ownedVideo = videoRef.current;
		window.__openscreenRequestFloatingSelfView = globalRequest;
		return () => {
			if (window.__openscreenRequestFloatingSelfView === globalRequest) {
				delete window.__openscreenRequestFloatingSelfView;
			}
			// React may clear the ref before passive-effect cleanup. Keep the actual
			// element so HUD destruction cannot strand its native PiP window.
			if (ownedVideo && document.pictureInPictureElement === ownedVideo) {
				void document.exitPictureInPicture().catch(() => undefined);
			}
		};
	}, []);

	return { videoRef, supported, ready, open, show, hide, toggle };
}
