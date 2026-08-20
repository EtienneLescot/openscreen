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

/**
 * Lowercase, letters and digits only, single-spaced — the shape both sides
 * compare in.
 *
 * Unicode-aware, and not `[^a-z0-9]`: that stripped every non-Latin letter, so a
 * Japanese "カメラ A" and "ウェブカメラ A" both collapsed to "a" and matched each
 * other exactly, at the highest score there is. The C++ helpers use
 * `std::iswalnum` on wide characters and never had that flaw; this is the copy
 * that did.
 */
export function normalizeDeviceName(value: string) {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Does `needle` appear in `haystack` as whole words?
 *
 * Plain containment answers for devices that merely share a spelling: a
 * requested "Micro" is inside "Microphone (Logitech StreamCam)", and "Logi"
 * inside "Logitech", neither of them as a word. Both resolved a device nobody
 * asked for — and resolving one is precisely what stops the caller from falling
 * through to the provider that had the right one.
 *
 * Both sides are normalized, so a boundary is the start of the string, its end,
 * or a space.
 */
function containsAsWords(haystack: string, needle: string) {
	if (!haystack || !needle) {
		return false;
	}
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
		const startsOnBoundary = at === 0 || haystack[at - 1] === " ";
		const after = at + needle.length;
		const endsOnBoundary = after === haystack.length || haystack[after] === " ";
		if (startsOnBoundary && endsOnBoundary) {
			return true;
		}
	}
	return false;
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
	// inexact match worth trusting — provided the shared part is whole words.
	if (containsAsWords(candidate, requested) || containsAsWords(requested, candidate)) {
		return 900;
	}
	if (containsAsWords(id, requested) || containsAsWords(requested, id)) {
		return 800;
	}
	return 0;
}
