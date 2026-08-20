/**
 * Matching a device the user picked in the browser against one Windows can open.
 *
 * The two sides name the same hardware differently — Chromium appends USB ids
 * ("Logitech StreamCam (046d:0893)") while DirectShow, Media Foundation and
 * WASAPI report the driver's friendly name — so the match cannot be equality.
 * It can, however, be *decisive*: every real pairing observed is one name
 * containing the other, and nothing weaker is trusted.
 *
 * There used to be a further tier that scored shared WORDS, meant to bridge
 * names that differ more than that. It bridged names that were not the same
 * device at all. "Logi Capture" and "Logitech StreamCam" share no word, but
 * "logi" is inside "logitech" — enough to win, so choosing a camera Media
 * Foundation cannot see opened a different camera instead of falling through to
 * the provider that would have found the right one. The microphone side reached
 * the same place by the same road, "micro" sitting inside the "microphone" that
 * opens nearly every Windows endpoint name (getopenscreen/openscreen#404, #405).
 *
 * Dropping that tier costs nothing measurable: on the reporter's machine every
 * camera and microphone resolves at 800 or above without it. What it buys is
 * that "I could not find it" is now reachable — and a caller that hears it can
 * try another provider, or say so, instead of recording the wrong device.
 *
 * This lives here rather than in `electron/ipc/handlers.ts` because that module
 * calls `app.getPath()` while being imported and cannot be loaded from a test.
 * The C++ helpers carry their own copy of these rules, covered by the
 * Windows-only scripts in `scripts/` that drive the real binary.
 */

/** Lowercase, alphanumerics only, single-spaced — the shape both sides compare in. */
export function normalizeDeviceName(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * How well a candidate device answers a requested name, or 0 for "not this one"
 * — which callers must treat as a real answer rather than a weak match.
 *
 * @param candidateName The device's own name, as the platform reports it.
 * @param candidateId Its stable identifier — a CLSID, a symbolic link — which
 * sometimes carries the model name when the friendly name does not.
 * @param requestedName What the user picked, as the browser labelled it.
 */
export function scoreDeviceNameMatch(
	candidateName: string,
	candidateId: string,
	requestedName?: string,
) {
	const candidate = normalizeDeviceName(candidateName);
	const id = normalizeDeviceName(candidateId);
	const requested = normalizeDeviceName(requestedName ?? "");
	if (!requested) {
		return 0;
	}
	if (candidate === requested) {
		return 1000;
	}
	// One name being the other plus decoration is the ordinary case, and the only
	// inexact match worth trusting.
	if (candidate && (candidate.includes(requested) || requested.includes(candidate))) {
		return 900;
	}
	if (id && (id.includes(requested) || requested.includes(id))) {
		return 800;
	}
	return 0;
}
