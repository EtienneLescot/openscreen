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
import { IS_WIN, appVersion as platformVersion, powershell, signatureStatus } from "./platform.mjs";

const APPLICATIONS = "/Applications";

const run = (bin, args, opts = {}) =>
	execFileSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...opts });

export const appVersion = platformVersion;

/** Signing / notarisation status, recorded so the report can say what was actually run. */
export const codesignStatus = signatureStatus;

/** Resolve a GitHub release asset to a concrete URL, so the install is version-pinned. */
export function resolveGithubAsset(repo, pattern) {
	const json = run(IS_WIN ? "curl.exe" : "/usr/bin/curl", [
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

/**
 * Run a Windows installer unattended.
 *
 * Both vendors in the Windows set ship NSIS packages, where `/S` is the silent switch; an MSI
 * would need `msiexec /qn` instead. If an installer rejects its silent switch it will sit on a
 * dialog forever, so this is bounded and reports what it left behind rather than hanging a run.
 */
function runWindowsInstaller(installerPath, spec, { log = () => undefined }) {
	const args = spec.silentArgs ?? ["/S"];
	log(`  running ${basename(installerPath)} ${args.join(" ")}`);
	powershell(
		`$p = Start-Process -FilePath ${JSON.stringify(installerPath)} -ArgumentList @(${args
			.map((a) => `'${a}'`)
			.join(",")}) -PassThru -Wait
		 exit $p.ExitCode`,
		{ timeoutMs: 20 * 60 * 1000 },
	);
}

/** Resumable download. A 400 MB DMG over a flaky link should not restart from zero. */
export function download(url, destDir, { log = () => undefined } = {}) {
	mkdirSync(destDir, { recursive: true });
	// The vendor URL is often a redirect; ask curl for the effective name it lands on.
	const curl = IS_WIN ? "curl.exe" : "/usr/bin/curl";
	const nul = IS_WIN ? "NUL" : "/dev/null";
	const effective = run(curl, [
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
	if (!/\.(dmg|zip|pkg|exe|msi)$/i.test(name))
		name = `${name || "download"}${IS_WIN ? ".exe" : ".dmg"}`;
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
	// On Windows an app is wherever its installer put it, so the driver resolves it; on macOS
	// it is always /Applications/<Name>.app.
	const destApp = IS_WIN ? (spec.resolve?.() ?? null) : join(APPLICATIONS, spec.appName);
	if (destApp && existsSync(destApp) && !force) {
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

	let appPath;
	if (IS_WIN) {
		if (!/\.(exe|msi)$/i.test(dl.path)) {
			throw new Error(`expected an .exe or .msi installer; got ${basename(dl.path)}`);
		}
		runWindowsInstaller(dl.path, spec, { log });
		appPath = spec.resolve ? spec.resolve() : null;
		if (!appPath) {
			throw new Error(
				`${spec.appName} installed but its executable was not found where expected. ` +
					"Add the real path to the driver's winPaths list.",
			);
		}
	} else {
		if (!/\.dmg$/i.test(dl.path)) {
			throw new Error(`only .dmg installs are automated on macOS; got ${basename(dl.path)}`);
		}
		appPath = installDmg(dl.path, spec.appName, { log });
	}

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
