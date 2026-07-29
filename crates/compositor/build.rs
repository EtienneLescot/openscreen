use std::env;
use std::path::{Path, PathBuf};

fn main() {
    // La cible réelle est connue via `CARGO_CFG_TARGET_OS` (renseigné par cargo
    // pour chaque build). `cfg!(target_os = "macos")` est faux ici : build.rs
    // s'exécute sur le HOST, pas sur la cible.
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_is_macos = target_os == "macos";

    if target_is_macos {
        point_libclang_at_the_xcode_toolchain();
    }

    // Le pin ffmpeg est porté par `.cargo/config.toml` ; sur Windows c'est le
    // BtbN n8.1.2-win64-lgpl-shared, sur macOS c'est l'équivalent .dylib (à venir —
    // voir `crates/fixture/fixture.json` pour le pin exact quand la dépendance
    // sera ajoutée).
    // Sur macOS, `MAC_FFMPEG_DIR` passe AVANT `FFMPEG_DIR`. Ce n'est pas une préférence
    // de style : `crates/.cargo/config.toml` pose `FFMPEG_DIR` dans un `[env]` global —
    // cargo n'a pas de `[target.<cfg>.env]`, la section macOS y est inerte — donc
    // `FFMPEG_DIR` est TOUJOURS renseigné, et pointe sur l'arbre win64. Le lire d'abord
    // rendait le fallback macOS ci-dessous inatteignable : bindgen partait sur
    // `thirdparty/ffmpeg-n8.1.2-win64-lgpl-shared/include`, qui n'existe pas sur un Mac.
    let ff = if target_is_macos {
        // `MAC_FFMPEG_DIR` explicite (CI / dev), sinon l'arbre vendorisé attendu sous
        // `crates/thirdparty/`, aligné sur la disposition Windows. `FFMPEG_DIR` ne sert
        // de recours que s'il désigne un arbre qui existe VRAIMENT — c'est-à-dire quand
        // un dev l'a posé à la main pour macOS, jamais quand il vient du pin Windows.
        env::var("MAC_FFMPEG_DIR")
            .ok()
            .filter(|v| Path::new(v).join("include").exists())
            .or_else(|| {
                // `thirdparty/` est frère de `compositor/`, sous `crates/` — c'est aussi
                // ce que le pin Windows désigne (`relative = true` dans
                // `crates/.cargo/config.toml`, relatif au dossier de la config).
                // build.rs s'exécute avec cwd = racine du crate, pas `crates/`, donc on
                // remonte depuis CARGO_MANIFEST_DIR plutôt que d'écrire un chemin relatif
                // qui viserait `crates/compositor/thirdparty/`.
                let candidate = Path::new(&env::var("CARGO_MANIFEST_DIR").ok()?)
                    .parent()?
                    .join("thirdparty")
                    .join("ffmpeg-n8.1.2-macos64-lgpl-shared");
                candidate
                    .join("include")
                    .exists()
                    .then(|| candidate.to_string_lossy().to_string())
            })
            .or_else(|| {
                env::var("FFMPEG_DIR")
                    .ok()
                    .filter(|v| Path::new(v).join("include").exists())
            })
    } else {
        env::var("FFMPEG_DIR").ok()
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

/// Pose `LIBCLANG_PATH` sur la toolchain Xcode/CommandLineTools active, pour bindgen.
///
/// Nécessaire parce que `crates/.cargo/config.toml` pose `LIBCLANG_PATH` dans un `[env]`
/// GLOBAL, avec la valeur Windows (`C:\Program Files\LLVM\bin`). Cargo n'a pas de
/// `[target.<cfg>.env]` — la section macOS du fichier est inerte, cargo la signale
/// d'ailleurs en `unused key` — donc sur un Mac clang-sys reçoit un chemin Windows,
/// n'y trouve rien, et n'essaie même pas la découverte par défaut : il échoue sur
/// « Unable to find libclang ». On écrase donc la valeur ici, dans le seul processus
/// qui la lit.
///
/// `xcrun --find clang` donne `<toolchain>/usr/bin/clang` ; `libclang.dylib` est deux
/// niveaux plus haut, dans `<toolchain>/usr/lib`. Ça marche pour Xcode.app comme pour
/// CommandLineTools, et suit un `xcode-select` qui bouge — ce qu'un chemin en dur ne
/// ferait pas. Un `LIBCLANG_PATH` déjà valide (dev qui pointe une LLVM Homebrew) est
/// respecté.
fn point_libclang_at_the_xcode_toolchain() {
    println!("cargo:rerun-if-env-changed=LIBCLANG_PATH");
    if let Ok(v) = env::var("LIBCLANG_PATH") {
        if Path::new(&v).join("libclang.dylib").exists() {
            return;
        }
    }
    let clang = std::process::Command::new("xcrun")
        .args(["--find", "clang"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let lib_dir = clang
        .as_deref()
        .map(Path::new)
        // <toolchain>/usr/bin/clang -> <toolchain>/usr
        .and_then(|p| p.parent()?.parent().map(|usr| usr.join("lib")))
        .filter(|d| d.join("libclang.dylib").exists());
    match lib_dir {
        Some(d) => env::set_var("LIBCLANG_PATH", d),
        // Rien trouvé : retirer la valeur Windows plutôt que la laisser saboter la
        // découverte par défaut de clang-sys, qui sait aussi chercher toute seule.
        None => env::remove_var("LIBCLANG_PATH"),
    }
}