//! Backend GPU macOS — Metal + VideoToolbox.
//!
//! Ce module EST l'équivalent macOS de `d3d_windows.rs`. Il expose la même surface
//! publique (`Backend`, `Gpu`, `create`, `create_backend`, `create_auto`, `probe`,
//! `diagnose`) pour que `pipeline.rs`, `live.rs` et `compositor-view-napi` puissent
//! l'utiliser sans connaître la plateforme sous-jacente (cf. `lib.rs`, qui ré-exporte
//! `crate::d3d` vers `d3d_windows` ou `d3d_macos` selon `cfg`).
//!
//! # Pourquoi `Backend::Cpu` existe quand même
//!
//! `Backend::{Hardware, Cpu}` reste un enum à deux variantes côté macOS pour la
//! symétrie d'API — `pipeline.rs` itère sur les deux dans certains chemins (sélection
//! d'encodeur, câblage decode/encode). Métal n'a pas de rastériseur logiciel et n'en a
//! pas besoin (chaque Mac supporté a un GPU), donc `Backend::Cpu` côté macOS EST
//! `Hardware` : pas de chemin de rendu distinct. Il est conservé dans le type pour
//! qu'un appel `gpu.backend == Backend::Cpu` côté macOS ne surprenne pas le pipeline
//! (et pour que la fonction `probe` puisse signaler correctement le seul backend
//! existant, `Backend::Hardware`).
//!
//! # Frame seam (cf. `cpu_frames_windows.rs` doc en-tête)
//!
//! Tout ce que le compositor lit d'une frame décodeur tient dans quatre champs AVFrame :
//!   - `data[0]` : un pointeur vers le buffer natif (ID3D11Texture2D* sur Windows,
//!     `CVPixelBufferRef` sur macOS),
//!   - `data[1]` : tranche d'array (toujours 0 sur macOS : VideoToolbox produit des
//!     CVPixelBuffers indépendants, pas des tableaux),
//!   - `width`/`height` : dimensions visibles dans la texture.
//!
//! Le CVPixelBufferRef de macOS est posé dans `data[0]` via le type `frame::PixelBuffer`
//! (c.f. `mac_frames.rs` — sa présentation encode `(*present).data[0] = cv_retain(buf)`).
//! `nv12_srvs` côté macOS le convertit en deux `MTLTexture`s (Y `R8Unorm`, UV `RG8Unorm`)
//! via `CVMetalTextureCacheCreateTextureFromImage` — zéro copie, IOSurface-backed.
//!
//! Ce module ne fait pas encore la mise en place effective : il expose les bonnes
//! signatures et retourne `Err` partout. Les PRs suivants remplissent l'implémentation
//! par couches (device, swapchain, shaders MSL, decode VideoToolbox, encode h264_videotoolbox).

use anyhow::{anyhow, Result};
use std::sync::OnceLock;

/// Qui exécute le pipeline (symétrie d'API avec `d3d_windows::Backend` — voir l'en-tête).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    /// GPU : rastérisation Metal + décodage VideoToolbox sur le même pipeline. Sur macOS,
    /// c'est le SEUL backend possible — chaque Mac supporté a un GPU. (Aucun rastériseur
    /// logiciel n'existe pour Metal, et il n'y en a pas besoin.)
    Hardware,
    /// Conservé pour la symétrie d'API avec `d3d_windows`. Sur macOS, ce variant n'est
    /// jamais produit : `probe()` ne renvoie que `Some(Backend::Hardware)`, et
    /// `create_auto` ne tente jamais le fallback. Le pipeline peut comparer
    /// `gpu.backend == Backend::Cpu` sans planter.
    Cpu,
}

/// Handle de device GPU macOS. Côté Metal, `device: metal::Device` est compté en
/// références (ARC) — `.clone()` est un `retain` côté ObjC, le `Drop` côté Rust fait
/// le `release`. `feature_level` n'a pas d'équivalent strict (Metal n'expose pas de
/// feature levels comme D3D_FEATURE_LEVEL_11_1) ; on stocke la révision de Metal
/// supportée par le runtime pour pouvoir raisonner à partir d'elle (cf. futur
/// `diagnose` qui distingue "Metal 3+ pas dispo" de "GPU dégradé").
///
/// `context` est l'équivalent macOS du `ID3D11DeviceContext` D3D11 — chez Metal
/// c'est une `MTLCommandQueue` (la file de command buffers). Le port garde le même
/// nom de champ (`context`) que `d3d_windows::Gpu` pour que `live.rs::Player` puisse
/// copier la struct champ par champ sans cfg-fendre le constructeur.
pub struct Gpu {
    pub device: metal::Device,
    pub context: metal::CommandQueue,
    pub backend: Backend,
    /// `MTLFeatureSet` ou révision runtime (Metal 2/3). Conservé pour les diagnostics.
    pub feature_level: u64,
}

/// `probe()` — propriété de la machine, mis en cache pour ne pas payer deux fois
/// la création du device (la preview et la modale d'export en ont tous les deux besoin,
/// cf. `useCompositorBackend` côté TS).
///
/// Renvoie `None` quand aucun device Metal ne peut être créé — hôte sans GPU (rare :
/// une VM sans passthrough) ou Metal désactivé en force (variable `MTL_DEBUG_LAYER`).
static PROBE: OnceLock<Option<Backend>> = OnceLock::new();

pub fn probe() -> Option<Backend> {
    *PROBE.get_or_init(|| {
        // metal::Device::system_default() renvoie None si Metal est indisponible.
        // En pratique, sur macOS 10.13+, c'est toujours Some — sauf VM sans GPU.
        if metal::Device::system_default().is_some() {
            Some(Backend::Hardware)
        } else {
            None
        }
    })
}

/// Crée un device pour le backend demandé. Sur macOS, seul `Backend::Hardware` est
/// implémenté ; `Backend::Cpu` retourne `Err` (pas de rastériseur logiciel Metal).
pub fn create_backend(backend: Backend) -> Result<Gpu> {
    match backend {
        Backend::Hardware => create_metal_device(),
        Backend::Cpu => Err(anyhow!(
            "Backend::Cpu n'existe pas sur macOS : Metal n'a pas de rastériseur logiciel \
             et chaque Mac supporté a un GPU"
        )),
    }
}

/// Crée le `MTLDevice` système. En cas d'échec (VM, Metal désactivé, GPU gelé), on
/// renvoie `Err` plutôt qu'un device partiel : la policy de PR #162 est "échouer
/// lisiblement, pas silencieusement".
fn create_metal_device() -> Result<Gpu> {
    let device = metal::Device::system_default()
        .ok_or_else(|| anyhow!("aucun MTLDevice disponible (Metal indisponible ou VM sans GPU)"))?;
    let queue = device.new_command_queue();
    Ok(Gpu {
        device,
        context: queue,
        backend: Backend::Hardware,
        feature_level: 0,
    })
}

impl Gpu {
    /// Chemin de production : matérielle uniquement (Metal + VideoToolbox).
    /// Conservé pour la symétrie d'API avec `d3d_windows::Gpu::create_auto` : un
    /// appel `create_auto(false)` côté macOS doit renvoyer le seul backend existant,
    /// jamais basculer silencieusement sur autre chose (le silence est précisément
    /// la failure mode que PR #162 a éliminée côté Windows).
    ///
    /// `_debug` est le pendant du flag de couche de debug D3D11 ; Metal a l'équivalent
    /// via la variable d'environnement `METAL_DEVICE_WRAPPER_TYPE`, donc rien à faire
    /// ici. Le paramètre reste pour que les call-sites (`compositor-view-napi`) soient
    /// littéralement les mêmes des deux côtés.
    pub fn create_auto(_debug: bool) -> Result<Gpu> {
        create_backend(Backend::Hardware)
    }

    /// Création hardware-strict (utilisée par les tests et les goldens).
    pub fn create(_debug: bool) -> Result<Gpu> {
        create_backend(Backend::Hardware)
    }

    /// Le backend de cette machine, mis en cache. `d3d_windows` l'expose comme
    /// fonction ASSOCIÉE (`Gpu::probe()`) et `compositor-view-napi` l'appelle ainsi ;
    /// la version macOS n'avait qu'une fonction libre `probe()`, donc l'addon ne
    /// compilait pas.
    pub fn probe() -> Option<Backend> {
        probe()
    }
}

/// Message d'échec ACTIONNABLE (symétrie d'API avec `d3d_windows::diagnose`).
///
/// `create_metal_device` ci-dessus ne renvoie qu'un `Err` laconique aujourd'hui ;
/// ce diagnostic sera étoffé dans un commit ultérieur pour distinguer :
///   - "Metal désactivé" (variable d'env, profil développeur)
///   - "Mac trop ancien" (Metal 3 indisponible ; faut-il se contenter de Metal 2 ?)
///   - "VM sans passthrough GPU" (structurel — message adapté)
/// Pour l'instant il ne fait que ré-empaqueter l'erreur, ce qui suffit à la
/// propagation.
pub fn diagnose(err: &anyhow::Error) -> String {
    format!("{err:#}")
}