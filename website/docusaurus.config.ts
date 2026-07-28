import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

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

export default async function createConfig(): Promise<Config> {
	const starCount = await fetchStarCount();
	const starBadge =
		starCount !== null
			? `<span class="navbar-github-stars">${STAR_SVG}${formatStarCount(starCount)}</span>`
			: "";

	return {
		title: "OpenScreen",
		tagline: "A free, open-source screen recorder and editor.",
		favicon: "img/logo-icon.png",

		url: "https://getopenscreen.github.io",
		baseUrl: "/openscreen/",

		organizationName: "getopenscreen",
		projectName: "openscreen",

		onBrokenLinks: "throw",

		markdown: {
			hooks: {
				onBrokenMarkdownLinks: "warn",
			},
		},

		presets: [
			[
				"@docusaurus/preset-classic",
				{
					docs: {
						sidebarPath: "./sidebars.ts",
						editUrl: "https://github.com/getopenscreen/openscreen/tree/main/website/",
					},
					blog: false,
					theme: {
						customCss: "./src/css/custom.css",
					},
				} satisfies Preset.Options,
			],
		],

		themeConfig: {
			image: "img/logo-icon.png",
			colorMode: {
				defaultMode: "dark",
				disableSwitch: false,
				respectPrefersColorScheme: false,
			},
			navbar: {
				title: "OpenScreen",
				logo: {
					alt: "OpenScreen",
					src: "img/logo-icon.png",
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
						href: "https://github.com/getopenscreen/openscreen/blob/main/ROADMAP.md",
						label: "Roadmap",
						position: "left",
					},
					{
						href: "https://discord.gg/VvT6Vtnyh",
						label: "Discord",
						position: "left",
					},
					{
						type: "html",
						position: "right",
						value:
							'<a class="navbar-github-link" href="https://github.com/getopenscreen/openscreen" target="_blank" rel="noopener noreferrer">' +
							'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>' +
							`GitHub${starBadge}</a>`,
					},
					{
						type: "html",
						position: "right",
						value:
							'<a class="navbar-download-cta" href="https://github.com/getopenscreen/openscreen/releases" target="_blank" rel="noopener noreferrer">' +
							'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>' +
							"Download</a>",
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
