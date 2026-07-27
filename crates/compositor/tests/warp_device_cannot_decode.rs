//! Pourquoi il n'y a PAS de repli WARP (PR #162).
//!
//! `d3d::Gpu::create` demande `D3D_DRIVER_TYPE_HARDWARE` et `VIDEO_SUPPORT`, sans
//! second choix. La proposition évidente — retenter en `D3D_DRIVER_TYPE_WARP`, le
//! rastériseur CPU de Microsoft — ne marche pas, et pas pour une raison de vitesse :
//! WARP n'a tout simplement pas de décodeur vidéo. Or `pipeline.rs` passe le device
//! de `Gpu` à ffmpeg comme `AVD3D11VADeviceContext` (`(*d3dctx).device = ...`), donc
//! preview ET export décodent chaque frame en D3D11VA sur CE device. Un device WARP
//! se créerait puis ne produirait aucune frame.
//!
//! Ce test verrouille la mesure. S'il ÉCHOUE, c'est que WARP a gagné une capacité
//! vidéo sur cette machine/version de Windows — et alors le repli redevient une
//! question ouverte : relire `diagnose()` dans `src/d3d.rs`.

#![cfg(windows)]

use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11VideoDevice,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_FLAG,
    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
};

fn create(
    driver: D3D_DRIVER_TYPE,
    flags: D3D11_CREATE_DEVICE_FLAG,
) -> windows::core::Result<ID3D11Device> {
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
    device.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_UNEXPECTED))
}

/// Exactement les flags de `Gpu::create`. Mesuré : `DXGI_ERROR_UNSUPPORTED` (0x887A0004)
/// — le device WARP ne se crée même pas avec `VIDEO_SUPPORT`.
#[test]
fn warp_rejects_the_video_support_flag_gpu_create_requires() {
    let err = create(
        D3D_DRIVER_TYPE_WARP,
        D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    )
    .expect_err("WARP a accepté VIDEO_SUPPORT — le repli WARP redevient envisageable");
    assert_eq!(err.code().0 as u32, 0x887A_0004, "attendu DXGI_ERROR_UNSUPPORTED, eu {err}");
}

/// Et laisser tomber le flag ne sauve rien : le device se crée bien à FL 11_1, mais
/// il n'expose aucun `ID3D11VideoDevice`, donc zéro profil décodeur pour D3D11VA.
#[test]
fn warp_without_the_flag_still_exposes_no_video_device() {
    let device =
        create(D3D_DRIVER_TYPE_WARP, D3D11_CREATE_DEVICE_BGRA_SUPPORT).expect("WARP FL 11_1");
    let profiles = device
        .cast::<ID3D11VideoDevice>()
        .map(|video| unsafe { video.GetVideoDecoderProfileCount() });
    assert!(
        matches!(profiles, Err(_) | Ok(0)),
        "WARP expose {profiles:?} profils décodeur — le repli WARP redevient envisageable"
    );
}
