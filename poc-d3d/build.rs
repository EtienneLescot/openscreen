use std::env;
use std::path::PathBuf;

fn main() {
    let ff = env::var("FFMPEG_DIR").expect("FFMPEG_DIR non défini (voir .cargo/config.toml)");

    // --- linkage : les import libs LGPL de BtbN ---
    println!("cargo:rustc-link-search=native={}\\lib", ff);
    for lib in ["avformat", "avcodec", "avutil", "swscale", "swresample"] {
        println!("cargo:rustc-link-lib=dylib={}", lib);
    }

    println!("cargo:rerun-if-changed=wrapper.h");
    println!("cargo:rerun-if-changed=shim.c");
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");

    // shim C : accesseurs pour les structs que bindgen rend opaques (AVFormatContext).
    cc::Build::new()
        .file("shim.c")
        .include(format!("{}\\include", ff))
        .compile("sn_shim");

    // --- bindings générés sur les VRAIS headers 8.x (immunisé contre la version) ---
    let bindings = bindgen::Builder::default()
        .header("wrapper.h")
        .clang_arg(format!("-I{}\\include", ff))
        .allowlist_function("av.*")
        .allowlist_function("avcodec_.*")
        .allowlist_function("avformat_.*")
        .allowlist_function("avio_.*")
        .allowlist_type("AV.*")
        .allowlist_var("AV_.*")
        .allowlist_var("AVERROR.*")
        .allowlist_var("FF_.*")
        .allowlist_var("AVIO_.*")
        // enums en constantes simples : plus simple à manipuler en FFI brut
        .default_enum_style(bindgen::EnumVariation::ModuleConsts)
        .derive_default(true)
        .layout_tests(false)
        .generate()
        .expect("bindgen a échoué sur les headers ffmpeg");

    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out.join("ffi.rs"))
        .expect("écriture ffi.rs");
}
