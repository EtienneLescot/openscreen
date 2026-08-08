/**
 * Shape of the build-time GitHub release lookup, shared between the config that
 * fetches it (docusaurus.config.ts) and the page that renders it
 * (src/pages/download.tsx), which reads it back off siteConfig.customFields.
 */

export type ReleaseAsset = {
	name: string;
	url: string;
	size: number;
};

/** null whenever the build-time lookup failed; callers must handle it. */
export type LatestRelease = {
	tag: string;
	/** Pre-formatted at build time, e.g. "19 July 2026". Empty if unknown. */
	published: string;
	/** The same date as YYYY-MM-DD, for structured data. Empty if unknown. */
	publishedIso: string;
	assets: ReleaseAsset[];
} | null;

/**
 * Asset filenames carry the version (Openscreen-Mac-arm64-1.7.0.dmg), so these
 * match on the stable parts only — platform, arch, and extension — and keep
 * working across releases without a config change.
 */
export const ASSET_PATTERNS = {
	macArm: /Mac.*arm64.*\.dmg$/i,
	macIntel: /Mac.*x64.*\.dmg$/i,
	windows: /\.exe$/i,
	deb: /\.deb$/i,
	rpm: /\.rpm$/i,
	pacman: /\.pacman$/i,
	appImage: /\.AppImage$/i,
} as const;

export type AssetKind = keyof typeof ASSET_PATTERNS;

export function findAsset(release: LatestRelease, kind: AssetKind): ReleaseAsset | null {
	return release?.assets.find((a) => ASSET_PATTERNS[kind].test(a.name)) ?? null;
}

export function formatSize(bytes: number): string {
	if (!bytes) return "";
	return `${Math.round(bytes / 1048576)} MB`;
}
