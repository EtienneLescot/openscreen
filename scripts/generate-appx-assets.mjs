// Generates the Microsoft Store (AppX/MSIX) tile assets into build/appx/.
//
// Why this exists: electron-builder only ships BRANDED tiles if it finds them in
// `<buildResources>/appx/` (AppXTarget.computeUserAssets -> packager.getResource(undefined, "appx")).
// With that directory missing it silently falls back to its vendored placeholders
// — SampleAppx.50x50.png, SampleAppx.150x150.png, SampleAppx.44x44.png,
// SampleAppx.310x150.png — and ships an Electron-generic tile. That is exactly what
// Store certification rejected under 10.1.1.11 "On Device Tiles":
//   "The available product tile icons include a default image."
// So build/appx/ is committed to the repo; this script only regenerates it when the
// app icon changes. No build step depends on it.
//
// Why hand-rolled PNG I/O: the project has no image library in its dependency tree
// (no sharp, no jimp), and adding one — with prebuilt native binaries — to draw seven
// static logos would cost far more than the ~150 lines below. Node's zlib does the
// only hard part.
//
// Layout follows Microsoft's tile guidance: the icon sits on a TRANSPARENT canvas with
// padding rather than bleeding to the edges, because `appx.backgroundColor` is
// "transparent" in electron-builder.json5, so Windows paints the tile in the user's
// accent colour behind these assets. The small assets (store logo, 44x44 app-list icon)
// are full-bleed instead: Windows plates and crops those itself.
//
// Run: node scripts/generate-appx-assets.mjs
// Verify: the generated names must keep matching electron-builder's expectations —
// StoreLogo / Square150x150Logo / Square44x44Logo / Wide310x150Logo are the four it
// substitutes placeholders for, and SmallTile / LargeTile / SplashScreen are opt-in
// (their <uap:> manifest attributes only appear when the file is present).

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ICON = path.join(ROOT, "icons", "icons", "png", "1024x1024.png");
const OUT_DIR = path.join(ROOT, "build", "appx");

/**
 * One entry per logical asset.
 *
 * `fill` is the icon's edge length as a fraction of the canvas's SHORT side, and
 * `shiftY` nudges it up as a fraction of canvas height — the tiles that carry
 * `<uap:ShowNameOnTiles>` (150x150 and the wide tile, per showNameOnTiles in
 * electron-builder.json5) get the product name drawn across their bottom band, and
 * a dead-centred logo sits under that text.
 *
 * `scales` are the MRT scale qualifiers emitted next to the unqualified 100% file.
 * 400% is only worth its bytes on the assets that stay small on screen; the big tiles
 * stop at 200%. Every variant is a DOWNSCALE of the 1024px master — nothing here
 * upsamples.
 */
const ASSETS = [
	{ name: "StoreLogo", width: 50, height: 50, fill: 1, scales: [125, 150, 200, 400] },
	{ name: "Square44x44Logo", width: 44, height: 44, fill: 1, scales: [125, 150, 200, 400] },
	{ name: "SmallTile", width: 71, height: 71, fill: 0.7, scales: [125, 150, 200, 400] },
	{
		name: "Square150x150Logo",
		width: 150,
		height: 150,
		fill: 0.66,
		shiftY: -0.08,
		scales: [125, 150, 200],
	},
	{
		name: "Wide310x150Logo",
		width: 310,
		height: 150,
		fill: 0.6,
		shiftY: -0.08,
		scales: [125, 150, 200],
	},
	{ name: "LargeTile", width: 310, height: 310, fill: 0.55, scales: [125, 150, 200] },
	{ name: "SplashScreen", width: 620, height: 300, fill: 0.6, scales: [125, 150, 200] },
];

/**
 * Square44x44Logo is also consumed by target size rather than by scale: the taskbar,
 * task-view and Start's app list ask for an exact pixel size. `altform-unplated` is the
 * variant Windows uses where it does NOT draw its accent-coloured plate behind the icon
 * (taskbar, title bar) — same art, different qualifier.
 */
const TARGET_SIZES = [16, 24, 32, 48, 256];

// --- PNG decoding -----------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buffer) {
	let c = -1;
	for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function paethPredictor(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

/** Decodes an 8-bit RGBA, non-interlaced PNG into flat RGBA bytes. */
function decodePng(buffer) {
	if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");

	let width = 0;
	let height = 0;
	const idat = [];
	let offset = 8;
	while (offset < buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const body = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			// The master icon is committed as RGBA8; anything else would need a converter
			// this script deliberately does not carry.
			if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) {
				throw new Error(
					`${SOURCE_ICON}: expected 8-bit RGBA non-interlaced, got depth=${body[8]} colorType=${body[9]} interlace=${body[12]}`,
				);
			}
		} else if (type === "IDAT") {
			idat.push(body);
		} else if (type === "IEND") {
			break;
		}
		offset += 12 + length;
	}

	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * 4;
	const pixels = new Uint8ClampedArray(width * height * 4);
	let pos = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[pos++];
		const row = raw.subarray(pos, pos + stride);
		pos += stride;
		const out = y * stride;
		const prev = out - stride;
		for (let x = 0; x < stride; x++) {
			const left = x >= 4 ? pixels[out + x - 4] : 0;
			const up = y > 0 ? pixels[prev + x] : 0;
			const upLeft = y > 0 && x >= 4 ? pixels[prev + x - 4] : 0;
			let value = row[x];
			if (filter === 1) value += left;
			else if (filter === 2) value += up;
			else if (filter === 3) value += (left + up) >> 1;
			else if (filter === 4) value += paethPredictor(left, up, upLeft);
			else if (filter !== 0) throw new Error(`unsupported PNG row filter ${filter}`);
			pixels[out + x] = value & 0xff;
		}
	}
	return { width, height, pixels };
}

// --- PNG encoding -----------------------------------------------------------------

function chunk(type, body) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length, 0);
	const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typed), 0);
	return Buffer.concat([length, typed, crc]);
}

function encodePng(width, height, pixels) {
	const stride = width * 4;
	// Paeth on every row: these assets are mostly flat colour and long transparent runs,
	// which the predictor turns into zeroes for deflate to collapse.
	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		const dst = y * (stride + 1);
		raw[dst] = 4;
		const src = y * stride;
		const prev = src - stride;
		for (let x = 0; x < stride; x++) {
			const left = x >= 4 ? pixels[src + x - 4] : 0;
			const up = y > 0 ? pixels[prev + x] : 0;
			const upLeft = y > 0 && x >= 4 ? pixels[prev + x - 4] : 0;
			raw[dst + 1 + x] = (pixels[src + x] - paethPredictor(left, up, upLeft)) & 0xff;
		}
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	return Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// --- Resampling and composition ---------------------------------------------------

/**
 * Box-filter (exact area average) resample in PREMULTIPLIED alpha.
 *
 * Averaging straight RGBA would pull the fully transparent black outside the icon's
 * rounded corners into the visible edge and leave a dark fringe at small sizes.
 */
function resample(src, srcWidth, srcHeight, dstWidth, dstHeight) {
	const out = new Uint8ClampedArray(dstWidth * dstHeight * 4);
	const xRatio = srcWidth / dstWidth;
	const yRatio = srcHeight / dstHeight;
	for (let dy = 0; dy < dstHeight; dy++) {
		const y0 = dy * yRatio;
		const y1 = (dy + 1) * yRatio;
		const sy0 = Math.floor(y0);
		const sy1 = Math.min(srcHeight, Math.ceil(y1));
		for (let dx = 0; dx < dstWidth; dx++) {
			const x0 = dx * xRatio;
			const x1 = (dx + 1) * xRatio;
			const sx0 = Math.floor(x0);
			const sx1 = Math.min(srcWidth, Math.ceil(x1));
			let r = 0;
			let g = 0;
			let b = 0;
			let alpha = 0;
			let weight = 0;
			for (let sy = sy0; sy < sy1; sy++) {
				const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
				if (wy <= 0) continue;
				for (let sx = sx0; sx < sx1; sx++) {
					const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
					if (wx <= 0) continue;
					const w = wx * wy;
					const o = (sy * srcWidth + sx) * 4;
					const a = (src[o + 3] / 255) * w;
					r += src[o] * a;
					g += src[o + 1] * a;
					b += src[o + 2] * a;
					alpha += a;
					weight += w;
				}
			}
			const o = (dy * dstWidth + dx) * 4;
			if (alpha > 0) {
				out[o] = Math.round(r / alpha);
				out[o + 1] = Math.round(g / alpha);
				out[o + 2] = Math.round(b / alpha);
			}
			out[o + 3] = Math.round((alpha / weight) * 255);
		}
	}
	return out;
}

/** Draws the square icon, scaled to `size`, onto a transparent canvas. */
function compose(icon, canvasWidth, canvasHeight, size, shiftY) {
	const scaled = resample(icon.pixels, icon.width, icon.height, size, size);
	const canvas = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
	const left = Math.round((canvasWidth - size) / 2);
	const top = Math.round((canvasHeight - size) / 2 + shiftY * canvasHeight);
	for (let y = 0; y < size; y++) {
		const dy = top + y;
		if (dy < 0 || dy >= canvasHeight) continue;
		canvas.set(scaled.subarray(y * size * 4, (y + 1) * size * 4), (dy * canvasWidth + left) * 4);
	}
	return canvas;
}

// --- Generation -------------------------------------------------------------------

/**
 * Every asset this generator owns, as {name, width, height, size, shiftY}, derived from
 * ASSETS/TARGET_SIZES alone — no filesystem involved.
 *
 * This table, not the contents of build/appx/, is the authority on what the package must
 * contain. `--list` exposes it so CI can tell "this asset is missing" apart from "this
 * asset was never expected": a check that reads build/appx/ to decide what to look for
 * passes happily once a file is deleted there, which is precisely when electron-builder
 * swaps a blank placeholder in.
 *
 * The targetsize variants come out of compose() too rather than a bare resample: at
 * size == width == height with no shift, the canvas is fully covered, so the two are the
 * same pixels — and there is then a single code path to keep honest.
 */
function plannedAssets() {
	const planned = [];
	for (const asset of ASSETS) {
		const shiftY = asset.shiftY ?? 0;
		for (const scale of [100, ...(asset.scales ?? [])]) {
			const width = Math.round((asset.width * scale) / 100);
			const height = Math.round((asset.height * scale) / 100);
			const size = Math.round(Math.min(width, height) * asset.fill);
			// The 100% variant stays unqualified so it is also the neutral MRT candidate:
			// if resources.pri ever fails to resolve a scale, Windows still finds art.
			const suffix = scale === 100 ? "" : `.scale-${scale}`;
			planned.push({ name: `${asset.name}${suffix}.png`, width, height, size, shiftY });
		}
	}
	for (const target of TARGET_SIZES) {
		for (const suffix of ["", "_altform-unplated"]) {
			planned.push({
				name: `Square44x44Logo.targetsize-${target}${suffix}.png`,
				width: target,
				height: target,
				size: target,
				shiftY: 0,
			});
		}
	}
	return planned;
}

async function main() {
	const planned = plannedAssets();

	if (process.argv.includes("--list")) {
		console.log(planned.map((it) => it.name).join("\n"));
		return;
	}

	const icon = decodePng(await readFile(SOURCE_ICON));
	for (const { name, size } of planned) {
		if (size > icon.width) {
			throw new Error(`${name} needs a ${size}px icon; master is ${icon.width}px`);
		}
	}

	// Wipe first: a renamed or dropped asset left behind in build/appx/ would still be
	// mapped into the package by electron-builder, which copies the directory wholesale.
	await rm(OUT_DIR, { recursive: true, force: true });
	await mkdir(OUT_DIR, { recursive: true });

	for (const { name, width, height, size, shiftY } of planned) {
		const pixels = compose(icon, width, height, size, shiftY);
		await writeFile(path.join(OUT_DIR, name), encodePng(width, height, pixels));
	}

	const total = (await readdir(OUT_DIR)).length;
	console.log(
		`${planned.length} assets written to ${path.relative(ROOT, OUT_DIR)} (${total} files)`,
	);
}

await main();
