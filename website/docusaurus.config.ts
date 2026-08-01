import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

import type { LatestRelease } from "./src/lib/release";

const SITE_URL = "https://getopenscreen.com";
const REPO_SLUG = "getopenscreen/openscreen";
const REPO_URL = `https://github.com/${REPO_SLUG}`;
const UPSTREAM_REPO_URL = "https://github.com/siddharthvaddem/openscreen";
const DISCORD_URL = "https://discord.gg/VvT6Vtnyh";

// Kept under ~155 characters: past that, Google truncates the snippet mid-word.
const SITE_DESCRIPTION =
	"Free, open-source screen recorder and video editor for Windows, macOS, and Linux. Native capture, on-device captions, no watermarks, no subscriptions.";

// Site-wide structured data. Organization + WebSite are true of every page, so
// they belong here; the SoftwareApplication entity describes the product rather
// than the site and lives in src/lib/structured-data.ts, emitted only by the two
// pages that are about the product (the landing page and /download), because
// repeating it under every docs URL is what earns a manual action.
const ORGANIZATION_LD = {
	"@context": "https://schema.org",
	"@type": "Organization",
	"@id": `${SITE_URL}/#organization`,
	name: "OpenScreen",
	url: SITE_URL,
	logo: `${SITE_URL}/img/logo-icon.png`,
	description: SITE_DESCRIPTION,
	sameAs: [REPO_URL, UPSTREAM_REPO_URL, DISCORD_URL],
};

const WEBSITE_LD = {
	"@context": "https://schema.org",
	"@type": "WebSite",
	"@id": `${SITE_URL}/#website`,
	name: "OpenScreen",
	url: SITE_URL,
	description: SITE_DESCRIPTION,
	inLanguage: "en",
	publisher: { "@id": `${SITE_URL}/#organization` },
};

const STAR_SVG =
	'<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>';

function formatStarCount(count: number): string {
	if (count < 1000) return String(count);
	return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

// GitHub's own embeddable widgets (the buttons.github.io <a class="github-button">
// script, or a shields.io <img> badge) are live but render as an iframe / raster
// image neither of which can match the design's inline text+icon pixel spec. This
// fetches the real count once at build time instead, so the number stays live
// across deploys without faking data or fighting a third-party widget's styling.
async function fetchStarCount(): Promise<number | null> {
	try {
		const res = await fetch("https://api.github.com/repos/getopenscreen/openscreen", {
			headers: { Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { stargazers_count?: unknown };
		return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
	} catch {
		return null;
	}
}

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/**
 * The published assets for the current stable release, resolved at build time
 * so /download can link each platform to its actual file instead of bouncing
 * everyone through the releases list.
 *
 * This is only safe because .github/workflows/docs.yml also rebuilds on
 * `release: published`. Without that trigger the data would go stale silently —
 * the workflow otherwise only fires on website/** changes, so shipping a new
 * version would leave this page advertising the previous one indefinitely.
 *
 * Returns null on any failure (the API is called unauthenticated, so a
 * rate-limited runner is a real possibility); the page falls back to
 * /releases/latest links, which are always correct.
 */
async function fetchLatestRelease(): Promise<LatestRelease> {
	try {
		const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`, {
			headers: { Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as {
			tag_name?: unknown;
			published_at?: unknown;
			assets?: unknown;
		};
		if (typeof data.tag_name !== "string" || !Array.isArray(data.assets)) return null;

		const assets = data.assets.flatMap((raw) => {
			const a = raw as { name?: unknown; browser_download_url?: unknown; size?: unknown };
			if (typeof a.name !== "string" || typeof a.browser_download_url !== "string") return [];
			return [{ name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 }];
		});
		if (assets.length === 0) return null;

		// Formatted here rather than in the component: toLocaleDateString would
		// resolve against the visitor's locale and time zone on hydration and
		// mismatch the server-rendered string.
		let published = "";
		let publishedIso = "";
		if (typeof data.published_at === "string") {
			const [y, m, d] = data.published_at.slice(0, 10).split("-");
			if (y && m && d) {
				published = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
				// Kept alongside the display string for /download's structured
				// data, which needs schema.org's Date form rather than prose.
				publishedIso = `${y}-${m}-${d}`;
			}
		}

		return { tag: data.tag_name, published, publishedIso, assets };
	} catch {
		return null;
	}
}

export default async function createConfig(): Promise<Config> {
	const [starCount, latestRelease] = await Promise.all([fetchStarCount(), fetchLatestRelease()]);
	const starBadge =
		starCount !== null
			? `<span class="navbar-github-stars">${STAR_SVG}${formatStarCount(starCount)}</span>`
			: "";

	return {
		title: "OpenScreen",
		tagline: "A free, open-source screen recorder and editor.",
		favicon: "img/logo-icon.png",

		// Pages serves this from the custom domain's root, not from
		// getopenscreen.github.io/openscreen/, so baseUrl has to be "/" — a project
		// baseUrl would prefix every asset URL with a path the server has nothing at.
		url: SITE_URL,
		baseUrl: "/",

		// Every page is emitted as <route>/index.html, and GitHub Pages 301s the
		// extensionless form to the trailing-slash one. Leaving this unset makes
		// Docusaurus advertise the pre-redirect URL in both <link rel="canonical">
		// and sitemap.xml, so every indexed URL costs a crawler an extra hop to a
		// URL that isn't the one we declared canonical. Declaring the served form
		// removes the redirect from the canonical path entirely.
		trailingSlash: true,

		organizationName: "getopenscreen",
		projectName: "openscreen",

		// Read back by src/pages/download.tsx. Serialized into the client bundle,
		// so it stays plain JSON.
		customFields: { latestRelease },

		onBrokenLinks: "throw",
		onBrokenAnchors: "throw",

		markdown: {
			hooks: {
				onBrokenMarkdownLinks: "warn",
			},
		},

		headTags: [
			{
				tagName: "link",
				attributes: {
					rel: "apple-touch-icon",
					sizes: "180x180",
					href: "/img/apple-touch-icon.png",
				},
			},
			{
				tagName: "script",
				attributes: { type: "application/ld+json" },
				innerHTML: JSON.stringify(ORGANIZATION_LD),
			},
			{
				tagName: "script",
				attributes: { type: "application/ld+json" },
				innerHTML: JSON.stringify(WEBSITE_LD),
			},
		],

		presets: [
			[
				"@docusaurus/preset-classic",
				{
					docs: {
						sidebarPath: "./sidebars.ts",
						editUrl: `${REPO_URL}/tree/main/website/`,
					},
					blog: false,
					theme: {
						customCss: "./src/css/custom.css",
					},
					sitemap: {
						// Off by default in Docusaurus 3. Sourced from git history, it
						// gives crawlers a real freshness signal per URL instead of one
						// undated blob that has to be re-fetched to find out what moved.
						lastmod: "date",
						changefreq: "weekly",
						priority: 0.5,
						createSitemapItems: async ({ defaultCreateSitemapItems, ...rest }) => {
							const items = await defaultCreateSitemapItems(rest);
							// Flat 0.5 everywhere tells a crawler nothing. The landing page
							// and the docs entry point are the two URLs worth ranking.
							return items.map((item) => {
								if (item.url === `${SITE_URL}/`) return { ...item, priority: 1.0 };
								if (item.url === `${SITE_URL}/docs/intro/`) return { ...item, priority: 0.8 };
								return { ...item, priority: 0.7 };
							});
						},
					},
				} satisfies Preset.Options,
			],
		],

		themeConfig: {
			// 1200x630, fully opaque. Docusaurus hardcodes twitter:card as
			// summary_large_image, which crops to 1.91:1 — the old square app icon was
			// letterboxed or cropped by every client. Opaque also still matters: an
			// og:image with alpha gets composited on whatever background the platform
			// picks, so a transparent mark turns into a green smear on some clients.
			image: "img/og-image.png",
			// Docusaurus emits og:title/description/url/image and twitter:card on its
			// own, but never og:type or og:site_name — without them Facebook and
			// LinkedIn fall back to a bare link preview. The robots directives lift
			// Google's default 160-char snippet cap and thumbnail size limit.
			metadata: [
				{ name: "description", content: SITE_DESCRIPTION },
				{
					name: "keywords",
					content:
						"screen recorder, open source screen recorder, free screen recorder, video editor, screen recording software, screen capture, Windows, macOS, Linux, Screen Studio alternative, automatic captions, subtitles, Whisper, MIT license",
				},
				{ name: "robots", content: "index, follow, max-image-preview:large, max-snippet:-1" },
				{ property: "og:type", content: "website" },
				{ property: "og:site_name", content: "OpenScreen" },
				{ name: "twitter:image:alt", content: "OpenScreen — free, open-source screen recorder" },
			],
			colorMode: {
				defaultMode: "dark",
				disableSwitch: false,
				respectPrefersColorScheme: false,
			},
			navbar: {
				title: "OpenScreen",
				logo: {
					// Explicit intrinsic size: without it the navbar reserves no space
					// for the mark and the whole bar reflows once the PNG decodes.
					alt: "OpenScreen logo",
					src: "img/logo-icon.png",
					width: 32,
					height: 32,
				},
				items: [
					{
						type: "docSidebar",
						sidebarId: "mainSidebar",
						position: "left",
						label: "Docs",
						className: "navbar-link-strong",
					},
					{
						href: `${REPO_URL}/blob/main/ROADMAP.md`,
						label: "Roadmap",
						position: "left",
					},
					{
						href: DISCORD_URL,
						label: "Discord",
						position: "left",
					},
					{
						type: "html",
						position: "right",
						value:
							`<a class="navbar-github-link" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">` +
							'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>' +
							`GitHub${starBadge}</a>`,
					},
					{
						// Points at our own page now, not straight out to Releases, which
						// means it can be a real router link: SPA navigation plus route
						// prefetch, neither of which a raw <a> in an html item gets. A
						// link item only takes a string label, so the download glyph moves
						// to a CSS mask on .navbar-download-cta.
						to: "/download",
						label: "Download",
						className: "navbar-download-cta",
						position: "right",
					},
				],
			},
			prism: {
				theme: prismThemes.github,
				darkTheme: prismThemes.dracula,
			},
		} satisfies Preset.ThemeConfig,
	};
}
