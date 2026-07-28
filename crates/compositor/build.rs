use std::env;
use std::path::{Path, PathBuf};

fn main() {
    // La cible réelle est connue via `CARGO_CFG_TARGET_OS` (renseigné par cargo
    // pour chaque build). `cfg!(target_os = "macos")` est faux ici : build.rs
    // s'exécute sur le HOST, pas sur la cible.
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_is_macos = target_os == "macos";

    // Le pin ffmpeg est porté par `.cargo/config.toml` ; sur Windows c'est le
    // BtbN n8.1.2-win64-lgpl-shared, sur macOS c'est l'équivalent .dylib (à venir —
    // voir `crates/fixture/fixture.json` pour le pin exact quand la dépendance
    // sera ajoutée).
    let ff = match env::var("FFMPEG_DIR") {
        Ok(v) => Some(v),
        Err(_) => {
            if target_is_macos {
                // Cherche d'abord `MAC_FFMPEG_DIR`, puis un répertoire attendu dans
                // `crates/thirdparty/ffmpeg-*` aligné sur la disposition Windows.
                env::var("MAC_FFMPEG_DIR").ok().or_else(|| {
                    let candidate = Path::new("thirdparty").join("ffmpeg-n8.1.2-macos64-lgpl-shared");
                    if candidate.exists() {
                        Some(candidate.to_string_lossy().to_string())
                    } else {
                        None
                    }
                })
            } else {
                None
            }
        }
    };

    let include_dir = match ff.as_ref() {
        Some(v) => Path::new(v).join("include").to_string_lossy().to_string(),
        None => panic!(
            "crates/compositor build.rs: FFMPEG_DIR non défini (target={}). \
             Sur Windows, voir crates/.cargo/config.toml. Sur macOS, poser \
             MAC_FFMPEG_DIR ou vendoriser thirdparty/ffmpeg-n8.1.2-macos64-lgpl-shared.",
            target_os
        ),
    };

    // --- linkage : les import libs LGPL ---
    if let Some(v) = ff.as_ref() {
        let lib_dir = Path::new(v).join("lib");
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        for lib in ["avformat", "avcodec", "avutil", "swscale", "swresample"] {
            println!("cargo:rustc-link-lib=dylib={}", lib);
        }
    }

    // Le wrapper.h à binder dépend de la plateforme cible :
    //   - Windows : D3D11VA (ID3D11VA*),
    //   - macOS   : VideoToolbox (AVVideotoolboxContext).
    let wrapper = if target_is_macos {
        "wrapper_macos.h"
    } else {
        "wrapper_windows.h"
    };

    println!("cargo:rerun-if-changed={}", wrapper);
    println!("cargo:rerun-if-changed=shim.c");
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");
    println!("cargo:rerun-if-env-changed=MAC_FFMPEG_DIR");

    // shim C : accesseurs pour les structs que bindgen rend opaques (AVFormatContext).
    // Sur macOS, cc utilise clang par défaut ; sur Windows, MSVC via vcvars (cf. x.bat).
    cc::Build::new()
        .file("shim.c")
        .include(&include_dir)
        .compile("sn_shim");

    // --- bindings générés sur les VRAIS headers 8.x (immunisé contre la version) ---
    // Cible clang explicite pour que les layouts matchent le runtime de prod (FFmpeg
    // pinne ses enums/structs pour clang sur macOS, MSVC sur Windows).
    let mut builder = bindgen::Builder::default()
        .header(wrapper)
        .clang_arg(format!("-I{}", include_dir))
        .allowlist_function("av.*")
        .allowlist_function("avcodec_.*")
        .allowlist_function("avformat_.*")
        .allowlist_function("avio_.*")
        .allowlist_function("swr_.*")
        .allowlist_function("sws_.*")
        .allowlist_type("AV.*")
        .allowlist_type("SwrContext")
        .allowlist_type("SwsContext")
        .allowlist_var("SWS_.*")
        .allowlist_var("AV_.*")
        .allowlist_var("AVERROR.*")
        .allowlist_var("FF_.*")
        .allowlist_var("AVIO_.*")
        // enums en constantes simples : plus simple à manipuler en FFI brut
        .default_enum_style(bindgen::EnumVariation::ModuleConsts)
        .derive_default(true)
        .layout_tests(false);

    // Sur macOS le bindgen doit viser aarch64-apple-darwin pour que les layouts
    // générés (long=8, etc.) matchent la cible. Sans ce flag, bindgen utilise
    // le défaut du host (probablement x86_64), et les structs ffmpeg sont mal
    // dimensionnés au link. On laisse bindgen chercher le sysroot via `xcrun`
    // pour rester robuste aux variations Xcode (CommandLineTools vs Xcode.app,
    // versions 14.x → 15.x).
    if target_is_macos {
        builder = builder.clang_arg("--target=aarch64-apple-darwin");
        if let Ok(sysroot) = std::process::Command::new("xcrun")
            .args(["--show-sdk-path", "--sdk", "macosx"])
            .output()
        {
            if let Ok(s) = std::str::from_utf8(&sysroot.stdout) {
                let s = s.trim();
                if !s.is_empty() {
                    builder = builder.clang_arg("-isysroot").clang_arg(s);
                }
            }
        }
    }

    let bindings = builder
        .generate()
        .expect("bindgen a échoué sur les headers ffmpeg");

    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out.join("ffi.rs"))
        .expect("écriture ffi.rs");
}