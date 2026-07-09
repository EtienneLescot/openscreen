import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
	mainSidebar: [
		{
			type: "category",
			label: "Getting Started",
			collapsible: false,
			items: ["intro", "installation", "quick-start"],
		},
		{
			type: "category",
			label: "Features",
			collapsible: false,
			items: ["recording", "editing-timeline", "captions", "export"],
		},
		{
			type: "category",
			label: "Community",
			collapsible: false,
			items: [
				{
					type: "link",
					label: "Contributing",
					href: "https://github.com/getopenscreen/openscreen/blob/main/CONTRIBUTING.md",
				},
				{
					type: "link",
					label: "Roadmap",
					href: "https://github.com/getopenscreen/openscreen/blob/main/ROADMAP.md",
				},
			],
		},
	],
};

export default sidebars;
