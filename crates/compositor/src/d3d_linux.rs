//! Backend GPU Linux -- wgpu (Vulkan).
//!
//! Equivalent Linux de `d3d_windows.rs` / `d3d_macos.rs` : meme surface publique
//! (`Backend`, `Gpu`, `create`, `create_backend`, `create_auto`, `probe`,
//! `diagnose`) pour que `pipeline`, `live.rs` et `compositor-view-napi`
//! l'utilisent sans connaitre la plateforme (cf. `lib.rs`, qui re-exporte
//! `crate::d3d` vers `d3d_linux` sous `cfg(target_os = "linux")`).
//!
//! # `Backend::Cpu` sur Linux
//!
//! Contrairement a macOS (ou Metal n'a pas de rasteriseur logiciel), Linux EN A
//! un : Mesa **lavapipe** (`llvmpipe`), le pendant Vulkan de WARP. `probe()` le
//! classe donc en `Backend::Cpu` (le meme repli que WARP cote Windows : notice
//! dans la preview, warning a l'export), et un vrai GPU (RADV, dzn, NVK...) en
//! `Backend::Hardware`.

use anyhow::{Context, Result};
use std::sync::OnceLock;

/// Qui execute le pipeline (symetrie d'API avec `d3d_windows::Backend`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    /// Vrai GPU (RADV / dzn / NVK / ...) via Vulkan.
    Hardware,
    /// Mesa lavapipe (`llvmpipe`), rasteriseur logiciel Vulkan.
    Cpu,
}

/// Handle GPU Linux : `wgpu::Device` + `wgpu::Queue` (Arc internes cote wgpu,
/// `.clone()` bon marche). Les champs `device`/`context`/`backend`/
/// `feature_level` sont alignes sur `d3d_windows::Gpu` / `d3d_macos::Gpu` pour
/// que `live.rs::Player` copie la struct champ par champ sans cfg-fendre le
/// constructeur.
pub struct Gpu {
    pub device: wgpu::Device,
    /// Pendant de `ID3D11DeviceContext` (D3D11) / `MTLCommandQueue` (Metal) :
    /// la file de soumission wgpu.
    pub context: wgpu::Queue,
    pub backend: Backend,
    /// Pas d'equivalent `D3D_FEATURE_LEVEL` en wgpu ; conserve a 0 pour la
    /// symetrie d'API (les diagnostics futurs pourront le renseigner).
    pub feature_level: u64,
}

/// `probe()` -- propriete de la machine, mise en cache (la preview et la modale
/// d'export en ont besoin toutes les deux). `None` si aucun adaptateur wgpu
/// (headless sans lavapipe, kernel sans DRM ni ICD logiciel).
static PROBE: OnceLock<Option<Backend>> = OnceLock::new();

pub fn probe() -> Option<Backend> {
    *PROBE.get_or_init(|| create_backend(Backend::Hardware).ok().map(|g| g.backend))
}

/// Cree un device wgpu (Vulkan). `_backend` est indicatif : on prend le meilleur
/// adaptateur disponible (HighPerformance) et on reporte son type REEL via
/// `classify` (lavapipe -> `Cpu`, sinon `Hardware`) -- pas de chemin de rendu
/// distinct entre les deux cote Linux, seul le libelle change.
pub fn create_backend(_backend: Backend) -> Result<Gpu> {
    pollster::block_on(create_async())
}

async fn create_async() -> Result<Gpu> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    });
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        })
        .await
        .context("aucun adaptateur graphique compatible")?;
    let info = adapter.get_info();
    let backend = classify(&info);
    let (device, queue) = adapter
        .request_device(
            &wgpu::DeviceDescriptor {
                label: Some("openscreen-linux"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::default(),
            },
            None,
        )
        .await
        .context("request_device a echoue")?;
    Ok(Gpu {
        device,
        context: queue,
        backend,
        feature_level: 0,
    })
}

/// lavapipe expose "llvmpipe" dans le nom d'adaptateur -- c'est l'equivalent
/// Vulkan de WARP, a ranger sous `Cpu`.
fn classify(info: &wgpu::AdapterInfo) -> Backend {
    let n = info.name.to_ascii_lowercase();
    if n.contains("llvmpipe") || n.contains("lavapipe") {
        Backend::Cpu
    } else {
        Backend::Hardware
    }
}

impl Gpu {
    /// Chemin de production. Symetrie d'API avec `d3d_windows::Gpu::create_auto` ;
    /// `_debug` est le pendant de la couche de debug D3D11 (rien a faire ici,
    /// wgpu a `WGPU_VALIDATION` en variable d'env).
    pub fn create_auto(_debug: bool) -> Result<Gpu> {
        create_backend(Backend::Hardware)
    }

    /// Creation hardware-strict (tests et goldens).
    pub fn create(_debug: bool) -> Result<Gpu> {
        create_backend(Backend::Hardware)
    }

    /// Le backend de cette machine, mis en cache. Expose comme fonction ASSOCIEE
    /// (`Gpu::probe()`) parce que `compositor-view-napi` l'appelle ainsi.
    pub fn probe() -> Option<Backend> {
        probe()
    }
}

/// Message d'echec actionnable (symetrie d'API avec `d3d_windows::diagnose`).
pub fn diagnose(err: &anyhow::Error) -> String {
    format!("{err:#}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_cpu_pour_lavapipe() {
        let info = wgpu::AdapterInfo {
            name: "llvmpipe (LLVM 21.1.8, 256 bits)".into(),
            vendor: 0x10005,
            device: 0,
            device_type: wgpu::DeviceType::Cpu,
            driver: "llvmpipe".into(),
            driver_info: String::new(),
            backend: wgpu::Backend::Vulkan,
        };
        assert_eq!(classify(&info), Backend::Cpu);
    }

    #[test]
    fn classify_hardware_pour_gpu_reel() {
        let info = wgpu::AdapterInfo {
            name: "Microsoft Direct3D12 (AMD Radeon(TM) Graphics)".into(),
            vendor: 0x1002,
            device: 0,
            device_type: wgpu::DeviceType::IntegratedGpu,
            driver: "Dozen".into(),
            driver_info: String::new(),
            backend: wgpu::Backend::Vulkan,
        };
        assert_eq!(classify(&info), Backend::Hardware);
    }
}
