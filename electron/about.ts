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
/** The collective form, and deliberately NOT the whole of LICENSE. LICENSE carries two holders:
 *  Siddharth Vaddem, who created the project — MIT obliges us to keep that notice on a codebase
 *  that still contains his code — and the contributors collectively. This is the line every user
 *  sees, so it names the group that maintains the app rather than one person who no longer does.
 *
 *  "contributors" and not "OpenScreen": getopenscreen is a GitHub organisation, not a legal
 *  entity, and copyright cannot vest in something that does not exist. Each author keeps their
 *  own; this is shorthand for all of them.
 *
 *  Must stay byte-identical to `copyright` in electron-builder.json5, which feeds Info.plist's
 *  NSHumanReadableCopyright and the Windows LegalCopyright. That key is declared explicitly
 *  BECAUSE electron-builder otherwise derives those from package.json's `author` — a single
 *  name, which put a second attribution on the same binary this string appears in. */
export const COPYRIGHT = "© 2025-2026 OpenScreen contributors — MIT License";

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
