import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

const config: Config = {
	title: "OpenScreen",
	tagline: "A free, open-source screen recorder and editor.",
	favicon: "img/logo.svg",

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
			} satisfies Preset.Options,
		],
	],

	themeConfig: {
		image: "img/logo.svg",
		colorMode: {
			defaultMode: "light",
			disableSwitch: false,
			respectPrefersColorScheme: true,
		},
		navbar: {
			title: "OpenScreen",
			logo: {
				alt: "OpenScreen",
				src: "img/logo.svg",
			},
			items: [
				{
					type: "docSidebar",
					sidebarId: "mainSidebar",
					position: "left",
					label: "Docs",
				},
				{
					href: "https://github.com/getopenscreen/openscreen",
					label: "GitHub",
					position: "right",
				},
			],
		},
		footer: {
			style: "dark",
			links: [
				{
					title: "Project",
					items: [
						{
							label: "GitHub",
							href: "https://github.com/getopenscreen/openscreen",
						},
						{
							label: "Releases",
							href: "https://github.com/getopenscreen/openscreen/releases",
						},
					],
				},
				{
					title: "Docs",
					items: [
						{
							label: "Introduction",
							to: "/",
						},
					],
				},
				{
					title: "Community",
					items: [
						{
							label: "Contributing",
							href: "https://github.com/getopenscreen/openscreen/blob/main/CONTRIBUTING.md",
						},
						{
							label: "License (MIT)",
							href: "https://github.com/getopenscreen/openscreen/blob/main/LICENSE",
						},
					],
				},
			],
			copyright:
				"OpenScreen is released under the MIT license. Built by the community — free, forever.",
		},
		prism: {
			theme: prismThemes.github,
			darkTheme: prismThemes.dracula,
		},
	} satisfies Preset.ThemeConfig,
};

export default config;
