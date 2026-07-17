import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * POST /save?name=x → poc/out/x.
 *
 * The output has to be watchable on disk, not just a blob URL that dies with the
 * tab. Dev-only, and it writes exactly one directory.
 */
const save = {
	name: "poc-save",
	configureServer(server) {
		server.middlewares.use("/save", (req, res) => {
			const name = new URL(req.url, "http://x").searchParams.get("name") ?? "out.bin";
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const body = Buffer.concat(chunks);
				const dir = join(here, "out");
				mkdirSync(dir, { recursive: true });
				const file = join(dir, name.replace(/[^\w.-]/g, "_"));
				writeFileSync(file, body);
				console.log(`[poc] wrote ${file} (${body.length} bytes)`);
				res.end(file);
			});
		});
	},
};

// The POC serves itself. Nothing here knows about the app: no aliases, no
// electron plugin, no shared config — the isolation is the point.
export default {
	root: here,
	plugins: [save],
	server: { port: 5210, strictPort: true },
};
