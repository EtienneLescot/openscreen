import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

// PR #1 ships only the intro page. The full docs migration
// (architecture/, engineering/, testing/, project/) lands in PR #3.
const sidebars: SidebarsConfig = {
	mainSidebar: ["intro"],
};

export default sidebars;
