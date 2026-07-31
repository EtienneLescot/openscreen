// Compiles csrc/pw_shim.c against the vendored PipeWire headers.
//
// There is deliberately no pkg-config probe and no `println!("cargo:rustc-link-lib=…")`:
// the shim resolves every libpipewire symbol with dlsym at runtime, so the only
// build input is a C compiler and the header tree under vendor/. That is what
// makes this crate buildable on a machine with no libpipewire-0.3-dev, which is
// most machines — Ubuntu ships only the runtime .so.0.

use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let vendor = root.join("vendor/pipewire-1.0.5/include");
    let shim = root.join("csrc/pw_shim.c");

    assert!(
        vendor.join("pipewire/pipewire.h").is_file(),
        "vendored PipeWire headers are missing at {} — see vendor/README.md",
        vendor.display()
    );

    cc::Build::new()
        .file(&shim)
        .include(&vendor)
        .include(root.join("csrc"))
        .flag_if_supported("-std=gnu11")
        .warnings(true)
        .compile("openscreen_pw_shim");

    println!("cargo:rerun-if-changed={}", shim.display());
    println!("cargo:rerun-if-changed={}", root.join("csrc/pw_shim.h").display());
    println!("cargo:rerun-if-changed={}", vendor.display());

    // dlopen/dlsym.
    println!("cargo:rustc-link-lib=dl");
}
