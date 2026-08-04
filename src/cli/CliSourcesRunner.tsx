// Hidden-window runner for `openscreen sources`: enumerates capturable
// displays/windows (via the same get-sources IPC the GUI picker uses) and
// microphone inputs, then hands the payload to the CLI controller to print.

import { useEffect, useRef, useState } from "react";
import type { CliSourcesResult } from "@/lib/cliContracts";

async function enumerateMicrophones(): Promise<{
	microphones: { label: string }[];
	microphoneLabelsUnavailable: boolean;
}> {
	const listInputs = async () =>
		(await navigator.mediaDevices.enumerateDevices()).filter(
			(device) => device.kind === "audioinput",
		);

	let inputs = await listInputs();

	// Labels are blank until a getUserMedia grant exists; a short-lived probe
	// stream unlocks them without leaving anything recording.
	if (inputs.length > 0 && inputs.every((device) => !device.label)) {
		let probeStream: MediaStream | null = null;
		try {
			probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
			inputs = await listInputs();
		} catch {
			// Permission denied — report devices without labels.
		} finally {
			probeStream?.getTracks().forEach((track) => track.stop());
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
