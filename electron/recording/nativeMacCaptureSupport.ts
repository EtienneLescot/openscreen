/** ScreenCaptureKit recording in OpenScreen is built with a macOS 13 deployment target. */
export function isNativeMacCaptureOsSupported(platform: NodeJS.Platform, version: string) {
	if (platform !== "darwin") {
		return false;
	}

	const major = Number.parseInt(version.split(".")[0] ?? "", 10);
	return Number.isFinite(major) && major >= 13;
}
