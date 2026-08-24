import { useEffect, useRef, useState } from "react";

export interface CameraDevice {
	deviceId: string;
	label: string;
	groupId: string;
}

/**
 * @param preferredDeviceId The camera the session already settled on — typically
 * the one restored from the recording prefs. It wins over "first in the list",
 * because the list order is the OS enumeration order and the first entry is
 * routinely a virtual camera that emits nothing. Without this, a HUD rebuilt for
 * a new recording silently reverted the user's pick to that first device, and
 * only the *name* reached the native helper, so the preview showed the chosen
 * camera while the recording captured the other one.
 */
export function useCameraDevices(enabled: boolean = false, preferredDeviceId?: string) {
	const [devices, setDevices] = useState<CameraDevice[]>([]);
	const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// `loadDevices` runs long after the render that scheduled it — on a
	// `devicechange` that may arrive at any moment — so it reads these two
	// through refs rather than closing over them.
	//
	// Synchronised in an effect and not during render: React may discard a render
	// without committing it, and a ref written there keeps the value anyway. The
	// selection would then be resolved against a device the committed tree never
	// agreed on. Declared above the loading effect so the refs are current before
	// the first enumeration reads them.
	const selectedDeviceIdRef = useRef(selectedDeviceId);
	const preferredDeviceIdRef = useRef(preferredDeviceId);
	useEffect(() => {
		selectedDeviceIdRef.current = selectedDeviceId;
		preferredDeviceIdRef.current = preferredDeviceId;
	}, [selectedDeviceId, preferredDeviceId]);

	useEffect(() => {
		if (!enabled) return;
		let mounted = true;

		const loadDevices = async () => {
			try {
				setIsLoading(true);
				setError(null);

				// Enumerate without requesting a second stream; the recorder handles
				// the real acquisition. Unlabeled devices fall back to their device ID.
				const allDevices = await navigator.mediaDevices.enumerateDevices();
				const videoInputs = allDevices
					.filter((device) => device.kind === "videoinput")
					.map((device) => ({
						deviceId: device.deviceId,
						label: device.label || `Camera ${device.deviceId.slice(0, 8)}`,
						groupId: device.groupId,
					}));

				if (mounted) {
					setDevices(videoInputs);
					const currentId = selectedDeviceIdRef.current;
					const stillAvailable = videoInputs.some((d) => d.deviceId === currentId);
					if (!currentId || !stillAvailable) {
						const preferredId = preferredDeviceIdRef.current;
						const preferred = preferredId
							? videoInputs.find((d) => d.deviceId === preferredId)
							: undefined;
						setSelectedDeviceId(preferred?.deviceId ?? videoInputs[0]?.deviceId ?? "");
					}
					setIsLoading(false);
				}
			} catch (err) {
				if (mounted) {
					setError(err instanceof Error ? err.message : "Failed to load cameras");
					setIsLoading(false);
				}
			}
		};

		loadDevices();

		navigator.mediaDevices.addEventListener("devicechange", loadDevices);
		return () => {
			mounted = false;
			navigator.mediaDevices.removeEventListener("devicechange", loadDevices);
		};
	}, [enabled]);

	// The preference is restored over IPC while this list is being enumerated, so
	// it routinely lands *after* the effect above has already fallen back to the
	// first device. Adopting it here is what makes the two async sources converge
	// on the same camera instead of racing.
	useEffect(() => {
		if (!enabled || !preferredDeviceId) return;
		if (preferredDeviceId === selectedDeviceId) return;
		if (!devices.some((d) => d.deviceId === preferredDeviceId)) return;
		setSelectedDeviceId(preferredDeviceId);
	}, [enabled, preferredDeviceId, devices, selectedDeviceId]);

	// The selected entry itself, so callers can react to "which camera is chosen"
	// without depending on the identity of `devices`. `loadDevices` rebuilds that
	// array on every `devicechange`, and a caller that mirrors the selection back
	// into its own state — the HUD does — would re-fire on each rebuild and fight
	// the effect above for the value, swapping the two on every commit and never
	// settling. Depending on this object's fields instead makes the write-back
	// fire only when the chosen camera really changed.
	const selectedDevice = devices.find((d) => d.deviceId === selectedDeviceId);

	return { devices, selectedDevice, selectedDeviceId, setSelectedDeviceId, isLoading, error };
}
