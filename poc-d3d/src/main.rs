//! Binaire mince : toute la logique vit dans la bibliothèque `poc_d3d`
//! (réutilisable par l'addon napi-rs de l'intégration Electron).

fn main() -> anyhow::Result<()> {
    poc_d3d::run()
}
