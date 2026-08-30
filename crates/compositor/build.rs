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
    } else if target_os == "linux" {
        drop_unusable_libclang_path();
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
            .filter(|v| usable_ffmpeg_tree(Path::new(v)))
            .or_else(|| vendored_ffmpeg_tree("ffmpeg-n8.1.2-macos64-lgpl-shared"))
            .or_else(|| {
                env::var("FFMPEG_DIR")
                    .ok()
                    .filter(|v| usable_ffmpeg_tree(Path::new(v)))
            })
    } else if target_os == "linux" {
        // Même piège que LIBCLANG_PATH, même remède : le `FFMPEG_DIR` du `[env]` global
        // désigne l'arbre win64, qui n'existe pas ici, donc on ne l'accepte que s'il
        // pointe sur un arbre RÉEL — c'est-à-dire quand un dev ou
        // scripts/build-linux-compositor-addon.mjs l'a posé à la main. Sinon on retombe
        // sur l'emplacement vendorisé conventionnel, dans le même ordre que ce script
        // (`resolveFfmpegDir`), pour qu'un `cargo check` nu et un build via npm voient
        // le même arbre.
        env::var("FFMPEG_DIR")
            .ok()
            .filter(|v| usable_ffmpeg_tree(Path::new(v)))
            .or_else(|| vendored_ffmpeg_tree("ffmpeg-linux64-lgpl-shared"))
    } else {
        env::var("FFMPEG_DIR").ok()
    };

    let include_dir = match ff.as_ref() {
        Some(v) => Path::new(v).join("include").to_string_lossy().to_string(),
        None => panic!(
            "crates/compositor build.rs: aucun arbre ffmpeg utilisable (target={}). \
             Sur Windows, voir crates/.cargo/config.toml. Sur macOS, poser \
             MAC_FFMPEG_DIR ou vendoriser thirdparty/ffmpeg-n8.1.2-macos64-lgpl-shared. \
             Sur Linux, poser FFMPEG_DIR ou vendoriser \
             thirdparty/ffmpeg-linux64-lgpl-shared (arbre *shared*, avec include/ et \
             lib/ — celui de scripts/fetch-ffmpeg.mjs est statique et ne convient pas).",
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
    //   - macOS   : VideoToolbox (AVVideotoolboxContext),
    //   - Linux   : software/VAAPI, aucun hwcontext propriétaire (le d3d11.h /
    //               les headers VT n'existent pas → wrapper dédié).
    let wrapper = if target_is_macos {
        "wrapper_macos.h"
    } else if target_os == "linux" {
        "wrapper_linux.h"
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

    // Linux uniquement : cf. `freestanding_header_args()`. Sur macOS le sysroot arrive
    // par `xcrun` juste en dessous, sur Windows par MSVC — dans les deux cas clang a
    // déjà ses en-têtes builtin et injecter ceux de gcc n'aurait aucun sens.
    if target_os == "linux" {
        for arg in freestanding_header_args() {
            builder = builder.clang_arg(arg);
        }
    }

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
    let ffi_path = out.join("ffi.rs");
    bindings.write_to_file(&ffi_path).expect("écriture ffi.rs");

    // Sur Linux, les symboles ffmpeg des .so vendorisés sont renommés avec un préfixe
    // avant l'édition de liens (cf. scripts/build-linux-compositor-addon.mjs). Il faut
    // donc que CES déclarations importent les noms préfixés — sinon l'éditeur de liens
    // ne trouve rien, ou pire, l'addon se rattache au ffmpeg de Chromium au runtime.
    if let Ok(prefix) = env::var("OPENSCREEN_FFMPEG_SYMBOL_PREFIX") {
        prefix_ffmpeg_symbols(&ffi_path, &prefix);
    }
}

/// Flags `-I` supplémentaires pour que clang trouve les en-têtes « freestanding » qu'il
/// embarque normalement lui-même (`stddef.h`, `limits.h`, `stdint.h`).
///
/// Ubuntu scinde libclang : `libclang.so.1` vient du paquet runtime, le répertoire
/// d'en-têtes builtin de `libclang-N-dev`. Avec seulement le premier — le cas courant —
/// parser n'importe quel header réel échoue sur
/// `/usr/include/stdio.h: 'stddef.h' file not found`, parce que la copie de la glibc fait
/// un `#include_next` de celle du compilateur et qu'il n'y en a aucune. Celles de gcc
/// sont interchangeables pour cet usage : on y pointe clang plutôt que d'imposer une
/// seconde toolchain à chaque contributeur.
///
/// Jumeau de `freestanding_header_args()` dans
/// electron/native/pipewire-capture/build.rs, et comme lui ça vit DANS build.rs plutôt
/// que dans scripts/build-linux-compositor-addon.mjs : tant que seul le script posait
/// `BINDGEN_EXTRA_CLANG_ARGS`, un `cargo check -p openscreen-compositor` nu échouait sur
/// une Ubuntu de série — y compris en x86_64.
fn freestanding_header_args() -> Vec<String> {
    if let Ok(extra) = env::var("BINDGEN_EXTRA_CLANG_ARGS") {
        // Déjà configuré par l'appelant ; bindgen le lit de lui-même.
        if !extra.trim().is_empty() {
            return Vec::new();
        }
    }
    // Le triplet vendeur n'est PAS codé en dur : c'est `x86_64-linux-gnu` sur Debian/
    // Ubuntu amd64, `aarch64-linux-gnu` sur arm64 et `x86_64-pc-linux-gnu` sur Arch.
    // Matcher sur le préfixe d'architecture de la CIBLE couvre les trois, et sur une
    // machine où un cross-gcc est installé refuse quand même les en-têtes de l'AUTRE
    // architecture, dont les largeurs de types seraient fausses.
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| env::consts::ARCH.to_string());
    let prefix = format!("{arch}-");
    let Ok(vendors) = std::fs::read_dir("/usr/lib/gcc") else {
        return Vec::new();
    };
    // Les DEUX en-têtes sont exigés : l'échec observé porte tantôt sur `stddef.h`
    // (compositor) tantôt sur `limits.h` (pipewire-capture), et un répertoire qui n'a
    // que l'un des deux ne réglerait qu'une moitié du problème tout en ayant l'air
    // d'un candidat valable.
    let mut dirs: Vec<PathBuf> = vendors
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .filter_map(|vendor| std::fs::read_dir(vendor.path()).ok())
        .flatten()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().join("include"))
        .filter(|dir| dir.join("limits.h").is_file() && dir.join("stddef.h").is_file())
        .collect();
    // gcc le plus récent d'abord, pour une machine qui en a plusieurs.
    dirs.sort();
    dirs.reverse();
    dirs.into_iter()
        .take(1)
        .map(|dir| format!("-I{}", dir.display()))
        .collect()
}

/// Ajoute `#[link_name = "<prefix><nom>"]` devant chaque `pub fn` ffmpeg de `ffi.rs`.
///
/// Seul le SYMBOLE importé change ; l'identifiant Rust reste `avformat_open_input`, donc
/// aucun site d'appel du crate ne bouge. bindgen ne génère ici que des fonctions (aucun
/// `pub static`), ce qui rend la réécriture sûre et purement textuelle.
///
/// Pourquoi ce détour plutôt qu'un `#[link(name = ...)]` : le problème n'est pas de
/// désigner une bibliothèque mais d'éviter une COLLISION DE NOMS. Electron charge
/// `libffmpeg.so` (le ffmpeg de Chromium) comme dépendance directe, donc ses symboles
/// occupent la portée globale avant tout addon ; sous ELF, nos imports s'y rattachent
/// quoi que dise notre RUNPATH. Renommer supprime la collision à la racine, là où jouer
/// sur la portée de résolution (RTLD_DEEPBIND) casse l'interposition de l'allocateur de
/// Chromium et fait planter le process.
fn prefix_ffmpeg_symbols(ffi_path: &Path, prefix: &str) {
    let source = std::fs::read_to_string(ffi_path).expect("relecture ffi.rs");
    let mut out = String::with_capacity(source.len() + 64 * 1024);
    let mut renamed = 0usize;

    for line in source.lines() {
        if let Some(name) = line
            .strip_prefix("    pub fn ")
            .and_then(|rest| rest.split('(').next())
            .filter(|n| is_ffmpeg_symbol(n))
        {
            out.push_str(&format!("    #[link_name = \"{prefix}{name}\"]\n"));
            renamed += 1;
        }
        out.push_str(line);
        out.push('\n');
    }

    assert!(
        renamed > 0,
        "OPENSCREEN_FFMPEG_SYMBOL_PREFIX est posé mais aucune fonction ffmpeg n'a été \
         trouvée dans ffi.rs — le format de sortie de bindgen a changé, et l'addon se \
         lierait silencieusement au ffmpeg de Chromium."
    );
    std::fs::write(ffi_path, out).expect("réécriture ffi.rs");
    println!("cargo:warning=ffmpeg: {renamed} symboles préfixés en `{prefix}`");
}

/// Les préfixes que ffmpeg expose : `av*` (avutil/avcodec/avformat + `avpriv_`),
/// `sws_*` (swscale) et `swr_*` (swresample). Aligné sur le filtre du script de build,
/// qui dérive la table de renommage des mêmes bibliothèques.
fn is_ffmpeg_symbol(name: &str) -> bool {
    name.starts_with("av") || name.starts_with("sws_") || name.starts_with("swr_")
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

/// Un arbre ffmpeg exploitable : `include/` pour bindgen ET `lib/` pour le linkage.
///
/// Les deux, pas seulement le premier : la section « linkage » plus bas pose un
/// `rustc-link-search` sur `<tree>/lib` et réclame avformat/avcodec/avutil/swscale/
/// swresample. Un arbre n'ayant que les en-têtes passait le filtre, écartait le repli
/// vers un arbre vendorisé complet, et échouait bien plus tard sur un `cannot find
/// -lavformat` qui ne désigne pas sa cause. `resolveFfmpegDir()` dans
/// scripts/build-linux-compositor-addon.mjs vérifie déjà les deux — c'est la même règle
/// des deux côtés.
fn usable_ffmpeg_tree(dir: &Path) -> bool {
    dir.join("include").is_dir() && dir.join("lib").is_dir()
}

/// L'arbre ffmpeg vendorisé sous `crates/thirdparty/<name>`, s'il existe vraiment.
///
/// `thirdparty/` est frère de `compositor/`, sous `crates/` — c'est aussi ce que le pin
/// Windows désigne (`relative = true` dans `crates/.cargo/config.toml`, relatif au
/// dossier de la config). build.rs s'exécute avec cwd = racine du crate, pas `crates/`,
/// donc on remonte depuis CARGO_MANIFEST_DIR plutôt que d'écrire un chemin relatif qui
/// viserait `crates/compositor/thirdparty/`.
fn vendored_ffmpeg_tree(name: &str) -> Option<String> {
    let candidate = Path::new(&env::var("CARGO_MANIFEST_DIR").ok()?)
        .parent()?
        .join("thirdparty")
        .join(name);
    usable_ffmpeg_tree(&candidate).then(|| candidate.to_string_lossy().to_string())
}

/// Même remède que le versant macOS, pour la même cause.
///
/// `crates/.cargo/config.toml` pose `LIBCLANG_PATH` dans un `[env]` GLOBAL, faute de
/// `[target.<cfg>.env]` en cargo. La valeur est celle de Windows
/// (`C:\Program Files\LLVM\bin`) et elle est donc renseignée sous Linux aussi, où
/// clang-sys la prend au mot : il ne regarde nulle part ailleurs et abandonne sur
/// « Unable to find libclang », alors qu'un `libclang.so` de distribution est presque
/// toujours installé. Un `cargo check -p openscreen-compositor` nu échouait donc sur
/// une Ubuntu de série — exactement ce que `freestanding_header_args()` juste au-dessus
/// s'emploie à éviter par ailleurs.
///
/// On ne devine pas le bon chemin : clang-sys sait chercher tout seul (LD_LIBRARY_PATH,
/// PATH, /usr/lib/llvm-*/lib …). Il suffit de ne pas lui mentir. Une valeur posée par le
/// dev et réellement utilisable est conservée telle quelle — `force = false` fait déjà
/// gagner l'environnement réel sur la config, et on ne casse pas un choix explicite.
fn drop_unusable_libclang_path() {
    println!("cargo:rerun-if-env-changed=LIBCLANG_PATH");
    let Ok(value) = env::var("LIBCLANG_PATH") else {
        return;
    };
    // clang-sys accepte DEUX formes : un fichier bibliothèque, ou un répertoire qui en
    // contient un (`search_libclang_directories` : « Check if the path is a matching
    // file », puis « … a directory containing a matching file »). Ne traiter que le
    // répertoire retirerait un `LIBCLANG_PATH` parfaitement valide pointant sur
    // `/usr/lib/llvm-N/lib/libclang.so.1`.
    let path = Path::new(&value);
    let usable = if path.is_file() {
        path.file_name()
            .is_some_and(|n| is_libclang_filename(&n.to_string_lossy()))
    } else {
        std::fs::read_dir(path).is_ok_and(|entries| {
            entries
                .flatten()
                // `is_file()` autant que le nom : `read_dir` rend aussi les
                // sous-répertoires et les fichiers spéciaux, et un répertoire qui
                // s'appellerait `libclang.so` passerait le seul test de nom — clang-sys
                // le retiendrait puis échouerait à le charger, sans repli possible.
                .any(|e| {
                    e.path().is_file() && is_libclang_filename(&e.file_name().to_string_lossy())
                })
        })
    };
    if !usable {
        env::remove_var("LIBCLANG_PATH");
    }
}

/// Les motifs EXACTS que clang-sys cherche sous Linux : `libclang.so`,
/// `libclang-<v>.so`, `libclang.so.<v>`, `libclang-<v>.so.<v>`.
///
/// Coller aux motifs, et pas seulement au préfixe, parce que `search_libclang_directories`
/// s'arrête net sur `LIBCLANG_PATH` quand la variable est posée — « Search only the path
/// indicated by the relevant environment variable » — sans jamais retomber sur
/// `llvm-config`, le PATH ou les répertoires connus. Conserver un chemin qui ne contient
/// qu'un `libclang_extra.so` ou un `libclang.software` reviendrait donc à condamner le
/// build, exactement comme le faisait la valeur Windows.
///
/// `libclang-cpp.*` est écarté d'entrée : clang-sys l'écarte lui-même
/// (`filename.contains("-cpp.")`), `libclang_shared` ayant été renommé `libclang-cpp` à
/// partir de Clang 10.
fn is_libclang_filename(name: &str) -> bool {
    if name.contains("-cpp.") {
        return false;
    }
    let Some(rest) = name.strip_prefix("libclang") else {
        return false;
    };
    // Soit `libclang.so…`, soit `libclang-<v>.so…` avec un `<v>` non vide.
    let rest = match rest.strip_prefix('-') {
        Some(versioned) => match versioned.find(".so") {
            None | Some(0) => return false,
            Some(i) => &versioned[i..],
        },
        None => rest,
    };
    rest == ".so" || rest.starts_with(".so.")
}
