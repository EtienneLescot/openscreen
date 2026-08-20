// Hidden-window runner for `openscreen sources`: enumerates capturable
// displays/windows (via the same get-sources IPC the GUI picker uses) and
// microphone inputs, then hands the payload to the CLI controller to print.

import { useEffect, useRef, useState } from "react";
import type { CliSourcesResult } from "@/lib/cliContracts";

// getUserMedia and enumerateDevices both sit on the host's audio backend, and
// neither takes a timeout. Where that backend is absent or wedged -- a
// container, a CI runner, a server -- they can simply never settle, and the
// catch below is no defence: it fires on rejection, not on silence. `openscreen
// sources` hung indefinitely on roughly half of its headless runs for this
// reason, which is worse than failing outright, because a script waits forever
// rather than seeing an error.
//
// Displays and windows are what the command is for; microphone labels are a
// nicety on top. So the audio path is best-effort and bounded, and giving up
// reports exactly what a denied permission already reported.
const MICROPHONE_TIMEOUT_MS = 5_000;

async function withTimeout<T>(work: Promise<T>, fallback: T, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<T>((resolve) => {
				timer = setTimeout(() => {
					// Surfaced on stderr as `[renderer] …` by the CLI's console bridge.
					console.warn(
						`${what} did not settle in ${MICROPHONE_TIMEOUT_MS}ms; continuing without it`,
					);
					resolve(fallback);
				}, MICROPHONE_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function enumerateMicrophones(): Promise<{
	microphones: { label: string }[];
	microphoneLabelsUnavailable: boolean;
}> {
	const listInputs = async () =>
		(await navigator.mediaDevices.enumerateDevices()).filter(
			(device) => device.kind === "audioinput",
		);

	let inputs = await withTimeout<MediaDeviceInfo[]>(listInputs(), [], "device enumeration");

	// Labels are blank until a getUserMedia grant exists; a short-lived probe
	// stream unlocks them without leaving anything recording.
	if (inputs.length > 0 && inputs.every((device) => !device.label)) {
		const probe = navigator.mediaDevices
			.getUserMedia({ audio: true })
			.then((stream) => {
				// Released here rather than in a finally, so that a stream arriving
				// after we have stopped waiting still does not hold the device open.
				stream.getTracks().forEach((track) => track.stop());
				return true;
			})
			.catch(() => false); // Permission denied — report devices without labels.

		if (await withTimeout(probe, false, "microphone permission probe")) {
			inputs = await withTimeout(listInputs(), inputs, "device re-enumeration");
		}
	}

	const labeled = inputs.filter((device) => device.label);
	return {
		microphones: labeled.map((device) => ({ label: device.label })),
		microphoneLabelsUnavailable: inputs.length > 0 && labeled.length === 0,
	};
}

async function enumerateSources(): Promise<CliSourcesResult> {
	const sources = await window.electronAPI.getSources({
		types: ["screen", "window"],
		thumbnailSize: { width: 32, height: 18 },
	});

	const displays = sources
		.filter((source) => source.id.startsWith("screen:"))
		.map((source, index) => ({ index, id: source.id, name: source.name }));
	const windows = sources
		.filter((source) => source.id.startsWith("window:"))
		.map((source) => ({ id: source.id, name: source.name }));

	const { microphones, microphoneLabelsUnavailable } = await enumerateMicrophones();
	return { displays, windows, microphones, microphoneLabelsUnavailable };
}

export function CliSourcesRunner() {
	const startedRef = useRef(false);
	const [status] = useState("Enumerating sources…");

	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;

		void (async () => {
			try {
				const request = await window.electronAPI.cliGetRequest();
				if (request.kind !== "sources") {
					throw new Error(`cli-sources window received a ${request.kind} request`);
				}
				const sources = await enumerateSources();
				await window.electronAPI.cliDone({ success: true, sources });
			} catch (error) {
				const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
				await window.electronAPI.cliDone({ success: false, error: message });
			}
		})();
	}, []);

	return (
		<div className="flex h-screen items-center justify-center bg-[#09090b] text-white/60 text-sm">
			{status}
		</div>
	);
}

export default CliSourcesRunner;
