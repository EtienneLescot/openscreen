// What the About box says, kept out of the dialog that shows it. Every fact is passed in
// rather than read from `app`/`process`, so the string can be pinned in a test from any
// platform — the same reason install-channel.ts takes an `InstallProbe`.
//
// The install channel is in there deliberately: it is the single fact that explains why a
// copy does or does not offer "Check for Updates" (see install-channel.ts), and the first
// thing worth knowing about a bug report from a build we did not install ourselves.

import type { InstallChannel } from "./install-channel";

export const WEBSITE_URL = "https://getopenscreen.com";
/** The brand spelling, for the surfaces we render ourselves. NOT `app.name`: that resolves to
 *  electron-builder's `productName` ("Openscreen") when packaged and to package.json's `name`
 *  ("openscreen") in dev, so the About box would disagree with its own title bar. */
export const PRODUCT_NAME = "OpenScreen";
/** Must name the holder in LICENSE. electron-builder derives Info.plist's
 *  NSHumanReadableCopyright and the Windows LegalCopyright from package.json's `author`, so a
 *  third spelling here would put three attributions on one binary. */
export const COPYRIGHT = "© 2025 Siddharth Vaddem — MIT License";

/** macOS opens its own About panel (the app menu's `role: "about"`), so it is the one platform
 *  that must not be shown the message box we build, and the only one whose panel needs
 *  populating up front. Pure so both branches can be pinned from a Linux-only CI. */
export function usesNativeAboutPanel(platform: NodeJS.Platform): boolean {
	return platform === "darwin";
}

export interface AboutFacts {
	version: string;
	channel: InstallChannel;
	platform: NodeJS.Platform;
	arch: string;
	electron: string;
	chrome: string;
	node: string;
}

/** The block under "Openscreen <version>". Untranslated on purpose: every line is a version
 *  number, a platform identifier or a URL, and a pasted bug report reads the same whatever
 *  locale the reporter runs.
 *
 *  `COPYRIGHT` is deliberately NOT part of it: the macOS About panel has its own field for
 *  that line, and putting it here too would print it twice on the one platform that asked
 *  for it separately. The surface that shows the box adds it. */
export function formatAboutDetail(facts: AboutFacts): string {
	return [
		`Electron ${facts.electron} · Chromium ${facts.chrome} · Node ${facts.node}`,
		`${facts.platform} ${facts.arch} · ${facts.channel}`,
		WEBSITE_URL,
	].join("\n");
}
