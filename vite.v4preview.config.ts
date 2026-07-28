import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Browser-only preview of the renderer (no Electron plugin) so the v4 editor
// shell can be opened in a plain browser for design QA. The app installs
// browser shims (src/native/browserShim.ts) so the stores work without the
// Electron bridge. Serve: vite --config vite.v4preview.config.ts (port 5199).
export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	server: {
		port: 5207,
		strictPort: true,
	},
});
