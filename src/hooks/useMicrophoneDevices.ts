import { useEffect, useRef, useState } from "react";

export interface MicrophoneDevice {
	deviceId: string;
	label: string;
	groupId: string;
}

export function useMicrophoneDevices(enabled: boolean = true) {
	const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
	const [selectedDeviceId, setSelectedDeviceId] = useState<string>("default");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Read through a ref rather than a dependency: `selectedDeviceId` is written by
	// this very effect, so depending on it re-ran the whole load — a second
	// getUserMedia() permission stream acquired and torn down on every open.
	const selectedDeviceIdRef = useRef(selectedDeviceId);
	selectedDeviceIdRef.current = selectedDeviceId;

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
						setSelectedDeviceId(audioInputs[0].deviceId);
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
