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

// Enumeration walks every display and window and grabs a thumbnail of each, so
// it is allowed to be slow on a loaded machine. It is not allowed to be
// unbounded.
const SOURCE_ENUMERATION_TIMEOUT_MS = 20_000;

async function withTimeout<T>(work: Promise<T>, fallback: T, what: string, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<T>((resolve) => {
				timer = setTimeout(() => {
					// Surfaced on stderr as `[renderer] …` by the CLI's console bridge.
					console.warn(`${what} did not settle in ${ms}ms`);
					resolve(fallback);
				}, ms);
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

	// null, not []: an empty list is an affirmative claim that this host has no
	// microphones, and with it `microphoneLabelsUnavailable` computes to false
	// below — the exact opposite of what giving up should report, and
	// indistinguishable from a genuinely mic-less machine for anyone reading the
	// -o file. The sentinel keeps "we stopped asking" separate from "there are
	// none", and reports it the way a denied permission already reports it.
	// The .catch for the same reason as the re-enumeration below: withTimeout is a
	// Promise.race, so it adopts a rejection and the fallback applies only to
	// silence. A backend that answers with an error rather than not answering is
	// the same situation from the caller's side -- no device list -- and must not
	// take the displays and windows down with it.
	const initialInputs = await withTimeout<MediaDeviceInfo[] | null>(
		listInputs().catch(() => null),
		null,
		"device enumeration",
		MICROPHONE_TIMEOUT_MS,
	);
	if (initialInputs === null) {
		return { microphones: [], microphoneLabelsUnavailable: true };
	}
	let inputs = initialInputs;

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

		if (await withTimeout(probe, false, "microphone permission probe", MICROPHONE_TIMEOUT_MS)) {
			// The .catch restores what the try/catch around this call used to give:
			// withTimeout is a Promise.race, so it adopts a rejection and its
			// `fallback` never applies on that path. Without it a rejecting
			// enumerateDevices() — a detached context, or the MediaDevices connection
			// dropping after the grant — fails the whole command and discards the
			// displays and windows already enumerated above, which are what `sources`
			// is for. Labels are a nicety; keep the pre-probe list and carry on.
			inputs = await withTimeout(
				listInputs().catch(() => inputs),
				inputs,
				"device re-enumeration",
				MICROPHONE_TIMEOUT_MS,
			);
		}
	}

	const labeled = inputs.filter((device) => device.label);
	return {
		microphones: labeled.map((device) => ({ label: device.label })),
		microphoneLabelsUnavailable: inputs.length > 0 && labeled.length === 0,
	};
}

async function enumerateSources(): Promise<CliSourcesResult> {
	// desktopCapturer.getSources is unbounded on the main side, and on a host
	// whose GL stack is broken -- a CI runner, a container, a server where ANGLE
	// cannot initialise -- it can simply never return. `openscreen sources` hung
	// forever on four of five headless attempts, always here: the milestones show
	// the renderer asking for its request and then going silent, which is the call
	// immediately after.
	//
	// Bounded on this side rather than in the shared get-sources handler, which
	// the GUI uses too and where a timeout would change behaviour nobody asked to
	// change. Failing in twenty seconds with a reason beats hanging until killed.
	const sources = await withTimeout<Awaited<
		ReturnType<typeof window.electronAPI.getSources>
	> | null>(
		window.electronAPI.getSources({
			types: ["screen", "window"],
			thumbnailSize: { width: 32, height: 18 },
		}),
		null,
		"desktop source enumeration",
		SOURCE_ENUMERATION_TIMEOUT_MS,
	);
	if (sources === null) {
		throw new Error(
			`Desktop source enumeration did not return within ${SOURCE_ENUMERATION_TIMEOUT_MS}ms. ` +
				"This usually means the display or GPU stack cannot be reached — check that a display server is available.",
		);
	}

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
