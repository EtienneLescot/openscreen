//! Le device D3D11 unique du POC (§2).
//! Un seul `ID3D11Device`, feature level 11_1, flag VIDEO_SUPPORT (décodeur),
//! et `ID3D10Multithread::SetMultithreadProtected(TRUE)` — parce que le décodeur
//! ffmpeg et notre boucle de rendu toucheront le device depuis des threads distincts.

use anyhow::{bail, Result};
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_DEBUG,
    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
};

pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub feature_level: D3D_FEATURE_LEVEL,
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

        let levels = [D3D_FEATURE_LEVEL_11_1];
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let mut got = D3D_FEATURE_LEVEL::default();

        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                flags,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut got),
                Some(&mut context),
            )?;
        }

        let device = device.ok_or_else(|| anyhow::anyhow!("D3D11CreateDevice: pas de device"))?;
        let context = context.ok_or_else(|| anyhow::anyhow!("D3D11CreateDevice: pas de contexte"))?;

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
