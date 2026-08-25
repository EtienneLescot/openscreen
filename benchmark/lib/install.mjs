/**
 * Unattended installation of the competitor apps.
 *
 * Everything here runs *after* the single up-front approval collected by `preflight`, and
 * nothing here can ask a question — a run is expected to continue with nobody at the keyboard.
 *
 * Note on Gatekeeper: `curl` does not set `com.apple.quarantine`, so an app fetched this way
 * skips the "downloaded from the internet" first-launch prompt that would otherwise stall an
 * unattended run. The quarantine flag is never stripped from anything — if a vendor ships an
 * unnotarised build, that is recorded as a finding rather than worked around.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const APPLICATIONS = "/Applications";

const run = (bin, args, opts = {}) =>
	execFileSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...opts });

export function appVersion(appPath) {
	try {
		return run("/usr/bin/defaults", [
			"read",
			join(appPath, "Contents", "Info.plist"),
			"CFBundleShortVersionString",
		]).trim();
	} catch {
		return null;
	}
}

/** Notarisation / signing status, recorded so the report can say what was actually run. */
export function codesignStatus(appPath) {
	const res = spawnSync("/usr/sbin/spctl", ["-a", "-t", "exec", "-vv", appPath], {
		encoding: "utf8",
	});
	const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
	const team = /origin=(.+)/.exec(text)?.[1]?.trim() ?? null;
	return { accepted: /: accepted/.test(text), authority: team, raw: text.trim().slice(0, 400) };
}

/** Resolve a GitHub release asset to a concrete URL, so the install is version-pinned. */
export function resolveGithubAsset(repo, pattern) {
	const json = run("/usr/bin/curl", [
		"-fsSL",
		"--max-time",
		"40",
		"-H",
		"Accept: application/vnd.github+json",
		`https://api.github.com/repos/${repo}/releases/latest`,
	]);
	const rel = JSON.parse(json);
	const asset = (rel.assets ?? []).find((a) => pattern.test(a.name));
	if (!asset) {
		throw new Error(
			`no asset in ${repo}@${rel.tag_name} matched ${pattern}. Present: ${(rel.assets ?? []).map((a) => a.name).join(", ")}`,
		);
	}
	return {
		url: asset.browser_download_url,
		version: rel.tag_name,
		name: asset.name,
		sizeBytes: asset.size,
	};
}

/** Resumable download. A 400 MB DMG over a flaky link should not restart from zero. */
export function download(url, destDir, { log = () => undefined } = {}) {
	mkdirSync(destDir, { recursive: true });
	// The vendor URL is often a redirect; ask curl for the effective name it lands on.
	const effective = run("/usr/bin/curl", [
		"-sIL",
		"--max-time",
		"60",
		"-o",
		"/dev/null",
		"-w",
		"%{url_effective}",
		url,
	]).trim();
	let name = basename(new URL(effective).pathname) || basename(new URL(url).pathname);
	if (!/\.(dmg|zip|pkg)$/i.test(name)) name = `${name || "download"}.dmg`;
	const dest = join(destDir, decodeURIComponent(name));

	log(`  downloading ${decodeURIComponent(name)}`);
	run(
		"/usr/bin/curl",
		["-fL", "--retry", "3", "--retry-delay", "2", "-C", "-", "--max-time", "1800", "-o", dest, url],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);

	const sha = createHash("sha256").update(readFileSync(dest)).digest("hex");
	return { path: dest, sizeBytes: statSync(dest).size, sha256: sha };
}

/** Mount a DMG, copy the .app out, unmount. Idempotent at the app level. */
export function installDmg(dmgPath, appName, { log = () => undefined } = {}) {
	const plist = run("/usr/bin/hdiutil", [
		"attach",
		dmgPath,
		"-nobrowse",
		"-noverify",
		"-noautoopen",
		"-plist",
	]);
	const mountPoint = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
	if (!mountPoint) throw new Error(`could not determine mount point for ${dmgPath}`);

	try {
		const src = join(mountPoint, appName);
		if (!existsSync(src)) {
			const contents = run("/bin/ls", ["-1", mountPoint]).trim().split("\n");
			throw new Error(
				`"${appName}" not found on the mounted image. Contents: ${contents.join(", ")}`,
			);
		}
		const dest = join(APPLICATIONS, appName);
		if (existsSync(dest)) {
			log(`  replacing existing ${appName}`);
			rmSync(dest, { recursive: true, force: true });
		}
		log(`  copying ${appName} → ${APPLICATIONS}`);
		cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
		return dest;
	} finally {
		try {
			run("/usr/bin/hdiutil", ["detach", mountPoint, "-quiet"]);
		} catch {
			run("/usr/bin/hdiutil", ["detach", mountPoint, "-force", "-quiet"]);
		}
	}
}

/**
 * Install one app from its registry spec. Returns a record detailed enough that another
 * machine can be checked against it — the whole point of pinning versions and hashes.
 */
export function installApp(spec, { cacheDir, force = false, log = () => undefined } = {}) {
	const destApp = join(APPLICATIONS, spec.appName);
	if (existsSync(destApp) && !force) {
		return {
			id: spec.id,
			status: "already-installed",
			appPath: destApp,
			version: appVersion(destApp),
			codesign: codesignStatus(destApp),
		};
	}

	let url = spec.url;
	let pinnedVersion = spec.version ?? null;
	if (spec.method === "github-release") {
		const asset = resolveGithubAsset(spec.repo, spec.assetPattern);
		url = asset.url;
		pinnedVersion = asset.version;
		log(`  resolved ${spec.repo} → ${asset.version} (${asset.name})`);
	}

	const dl = download(url, cacheDir, { log });
	if (!/\.dmg$/i.test(dl.path)) {
		throw new Error(`only .dmg installs are automated; got ${basename(dl.path)}`);
	}
	const appPath = installDmg(dl.path, spec.appName, { log });

	return {
		id: spec.id,
		status: "installed",
		appPath,
		version: appVersion(appPath),
		pinnedVersion,
		sourceUrl: url,
		downloadSha256: dl.sha256,
		downloadBytes: dl.sizeBytes,
		codesign: codesignStatus(appPath),
	};
}
