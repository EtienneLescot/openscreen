//! Le device D3D11 unique du POC (§2).
//! Un seul `ID3D11Device`, feature level 11_1, flag VIDEO_SUPPORT (décodeur),
//! et `ID3D10Multithread::SetMultithreadProtected(TRUE)` — parce que le décodeur
//! ffmpeg et notre boucle de rendu toucheront le device depuis des threads distincts.

use anyhow::{bail, Result};
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_DEBUG, D3D11_CREATE_DEVICE_FLAG,
    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
};

pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub feature_level: D3D_FEATURE_LEVEL,
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
/// PR #162 proposait de retomber sur `D3D_DRIVER_TYPE_WARP`. Mesuré sur cette machine
/// (`tests/warp_device_cannot_decode.rs`, qui échouera si Windows change d'avis) :
/// WARP + `VIDEO_SUPPORT` ne se crée même pas (`DXGI_ERROR_UNSUPPORTED`), et WARP sans
/// ce flag n'expose aucun `ID3D11VideoDevice` (`E_NOINTERFACE`, 0 profil décodeur).
/// Or `pipeline.rs` passe CE device à ffmpeg comme `AVD3D11VADeviceContext` : preview
/// comme export décodent chaque frame en D3D11VA. Un device WARP produirait donc zéro
/// frame et transformerait cet échec net en panne ffmpeg obscure. D'où : pas de repli,
/// mais un échec qui se lit.
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
    pub fn create(debug: bool) -> Result<Gpu> {
        // VIDEO_SUPPORT : requis pour que D3D11VA décode sur CE device.
        // BGRA_SUPPORT : utile (interop D2D éventuelle) et sans coût.
        let mut flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        if debug {
            flags |= D3D11_CREATE_DEVICE_DEBUG;
        }

        let (device, context, got) = match try_create(D3D_DRIVER_TYPE_HARDWARE, flags) {
            Ok(gpu) => gpu,
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

        Ok(Gpu { device, context, feature_level: got })
    }
}
