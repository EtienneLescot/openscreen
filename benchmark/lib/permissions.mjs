/**
 * Getting every permission prompt out of the way in one sitting.
 *
 * The benchmark is meant to be started and then left alone, but macOS will not let that
 * happen by default: the first Apple Event sent to each application raises a modal
 * "<host> wants access to control <app>" dialog, and it blocks the script that triggered it
 * until somebody answers. Hit six of those spread across a two-hour unattended run and the
 * run is not unattended at all — it is six ambushes.
 *
 * So they are all provoked deliberately, up front, while the user is still at the keyboard.
 * Each app gets one harmless scripted question ("how many windows do you have?"); the first
 * one raises the dialog, every later one is silent. Granting is the user's to do — these are
 * security settings and nothing here clicks Allow on their behalf — but after this pass there
 * is nothing left to interrupt.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Has this process already been granted Apple Event access to `bundleId`? */
export function automationStatus(bundleId) {
	// A zero-timeout probe: if the permission is missing the call blocks on the dialog, which
	// is exactly what we want to detect without waiting for a human.
	const res = spawnSync(
		"/usr/bin/osascript",
		["-e", `tell application id "${bundleId}" to return name`],
		{ encoding: "utf8", timeout: 2500 },
	);
	if (res.error?.code === "ETIMEDOUT") return "prompting";
	const err = (res.stderr ?? "").toLowerCase();
	if (res.status === 0) return "granted";
	if (err.includes("not authoriz") || err.includes("-1743")) return "denied";
	if (err.includes("-600") || err.includes("isn't running")) return "granted"; // reachable, just not running
	return "unknown";
}

/**
 * Provoke the Apple Events prompt for one app and wait for an answer.
 * Returns once the user has responded (or the timeout expires).
 */
export function primeAutomation(bundleId, { timeoutMs = 180_000 } = {}) {
	const res = spawnSync(
		"/usr/bin/osascript",
		["-e", `tell application id "${bundleId}" to return name`],
		{ encoding: "utf8", timeout: timeoutMs },
	);
	if (res.status === 0) return { bundleId, status: "granted" };
	const err = (res.stderr ?? "").trim();
	if (/-1743|not authoriz/i.test(err))
		return { bundleId, status: "denied", error: err.slice(0, 200) };
	if (/-600|isn't running/i.test(err))
		return { bundleId, status: "granted", note: "app not running" };
	if (res.error?.code === "ETIMEDOUT") return { bundleId, status: "unanswered" };
	return { bundleId, status: "unknown", error: err.slice(0, 200) };
}

/**
 * Whether this process can drive the UI at all. Without Accessibility, System Events refuses
 * every menu click and no GUI driver can run — better to say so in preflight than to have the
 * first GUI app fail an hour into a run.
 */
export function accessibilityGranted() {
	const res = spawnSync(
		"/usr/bin/osascript",
		["-e", 'tell application "System Events" to return count of processes'],
		{ encoding: "utf8", timeout: 10_000 },
	);
	return res.status === 0 && /^\d+$/.test((res.stdout ?? "").trim());
}

/** Is any modal permission dialog on screen right now, and what is it asking? */
export function pendingPermissionDialog() {
	const res = spawnSync(
		"/usr/bin/osascript",
		[
			"-e",
			`tell application "System Events"
				if not (exists process "UserNotificationCenter") then return ""
				tell process "UserNotificationCenter"
					if (count of windows) is 0 then return ""
					set t to ""
					repeat with e in (every static text of window 1)
						set t to t & (value of e) & " "
					end repeat
					return t
				end tell
			end tell`,
		],
		{ encoding: "utf8", timeout: 8000 },
	);
	const text = (res.stdout ?? "").trim();
	return text || null;
}

/** Everything a run needs, in the order preflight should walk through it. */
export function permissionPlan(drivers) {
	return drivers
		.filter((d) => d.bundleId && d.appPath && existsSync(d.appPath))
		.map((d) => ({
			app: d.displayName,
			bundleId: d.bundleId,
			why:
				d.automation === "cli"
					? "quitting the app cleanly between runs"
					: "driving its menu bar and export dialog",
			status: automationStatus(d.bundleId),
		}));
}
