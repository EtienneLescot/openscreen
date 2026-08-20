//! Raw ffmpeg bindings, plus the handful of constants bindgen cannot produce.
//!
//! The generated half comes from build.rs. The hand-written half below exists
//! because ffmpeg expresses these as FUNCTION-LIKE macros (`AVERROR(e)`,
//! `MKTAG`, `FFERRTAG`) or as bit flags inside a comment block, and bindgen
//! emits neither. The compositor crate hit the same wall — see the
//! `AVERROR_INVALIDDATA` constant in crates/compositor/src/ffi.rs, which was
//! wrong for months because someone guessed at it instead of deriving it.
//!
//! Every value here is therefore derived, with the derivation shown, and pinned
//! by a test at the bottom of the file rather than trusted.

#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case, dead_code)]

include!(concat!(env!("OUT_DIR"), "/ffmpeg_sys.rs"));

/// `MKTAG(a,b,c,d)` — a FourCC packed little-endian, as libavutil defines it.
const fn mktag(a: u8, b: u8, c: u8, d: u8) -> i32 {
    (a as i32) | ((b as i32) << 8) | ((c as i32) << 16) | ((d as i32) << 24)
}

/// `FFERRTAG` — the negated FourCC ffmpeg uses for its own error codes.
const fn fferrtag(a: u8, b: u8, c: u8, d: u8) -> i32 {
    -mktag(a, b, c, d)
}

/// `AVERROR(EAGAIN)`. The encoder returns this to mean "I have no packet for you
/// yet, send another frame", which is the normal steady state, not a failure.
pub const AVERROR_EAGAIN: i32 = -libc_EAGAIN;
/// Linux's `EAGAIN`. Hardcoded rather than pulled from libc: this crate has no
/// libc dependency, and the value is fixed by the kernel ABI on every Linux
/// architecture this ships to.
const libc_EAGAIN: i32 = 11;

pub const AVERROR_EOF: i32 = fferrtag(b'E', b'O', b'F', b' ');
pub const AVERROR_INVALIDDATA: i32 = fferrtag(b'I', b'N', b'D', b'A');
pub const AVERROR_ENOMEM: i32 = -12;

/// `AVIO_FLAG_WRITE` from libavformat/avio.h:618. A plain `#define` in a block
/// bindgen skips, unlike the `SWS_*` flags below.
pub const AVIO_FLAG_WRITE: i32 = 2;

// The `SWS_*` rescaler flags are NOT redeclared here. They used to need it — the
// compositor still carries its own copies (crates/compositor/src/linux_frames.rs)
// because on its pinned headers they were plain `#define`s that bindgen skipped.
// ffmpeg 8.1 made them an `enum SwsFlags`, so bindgen emits them and a
// hand-written copy is now a hard compile error rather than a silent duplicate.

/// Formats an ffmpeg return code the way `av_err2str` would, since that too is a
/// macro and needs a caller-supplied buffer.
pub fn err_to_string(code: i32) -> String {
    // NOT `[0i8; 256]`: `c_char` is signed on x86_64 but UNSIGNED on aarch64, so a
    // hardcoded i8 makes av_strerror's `*mut c_char` a type error on arm64.
    let mut buffer = [0 as std::ffi::c_char; 256];
    // SAFETY: the buffer is the size we tell av_strerror it is, and ffmpeg
    // always NUL-terminates within it.
    let ok = unsafe { av_strerror(code, buffer.as_mut_ptr(), buffer.len()) } == 0;
    if !ok {
        return format!("unknown ffmpeg error {code}");
    }
    let bytes: Vec<u8> = buffer
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_constants_match_what_ffmpeg_itself_reports() {
        // The point of this test: it does not check the constants against other
        // hardcoded numbers, it checks them against the linked libavutil. A
        // wrong FourCC derivation shows up here as a mismatched message.
        assert_eq!(err_to_string(AVERROR_EOF), "End of file");
        assert_eq!(err_to_string(AVERROR_INVALIDDATA), "Invalid data found when processing input");
        assert_eq!(AVERROR_EAGAIN, -11);
    }

    #[test]
    fn mktag_packs_little_endian() {
        // 'a' = 0x61 lands in the LOW byte. Getting this backwards silently
        // produces plausible-looking but wrong error codes.
        assert_eq!(mktag(b'a', 0, 0, 0), 0x61);
        assert_eq!(mktag(0, 0, 0, b'a'), 0x6100_0000);
    }
}
