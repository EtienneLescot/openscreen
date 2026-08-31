// Reads the macOS floor the app declares to LaunchServices out of electron-builder.json5.
//
// Its own module because the number is asserted from two different guards — the
// Package.swift floor check and before-pack's pack-time payload check — and a second copy
// of the parser is precisely how one of them ends up hardened and the other not. That
// already happened once: declaredMacOsFloor() was scoped to its declaration block after
// review, while the function written directly beside it still took the first match in the
// whole file.
//
// Hand-rolled rather than a JSON5 parse to stay dependency-free and runnable on every CI
// platform.

/**
 * Drops `//` comments, ignoring any that appear inside a string — electron-builder.json5
 * is heavily commented, and its comments discuss the very keys parsed below.
 *
 * String-aware rather than a plain `s.replace(/\/\/.*$/gm, "")` because the config also
 * carries URLs, whose `//` a naive strip would eat.
 */
function stripJson5Comments(source) {
	let out = "";
	let inString = false;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += source[++i] ?? "";
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && source[i + 1] === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		out += ch;
	}
	return out;
}

/** The body of a top-level `"<key>": { ... }` object, brace-matched. */
function objectBody(source, key) {
	const opener = new RegExp(`"${key}"\\s*:\\s*{`).exec(source);
	if (!opener) {
		return null;
	}
	let depth = 0;
	for (let i = opener.index + opener[0].length - 1; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0) {
			return source.slice(opener.index + opener[0].length, i);
		}
	}
	return null;
}

/** The declared macOS major floor, or null if the `mac` block does not carry one. */
export function declaredAppFloorFrom(source) {
	const mac = objectBody(stripJson5Comments(source), "mac");
	if (!mac) {
		return null;
	}
	const match = mac.match(/"minimumSystemVersion"\s*:\s*"(\d+)(?:\.\d+)*"/);
	return match ? Number(match[1]) : null;
}

/** The full declared version string (e.g. "13.0"), for callers comparing exactly. */
export function declaredAppVersionFrom(source) {
	const mac = objectBody(stripJson5Comments(source), "mac");
	const match = mac?.match(/"minimumSystemVersion"\s*:\s*"([\d.]+)"/);
	return match ? match[1] : null;
}
