// Two build inputs, with deliberately different linkage strategies.
//
// PIPEWIRE is compiled from csrc/pw_shim.c against the vendored headers and NOT
// linked: the shim resolves every libpipewire symbol with dlsym at runtime, so
// the only build requirement is a C compiler. That is what makes this crate
// buildable on a machine with no libpipewire-0.3-dev, which is most machines —
// Ubuntu ships only the runtime .so.0.
//
// FFMPEG is linked normally against the tree the app already vendors for the
// compositor. See Cargo.toml for why that is safe here and nowhere else: this is
// a separate process, so Chromium's `libffmpeg.so` is not in its address space
// and the symbol collision that forces the addon's `osff_` renaming cannot
// happen. RUNPATH points at $ORIGIN so the packaged binary finds the .so files
// staged beside it, and at the vendored lib dir so a dev build runs from the
// repo without LD_LIBRARY_PATH.

use std::path::{Path, PathBuf};

fn main() {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    build_pipewire_shim(&root);
    link_ffmpeg(&root);
}

fn build_pipewire_shim(root: &Path) {
    let vendor = root.join("vendor/pipewire-1.0.5/include");
    let sources = ["csrc/pw_shim.c", "csrc/pw_audio.c", "csrc/dmabuf_modifiers.c"];

    assert!(
        vendor.join("pipewire/pipewire.h").is_file(),
        "vendored PipeWire headers are missing at {} — see vendor/README.md",
        vendor.display()
    );

    let mut build = cc::Build::new();
    for source in sources {
        build.file(root.join(source));
    }
    build
        .include(&vendor)
        .include(root.join("csrc"))
        .flag_if_supported("-std=gnu11")
        .warnings(true)
        .compile("openscreen_pw_shim");

    for source in sources {
        println!("cargo:rerun-if-changed={}", root.join(source).display());
    }
    println!("cargo:rerun-if-changed={}", root.join("csrc/pw_shim.h").display());
    println!("cargo:rerun-if-changed={}", root.join("csrc/pw_internal.h").display());
    println!("cargo:rerun-if-changed={}", vendor.display());

    // dlopen/dlsym.
    println!("cargo:rustc-link-lib=dl");
}

/// Extra `-I` flags so clang can find the freestanding headers it normally ships
/// with itself (`stddef.h`, `limits.h`, `stdint.h`).
///
/// Ubuntu splits libclang: `libclang.so.1` comes from the runtime package while
/// the builtin header directory comes from `libclang-N-dev`. With only the
/// former installed — the common case — parsing any real header fails on
/// `/usr/include/limits.h: 'limits.h' file not found`, because glibc's copy
/// `#include_next`s the compiler's and there is none. gcc's copies are
/// interchangeable for this purpose, so point clang at those instead of making
/// every contributor install a second toolchain.
///
/// Twin of `freestanding_header_args()` in crates/compositor/build.rs. Both live in
/// build.rs rather than in the npm build scripts so that a bare `cargo build` works
/// too — scripts/build-linux-compositor-addon.mjs used to carry a copy of this, and
/// `cargo check -p openscreen-compositor` stayed broken for as long as it did.
fn freestanding_header_args() -> Vec<String> {
    if let Ok(extra) = std::env::var("BINDGEN_EXTRA_CLANG_ARGS") {
        // Already configured by the caller; bindgen picks that up on its own.
        if !extra.trim().is_empty() {
            return Vec::new();
        }
    }
    // The vendor triplet is NOT hardcoded. It is `x86_64-linux-gnu` on Debian/Ubuntu
    // amd64 but `aarch64-linux-gnu` on arm64 — hardcoding the former is why bindgen
    // died with "'limits.h' file not found" there — and neither on Arch
    // (`x86_64-pc-linux-gnu`). Matching on the target arch prefix covers all of them,
    // and on a box with a cross-gcc installed it still refuses the OTHER
    // architecture's headers, whose type widths would be wrong.
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH")
        .unwrap_or_else(|_| std::env::consts::ARCH.to_string());
    let prefix = format!("{arch}-");
    let Ok(vendors) = std::fs::read_dir("/usr/lib/gcc") else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = vendors
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .filter_map(|vendor| std::fs::read_dir(vendor.path()).ok())
        .flatten()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().join("include"))
        .filter(|dir| dir.join("limits.h").is_file() && dir.join("stddef.h").is_file())
        .collect();
    // Highest gcc version first, so a machine with several picks the newest.
    dirs.sort();
    dirs.reverse();
    dirs.into_iter()
        .take(1)
        .map(|dir| format!("-I{}", dir.display()))
        .collect()
}

/// The vendored ffmpeg tree, five directories up from this crate. `FFMPEG_DIR`
/// overrides it for CI or a cross build.
fn ffmpeg_dir(root: &Path) -> PathBuf {
    if let Some(dir) = std::env::var_os("FFMPEG_DIR") {
        return PathBuf::from(dir);
    }
    root.join("../../../crates/thirdparty/ffmpeg-linux64-lgpl-shared")
}

fn link_ffmpeg(root: &Path) {
    let dir = ffmpeg_dir(root);
    let include = dir.join("include");
    let lib = dir.join("lib");

    assert!(
        include.join("libavcodec/avcodec.h").is_file(),
        "vendored ffmpeg headers are missing at {} — run `npm run fetch:ffmpeg` or set FFMPEG_DIR",
        include.display()
    );

    println!("cargo:rustc-link-search=native={}", lib.display());
    // avfilter is for the VAAPI VPP (scale_vaapi) that converts an imported
    // dmabuf surface to NV12 for the encoder — see the dmabuf import path.
    for name in ["avcodec", "avformat", "avutil", "avfilter", "swscale", "swresample"] {
        println!("cargo:rustc-link-lib={name}");
    }
    // A SUBDIRECTORY, NOT `$ORIGIN`. The helper is staged into
    // electron/native/bin/linux-x64/, and that directory ALREADY contains
    // libavcodec.so.62 and friends — the copies whose every symbol was renamed
    // to `osff_*` by scripts/build-linux-compositor-addon.mjs so the compositor
    // addon does not collide with Chromium's ffmpeg inside Electron. Searching
    // `$ORIGIN` finds those first and the helper dies at startup with
    // "undefined symbol: avcodec_send_frame, version LIBAVCODEC_62". The
    // renaming trick is what makes the ADDON work and what would break the
    // HELPER, so the two sets of libraries must not share a directory.
    //
    // `helper-ffmpeg` and not `ffmpeg`, which is what this used to be: that name
    // is also where fetch-ffmpeg.mjs vendors the static ffmpeg EXECUTABLE, and
    // where audioPeaks.ts looks for it. Three artifacts, one path — whichever
    // ran last won, and the loser failed with EEXIST from mkdir or EACCES from
    // spawn, neither of which names the real problem. A directory called
    // `ffmpeg` full of shared objects is also simply a lie about its contents.
    //
    // The absolute vendored path comes second so `cargo run` works straight out
    // of the repo. `--disable-new-dtags` is what makes these RUNPATH entries
    // apply to the transitive ffmpeg libs too; with the default DT_RUNPATH they
    // would not.
    println!("cargo:rustc-link-arg=-Wl,--disable-new-dtags");
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/helper-ffmpeg");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());

    let mut builder = bindgen::Builder::default();
    for arg in freestanding_header_args() {
        builder = builder.clang_arg(arg);
    }
    let bindings = builder
        .header_contents(
            "ffmpeg.h",
            r#"
            #include <libavcodec/avcodec.h>
            #include <libavformat/avformat.h>
            #include <libavutil/avutil.h>
            #include <libavutil/hwcontext.h>
            #include <libavutil/hwcontext_drm.h>
            #include <libavutil/imgutils.h>
            #include <libavutil/opt.h>
            #include <libavfilter/avfilter.h>
            #include <libavfilter/buffersrc.h>
            #include <libavfilter/buffersink.h>
            #include <libswresample/swresample.h>
            #include <libswscale/swscale.h>
            "#,
        )
        .clang_arg(format!("-I{}", include.display()))
        // An allowlist rather than the whole tree: it keeps the generated file
        // to what this helper calls, and keeps `cargo build` from regenerating
        // thousands of items nothing references.
        .allowlist_function("av_.*")
        .allowlist_function("avcodec_.*")
        .allowlist_function("avformat_.*")
        .allowlist_function("avio_.*")
        .allowlist_function("avfilter_.*")
        .allowlist_function("av_buffersrc_.*")
        .allowlist_function("av_buffersink_.*")
        .allowlist_function("sws_.*")
        .allowlist_function("swr_.*")
        .allowlist_type("AV.*")
        .allowlist_type("Sws.*")
        .allowlist_type("SwrContext")
        .allowlist_var("AV_.*")
        .allowlist_var("AVERROR.*")
        .allowlist_var("FF_.*")
        .allowlist_var("SWS_.*")
        .derive_default(true)
        .prepend_enum_name(false)
        .layout_tests(false)
        // ffmpeg's headers are riddled with doc comments that are not valid
        // rustdoc; without this every build emits hundreds of warnings.
        .generate_comments(false)
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .generate()
        .expect("bindgen failed on the ffmpeg headers");

    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("ffmpeg_sys.rs");
    bindings.write_to_file(&out).expect("could not write ffmpeg bindings");

    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");
}
