//! Compositeur D3D11 : rend les calques dans un render target RGBA8, un draw par quad.
//! NV12 échantillonné depuis les textures décodeur (SRV par plan), effets en HLSL (§7).

use crate::config::Cfg;
use crate::cursor::CursorTrack;
use crate::d3d::Gpu;
use crate::ffi::AVFrame;
use anyhow::{bail, Result};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use windows::core::{Interface, PCSTR};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::{
    ID3DBlob, D3D11_SRV_DIMENSION_TEXTURE2DARRAY, D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP,
};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;

pub const OUT_W: u32 = 1920;
pub const OUT_H: u32 = 1080;

/// Constant buffer d'un calque (doit matcher `cbuffer Layer` du HLSL, 64 octets).
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct LayerCB {
    pub dst: [f32; 4],
    pub src: [f32; 4],
    pub quad_px: [f32; 2],
    pub radius_px: f32,
    pub mode: f32,
    pub color: [f32; 4],
    pub fx: [f32; 4],
    pub src_prev: [f32; 4],
    pub dst_prev: [f32; 4],
    pub mb: [f32; 4], // mb[0] = nombre de taps de motion blur
}

pub struct Compositor {
    dev: ID3D11Device,
    ctx: ID3D11DeviceContext,
    rt: ID3D11Texture2D,
    rtv: ID3D11RenderTargetView,
    rt_srv: ID3D11ShaderResourceView,
    staging: ID3D11Texture2D,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    vs_fs: ID3D11VertexShader,
    ps_y: ID3D11PixelShader,
    ps_uv: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    cbuf: ID3D11Buffer,
    blend: ID3D11BlendState,
    blend_none: ID3D11BlendState,
    nv12: ID3D11Texture2D, // notre NV12 simple (RT), source de la copie vers le pool encodeur
    rtv_y: ID3D11RenderTargetView,
    rtv_uv: ID3D11RenderTargetView,
    // ping-pong demi-résolution pour le flou séparable (§7 E3)
    ps_blur: ID3D11PixelShader,
    ps_tex: ID3D11PixelShader,
    half_a_rtv: ID3D11RenderTargetView,
    half_a_srv: ID3D11ShaderResourceView,
    half_b_rtv: ID3D11RenderTargetView,
    half_b_srv: ID3D11ShaderResourceView,
    // dual-Kawase : chaîne quart (480x270) + huitième (240x135)
    ps_kdown: ID3D11PixelShader,
    ps_kup: ID3D11PixelShader,
    q_rtv: ID3D11RenderTargetView,
    q_srv: ID3D11ShaderResourceView,
    e_rtv: ID3D11RenderTargetView,
    e_srv: ID3D11ShaderResourceView,
    // accumulateur pour le flou de mouvement (supersampling temporel)
    accum: ID3D11Texture2D,
    accum_rtv: ID3D11RenderTargetView,
    accum_srv: ID3D11ShaderResourceView,
    blend_add: ID3D11BlendState,
    cursor: Option<CursorTrack>,
    // cache des SRV décodeur par (texture array, slice) : le pool réutilise ~32 textures,
    // donc après warmup plus aucune création de SRV par frame (overhead CPU supprimé).
    srv_cache: RefCell<HashMap<(usize, u32), (ID3D11ShaderResourceView, ID3D11ShaderResourceView)>>,
}

pub const HALF_W: u32 = OUT_W / 2;
pub const HALF_H: u32 = OUT_H / 2;

pub const FIXTURE_FRAMES: u32 = 360;
const FPS: f32 = 60.0;

fn ease_in_out_cubic(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x < 0.5 {
        4.0 * x * x * x
    } else {
        1.0 - (-2.0 * x + 2.0).powi(3) / 2.0
    }
}
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
fn lerp4(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
    [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)]
}

/// Un calque vidéo animé (rect sortie, taille px, rayon) — screen ou webcam.
#[derive(Clone, Copy)]
struct Placement {
    dst: [f32; 4],
    radius: f32,
}

/// Paramètres d'une frame : dérivés du temps par la timeline (§8).
struct FrameParams {
    zoom: f32,
    focus: [f32; 2],
    screen: Placement,
    webcam: Placement, // dst carré (w en px via OUT_W)
}

/// Timeline figée de la fixture (6 s) : zoom 1.0→1.8→1.0, layout A(PIP)↔B(côte à côte).
/// `frame` fractionnaire pour permettre le supersampling temporel (flou de mouvement).
/// Gaté par `cfg` : zoom et layout ne bougent que si activés.
fn timeline(frame: f32, cfg: &Cfg) -> FrameParams {
    let t = frame / FPS; // secondes

    // zoom : montée [0,3s] puis descente [3s,6s], easeInOutCubic
    let zoom = if cfg.zoom {
        let zt = if t < 3.0 { ease_in_out_cubic(t / 3.0) } else { ease_in_out_cubic((6.0 - t) / 3.0) };
        1.0 + 0.8 * zt
    } else {
        1.0
    };

    // layout A = PIP bas-droite ; B = côte à côte. Transitions A→B [2,2.5]s, B→A [4,4.5]s.
    let lf = if !cfg.layout_anim {
        0.0
    } else if t < 2.0 {
        0.0
    } else if t < 2.5 {
        ease_in_out_cubic((t - 2.0) / 0.5)
    } else if t < 4.0 {
        1.0
    } else if t < 4.5 {
        1.0 - ease_in_out_cubic((t - 4.0) / 0.5)
    } else {
        0.0
    };

    // Layout A (PIP)
    let a_screen = Placement { dst: [0.05, 0.05, 0.90, 0.90], radius: 24.0 };
    let a_side = 320.0_f32;
    let a_webcam = Placement {
        dst: [
            (OUT_W as f32 - 40.0 - a_side) / OUT_W as f32,
            (OUT_H as f32 - 40.0 - a_side) / OUT_H as f32,
            a_side / OUT_W as f32,
            a_side / OUT_H as f32,
        ],
        radius: 40.0,
    };
    // Layout B (côte à côte) : screen à gauche (16:9), webcam carré à droite
    let b_screen = Placement { dst: [0.035, 0.22, 0.60, 0.5625], radius: 20.0 };
    let b_side = 520.0_f32;
    let b_webcam = Placement {
        dst: [
            0.70,
            (OUT_H as f32 - b_side) * 0.5 / OUT_H as f32,
            b_side / OUT_W as f32,
            b_side / OUT_H as f32,
        ],
        radius: 40.0,
    };

    FrameParams {
        zoom,
        focus: [0.5, 0.32],
        screen: Placement { dst: lerp4(a_screen.dst, b_screen.dst, lf), radius: lerp(a_screen.radius, b_screen.radius, lf) },
        webcam: Placement { dst: lerp4(a_webcam.dst, b_webcam.dst, lf), radius: lerp(a_webcam.radius, b_webcam.radius, lf) },
    }
}

unsafe fn compile(src: &[u8], entry: &[u8], target: &[u8]) -> Result<ID3DBlob> {
    let mut code: Option<ID3DBlob> = None;
    let mut err: Option<ID3DBlob> = None;
    let r = D3DCompile(
        src.as_ptr() as *const c_void,
        src.len(),
        PCSTR::null(),
        None,
        None,
        PCSTR(entry.as_ptr()),
        PCSTR(target.as_ptr()),
        D3DCOMPILE_OPTIMIZATION_LEVEL3,
        0,
        &mut code,
        Some(&mut err),
    );
    if r.is_err() {
        if let Some(e) = err {
            let msg = std::slice::from_raw_parts(
                e.GetBufferPointer() as *const u8,
                e.GetBufferSize(),
            );
            bail!("D3DCompile {}: {}", String::from_utf8_lossy(entry), String::from_utf8_lossy(msg));
        }
        bail!("D3DCompile a échoué");
    }
    Ok(code.unwrap())
}

impl Compositor {
    pub fn new(gpu: &Gpu) -> Result<Compositor> {
        unsafe { Self::new_inner(gpu) }
    }

    unsafe fn new_inner(gpu: &Gpu) -> Result<Compositor> {
        let dev = gpu.device.clone();
        let ctx = gpu.context.clone();

        // --- render target RGBA8 (gamma natif de la vidéo ; voir note couleur docs) ---
        let mut td = D3D11_TEXTURE2D_DESC {
            Width: OUT_W,
            Height: OUT_H,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut rt: Option<ID3D11Texture2D> = None;
        dev.CreateTexture2D(&td, None, Some(&mut rt))?;
        let rt = rt.unwrap();
        let mut rtv: Option<ID3D11RenderTargetView> = None;
        dev.CreateRenderTargetView(&rt, None, Some(&mut rtv))?;
        let mut rt_srv: Option<ID3D11ShaderResourceView> = None;
        dev.CreateShaderResourceView(&rt, None, Some(&mut rt_srv))?;

        // staging pour readback PNG
        td.Usage = D3D11_USAGE_STAGING;
        td.BindFlags = 0;
        td.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging: Option<ID3D11Texture2D> = None;
        dev.CreateTexture2D(&td, None, Some(&mut staging))?;

        // --- shaders ---
        let hlsl = include_bytes!("shaders.hlsl");
        let vsb = compile(hlsl, b"vs_main\0", b"vs_5_0\0")?;
        let psb = compile(hlsl, b"ps_main\0", b"ps_5_0\0")?;
        let vs_bytes =
            std::slice::from_raw_parts(vsb.GetBufferPointer() as *const u8, vsb.GetBufferSize());
        let ps_bytes =
            std::slice::from_raw_parts(psb.GetBufferPointer() as *const u8, psb.GetBufferSize());
        let mut vs: Option<ID3D11VertexShader> = None;
        dev.CreateVertexShader(vs_bytes, None, Some(&mut vs))?;
        let mut ps: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(ps_bytes, None, Some(&mut ps))?;

        // shaders RGB->NV12
        let fsb = compile(hlsl, b"vs_fs\0", b"vs_5_0\0")?;
        let yb = compile(hlsl, b"ps_y\0", b"ps_5_0\0")?;
        let uvb = compile(hlsl, b"ps_uv\0", b"ps_5_0\0")?;
        let fs_bytes =
            std::slice::from_raw_parts(fsb.GetBufferPointer() as *const u8, fsb.GetBufferSize());
        let y_bytes =
            std::slice::from_raw_parts(yb.GetBufferPointer() as *const u8, yb.GetBufferSize());
        let uv_bytes =
            std::slice::from_raw_parts(uvb.GetBufferPointer() as *const u8, uvb.GetBufferSize());
        let mut vs_fs: Option<ID3D11VertexShader> = None;
        dev.CreateVertexShader(fs_bytes, None, Some(&mut vs_fs))?;
        let mut ps_y: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(y_bytes, None, Some(&mut ps_y))?;
        let mut ps_uv: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(uv_bytes, None, Some(&mut ps_uv))?;

        // --- sampler bilinéaire clamp ---
        let sd = D3D11_SAMPLER_DESC {
            Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
            AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
            ComparisonFunc: D3D11_COMPARISON_NEVER,
            MaxLOD: f32::MAX,
            ..Default::default()
        };
        let mut sampler: Option<ID3D11SamplerState> = None;
        dev.CreateSamplerState(&sd, Some(&mut sampler))?;

        // --- constant buffer dynamique ---
        let bd = D3D11_BUFFER_DESC {
            ByteWidth: std::mem::size_of::<LayerCB>() as u32,
            Usage: D3D11_USAGE_DYNAMIC,
            BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
            CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
            ..Default::default()
        };
        let mut cbuf: Option<ID3D11Buffer> = None;
        dev.CreateBuffer(&bd, None, Some(&mut cbuf))?;

        // --- blend alpha prémultiplié ---
        let mut bl = D3D11_BLEND_DESC::default();
        bl.RenderTarget[0] = D3D11_RENDER_TARGET_BLEND_DESC {
            BlendEnable: true.into(),
            SrcBlend: D3D11_BLEND_ONE,
            DestBlend: D3D11_BLEND_INV_SRC_ALPHA,
            BlendOp: D3D11_BLEND_OP_ADD,
            SrcBlendAlpha: D3D11_BLEND_ONE,
            DestBlendAlpha: D3D11_BLEND_INV_SRC_ALPHA,
            BlendOpAlpha: D3D11_BLEND_OP_ADD,
            RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
        };
        let mut blend: Option<ID3D11BlendState> = None;
        dev.CreateBlendState(&bl, Some(&mut blend))?;

        // blend désactivé mais écriture ACTIVE (le défaut a WriteMask=0 -> rien n'est écrit)
        let mut bl_none = D3D11_BLEND_DESC::default();
        bl_none.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8;
        let mut blend_none: Option<ID3D11BlendState> = None;
        dev.CreateBlendState(&bl_none, Some(&mut blend_none))?;

        // notre texture NV12 simple (ArraySize=1) : NV12+RT n'est autorisé qu'en non-array
        // sur cet iGPU. On y rend la conversion, puis copie GPU->GPU vers le pool encodeur.
        let nvd = D3D11_TEXTURE2D_DESC {
            Width: OUT_W,
            Height: OUT_H,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut nv12: Option<ID3D11Texture2D> = None;
        dev.CreateTexture2D(&nvd, None, Some(&mut nv12))?;
        let nv12 = nv12.unwrap();
        let mk_rtv = |fmt: DXGI_FORMAT| -> Result<ID3D11RenderTargetView> {
            let d = D3D11_RENDER_TARGET_VIEW_DESC {
                Format: fmt,
                ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_RTV { MipSlice: 0 },
                },
            };
            let mut rtv: Option<ID3D11RenderTargetView> = None;
            dev.CreateRenderTargetView(&nv12, Some(&d), Some(&mut rtv))?;
            Ok(rtv.unwrap())
        };
        let rtv_y = mk_rtv(DXGI_FORMAT_R8_UNORM)?;
        let rtv_uv = mk_rtv(DXGI_FORMAT_R8G8_UNORM)?;

        // shaders de flou + copie
        let blurb = compile(hlsl, b"ps_blur\0", b"ps_5_0\0")?;
        let texb = compile(hlsl, b"ps_tex\0", b"ps_5_0\0")?;
        let mut ps_blur: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(
            std::slice::from_raw_parts(blurb.GetBufferPointer() as *const u8, blurb.GetBufferSize()),
            None,
            Some(&mut ps_blur),
        )?;
        let mut ps_tex: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(
            std::slice::from_raw_parts(texb.GetBufferPointer() as *const u8, texb.GetBufferSize()),
            None,
            Some(&mut ps_tex),
        )?;

        // shaders dual-Kawase
        let kdb = compile(hlsl, b"ps_kawase_down\0", b"ps_5_0\0")?;
        let kub = compile(hlsl, b"ps_kawase_up\0", b"ps_5_0\0")?;
        let mut ps_kdown: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(
            std::slice::from_raw_parts(kdb.GetBufferPointer() as *const u8, kdb.GetBufferSize()),
            None,
            Some(&mut ps_kdown),
        )?;
        let mut ps_kup: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(
            std::slice::from_raw_parts(kub.GetBufferPointer() as *const u8, kub.GetBufferSize()),
            None,
            Some(&mut ps_kup),
        )?;

        // textures RGBA RT+SRV à une taille donnée (chaîne de flou)
        let mk_rgba = |w: u32, h: u32| -> Result<(ID3D11RenderTargetView, ID3D11ShaderResourceView)> {
            let hd = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut t: Option<ID3D11Texture2D> = None;
            dev.CreateTexture2D(&hd, None, Some(&mut t))?;
            let t = t.unwrap();
            let mut rtv: Option<ID3D11RenderTargetView> = None;
            dev.CreateRenderTargetView(&t, None, Some(&mut rtv))?;
            let mut srv: Option<ID3D11ShaderResourceView> = None;
            dev.CreateShaderResourceView(&t, None, Some(&mut srv))?;
            Ok((rtv.unwrap(), srv.unwrap()))
        };
        let (half_a_rtv, half_a_srv) = mk_rgba(HALF_W, HALF_H)?;
        let (half_b_rtv, half_b_srv) = mk_rgba(HALF_W, HALF_H)?;
        let (q_rtv, q_srv) = mk_rgba(HALF_W / 2, HALF_H / 2)?; // 480x270
        let (e_rtv, e_srv) = mk_rgba(HALF_W / 4, HALF_H / 4)?; // 240x135

        // accumulateur pleine réso (RGBA) + blend additif pondéré (facteur = 1/N)
        let ad = D3D11_TEXTURE2D_DESC {
            Width: OUT_W,
            Height: OUT_H,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut accum: Option<ID3D11Texture2D> = None;
        dev.CreateTexture2D(&ad, None, Some(&mut accum))?;
        let accum = accum.unwrap();
        let mut accum_rtv: Option<ID3D11RenderTargetView> = None;
        dev.CreateRenderTargetView(&accum, None, Some(&mut accum_rtv))?;
        let mut accum_srv: Option<ID3D11ShaderResourceView> = None;
        dev.CreateShaderResourceView(&accum, None, Some(&mut accum_srv))?;

        let mut bla = D3D11_BLEND_DESC::default();
        bla.RenderTarget[0] = D3D11_RENDER_TARGET_BLEND_DESC {
            BlendEnable: true.into(),
            SrcBlend: D3D11_BLEND_BLEND_FACTOR,
            DestBlend: D3D11_BLEND_ONE,
            BlendOp: D3D11_BLEND_OP_ADD,
            SrcBlendAlpha: D3D11_BLEND_BLEND_FACTOR,
            DestBlendAlpha: D3D11_BLEND_ONE,
            BlendOpAlpha: D3D11_BLEND_OP_ADD,
            RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
        };
        let mut blend_add: Option<ID3D11BlendState> = None;
        dev.CreateBlendState(&bla, Some(&mut blend_add))?;

        Ok(Compositor {
            dev,
            ctx,
            rt,
            rtv: rtv.unwrap(),
            rt_srv: rt_srv.unwrap(),
            staging: staging.unwrap(),
            vs: vs.unwrap(),
            ps: ps.unwrap(),
            vs_fs: vs_fs.unwrap(),
            ps_y: ps_y.unwrap(),
            ps_uv: ps_uv.unwrap(),
            sampler: sampler.unwrap(),
            cbuf: cbuf.unwrap(),
            blend: blend.unwrap(),
            blend_none: blend_none.unwrap(),
            nv12,
            rtv_y,
            rtv_uv,
            ps_blur: ps_blur.unwrap(),
            ps_tex: ps_tex.unwrap(),
            half_a_rtv,
            half_a_srv,
            half_b_rtv,
            half_b_srv,
            ps_kdown: ps_kdown.unwrap(),
            ps_kup: ps_kup.unwrap(),
            q_rtv,
            q_srv,
            e_rtv,
            e_srv,
            accum,
            accum_rtv: accum_rtv.unwrap(),
            accum_srv: accum_srv.unwrap(),
            blend_add: blend_add.unwrap(),
            cursor: None,
            srv_cache: RefCell::new(HashMap::new()),
        })
    }

    /// Crée les SRV Y (R8) et UV (R8G8) sur la tranche d'array de la frame décodeur.
    pub unsafe fn nv12_srvs(
        &self,
        frame: *const AVFrame,
    ) -> Result<(ID3D11ShaderResourceView, ID3D11ShaderResourceView)> {
        let tex_ptr = (*frame).data[0] as *mut c_void;
        let slice = (*frame).data[1] as u32;
        // cache hit : le pool réutilise les mêmes textures -> zéro création après warmup
        let key = (tex_ptr as usize, slice);
        if let Some((y, uv)) = self.srv_cache.borrow().get(&key) {
            return Ok((y.clone(), uv.clone()));
        }
        let tex = ID3D11Texture2D::from_raw_borrowed(&tex_ptr)
            .ok_or_else(|| anyhow::anyhow!("frame sans texture D3D11"))?
            .clone();

        let mk = |fmt: DXGI_FORMAT| -> Result<ID3D11ShaderResourceView> {
            let mut d = D3D11_SHADER_RESOURCE_VIEW_DESC {
                Format: fmt,
                ViewDimension: D3D11_SRV_DIMENSION_TEXTURE2DARRAY,
                ..Default::default()
            };
            d.Anonymous.Texture2DArray = D3D11_TEX2D_ARRAY_SRV {
                MostDetailedMip: 0,
                MipLevels: 1,
                FirstArraySlice: slice,
                ArraySize: 1,
            };
            let mut srv: Option<ID3D11ShaderResourceView> = None;
            self.dev.CreateShaderResourceView(&tex, Some(&d), Some(&mut srv))?;
            Ok(srv.unwrap())
        };
        let y = mk(DXGI_FORMAT_R8_UNORM)?;
        let uv = mk(DXGI_FORMAT_R8G8_UNORM)?;
        self.srv_cache.borrow_mut().insert(key, (y.clone(), uv.clone()));
        Ok((y, uv))
    }

    /// Dimensions réelles de la texture décodeur (alignée macrobloc : 1080->1088, etc.).
    pub unsafe fn tex_dims(&self, frame: *const AVFrame) -> (u32, u32) {
        let tex_ptr = (*frame).data[0] as *mut c_void;
        let tex = ID3D11Texture2D::from_raw_borrowed(&tex_ptr).unwrap();
        let mut d = D3D11_TEXTURE2D_DESC::default();
        tex.GetDesc(&mut d);
        (d.Width, d.Height)
    }

    /// État de composition : RT principal, viewport plein, shaders de calque, blend prémultiplié.
    /// (Sans clear — sert à reprendre après les passes de flou.)
    pub unsafe fn bind_compose_state(&self) {
        self.ctx.OMSetRenderTargets(Some(&[Some(self.rtv.clone())]), None);
        let vp = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: OUT_W as f32, Height: OUT_H as f32, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp]));
        self.ctx.VSSetShader(&self.vs, None);
        self.ctx.PSSetShader(&self.ps, None);
        self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
        self.ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
        self.ctx.OMSetBlendState(&self.blend, None, 0xffffffff);
    }

    /// Prépare la passe : état de composition + clear.
    pub unsafe fn begin(&self, clear: [f32; 4]) {
        self.bind_compose_state();
        self.ctx.ClearRenderTargetView(&self.rtv, &clear);
    }

    /// Passe plein écran générique (triangle unique) : `srv` -> `rtv` via `ps`, avec `fx`.
    unsafe fn fs_pass(
        &self,
        rtv: &ID3D11RenderTargetView,
        srv: &ID3D11ShaderResourceView,
        ps: &ID3D11PixelShader,
        w: u32,
        h: u32,
        fx: [f32; 4],
    ) {
        self.ctx.OMSetBlendState(&self.blend_none, None, 0xffffffff);
        self.ctx.OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);
        self.ctx.PSSetShaderResources(0, Some(&[Some(srv.clone())]));
        self.ctx.VSSetShader(&self.vs_fs, None);
        self.ctx.PSSetShader(ps, None);
        self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
        let vp = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: w as f32, Height: h as f32, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp]));
        self.upload_cb(&LayerCB { fx, ..Default::default() });
        self.ctx.Draw(3, 0);
        self.ctx.PSSetShaderResources(0, Some(&[None]));
    }

    /// Fond flouté (§7), dual-Kawase : suppose le screen déjà dessiné plein écran dans le RT.
    /// Chaîne down (RT→960→480→240) puis up (240→480→960→RT). ~6 passes de 5-8 taps
    /// à résolution décroissante, vs 2 passes gaussiennes 49-tap. Le RT devient le fond.
    pub unsafe fn blur_bg(&self, _sigma: f32) {
        let off = 2.2; // spread par passe
        let hw = HALF_W as f32;
        let hh = HALF_H as f32;
        // DOWN : texel = 1/(dims de la SOURCE échantillonnée)
        self.fs_pass(&self.half_a_rtv, &self.rt_srv, &self.ps_kdown, HALF_W, HALF_H,
            [1.0 / OUT_W as f32, 1.0 / OUT_H as f32, off, 0.0]);
        self.fs_pass(&self.q_rtv, &self.half_a_srv, &self.ps_kdown, HALF_W / 2, HALF_H / 2,
            [1.0 / hw, 1.0 / hh, off, 0.0]);
        self.fs_pass(&self.e_rtv, &self.q_srv, &self.ps_kdown, HALF_W / 4, HALF_H / 4,
            [2.0 / hw, 2.0 / hh, off, 0.0]);
        // UP
        self.fs_pass(&self.q_rtv, &self.e_srv, &self.ps_kup, HALF_W / 2, HALF_H / 2,
            [4.0 / hw, 4.0 / hh, off, 0.0]);
        self.fs_pass(&self.half_a_rtv, &self.q_srv, &self.ps_kup, HALF_W, HALF_H,
            [2.0 / hw, 2.0 / hh, off, 0.0]);
        self.fs_pass(&self.rtv, &self.half_a_srv, &self.ps_kup, OUT_W, OUT_H,
            [1.0 / hw, 1.0 / hh, off, 0.0]);
    }

    unsafe fn upload_cb(&self, cb: &LayerCB) {
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        self.ctx
            .Map(&self.cbuf, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut m))
            .unwrap();
        std::ptr::copy_nonoverlapping(cb as *const LayerCB as *const u8, m.pData as *mut u8, std::mem::size_of::<LayerCB>());
        self.ctx.Unmap(&self.cbuf, 0);
        self.ctx.VSSetConstantBuffers(0, Some(&[Some(self.cbuf.clone())]));
        self.ctx.PSSetConstantBuffers(0, Some(&[Some(self.cbuf.clone())]));
    }

    /// Calque vidéo NV12.
    pub unsafe fn draw_video(
        &self,
        cb: &LayerCB,
        srv_y: &ID3D11ShaderResourceView,
        srv_uv: &ID3D11ShaderResourceView,
    ) {
        self.upload_cb(cb);
        self.ctx
            .PSSetShaderResources(0, Some(&[Some(srv_y.clone()), Some(srv_uv.clone())]));
        self.ctx.Draw(4, 0);
    }

    /// Calque couleur pleine (fond).
    pub unsafe fn draw_solid(&self, cb: &LayerCB) {
        self.upload_cb(cb);
        self.ctx.Draw(4, 0);
    }

    pub fn set_cursor(&mut self, track: CursorTrack) {
        self.cursor = Some(track);
    }

    /// Curseur custom (dot+ring) centré en `center` (0..1 sortie), taille `size_px`, opacité `a`.
    unsafe fn draw_cursor(&self, center: [f32; 2], size_px: f32, a: f32) {
        let w = size_px / OUT_W as f32;
        let h = size_px / OUT_H as f32;
        self.draw_solid(&LayerCB {
            dst: [center[0] - w * 0.5, center[1] - h * 0.5, w, h],
            quad_px: [size_px, size_px],
            mode: 4.0,
            color: [1.0, 1.0, 1.0, a],
            ..Default::default()
        });
    }

    /// Ombre portée (§7 E4) sous un quad `dst` (normalisé) de taille `size_px`.
    /// Le quad d'ombre est élargi de `spread` px et décalé de `offset_px`.
    pub unsafe fn draw_shadow(
        &self,
        dst: [f32; 4],
        size_px: [f32; 2],
        radius: f32,
        spread: f32,
        offset_px: [f32; 2],
        opacity: f32,
    ) {
        let sx = spread / OUT_W as f32;
        let sy = spread / OUT_H as f32;
        let ox = offset_px[0] / OUT_W as f32;
        let oy = offset_px[1] / OUT_H as f32;
        let cb = LayerCB {
            dst: [dst[0] - sx + ox, dst[1] - sy + oy, dst[2] + 2.0 * sx, dst[3] + 2.0 * sy],
            quad_px: [size_px[0] + 2.0 * spread, size_px[1] + 2.0 * spread],
            radius_px: radius,
            mode: 2.0,
            color: [0.0, 0.0, 0.0, opacity],
            fx: [spread, 0.0, 0.0, 0.0],
            ..Default::default()
        };
        self.draw_solid(&cb);
    }

    /// Compose une frame animée (§6/§8) : fond flouté + screen zoomé (padding, coins, ombre)
    /// + webcam crop carré (coins, ombre), placements interpolés A↔B par la timeline.
    pub unsafe fn compose_frame(
        &self,
        screen: *const AVFrame,
        webcam: *const AVFrame,
        frame: f32,
        cfg: &Cfg,
    ) -> Result<()> {
        let (sy, suv) = self.nv12_srvs(screen)?;
        let (wy, wuv) = self.nv12_srvs(webcam)?;
        let (stw, sth) = self.tex_dims(screen);
        let (wtw, wth) = self.tex_dims(webcam);
        let (scw, sch) = ((*screen).width as f32, (*screen).height as f32);
        let (wcw, wch) = ((*webcam).width as f32, (*webcam).height as f32);
        let u_max = scw / stw as f32;
        let v_max = sch / sth as f32;

        let p = timeline(frame, cfg);
        let pp = timeline(frame - 1.0, cfg); // frame précédente, pour la vélocité (§8)
        let mb_taps = cfg.mblur_n as f32;
        let s_radius = if cfg.rounded { p.screen.radius } else { 0.0 };
        let w_radius = if cfg.rounded { p.webcam.radius } else { 0.0 };

        self.begin([0.0, 0.0, 0.0, 1.0]);

        // --- fond : flouté (screen plein cadre + gaussien) ou couleur plate ---
        if cfg.bg_blur {
            let over = 0.06;
            self.draw_video(
                &LayerCB {
                    dst: [-over, -over, 1.0 + 2.0 * over, 1.0 + 2.0 * over],
                    src: [0.0, 0.0, u_max, v_max],
                    quad_px: [OUT_W as f32, OUT_H as f32],
                    mode: 0.0,
                    color: [1.0, 1.0, 1.0, 1.0],
                    ..Default::default()
                },
                &sy,
                &suv,
            );
            self.blur_bg(18.0);
            self.bind_compose_state();
            self.draw_solid(&LayerCB {
                dst: [0.0, 0.0, 1.0, 1.0],
                mode: 1.0,
                color: [0.0, 0.0, 0.0, 0.35],
                ..Default::default()
            });
        } else {
            self.draw_solid(&LayerCB {
                dst: [0.0, 0.0, 1.0, 1.0],
                mode: 1.0,
                color: [0.10, 0.11, 0.14, 1.0],
                ..Default::default()
            });
        }

        // --- screen : zoom appliqué au rect source (§8) ---
        let cx = p.focus[0] * u_max;
        let cy = p.focus[1] * v_max;
        let hu = u_max / (2.0 * p.zoom);
        let hv = v_max / (2.0 * p.zoom);
        let su0 = (cx - hu).clamp(0.0, u_max - 2.0 * hu);
        let sv0 = (cy - hv).clamp(0.0, v_max - 2.0 * hv);
        // rect source à la frame précédente (zoom différent) pour la vélocité
        let hu_p = u_max / (2.0 * pp.zoom);
        let hv_p = v_max / (2.0 * pp.zoom);
        let su0_p = (cx - hu_p).clamp(0.0, u_max - 2.0 * hu_p);
        let sv0_p = (cy - hv_p).clamp(0.0, v_max - 2.0 * hv_p);
        let s_px = [p.screen.dst[2] * OUT_W as f32, p.screen.dst[3] * OUT_H as f32];
        if cfg.shadow {
            self.draw_shadow(p.screen.dst, s_px, s_radius, 40.0, [0.0, 16.0], 0.45);
        }
        self.draw_video(
            &LayerCB {
                dst: p.screen.dst,
                src: [su0, sv0, su0 + 2.0 * hu, sv0 + 2.0 * hv],
                quad_px: s_px,
                radius_px: s_radius,
                mode: 0.0,
                color: [0.0, 0.0, 0.0, 1.0],
                src_prev: [su0_p, sv0_p, su0_p + 2.0 * hu_p, sv0_p + 2.0 * hv_p],
                dst_prev: pp.screen.dst,
                mb: [mb_taps, 0.0, 0.0, 0.0],
                ..Default::default()
            },
            &sy,
            &suv,
        );

        // --- curseur custom : suit le mapping src/dst (zoom+layout), click bounce,
        // et flou de mouvement par fantômes le long de sa vélocité (frame-1 -> frame) ---
        if cfg.cursor {
            if let Some(track) = &self.cursor {
                let t = frame / FPS;
                // position sortie à un temps donné via un mapping screen (src rect + dst)
                let map = |cxy: Option<(f32, f32)>, s0: [f32; 2], h: [f32; 2], dst: [f32; 4]| {
                    cxy.and_then(|(cx2, cy2)| {
                        let fx = (cx2 * u_max - s0[0]) / (2.0 * h[0]);
                        let fy = (cy2 * v_max - s0[1]) / (2.0 * h[1]);
                        if (0.0..=1.0).contains(&fx) && (0.0..=1.0).contains(&fy) {
                            Some([dst[0] + fx * dst[2], dst[1] + fy * dst[3]])
                        } else {
                            None
                        }
                    })
                };
                if let Some(cur) = map(track.at(t), [su0, sv0], [hu, hv], p.screen.dst) {
                    let sz = 34.0 * track.bounce(t);
                    let taps = cfg.mblur_n;
                    if taps <= 1 {
                        self.draw_cursor(cur, sz, 1.0);
                    } else {
                        let tp = (frame - 1.0) / FPS;
                        let prev = map(track.at(tp), [su0_p, sv0_p], [hu_p, hv_p], pp.screen.dst)
                            .unwrap_or(cur);
                        for k in 0..taps {
                            let f = k as f32 / (taps - 1) as f32;
                            let c = [prev[0] + (cur[0] - prev[0]) * f, prev[1] + (cur[1] - prev[1]) * f];
                            let a = (k as f32 + 1.0) / taps as f32; // traîne -> tête
                            self.draw_cursor(c, sz, a);
                        }
                    }
                }
            }
        }

        // --- webcam : center-crop carré ---
        let sq = wch;
        let u0 = (wcw - sq) * 0.5 / wtw as f32;
        let u1 = u0 + sq / wtw as f32;
        let w_px = [p.webcam.dst[2] * OUT_W as f32, p.webcam.dst[3] * OUT_H as f32];
        if cfg.shadow {
            self.draw_shadow(p.webcam.dst, w_px, w_radius, 32.0, [0.0, 12.0], 0.5);
        }
        self.draw_video(
            &LayerCB {
                dst: p.webcam.dst,
                src: [u0, 0.0, u1, wch / wth as f32],
                quad_px: w_px,
                radius_px: w_radius,
                mode: 0.0,
                color: [0.0, 0.0, 0.0, 1.0],
                src_prev: [u0, 0.0, u1, wch / wth as f32], // src fixe (pas de zoom webcam)
                dst_prev: pp.webcam.dst,
                mb: [mb_taps, 0.0, 0.0, 0.0],
                ..Default::default()
            },
            &wy,
            &wuv,
        );
        Ok(())
    }

    /// Flou de mouvement (§8) : moyenne de `n` sous-frames aux temps intermédiaires
    /// (mêmes textures vidéo, params d'animation à frame+k/n). Résultat laissé dans le RT.
    pub unsafe fn compose_frame_mb(
        &self,
        screen: *const AVFrame,
        webcam: *const AVFrame,
        frame: u32,
        cfg: &Cfg,
    ) -> Result<()> {
        let n = cfg.mblur_n;
        if n <= 1 {
            return self.compose_frame(screen, webcam, frame as f32, cfg);
        }
        // accumulateur à zéro
        self.ctx.ClearRenderTargetView(&self.accum_rtv, &[0.0, 0.0, 0.0, 0.0]);
        let w = 1.0 / n as f32;
        for k in 0..n {
            let tf = frame as f32 + (k as f32 + 0.5) / n as f32 - 0.5;
            self.compose_frame(screen, webcam, tf, cfg)?; // -> self.rt
            // accum += rt * (1/n)  (blend factor = 1/n, dest = ONE)
            self.ctx.OMSetRenderTargets(Some(&[Some(self.accum_rtv.clone())]), None);
            self.ctx.PSSetShaderResources(0, Some(&[Some(self.rt_srv.clone())]));
            self.ctx.VSSetShader(&self.vs_fs, None);
            self.ctx.PSSetShader(&self.ps_tex, None);
            self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            let vp = D3D11_VIEWPORT {
                TopLeftX: 0.0, TopLeftY: 0.0,
                Width: OUT_W as f32, Height: OUT_H as f32, MinDepth: 0.0, MaxDepth: 1.0,
            };
            self.ctx.RSSetViewports(Some(&[vp]));
            self.ctx.OMSetBlendState(&self.blend_add, Some(&[w, w, w, w]), 0xffffffff);
            self.upload_cb(&LayerCB::default());
            self.ctx.Draw(3, 0);
            self.ctx.PSSetShaderResources(0, Some(&[None]));
        }
        // recopie l'accumulateur dans le RT (pour rgb_to_nv12 qui échantillonne rt_srv)
        let src: ID3D11Resource = self.accum.cast()?;
        let dst: ID3D11Resource = self.rt.cast()?;
        self.ctx.CopyResource(&dst, &src);
        Ok(())
    }

    /// Rend le RT RGBA vers notre texture NV12 puis copie vers la surface `out_tex`/`slice`.
    pub unsafe fn rgb_to_nv12(&self, out_tex: *mut c_void, slice: u32) -> Result<()> {
        self.render_nv12();
        let src: ID3D11Resource = self.nv12.cast()?;
        let dst_tex = ID3D11Texture2D::from_raw_borrowed(&out_tex).unwrap().clone();
        let dst: ID3D11Resource = dst_tex.cast()?;
        self.ctx.CopySubresourceRegion(&dst, slice, 0, 0, 0, &src, 0, None);
        Ok(())
    }

    /// Convertit le RT RGBA vers notre texture NV12 (§5) : Y pleine réso, UV demi-réso.
    pub unsafe fn render_nv12(&self) {
        self.ctx.OMSetBlendState(&self.blend_none, None, 0xffffffff);
        self.ctx.VSSetShader(&self.vs_fs, None);
        self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));

        // passe Y : basculer le RT AVANT de binder le SRV (le RGBA RT était encore RTV via
        // begin() ; D3D11 rejetterait le SRV d'une ressource encore liée en RTV).
        self.ctx.OMSetRenderTargets(Some(&[Some(self.rtv_y.clone())]), None);
        self.ctx.PSSetShaderResources(0, Some(&[Some(self.rt_srv.clone())]));
        let vp_y = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: OUT_W as f32, Height: OUT_H as f32, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp_y]));
        self.ctx.PSSetShader(&self.ps_y, None);
        self.ctx.Draw(3, 0);

        // passe UV (demi-résolution)
        self.ctx.OMSetRenderTargets(Some(&[Some(self.rtv_uv.clone())]), None);
        let vp_uv = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: (OUT_W / 2) as f32, Height: (OUT_H / 2) as f32, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp_uv]));
        self.ctx.PSSetShader(&self.ps_uv, None);
        self.ctx.Draw(3, 0);

        // libère le SRV du RT (il redevient RTV au prochain begin())
        self.ctx.PSSetShaderResources(0, Some(&[None]));
    }

    /// Debug : dump notre NV12 (Y puis UV entrelacé) en RAW, pour inspecter la conversion.
    pub unsafe fn dump_nv12(&self, path: &str) -> Result<()> {
        let sd = D3D11_TEXTURE2D_DESC {
            Width: OUT_W,
            Height: OUT_H,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut stg: Option<ID3D11Texture2D> = None;
        self.dev.CreateTexture2D(&sd, None, Some(&mut stg))?;
        let stg = stg.unwrap();
        let src: ID3D11Resource = self.nv12.cast()?;
        let dstr: ID3D11Resource = stg.cast()?;
        self.ctx.CopyResource(&dstr, &src);
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        self.ctx.Map(&stg, 0, D3D11_MAP_READ, 0, Some(&mut m))?;
        let mut out = Vec::with_capacity((OUT_W * OUT_H * 3 / 2) as usize);
        // plan Y
        for y in 0..OUT_H as usize {
            let row = (m.pData as *const u8).add(y * m.RowPitch as usize);
            out.extend_from_slice(std::slice::from_raw_parts(row, OUT_W as usize));
        }
        // plan UV : commence à RowPitch*Height (offset donné par le pitch), demi-hauteur
        let uv_off = m.RowPitch as usize * OUT_H as usize;
        for y in 0..(OUT_H / 2) as usize {
            let row = (m.pData as *const u8).add(uv_off + y * m.RowPitch as usize);
            out.extend_from_slice(std::slice::from_raw_parts(row, OUT_W as usize));
        }
        self.ctx.Unmap(&stg, 0);
        std::fs::write(path, &out)?;
        Ok(())
    }

    /// Recopie le RT en RAM (RGBA tightly-packed) — vérification uniquement.
    pub unsafe fn dump_raw(&self, path: &str) -> Result<()> {
        self.ctx.CopyResource(&self.staging, &self.rt);
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        self.ctx.Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut m))?;
        let mut out = vec![0u8; (OUT_W * OUT_H * 4) as usize];
        for y in 0..OUT_H as usize {
            let src = (m.pData as *const u8).add(y * m.RowPitch as usize);
            let dst = out.as_mut_ptr().add(y * OUT_W as usize * 4);
            std::ptr::copy_nonoverlapping(src, dst, OUT_W as usize * 4);
        }
        self.ctx.Unmap(&self.staging, 0);
        std::fs::write(path, &out)?;
        Ok(())
    }
}
