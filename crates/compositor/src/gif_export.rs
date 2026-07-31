//! Native GIF export pipeline.
//!
//! This is now the ONLY GIF path: the renderer-side `gif.js` exporter it
//! originally sat beside — and the `NATIVE_GIF_EXPORT_ENABLED` flag that
//! chose between them — were deleted when GIF moved over for good. Same
//! compositor as the MP4 path (D3D11 on Windows, Metal on macOS), but the
//! per-frame output is a 256-color GIF89a file written from scratch in
//! pure Rust.
//!
//! ## Why pure Rust, not ffmpeg
//!
//! The compositor's ffmpeg bindings are `avformat` / `avcodec` / `avutil` /
//! `swscale` / `swresample` only — **no `libavfilter`**
//! (see `crates/compositor/Cargo.toml` and `crates/compositor/build.rs`).
//! ffmpeg's `palettegen` + `paletteuse` live in `libavfilter` and aren't
//! buildable here, and ffmpeg's `gif` codec in libavcodec still expects
//! pre-quantized `PAL8` frames — it refuses to do the quantize step
//! itself. So the "ffmpeg GIF muxer" route would have been a
//! write-our-own-palette-and-LZW path either way. The CPU readback
//! (the dominant per-frame cost — see the bench in
//! `crates/poc-d3d/src/bench.rs`) already lands us on CPU regardless, so
//! skipping a swscale round-trip and writing the format directly in this
//! crate costs no extra dependency, stays inside the LGPL-only ffmpeg
//! pin we already have, and keeps the readback/quantize/LZW layers
//! auditable in one file.
//!
//! ## What's in this file
//!
//! - `export_gif` — the orchestrator. Drives `pipeline::walk_composited_timeline`,
//!   the SAME clip walk the MP4 exporter uses, so clip iteration, speed
//!   segments and output-time decoder advancement have exactly one
//!   definition. Per output frame the walk composes, then this module does
//!   `Compositor::readback_direct` → palette → optional fused
//!   Floyd-Steinberg → `GifWriter::write_frame`. Reports the same `GifStats`
//!   shape the MP4 `pipeline::Stats` returns.
//!
//!   It previously ran its own loop over the live-preview `Player`, stepping
//!   one SOURCE frame per OUTPUT frame — which made a 30 s/60 fps recording
//!   export as 6 s of content stretched over 30 s, and could not decode files
//!   the MP4 path handled. `tests/export_timing.rs` pins the behaviour.
//! - `GifWriter` — GIF89a format writer: header, optional Netscape 2.0
//!   loop extension, per-frame Graphics Control Extension + Image
//!   Descriptor + LZW image data, trailer. Pure std `Write`.
//! - `lzw_compress` — GIF's LZW variant. Codes 0..255 are the palette;
//!   code 256 = clear, 257 = EOI; codes 258+ are the string table.
//!   Packed LSB-first into the output byte stream. Code size starts at
//!   `min_code_size + 1` (9 for 8-bit palette) and grows to 12 as the
//!   table fills; when the table hits 4096, a clear code resets it.
//! - `build_palette_median_cut` — 256-color palette via median-cut on
//!   the frame's color histogram. Cheap enough at the GIF frame sizes
//!   we ship (≤ 480p) and good enough for screen content; the
//!   requantize-every-30-frames cadence trades a small per-frame
//!   color drift for keeping the palette adapted to the timeline.
//! - `map_to_indices` — brute-force nearest-color search. The hot loop
//!   is 4 reads + 3 muls + 2 adds + 1 compare per pixel, small enough
//!   for the compiler to autovectorize; a NeuQuant network lookup
//!   would be slower at 256 colors and isn't worth its complexity.
//! - `map_to_indices_dithered` — the same search with Floyd-Steinberg
//!   error diffusion fused into it (alpha left as the readback emitted
//!   it), two row-buffers so the working set is O(width) per row. Fused
//!   because the error worth diffusing is `pixel - palette[chosen]`,
//!   which doesn't exist until the entry has been picked.
//!
//! ## Honest signal
//!
//! The wall-time is the only honest signal here: GIF's quality is a
//! user-visible trade-off the user already accepted when they picked
//! the format, and 256-color quantization dominates per-frame CPU. The
//! bench in `crates/poc-d3d/src/bench.rs` is the only check that
//! catches a "this is fine in micro-benchmarks but the readback kills
//! the loop" regression. See the `Native GIF export — initial bench`
//! section of `technical-documentation/engineering/rendering-performance.md`.

use crate::compositor::Compositor;
use crate::config::Cfg;
use crate::d3d::Gpu;
use crate::pipeline::{ClipSource, Decoder};
use crate::timeline_walk::walk_composited_timeline;
use anyhow::{anyhow, bail, Context, Result};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

/// Default output width/height. GIF is 8-bit indexed; smaller frames look
/// better than 1080p under the same palette budget. The user-facing
/// `ExportDialog` can request a different size via `GifExportParams`.
pub const DEFAULT_GIF_WIDTH: u32 = 854;
pub const DEFAULT_GIF_HEIGHT: u32 = 480;
/// Default output framerate. The compositor's decode is decoupled from
/// this; we just subsample frames to hit it.
pub const DEFAULT_GIF_FPS: u32 = 12;

/// Re-quantize the palette every N frames. The user-visible drift on a
/// screen-recording timeline is small within a few seconds, and
/// rebuilding the histogram + median-cut is O(n) on a 410 k-pixel frame
/// — caching amortizes the cost. 30 frames at 12 fps is one re-quant
/// per 2.5 s, the rough interval at which a recording's colour palette
/// tends to shift.
const PALETTE_REQUANTIZE_EVERY: u64 = 30;

/// Number of palette entries per frame. GIF supports up to 256
/// (`2_u16.pow(8)`), which is also what the standard web palette
/// assumes. 256 is the default; the spec allows smaller (4 / 8 / 16 /
/// 32 / 64 / 128) but 256 looks meaningfully better on screen
/// recordings and the cost difference is tiny.
const PALETTE_COLORS: usize = 256;

/// Wall-time / size / fps summary for a GIF export, shaped like
/// `pipeline::Stats` so the bench and the napi binding can pass it
/// through without a second struct.
pub struct GifStats {
	pub frames: u64,
	pub wall_s: f64,
	pub fps: f64,
	/// Duration of the resulting GIF (seconds) = `frames / fps`. Distinct
	/// from `wall_s` (real render time).
	pub video_duration_s: f64,
	/// Size of the GIF file on disk, in bytes. Read after the writer
	/// drops so it includes the trailer.
	pub file_bytes: u64,
}

/// Optional knobs for `export_gif`. The same shape as the future
/// `ExportGifParams` block in the TS contract.
#[derive(Debug, Clone)]
pub struct GifExportParams {
	pub width: Option<u32>,
	pub height: Option<u32>,
	pub fps: Option<u32>,
	/// `None` or `0` → infinite loop (the historical GIF default).
	/// Otherwise finite count.
	pub loop_count: Option<u16>,
	/// Floyd-Steinberg dithering before quantization. Default off —
	/// the quantized result without dithering is usually acceptable
	/// for screen content, and dithering roughly doubles the per-frame
	/// CPU cost.
	pub dither: bool,
}

impl Default for GifExportParams {
	fn default() -> Self {
		Self {
			width: Some(DEFAULT_GIF_WIDTH),
			height: Some(DEFAULT_GIF_HEIGHT),
			fps: Some(DEFAULT_GIF_FPS),
			loop_count: None, // infinite
			dither: false,
		}
	}
}

/// Drive a multiclip GIF export end-to-end.
///
/// Deliberately the same shape as `pipeline::run_composited_multi`, and
/// deliberately driven by the same `walk_composited_timeline`: the clip walk,
/// the speed segments and the output-time decoder advancement are the video
/// exporter's, not a second implementation. Only the per-frame sink differs —
/// MP4 hands the composed texture to a hardware NV12 encoder, GIF reads it back
/// to the CPU and quantizes it to 256 colours.
///
/// A failed run leaves a truncated GIF under exactly the name the user thinks
/// they exported. Remove it rather than leave it lying around — same contract
/// as `discard_partial_output` on the MP4 path.
pub fn export_gif(
	clips: &[ClipSource],
	out_path: &Path,
	gpu: &Gpu,
	comp: &Compositor,
	cfg: &Cfg,
	params: &GifExportParams,
	progress: &mut dyn FnMut(u64),
) -> Result<GifStats> {
	let result = export_gif_inner(clips, out_path, gpu, comp, cfg, params, progress);
	if result.is_err() {
		let _ = std::fs::remove_file(out_path);
	}
	result
}

fn export_gif_inner(
	clips: &[ClipSource],
	out_path: &Path,
	gpu: &Gpu,
	comp: &Compositor,
	cfg: &Cfg,
	params: &GifExportParams,
	progress: &mut dyn FnMut(u64),
) -> Result<GifStats> {
	if clips.is_empty() {
		bail!("export_gif: aucun clip à exporter");
	}
	// The caller builds the compositor at the output size (same contract as
	// `run_composited_multi` / `ExportParams`), so these must agree with what
	// `readback_direct` hands back — asserted per frame below.
	let width = params.width.unwrap_or(DEFAULT_GIF_WIDTH);
	let height = params.height.unwrap_or(DEFAULT_GIF_HEIGHT);
	let fps = params.fps.unwrap_or(DEFAULT_GIF_FPS).max(1);
	let dither = params.dither;

	// Set up the GIF writer up front: file + global header. We use a
	// per-frame local palette (the standard "high-quality" form: a
	// palette tuned to each frame's colours), so the global palette in
	// the header is empty.
	if let Some(parent) = out_path.parent() {
		if !parent.as_os_str().is_empty() {
			std::fs::create_dir_all(parent).ok();
		}
	}
	let file = File::create(out_path)
		.with_context(|| format!("export_gif: create {}", out_path.display()))?;
	let mut writer = BufWriter::new(file);

	// GIF frame delay in centiseconds (= 1/100 s). `fps` →
	// `100 / fps` cs per frame, rounded to the nearest unit the
	// GIF spec supports. u16 caps at 65535 — 10.9 minutes per
	// frame, plenty.
	//
	// ponytail: integer centiseconds can't express every fps exactly
	// (12 → 8 cs → 12.5 fps). `video_duration_s` below is computed
	// from the delays actually written, so the reported duration never
	// disagrees with the file. Fractional accumulation if a viewer ever
	// cares about the ~4% drift.
	let delay_cs: u16 = (100_u32 / fps).max(1) as u16;

	// Pre-allocate the per-frame index buffer. Reused across
	// frames so we don't hit the allocator in the hot loop.
	let mut indices: Vec<u8> = vec![0u8; (width as usize) * (height as usize)];
	// Optional dither error buffer (one signed channel per
	// pixel per channel, 3 channels per pixel, 2 rows of state
	// for the FS pass). Allocated once; only touched when
	// `dither` is true.
	let mut err_cur: Vec<f32> = vec![0.0f32; (width as usize) * 3];
	let mut err_next: Vec<f32> = vec![0.0f32; (width as usize) * 3];
	// Cached palette: rebuilt on a schedule
	// (`PALETTE_REQUANTIZE_EVERY`).
	let mut palette_rgb: Vec<u8> = vec![0u8; PALETTE_COLORS * 3];

	let t0 = Instant::now();
	let scene = comp.scene_snapshot();
	let frames = {
		let mut gw = GifWriter::new(&mut writer, width as u16, height as u16)?;
		gw.write_header()?;
		// Netscape 2.0 application extension drives the loop count.
		// 0 = infinite; some viewers also treat 0 as infinite, so we
		// keep that as the "default".
		let loops = match params.loop_count {
			None | Some(0) => 0u16,
			Some(n) => n,
		};
		gw.write_netscape_loop(loops)?;

		let mut screen_decs: HashMap<String, Decoder> = HashMap::new();
		let mut webcam_decs: HashMap<String, Decoder> = HashMap::new();
		screen_decs.insert(clips[0].screen.clone(), unsafe {
			Decoder::open(&clips[0].screen, gpu)?
		});

		let frames = unsafe {
			walk_composited_timeline(
				clips,
				gpu,
				comp,
				cfg,
				fps as i32,
				&scene,
				&mut screen_decs,
				&mut webcam_decs,
				&mut |frame_index| {
					// CPU readback of the staged RT (RGBA8 tightly-packed,
					// `width * height * 4` bytes). The dominant per-frame cost,
					// and the reason GIF can't use the MP4 zero-copy sink.
					let (rw, rh, rgba) = comp
						.readback_direct()
						.map_err(|e| anyhow!("export_gif: readback @ frame {frame_index}: {e:#}"))?;
					debug_assert_eq!(rw, width);
					debug_assert_eq!(rh, height);

					// Refresh the palette on a schedule. Building the histogram
					// and running median-cut is O(unique colors) — fast enough at
					// 480p on our 30-frame cadence.
					if frame_index % PALETTE_REQUANTIZE_EVERY == 0 {
						build_palette_median_cut(&rgba, PALETTE_COLORS, &mut palette_rgb);
					}

					// Quantize (with optional dithering). The dither pass diffuses
					// the error against the CHOSEN PALETTE ENTRY, so it has to run
					// fused with the index mapping — see `map_to_indices_dithered`.
					if dither {
						map_to_indices_dithered(
							&palette_rgb,
							&rgba,
							width,
							height,
							&mut err_cur,
							&mut err_next,
							&mut indices,
						);
					} else {
						map_to_indices(&palette_rgb, &rgba, &mut indices);
					}

					// Per-frame palette (GIF local palette, written by `write_frame`).
					gw.write_frame(&indices, &palette_rgb, delay_cs, fps)?;
					progress(frame_index + 1);
					Ok(())
				},
				// GIF has no audio track, so clip boundaries need no work.
				&mut |_, _, _, _| Ok(()),
			)?
		};

		gw.finish()?;
		frames
	};
	// Drop the writer before stat-ing the file so the trailer is
	// flushed.
	drop(writer);

	let wall_s = t0.elapsed().as_secs_f64();
	let fps_actual = if wall_s > 0.0 { frames as f64 / wall_s } else { 0.0 };
	// From the delays actually written, not from the requested fps — see the
	// `delay_cs` note above.
	let video_duration_s = frames as f64 * (delay_cs as f64 / 100.0);
	let file_bytes = std::fs::metadata(out_path).map(|m| m.len()).unwrap_or(0);

	Ok(GifStats { frames, wall_s, fps: fps_actual, video_duration_s, file_bytes })
}


// =====================================================================
// GIF89a format writer (pure std::io::Write).
// =====================================================================
//
// Spec reference: GIF89a Appendix F (LZW) and the Lempel-Ziv-Welch
// variant. Code packing is LSB-first into the byte stream (the LSB of
// each code goes into the LSB of the byte), and bytes are written in
// order. A sub-block of N LZW bytes is preceded by a 1-byte length N
// (1..=255); a 0x00 byte terminates the sub-block stream. The image
// descriptor's LCT size field uses the same `2^N` encoding as the
// header's GCT size field.

struct GifWriter<W: Write> {
	w: W,
	width: u16,
	height: u16,
	/// Set by `finish`, so `Drop` does not append a second trailer.
	finished: bool,
}

impl<W: Write> GifWriter<W> {
	fn new(w: W, width: u16, height: u16) -> Result<Self> {
		if width == 0 || height == 0 {
			bail!("gif: dimensions must be > 0 (got {width}x{height})");
		}
		Ok(GifWriter {
			w,
			width,
			height,
			finished: false,
		})
	}

	/// Write the GIF89a header + Logical Screen Descriptor. No global
	/// color table: every frame carries a local palette, which the
	/// GIF89a spec specifically allows and which gives per-frame
	/// colour fidelity that a single global table can't match.
	fn write_header(&mut self) -> Result<()> {
		self.w.write_all(b"GIF89a")?;
		// Logical screen descriptor.
		self.w.write_all(&self.width.to_le_bytes())?;
		self.w.write_all(&self.height.to_le_bytes())?;
		// Packed byte: GCT flag (bit 7) = 0, color resolution
		// (bits 4-6) = 7 (8 bits/channel), sort flag (bit 3) = 0,
		// GCT size (bits 0-2) = 0 (no GCT). The upper nibble is the
		// raw value; the GCT size is `(n + 1)` where the table has
		// `2^(n+1)` entries. 0 here = "no GCT" (flag bit is 0
		// anyway).
		self.w.write_all(&[0b0_111_0_000])?;
		// Background color index (unused, no GCT) and pixel aspect
		// ratio (0 = unspecified, the common case).
		self.w.write_all(&[0, 0])?;
		Ok(())
	}

	/// Write a Netscape 2.0 application extension block driving the
	/// GIF loop counter. `loop_count == 0` means infinite — the
	/// historical GIF default and what most viewers assume.
	fn write_netscape_loop(&mut self, loop_count: u16) -> Result<()> {
		self.w.write_all(&[0x21, 0xFF, 0x0B])?;
		self.w.write_all(b"NETSCAPE2.0")?;
		self.w.write_all(&[0x03, 0x01])?;
		self.w.write_all(&loop_count.to_le_bytes())?;
		self.w.write_all(&[0x00])?;
		Ok(())
	}

	/// Write one animated frame: Graphics Control Extension (delay
	/// only — no transparency, no disposal), Image Descriptor, local
	/// color table, LZW-compressed index stream.
	fn write_frame(
		&mut self,
		indices: &[u8],
		palette_rgb: &[u8],
		delay_cs: u16,
		_fps: u32,
	) -> Result<()> {
		debug_assert_eq!(indices.len(), (self.width as usize) * (self.height as usize));
		debug_assert_eq!(palette_rgb.len(), PALETTE_COLORS * 3);

		// Graphics Control Extension: delay only. The disposal
		// method is "leave in place" (0) and the transparent flag
		// is off, so a frame with overlapping dimensions is
		// composited on top of the previous frame.
		self.w.write_all(&[0x21, 0xF9, 0x04])?;
		// Packed: 3 reserved (0) | 3 disposal (0 = leave in
		// place) | 1 user input (0) | 1 transparent (0). 0x00
		// throughout.
		self.w.write_all(&[0x00])?;
		self.w.write_all(&delay_cs.to_le_bytes())?;
		// Transparent color index (unused — `0` is the conventional
		// "no transparency" sentinel).
		self.w.write_all(&[0x00])?;
		// Block terminator.
		self.w.write_all(&[0x00])?;

		// Image Descriptor.
		self.w.write_all(&[0x2C])?;
		self.w.write_all(&0u16.to_le_bytes())?; // left
		self.w.write_all(&0u16.to_le_bytes())?; // top
		self.w.write_all(&self.width.to_le_bytes())?;
		self.w.write_all(&self.height.to_le_bytes())?;
		// Packed: LCT flag (bit 7) = 1, interlace (bit 6) = 0,
		// sort (bit 5) = 0, reserved (bits 3-4) = 0, LCT size
		// (bits 0-2) = 7 (i.e. 2^(7+1) = 256 entries).
		self.w.write_all(&[0b1_0_0_00_111])?;
		// Local color table.
		self.w.write_all(palette_rgb)?;

		// LZW image data: `LZW minimum code size` byte, then
		// sub-blocks of compressed bytes, then a 0x00 terminator.
		// LZW min code size is 8 for a 256-color palette.
		self.w.write_all(&[8])?;
		let mut compressed: Vec<u8> = Vec::new();
		lzw_compress(indices, 8, &mut compressed);
		write_sub_blocks(&mut self.w, &compressed)?;
		self.w.write_all(&[0x00])?; // image data terminator
		Ok(())
	}

	/// Write the trailer byte (`0x3B`) and flush. Callers should
	/// typically rely on `Drop` instead — this exists for the bench
	/// path that wants an explicit "we're done, no more frames"
	/// signal.
	fn finish(&mut self) -> Result<()> {
		if self.finished {
			return Ok(());
		}
		self.finished = true;
		self.w.write_all(&[0x3B])?;
		self.w.flush()?;
		Ok(())
	}
}

impl<W: Write> Drop for GifWriter<W> {
	fn drop(&mut self) {
		// Best-effort trailer for the paths that bail out before calling
		// `finish`. Skipped when `finish` already wrote one — two trailer
		// bytes are tolerated by most decoders but rejected by strict ones.
		// We intentionally don't propagate the result — `Drop` can't return
		// errors. The resulting file will be truncated/invalid, which the
		// caller will detect on the next read.
		if self.finished {
			return;
		}
		let _ = self.w.write_all(&[0x3B]);
		let _ = self.w.flush();
	}
}

/// Write a stream of bytes as a sequence of GIF sub-blocks (max 255
/// bytes per sub-block, preceded by a 1-byte length, terminated by
/// `0x00`).
fn write_sub_blocks<W: Write>(w: &mut W, data: &[u8]) -> Result<()> {
	let mut pos = 0;
	while pos < data.len() {
		let chunk = (data.len() - pos).min(255);
		w.write_all(&[chunk as u8])?;
		w.write_all(&data[pos..pos + chunk])?;
		pos += chunk;
	}
	Ok(())
}

// =====================================================================
// LZW encoder (GIF89a variant).
// =====================================================================
//
// The GIF LZW variant:
//   - LZW min code size = log2(max color + 1). For 256 colors: 8.
//   - Initial code size = min code size + 1 = 9.
//   - Clear code = 2^min_code_size = 256.
//   - EOI code = clear code + 1 = 257.
//   - First free code = 258.
//   - Codes 0..256+1 are the initial table (literal codes plus the
//     clear and EOI sentinels); codes 258+ are added as the encoder
//     walks the input.
//   - Code size bumps from 9 to 12 as the table fills; at 12 bits
//     the table holds 4096 codes (0..4095). Adding the 4096th
//     "missing pair" triggers a clear code, table reset, and the
//     encoder starts over. The bump lands one code LATER than the
//     table boundary suggests, because the decoder's table lags
//     ours by one entry — see the note at the `code_size += 1`.
//   - Codes are packed LSB-first into the byte stream; the
//     bit-buffer drains into output bytes as soon as 8 bits have
//     accumulated.

fn lzw_compress(indices: &[u8], min_code_size: u8, out: &mut Vec<u8>) {
	let clear_code: u16 = 1u16 << min_code_size;
	let eoi_code: u16 = clear_code + 1;
	let initial_code_size: u8 = min_code_size + 1;

	let mut table: HashMap<(u16, u8), u16> = HashMap::new();
	let mut code_size: u8 = initial_code_size;
	let mut next_code: u16 = eoi_code + 1;
	let mut bit_buffer: u32 = 0;
	let mut bits_in_buffer: u8 = 0;

	// Helper closure: pack `code` at the current `code_size` into
	// the bit buffer, draining whole bytes into `out` as they fill
	// up. Code packing is LSB-first (the LSB of the code goes into
	// the LSB of the current byte), and codes are written into
	// `out` in stream order — which is the canonical GIF behaviour.
	// Captures `out` mutably; the bit buffer and code size are
	// passed in to keep the closure a small mutator rather than a
	// re-borrow of the whole function.
	let mut emit = |code: u16, code_size: u8, buf: &mut u32, n: &mut u8| {
		*buf |= (code as u32) << *n;
		*n += code_size;
		while *n >= 8 {
			out.push((*buf & 0xFF) as u8);
			*buf >>= 8;
			*n -= 8;
		}
	};

	// Always start with a clear code — the decoder also requires
	// it. (Empty streams still need the clear + EOI pair.)
	emit(clear_code, code_size, &mut bit_buffer, &mut bits_in_buffer);

	if indices.is_empty() {
		emit(eoi_code, code_size, &mut bit_buffer, &mut bits_in_buffer);
		// Pad the final byte with zeros to a full byte.
		if bits_in_buffer > 0 {
			out.push(bit_buffer as u8);
		}
		return;
	}

	let mut prefix: u16 = indices[0] as u16;
	for &k in &indices[1..] {
		let key = (prefix, k);
		if let Some(&code) = table.get(&key) {
			prefix = code;
			continue;
		}
		// Miss: emit the prefix code at the current size, then
		// add the new entry.
		emit(prefix, code_size, &mut bit_buffer, &mut bits_in_buffer);

		if next_code <= 4095 {
			table.insert(key, next_code);
			next_code += 1;
			// Bump code_size one entry AFTER the table outgrows
			// it, not on the boundary itself. The missing `+ 1`
			// is what black-framed every exported GIF.
			//
			// The decoder builds its table one entry behind the
			// encoder: it can only add `(prev, first_byte(cur))`
			// once it has read the code that FOLLOWS. So when we
			// have just inserted code 511 (`next_code == 512`),
			// the decoder still holds 511 entries and still reads
			// at 9 bits. Bumping here sends the next code out at
			// 10 bits while the decoder reads 9 — the stream
			// desyncs a few hundred codes in and every pixel
			// after that is garbage. Deferring by one
			// (`next_code == 513`) puts both bumps on the same
			// code, which is what the reference encoder does too
			// (it tests the PRE-insert `free_ent > maxcode`
			// after emitting, not before).
			if code_size < 12 && next_code == (1u16 << code_size) + 1 {
				code_size += 1;
			}
		} else {
			// Table full (next_code is 4096). Emit a clear
			// code, reset the table, and start over. The
			// decoder will see this clear code and rebuild
			// the table the same way.
			emit(clear_code, code_size, &mut bit_buffer, &mut bits_in_buffer);
			table.clear();
			code_size = initial_code_size;
			next_code = eoi_code + 1;
		}
		prefix = k as u16;
	}

	// Flush: emit the final prefix, then EOI, then pad the bit
	// buffer to a byte boundary.
	emit(prefix, code_size, &mut bit_buffer, &mut bits_in_buffer);
	emit(eoi_code, code_size, &mut bit_buffer, &mut bits_in_buffer);
	if bits_in_buffer > 0 {
		out.push(bit_buffer as u8);
	}
}

// =====================================================================
// Median-cut palette builder.
// =====================================================================
//
// The standard Heckbert "Color Image Quantization for Frame Buffer
// Display" algorithm, with two pragmatic choices:
//
//   1. We work on a histogram of distinct colors (not on the raw
//      pixel stream). The number of distinct colors on a screen
//      recording frame is typically ≪ pixel count (10k–100k
//      distinct colors in 410k pixels), which keeps the per-split
//      sort cheap. Building the histogram is O(n) on pixel count.
//   2. We split by finding the longest channel axis and bisecting
//      at the median (count-weighted) of that axis. A full sort
//      per split dominates the cost; we sort by a single key (the
//      chosen channel) which is `O(k log k)` per split, summed
//      across `num_colors` splits.

fn build_palette_median_cut(rgba: &[u8], num_colors: usize, out_palette: &mut [u8]) {
	debug_assert_eq!(out_palette.len(), num_colors * 3);
	debug_assert!(num_colors > 0);

	// 1. Histogram of distinct colors. Bumping the counter is a
	//    single hashmap insert/update per pixel — O(n) total, with
	//    cache-friendly bulk iteration over the RGBA buffer.
	let mut histogram: HashMap<[u8; 3], u32> = HashMap::new();
	for chunk in rgba.chunks_exact(4) {
		let color = [chunk[0], chunk[1], chunk[2]];
		*histogram.entry(color).or_insert(0) += 1;
	}
	if histogram.is_empty() {
		// Shouldn't happen with a real readback, but fall back to
		// a black palette if it does.
		for chunk in out_palette.chunks_exact_mut(3) {
			chunk[0] = 0;
			chunk[1] = 0;
			chunk[2] = 0;
		}
		return;
	}

	// Collapse the histogram into a sorted vector for the split
	// step. We allocate this fresh each call — `requantize_every`
	// frames is the only call site, and the cost (one allocation +
	// one memcpy from the hashmap) is well under a millisecond at
	// 480p.
	let entries: Vec<([u8; 3], u32)> = histogram.into_iter().collect();

	// 2. Repeatedly split the bucket with the longest channel
	//    range until we have `num_colors` buckets. The split is
	//    count-weighted: the median of the channel values by
	//    cumulative count, not by raw position.
	let mut buckets: Vec<Vec<([u8; 3], u32)>> = vec![entries];
	while buckets.len() < num_colors {
		// Find the bucket with the largest total range across
		// channels. Ties break by index (earlier split first),
		// which is reproducible across machines.
		let mut best_idx: usize = 0;
		let mut best_range: u32 = 0;
		for (i, b) in buckets.iter().enumerate() {
			if b.len() < 2 {
				continue;
			}
			let r = channel_range(b, 0);
			let g = channel_range(b, 1);
			let bl = channel_range(b, 2);
			let m = r.max(g).max(bl);
			if m > best_range {
				best_range = m;
				best_idx = i;
			}
		}
		if best_range == 0 {
			// All remaining buckets are uniform; no further
			// refinement possible. Pad with the average of
			// the largest bucket so the palette still has
			// the requested entry count (or close to it).
			break;
		}
		// Split `best_idx` along the longest axis. Count-weighted
		// median: find the channel value where the cumulative
		// count crosses half the bucket's total.
		let axis = {
			let b = &buckets[best_idx];
			let r = channel_range(b, 0);
			let g = channel_range(b, 1);
			let bl = channel_range(b, 2);
			if r >= g && r >= bl {
				0
			} else if g >= bl {
				1
			} else {
				2
			}
		};
		let bucket = buckets.remove(best_idx);
		let total: u64 = bucket.iter().map(|(_, c)| *c as u64).sum();
		let half = total / 2;

		// Sort by the chosen axis. A full sort is the right call
		// here — the bucket is at most the size of the histogram
		// (typically 10k–100k entries), and a single sort is
		// cheaper than trying to find the median in O(n) and then
		// partitioning, which has worse constants in Rust.
		let mut sorted = bucket;
		sorted.sort_by_key(|(c, _)| c[axis]);

		// Walk the sorted bucket accumulating counts; the first
		// entry past `half` is the split point.
		let mut acc: u64 = 0;
		let mut split = sorted.len();
		for (i, (_, count)) in sorted.iter().enumerate() {
			acc += *count as u64;
			if acc >= half {
				split = i + 1;
				break;
			}
		}
		// split in (0, len) by construction (the bucket has ≥ 2
		// entries and half < total), but guard against an edge
		// case where every entry sits on one side of the median.
		if split == 0 {
			split = 1;
		} else if split >= sorted.len() {
			split = sorted.len() - 1;
		}
		let mut right = sorted.split_off(split);
		if right.is_empty() {
			// Defensive: shouldn't happen with a valid split
			// point, but if it does we don't want to lose
			// entries.
			right = sorted.split_off(sorted.len() - 1);
		}
		buckets.push(sorted);
		buckets.push(right);
	}

	// 3. Average each bucket (count-weighted) to get one palette
	//    entry per bucket. If we have fewer than `num_colors`
	//    buckets (all-uniform early exit), duplicate the largest
	//    bucket's average to fill the rest.
	for (i, chunk) in out_palette.chunks_exact_mut(3).enumerate() {
		let bucket = buckets.get(i).filter(|b| !b.is_empty());
		let (r, g, b) = match bucket {
			Some(b) => {
				let mut r_sum: u64 = 0;
				let mut g_sum: u64 = 0;
				let mut b_sum: u64 = 0;
				let mut n: u64 = 0;
				for (color, count) in b {
					r_sum += color[0] as u64 * *count as u64;
					g_sum += color[1] as u64 * *count as u64;
					b_sum += color[2] as u64 * *count as u64;
					n += *count as u64;
				}
				if n == 0 {
					(0u8, 0u8, 0u8)
				} else {
					((r_sum / n) as u8, (g_sum / n) as u8, (b_sum / n) as u8)
				}
			}
			None => {
				// Pad: reuse the first non-empty bucket's
				// average. (`buckets` is non-empty because
				// the histogram is non-empty.)
				if let Some(b) = buckets.first().filter(|b| !b.is_empty()) {
					let mut r_sum: u64 = 0;
					let mut g_sum: u64 = 0;
					let mut b_sum: u64 = 0;
					let mut n: u64 = 0;
					for (color, count) in b {
						r_sum += color[0] as u64 * *count as u64;
						g_sum += color[1] as u64 * *count as u64;
						b_sum += color[2] as u64 * *count as u64;
						n += *count as u64;
					}
					if n == 0 {
						(0u8, 0u8, 0u8)
					} else {
						((r_sum / n) as u8, (g_sum / n) as u8, (b_sum / n) as u8)
					}
				} else {
					(0u8, 0u8, 0u8)
				}
			}
		};
		chunk[0] = r;
		chunk[1] = g;
		chunk[2] = b;
	}
}

fn channel_range(bucket: &[([u8; 3], u32)], channel: usize) -> u32 {
	if bucket.is_empty() {
		return 0;
	}
	let min = bucket.iter().map(|(c, _)| c[channel]).min().unwrap() as u32;
	let max = bucket.iter().map(|(c, _)| c[channel]).max().unwrap() as u32;
	max - min
}

// =====================================================================
// Nearest-color index mapping.
// =====================================================================
//
// Brute-force squared-distance search over 256 palette entries per
// pixel. The inner loop is `4 reads + 3 muls + 2 adds + 1 compare`
// per (pixel × palette entry) — small enough that the compiler
// autovectorizes the pixel loop on x86-64 (the `pow(2)` distance
// rule is fine because we only compare, not sort by it). A
// NeuQuant-network lookup would walk a per-frame tree (≈ 512-node
// path per pixel), which is **slower** than 256 brute-force
// comparisons on modern CPUs with wide SIMD.
//
// Cost on the 854×480 fixture (410 k pixels × 256 entries) is
// ~100 M simple integer ops, well under one frame on a recent
// CPU. If it ever shows up on the bench, the right fix is
// `std::simd` or a hand-written AVX2 inner loop — both in this
// file, no new deps.

fn map_to_indices(palette_rgb: &[u8], rgba: &[u8], indices: &mut [u8]) {
	let npix = indices.len();
	debug_assert_eq!(rgba.len(), npix * 4);
	debug_assert_eq!(palette_rgb.len(), PALETTE_COLORS * 3);

	// Pre-transpose the palette into `[r0..r255, g0..g255, b0..b255]`
	// form so the inner loop's three channel reads are contiguous
	// and the compiler can pack them into SIMD loads. The cost
	// is 768 bytes per frame, written once; the alternative
	// (interleaved reads with a `* 3` step) costs the same in
	// the hot loop and is harder to vectorize.
	let mut pr = [0u8; PALETTE_COLORS];
	let mut pg = [0u8; PALETTE_COLORS];
	let mut pb = [0u8; PALETTE_COLORS];
	for (k, chunk) in palette_rgb.chunks_exact(3).enumerate() {
		pr[k] = chunk[0];
		pg[k] = chunk[1];
		pb[k] = chunk[2];
	}

	for i in 0..npix {
		let base = i * 4;
		let r = rgba[base] as i32;
		let g = rgba[base + 1] as i32;
		let b = rgba[base + 2] as i32;
		// Branchless nearest. The 256-entry loop body is 3 reads
		// + 3 subs + 3 muls + 2 adds + 1 compare + 1 conditional
		// store — well within autovectorization budget. The
		// (distance, index) packing into a single `i32` was
		// tried and dropped: the conditional store didn't
		// improve (the compiler vectorizes the simple form
		// already).
		let mut best_idx: usize = 0;
		let mut best_dist: i32 = i32::MAX;
		for k in 0..PALETTE_COLORS {
			let dr = r - pr[k] as i32;
			let dg = g - pg[k] as i32;
			let db = b - pb[k] as i32;
			let dist = dr * dr + dg * dg + db * db;
			if dist < best_dist {
				best_dist = dist;
				best_idx = k;
			}
		}
		indices[i] = best_idx as u8;
	}
}

/// Nearest-palette mapping with Floyd-Steinberg error diffusion, fused.
///
/// Fused on purpose. A separate dither pass has nothing to diffuse against:
/// quantizing to `round()` of an already-integer channel gives an error of
/// exactly zero for every pixel, so the whole pass is a no-op that still costs
/// a full float traversal. The error that matters is `pixel - palette[chosen]`,
/// which only exists once the palette entry has been picked — hence one loop.
///
/// Kernel is the standard 7/16 right, 3/16 below-left, 5/16 below,
/// 1/16 below-right. Two row buffers keep the working set at O(width).
#[allow(clippy::too_many_arguments)]
fn map_to_indices_dithered(
	palette_rgb: &[u8],
	rgba: &[u8],
	width: u32,
	height: u32,
	err_cur: &mut [f32],
	err_next: &mut [f32],
	indices: &mut [u8],
) {
	let w = width as usize;
	let h = height as usize;
	debug_assert_eq!(indices.len(), w * h);
	debug_assert_eq!(palette_rgb.len(), PALETTE_COLORS * 3);

	err_cur.fill(0.0);
	err_next.fill(0.0);

	for y in 0..h {
		for x in 0..w {
			let base = (y * w + x) * 4;
			let e = x * 3;
			// Channel value carrying the error diffused into this pixel.
			let cr = (rgba[base] as f32 + err_cur[e]).clamp(0.0, 255.0);
			let cg = (rgba[base + 1] as f32 + err_cur[e + 1]).clamp(0.0, 255.0);
			let cb = (rgba[base + 2] as f32 + err_cur[e + 2]).clamp(0.0, 255.0);

			let mut best_idx = 0usize;
			let mut best_dist = f32::MAX;
			for k in 0..PALETTE_COLORS {
				let dr = cr - palette_rgb[k * 3] as f32;
				let dg = cg - palette_rgb[k * 3 + 1] as f32;
				let db = cb - palette_rgb[k * 3 + 2] as f32;
				let dist = dr * dr + dg * dg + db * db;
				if dist < best_dist {
					best_dist = dist;
					best_idx = k;
				}
			}
			indices[y * w + x] = best_idx as u8;

			// THE error: distance to the colour actually written.
			let er = cr - palette_rgb[best_idx * 3] as f32;
			let eg = cg - palette_rgb[best_idx * 3 + 1] as f32;
			let eb = cb - palette_rgb[best_idx * 3 + 2] as f32;

			let mut spread = |slot: &mut [f32], idx: usize, f: f32| {
				slot[idx] += er * f;
				slot[idx + 1] += eg * f;
				slot[idx + 2] += eb * f;
			};
			if x + 1 < w {
				spread(err_cur, e + 3, 7.0 / 16.0);
				spread(err_next, e + 3, 1.0 / 16.0);
			}
			if x > 0 {
				spread(err_next, e - 3, 3.0 / 16.0);
			}
			spread(err_next, e, 5.0 / 16.0);
		}
		// Next row becomes current; clear the far row for reuse.
		err_cur.copy_from_slice(err_next);
		err_next.fill(0.0);
	}
}

// =====================================================================
// Tests.
// =====================================================================
//
// These tests run under `cargo test -p openscreen-compositor` and
// don't need a GPU — they exercise the GIF89a writer, the LZW
// encoder, the median-cut palette, the nearest-color mapping, and
// the Floyd-Steinberg dither. The full `export_gif` pipeline
// (Player + GPU + readback) is exercised by the bench, not here.

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Cursor;

	/// The most basic round-trip: write a 2×2 frame and check the
	/// file is well-formed GIF89a. No decode — we just walk the
	/// output bytes and confirm the structural shape.
	#[test]
	fn gif_writer_writes_exactly_one_trailer() {
		// `finish` writes 0x3B, and so does `Drop`. Without the guard the file
		// ends `3B 3B`, which strict decoders reject.
		let mut buf = Vec::new();
		{
			let mut gw = GifWriter::new(&mut buf, 2, 2).unwrap();
			gw.write_header().unwrap();
			gw.finish().unwrap();
		}
		assert_eq!(buf.last(), Some(&0x3B));
		assert_ne!(
			buf[buf.len() - 2],
			0x3B,
			"trailer written twice: {:02X?}",
			&buf[buf.len() - 2..]
		);
	}

	#[test]
	fn gif_writer_drop_still_terminates_without_finish() {
		// The bail-out paths never call `finish`; `Drop` must still close the file.
		let mut buf = Vec::new();
		{
			let mut gw = GifWriter::new(&mut buf, 2, 2).unwrap();
			gw.write_header().unwrap();
		}
		assert_eq!(buf.last(), Some(&0x3B));
	}

	#[test]
	fn gif_writer_writes_minimal_header() {
		let mut buf = Vec::new();
		{
			let mut gw = GifWriter::new(&mut buf, 2, 2).unwrap();
			gw.write_header().unwrap();
			gw.write_netscape_loop(0).unwrap();
			let palette = vec![0u8; PALETTE_COLORS * 3];
			let indices = vec![0u8; 4];
			gw.write_frame(&indices, &palette, 10, 12).unwrap();
			gw.finish().unwrap();
		}
		// Magic.
		assert_eq!(&buf[0..6], b"GIF89a");
		// Width / height (LE u16).
		assert_eq!(&buf[6..8], &2u16.to_le_bytes());
		assert_eq!(&buf[8..10], &2u16.to_le_bytes());
		// Packed byte: GCT flag = 0, color res = 7, sort = 0, GCT
		// size = 0.
		assert_eq!(buf[10], 0b0_111_0_000);
		// Background + aspect: 0, 0.
		assert_eq!(buf[11], 0);
		assert_eq!(buf[12], 0);
		// Netscape loop extension.
		assert_eq!(&buf[13..16], &[0x21, 0xFF, 0x0B]);
		assert_eq!(&buf[16..27], b"NETSCAPE2.0");
		// Trailer at the end.
		assert_eq!(*buf.last().unwrap(), 0x3B);
	}

	/// Reference GIF89a LZW decoder (spec Appendix F), for the
	/// round-trip tests below.
	///
	/// It exists because "the output is a non-empty byte stream" —
	/// all the assertion these tests used to make — passes happily on
	/// a stream no decoder can read. The encoder bumped its code size
	/// one code too early, every GIF the app exported decoded to black,
	/// and the whole suite stayed green: `export_timing.rs` reads the
	/// frame PALETTES, which are written outside the LZW data and were
	/// perfectly fine. Nothing in the repo ever decoded a pixel.
	///
	/// So this is deliberately an INDEPENDENT implementation, written
	/// from the spec rather than by mirroring `lzw_compress`: a decoder
	/// derived from the encoder would have reproduced the same
	/// off-by-one and agreed with it. Its output was cross-checked
	/// against macOS ImageIO (`sips -s format png`) on real frames.
	///
	/// Table lags the encoder's by one entry by construction: an entry
	/// can only be completed once the FOLLOWING code is known.
	fn lzw_decompress(data: &[u8], min_code_size: u8) -> Vec<u8> {
		let clear_code: u16 = 1u16 << min_code_size;
		let eoi_code: u16 = clear_code + 1;
		let mut code_size: u8 = min_code_size + 1;

		// Literals, then two placeholders so indices line up with the
		// clear / EOI codes: `dict.len()` is then exactly the encoder's
		// `next_code`.
		let fresh = || -> Vec<Vec<u8>> {
			let mut d: Vec<Vec<u8>> = (0..clear_code).map(|i| vec![i as u8]).collect();
			d.push(Vec::new());
			d.push(Vec::new());
			d
		};
		let mut dict = fresh();

		let mut out: Vec<u8> = Vec::new();
		let mut prev: Option<u16> = None;
		let mut bitpos: usize = 0;
		let total_bits = data.len() * 8;

		loop {
			assert!(
				bitpos + code_size as usize <= total_bits,
				"truncated LZW stream at bit {bitpos} of {total_bits}"
			);
			// LSB-first: bit i of the code is bit i of the stream.
			let mut code: u16 = 0;
			for i in 0..code_size as usize {
				let bit = (data[(bitpos + i) / 8] >> ((bitpos + i) % 8)) & 1;
				code |= (bit as u16) << i;
			}
			bitpos += code_size as usize;

			if code == clear_code {
				dict = fresh();
				code_size = min_code_size + 1;
				prev = None;
				continue;
			}
			if code == eoi_code {
				break;
			}

			// Either a known entry, or the KwKwK case: the code the
			// encoder just added, which we can only reconstruct from
			// the previous entry plus its own first byte.
			let entry: Vec<u8> = if (code as usize) < dict.len() {
				dict[code as usize].clone()
			} else {
				let p = prev.unwrap_or_else(|| {
					panic!("first code after a clear must be a literal, got {code}")
				});
				let mut e = dict[p as usize].clone();
				e.push(dict[p as usize][0]);
				e
			};
			assert!(!entry.is_empty(), "code {code} resolved to an empty entry");
			out.extend_from_slice(&entry);

			if let Some(p) = prev {
				if dict.len() < 4096 {
					let mut new_entry = dict[p as usize].clone();
					new_entry.push(entry[0]);
					dict.push(new_entry);
					if code_size < 12 && dict.len() == (1usize << code_size) {
						code_size += 1;
					}
				}
			}
			prev = Some(code);
		}
		out
	}

	fn assert_lzw_round_trips(name: &str, pixels: &[u8]) {
		let mut compressed = Vec::new();
		lzw_compress(pixels, 8, &mut compressed);
		let decoded = lzw_decompress(&compressed, 8);
		assert_eq!(
			decoded.len(),
			pixels.len(),
			"{name}: decoded {} pixels, expected {}",
			decoded.len(),
			pixels.len()
		);
		if let Some(i) = (0..pixels.len()).find(|&i| decoded[i] != pixels[i]) {
			panic!(
				"{name}: first mismatch at pixel {i} (expected {}, got {})",
				pixels[i], decoded[i]
			);
		}
	}

	/// A stream long enough to cross the 9→10 bit boundary must survive a
	/// decode. This is THE regression test: the encoder used to bump its
	/// code size one code before the decoder does, so everything past
	/// roughly the 255th code came back as garbage — which is what made
	/// exported GIFs render black.
	#[test]
	fn lzw_round_trips_across_the_code_size_boundary() {
		// Long runs plus slow variation — the shape of a real
		// screen-recording frame, and enough misses to walk 9 → 10 → 11.
		let pixels: Vec<u8> = (0..200_000u32).map(|i| ((i / 97) % 251) as u8).collect();
		assert_lzw_round_trips("gradient-ish", &pixels);
	}

	/// Table-full path: 4096 entries, a clear code, and a reset mid-stream.
	/// Pseudo-random data fills the table fast and forces several clears.
	#[test]
	fn lzw_round_trips_through_table_full_clears() {
		let mut seed = 0x1234_5678u32;
		let pixels: Vec<u8> = (0..DEFAULT_GIF_WIDTH * DEFAULT_GIF_HEIGHT)
			.map(|_| {
				seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
				(seed >> 24) as u8
			})
			.collect();
		assert_lzw_round_trips("noise (forces clears)", &pixels);
	}

	/// The degenerate shapes: uniform frame (one long run), two-colour
	/// alternation (table grows without ever repeating), single pixel.
	#[test]
	fn lzw_round_trips_degenerate_frames() {
		assert_lzw_round_trips("uniform", &vec![42u8; 100_000]);
		assert_lzw_round_trips(
			"alternating",
			&(0..50_000).map(|i| (i % 2) as u8).collect::<Vec<_>>(),
		);
		assert_lzw_round_trips("single pixel", &[7]);
	}

	/// The LZW encoder must produce a clear code at the start and
	/// an EOI at the end — checked by decoding, since a stream that
	/// merely "isn't empty" proves nothing.
	#[test]
	fn lzw_compress_emits_clear_and_eoi() {
		let pixels: Vec<u8> = (0..200).map(|i| (i % 4) as u8).collect();
		let mut out = Vec::new();
		lzw_compress(&pixels, 8, &mut out);
		assert!(!out.is_empty());
		// The leading clear code (256, 9 bits, LSB-first) occupies the
		// first byte and the low bit of the second.
		assert_eq!(out[0], 0x00);
		assert_eq!(out[1] & 0x01, 0x01);
		// And the whole thing decodes back to what went in — which is
		// only possible if the EOI is there and the bits line up.
		assert_lzw_round_trips("short run", &pixels);
	}

	/// LZW on an empty input still emits clear + EOI. This is the
	/// documented behaviour and the decoder requires it.
	#[test]
	fn lzw_compress_empty_still_has_clear_eoi() {
		let mut out = Vec::new();
		lzw_compress(&[], 8, &mut out);
		assert!(!out.is_empty());
		assert!(lzw_decompress(&out, 8).is_empty());
	}

	/// End-to-end through the container: write a frame with `GifWriter`,
	/// then pull the LZW payload back out of the file bytes and decode it.
	/// Covers the sub-block chunking and the image-descriptor layout as
	/// well as the codec — the encoder and the container have to agree for
	/// the pixels to survive.
	#[test]
	fn written_frame_decodes_back_to_the_same_indices() {
		// 64×64 with a diagonal pattern: enough distinct index runs that a
		// desynced code size would show up, and >255 compressed bytes so
		// the sub-block chunking is exercised.
		let (w, h) = (64usize, 64usize);
		let indices: Vec<u8> = (0..w * h).map(|i| ((i / 7 + i % 13) % 251) as u8).collect();
		let palette = vec![0u8; PALETTE_COLORS * 3];

		let mut buf = Vec::new();
		{
			let mut gw = GifWriter::new(&mut buf, w as u16, h as u16).unwrap();
			gw.write_header().unwrap();
			gw.write_netscape_loop(0).unwrap();
			gw.write_frame(&indices, &palette, 8, 12).unwrap();
			gw.finish().unwrap();
		}

		// Walk to the image descriptor (0x2C), skip its 9-byte body and the
		// 256-entry local table, then reassemble the sub-block chain.
		let img = buf.iter().position(|&b| b == 0x2C).expect("image descriptor");
		let mut p = img + 10 + PALETTE_COLORS * 3;
		assert_eq!(buf[p], 8, "LZW minimum code size");
		p += 1;
		let mut payload = Vec::new();
		while buf[p] != 0 {
			let len = buf[p] as usize;
			payload.extend_from_slice(&buf[p + 1..p + 1 + len]);
			p += 1 + len;
		}
		assert_eq!(lzw_decompress(&payload, 8), indices);
	}

	/// Median-cut on a 2-color image should produce 2 distinct
	/// palette entries (and pad the rest with the same average).
	#[test]
	fn median_cut_handles_two_color_image() {
		let rgba: Vec<u8> = (0..100)
			.flat_map(|i| if i % 2 == 0 { [255, 0, 0, 255] } else { [0, 0, 255, 255] })
			.collect();
		let mut palette = vec![0u8; 256 * 3];
		build_palette_median_cut(&rgba, 256, &mut palette);
		// The first entries should be near pure red and pure blue;
		// the rest pad to the bucket average (whichever the
		// algorithm picked first).
		let has_red = palette.chunks_exact(3).any(|c| c[0] > 200 && c[1] < 50 && c[2] < 50);
		let has_blue = palette.chunks_exact(3).any(|c| c[2] > 200 && c[0] < 50 && c[1] < 50);
		assert!(has_red, "median-cut dropped red");
		assert!(has_blue, "median-cut dropped blue");
	}

	/// Median-cut on a uniform image (single color) must not
	/// loop forever and must produce a non-empty palette.
	#[test]
	fn median_cut_uniform_image_does_not_hang() {
		let rgba = vec![128u8; 4 * 100];
		let mut palette = vec![0u8; 256 * 3];
		build_palette_median_cut(&rgba, 256, &mut palette);
		// Every entry is near gray.
		for chunk in palette.chunks_exact(3) {
			assert!((chunk[0] as i32 - 128).abs() < 4);
			assert!((chunk[1] as i32 - 128).abs() < 4);
			assert!((chunk[2] as i32 - 128).abs() < 4);
		}
	}

	/// Nearest-color mapping: every index is in [0, 256) and the
	/// output length matches the input.
	#[test]
	fn map_to_indices_covers_all_pixels() {
		// Use `wrapping_mul` so the test palette stays inside u8
		// without overflowing (the production palette is built by
		// median-cut and never overflows, but a test palette
		// built from a closed-form expression can).
		let palette: Vec<u8> = (0..256u32)
			.flat_map(|i| {
				let i = i as u8;
				[i.wrapping_mul(3), i.wrapping_mul(5), i.wrapping_mul(7)]
			})
			.collect();
		let rgba: Vec<u8> = (0..1000u32)
			.flat_map(|i| {
				let i = i as u8;
				[i, i.wrapping_mul(2), i.wrapping_mul(3), 255]
			})
			.collect();
		let mut indices = vec![0u8; 1000];
		map_to_indices(&palette, &rgba, &mut indices);
		assert_eq!(indices.len(), 1000);
		for &idx in &indices {
			assert!((idx as usize) < PALETTE_COLORS);
		}
	}

	/// The dither path doesn't crash on a 1×1 image (the boundary
	/// cases — `x + 1 < w`, `x > 0` — are where off-by-one errors
	/// show up) and maps the single pixel into the palette.
	#[test]
	fn dithered_mapping_handles_one_by_one() {
		let rgba = vec![100u8, 150, 200, 255];
		let palette = vec![0u8; PALETTE_COLORS * 3];
		let mut err_cur = vec![0.0f32; 3];
		let mut err_next = vec![0.0f32; 3];
		let mut indices = vec![0u8; 1];
		map_to_indices_dithered(
			&palette,
			&rgba,
			1,
			1,
			&mut err_cur,
			&mut err_next,
			&mut indices,
		);
		assert!((indices[0] as usize) < PALETTE_COLORS);
	}

	/// `GifWriter::new` rejects zero dimensions.
	#[test]
	fn gif_writer_rejects_zero_dimensions() {
		let mut buf = Vec::new();
		assert!(GifWriter::new(&mut buf, 0, 100).is_err());
		assert!(GifWriter::new(&mut buf, 100, 0).is_err());
	}

	/// Sub-block writer chops a 600-byte payload into 3 blocks
	/// (255 + 255 + 90). The terminator byte is written by the
	/// caller, not by `write_sub_blocks` itself — it's a
	/// stream-of-sub-blocks, and the terminator's position is a
	/// concern of the GIF89a container.
	#[test]
	fn sub_blocks_chop_at_255() {
		let mut buf = Vec::new();
		let payload = vec![0xAAu8; 600];
		write_sub_blocks(&mut Cursor::new(&mut buf), &payload).unwrap();
		// 3 size bytes (255, 255, 90) + 600 payload bytes = 603.
		assert_eq!(buf.len(), 603);
		assert_eq!(buf[0], 255);
		assert_eq!(buf[256], 255); // start of the second block
		assert_eq!(buf[512], 90); // start of the third block
		// No terminator in `write_sub_blocks` itself — the
		// last byte is the last data byte of the third block.
		assert_eq!(*buf.last().unwrap(), 0xAA);
	}
}
