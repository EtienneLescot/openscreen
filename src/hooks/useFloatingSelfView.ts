import { useCallback, useEffect, useRef, useState } from "react";

export interface FloatingSelfViewResult {
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
 * Owns the capture-safe macOS BrowserWindow self-view lifecycle. The existing
 * recorder stream remains the source of truth for availability; the hidden,
 * pre-created self-view window opens its own low-resolution stream only when
 * this hook asks main to show it.
 */
export function useFloatingSelfView({
	recording,
	webcamEnabled,
	stream,
	autoShowEnabled,
	isMac,
	onUnavailable,
}: FloatingSelfViewOptions): FloatingSelfViewResult {
	const [open, setOpen] = useState(false);
	const previousRecording = useRef(recording);
	const pendingAutoOpen = useRef(false);
	const autoOpenAttempted = useRef(false);

	const supported = isMac && typeof window !== "undefined" && Boolean(window.electronAPI);
	const ready = hasLiveVideo(stream);

	const request = useCallback(async (): Promise<FloatingSelfViewRequestResult> => {
		if (!supported) return { success: false, error: "unsupported" };
		if (!ready || !hasLiveVideo(stream)) {
			return { success: false, error: "not-ready" };
		}

		try {
			const deviceId = stream?.getVideoTracks()[0]?.getSettings?.().deviceId;
			const result = await window.electronAPI.showFloatingSelfView(deviceId);
			if (result.success) setOpen(true);
			return result.success ? { success: true } : { success: false, error: "request-rejected" };
		} catch {
			return { success: false, error: "request-rejected" };
		}
	}, [ready, stream, supported]);

	const show = useCallback(async () => {
		const result = await request();
		if (!result.success) onUnavailable?.();
		return result.success;
	}, [onUnavailable, request]);

	const hide = useCallback(async () => {
		if (!isMac || !window.electronAPI) {
			setOpen(false);
			return;
		}
		try {
			await window.electronAPI.hideFloatingSelfView();
		} catch {
			// The main process also closes the self-view when the HUD goes away.
		}
		setOpen(false);
	}, [isMac]);

	const toggle = useCallback(async () => {
		if (open) await hide();
		else await show();
	}, [hide, open, show]);

	useEffect(() => {
		if (!supported) return;
		const unsubscribe = window.electronAPI.onFloatingSelfViewStateChanged((state) => {
			setOpen(state.open);
		});
		void window.electronAPI
			.getFloatingSelfViewState()
			.then((state) => setOpen(state.open))
			.catch(() => setOpen(false));
		return unsubscribe;
	}, [supported]);

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
		}
		// One hide for every reason the self-view can no longer be shown. Splitting this
		// across two effects ran hideInternal() twice in the same commit when recording
		// stopped, and sent a second, unconditional hide on a plain HUD mount.
		if (!recording || !webcamEnabled || !hasLiveVideo(stream)) {
			void hide();
		}
	}, [autoShowEnabled, hide, recording, stream, webcamEnabled]);

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
		void show();
	}, [ready, recording, show, stream, supported, webcamEnabled]);

	useEffect(() => () => void hide(), [hide]);

	return { supported, ready, open, show, hide, toggle };
}
