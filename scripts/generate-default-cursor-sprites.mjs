// Rasterizes the built-in cursor SVG set (src/assets/cursors/) into
// public/cursors/default/<type>.png.
//
// Why files at all: the native compositor decodes with the `image` crate (png/jpeg
// only) from a real path outside app.asar — it cannot read the SVGs, which exist only
// as Vite-bundled URLs in the renderer. Without a PNG set the native path has no
// default art and falls back to a math dot+ring, which is not what the OS cursor
// looks like.
//
// The PNGs are cropped to the art's alpha bounds. The sweezy theme packs fill their
// 128x128 box edge to edge, while the built-in SVGs sit in the middle of a 32-unit
// canvas using only ~55% of it — uncropped, every built-in cursor would render about
// half the size of a themed one at the same size slider. Cropping puts both on the
// same footing, and the hotspot is recomputed into the cropped image as a 0..1
// fraction, which is what the scene contract carries.
//
// Run: node scripts/generate-default-cursor-sprites.mjs
// Then paste the printed table into DEFAULT_CURSOR_SPRITES in src/lib/cursor/cursorThemes.ts.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "src", "assets", "cursors");
const OUT_DIR = path.join(ROOT, "public", "cursors", "default");
const OUT_SIZE = 128;

/**
 * cursorType -> { file, hotspotX, hotspotY } in the 32-logical reference.
 * Hotspots are copied from PRETTY_NATIVE_CURSOR_ASSETS in src/lib/cursor/nativeCursor.ts,
 * which is the live web renderer's table and stays the source of truth; this generator
 * only re-expresses them for the native path.
 */
const SPRITES = {
	arrow: { file: "Cursor=Default.svg", hotspotX: 16.25, hotspotY: 15.03 },
	text: { file: "Cursor=Text-Cursor.svg", hotspotX: 16, hotspotY: 16 },
	pointer: { file: "Cursor=Hand-(Pointing).svg", hotspotX: 16.65, hotspotY: 14.24 },
	crosshair: { file: "Cursor=Cross.svg", hotspotX: 16, hotspotY: 16 },
	"open-hand": { file: "Cursor=Hand-(Open).svg", hotspotX: 16, hotspotY: 9 },
	// The grabbing fist is drawn lower and shorter than the open hand: y=9 (what the table
	// carried, copied from open-hand) lands above the art entirely. Centred on the fist.
	"closed-hand": { file: "Cursor=Hand-(Grabbing).svg", hotspotX: 16, hotspotY: 17 },
	"resize-ew": { file: "Cursor=Resize-West-East.svg", hotspotX: 16, hotspotY: 16 },
	"resize-ns": { file: "Cursor=Resize-North-South.svg", hotspotX: 16, hotspotY: 16 },
	"resize-nesw": { file: "Cursor=Resize-North-East-South-West.svg", hotspotX: 16, hotspotY: 16 },
	"resize-nwse": { file: "Cursor=Resize-North-West-South-East.svg", hotspotX: 16, hotspotY: 16 },
	move: { file: "Cursor=Move.svg", hotspotX: 16, hotspotY: 16 },
	"not-allowed": { file: "Cursor=Not-Allowed.svg", hotspotX: 16, hotspotY: 16 },
	wait: { file: "Cursor=Wait.svg", hotspotX: 16, hotspotY: 16 },
	"app-starting": { file: "Cursor=App-Starting.svg", hotspotX: 7.25, hotspotY: 4.03 },
	help: { file: "Cursor=Help.svg", hotspotX: 7.25, hotspotY: 4.03 },
	"up-arrow": { file: "Cursor=Up-Arrow.svg", hotspotX: 16, hotspotY: 3 },
};

/**
 * Renders an SVG into an OUT_SIZE square, crops to the art's alpha bounds, and maps the
 * 32-reference hotspot into the cropped image as a 0..1 fraction.
 */
async function rasterize(page, svgText, hotspot) {
	return page.evaluate(
		async ([svg, size, hs]) => {
			const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
			const img = new Image();
			await new Promise((resolve, reject) => {
				img.onload = resolve;
				img.onerror = () => reject(new Error("svg decode failed"));
				img.src = url;
			});
			const canvas = document.createElement("canvas");
			canvas.width = size;
			canvas.height = size;
			const ctx = canvas.getContext("2d");
			// The viewBox may not be square (the pointing hand is 32x33): fit its longest
			// side to the box so `scale` maps the whole SVG user space uniformly.
			const scale = size / Math.max(img.naturalWidth, img.naturalHeight);
			ctx.drawImage(img, 0, 0, img.naturalWidth * scale, img.naturalHeight * scale);

			const { data } = ctx.getImageData(0, 0, size, size);
			let minX = size;
			let minY = size;
			let maxX = -1;
			let maxY = -1;
			for (let y = 0; y < size; y += 1) {
				for (let x = 0; x < size; x += 1) {
					if (data[(y * size + x) * 4 + 3] > 8) {
						if (x < minX) minX = x;
						if (y < minY) minY = y;
						if (x > maxX) maxX = x;
						if (y > maxY) maxY = y;
					}
				}
			}
			const bbox = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };

			const cropped = document.createElement("canvas");
			cropped.width = bbox.width;
			cropped.height = bbox.height;
			cropped
				.getContext("2d")
				.drawImage(canvas, bbox.x, bbox.y, bbox.width, bbox.height, 0, 0, bbox.width, bbox.height);

			return {
				dataUrl: cropped.toDataURL("image/png"),
				bbox,
				// SVG user units -> rendered px -> cropped px -> fraction of the cropped image.
				hotspot: {
					x: (hs[0] * scale - bbox.x) / bbox.width,
					y: (hs[1] * scale - bbox.y) / bbox.height,
				},
			};
		},
		[svgText, OUT_SIZE, hotspot],
	);
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");
await mkdir(OUT_DIR, { recursive: true });

const rows = [];
for (const [type, spec] of Object.entries(SPRITES)) {
	const svg = await readFile(path.join(SRC_DIR, spec.file), "utf8");
	const { dataUrl, bbox, hotspot } = await rasterize(page, svg, [spec.hotspotX, spec.hotspotY]);
	await writeFile(
		path.join(OUT_DIR, `${type}.png`),
		Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"),
	);
	if (hotspot.x < 0 || hotspot.x > 1 || hotspot.y < 0 || hotspot.y > 1) {
		console.warn(`  !! ${type}: hotspot falls outside the art (${hotspot.x}, ${hotspot.y})`);
	}
	rows.push({ type, bbox, hotspot });
}

await browser.close();

console.log(`Wrote ${rows.length} sprites to ${path.relative(ROOT, OUT_DIR)}\n`);
console.log("// generated by scripts/generate-default-cursor-sprites.mjs");
for (const { type, bbox, hotspot } of rows) {
	const key = /^[a-z]+$/.test(type) ? type : `"${type}"`;
	console.log(
		`\t${key}: { assetPath: "cursors/default/${type}.png", ` +
			`hotspotX: ${hotspot.x.toFixed(4)}, hotspotY: ${hotspot.y.toFixed(4)} }, // ${bbox.width}x${bbox.height}`,
	);
}
