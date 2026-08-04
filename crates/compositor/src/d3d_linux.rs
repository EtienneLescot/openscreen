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
//!
//! Ce repli a longtemps ete IMPLICITE : `create_backend` ignorait son parametre et
//! wgpu rendait lavapipe de lui-meme quand c'etait le seul ICD. Ca marche, mais rien
//! ne pouvait l'exercer (pas de forcage), rien ne le signalait (pas de log) et rien
//! ne le garantissait (Mesa n'etait declare dans aucun paquet). Trois consequences,
//! toutes corrigees ici :
//!
//!   - `create_backend` honore son parametre -- `Backend::Cpu` passe par
//!     `force_fallback_adapter`, `Backend::Hardware` rejette explicitement le
//!     logiciel. `create` est donc reellement materiel strict.
//!   - l'adaptateur retenu est journalise, comme le repli l'est cote Windows.
//!   - `OPENSCREEN_COMPOSITOR_BACKEND=hardware|cpu` force le choix sans passer par
//!     `VK_DRIVER_FILES`, qui priverait tout le processus -- Chromium compris -- de
//!     son GPU (cf. `FORCE_VAR`).

use anyhow::{anyhow, bail, Context, Result};
use std::sync::OnceLock;

/// Qui execute le pipeline (symetrie d'API avec `d3d_windows::Backend`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    /// Vrai GPU (RADV / dzn / NVK / ...) via Vulkan.
    Hardware,
    /// Mesa lavapipe (`llvmpipe`), rasteriseur logiciel Vulkan.
    Cpu,
}

impl Backend {
    /// Le libelle accepte par `OPENSCREEN_COMPOSITOR_BACKEND`, pour que le message
    /// d'erreur d'un forcage rate cite la valeur telle qu'on l'ecrit.
    fn as_str(self) -> &'static str {
        match self {
            Backend::Hardware => "hardware",
            Backend::Cpu => "cpu",
        }
    }
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
    // Meme forme que `d3d_windows::Gpu::probe` : on essaie les deux dans l'ordre
    // ou la production les prendra. Ne PAS se contenter de `Hardware` -- depuis
    // que ce backend est strict (cf. `create_async`), il echoue sur un hote
    // lavapipe-seul, et `probe()` y rendrait `None` (= "pas d'addon", qui ne
    // declenche aucune notice) au lieu de `Cpu` (= machine degradee, notice).
    *PROBE.get_or_init(|| {
        // Le forcage vaut aussi ici : sans ca l'UI annoncerait "hardware" pendant que
        // `create_auto` rend sur lavapipe, et la notice ne s'afficherait pas.
        if let Some(want) = forced_backend() {
            return create_backend(want).ok().map(|g| g.backend);
        }
        for backend in [Backend::Hardware, Backend::Cpu] {
            if create_backend(backend).is_ok() {
                return Some(backend);
            }
        }
        None
    })
}

/// Cree un device wgpu pour le backend DEMANDE.
///
/// - `Backend::Cpu` -> `force_fallback_adapter`, que le loader Vulkan ne satisfait
///   qu'avec un ICD logiciel. C'est le seul moyen d'atteindre lavapipe sur une
///   machine qui a AUSSI un vrai GPU, donc d'exercer le chemin CPU ailleurs que
///   sur un hote deja casse.
/// - `Backend::Hardware` -> le meilleur adaptateur, PUIS un rejet explicite du
///   logiciel. Sans ce rejet, `create` -- cense etre materiel strict -- rendait un
///   device llvmpipe sans broncher sur un hote sans pilote, et un golden mesure
///   dessus passait pour une mesure GPU.
pub fn create_backend(backend: Backend) -> Result<Gpu> {
    pollster::block_on(create_async(backend)).map_err(|err| match backend {
        // `Backend::Cpu` ne diagnostique pas : si le rasteriseur logiciel lui-meme
        // echoue, il n'y a plus rien derriere a proposer (meme raison que WARP
        // cote Windows).
        Backend::Cpu => err,
        Backend::Hardware => anyhow!("{}", diagnose(&err)),
    })
}

async fn create_async(want: Backend) -> Result<Gpu> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    });
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: want == Backend::Cpu,
            ..Default::default()
        })
        .await
        .context(match want {
            Backend::Hardware => "aucun adaptateur graphique compatible",
            Backend::Cpu => "aucun rasteriseur logiciel Vulkan (lavapipe) sur cet hote",
        })?;
    let info = adapter.get_info();
    let got = classify(&info);
    // `force_fallback_adapter` garantit le sens `Cpu` ; rien ne garantit l'autre.
    if want == Backend::Hardware && got == Backend::Cpu {
        bail!(
            "backend materiel demande, mais le seul adaptateur Vulkan disponible est le \
             rasteriseur logiciel « {} » -- aucun pilote GPU utilisable sur cet hote",
            info.name
        );
    }
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
    // Windows loggue son repli (`d3d_windows.rs`), Linux ne loggait rien : un hote
    // tombe sur lavapipe rendait a quelques fps sans que rien -- ni log, ni rapport
    // de bug -- ne permette de l'etablir a distance.
    eprintln!(
        "[d3d] adaptateur Vulkan : {} ({:?}, {:?}) -> backend {:?}",
        info.name, info.device_type, info.backend, got
    );
    Ok(Gpu {
        device,
        context: queue,
        backend: got,
        feature_level: 0,
    })
}

/// `DeviceType::Cpu` d'abord : c'est ce que l'ICD lui-meme declare
/// (`VK_PHYSICAL_DEVICE_TYPE_CPU`), et lavapipe n'est pas le seul rasteriseur
/// logiciel Vulkan -- SwiftShader en est un autre. Le nom ne sert plus que de
/// filet pour un ICD qui mentirait sur son type ; il etait l'unique critere
/// jusqu'ici, on ne le retire pas sans l'avoir vu echouer.
fn classify(info: &wgpu::AdapterInfo) -> Backend {
    if info.device_type == wgpu::DeviceType::Cpu {
        return Backend::Cpu;
    }
    let n = info.name.to_ascii_lowercase();
    if n.contains("llvmpipe") || n.contains("lavapipe") || n.contains("swiftshader") {
        Backend::Cpu
    } else {
        Backend::Hardware
    }
}

/// Forcage explicite du backend : `OPENSCREEN_COMPOSITOR_BACKEND=hardware|cpu`.
///
/// `VK_DRIVER_FILES` / `VK_ICD_FILENAMES` obtiendraient le meme effet au niveau du
/// loader Vulkan, mais s'appliquent au PROCESSUS ENTIER : sous Electron ils privent
/// aussi Chromium de son GPU, qui rasterise alors toute son UI sur CPU et sature la
/// machine -- le test devient inexploitable et emporte les autres applications. Cette
/// variable-ci ne touche que notre compositeur, ce qui en fait le seul moyen praticable
/// d'exercer le chemin CPU depuis une machine qui a un GPU.
///
/// Meme motif que `OPENSCREEN_EXPORT_ENCODER` cote pipeline. Linux seulement : Windows
/// a le meme besoin (WARP) mais son chemin n'est pas exerce ici.
pub const FORCE_VAR: &str = "OPENSCREEN_COMPOSITOR_BACKEND";

fn forced_backend() -> Option<Backend> {
    let raw = std::env::var(FORCE_VAR).ok()?;
    let parsed = parse_forced_backend(&raw);
    if parsed.is_none() {
        eprintln!("[d3d] {FORCE_VAR}={raw} ignore (attendu : hardware|cpu)");
    }
    parsed
}

/// Separe de `forced_backend` pour etre testable : muter l'environnement depuis un
/// test course avec les autres tests du meme binaire, qui tournent en parallele.
fn parse_forced_backend(raw: &str) -> Option<Backend> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "cpu" => Some(Backend::Cpu),
        "hardware" => Some(Backend::Hardware),
        _ => None,
    }
}

impl Gpu {
    /// Le device de PRODUCTION : materiel si possible, rasteriseur logiciel sinon.
    ///
    /// Symetrie d'API avec `d3d_windows::Gpu::create_auto` ; `_debug` est le pendant
    /// de la couche de debug D3D11 (rien a faire ici, wgpu a `WGPU_VALIDATION` en
    /// variable d'env).
    ///
    /// Le repli etait implicite jusqu'ici : wgpu rendait lavapipe de lui-meme quand
    /// c'etait le seul ICD, ce qui MARCHE mais ne se teste ni ne se loggue. Il est
    /// desormais explicite, pour la meme raison que cote Windows.
    pub fn create_auto(_debug: bool) -> Result<Gpu> {
        // Un forcage ne retombe deliberement sur rien : un repli silencieux sur le
        // materiel ferait croire au test d'etre passe (meme politique que
        // `OPENSCREEN_EXPORT_ENCODER` cote pipeline).
        if let Some(want) = forced_backend() {
            return create_backend(want).with_context(|| {
                format!("{FORCE_VAR}={} inutilisable sur cet hote", want.as_str())
            });
        }
        let hw_err = match create_backend(Backend::Hardware) {
            Ok(gpu) => return Ok(gpu),
            Err(err) => err,
        };
        eprintln!("[d3d] backend materiel indisponible ({hw_err:#}) -- repli sur le backend CPU");
        create_backend(Backend::Cpu).map_err(|cpu_err| {
            // Le diagnostic MATERIEL en tete : c'est lui qui est actionnable
            // ("installez Mesa"), pas "lavapipe indisponible" qui ne dit rien.
            anyhow!("{hw_err:#} (le repli logiciel a echoue aussi : {cpu_err:#})")
        })
    }

    /// Creation hardware-strict (tests, goldens, bench) : echoue plutot que de rendre
    /// un device lavapipe. Mesurer ou comparer le chemin GPU sur un rasteriseur
    /// logiciel n'a aucun sens. Le chemin de production, lui, prend `create_auto`.
    pub fn create(_debug: bool) -> Result<Gpu> {
        create_backend(Backend::Hardware)
    }

    /// Le backend de cette machine, mis en cache. Expose comme fonction ASSOCIEE
    /// (`Gpu::probe()`) parce que `compositor-view-napi` l'appelle ainsi.
    pub fn probe() -> Option<Backend> {
        probe()
    }
}

/// Message d'echec ACTIONNABLE (symetrie d'API avec `d3d_windows::diagnose`, qui
/// separe "cet adaptateur n'a pas de decodeur video" de "aucun adaptateur FL 11_1").
///
/// La seule panne de cette famille que l'utilisateur peut reparer lui-meme est
/// "aucun ICD Vulkan installe" : ni pilote GPU, ni rasteriseur logiciel, donc meme le
/// repli CPU est hors de portee et la preview s'ouvre sur un echec. On la separe du
/// reste en re-enumerant sans rien exiger -- si meme la aucun adaptateur ne sort,
/// c'est le loader qui est vide, pas notre demande qui etait trop stricte.
pub fn diagnose(err: &anyhow::Error) -> String {
    if !any_adapter_exists() {
        return format!(
            "aucun pilote Vulkan sur cet hote ({err:#}). Installez Mesa : \
             `mesa-vulkan-drivers` (Debian/Ubuntu, Fedora) ou `vulkan-swrast` (Arch) \
             donne le rendu logiciel ; le pilote de votre carte (`vulkan-radeon`, \
             `vulkan-intel`, pilote NVIDIA) donne le rendu accelere."
        );
    }
    format!("{err:#}")
}

/// Y a-t-il UN adaptateur Vulkan, quel qu'il soit ? Distingue "le loader n'a aucun
/// ICD" de "un adaptateur existe mais la creation a echoue". Volontairement sans
/// cache : `diagnose` n'est appele que sur un chemin d'erreur, jamais en boucle.
fn any_adapter_exists() -> bool {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    });
    !instance
        .enumerate_adapters(wgpu::Backends::all())
        .is_empty()
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

    /// `AdapterInfo` minimal pour les cas ou seuls `name` et `device_type` comptent.
    fn info(name: &str, device_type: wgpu::DeviceType) -> wgpu::AdapterInfo {
        wgpu::AdapterInfo {
            name: name.into(),
            vendor: 0,
            device: 0,
            device_type,
            driver: String::new(),
            driver_info: String::new(),
            backend: wgpu::Backend::Vulkan,
        }
    }

    /// `DEVICE_TYPE_CPU` prime sur le nom : c'est l'ICD qui se declare, et un
    /// rasteriseur logiciel n'est pas tenu de s'appeler llvmpipe.
    #[test]
    fn classify_suit_le_device_type_quand_le_nom_ne_dit_rien() {
        let i = info("Generic Vulkan Device", wgpu::DeviceType::Cpu);
        assert_eq!(classify(&i), Backend::Cpu);
    }

    /// Le nom reste un filet pour un ICD qui se declarerait mal -- c'etait l'unique
    /// critere avant, on ne le retire pas sans l'avoir vu echouer.
    #[test]
    fn classify_retombe_sur_le_nom_si_le_device_type_ment() {
        let i = info("llvmpipe (LLVM 21.1.8, 256 bits)", wgpu::DeviceType::Other);
        assert_eq!(classify(&i), Backend::Cpu);
        let i = info("SwiftShader Device (Subzero)", wgpu::DeviceType::Other);
        assert_eq!(classify(&i), Backend::Cpu);
    }

    /// Un GPU virtuel (VM avec passthrough, virtio-gpu) reste du materiel : il a un
    /// vrai pilote derriere, ce n'est pas un rasteriseur logiciel.
    #[test]
    fn classify_hardware_pour_gpu_virtuel() {
        let i = info(
            "virtio-gpu Venus (Intel Graphics)",
            wgpu::DeviceType::VirtualGpu,
        );
        assert_eq!(classify(&i), Backend::Hardware);
    }

    #[test]
    fn parse_forced_backend_accepte_les_deux_libelles() {
        assert_eq!(parse_forced_backend("cpu"), Some(Backend::Cpu));
        assert_eq!(parse_forced_backend("hardware"), Some(Backend::Hardware));
        // Tolerant sur la casse et les espaces : la variable est tapee a la main.
        assert_eq!(parse_forced_backend("  CPU \n"), Some(Backend::Cpu));
    }

    /// Une valeur inconnue est ignoree, PAS interpretee comme "cpu" : un forcage mal
    /// orthographie doit rendre la main au chemin normal et le dire, pas basculer en
    /// silence sur un backend qu'on n'a pas demande.
    #[test]
    fn parse_forced_backend_rejette_le_reste() {
        for raw in ["", "warp", "gpu", "vulkan", "true", "1"] {
            assert_eq!(parse_forced_backend(raw), None, "valeur : {raw:?}");
        }
    }

    /// Les libelles de `as_str` DOIVENT etre ceux que `parse_forced_backend` accepte,
    /// sinon le message d'erreur d'un forcage rate propose une valeur invalide.
    #[test]
    fn as_str_et_parse_forced_backend_sont_reciproques() {
        for b in [Backend::Hardware, Backend::Cpu] {
            assert_eq!(parse_forced_backend(b.as_str()), Some(b));
        }
    }
}
