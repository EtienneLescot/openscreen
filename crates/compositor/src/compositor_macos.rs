//! Moteur de composition macOS — Metal + VideoToolbox.
//!
//! Ce module EST l'équivalent macOS de `compositor_windows.rs`. Il exporte la
//! même surface publique (`Compositor`, `LiveParams`, les helpers `webcam_shape_code`/
//! `live_params_from_scene`, et les constantes `OUT_W`/`OUT_H`/`FIXTURE_FRAMES`) pour
//! que `live.rs`, `pipeline.rs` et `compositor-view-napi` restent portables.
//!
//! # Frame seam — `nv12_srvs` + `tex_dims`
//!
//! Le seam que `compositor_windows.rs` couvre avec deux `ID3D11ShaderResourceView`
//! (Y R8 + UV R8G8 sur l'array-slice d'une texture D3D11VA) est ici couvert par
//! deux `MTLTexture` produits par `CVMetalTextureCacheCreateTextureFromImage` à
//! partir d'un `CVPixelBufferRef` (le buffer natif macOS, IOSurface-backed).
//! Les 4 champs AVFrame lus sont identiques : `data[0]` (texture native), `data[1]`
//! (toujours 0 — pas d'array côté CoreVideo), `width`/`height` (visibles).
//!
//! # Chemin de lecture CPU
//!
//! Metal n'a pas d'équivalent de `ID3D11DeviceContext::Map` sur une ressource
//! `Private`. Les cibles de rendu (`rt`, `nv12_y`, `nv12_uv`) sont donc en
//! `StorageMode::Private`, et chaque passe se termine par un `MTLBlitCommandEncoder`
//! vers un miroir `Shared` (`rt_read`, `nv12_read_y`, `nv12_read_uv`) sur lequel
//! `getBytes` est légal. Le `waitUntilCompleted` qui suit est ce qui rend
//! `readback_direct` synchrone, comme son homologue Windows : sans lui, la preview
//! lirait le contenu de la frame précédente (ou du noir au premier tour).

use crate::config::Cfg;
use crate::d3d::Gpu;
use crate::ffi::AVFrame;
// Le constant buffer est le MÊME struct des deux côtés — cf. `frame_geometry`.
// Constant buffer, params runtime et constantes de sortie : une seule définition pour
// les deux backends — cf. `frame_geometry`, qui documente les divergences que
// l'unification a corrigées.
pub use crate::frame_geometry::{
    live_params_from_scene, webcam_shape_code, FIXTURE_FRAMES, LayerCB, LiveParams, OUT_H, OUT_W,
};
use crate::frame_geometry::{parse_hex, FrameGeometryInput, SCREEN_SHADOW_OFFSET_FRAC,
    SCREEN_SHADOW_SPREAD_FRAC, WEBCAM_SHADOW_OFFSET_FRAC, WEBCAM_SHADOW_OPACITY,
    WEBCAM_SHADOW_SPREAD_FRAC};
use crate::scene::{Scene, SceneBackground};
use anyhow::{anyhow, Result};
use metal::foreign_types::ForeignType;
use std::cell::RefCell;

// ---------------------------------------------------------------------------
// CVMetalTextureCache — le pont CVPixelBuffer → MTLTexture
// ---------------------------------------------------------------------------

/// Newtype safe Rust pour `CVMetalTextureCacheRef` (`*mut __CVMetalTextureCache`).
pub(crate) struct CVMetalTextureCache(std::ptr::NonNull<std::ffi::c_void>);

unsafe impl Send for CVMetalTextureCache {}
unsafe impl Sync for CVMetalTextureCache {}

#[link(name = "CoreVideo", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
#[link(name = "Metal", kind = "framework")]
extern "C" {
    fn CVMetalTextureCacheCreate(
        allocator: *const std::ffi::c_void,
        cache_attributes: *const std::ffi::c_void,
        metal_device: *const std::ffi::c_void, // id<MTLDevice>
        texture_attributes: *const std::ffi::c_void,
        cache_out: *mut *mut std::ffi::c_void, // CVMetalTextureCacheRef*
    ) -> i32; // CVReturn

    fn CVMetalTextureCacheCreateTextureFromImage(
        allocator: *const std::ffi::c_void,
        cache: *mut std::ffi::c_void,
        pixel_buffer: *mut std::ffi::c_void,
        texture_attributes: *const std::ffi::c_void,
        // `MTLPixelFormat` est un `NSUInteger`, donc 64 bits sur arm64/x86_64. Le
        // déclarer `u32` laissait la moitié haute du registre indéfinie côté appelé.
        pixel_format: u64,
        width: usize,
        height: usize,
        plane_index: usize,
        texture_out: *mut *mut std::ffi::c_void, // CVMetalTextureRef*
    ) -> i32; // CVReturn

    fn CVMetalTextureCacheFlush(cache: *mut std::ffi::c_void, options: u64);
    fn CVMetalTextureGetTexture(cv_texture: *mut std::ffi::c_void) -> *mut std::ffi::c_void;

    fn CFRelease(cf: *const std::ffi::c_void);

    fn CVPixelBufferGetWidthOfPlane(p: *mut std::ffi::c_void, plane_index: usize) -> usize;
    fn CVPixelBufferGetHeightOfPlane(p: *mut std::ffi::c_void, plane_index: usize) -> usize;
    fn CVPixelBufferGetWidth(p: *mut std::ffi::c_void) -> usize;
    fn CVPixelBufferGetHeight(p: *mut std::ffi::c_void) -> usize;
}

/// `retain` ObjC sur un `id`. `CVMetalTextureGetTexture` rend une référence
/// *empruntée* au `CVMetalTextureRef` qui la porte : relâcher ce dernier sans
/// retenir la texture donne un `id<MTLTexture>` mort. Et ne jamais le relâcher —
/// ce que faisait la première version — fuit un objet CoreVideo par plan et par
/// frame, soit 120 fuites par seconde en preview 60 fps.
extern "C" {
    fn objc_retain(obj: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

impl CVMetalTextureCache {
    /// Crée un `CVMetalTextureCache` lié au `MTLDevice` donné.
    pub(crate) fn new(metal_device: *const std::ffi::c_void) -> Result<Self> {
        let mut cache: *mut std::ffi::c_void = std::ptr::null_mut();
        let status = unsafe {
            CVMetalTextureCacheCreate(
                std::ptr::null(),
                std::ptr::null(), // default cache attributes
                metal_device,
                std::ptr::null(), // default texture attributes
                &mut cache,
            )
        };
        if status != 0 || cache.is_null() {
            return Err(anyhow!(
                "CVMetalTextureCacheCreate a échoué (CVReturn={status}, cache={cache:?})"
            ));
        }
        Ok(CVMetalTextureCache(unsafe {
            std::ptr::NonNull::new_unchecked(cache)
        }))
    }

    /// Wrappe le plan `plane_index` d'un `CVPixelBufferRef` en `MTLTexture`, zéro copie
    /// (le `MTLTexture` partage l'IOSurface du `CVPixelBuffer`).
    ///
    /// Pas de cache `(pixel_buffer, plane)` côté Rust : `CVMetalTextureCache` EST déjà
    /// ce cache — il rend la même texture pour le même IOSurface. Un second cache indexé
    /// sur l'ADRESSE du `CVPixelBufferRef` est en plus faux dès que le pool VideoToolbox
    /// recycle une adresse, et ne se vide jamais.
    pub(crate) fn make_texture_from_pixel_buffer(
        &self,
        pixel_buffer: *mut std::ffi::c_void,
        plane_index: usize,
        pixel_format: metal::MTLPixelFormat,
    ) -> Result<metal::Texture> {
        let (w, h) = unsafe {
            (
                CVPixelBufferGetWidthOfPlane(pixel_buffer, plane_index),
                CVPixelBufferGetHeightOfPlane(pixel_buffer, plane_index),
            )
        };
        if w == 0 || h == 0 {
            return Err(anyhow!(
                "CVPixelBuffer plan {plane_index} vide ({w}x{h}) — buffer non planaire ?"
            ));
        }
        let mut cv_texture: *mut std::ffi::c_void = std::ptr::null_mut();
        let status = unsafe {
            CVMetalTextureCacheCreateTextureFromImage(
                std::ptr::null(),
                self.0.as_ptr(),
                pixel_buffer,
                std::ptr::null(),
                pixel_format as u64,
                w,
                h,
                plane_index,
                &mut cv_texture,
            )
        };
        if status != 0 || cv_texture.is_null() {
            return Err(anyhow!(
                "CVMetalTextureCacheCreateTextureFromImage a échoué (CVReturn={status}, plane={plane_index}, {w}x{h}, fmt={pixel_format:?})"
            ));
        }
        let borrowed = unsafe { CVMetalTextureGetTexture(cv_texture) };
        if borrowed.is_null() {
            unsafe { CFRelease(cv_texture) };
            return Err(anyhow!(
                "CVMetalTextureGetTexture a renvoyé un id<MTLTexture> nul (plane={plane_index})"
            ));
        }
        // retain la texture, puis relâche le CVMetalTextureRef : la `metal::Texture`
        // rendue possède désormais sa propre référence, et son `Drop` fera le release.
        let owned = unsafe { objc_retain(borrowed) };
        unsafe { CFRelease(cv_texture) };
        Ok(unsafe { metal::Texture::from_ptr(owned as *mut metal::MTLTexture) })
    }

    /// Libère les textures que CoreVideo garde en cache. À appeler quand les
    /// `CVPixelBuffer` sources changent de dimensions (les entrées cachées pointent
    /// alors sur l'IOSurface précédent).
    pub(crate) fn flush(&self) {
        unsafe { CVMetalTextureCacheFlush(self.0.as_ptr(), 0) };
    }
}

impl Drop for CVMetalTextureCache {
    fn drop(&mut self) {
        unsafe {
            CVMetalTextureCacheFlush(self.0.as_ptr(), 0);
            // `CVMetalTextureCacheRef` est un CFType : c'est `CFRelease` qui le libère.
            // La version précédente ne faisait que le flush et fuitait le cache lui-même.
            CFRelease(self.0.as_ptr());
        }
    }
}

// ---------------------------------------------------------------------------
// Compositor
// ---------------------------------------------------------------------------

/// Le moteur de composition. Chaque frame décodée arrive comme un `CVPixelBufferRef`
/// IOSurface-backed (`mac_frames::CpuFrames::present` / VideoToolbox hwaccel), et
/// `nv12_srvs` le convertit en deux `MTLTexture` zéro-copie via `CVMetalTextureCache`.
///
/// **First-pass engine** : `compose_frame` rend la couche écran en plein cadre (mode 0
/// du méga-shader `ps_main`). Les couches suivantes — webcam, coins arrondis, ombres,
/// pyramide Kawase, motion blur — existent déjà dans `shaders.metal` mais ne sont pas
/// encore pilotées ici ; c'est ce que couvre le commit « couches » à suivre.
pub struct Compositor {
    gpu: Gpu,
    render_w: u32,
    render_h: u32,
    scene: RefCell<Option<Scene>>,
    cursor: RefCell<Option<crate::cursor::CursorTrack>>,
    cursor_time: RefCell<Option<f32>>,
    timeline_time: RefCell<Option<f32>>,
    live_params: RefCell<LiveParams>,
    metal_texture_cache: CVMetalTextureCache,
    /// Wallpapers décodés, indexés par chemin (ou par data-URI pour les annotations image).
    /// Le décode + upload coûte des millisecondes ; le faire à chaque frame ferait chuter la
    /// preview sur un fond image.
    img_cache: RefCell<std::collections::HashMap<String, (metal::Texture, u32, u32)>>,

    // --- Engine : render targets ---
    /// Render target principal RGBA8. Cible de `compose_frame`. `Private` : c'est une
    /// cible de rendu pure, jamais lue par le CPU (c'est `rt_read` qui l'est).
    rt: metal::Texture,
    /// Miroir `Shared` de `rt`, rempli par blit à la fin de `compose_frame` — la seule
    /// façon d'atteindre `getBytes` depuis une cible `Private`.
    rt_read: metal::Texture,
    /// NV12 interne : plan Y `R8Unorm`, plan UV `RG8Unorm` (demi-résolution).
    nv12_y: metal::Texture,
    nv12_uv: metal::Texture,
    /// Miroirs `Shared` des deux plans, pour `read_nv12_scaled`.
    nv12_read_y: metal::Texture,
    nv12_read_uv: metal::Texture,

    // --- Engine : shaders compilés ---
    /// MSL library compilée dans `new_sized`. Conservée : les pipeline states en
    /// dépendent, et un futur commit recompilera des variantes à partir d'elle.
    _library: metal::Library,
    /// Pipeline state pour la passe principale (`vs_main` + `ps_main`).
    pipeline_main: metal::RenderPipelineState,
    /// Pipeline states pour les passes fullscreen (`vs_fs` + `ps_y`/`ps_uv`/`ps_tex`).
    pipeline_fs_y: metal::RenderPipelineState,
    pipeline_fs_uv: metal::RenderPipelineState,
    /// Composite plein écran d'une texture sur le RT (`vs_fs` + `ps_tex`), en « over ».
    /// C'est la passe qui rapatrie l'accumulation de traînée sur la scène.
    pipeline_fs_tex: metal::RenderPipelineState,
    /// `vs_main` + `ps_main` en additif : les échantillons de traînée du curseur.
    pipeline_add: metal::RenderPipelineState,
    /// Buffer d'accumulation ISOLÉ (transparent) pour la traînée. Accumuler directement sur
    /// le RT reviendrait à AJOUTER du blanc à ce qui est déjà dessous : sur un fond clair,
    /// le curseur disparaît. Même raisonnement que côté D3D11.
    accum: metal::Texture,
    /// Pyramide dual-Kawase du flou de fond : demi, quart, huitième de la taille de rendu.
    /// Dérivée de la taille de rendu et non d'une constante — sinon le rayon effectif du
    /// flou changerait avec la résolution de sortie.
    blur_half: metal::Texture,
    blur_quarter: metal::Texture,
    blur_eighth: metal::Texture,
    pipeline_kdown: metal::RenderPipelineState,
    pipeline_kup: metal::RenderPipelineState,
}

/// Descripteur de texture — les six cibles ne diffèrent que par format, taille et
/// storage, donc autant ne l'écrire qu'une fois.
fn make_texture(
    device: &metal::Device,
    format: metal::MTLPixelFormat,
    w: u32,
    h: u32,
    storage: metal::MTLStorageMode,
    usage: metal::MTLTextureUsage,
) -> metal::Texture {
    let desc = metal::TextureDescriptor::new();
    desc.set_texture_type(metal::MTLTextureType::D2);
    desc.set_pixel_format(format);
    desc.set_width(w as u64);
    desc.set_height(h as u64);
    desc.set_storage_mode(storage);
    desc.set_usage(usage);
    device.new_texture(&desc)
}

/// Comment un draw se mélange à ce qui est déjà dans la cible.
#[derive(Clone, Copy, PartialEq)]
enum Blend {
    /// Opaque : la conversion NV12 et le composite fullscreen écrasent.
    Replace,
    /// « over » alpha prémultiplié — la passe de composition normale.
    Over,
    /// Additif pondéré par la couleur de blend : chaque échantillon de traînée entre pour
    /// `1/taps`. C'est `OMSetBlendState(blend_add, [w,w,w,w])` côté D3D11.
    Add,
}

/// Un pipeline state à une seule pièce jointe couleur.
fn make_pipeline(
    device: &metal::Device,
    library: &metal::Library,
    vs: &str,
    fs: &str,
    format: metal::MTLPixelFormat,
    blend: Blend,
) -> Result<metal::RenderPipelineState> {
    let vs_fn = library
        .get_function(vs, None)
        .map_err(|e| anyhow!("MTLLibrary::get_function('{vs}') : {e}"))?;
    let fs_fn = library
        .get_function(fs, None)
        .map_err(|e| anyhow!("MTLLibrary::get_function('{fs}') : {e}"))?;

    let desc = metal::RenderPipelineDescriptor::new();
    desc.set_vertex_function(Some(&vs_fn));
    desc.set_fragment_function(Some(&fs_fn));
    // metal-rs n'expose pas de constructeur pour
    // `RenderPipelineColorAttachmentDescriptor` : la pièce jointe 0 se configure sur
    // le tableau que le descripteur possède déjà.
    let ca = desc
        .color_attachments()
        .object_at(0)
        .ok_or_else(|| anyhow!("RenderPipelineDescriptor::color_attachments(0) est nul"))?;
    ca.set_pixel_format(format);
    if blend != Blend::Replace {
        ca.set_blending_enabled(true);
        ca.set_rgb_blend_operation(metal::MTLBlendOperation::Add);
        ca.set_alpha_blend_operation(metal::MTLBlendOperation::Add);
        let (src, dst) = match blend {
            Blend::Over => (metal::MTLBlendFactor::One, metal::MTLBlendFactor::OneMinusSourceAlpha),
            Blend::Add => (metal::MTLBlendFactor::BlendColor, metal::MTLBlendFactor::One),
            Blend::Replace => unreachable!(),
        };
        ca.set_source_rgb_blend_factor(src);
        ca.set_destination_rgb_blend_factor(dst);
        ca.set_source_alpha_blend_factor(src);
        ca.set_destination_alpha_blend_factor(dst);
    }
    device
        .new_render_pipeline_state(&desc)
        .map_err(|e| anyhow!("new_render_pipeline_state({vs}+{fs}) : {e}"))
}

impl Compositor {
    /// Crée le moteur sur le GPU donné. Équivalent Metal de
    /// `compositor_windows::Compositor::new`.
    pub fn new(gpu: &Gpu) -> Result<Compositor> {
        Self::new_sized(gpu, OUT_W, OUT_H)
    }

    /// Comme `new`, mais avec une taille de rendu explicite. Câble le moteur Metal :
    ///   - `CVMetalTextureCache` (zero-copy CVPixelBuffer → MTLTexture),
    ///   - render targets (RT RGBA, RT NV12 Y/UV, miroirs `Shared`),
    ///   - compilation MSL (`shaders.metal` → `MTLLibrary`),
    ///   - pipeline states (principal + passes fullscreen).
    pub fn new_sized(gpu: &Gpu, w: u32, h: u32) -> Result<Compositor> {
        let (rw, rh) = Self::normalize_render_size(w, h);
        let cache = CVMetalTextureCache::new(gpu.device.as_ptr() as *const std::ffi::c_void)?;

        let device = &gpu.device;
        let rt_usage = metal::MTLTextureUsage::RenderTarget | metal::MTLTextureUsage::ShaderRead;

        let rt = make_texture(
            device,
            metal::MTLPixelFormat::RGBA8Unorm,
            rw,
            rh,
            metal::MTLStorageMode::Private,
            rt_usage,
        );
        let rt_read = make_texture(
            device,
            metal::MTLPixelFormat::RGBA8Unorm,
            rw,
            rh,
            metal::MTLStorageMode::Shared,
            metal::MTLTextureUsage::ShaderRead,
        );
        let nv12_y = make_texture(
            device,
            metal::MTLPixelFormat::R8Unorm,
            rw,
            rh,
            metal::MTLStorageMode::Private,
            rt_usage,
        );
        // NV12 : le plan chroma est entrelacé ET demi-résolution dans les deux axes.
        // Le dimensionner comme le plan luma — ce que faisait la première version —
        // produisait un UV 4x trop grand, donc un `read_nv12_scaled` qui lit au-delà
        // de ce que la passe a écrit.
        let nv12_uv = make_texture(
            device,
            metal::MTLPixelFormat::RG8Unorm,
            rw / 2,
            rh / 2,
            metal::MTLStorageMode::Private,
            rt_usage,
        );
        let nv12_read_y = make_texture(
            device,
            metal::MTLPixelFormat::R8Unorm,
            rw,
            rh,
            metal::MTLStorageMode::Shared,
            metal::MTLTextureUsage::ShaderRead,
        );
        let nv12_read_uv = make_texture(
            device,
            metal::MTLPixelFormat::RG8Unorm,
            rw / 2,
            rh / 2,
            metal::MTLStorageMode::Shared,
            metal::MTLTextureUsage::ShaderRead,
        );

        // --- Compilation MSL ---
        let msl_source = include_str!("shaders.metal");
        let library = device
            .new_library_with_source(msl_source, &metal::CompileOptions::new())
            .map_err(|e| anyhow!("MTLDevice::new_library_with_source a échoué : {e}"))?;

        let pipeline_main = make_pipeline(
            device,
            &library,
            "vs_main",
            "ps_main",
            metal::MTLPixelFormat::RGBA8Unorm,
            Blend::Over,
        )?;
        let pipeline_fs_y = make_pipeline(
            device,
            &library,
            "vs_fs",
            "ps_y",
            metal::MTLPixelFormat::R8Unorm,
            Blend::Replace,
        )?;
        let pipeline_fs_uv = make_pipeline(
            device,
            &library,
            "vs_fs",
            "ps_uv",
            metal::MTLPixelFormat::RG8Unorm,
            Blend::Replace,
        )?;
        let pipeline_fs_tex = make_pipeline(
            device,
            &library,
            "vs_fs",
            "ps_tex",
            metal::MTLPixelFormat::RGBA8Unorm,
            Blend::Over,
        )?;
        let pipeline_add = make_pipeline(
            device,
            &library,
            "vs_main",
            "ps_main",
            metal::MTLPixelFormat::RGBA8Unorm,
            Blend::Add,
        )?;
        let accum = make_texture(
            device,
            metal::MTLPixelFormat::RGBA8Unorm,
            rw,
            rh,
            metal::MTLStorageMode::Private,
            rt_usage,
        );
        let mut pyramid = [2u32, 4, 8].map(|d| {
            make_texture(
                device,
                metal::MTLPixelFormat::RGBA8Unorm,
                (rw / d).max(1),
                (rh / d).max(1),
                metal::MTLStorageMode::Private,
                rt_usage,
            )
        });
        let blur_eighth = pyramid[2].clone();
        let blur_quarter = pyramid[1].clone();
        let blur_half = std::mem::replace(&mut pyramid[0], blur_quarter.clone());
        let pipeline_kdown = make_pipeline(
            device, &library, "vs_fs", "ps_kawase_down",
            metal::MTLPixelFormat::RGBA8Unorm, Blend::Replace,
        )?;
        let pipeline_kup = make_pipeline(
            device, &library, "vs_fs", "ps_kawase_up",
            metal::MTLPixelFormat::RGBA8Unorm, Blend::Replace,
        )?;

        Ok(Compositor {
            gpu: Gpu {
                device: gpu.device.clone(),
                context: gpu.context.clone(),
                backend: gpu.backend,
                feature_level: gpu.feature_level,
            },
            render_w: rw,
            render_h: rh,
            scene: RefCell::new(None),
            cursor: RefCell::new(None),
            cursor_time: RefCell::new(None),
            timeline_time: RefCell::new(None),
            live_params: RefCell::new(LiveParams::default()),
            metal_texture_cache: cache,
            img_cache: RefCell::new(std::collections::HashMap::new()),
            rt,
            rt_read,
            nv12_y,
            nv12_uv,
            nv12_read_y,
            nv12_read_uv,
            _library: library,
            pipeline_main,
            pipeline_fs_y,
            pipeline_fs_uv,
            pipeline_fs_tex,
            pipeline_add,
            accum,
            blur_half,
            blur_quarter,
            blur_eighth,
            pipeline_kdown,
            pipeline_kup,
        })
    }

    /// Arrondit `(w, h)` au multiple de 2 supérieur — nécessaire pour NV12 4:2:0.
    pub fn normalize_render_size(w: u32, h: u32) -> (u32, u32) {
        ((w.max(1) + 1) & !1, (h.max(1) + 1) & !1)
    }

    pub fn render_size(&self) -> (u32, u32) {
        (self.render_w, self.render_h)
    }

    pub fn set_live_params(&self, p: LiveParams) {
        *self.live_params.borrow_mut() = p;
    }

    pub fn set_scene(&self, s: Option<Scene>) {
        *self.scene.borrow_mut() = s;
    }

    pub fn set_cursor(&self, track: crate::cursor::CursorTrack) {
        *self.cursor.borrow_mut() = Some(track);
    }

    pub fn set_cursor_time(&self, t: Option<f32>) {
        *self.cursor_time.borrow_mut() = t;
    }

    pub fn set_timeline_time(&self, t: Option<f32>) {
        *self.timeline_time.borrow_mut() = t;
    }

    pub fn clear_cursor(&self) {
        *self.cursor.borrow_mut() = None;
    }

    pub fn scene_snapshot(&self) -> Option<Scene> {
        self.scene.borrow().clone()
    }

    /// Le `CVPixelBufferRef` porté par une frame, quel que soit le chemin de décodage :
    ///   - `AV_PIX_FMT_VIDEOTOOLBOX` : frame brute VideoToolbox, `data[3]` (convention ffmpeg) ;
    ///   - `AV_PIX_FMT_D3D11` : sentinel posé par `mac_frames::CpuFrames::present`, `data[0]`.
    ///
    /// Les deux aboutissent au même buffer IOSurface-backed ; `CVMetalTextureCache` n'a
    /// pas de préférence.
    unsafe fn pixel_buffer_of(frame: *const AVFrame) -> Option<*mut std::ffi::c_void> {
        if frame.is_null() {
            return None;
        }
        let pb = match (*frame).format {
            f if f == crate::ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX as i32 => {
                (*frame).data[3] as *mut std::ffi::c_void
            }
            f if f == crate::ffi::AVPixelFormat::AV_PIX_FMT_D3D11 as i32 => {
                (*frame).data[0] as *mut std::ffi::c_void
            }
            _ => return None,
        };
        if pb.is_null() {
            None
        } else {
            Some(pb)
        }
    }

    /// Dimensions réelles (texture, alignée pair) du `CVPixelBufferRef` posé dans la
    /// frame. API symétrique de `compositor_windows::tex_dims`.
    pub unsafe fn tex_dims(&self, frame: *const AVFrame) -> (u32, u32) {
        match Self::pixel_buffer_of(frame) {
            Some(pb) => (
                CVPixelBufferGetWidth(pb) as u32,
                CVPixelBufferGetHeight(pb) as u32,
            ),
            None => (0, 0),
        }
    }

    /// Crée les `MTLTexture` Y (`R8Unorm`) et UV (`RG8Unorm`) de la frame. Zéro copie :
    /// les textures Metal partagent l'IOSurface du `CVPixelBuffer`. API symétrique de
    /// `compositor_windows::nv12_srvs`.
    pub unsafe fn nv12_srvs(
        &self,
        frame: *const AVFrame,
    ) -> Result<(metal::Texture, metal::Texture)> {
        let pb = Self::pixel_buffer_of(frame).ok_or_else(|| {
            anyhow!(
                "nv12_srvs: pas de CVPixelBufferRef (format={}, ni sentinel D3D11 ni VIDEOTOOLBOX)",
                if frame.is_null() { -1 } else { (*frame).format }
            )
        })?;
        let cache = &self.metal_texture_cache;
        let y = cache.make_texture_from_pixel_buffer(pb, 0, metal::MTLPixelFormat::R8Unorm)?;
        let uv = cache.make_texture_from_pixel_buffer(pb, 1, metal::MTLPixelFormat::RG8Unorm)?;
        Ok((y, uv))
    }

    /// Les verbes de dessin, côté Metal. Mêmes noms et mêmes paramètres que leurs
    /// homologues de `compositor_windows.rs` — c'est ce qui rend les deux moitiés
    /// « dessin » comparables ligne à ligne.
    ///
    /// `ps_main` lit `LayerCB` au fragment ET `vs_main` le lit au vertex (il en tire le
    /// quad), donc les deux étages sont liés à chaque draw.
    unsafe fn draw_layer(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        cb: &LayerCB,
        tex: Option<(&metal::Texture, &metal::Texture)>,
    ) {
        let bytes = std::mem::size_of::<LayerCB>() as u64;
        let ptr = cb as *const LayerCB as *const std::ffi::c_void;
        enc.set_vertex_bytes(0, bytes, ptr);
        enc.set_fragment_bytes(0, bytes, ptr);
        if let Some((y, uv)) = tex {
            enc.set_fragment_texture(0, Some(y));
            enc.set_fragment_texture(1, Some(uv));
        }
        enc.draw_primitives(metal::MTLPrimitiveType::TriangleStrip, 0, 4);
    }

    /// Quad de couleur pleine / gradient / ombre — tout ce qui n'échantillonne pas la vidéo.
    unsafe fn draw_solid(&self, enc: &metal::RenderCommandEncoderRef, cb: &LayerCB) {
        self.draw_layer(enc, cb, None);
    }

    /// Quad vidéo NV12 (mode 0) : les deux plans de la frame décodée.
    unsafe fn draw_video(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        cb: &LayerCB,
        y: &metal::Texture,
        uv: &metal::Texture,
    ) {
        self.draw_layer(enc, cb, Some((y, uv)));
    }

    /// Ombre portée (mode 2) — port mot pour mot de `compositor_windows::draw_shadow` :
    /// le quad est élargi de `spread` de chaque côté et décalé de `offset_px`, et le
    /// shader dérive la pénombre de la SDF du rect arrondi inscrit.
    #[allow(clippy::too_many_arguments)]
    unsafe fn draw_shadow(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        dst: [f32; 4],
        size_px: [f32; 2],
        radius: f32,
        spread: f32,
        offset_px: [f32; 2],
        opacity: f32,
    ) {
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let (sx, sy) = (spread / rw, spread / rh);
        let (ox, oy) = (offset_px[0] / rw, offset_px[1] / rh);
        let cb = LayerCB {
            dst: [dst[0] - sx + ox, dst[1] - sy + oy, dst[2] + 2.0 * sx, dst[3] + 2.0 * sy],
            quad_px: [size_px[0] + 2.0 * spread, size_px[1] + 2.0 * spread],
            radius_px: radius,
            mode: 2.0,
            color: [0.0, 0.0, 0.0, opacity],
            fx: [spread, 0.0, 0.0, 0.0],
            mb: [0.0, 1.0, 1.0, 0.0],
            ..Default::default()
        };
        self.draw_solid(enc, &cb);
    }


    /// Décode un fichier image (jpg/png) — ou une data-URI — en `MTLTexture` RGBA8.
    ///
    /// Miroir de `compositor_windows::load_image_srv`. Les annotations image stockent une
    /// data URL plutôt qu'un chemin (cf. `types.ts`), d'où les deux entrées.
    fn load_image_texture(&self, path: &str) -> Result<(metal::Texture, u32, u32)> {
        let img = if let Some(bytes) = crate::frame_geometry::decode_data_uri(path) {
            image::load_from_memory(&bytes)
                .map_err(|e| anyhow!("data URI image ({} octets) : {e}", bytes.len()))?
                .to_rgba8()
        } else {
            image::open(path)
                .map_err(|e| anyhow!("wallpaper {path} : {e}"))?
                .to_rgba8()
        };
        let (w, h) = (img.width(), img.height());
        let pixels = img.into_raw();
        let tex = make_texture(
            &self.gpu.device,
            metal::MTLPixelFormat::RGBA8Unorm,
            w,
            h,
            metal::MTLStorageMode::Shared,
            metal::MTLTextureUsage::ShaderRead,
        );
        tex.replace_region(
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize { width: w as u64, height: h as u64, depth: 1 },
            },
            0,
            pixels.as_ptr() as *const std::ffi::c_void,
            (w * 4) as u64,
        );
        Ok((tex, w, h))
    }

    /// Fond wallpaper image, cover-fit sur le ratio de SORTIE (mode 6).
    ///
    /// Le crop de recouvrement se calcule contre le vrai ratio de sortie, pas contre celui
    /// de la texture : sinon l'image, déjà cover-fittée, se fait re-déformer.
    unsafe fn draw_image_bg(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        path: &str,
        output_aspect: f32,
    ) -> Result<()> {
        // Emprunt isolé dans un `let` pour qu'il soit relâché AVANT le `borrow_mut` —
        // même piège que côté Windows (double emprunt RefCell à la première frame image).
        let cached = self.img_cache.borrow().get(path).cloned();
        let (tex, iw, ih) = match cached {
            Some(v) => v,
            None => {
                let loaded = self.load_image_texture(path)?;
                self.img_cache.borrow_mut().insert(path.to_string(), loaded.clone());
                loaded
            }
        };
        let ai = iw as f32 / ih.max(1) as f32;
        let ao = output_aspect;
        let (u0, v0, u1, v1) = if ai > ao {
            let vis = ao / ai; // rogne horizontalement
            ((1.0 - vis) * 0.5, 0.0, 1.0 - (1.0 - vis) * 0.5, 1.0)
        } else {
            let vis = ai / ao; // rogne verticalement
            (0.0, (1.0 - vis) * 0.5, 1.0, 1.0 - (1.0 - vis) * 0.5)
        };
        enc.set_fragment_texture(2, Some(&tex));
        self.draw_solid(
            enc,
            &LayerCB {
                dst: [0.0, 0.0, 1.0, 1.0],
                src: [u0, v0, u1, v1],
                mode: 6.0,
                ..Default::default()
            },
        );
        Ok(())
    }



    /// Une passe plein écran : `source` -> `target` avec `pipeline`, `fx` dans le LayerCB.
    /// Le viewport découle de la taille de l'attachement, donc pas de `RSSetViewports`.
    unsafe fn fs_pass(
        &self,
        cmd: &metal::CommandBufferRef,
        target: &metal::Texture,
        source: &metal::Texture,
        pipeline: &metal::RenderPipelineState,
        fx: [f32; 4],
    ) -> Result<()> {
        let e = self.begin_pass(
            cmd,
            target,
            Some(metal::MTLClearColor::new(0.0, 0.0, 0.0, 0.0)),
            pipeline,
        )?;
        let cb = LayerCB { fx, ..Default::default() };
        e.set_fragment_bytes(
            0,
            std::mem::size_of::<LayerCB>() as u64,
            &cb as *const LayerCB as *const std::ffi::c_void,
        );
        e.set_fragment_texture(0, Some(source));
        e.draw_primitives(metal::MTLPrimitiveType::Triangle, 0, 3);
        e.end_encoding();
        Ok(())
    }

    /// Dual-Kawase sur le contenu courant du RT : trois passes DOWN puis trois UP, la
    /// dernière réécrivant le RT. Port des six `fs_pass` de `compositor_windows::blur_bg`,
    /// mêmes tailles et mêmes texels.
    unsafe fn blur_bg(&self, cmd: &metal::CommandBufferRef) -> Result<()> {
        let off = 2.2; // spread par passe
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let (hw, hh) = (rw * 0.5, rh * 0.5);
        // DOWN : texel = 1/(dims de la SOURCE échantillonnée)
        self.fs_pass(cmd, &self.blur_half, &self.rt, &self.pipeline_kdown, [1.0 / rw, 1.0 / rh, off, 0.0])?;
        self.fs_pass(cmd, &self.blur_quarter, &self.blur_half, &self.pipeline_kdown, [1.0 / hw, 1.0 / hh, off, 0.0])?;
        self.fs_pass(cmd, &self.blur_eighth, &self.blur_quarter, &self.pipeline_kdown, [2.0 / hw, 2.0 / hh, off, 0.0])?;
        // UP
        self.fs_pass(cmd, &self.blur_quarter, &self.blur_eighth, &self.pipeline_kup, [4.0 / hw, 4.0 / hh, off, 0.0])?;
        self.fs_pass(cmd, &self.blur_half, &self.blur_quarter, &self.pipeline_kup, [2.0 / hw, 2.0 / hh, off, 0.0])?;
        self.fs_pass(cmd, &self.rt, &self.blur_half, &self.pipeline_kup, [1.0 / hw, 1.0 / hh, off, 0.0])?;
        Ok(())
    }

    /// Ouvre un encodeur sur `target`. `clear` = `None` conserve ce qui s'y trouve.
    ///
    /// Metal n'a pas d'`OMSetRenderTargets` : changer de cible veut dire terminer
    /// l'encodeur et en ouvrir un autre. C'est ce qui remplace la choréographie
    /// `OMSetRenderTargets` / `OMSetBlendState` du chemin D3D11.
    fn begin_pass<'a>(
        &self,
        cmd: &'a metal::CommandBufferRef,
        target: &metal::Texture,
        clear: Option<metal::MTLClearColor>,
        pipeline: &metal::RenderPipelineState,
    ) -> Result<&'a metal::RenderCommandEncoderRef> {
        let desc = metal::RenderPassDescriptor::new();
        let ca = desc
            .color_attachments()
            .object_at(0)
            .ok_or_else(|| anyhow!("RenderPassDescriptor::color_attachments(0) est nul"))?;
        ca.set_texture(Some(target));
        match clear {
            Some(c) => {
                ca.set_load_action(metal::MTLLoadAction::Clear);
                ca.set_clear_color(c);
            }
            None => ca.set_load_action(metal::MTLLoadAction::Load),
        }
        ca.set_store_action(metal::MTLStoreAction::Store);
        let enc = cmd.new_render_command_encoder(&desc);
        enc.set_render_pipeline_state(pipeline);
        Ok(enc)
    }

    /// Sprite de curseur (mode 7). Rend `Err` quand l'art n'est pas chargeable, pour que
    /// l'appelant retombe sur le curseur dessiné.
    unsafe fn draw_cursor_sprite(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        placement: crate::frame_geometry::CursorPlacement,
        size_px: f32,
        a: f32,
        sprite: &crate::scene::SceneCursorSprite,
        clip: [f32; 4],
    ) -> Result<()> {
        let cached = self.img_cache.borrow().get(sprite.path.as_str()).cloned();
        let (tex, iw, ih) = match cached {
            Some(v) => v,
            None => {
                let loaded = self.load_image_texture(&sprite.path)?;
                self.img_cache.borrow_mut().insert(sprite.path.clone(), loaded.clone());
                loaded
            }
        };
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let ar = iw as f32 / ih.max(1) as f32;
        let (pw, ph) = if ar >= 1.0 { (size_px, size_px / ar) } else { (size_px * ar, size_px) };
        // Le plan incliné (mode 13) arrive avec le tilt ; en attendant, un curseur posé sur
        // le centre droit du plan vaut mieux qu'aucun curseur.
        let center = placement.upright_center();
        let cb = LayerCB {
            dst: crate::frame_geometry::cursor_sprite_dst(
                center,
                pw / rw,
                ph / rh,
                [sprite.hotspot_x, sprite.hotspot_y],
            ),
            src: [0.0, 0.0, 1.0, 1.0],
            mode: 7.0,
            color: [1.0, 1.0, 1.0, a],
            fx: clip,
            ..Default::default()
        };
        enc.set_fragment_texture(2, Some(&tex));
        self.draw_solid(enc, &cb);
        Ok(())
    }

    /// Curseur thématisé : le sprite de l'état courant, sinon la flèche, sinon rien.
    ///
    /// Le repli « dot + ring » mathématique (mode 4) du chemin Windows n'est pas porté :
    /// l'app résout toujours un jeu de sprites, et l'art intégré couvre les états qu'un
    /// thème ne fournit pas. S'il n'y a vraiment aucun sprite, ne rien dessiner est plus
    /// honnête qu'un curseur qui ne ressemble à aucun réglage.
    unsafe fn draw_cur_themed(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        sprites: &std::collections::HashMap<String, crate::scene::SceneCursorSprite>,
        cursor_type: Option<&str>,
        placement: crate::frame_geometry::CursorPlacement,
        size_px: f32,
        a: f32,
        clip: [f32; 4],
    ) {
        let sprite = cursor_type.and_then(|t| sprites.get(t)).or_else(|| sprites.get("arrow"));
        if let Some(sprite) = sprite {
            if let Err(e) = self.draw_cursor_sprite(enc, placement, size_px, a, sprite, clip) {
                eprintln!("[compositor] sprite curseur \"{}\" : {e:#}", sprite.path);
            }
        }
    }

    /// Compose la frame : fond, ombre écran, écran, ombre caméra, caméra — puis miroir
    /// `Shared` pour la lecture CPU.
    ///
    /// La géométrie vient de `frame_geometry::plan_frame`, la MÊME fonction que le moteur
    /// D3D11 appelle. Ce qui reste ici n'est donc que l'émission des draws ; c'est aussi
    /// pourquoi cette moitié se relit en regard de `compositor_windows.rs`, section par
    /// section.
    ///
    /// Pas encore rendu : le tilt 3D (mode 8), les annotations, le curseur, le flou de
    /// fond, et le wallpaper image — ce dernier faute de chemin de décodage/upload d'image
    /// côté Metal, et il retombe sur la couleur de fond en le disant.
    pub unsafe fn compose_frame(
        &self,
        screen: *const AVFrame,
        webcam: *const AVFrame,
        frame: f32,
        cfg: &Cfg,
    ) -> Result<()> {
        if Self::pixel_buffer_of(screen).is_none() {
            return self.clear_rt();
        }
        let (sy, suv) = self.nv12_srvs(screen)?;
        // La caméra peut manquer (clip sans webcam) : son absence ne doit pas emporter
        // l'écran avec elle.
        let webcam_tex = self.nv12_srvs(webcam).ok();
        let (stw, sth) = self.tex_dims(screen);
        let (wtw, wth) = self.tex_dims(webcam);
        let (scw, sch) = ((*screen).width as f32, (*screen).height as f32);
        let (wcw, wch) = if webcam.is_null() {
            (1.0, 1.0)
        } else {
            ((*webcam).width as f32, (*webcam).height as f32)
        };
        let u_max = scw / (stw.max(1)) as f32;
        let v_max = sch / (sth.max(1)) as f32;
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);

        let scene_ref = self.scene.borrow();
        let cursor_ref = self.cursor.borrow();
        let lp = *self.live_params.borrow();
        let g = crate::frame_geometry::plan_frame(&FrameGeometryInput {
            render_px: [rw, rh],
            screen_tex_px: [stw as f32, sth as f32],
            screen_visible_px: [scw, sch],
            webcam_visible_px: [wcw, wch],
            u_max,
            v_max,
            frame,
            cfg,
            live: lp,
            scene: scene_ref.as_ref(),
            cursor: cursor_ref.as_ref(),
            timeline_t_override: *self.timeline_time.borrow(),
        });

        let cmd_buf = self.gpu.context.new_command_buffer();
        let enc = self.begin_pass(
            cmd_buf,
            &self.rt,
            Some(metal::MTLClearColor::new(0.0, 0.0, 0.0, 1.0)),
            &self.pipeline_main,
        )?;
        // Les deux plans écran restent liés par défaut : les quads de couleur ne les
        // échantillonnent pas, mais Metal veut des slots renseignés pour les draws qui, eux,
        // le font.
        enc.set_fragment_texture(0, Some(&sy));
        enc.set_fragment_texture(1, Some(&suv));

        // --- fond --- (parité `compositor_windows.rs`, section « fond »)
        match scene_ref.as_ref().map(|s| s.background.clone()) {
            Some(SceneBackground::Color { color }) => {
                let c = parse_hex(&color).unwrap_or(lp.bg_color);
                self.draw_solid(
                    enc,
                    &LayerCB { dst: [0.0, 0.0, 1.0, 1.0], mode: 1.0, color: c, ..Default::default() },
                );
            }
            Some(SceneBackground::Gradient { angle_deg, stops }) => {
                let c0 = stops.first().and_then(|s| parse_hex(s)).unwrap_or(lp.bg_color);
                let c1 = stops.last().and_then(|s| parse_hex(s)).unwrap_or(c0);
                let a = angle_deg.to_radians();
                self.draw_solid(
                    enc,
                    &LayerCB {
                        dst: [0.0, 0.0, 1.0, 1.0],
                        src: [c1[0], c1[1], c1[2], c1[3]],
                        mode: 5.0,
                        color: c0,
                        fx: [a.sin(), -a.cos(), 0.0, 0.0],
                        ..Default::default()
                    },
                );
            }
            Some(SceneBackground::Image { path }) => {
                // Repli couleur en cas d'échec, mais LOGGÉ : un fallback silencieux masquerait
                // un chemin cassé.
                if let Err(e) = self.draw_image_bg(enc, &path, rw / rh) {
                    eprintln!("[compositor] wallpaper image \"{path}\" : {e:#}");
                    self.draw_solid(
                        enc,
                        &LayerCB {
                            dst: [0.0, 0.0, 1.0, 1.0],
                            mode: 1.0,
                            color: lp.bg_color,
                            ..Default::default()
                        },
                    );
                }
            }
            None => {
                self.draw_solid(
                    enc,
                    &LayerCB {
                        dst: [0.0, 0.0, 1.0, 1.0],
                        mode: 1.0,
                        color: lp.bg_color,
                        ..Default::default()
                    },
                );
            }
        }

        // « Blur BG » (parité web `blurredBackgroundLayer`) : floute CE wallpaper qu'on vient
        // de dessiner, pas la vidéo. No-op visuel sur une couleur plate, effet réel sur un
        // gradient ou une image. Il lui faut ses propres passes, d'où la coupure ici.
        enc.end_encoding();
        if scene_ref.as_ref().map(|s| s.effects.blur).unwrap_or(false) {
            self.blur_bg(cmd_buf)?;
        }
        let enc = self.begin_pass(cmd_buf, &self.rt, None, &self.pipeline_main)?;
        enc.set_fragment_texture(0, Some(&sy));
        enc.set_fragment_texture(1, Some(&suv));

        // --- écran : ombre puis vidéo ---
        let s_px = [g.s_dst[2] * rw, g.s_dst[3] * rh];
        if cfg.shadow {
            self.draw_shadow(
                enc,
                g.s_dst,
                s_px,
                g.s_radius,
                SCREEN_SHADOW_SPREAD_FRAC * g.frame_min_px,
                [0.0, SCREEN_SHADOW_OFFSET_FRAC * g.frame_min_px],
                0.45 * lp.shadow_scale,
            );
        }
        let [su0, sv0, su1, sv1] = g.cut;
        self.draw_video(
            enc,
            &LayerCB {
                dst: g.s_dst,
                src: [su0, sv0, su1, sv1],
                quad_px: s_px,
                radius_px: g.s_radius,
                mode: 0.0,
                color: [0.0, 0.0, 0.0, 1.0],
                src_prev: [su0, sv0, su1, sv1],
                dst_prev: g.s_dst_prev,
                mb: [g.mb_taps, 1.0, 1.0, 0.0],
                ..Default::default()
            },
            &sy,
            &suv,
        );

        enc.end_encoding();

        // --- curseur --- (parité `compositor_windows.rs`, section « curseur custom »)
        if let Some(track) = cursor_ref.as_ref() {
            let plan = crate::frame_geometry::plan_cursor(
                &g,
                &crate::frame_geometry::CursorPlanInput {
                    render_px: [rw, rh],
                    u_max,
                    v_max,
                    cfg,
                    live: lp,
                    scene: scene_ref.as_ref(),
                    track,
                    t: self.cursor_time.borrow().unwrap_or(frame / crate::frame_geometry::FPS),
                },
            );
            if let Some(plan) = plan {
                let sprites = scene_ref
                    .as_ref()
                    .map(|s| s.cursor.cursor_sprites.clone())
                    .unwrap_or_default();
                let kind = plan.cursor_type.as_deref();
                if plan.taps <= 1 {
                    let e = self.begin_pass(cmd_buf, &self.rt, None, &self.pipeline_main)?;
                    self.draw_cur_themed(e, &sprites, kind, plan.placement, plan.size_px, 1.0, plan.clip);
                    e.end_encoding();
                } else {
                    // Flou RÉEL, pas des copies discrètes : les N échantillons s'accumulent dans
                    // un buffer ISOLÉ parti de zéro, puis sont composités « over » sur la scène.
                    // Les additionner directement sur le RT ajouterait du blanc à ce qui est
                    // dessous — sur un fond clair, curseur quasi invisible.
                    let e = self.begin_pass(
                        cmd_buf,
                        &self.accum,
                        Some(metal::MTLClearColor::new(0.0, 0.0, 0.0, 0.0)),
                        &self.pipeline_add,
                    )?;
                    let w = 1.0 / plan.taps as f32;
                    e.set_blend_color(w, w, w, w);
                    for k in 0..plan.taps {
                        let f = k as f32 / (plan.taps - 1) as f32;
                        self.draw_cur_themed(
                            e,
                            &sprites,
                            kind,
                            plan.prev_placement.lerp(plan.placement, f),
                            plan.size_px,
                            1.0,
                            plan.clip,
                        );
                    }
                    e.end_encoding();

                    let c = self.begin_pass(cmd_buf, &self.rt, None, &self.pipeline_fs_tex)?;
                    c.set_fragment_texture(0, Some(&self.accum));
                    c.draw_primitives(metal::MTLPrimitiveType::Triangle, 0, 3);
                    c.end_encoding();
                }
            }
        }

        // --- caméra : ombre PiP puis vidéo ---
        let enc = self.begin_pass(cmd_buf, &self.rt, None, &self.pipeline_main)?;
        if let (true, Some((wy, wuv))) = (lp.has_webcam, webcam_tex.as_ref()) {
            let (cu0, cv0, cu1, cv1) = crate::frame_geometry::cover_crop_uv(
                [wcw, wch],
                [wtw as f32, wth as f32],
                g.w_px[0] / g.w_px[1].max(0.0001),
            );
            let (u0, u1) = if lp.webcam_mirror { (cu1, cu0) } else { (cu0, cu1) };
            let webcam_is_block = matches!(
                g.scene_preset.as_deref(),
                Some("dual-frame") | Some("vertical-stack")
            );
            if cfg.shadow && !webcam_is_block && g.shape_fade > 0.0 {
                self.draw_shadow(
                    enc,
                    g.w_dst,
                    g.w_px,
                    g.w_radius,
                    WEBCAM_SHADOW_SPREAD_FRAC * g.frame_min_px,
                    [0.0, WEBCAM_SHADOW_OFFSET_FRAC * g.frame_min_px],
                    WEBCAM_SHADOW_OPACITY * g.shape_fade,
                );
            }
            self.draw_video(
                enc,
                &LayerCB {
                    dst: g.w_dst,
                    src: [u0, cv0, u1, cv1],
                    quad_px: g.w_px,
                    radius_px: g.w_radius,
                    mode: 0.0,
                    color: [0.0, 0.0, 0.0, 1.0],
                    src_prev: [u0, cv0, u1, cv1],
                    dst_prev: g.w_dst_prev,
                    mb: [g.mb_taps, 1.0, 1.0, 0.0],
                    ..Default::default()
                },
                wy,
                wuv,
            );
        }

        enc.end_encoding();
        self.mirror_rt(cmd_buf);
        cmd_buf.commit();
        cmd_buf.wait_until_completed();
        Ok(())
    }

    /// Efface le RT au noir (utilisé quand `screen` est null ou sans buffer).
    unsafe fn clear_rt(&self) -> Result<()> {
        let cmd_buf = self.gpu.context.new_command_buffer();
        let pass_desc = metal::RenderPassDescriptor::new();
        let ca = pass_desc
            .color_attachments()
            .object_at(0)
            .ok_or_else(|| anyhow!("RenderPassDescriptor::color_attachments(0) est nul"))?;
        ca.set_texture(Some(&self.rt));
        ca.set_load_action(metal::MTLLoadAction::Clear);
        ca.set_clear_color(metal::MTLClearColor::new(0.0, 0.0, 0.0, 1.0));
        ca.set_store_action(metal::MTLStoreAction::Store);
        cmd_buf.new_render_command_encoder(&pass_desc).end_encoding();

        self.mirror_rt(cmd_buf);
        cmd_buf.commit();
        cmd_buf.wait_until_completed();
        Ok(())
    }

    /// Copie `rt` (`Private`) vers `rt_read` (`Shared`) dans le command buffer donné.
    fn mirror_rt(&self, cmd_buf: &metal::CommandBufferRef) {
        let blit = cmd_buf.new_blit_command_encoder();
        blit.copy_from_texture(
            &self.rt,
            0,
            0,
            metal::MTLOrigin { x: 0, y: 0, z: 0 },
            metal::MTLSize {
                width: self.render_w as u64,
                height: self.render_h as u64,
                depth: 1,
            },
            &self.rt_read,
            0,
            0,
            metal::MTLOrigin { x: 0, y: 0, z: 0 },
        );
        blit.end_encoding();
    }

    /// Variante motion-blur de `compose_frame` — symétrique de
    /// `compositor_windows::compose_frame_mb`. Renvoie `Err` tant que le moteur
    /// avancé (couches multiples avec vélocité par quad) n'est pas câblé.
    pub unsafe fn compose_frame_mb(
        &self,
        _screen: *const AVFrame,
        _webcam: *const AVFrame,
        _frame: u32,
        _cfg: &Cfg,
    ) -> Result<()> {
        Err(anyhow!("compositor_macos::compose_frame_mb: non implémenté"))
    }

    /// First-pass engine : la cible est toujours le NV12 interne. L'argument `out_tex`
    /// est conservé pour l'API symétrique avec Windows ; le câblage zero-copy vers un
    /// `CVPixelBuffer` appartenant à l'encodeur viendra avec le commit « encodeur VT ».
    pub unsafe fn rgb_to_nv12(&self, _out_tex: *mut std::ffi::c_void, _slice: u32) -> Result<()> {
        self.render_nv12()
    }

    pub unsafe fn rgb_to_nv12_scaled(
        &self,
        _target_w: u32,
        _target_h: u32,
        _out_tex: *mut std::ffi::c_void,
        _slice: u32,
    ) -> Result<()> {
        self.render_nv12()
    }

    /// Convertit le RT RGBA → `nv12_y` (R8) et `nv12_uv` (RG8) via deux passes
    /// fullscreen (`ps_y` puis `ps_uv` sur `vs_fs`), puis recopie vers les miroirs
    /// `Shared` que `read_nv12_scaled` lit. Miroir Metal de
    /// `compositor_windows::render_nv12` — même conversion BT.709 limited.
    pub unsafe fn render_nv12(&self) -> Result<()> {
        let cmd_buf = self.gpu.context.new_command_buffer();

        for (target, pipeline) in [
            (&self.nv12_y, &self.pipeline_fs_y),
            (&self.nv12_uv, &self.pipeline_fs_uv),
        ] {
            let pass = metal::RenderPassDescriptor::new();
            let ca = pass
                .color_attachments()
                .object_at(0)
                .ok_or_else(|| anyhow!("RenderPassDescriptor::color_attachments(0) est nul"))?;
            ca.set_texture(Some(target));
            ca.set_load_action(metal::MTLLoadAction::Clear);
            ca.set_clear_color(metal::MTLClearColor::new(0.0, 0.0, 0.0, 1.0));
            ca.set_store_action(metal::MTLStoreAction::Store);
            let enc = cmd_buf.new_render_command_encoder(&pass);
            enc.set_render_pipeline_state(pipeline);
            enc.set_fragment_texture(0, Some(&self.rt));
            // `vs_fs` est un triangle plein écran généré depuis `[[vertex_id]]`.
            enc.draw_primitives(metal::MTLPrimitiveType::Triangle, 0, 3);
            enc.end_encoding();
        }

        let blit = cmd_buf.new_blit_command_encoder();
        for (src, dst, w, h) in [
            (&self.nv12_y, &self.nv12_read_y, self.render_w, self.render_h),
            (
                &self.nv12_uv,
                &self.nv12_read_uv,
                self.render_w / 2,
                self.render_h / 2,
            ),
        ] {
            blit.copy_from_texture(
                src,
                0,
                0,
                metal::MTLOrigin { x: 0, y: 0, z: 0 },
                metal::MTLSize {
                    width: w as u64,
                    height: h as u64,
                    depth: 1,
                },
                dst,
                0,
                0,
                metal::MTLOrigin { x: 0, y: 0, z: 0 },
            );
        }
        blit.end_encoding();

        cmd_buf.commit();
        cmd_buf.wait_until_completed();
        Ok(())
    }

    /// Lit le RT RGBA vers un `Vec<u8>` CPU (preview live). Renvoie `(w, h, RGBA8)`.
    pub unsafe fn readback_direct(&self) -> Result<(u32, u32, Vec<u8>)> {
        let (w, h) = (self.render_w, self.render_h);
        let bytes_per_row = (w as usize) * 4;
        let mut data = vec![0u8; bytes_per_row * h as usize];
        self.rt_read.get_bytes(
            data.as_mut_ptr() as *mut std::ffi::c_void,
            bytes_per_row as u64,
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize {
                    width: w as u64,
                    height: h as u64,
                    depth: 1,
                },
            },
            0,
        );
        Ok((w, h, data))
    }

    /// Variante resize de `readback_direct` — first-pass engine : rend à la taille de
    /// rendu puis lit ; le resize GPU viendra avec le commit « pipeline resize ».
    pub unsafe fn readback_resized(&self, _target_w: u32, _target_h: u32) -> Result<Vec<u8>> {
        let (_, _, data) = self.readback_direct()?;
        Ok(data)
    }

    /// Lit le NV12 (Y+UV) vers la mémoire système, dans les plans d'une AVFrame.
    /// `pitch_y` / `pitch_uv` sont les strides de destination (`AVFrame::linesize`),
    /// que `getBytes` respecte via `bytesPerRow`.
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn read_nv12_scaled(
        &self,
        target_w: u32,
        target_h: u32,
        dst_y: *mut u8,
        pitch_y: usize,
        dst_uv: *mut u8,
        pitch_uv: usize,
    ) -> Result<()> {
        // Le moteur rend à `render_w`x`render_h` ; lire au-delà serait hors-texture.
        let w = target_w.min(self.render_w);
        let h = target_h.min(self.render_h);
        if w == 0 || h == 0 {
            return Err(anyhow!(
                "read_nv12_scaled: cible vide ({target_w}x{target_h})"
            ));
        }
        self.nv12_read_y.get_bytes(
            dst_y as *mut std::ffi::c_void,
            pitch_y as u64,
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize {
                    width: w as u64,
                    height: h as u64,
                    depth: 1,
                },
            },
            0,
        );
        self.nv12_read_uv.get_bytes(
            dst_uv as *mut std::ffi::c_void,
            pitch_uv as u64,
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize {
                    width: (w / 2) as u64,
                    height: (h / 2) as u64,
                    depth: 1,
                },
            },
            0,
        );
        Ok(())
    }

    /// Vide le cache CoreVideo. À appeler quand la source change de dimensions.
    pub fn flush_texture_cache(&self) {
        self.metal_texture_cache.flush();
    }

    pub unsafe fn dump_nv12(&self, _path: &str) -> Result<()> {
        Err(anyhow!("compositor_macos::dump_nv12: non implémenté"))
    }

    pub unsafe fn dump_raw(&self, _path: &str) -> Result<()> {
        Err(anyhow!("compositor_macos::dump_raw: non implémenté"))
    }

    pub unsafe fn blit_to(&self, _rtv: *mut std::ffi::c_void, _x: f32, _y: f32, _w: f32, _h: f32) {
        // No-op : il n'y a pas de swapchain côté macOS (la preview passe par
        // `readback_direct`, l'export par `render_nv12`).
    }
}


#[cfg(test)]
mod tests {
    

    /// Le pendant macOS de `compositor_windows`'s `every_shader_entry_point_compiles`.
    ///
    /// `shaders.metal` est compilé À L'EXÉCUTION par `new_library_with_source` : une
    /// erreur de syntaxe MSL ne se voit donc jamais au `cargo build`, seulement au
    /// premier `Compositor::new` — c'est-à-dire quand un utilisateur ouvre l'éditeur.
    /// Ce test la fait remonter au `cargo test`.
    #[test]
    fn every_shader_entry_point_compiles() {
        let Some(device) = metal::Device::system_default() else {
            eprintln!("pas de MTLDevice (CI sans GPU) — test sauté");
            return;
        };
        let library = device
            .new_library_with_source(
                include_str!("shaders.metal"),
                &metal::CompileOptions::new(),
            )
            .expect("shaders.metal doit compiler");
        for name in [
            "vs_main",
            "vs_fs",
            "ps_main",
            "ps_y",
            "ps_uv",
            "ps_blur",
            "ps_tex",
            "ps_kawase_down",
            "ps_kawase_up",
        ] {
            library
                .get_function(name, None)
                .unwrap_or_else(|e| panic!("entry point {name} absent de la library : {e}"));
        }
    }

    /// Les quatre pipeline states que `new_sized` construit doivent être acceptés par
    /// Metal : c'est là que se voient les désaccords entre la signature d'un shader et
    /// la pièce jointe couleur qu'on lui donne (format, blend), qui ne sont PAS des
    /// erreurs de compilation MSL.
    #[test]
    fn the_compositor_builds_on_the_system_device() {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return;
        };
        let comp = super::Compositor::new_sized(&gpu, 640, 360).expect("Compositor::new_sized");
        assert_eq!(comp.render_size(), (640, 360));
    }
}
