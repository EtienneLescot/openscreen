import { useEffect, useRef, useState } from "react";

export interface MicrophoneDevice {
	deviceId: string;
	label: string;
	groupId: string;
}

/**
 * @param preferredDeviceId The microphone the session already settled on —
 * normally the one restored from the recording prefs. It outranks "first in the
 * list", which is the OS enumeration order and has nothing to do with what the
 * user chose. The HUD window is destroyed and rebuilt for every recording, so
 * without this its pick reverted on each take.
 * @param preferredDeviceName The same choice by label, tried when the id finds
 * nothing. Chromium's device ids are per-origin salted, so the id a previous
 * window persisted can name nothing in this one while the microphone is sitting
 * right there in the list — and falling through to the first input would then
 * discard a choice that was perfectly resolvable.
 */
export function useMicrophoneDevices(
	enabled: boolean = true,
	preferredDeviceId?: string,
	preferredDeviceName?: string,
) {
	const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
	const [selectedDeviceId, setSelectedDeviceId] = useState<string>("default");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Read through a ref rather than a dependency: `selectedDeviceId` is written by
	// this very effect, so depending on it re-ran the whole load — a second
	// getUserMedia() permission stream acquired and torn down on every open.
	const selectedDeviceIdRef = useRef(selectedDeviceId);
	const preferredDeviceIdRef = useRef(preferredDeviceId);
	const preferredDeviceNameRef = useRef(preferredDeviceName);
	// Synchronised in an effect rather than during render: React may discard a
	// render without committing it, and a ref written there keeps the value
	// anyway, which would resolve the selection against a device the committed
	// tree never agreed on.
	useEffect(() => {
		selectedDeviceIdRef.current = selectedDeviceId;
		preferredDeviceIdRef.current = preferredDeviceId;
		preferredDeviceNameRef.current = preferredDeviceName;
	}, [selectedDeviceId, preferredDeviceId, preferredDeviceName]);

	useEffect(() => {
		if (!enabled) {
			return;
		}

		let mounted = true;

		const loadDevices = async () => {
			try {
				setIsLoading(true);
				setError(null);

				// Request permission first to get actual device labels
				const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

				const allDevices = await navigator.mediaDevices.enumerateDevices();
				const audioInputs = allDevices
					.filter((device) => device.kind === "audioinput")
					.map((device) => ({
						deviceId: device.deviceId,
						label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
						groupId: device.groupId,
					}));

				// Stop the permission stream
				stream.getTracks().forEach((track) => track.stop());

				if (mounted) {
					setDevices(audioInputs);
					const currentId = selectedDeviceIdRef.current;
					const stillAvailable = audioInputs.some((d) => d.deviceId === currentId);
					if ((currentId === "default" || !stillAvailable) && audioInputs.length > 0) {
						const preferredId = preferredDeviceIdRef.current;
						const preferredName = preferredDeviceNameRef.current;
						// By id, then by label, then whatever is first. Always an entry
						// from THIS list, so the id and the label the caller ends up
						// sending to the native helper describe the same device — the
						// pairing that #387 and #404 were both about.
						const preferred =
							(preferredId ? audioInputs.find((d) => d.deviceId === preferredId) : undefined) ??
							(preferredName ? audioInputs.find((d) => d.label === preferredName) : undefined);
						setSelectedDeviceId(preferred?.deviceId ?? audioInputs[0].deviceId);
					}
					setIsLoading(false);
				}
			} catch (err) {
				if (mounted) {
					const errorMessage =
						err instanceof Error ? err.message : "Failed to enumerate audio devices";
					setError(errorMessage);
					setIsLoading(false);
					console.error("Error loading microphone devices:", err);
				}
			}
		};

		loadDevices();

		const handleDeviceChange = () => {
			loadDevices();
		};

		navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

		return () => {
			mounted = false;
			navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
		};
	}, [enabled]);

	return {
		devices,
		selectedDeviceId,
		setSelectedDeviceId,
		isLoading,
		error,
	};
}
