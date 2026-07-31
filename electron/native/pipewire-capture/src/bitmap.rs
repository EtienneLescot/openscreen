//! SPA cursor bitmap → PNG data URL.
//!
//! The renderer consumes `NativeCursorAsset.imageDataUrl` (see
//! src/native/contracts.ts) exactly as the macOS helper produces it: a base64
//! `data:image/png` string, keyed by the SHA-256 of the PNG bytes so the same
//! shape is only ever serialised once.
//!
//! UNVERIFIED: Wayland cursor buffers are conventionally PREMULTIPLIED alpha,
//! and PNG expects straight alpha. No sprite has been observed on real hardware
//! yet (Stage 1's `debug` instrumentation exists to find out whether GNOME even
//! sends one), so the channels are copied through unchanged rather than
//! un-premultiplied on a guess. If sprites come back with dark fringes on their
//! antialiased edges, that is the bug, and the fix belongs here.

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::shim::{Constants, CursorBitmap};

/// Refuse anything larger. Kept in step with the cursor metadata ceiling
/// negotiated in pw_shim.c (OSC_CURSOR_META_SIZE(1024, 1024)): a bitmap bigger
/// than the block we agreed to accept means the producer and this process
/// disagree about the buffer. For reference, mutter's own plane is 384×384 and
/// a real GNOME cursor is 24–96 px.
const MAX_DIMENSION: u32 = 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct EncodedCursor {
    pub id: String,
    pub image_data_url: String,
    pub width: u32,
    pub height: u32,
}

/// Byte offsets of R, G, B, A within one source pixel, or `None` when the
/// format is not a 32-bit packed one we understand.
fn channel_order(constants: &Constants, format: u32) -> Option<[usize; 4]> {
    // Written as a lookup against the values the C shim read out of the
    // vendored headers, never against hardcoded enum numbers.
    let table = [
        (constants.video_format_rgbx, [0, 1, 2, 3]),
        (constants.video_format_bgrx, [2, 1, 0, 3]),
        (constants.video_format_xrgb, [1, 2, 3, 0]),
        (constants.video_format_xbgr, [3, 2, 1, 0]),
        (constants.video_format_rgba, [0, 1, 2, 3]),
        (constants.video_format_bgra, [2, 1, 0, 3]),
        (constants.video_format_argb, [1, 2, 3, 0]),
        (constants.video_format_abgr, [3, 2, 1, 0]),
    ];
    table
        .iter()
        .find(|(id, _)| *id == format)
        .map(|(_, order)| *order)
}

/// True when the format has no alpha channel, so the 4th byte is padding and
/// must be replaced by opaque rather than copied.
fn is_opaque(constants: &Constants, format: u32) -> bool {
    format == constants.video_format_rgbx
        || format == constants.video_format_bgrx
        || format == constants.video_format_xrgb
        || format == constants.video_format_xbgr
}

pub fn encode(constants: &Constants, bitmap: &CursorBitmap) -> Result<EncodedCursor, String> {
    if bitmap.width <= 0 || bitmap.height <= 0 {
        return Err(format!(
            "cursor bitmap has a non-positive size ({}x{})",
            bitmap.width, bitmap.height
        ));
    }
    let width = bitmap.width as u32;
    let height = bitmap.height as u32;
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(format!("cursor bitmap is implausibly large ({width}x{height})"));
    }

    let order = channel_order(constants, bitmap.format)
        .ok_or_else(|| format!("unsupported cursor bitmap format id {}", bitmap.format))?;
    let opaque = is_opaque(constants, bitmap.format);

    let stride = usize::try_from(bitmap.stride).map_err(|_| "negative stride".to_owned())?;
    let row_bytes = width as usize * 4;
    if stride < row_bytes {
        return Err(format!("stride {stride} is shorter than one {width}px row"));
    }
    // The C side already bounds-checked this against the metadata block; repeat
    // it here so the slicing below cannot panic even if that ever regresses.
    let needed = stride
        .checked_mul(height as usize)
        .ok_or_else(|| "cursor bitmap size overflows".to_owned())?;
    if bitmap.pixels.len() < needed {
        return Err(format!(
            "cursor bitmap is truncated: {} bytes for {}x{} at stride {}",
            bitmap.pixels.len(),
            width,
            height,
            stride
        ));
    }

    let mut rgba = Vec::with_capacity(row_bytes * height as usize);
    for row in 0..height as usize {
        let line = &bitmap.pixels[row * stride..row * stride + row_bytes];
        for pixel in line.chunks_exact(4) {
            rgba.push(pixel[order[0]]);
            rgba.push(pixel[order[1]]);
            rgba.push(pixel[order[2]]);
            rgba.push(if opaque { 0xff } else { pixel[order[3]] });
        }
    }

    let png = encode_png(width, height, &rgba)?;
    let id = Sha256::digest(&png)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let image_data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );

    Ok(EncodedCursor {
        id,
        image_data_url,
        width,
        height,
    })
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("png header: {error}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|error| format!("png data: {error}"))?;
    }
    Ok(png)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn constants() -> Constants {
        // Read from the compiled C shim, so the test also proves the Rust view
        // of the SPA enum matches the vendored headers.
        crate::shim::constants()
    }

    fn bitmap(format: u32, width: i32, height: i32, stride: i32, pixels: Vec<u8>) -> CursorBitmap {
        CursorBitmap {
            format,
            width,
            height,
            stride,
            pixels,
        }
    }

    fn decode(data_url: &str) -> (png::OutputInfo, Vec<u8>) {
        let base64 = data_url
            .strip_prefix("data:image/png;base64,")
            .expect("data url prefix");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64)
            .expect("base64");
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().expect("png info");
        let mut buffer = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buffer).expect("png frame");
        buffer.truncate(info.buffer_size());
        (info, buffer)
    }

    #[test]
    fn spa_format_ids_are_distinct() {
        // Guards against the constants struct being mis-ordered between C and Rust:
        // a field-order mismatch would collapse several of these onto one value.
        let c = constants();
        let ids = [
            c.video_format_rgbx,
            c.video_format_bgrx,
            c.video_format_xrgb,
            c.video_format_xbgr,
            c.video_format_rgba,
            c.video_format_bgra,
            c.video_format_argb,
            c.video_format_abgr,
        ];
        let mut sorted = ids.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "duplicate SPA video format ids: {ids:?}");
        assert_ne!(c.data_mem_ptr, c.data_dma_buf);
    }

    #[test]
    fn bgra_channels_are_reordered_to_rgba() {
        let c = constants();
        // One pixel: B=1, G=2, R=3, A=4.
        let encoded = encode(&c, &bitmap(c.video_format_bgra, 1, 1, 4, vec![1, 2, 3, 4]))
            .expect("encode");
        let (info, pixels) = decode(&encoded.image_data_url);
        assert_eq!((info.width, info.height), (1, 1));
        assert_eq!(&pixels[..4], &[3, 2, 1, 4]);
    }

    #[test]
    fn argb_channels_are_reordered_to_rgba() {
        let c = constants();
        // One pixel: A=9, R=1, G=2, B=3.
        let encoded = encode(&c, &bitmap(c.video_format_argb, 1, 1, 4, vec![9, 1, 2, 3]))
            .expect("encode");
        let (_, pixels) = decode(&encoded.image_data_url);
        assert_eq!(&pixels[..4], &[1, 2, 3, 9]);
    }

    #[test]
    fn padding_byte_becomes_opaque_for_formats_without_alpha() {
        let c = constants();
        let encoded = encode(&c, &bitmap(c.video_format_bgrx, 1, 1, 4, vec![1, 2, 3, 0]))
            .expect("encode");
        let (_, pixels) = decode(&encoded.image_data_url);
        assert_eq!(&pixels[..4], &[3, 2, 1, 0xff]);
    }

    #[test]
    fn row_padding_is_skipped() {
        let c = constants();
        // 1px wide, 2 rows, stride 8: bytes 4..8 and 12..16 are padding.
        let pixels = vec![1, 2, 3, 4, 0xaa, 0xaa, 0xaa, 0xaa, 5, 6, 7, 8, 0xbb, 0xbb, 0xbb, 0xbb];
        let encoded =
            encode(&c, &bitmap(c.video_format_bgra, 1, 2, 8, pixels)).expect("encode");
        let (_, decoded) = decode(&encoded.image_data_url);
        assert_eq!(&decoded[..8], &[3, 2, 1, 4, 7, 6, 5, 8]);
    }

    #[test]
    fn identical_bitmaps_hash_to_the_same_asset_id() {
        let c = constants();
        let first = encode(&c, &bitmap(c.video_format_bgra, 1, 1, 4, vec![1, 2, 3, 4])).unwrap();
        let second = encode(&c, &bitmap(c.video_format_bgra, 1, 1, 4, vec![1, 2, 3, 4])).unwrap();
        let other = encode(&c, &bitmap(c.video_format_bgra, 1, 1, 4, vec![9, 9, 9, 9])).unwrap();
        assert_eq!(first.id, second.id);
        assert_ne!(first.id, other.id);
        assert_eq!(first.id.len(), 64, "sha-256 hex, like the macOS helper");
    }

    #[test]
    fn truncated_buffers_are_rejected_rather_than_sliced() {
        let c = constants();
        let error = encode(&c, &bitmap(c.video_format_bgra, 4, 4, 16, vec![0; 16]))
            .expect_err("must reject");
        assert!(error.contains("truncated"), "{error}");
    }

    #[test]
    fn short_stride_is_rejected() {
        let c = constants();
        let error = encode(&c, &bitmap(c.video_format_bgra, 4, 1, 8, vec![0; 64]))
            .expect_err("must reject");
        assert!(error.contains("shorter"), "{error}");
    }

    #[test]
    fn implausible_dimensions_are_rejected() {
        let c = constants();
        let error = encode(&c, &bitmap(c.video_format_bgra, 4096, 1, 16384, vec![0; 16384]))
            .expect_err("must reject");
        assert!(error.contains("implausibly large"), "{error}");
    }

    #[test]
    fn unknown_formats_are_reported_not_guessed() {
        let c = constants();
        let error =
            encode(&c, &bitmap(u32::MAX, 1, 1, 4, vec![0; 4])).expect_err("must reject");
        assert!(error.contains("unsupported"), "{error}");
    }
}
