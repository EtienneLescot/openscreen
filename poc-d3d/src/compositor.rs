//! Compositeur D3D11 : rend les calques dans un render target RGBA8, un draw par quad.
//! NV12 échantillonné depuis les textures décodeur (SRV par plan), effets en HLSL (§7).

use crate::config::Cfg;
use crate::cursor::CursorTrack;
use crate::scene::{Scene, SceneBackground};
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

/// Parse une couleur "#rgb" / "#rrggbb" (sRGB, comme les wallpapers web) → [r,g,b,a] 0..1.
/// Les couleurs plates suivent le même chemin que `bg_color` (pas de linéarisation).
fn parse_hex(s: &str) -> Option<[f32; 4]> {
    let h = s.trim().trim_start_matches('#');
    let (r, g, b) = match h.len() {
        3 => {
            let d = |i: usize| u8::from_str_radix(&h[i..=i], 16).ok().map(|v| v * 17);
            (d(0)?, d(1)?, d(2)?)
        }
        6 => (
            u8::from_str_radix(&h[0..2], 16).ok()?,
            u8::from_str_radix(&h[2..4], 16).ok()?,
            u8::from_str_radix(&h[4..6], 16).ok()?,
        ),
        _ => return None,
    };
    Some([r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0])
}

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

/// Valeurs continues pilotées par l'inspector (celles qui étaient codées en dur dans
/// `compose_frame`). Le défaut reproduit le rendu actuel → bench/export inchangés.
/// Les booléens/taps (fond flouté, ombre on/off, coins on/off, motion blur) restent
/// portés par le `Cfg` que le thread live reconstruit depuis les switches.
#[derive(Clone, Copy)]
pub struct LiveParams {
    pub bg_color: [f32; 4],       // fond plat (mode couleur) quand non flouté
    pub shadow_scale: f32,        // multiplie l'opacité des ombres (1 = défaut, 0 = off)
    pub radius_scale: f32,        // multiplie le rayon des coins (1 = défaut, 0 = carré)
    pub padding: f32,             // 0..1 : inset supplémentaire du screen (0 = défaut fixture)
    pub webcam_size_scale: f32,   // multiplie la taille de la webcam (1 = défaut)
    pub webcam_mirror: bool,      // miroir horizontal de la webcam
    pub webcam_shape: u32,        // 0=rect, 1=circle, 2=square, 3=rounded (défaut)
    pub cursor_size_scale: f32,   // multiplie la taille du curseur (1 = défaut)
    pub cursor_bounce_scale: f32, // multiplie l'amplitude du click-bounce (1 = défaut, 0 = off)
    /// 0..1 : flou de mouvement DU CURSEUR (indépendant du motion blur écran/`cfg.mblur_n`).
    /// Approximé par le même mécanisme de traînée fantôme (taps décalés le long de la
    /// vélocité), pas par un flou gaussien variable comme le canvas web — plus simple à
    /// réutiliser côté GPU, effet de streak équivalent.
    pub cursor_motion_blur: f32,
}

impl Default for LiveParams {
    fn default() -> Self {
        Self {
            bg_color: [0.10, 0.11, 0.14, 1.0],
            shadow_scale: 1.0,
            radius_scale: 1.0,
            padding: 0.0,
            webcam_size_scale: 1.0,
            webcam_mirror: false,
            webcam_shape: 3,
            cursor_size_scale: 1.0,
            cursor_bounce_scale: 1.0,
            cursor_motion_blur: 0.0,
        }
    }
}

/// "rectangle"|"circle"|"square"|"rounded" -> code webcam_shape (0/1/2/3). Partagé entre le
/// live (`live.rs::set_param_str`) et l'export (construit `LiveParams` depuis la scène) — une
/// seule table de vérité pour ce mapping.
pub fn webcam_shape_code(shape: &str) -> u32 {
    match shape {
        "rectangle" => 0,
        "circle" => 1,
        "square" => 2,
        _ => 3, // "rounded" (défaut)
    }
}

/// Construit les `LiveParams` équivalents à ce que l'inspector pousse en live, mais depuis la
/// scène de l'app — l'export est un rendu one-shot sans historique de sliders, donc il doit lire
/// directement la config déjà posée dans la scène plutôt que dupliquer un mécanisme d'inspector.
/// Unités identiques à `RightPanes.tsx` (mêmes conversions, pas de re-normalisation) : voir
/// `sceneDescription.ts` pour la correspondance settings -> champs de scène.
pub fn live_params_from_scene(s: &crate::scene::Scene) -> LiveParams {
    const NATIVE_SCREEN_BASE_RADIUS_PX: f32 = 24.0;
    LiveParams {
        shadow_scale: s.effects.shadow,
        radius_scale: s.effects.roundness_px / NATIVE_SCREEN_BASE_RADIUS_PX,
        padding: s.effects.padding,
        webcam_size_scale: s.layout.webcam_size,
        webcam_mirror: s.layout.webcam_mirror,
        webcam_shape: webcam_shape_code(&s.layout.webcam_shape),
        cursor_size_scale: s.cursor.size,
        cursor_bounce_scale: s.cursor.click_bounce,
        cursor_motion_blur: s.cursor.motion_blur,
        ..LiveParams::default()
    }
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
    /// RefCell (pas un simple champ) pour que `set_cursor` reste `&self`, comme `set_scene` /
    /// `set_live_params` — nécessaire pour le rebrancher par clip dans l'export multiclip, qui
    /// n'a qu'une référence partagée au `Compositor`.
    cursor: RefCell<Option<CursorTrack>>,
    /// Override du temps d'échantillonnage curseur (secondes) — `None` = comportement fixture
    /// (`frame / FPS`). L'export multiclip et le live le positionnent au PTS écran courant,
    /// c'est-à-dire au temps source absolu du clip actif.
    cursor_t_override: RefCell<Option<f32>>,
    /// Override du temps des zoom/full-camera regions (secondes source du clip actif). Le nom
    /// `timeline_t_override` est conservé pour l'API existante, mais ce temps n'est plus cumulé
    /// entre clips : les régions projetées par l'app portent elles aussi des temps source.
    /// Séparé de l'override curseur pour préserver les chemins fixture sans télémétrie.
    timeline_t_override: RefCell<Option<f32>>,
    // cache des SRV décodeur par (texture array, slice) : le pool réutilise ~32 textures,
    // donc après warmup plus aucune création de SRV par frame (overhead CPU supprimé).
    srv_cache: RefCell<HashMap<(usize, u32), (ID3D11ShaderResourceView, ID3D11ShaderResourceView)>>,
    live_params: RefCell<LiveParams>,
    /// Scène pilotée par l'app (contrat) : quand présente, remplace le layout fixture de
    /// `timeline()`. Voir `scene.rs` / `SceneDescription` (TS).
    scene: RefCell<Option<Scene>>,
    /// Cache des textures wallpaper image (clé = chemin absolu) : décodage/upload une seule
    /// fois, puis réutilisées par frame. (SRV, largeur, hauteur).
    img_cache: RefCell<HashMap<String, (ID3D11ShaderResourceView, u32, u32)>>,
    /// Ressources de resize export (allouées paresseusement à la 1re taille de sortie ≠
    /// OUT_W×OUT_H — le live et les exports "Source"/1080p restent sur `rgb_to_nv12` inchangé,
    /// zéro coût). Voir `rgb_to_nv12_scaled`.
    resize_target: RefCell<Option<ResizeTarget>>,
}

/// Ressources d'un resize export à une taille cible : RGBA intermédiaire (résultat du
/// redimensionnement bilinéaire du RT composé, toujours rendu en interne à OUT_W×OUT_H) +
/// sa propre texture NV12 à cette même taille cible (le NV12 principal du `Compositor` reste
/// fixé à OUT_W×OUT_H, partagé par le live).
struct ResizeTarget {
    w: u32,
    h: u32,
    rgba_rtv: ID3D11RenderTargetView,
    rgba_srv: ID3D11ShaderResourceView,
    nv12: ID3D11Texture2D,
    nv12_rtv_y: ID3D11RenderTargetView,
    nv12_rtv_uv: ID3D11RenderTargetView,
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
#[derive(Clone, Copy)]
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

/// Placements statiques screen+webcam pour un preset de layout de l'app (contrat de scène) —
/// remplace le planning A↔B fixture de `timeline()`. Zoom = 1 (les zoom regions viennent ensuite).
/// La taille/forme/miroir webcam restent appliqués par-dessus via `LiveParams`.
fn preset_placements(preset: &str) -> FrameParams {
    // plein cadre : le padding l'insère ensuite (padding 0 → bord à bord).
    let full_screen = Placement { dst: [0.0, 0.0, 1.0, 1.0], radius: 24.0 };
    // PiP bas-droite (≈ layout A fixture).
    let a_side = 320.0_f32;
    let pip_webcam = Placement {
        dst: [
            (OUT_W as f32 - 40.0 - a_side) / OUT_W as f32,
            (OUT_H as f32 - 40.0 - a_side) / OUT_H as f32,
            a_side / OUT_W as f32,
            a_side / OUT_H as f32,
        ],
        radius: 40.0,
    };
    // webcam hors écran (no-webcam) : quad de taille nulle, jamais visible.
    let off_webcam = Placement { dst: [2.0, 2.0, 0.0, 0.0], radius: 0.0 };

    let (screen, webcam) = match preset {
        "dual-frame" => {
            // côte à côte : screen 16:9 à gauche, webcam carré à droite (≈ layout B fixture).
            let b_side = 520.0_f32;
            (
                Placement { dst: [0.035, 0.22, 0.60, 0.5625], radius: 20.0 },
                Placement {
                    dst: [
                        0.70,
                        (OUT_H as f32 - b_side) * 0.5 / OUT_H as f32,
                        b_side / OUT_W as f32,
                        b_side / OUT_H as f32,
                    ],
                    radius: 40.0,
                },
            )
        }
        "vertical-stack" => {
            // haut/bas : screen en haut, webcam carré centré en bas.
            let w_side = 360.0_f32;
            (
                Placement { dst: [0.13, 0.04, 0.74, 0.52], radius: 20.0 },
                Placement {
                    dst: [
                        0.5 - (w_side * 0.5) / OUT_W as f32,
                        0.60,
                        w_side / OUT_W as f32,
                        w_side / OUT_H as f32,
                    ],
                    radius: 40.0,
                },
            )
        }
        "no-webcam" => (full_screen, off_webcam),
        _ => (full_screen, pip_webcam), // "picture-in-picture" (défaut)
    };

    FrameParams { zoom: 1.0, focus: [0.5, 0.5], screen, webcam }
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
            cursor: RefCell::new(None),
            cursor_t_override: RefCell::new(None),
            timeline_t_override: RefCell::new(None),
            srv_cache: RefCell::new(HashMap::new()),
            live_params: RefCell::new(LiveParams::default()),
            scene: RefCell::new(None),
            img_cache: RefCell::new(HashMap::new()),
            resize_target: RefCell::new(None),
        })
    }

    /// Met à jour les paramètres continus pilotés par l'inspector (thread live uniquement).
    pub fn set_live_params(&self, p: LiveParams) {
        *self.live_params.borrow_mut() = p;
    }

    /// Installe (ou retire) la scène de l'app. Présente → `compose_frame` prend ses placements
    /// depuis le layout preset au lieu du planning fixture.
    pub fn set_scene(&self, s: Option<Scene>) {
        *self.scene.borrow_mut() = s;
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

    /// Fond wallpaper image (cover-fit). `path` = chemin absolu (résolu côté app). Décodé et
    /// uploadé une fois (cache), puis échantillonné en mode 6. Err → l'appelant retombe sur une
    /// couleur plate. Le rect uv `src` recouvre toute la sortie en rognant le débordement.
    unsafe fn draw_image_bg(&self, path: &str) -> Result<()> {
        // NB : la recherche est isolée dans un `let` pour que l'emprunt immuable soit relâché
        // AVANT le `borrow_mut()` (sinon double-emprunt RefCell → panic sur la 1re frame image).
        let cached = self.img_cache.borrow().get(path).cloned();
        let (srv, iw, ih) = match cached {
            Some(v) => v,
            None => {
                let loaded = self.load_image_srv(path)?;
                self.img_cache.borrow_mut().insert(path.to_string(), loaded.clone());
                loaded
            }
        };
        let ai = iw as f32 / ih as f32;
        let ao = OUT_W as f32 / OUT_H as f32;
        let (u0, v0, u1, v1) = if ai > ao {
            let vis = ao / ai; // rogne horizontalement
            ((1.0 - vis) * 0.5, 0.0, 1.0 - (1.0 - vis) * 0.5, 1.0)
        } else {
            let vis = ai / ao; // rogne verticalement
            (0.0, (1.0 - vis) * 0.5, 1.0, 1.0 - (1.0 - vis) * 0.5)
        };
        self.upload_cb(&LayerCB {
            dst: [0.0, 0.0, 1.0, 1.0],
            src: [u0, v0, u1, v1],
            mode: 6.0,
            ..Default::default()
        });
        self.ctx.PSSetShaderResources(2, Some(&[Some(srv)]));
        self.ctx.Draw(4, 0);
        Ok(())
    }

    /// Décode un fichier image (jpg/png) → texture RGBA immuable + SRV.
    unsafe fn load_image_srv(&self, path: &str) -> Result<(ID3D11ShaderResourceView, u32, u32)> {
        let img = image::open(path)
            .map_err(|e| anyhow::anyhow!("wallpaper {}: {}", path, e))?
            .to_rgba8();
        let (w, h) = (img.width(), img.height());
        let pixels = img.into_raw();
        let td = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_IMMUTABLE,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let init = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr() as *const c_void,
            SysMemPitch: w * 4,
            SysMemSlicePitch: 0,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        self.dev.CreateTexture2D(&td, Some(&init), Some(&mut tex))?;
        let tex = tex.unwrap();
        let mut srv: Option<ID3D11ShaderResourceView> = None;
        self.dev.CreateShaderResourceView(&tex, None, Some(&mut srv))?;
        Ok((srv.unwrap(), w, h))
    }

    pub fn set_cursor(&self, track: CursorTrack) {
        *self.cursor.borrow_mut() = Some(track);
    }

    pub fn clear_cursor(&self) {
        *self.cursor.borrow_mut() = None;
    }

    /// Voir `cursor_t_override`. `None` restaure le comportement fixture (`frame / FPS`).
    pub fn set_cursor_time(&self, t: Option<f32>) {
        *self.cursor_t_override.borrow_mut() = t;
    }

    /// Voir `timeline_t_override`. `None` restaure le comportement fixture (`frame / FPS`).
    pub fn set_timeline_time(&self, t: Option<f32>) {
        *self.timeline_t_override.borrow_mut() = t;
    }

    /// Copie de la scène courante (si présente) — utilisé par l'export multiclip pour lire les
    /// réglages curseur (thème/lissage/show) sans dupliquer le contrat de scène côté pipeline.
    pub fn scene_snapshot(&self) -> Option<Scene> {
        self.scene.borrow().clone()
    }

    /// Curseur custom (dot+ring) centré en `center` (0..1 sortie), taille `size_px`, opacité `a`.
    /// `clip` = rect "Clip to canvas" en espace sortie [x,y,w,h] ; passer un rect englobant tout
    /// (ex. [-1,-1,3,3]) pour désactiver l'effet.
    unsafe fn draw_cursor(&self, center: [f32; 2], size_px: f32, a: f32, clip: [f32; 4]) {
        let w = size_px / OUT_W as f32;
        let h = size_px / OUT_H as f32;
        self.draw_solid(&LayerCB {
            dst: [center[0] - w * 0.5, center[1] - h * 0.5, w, h],
            quad_px: [size_px, size_px],
            mode: 4.0,
            color: [1.0, 1.0, 1.0, a],
            fx: clip,
            ..Default::default()
        });
    }

    /// Curseur thème (sprite PNG, ex. arrow.png) centré en `center`, taille de référence
    /// `size_px` (ancré centre — l'ajustement fin du hotspot par thème est un raffinement
    /// futur). `Err` → l'appelant retombe sur `draw_cursor` (math dot+ring).
    unsafe fn draw_cursor_sprite(
        &self,
        center: [f32; 2],
        size_px: f32,
        a: f32,
        path: &str,
        clip: [f32; 4],
    ) -> Result<()> {
        let cached = self.img_cache.borrow().get(path).cloned();
        let (srv, iw, ih) = match cached {
            Some(v) => v,
            None => {
                let loaded = self.load_image_srv(path)?;
                self.img_cache.borrow_mut().insert(path.to_string(), loaded.clone());
                loaded
            }
        };
        let ar = iw as f32 / ih as f32;
        let (pw, ph) = if ar >= 1.0 { (size_px, size_px / ar) } else { (size_px * ar, size_px) };
        let w = pw / OUT_W as f32;
        let h = ph / OUT_H as f32;
        self.upload_cb(&LayerCB {
            dst: [center[0] - w * 0.5, center[1] - h * 0.5, w, h],
            src: [0.0, 0.0, 1.0, 1.0],
            mode: 7.0,
            color: [1.0, 1.0, 1.0, a],
            fx: clip,
            ..Default::default()
        });
        self.ctx.PSSetShaderResources(2, Some(&[Some(srv)]));
        self.ctx.Draw(4, 0);
        Ok(())
    }

    /// Sprite du thème si résolu et chargeable, sinon le curseur math (dot+ring).
    unsafe fn draw_cur_themed(
        &self,
        sprite: &Option<String>,
        center: [f32; 2],
        size_px: f32,
        a: f32,
        clip: [f32; 4],
    ) {
        if let Some(path) = sprite {
            if self.draw_cursor_sprite(center, size_px, a, path, clip).is_ok() {
                return;
            }
        }
        self.draw_cursor(center, size_px, a, clip);
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

        // Scène de l'app présente → placements du layout preset ; sinon planning fixture (bench).
        let scene_preset: Option<String> =
            self.scene.borrow().as_ref().map(|s| s.layout.preset.clone());
        let (mut p, mut pp) = match &scene_preset {
            Some(preset) => {
                let fp = preset_placements(preset);
                (fp, fp) // layout statique → vélocité nulle
            }
            None => (timeline(frame, cfg), timeline(frame - 1.0, cfg)),
        };
        let is_vstack = scene_preset.as_deref() == Some("vertical-stack");
        let lp = *self.live_params.borrow();
        let mb_taps = cfg.mblur_n as f32;

        // Zoom regions + Full Camera : filtrées en amont pour le clip actif et échantillonnées
        // dans le même référentiel source que le PTS du décodeur écran.
        let scene_ref = self.scene.borrow();
        let empty_zoom: Vec<crate::scene::SceneZoomRegion> = Vec::new();
        let empty_cam: Vec<crate::scene::SceneCameraFullscreenRegion> = Vec::new();
        let zoom_regions = scene_ref.as_ref().map(|s| &s.zoom_regions).unwrap_or(&empty_zoom);
        let cam_regions =
            scene_ref.as_ref().map(|s| &s.camera_fullscreen_regions).unwrap_or(&empty_cam);
        let webcam_reactive = scene_ref.as_ref().map(|s| s.layout.webcam_reactive_zoom).unwrap_or(false);
        let source_t = self.timeline_t_override.borrow().unwrap_or(frame / FPS);
        let source_t_prev = source_t - 1.0 / FPS;
        // le focus "auto" (suivi curseur) réutilise la même piste que le rendu du curseur.
        let cursor_ref = self.cursor.borrow();
        let cursor_for_zoom = cursor_ref.as_ref();
        // La rotation 3D (mode 8, pas de motion blur dans ce chemin — cf. le commentaire au
        // point d'appel) n'est calculée QUE pour la frame courante ; `pp` ne sert qu'au zoom
        // écran normal (vélocité pour le motion blur du chemin non-tilté).
        let mut zoom_rotation = [0.0f32; 3];
        if !zoom_regions.is_empty() {
            let zs = crate::regions::zoom_state_at(zoom_regions, source_t, cursor_for_zoom);
            p.zoom = zs.scale;
            p.focus = zs.focus;
            zoom_rotation = zs.rotation;
            let zs_p = crate::regions::zoom_state_at(zoom_regions, source_t_prev, cursor_for_zoom);
            pp.zoom = zs_p.scale;
            pp.focus = zs_p.focus;
        }
        // Full Camera ignore le rétrécissement réactif de la webcam (design web : mélanger
        // "rétrécit pour le zoom" et "grandit en plein cadre" dans la même frame n'a pas de sens).
        let cam_progress = crate::regions::camera_fullscreen_progress_at(cam_regions, source_t);
        let cam_progress_prev =
            crate::regions::camera_fullscreen_progress_at(cam_regions, source_t_prev);
        // rétrécissement réactif : la webcam rétrécit pendant un zoom actif (1/zoom, plancher
        // 0.35 — parité `reactiveWebcamScale`, TS). Ignoré pendant Full Camera (voir ci-dessus).
        let reactive_scale = |zoom: f32, progress: f32| -> f32 {
            if webcam_reactive && progress <= 0.0 && zoom.is_finite() && zoom > 0.0 {
                (1.0 / zoom).clamp(0.35, 1.0)
            } else {
                1.0
            }
        };
        let webcam_size_scale = lp.webcam_size_scale * reactive_scale(p.zoom, cam_progress);
        let webcam_size_scale_prev = lp.webcam_size_scale * reactive_scale(pp.zoom, cam_progress_prev);

        // padding : échelle globale du layout autour du centre du cadre (parité web frameRenderer :
        // paddingScale = 1 - padding*0.4 → padding 0 = plein cadre). Vertical-stack l'ignore.
        let padding_scale = if is_vstack { 1.0 } else { 1.0 - lp.padding * 0.4 };
        let scale_frame = |dst: [f32; 4], s: f32| -> [f32; 4] {
            [0.5 + (dst[0] - 0.5) * s, 0.5 + (dst[1] - 0.5) * s, dst[2] * s, dst[3] * s]
        };
        // webcam : ancrée à son coin bas-droite (grandit vers le haut-gauche, pas depuis le centre).
        let scale_corner_br = |dst: [f32; 4], s: f32| -> [f32; 4] {
            let (brx, bry) = (dst[0] + dst[2], dst[1] + dst[3]);
            let (nw, nh) = (dst[2] * s, dst[3] * s);
            [brx - nw, bry - nh, nw, nh]
        };
        // parité web (compositeLayout) : rectangle/rounded gardent le ratio natif de la webcam ;
        // square/circle forcent un carré (side = min). Le placement de base est carré → on ajuste
        // ici, en gardant le coin bas-droite fixe (cohérent avec le size-scale).
        let is_square_shape = matches!(lp.webcam_shape, 1 | 2); // circle | square
        let cam_ar = if is_square_shape { 1.0 } else { (wcw / wch).max(0.01) };
        let fit_cam_aspect = |dst: [f32; 4]| -> [f32; 4] {
            let s = (dst[2] * OUT_W as f32).min(dst[3] * OUT_H as f32); // côté carré de base (px)
            let (pw, ph) = if cam_ar >= 1.0 { (s, s / cam_ar) } else { (s * cam_ar, s) };
            let (nw, nh) = (pw / OUT_W as f32, ph / OUT_H as f32);
            let (brx, bry) = (dst[0] + dst[2], dst[1] + dst[3]);
            [brx - nw, bry - nh, nw, nh]
        };
        let s_dst = scale_frame(p.screen.dst, padding_scale);
        let s_dst_prev = scale_frame(pp.screen.dst, padding_scale);
        // le padding n'affecte QUE l'écran (la quantité de fond révélée). La webcam reste ancrée
        // en bas-droite à sa marge fixe, quelle que soit la valeur de padding (pas de scale_frame).
        let mut w_dst = fit_cam_aspect(scale_corner_br(p.webcam.dst, webcam_size_scale));
        let mut w_dst_prev = fit_cam_aspect(scale_corner_br(pp.webcam.dst, webcam_size_scale_prev));

        // Full Camera : la webcam grandit pour couvrir (presque) tout le cadre, en conservant
        // SON ratio actuel (pas celui du cadre) — parité `computeCameraFullscreenTargetRect` (TS) :
        // marge = 2.5% du plus petit côté du cadre, ajustée pour tenir dans les bornes.
        let fullscreen_dst = |dst: [f32; 4], progress: f32| -> [f32; 4] {
            if progress <= 0.0 {
                return dst;
            }
            let margin_px = OUT_W.min(OUT_H) as f32 * 0.025;
            let bounds_w = (OUT_W as f32 - margin_px * 2.0).max(0.0);
            let bounds_h = (OUT_H as f32 - margin_px * 2.0).max(0.0);
            let cur_w_px = dst[2] * OUT_W as f32;
            let cur_h_px = dst[3] * OUT_H as f32;
            let aspect = if cur_h_px > 0.0 { cur_w_px / cur_h_px } else { 1.0 };
            let (mut full_w, mut full_h) = (bounds_w, bounds_w / aspect);
            if full_h > bounds_h {
                full_h = bounds_h;
                full_w = full_h * aspect;
            }
            let full_x = margin_px + (bounds_w - full_w) * 0.5;
            let full_y = margin_px + (bounds_h - full_h) * 0.5;
            let cur_x_px = dst[0] * OUT_W as f32;
            let cur_y_px = dst[1] * OUT_H as f32;
            let lerp = |a: f32, b: f32| a + (b - a) * progress;
            [
                lerp(cur_x_px, full_x) / OUT_W as f32,
                lerp(cur_y_px, full_y) / OUT_H as f32,
                lerp(cur_w_px, full_w) / OUT_W as f32,
                lerp(cur_h_px, full_h) / OUT_H as f32,
            ]
        };
        w_dst = fullscreen_dst(w_dst, cam_progress);
        w_dst_prev = fullscreen_dst(w_dst_prev, cam_progress_prev);

        let s_radius = if cfg.rounded { p.screen.radius * lp.radius_scale } else { 0.0 };
        let w_px = [w_dst[2] * OUT_W as f32, w_dst[3] * OUT_H as f32];
        // forme webcam : rayon SDF dérivé de la SEULE forme choisie. Le slider Roundness ne
        // s'applique qu'à l'ÉCRAN, jamais à la caméra. Parité web (compositeLayout) : rectangle
        // ET square ont un léger arrondi (fraction 0.12) — ils ne diffèrent que par le ratio ;
        // rounded est nettement plus arrondi (0.3) ; circle = demi-côté.
        let w_min = w_px[0].min(w_px[1]);
        let w_radius = match lp.webcam_shape {
            1 => w_min * 0.5,  // circle
            3 => w_min * 0.3,  // rounded (nettement plus arrondi)
            _ => w_min * 0.12, // rectangle / square → léger arrondi (identique)
        };

        self.begin([0.0, 0.0, 0.0, 1.0]);

        // --- fond ---
        // Parité web (frameRenderer.blurredBackgroundLayer) : le fond est le WALLPAPER sélectionné
        // (image/couleur/gradient) et « Blur BG » floute CE wallpaper, PAS la vidéo. Le natif
        // dupliquait la vidéo floutée → le « vieux flou ». Côté APP (scène présente) on dessine
        // donc le wallpaper (couleur pour l'instant ; gradient/image rendus depuis la scène
        // ensuite ; pour une couleur plate le flou est un no-op visuel). Côté fixture/bench
        // (pas de scène) on garde le fond screen-flouté, dont le coût est mesuré (C4).
        let scene_bg = self.scene.borrow().as_ref().map(|s| (s.background.clone(), s.effects.blur));
        if let Some((bg, blur_wallpaper)) = scene_bg {
            match bg {
                SceneBackground::Color { color } => {
                    let c = parse_hex(&color).unwrap_or(lp.bg_color);
                    self.draw_solid(&LayerCB {
                        dst: [0.0, 0.0, 1.0, 1.0],
                        mode: 1.0,
                        color: c,
                        ..Default::default()
                    });
                }
                SceneBackground::Gradient { angle_deg, stops } => {
                    let c0 = stops.first().and_then(|s| parse_hex(s)).unwrap_or(lp.bg_color);
                    let c1 = stops.last().and_then(|s| parse_hex(s)).unwrap_or(c0);
                    // angle CSS → direction unitaire (espace sortie, y vers le bas) :
                    // 0° = vers le haut, 90° = vers la droite.
                    let a = angle_deg.to_radians();
                    let dir = [a.sin(), -a.cos()];
                    self.draw_solid(&LayerCB {
                        dst: [0.0, 0.0, 1.0, 1.0],
                        src: [c1[0], c1[1], c1[2], c1[3]],
                        mode: 5.0,
                        color: c0,
                        fx: [dir[0], dir[1], 0.0, 0.0],
                        ..Default::default()
                    });
                }
                SceneBackground::Image { path } => {
                    // image bg (cover-fit, mise en cache) ; fallback couleur si chargement échoue
                    // (loggé — un fallback silencieux masquerait un chemin cassé, cf. le panic
                    // borrow qu'on a déjà eu : toute panne doit être visible/traçable).
                    if let Err(e) = self.draw_image_bg(&path) {
                        eprintln!("[compositor] wallpaper image \"{}\" : {:#}", path, e);
                        self.draw_solid(&LayerCB {
                            dst: [0.0, 0.0, 1.0, 1.0],
                            mode: 1.0,
                            color: lp.bg_color,
                            ..Default::default()
                        });
                    }
                }
            }
            // « Blur BG » (parité web blurredBackgroundLayer) : floute CE wallpaper qu'on vient
            // de dessiner (dual-Kawase, déjà utilisé pour le fond fixture ci-dessous). No-op
            // visuel sur une couleur plate, effet réel sur gradient/image.
            if blur_wallpaper {
                self.blur_bg(18.0);
                self.bind_compose_state();
            }
        } else if cfg.bg_blur {
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
                color: lp.bg_color,
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
        let s_px = [s_dst[2] * OUT_W as f32, s_dst[3] * OUT_H as f32];
        if cfg.shadow {
            self.draw_shadow(s_dst, s_px, s_radius, 40.0, [0.0, 16.0], 0.45 * lp.shadow_scale);
        }
        if crate::regions::is_identity_rotation(zoom_rotation) {
            self.draw_video(
                &LayerCB {
                    dst: s_dst,
                    src: [su0, sv0, su0 + 2.0 * hu, sv0 + 2.0 * hv],
                    quad_px: s_px,
                    radius_px: s_radius,
                    mode: 0.0,
                    color: [0.0, 0.0, 0.0, 1.0],
                    src_prev: [su0_p, sv0_p, su0_p + 2.0 * hu_p, sv0_p + 2.0 * hv_p],
                    dst_prev: s_dst_prev,
                    mb: [mb_taps, 0.0, 0.0, 0.0],
                    ..Default::default()
                },
                &sy,
                &suv,
            );
        } else {
            // Tilt 3D (zoom "rotation" iso/left/right) : warp bilinéaire inverse (mode 8, voir
            // shaders.hlsl) — pas de motion blur ni de coins arrondis dans ce chemin (le tilt
            // est un effet ponctuel bref, cette simplification ne se voit pas).
            let corners = crate::regions::rotated_quad_corners_px(s_px[0], s_px[1], zoom_rotation);
            let (cx_px, cy_px) =
                ((s_dst[0] + s_dst[2] * 0.5) * OUT_W as f32, (s_dst[1] + s_dst[3] * 0.5) * OUT_H as f32);
            let (min_x, max_x) = corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| {
                (mn.min(x), mx.max(x))
            });
            let (min_y, max_y) = corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| {
                (mn.min(y), mx.max(y))
            });
            let bbox_w = (max_x - min_x).max(1.0);
            let bbox_h = (max_y - min_y).max(1.0);
            let bbox_dst = [
                (cx_px + min_x) / OUT_W as f32,
                (cy_px + min_y) / OUT_H as f32,
                bbox_w / OUT_W as f32,
                bbox_h / OUT_H as f32,
            ];
            // coins en px LOCAUX à la bbox (0..bbox_w/h), pour matcher `i.local` du shader.
            let local = |(x, y): (f32, f32)| -> [f32; 2] { [x - min_x, y - min_y] };
            let [tl0, tl1] = local(corners[0]);
            let [tr0, tr1] = local(corners[1]);
            let [br0, br1] = local(corners[2]);
            let [bl0, bl1] = local(corners[3]);
            self.draw_video(
                &LayerCB {
                    dst: bbox_dst,
                    src: [su0, sv0, su0 + 2.0 * hu, sv0 + 2.0 * hv],
                    quad_px: [bbox_w, bbox_h],
                    mode: 8.0,
                    fx: [tl0, tl1, tr0, tr1],
                    src_prev: [br0, br1, bl0, bl1],
                    ..Default::default()
                },
                &sy,
                &suv,
            );
        }

        // --- curseur custom : suit le mapping src/dst (zoom+layout), click bounce,
        // et flou de mouvement par fantômes le long de sa vélocité (frame-1 -> frame) ---
        // Thème (sprite) si résolu par l'app, sinon math dot+ring (défaut / fallback si le
        // sprite ne charge pas).
        let cursor_sprite: Option<String> =
            self.scene.borrow().as_ref().and_then(|s| s.cursor.cursor_sprite_path.clone());
        // « Clip to canvas » : tronque le curseur aux bords de l'écran (utile quand le padding
        // crée une marge et que la pointe, près du bord de la vidéo, dépasserait dedans).
        // Rect englobant tout par défaut = pas d'effet (le mode 4/7 du shader clippe sur `fx`).
        let cursor_clip_rect: [f32; 4] = match self.scene.borrow().as_ref() {
            Some(s) if s.cursor.clip_to_bounds => s_dst,
            _ => [-1.0, -1.0, 3.0, 3.0],
        };
        if cfg.cursor {
            let cursor_ref = self.cursor.borrow();
            if let Some(track) = cursor_ref.as_ref() {
                let t = self.cursor_t_override.borrow().unwrap_or(frame / FPS);
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
                if let Some(cur) = map(track.at(t), [su0, sv0], [hu, hv], s_dst) {
                    // taille + amplitude du bounce pilotées par l'inspector (défauts = fixture).
                    // `padding_scale` : le curseur est un recouvrement synthétique, pas cuit dans
                    // la vidéo — quand le padding rétrécit l'écran, le curseur doit rétrécir
                    // pareil pour rester à l'échelle du contenu (sinon sa pointe semble se
                    // décaler/dériver à mesure que le padding grandit).
                    let bounce = 1.0 + (track.bounce(t) - 1.0) * lp.cursor_bounce_scale;
                    let sz = 34.0 * lp.cursor_size_scale * bounce * padding_scale;
                    // flou de mouvement DU CURSEUR, indépendant de cfg.mblur_n (écran/vidéo).
                    // BUG corrigé : augmenter l'intensité ne faisait auparavant que sur-échantillonner
                    // (plus de taps) un écart figé d'1 frame (1/60s) -> la traînée ne s'allongeait
                    // JAMAIS, donc restait quasi invisible quel que soit le réglage. L'intensité doit
                    // étirer la FENÊTRE temporelle de la traînée, pas seulement sa densité d'échantillons.
                    // 0 -> 1 frame en arrière (net) ; 1 -> ~8 frames (~130 ms à 60fps, traînée nette).
                    let blur01 = lp.cursor_motion_blur.clamp(0.0, 1.0);
                    let has_scene = self.scene.borrow().is_some();
                    let trail_frames = if has_scene { 1.0 + blur01 * 7.0 } else { 1.0 };
                    // BUG corrigé : le plancher était 2 (pas 1) -> même à blur=0 le curseur
                    // passait TOUJOURS par le chemin additif multi-tap (poids 1/taps=0.5 chacun),
                    // et comme prev≠cur au pixel près, les deux copies à 0.5 d'alpha ne se
                    // recouvraient jamais parfaitement -> curseur en permanence semi-transparent
                    // (quasi invisible sur fond clair), même sans aucun flou demandé.
                    let taps = if has_scene {
                        (1.0 + blur01 * 10.0).round() as u32 // 0 -> 1 (net) ; 1 -> 11 (traînée)
                    } else {
                        cfg.mblur_n // fixture/bench : comportement historique inchangé
                    };
                    if taps <= 1 {
                        self.draw_cur_themed(&cursor_sprite, cur, sz, 1.0, cursor_clip_rect);
                    } else {
                        let tp = t - trail_frames / FPS;
                        let prev = map(track.at(tp), [su0_p, sv0_p], [hu_p, hv_p], s_dst_prev)
                            .unwrap_or(cur);
                        // Flou RÉEL, pas des copies discrètes : accumule les N échantillons dans un
                        // buffer ISOLÉ (transparent), pas directement sur la scène déjà composée.
                        // BUG précédent : additionner directement sur `self.rtv` revient à AJOUTER
                        // la couleur du curseur (blanc) à ce qu'il y a déjà dessous — sur un fond
                        // clair, ajouter du blanc*petit-alpha ne change presque rien de visible
                        // (déjà proche du blanc) -> curseur quasi invisible. En accumulant d'abord
                        // dans un buffer à part (parti de zéro, même mécanisme que le motion blur
                        // écran de `compose_frame_mb`), la somme reste correctement normalisée
                        // (alpha final ~1 si les échantillons se recouvrent), puis on la composite
                        // sur la scène par un blend "over" classique — correct quel que soit le fond.
                        self.ctx.ClearRenderTargetView(&self.accum_rtv, &[0.0, 0.0, 0.0, 0.0]);
                        self.ctx.OMSetRenderTargets(Some(&[Some(self.accum_rtv.clone())]), None);
                        let w = 1.0 / taps as f32;
                        self.ctx.OMSetBlendState(&self.blend_add, Some(&[w, w, w, w]), 0xffffffff);
                        for k in 0..taps {
                            let f = k as f32 / (taps - 1) as f32;
                            let c = [prev[0] + (cur[0] - prev[0]) * f, prev[1] + (cur[1] - prev[1]) * f];
                            self.draw_cur_themed(&cursor_sprite, c, sz, 1.0, cursor_clip_rect);
                        }
                        // composite le buffer accumulé sur la scène (blend "over" normal, prémultiplié).
                        self.ctx.OMSetRenderTargets(Some(&[Some(self.rtv.clone())]), None);
                        self.ctx.PSSetShaderResources(0, Some(&[Some(self.accum_srv.clone())]));
                        self.ctx.VSSetShader(&self.vs_fs, None);
                        self.ctx.PSSetShader(&self.ps_tex, None);
                        self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
                        let vp = D3D11_VIEWPORT {
                            TopLeftX: 0.0, TopLeftY: 0.0,
                            Width: OUT_W as f32, Height: OUT_H as f32, MinDepth: 0.0, MaxDepth: 1.0,
                        };
                        self.ctx.RSSetViewports(Some(&[vp]));
                        self.ctx.OMSetBlendState(&self.blend, None, 0xffffffff);
                        self.ctx.Draw(3, 0);
                        self.ctx.PSSetShaderResources(0, Some(&[None]));
                        // restaure l'état de composition standard (VS/PS/topologie quad-strip) pour
                        // le dessin de la webcam qui suit juste après.
                        self.bind_compose_state();
                    }
                }
            }
        }

        // --- webcam : source selon la forme (miroir horizontal optionnel) ---
        // rectangle/rounded → frame entière (ratio natif, dst déjà ajustée) ; square/circle →
        // center-crop carré. Évite toute distorsion : le dst matche le ratio de la source.
        let (su0, su1) = if is_square_shape {
            let sq = wch.min(wcw);
            let cu0 = (wcw - sq) * 0.5 / wtw as f32;
            (cu0, cu0 + sq / wtw as f32)
        } else {
            (0.0, wcw / wtw as f32)
        };
        // miroir = échanger les bornes u du rect source (flip horizontal).
        let (u0, u1) = if lp.webcam_mirror { (su1, su0) } else { (su0, su1) };
        let wv = wch / wth as f32;
        if cfg.shadow {
            self.draw_shadow(w_dst, w_px, w_radius, 32.0, [0.0, 12.0], 0.5 * lp.shadow_scale);
        }
        self.draw_video(
            &LayerCB {
                dst: w_dst,
                src: [u0, 0.0, u1, wv],
                quad_px: w_px,
                radius_px: w_radius,
                mode: 0.0,
                color: [0.0, 0.0, 0.0, 1.0],
                src_prev: [u0, 0.0, u1, wv], // src fixe (pas de zoom webcam)
                dst_prev: w_dst_prev,
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

    /// Alloue (une fois par taille) les ressources du resize export : RGBA intermédiaire +
    /// sa propre texture NV12 à `w`×`h`. `w`/`h` doivent être pairs (exigé par NV12 4:2:0,
    /// le plan UV fait exactement la moitié) — l'appelant (export_multi côté napi) arrondit.
    unsafe fn ensure_resize_target(&self, w: u32, h: u32) -> Result<()> {
        if let Some(t) = self.resize_target.borrow().as_ref() {
            if t.w == w && t.h == h {
                return Ok(());
            }
        }
        let rd = D3D11_TEXTURE2D_DESC {
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
        let mut rgba: Option<ID3D11Texture2D> = None;
        self.dev.CreateTexture2D(&rd, None, Some(&mut rgba))?;
        let rgba = rgba.unwrap();
        let mut rgba_rtv: Option<ID3D11RenderTargetView> = None;
        self.dev.CreateRenderTargetView(&rgba, None, Some(&mut rgba_rtv))?;
        let mut rgba_srv: Option<ID3D11ShaderResourceView> = None;
        self.dev.CreateShaderResourceView(&rgba, None, Some(&mut rgba_srv))?;

        // NV12 non-array à la taille cible (même contrainte que le NV12 principal).
        let nvd = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
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
        self.dev.CreateTexture2D(&nvd, None, Some(&mut nv12))?;
        let nv12 = nv12.unwrap();
        let mk_rtv = |fmt: DXGI_FORMAT| -> Result<ID3D11RenderTargetView> {
            let d = D3D11_RENDER_TARGET_VIEW_DESC {
                Format: fmt,
                ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_RTV { MipSlice: 0 } },
            };
            let mut rtv: Option<ID3D11RenderTargetView> = None;
            self.dev.CreateRenderTargetView(&nv12, Some(&d), Some(&mut rtv))?;
            Ok(rtv.unwrap())
        };
        let nv12_rtv_y = mk_rtv(DXGI_FORMAT_R8_UNORM)?;
        let nv12_rtv_uv = mk_rtv(DXGI_FORMAT_R8G8_UNORM)?;

        *self.resize_target.borrow_mut() = Some(ResizeTarget {
            w,
            h,
            rgba_rtv: rgba_rtv.unwrap(),
            rgba_srv: rgba_srv.unwrap(),
            nv12,
            nv12_rtv_y,
            nv12_rtv_uv,
        });
        Ok(())
    }

    /// Redimensionne (bilinéaire) le RT composé (OUT_W×OUT_H) vers `resize_target.rgba`, avant
    /// la conversion NV12 dans `rgb_to_nv12_scaled`.
    unsafe fn blit_resized(&self, target_w: u32, target_h: u32) -> Result<()> {
        self.ensure_resize_target(target_w, target_h)?;
        let cache = self.resize_target.borrow();
        let t = cache.as_ref().unwrap();
        self.ctx.OMSetBlendState(&self.blend_none, None, 0xffffffff);
        self.ctx.OMSetRenderTargets(Some(&[Some(t.rgba_rtv.clone())]), None);
        self.ctx.PSSetShaderResources(0, Some(&[Some(self.rt_srv.clone())]));
        self.ctx.VSSetShader(&self.vs_fs, None);
        self.ctx.PSSetShader(&self.ps_tex, None);
        self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
        let vp = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: target_w as f32, Height: target_h as f32, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp]));
        self.ctx.Draw(3, 0);
        self.ctx.PSSetShaderResources(0, Some(&[None]));
        Ok(())
    }

    /// Comme `rgb_to_nv12`, mais redimensionne d'abord (bilinéaire, `ps_tex`/`sampler` déjà
    /// utilisés partout ailleurs dans le fichier) le RT composé — toujours rendu en interne à
    /// OUT_W×OUT_H, quelle que soit la taille de sortie demandée — vers `target_w`×`target_h`
    /// avant la conversion NV12. Identique à `rgb_to_nv12` (donc coût inchangé) quand la cible
    /// égale la résolution interne : le live et les exports "Source"/1080p ne paient rien pour
    /// cette fonctionnalité.
    pub unsafe fn rgb_to_nv12_scaled(
        &self,
        target_w: u32,
        target_h: u32,
        out_tex: *mut c_void,
        slice: u32,
    ) -> Result<()> {
        if target_w == OUT_W && target_h == OUT_H {
            return self.rgb_to_nv12(out_tex, slice);
        }
        self.blit_resized(target_w, target_h)?;
        let cache = self.resize_target.borrow();
        let t = cache.as_ref().unwrap();

        // rgba (cible) -> NV12 (cible) : mêmes passes Y/UV que `render_nv12`, paramétrées.
        self.ctx.OMSetRenderTargets(Some(&[Some(t.nv12_rtv_y.clone())]), None);
        self.ctx.PSSetShaderResources(0, Some(&[Some(t.rgba_srv.clone())]));
        let vp_y = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: target_w as f32, Height: target_h as f32, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp_y]));
        self.ctx.PSSetShader(&self.ps_y, None);
        self.ctx.Draw(3, 0);

        self.ctx.OMSetRenderTargets(Some(&[Some(t.nv12_rtv_uv.clone())]), None);
        let vp_uv = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: (target_w / 2) as f32, Height: (target_h / 2) as f32, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp_uv]));
        self.ctx.PSSetShader(&self.ps_uv, None);
        self.ctx.Draw(3, 0);
        self.ctx.PSSetShaderResources(0, Some(&[None]));

        // 3) copie GPU->GPU vers le pool encodeur (identique à rgb_to_nv12).
        let src: ID3D11Resource = t.nv12.cast()?;
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

    /// Blit du RT composité (RGBA) vers un render target externe (backbuffer swapchain),
    /// mis à l'échelle dans le viewport `(x,y,w,h)` en pixels — sert la preview (§preview).
    /// Passe de copie `ps_tex` : même échantillonnage que `render_nv12`, sans conversion.
    /// Le caller a déjà clear le RTV (barres letterbox) avant l'appel.
    pub unsafe fn blit_to(&self, rtv: &ID3D11RenderTargetView, x: f32, y: f32, w: f32, h: f32) {
        self.ctx.OMSetBlendState(&self.blend_none, None, 0xffffffff);
        self.ctx.OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);
        self.ctx.PSSetShaderResources(0, Some(&[Some(self.rt_srv.clone())]));
        self.ctx.VSSetShader(&self.vs_fs, None);
        self.ctx.PSSetShader(&self.ps_tex, None);
        self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
        self.ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
        let vp = D3D11_VIEWPORT {
            TopLeftX: x, TopLeftY: y, Width: w, Height: h, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp]));
        self.upload_cb(&LayerCB::default());
        self.ctx.Draw(3, 0);
        self.ctx.PSSetShaderResources(0, Some(&[None]));
    }

    /// Vide le cache de SRV décodeur. À appeler après la fermeture d'un jeu de décodeurs
    /// (p.ex. après un export) pour ne pas retenir indéfiniment des textures de pool.
    pub fn clear_srv_cache(&self) {
        self.srv_cache.borrow_mut().clear();
    }
}
