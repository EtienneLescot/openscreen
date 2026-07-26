// Shared MSVC bootstrap for the two Windows native build scripts
// (build-windows-wgc-helper.mjs and build-windows-compositor-addon.mjs).
// Both need the same vcvarsall.bat discovery; their runInVsEnv bodies differ
// (SDK lib compat shims vs cargo) and stay in their own scripts.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function findVcVarsAll() {
	const explicit = process.env.VCVARSALL;
	if (explicit && fs.existsSync(explicit)) {
		return explicit;
	}

	const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
	if (fs.existsSync(vswhere)) {
		const result = spawnSync(
			vswhere,
			[
				"-latest",
				"-products",
				"*",
				"-requires",
				"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
				"-property",
				"installationPath",
			],
			{ encoding: "utf8", windowsHide: true },
		);
		const installPath = result.stdout?.trim();
		if (result.status === 0 && installPath) {
			const candidate = path.join(installPath, "VC", "Auxiliary", "Build", "vcvarsall.bat");
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}

	if (process.env.VSINSTALLDIR) {
		const candidate = path.join(
			process.env.VSINSTALLDIR,
			"VC",
			"Auxiliary",
			"Build",
			"vcvarsall.bat",
		);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	// vswhere doesn't always enumerate pre-release channels (e.g. "Insiders"
	// builds), and the on-disk layout for those isn't a stable "<year>\<edition>"
	// path -- Visual Studio 2026 Insiders installs under a numeric product
	// version folder like "18\Insiders\<edition>" instead of "2026\<edition>".
	// Walk the install roots generically instead of hard-coding version/channel
	// names so new VS releases and preview channels are found automatically.
	const editions = ["Community", "Professional", "Enterprise", "BuildTools"];
	const installRoots = [
		"C:\\Program Files\\Microsoft Visual Studio",
		"C:\\Program Files (x86)\\Microsoft Visual Studio",
	];

	const listDirs = (dir) => {
		try {
			return fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => path.join(dir, entry.name));
		} catch {
			return [];
		}
	};

	for (const installRoot of installRoots) {
		for (const versionDir of listDirs(installRoot)) {
			// versionDir is either an edition directly ("2022\Community") or a
			// channel that nests editions ("18\Insiders\Community").
			for (const channelDir of [versionDir, ...listDirs(versionDir)]) {
				const direct = path.join(channelDir, "VC", "Auxiliary", "Build", "vcvarsall.bat");
				if (fs.existsSync(direct)) {
					return direct;
				}
				for (const edition of editions) {
					const nested = path.join(
						channelDir,
						edition,
						"VC",
						"Auxiliary",
						"Build",
						"vcvarsall.bat",
					);
					if (fs.existsSync(nested)) {
						return nested;
					}
				}
			}
		}
	}

	return null;
}

/** spawn() as a promise. Callers pass their own cwd. */
export function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "inherit",
			windowsHide: true,
			...options,
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
			}
		});
	});
}
