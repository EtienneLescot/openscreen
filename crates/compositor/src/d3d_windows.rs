//! Le device D3D11 unique du POC (§2).
//! Un seul `ID3D11Device`, feature level 11_1, flag VIDEO_SUPPORT (décodeur),
//! et `ID3D10Multithread::SetMultithreadProtected(TRUE)` — parce que le décodeur
//! ffmpeg et notre boucle de rendu toucheront le device depuis des threads distincts.

use anyhow::{bail, Result};
use std::sync::OnceLock;
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL,
    D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_DEBUG, D3D11_CREATE_DEVICE_FLAG,
    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
};

/// Qui exécute le pipeline. Le rendu et le décodage sont DEUX axes distincts, et aucune
/// plateforme n'a de rastériseur logiciel qui décode aussi la vidéo (WARP ici, lavapipe
/// sous Linux, rien du tout sous macOS) — un backend fixe donc les deux ensemble.
///
/// Le contrat de scène, les shaders HLSL et tout `compositor.rs` sont identiques d'un
/// backend à l'autre : c'est tout l'intérêt. Un portage Metal/Vulkan remplace ce que fait
/// ce fichier et `Decoder`, pas le moteur.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    /// GPU : rastérisation matérielle + décodage D3D11VA sur le même device (zéro copie).
    /// Le seul backend qui puisse exporter — l'encodeur AMF exige lui aussi le vrai GPU.
    Hardware,
    /// CPU : rastérisation WARP + décodage logiciel libavcodec, uploadé en NV12.
    /// Pour les hôtes sans GPU D3D11 utilisable (VM, RDP, Basic Render Driver).
    Cpu,
}

impl Backend {
    fn driver(self) -> D3D_DRIVER_TYPE {
        match self {
            Backend::Hardware => D3D_DRIVER_TYPE_HARDWARE,
            Backend::Cpu => D3D_DRIVER_TYPE_WARP,
        }
    }

    /// WARP REFUSE `VIDEO_SUPPORT` (`DXGI_ERROR_UNSUPPORTED`, mesuré dans
    /// `tests/warp_device_cannot_decode.rs`) : ce flag n'a de sens que sur le device
    /// matériel, où il conditionne D3D11VA. Le backend CPU ne décode pas sur le GPU,
    /// il n'en a donc pas besoin.
    fn base_flags(self) -> D3D11_CREATE_DEVICE_FLAG {
        match self {
            Backend::Hardware => {
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT
            }
            Backend::Cpu => D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        }
    }
}

pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub feature_level: D3D_FEATURE_LEVEL,
    /// Lu par `Decoder::open` pour choisir D3D11VA ou le décodage logiciel. Porté par le
    /// `Gpu` plutôt que passé partout : tout ce qui tient un device sait déjà qui il est.
    pub backend: Backend,
}

/// Une tentative `D3D11CreateDevice` à FL 11_1. Extraite pour que le chemin d'échec
/// puisse re-sonder avec d'autres flags/driver et dire POURQUOI la vraie tentative
/// a échoué (voir `diagnose`), au lieu de remonter un HRESULT nu.
fn try_create(
    driver: D3D_DRIVER_TYPE,
    flags: D3D11_CREATE_DEVICE_FLAG,
) -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext, D3D_FEATURE_LEVEL)> {
    let levels = [D3D_FEATURE_LEVEL_11_1];
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    let mut got = D3D_FEATURE_LEVEL::default();
    unsafe {
        D3D11CreateDevice(
            None,
            driver,
            HMODULE::default(),
            flags,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut got),
            Some(&mut context),
        )?;
    }
    // Le SDK garantit les deux sorties quand l'appel réussit ; `E_UNEXPECTED` plutôt
    // qu'un `unwrap` pour que l'impossible reste une erreur, pas un panic.
    match (device, context) {
        (Some(device), Some(context)) => Ok((device, context, got)),
        _ => Err(windows::core::Error::from(windows::Win32::Foundation::E_UNEXPECTED)),
    }
}

/// Message d'échec ACTIONNABLE : re-sonde pour distinguer les deux causes réelles.
///
/// Ce message reste utile MÊME maintenant que `create_auto` replie sur le backend CPU :
/// il part dans les logs à chaque repli, et c'est lui qui dit si l'utilisateur subit un
/// pilote à mettre à jour (réparable en cinq minutes) ou une VM sans GPU (structurel).
/// Sans lui, un utilisateur au rendu logiciel ne saurait jamais qu'il lui manque un
/// pilote. Et si WARP échoue aussi, c'est ce message-ci que `create_auto` remonte.
///
/// PR #162 proposait de retomber sur `D3D_DRIVER_TYPE_WARP` en gardant tout le reste.
/// Mesuré (`tests/warp_device_cannot_decode.rs`) : WARP + `VIDEO_SUPPORT` ne se crée même
/// pas (`DXGI_ERROR_UNSUPPORTED`), et sans ce flag il n'expose aucun `ID3D11VideoDevice`
/// (`E_NOINTERFACE`, 0 profil décodeur). Comme `pipeline.rs` passe CE device à ffmpeg
/// comme `AVD3D11VADeviceContext`, un simple changement de driver type aurait produit zéro
/// frame. C'est ce qui a donné à `Backend::Cpu` sa forme : WARP pour le rendu PLUS un
/// décodage logiciel (`cpu_frames.rs`) — le rendu et le décodage sont deux axes.
fn diagnose(err: &windows::core::Error) -> String {
    // Le décodeur est le point de rupture le plus probable (RDP, VM sans passthrough,
    // Microsoft Basic Render Driver) : si l'appel passe SANS VIDEO_SUPPORT, l'adaptateur
    // est là, c'est son décodeur qui manque. La sonde ne garde que BGRA — surtout pas
    // `flags` moins VIDEO_SUPPORT, qui traînerait `DEBUG` avec lui : sans les Graphics
    // Tools de Windows la couche debug fait échouer la sonde aussi, et on accuserait
    // l'adaptateur à tort. Ce cas-là se lit déjà dans `{err}`
    // (`DXGI_ERROR_SDK_COMPONENT_MISSING`), il n'a pas besoin de sa propre branche.
    if try_create(D3D_DRIVER_TYPE_HARDWARE, D3D11_CREATE_DEVICE_BGRA_SUPPORT).is_ok() {
        return format!(
            "this display adapter has no D3D11 video decoder ({err}). OpenScreen decodes \
             every preview and export frame with D3D11VA on the same device it composites \
             with, so the decoder is not optional and there is no CPU path behind it. \
             Remote Desktop sessions and VMs without GPU passthrough land here: run on the \
             physical machine, or update the display driver."
        );
    }
    format!(
        "no Direct3D 11 feature level 11_1 display adapter ({err}). OpenScreen's compositor \
         requires one for both preview and export. Update the display driver, or run on a \
         machine with a GPU that reaches feature level 11_1."
    )
}

impl Gpu {
    /// Crée le device conforme au §2. `debug=false` impératif dans tout run mesuré
    /// (§10 : la couche debug valide et sérialise chaque appel — facteur, pas %).
    ///
    /// MATÉRIEL STRICT, sans repli : échoue plutôt que de rendre un device WARP. C'est ce
    /// que veulent les tests et les goldens (mesurer ou comparer le chemin GPU n'a aucun
    /// sens sur un rastériseur logiciel). Le chemin de production, lui, prend `create_auto`.
    pub fn create(debug: bool) -> Result<Gpu> {
        Gpu::create_backend(Backend::Hardware, debug)
    }

    /// Le device de PRODUCTION : matériel si possible, backend CPU sinon.
    ///
    /// C'est ici que le repli devient automatique, et il ne l'est qu'accompagné : l'app
    /// demande `probe()` et prévient l'utilisateur. Un basculement muet vers un rendu à
    /// ~8 fps serait exactement le « l'app rame aujourd'hui » que cette branche corrige.
    ///
    /// Si les DEUX échouent, c'est le diagnostic MATÉRIEL qu'on remonte en tête : c'est
    /// lui qui est actionnable (« pas de décodeur vidéo sur cet adaptateur »), pas
    /// « WARP indisponible », qui ne dit rien à personne.
    pub fn create_auto(debug: bool) -> Result<Gpu> {
        let hw_err = match Gpu::create_backend(Backend::Hardware, debug) {
            Ok(gpu) => return Ok(gpu),
            Err(err) => err,
        };
        eprintln!("[d3d] backend matériel indisponible ({hw_err:#}) — repli sur le backend CPU");
        Gpu::create_backend(Backend::Cpu, debug).map_err(|cpu_err| {
            anyhow::anyhow!("{hw_err:#} (le repli logiciel a échoué aussi : {cpu_err:#})")
        })
    }

    /// Le backend que cette machine obtiendra, sans créer de vue ni d'export.
    ///
    /// Mis en cache : créer un device coûte quelques dizaines de ms et la réponse ne
    /// change pas en cours de session (un pilote qui tombe en marche est un redémarrage,
    /// pas un rafraîchissement). `None` = ni matériel ni WARP — la vue échouera, et c'est
    /// son message d'erreur, plus précis, qui doit parler.
    pub fn probe() -> Option<Backend> {
        static PROBED: OnceLock<Option<Backend>> = OnceLock::new();
        *PROBED.get_or_init(|| {
            for backend in [Backend::Hardware, Backend::Cpu] {
                if Gpu::create_backend(backend, false).is_ok() {
                    return Some(backend);
                }
            }
            None
        })
    }

    /// Le device du backend demandé. `Backend::Cpu` ne diagnostique pas : si WARP
    /// lui-même échoue, il n'y a plus rien derrière à proposer.
    pub fn create_backend(backend: Backend, debug: bool) -> Result<Gpu> {
        let mut flags = backend.base_flags();
        if debug {
            flags |= D3D11_CREATE_DEVICE_DEBUG;
        }

        let (device, context, got) = match try_create(backend.driver(), flags) {
            Ok(gpu) => gpu,
            Err(err) if backend == Backend::Cpu => {
                bail!("WARP (rastériseur logiciel) indisponible sur cet hôte : {err}")
            }
            Err(err) => bail!("{}", diagnose(&err)),
        };

        if got != D3D_FEATURE_LEVEL_11_1 {
            bail!("feature level obtenu {:?} != 11_1", got);
        }

        // §2 : multithread-protected. Le décodeur ffmpeg soumet depuis son thread,
        // notre compositeur depuis le nôtre — sans ça, corruption silencieuse.
        let mt: ID3D11Multithread = context.cast()?;
        unsafe {
            let _prev = mt.SetMultithreadProtected(true);
            if !mt.GetMultithreadProtected().as_bool() {
                bail!("SetMultithreadProtected(TRUE) n'a pas pris");
            }
        }

        Ok(Gpu { device, context, feature_level: got, backend })
    }
}
