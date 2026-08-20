// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCameraDevices } from "./useCameraDevices";

/**
 * The HUD wires this hook into a cycle: it mirrors `selectedDevice` into the
 * recorder's `webcamDeviceId`, and hands that same value straight back as
 * `preferredDeviceId`. Testing the hook alone cannot see that — it takes both
 * halves in one tree — and the first version of the preference adoption spun at
 * ~1500 renders per 500 ms once a remembered-but-absent camera reappeared, with
 * the two effects writing each other's value on every commit. `webcamDeviceId`
 * is also a dependency of the recorder's getUserMedia effect, so the spin would
 * have hammered the camera hardware from the always-on recording toolbar.
 */

const devicechangeListeners: Array<() => void> = [];
let currentDevices: Array<{ kind: string; deviceId: string; label: string; groupId: string }> = [];

Object.defineProperty(global.navigator, "mediaDevices", {
	value: {
		enumerateDevices: vi.fn(async () => currentDevices),
		getUserMedia: vi.fn(),
		addEventListener: (_: string, cb: () => void) => devicechangeListeners.push(cb),
		removeEventListener: vi.fn(),
	},
	configurable: true,
});

const TWO_CAMERAS = [
	{ kind: "videoinput", deviceId: "cam1", label: "VCam Camera", groupId: "g1" },
	{ kind: "videoinput", deviceId: "cam2", label: "Logitech StreamCam", groupId: "g2" },
];

let renders = 0;
const observed = { selected: "", webcam: undefined as string | undefined };

/** Mirrors LaunchWindow's wiring: the hook's output feeds its own input. */
function Hud({ seedPrefs }: { seedPrefs: (set: (id: string) => void) => void }) {
	const [webcamDeviceId, setWebcamDeviceId] = useState<string | undefined>(undefined);
	const [, setWebcamDeviceName] = useState<string | undefined>(undefined);

	// useScreenRecorder seeds this from the main-process prefs, over IPC.
	useEffect(() => {
		seedPrefs(setWebcamDeviceId);
	}, [seedPrefs]);

	const { selectedDevice, selectedDeviceId } = useCameraDevices(true, webcamDeviceId);

	const selectedLabel = selectedDevice?.label;
	useEffect(() => {
		if (selectedDeviceId) {
			setWebcamDeviceId(selectedDeviceId);
			setWebcamDeviceName(selectedLabel);
		}
	}, [selectedDeviceId, selectedLabel]);

	renders += 1;
	observed.selected = selectedDeviceId;
	observed.webcam = webcamDeviceId;
	return null;
}

describe("useCameraDevices inside the HUD's write-back cycle", () => {
	beforeEach(() => {
		devicechangeListeners.length = 0;
		renders = 0;
		currentDevices = [...TWO_CAMERAS];
	});

	it("settles when a remembered camera that was absent finally appears", async () => {
		let seedNow: ((id: string) => void) | null = null;
		render(
			<Hud
				seedPrefs={(set) => {
					seedNow = set;
				}}
			/>,
		);

		// Enumeration wins the race and falls back to the first device.
		await waitFor(() => {
			expect(observed.selected).toBe("cam1");
		});

		// The prefs land afterwards, naming a camera that is not plugged in yet —
		// a virtual camera whose app has not been started, say.
		await act(async () => {
			seedNow?.("camX");
		});
		expect(observed.selected).toBe("cam1");
		expect(observed.webcam).toBe("camX");

		// The user starts NVIDIA Broadcast, so camX shows up.
		currentDevices = [
			...TWO_CAMERAS,
			{ kind: "videoinput", deviceId: "camX", label: "Camera (NVIDIA Broadcast)", groupId: "g3" },
		];
		const before = renders;
		await act(async () => {
			for (const notify of devicechangeListeners) notify();
			await new Promise((resolve) => setTimeout(resolve, 300));
		});

		// Both halves agree on the remembered camera, and the tree is quiet.
		expect(observed.selected).toBe("camX");
		expect(observed.webcam).toBe("camX");
		expect(renders - before).toBeLessThan(20);
	});

	it("stays quiet when a devicechange brings no actual change", async () => {
		render(<Hud seedPrefs={() => undefined} />);

		await waitFor(() => {
			expect(observed.selected).toBe("cam1");
		});

		const before = renders;
		await act(async () => {
			for (const notify of devicechangeListeners) notify();
			await new Promise((resolve) => setTimeout(resolve, 200));
		});

		expect(observed.selected).toBe("cam1");
		expect(renders - before).toBeLessThan(10);
	});
});
