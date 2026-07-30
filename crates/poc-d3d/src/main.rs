//! Binaire du POC de mesure : GUI Win32 de preview/export, harnais de bench fps, mode live.
//! Tout le rendu vient d'`openscreen-compositor` — ce crate ne fait que le piloter et le mesurer.

// GUI Win32 + bench encodeurs Windows : Windows-only. Sur les autres plateformes
// le POC n'a rien a piloter (le rendu/bench passe par les tests du crate compositor).
#[cfg(windows)]
mod app;
#[cfg(windows)]
mod bench;

#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    bench::run()
}

#[cfg(not(windows))]
fn main() {
    eprintln!("poc-d3d : bench GUI Win32 (Windows-only), rien a faire sur cette plateforme.");
}
