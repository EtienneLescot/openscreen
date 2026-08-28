/** ScreenCaptureKit recording in OpenScreen is built with a macOS 13 deployment target. */
export function isNativeMacCaptureOsSupported(platform: NodeJS.Platform, version: string) {
	if (platform !== "darwin" || !/^\d+(?:\.\d+)*$/.test(version)) {
		return false;
	}

	return Number(version.split(".")[0]) >= 13;
}

/** Resolve the native helper only on macOS versions that can execute it. */
export async function resolveNativeMacCaptureHelper(
	platform: NodeJS.Platform,
	version: string,
	findHelper: () => Promise<string | null>,
) {
	if (platform !== "darwin") {
		return { available: false as const, reason: "unsupported-platform" as const };
	}
	if (!isNativeMacCaptureOsSupported(platform, version)) {
		return { available: false as const, reason: "unsupported-os" as const };
	}

	const helperPath = await findHelper();
	return helperPath
		? { available: true as const, helperPath }
		: { available: false as const, reason: "missing-helper" as const };
}
