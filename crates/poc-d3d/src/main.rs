//! Binaire du POC de mesure : GUI Win32 de preview/export, harnais de bench fps, mode live.
//! Tout le rendu vient d'`openscreen-compositor` — ce crate ne fait que le piloter et le mesurer.

mod app;
mod bench;

fn main() -> anyhow::Result<()> {
    bench::run()
}
