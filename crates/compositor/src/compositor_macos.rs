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
use crate::scene::Scene;
use anyhow::{anyhow, Result};
use metal::foreign_types::ForeignType;
use std::cell::RefCell;

/// Largeur de référence pour l'export (conservée pour l'API symétrique ; la valeur
/// effective d'export est négociée par `LiveView` / `Compositor::render_size`).
pub const OUT_W: u32 = 1920;
/// Hauteur de référence pour l'export. Voir `OUT_W`.
pub const OUT_H: u32 = 1080;
/// Nombre de frames dans la fixture POC (pour le bench — le test C0 l'utilise).
pub const FIXTURE_FRAMES: u32 = 360;

/// Paramètres runtime de la preview (shadow_scale, radius_scale, …). **Mêmes champs
/// et même layout que `compositor_windows::LiveParams`** — le moteur Metal lit ces
/// champs au début de `compose_frame` via le constant buffer `LayerCB`, et toute
/// divergence casserait l'iso-render cross-backend (cf. PR #162 §3).
#[derive(Clone, Copy)]
pub struct LiveParams {
    pub bg_color: [f32; 4],
    pub shadow_scale: f32,
    pub radius_scale: f32,
    pub padding: f32,
    pub webcam_size_scale: f32,
    pub webcam_mirror: bool,
    pub webcam_shape: u32,
    pub cursor_size_scale: f32,
    pub cursor_bounce_scale: f32,
    pub cursor_motion_blur: f32,
    pub has_webcam: bool,
}

impl Default for LiveParams {
    fn default() -> Self {
        Self {
            bg_color: [0.0, 0.0, 0.0, 0.0],
            shadow_scale: 1.0,
            radius_scale: 1.0,
            padding: 0.0,
            webcam_size_scale: 1.0,
            webcam_mirror: false,
            webcam_shape: 3,
            cursor_size_scale: 1.0,
            cursor_bounce_scale: 1.0,
            cursor_motion_blur: 0.0,
            has_webcam: false,
        }
    }
}

/// Convertit une chaîne UI (« rectangle », « circle », « square ») en code de mode
/// shader (ps_main mode 4 / 9). Conservé ici pour la symétrie d'API : c'est un mapping
/// pur, identique sur les deux plateformes.
pub fn webcam_shape_code(shape: &str) -> u32 {
    match shape {
        "rectangle" => 0,
        "circle" => 1,
        "square" => 2,
        _ => 0,
    }
}

/// Construit un `LiveParams` à partir d'une scène. Le moteur Metal applique ces
/// params dans le constant buffer `LayerCB` avant `compose_frame`. **Mêmes formules
/// que `compositor_windows::live_params_from_scene`** — un changement doit être
/// reporté des deux côtés pour préserver l'iso-render cross-backend (cf. PR #162 §3).
pub fn live_params_from_scene(s: &Scene) -> LiveParams {
    LiveParams {
        shadow_scale: s.effects.shadow,
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
    _pipeline_fs_tex: metal::RenderPipelineState,
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

/// Un pipeline state à une seule pièce jointe couleur. `blend` n'est activé que pour
/// la passe principale (alpha prémultiplié), pas pour les conversions fullscreen.
fn make_pipeline(
    device: &metal::Device,
    library: &metal::Library,
    vs: &str,
    fs: &str,
    format: metal::MTLPixelFormat,
    blend: bool,
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
    if blend {
        ca.set_blending_enabled(true);
        ca.set_rgb_blend_operation(metal::MTLBlendOperation::Add);
        ca.set_alpha_blend_operation(metal::MTLBlendOperation::Add);
        ca.set_source_rgb_blend_factor(metal::MTLBlendFactor::One);
        ca.set_destination_rgb_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);
        ca.set_source_alpha_blend_factor(metal::MTLBlendFactor::One);
        ca.set_destination_alpha_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);
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
            true,
        )?;
        let pipeline_fs_y = make_pipeline(
            device,
            &library,
            "vs_fs",
            "ps_y",
            metal::MTLPixelFormat::R8Unorm,
            false,
        )?;
        let pipeline_fs_uv = make_pipeline(
            device,
            &library,
            "vs_fs",
            "ps_uv",
            metal::MTLPixelFormat::RG8Unorm,
            false,
        )?;
        let pipeline_fs_tex = make_pipeline(
            device,
            &library,
            "vs_fs",
            "ps_tex",
            metal::MTLPixelFormat::RGBA8Unorm,
            false,
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
            _pipeline_fs_tex: pipeline_fs_tex,
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

    /// Compose la frame suivante → render target RGBA, puis miroir `Shared` pour la
    /// lecture CPU. **First-pass engine** : la vidéo `screen` est rendue plein cadre
    /// (mode 0 de `ps_main`), sans webcam / coins arrondis / ombres / blur.
    pub unsafe fn compose_frame(
        &self,
        screen: *const AVFrame,
        _webcam: *const AVFrame,
        _frame: f32,
        _cfg: &Cfg,
    ) -> Result<()> {
        if Self::pixel_buffer_of(screen).is_none() {
            // Pas de frame source : on efface le RT au noir.
            return self.clear_rt();
        }

        let (sy, suv) = self.nv12_srvs(screen)?;

        // LayerCB : full-canvas (dst = [0,0,1,1], src = [0,0,1,1], mode = 0 = NV12).
        let layer = Layer {
            dst: [0.0, 0.0, 1.0, 1.0],
            src: [0.0, 0.0, 1.0, 1.0],
            quad_px: [self.render_w as f32, self.render_h as f32],
            radius_px: 0.0,
            mode: 0.0,
            color: [1.0, 1.0, 1.0, 1.0],
            fx: [0.0; 4],
            src_prev: [0.0, 0.0, 1.0, 1.0],
            dst_prev: [0.0, 0.0, 1.0, 1.0],
            mb: [1.0, 0.0, 0.0, 0.0],
        };

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

        let encoder = cmd_buf.new_render_command_encoder(&pass_desc);
        encoder.set_render_pipeline_state(&self.pipeline_main);
        encoder.set_fragment_texture(0, Some(&sy));
        encoder.set_fragment_texture(1, Some(&suv));
        // `vs_main` lit `layer.dst`/`layer.src`/`layer.quad_px` : le constant buffer doit
        // être lié aux DEUX étages. La première version ne le liait qu'au fragment, donc
        // le vertex shader lisait un buffer non lié et le quad sortait indéfini.
        let layer_bytes = std::mem::size_of::<Layer>() as u64;
        let layer_ptr = &layer as *const Layer as *const std::ffi::c_void;
        encoder.set_vertex_bytes(0, layer_bytes, layer_ptr);
        encoder.set_fragment_bytes(0, layer_bytes, layer_ptr);
        encoder.draw_primitives(metal::MTLPrimitiveType::TriangleStrip, 0, 4);
        encoder.end_encoding();

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

/// Constant buffer Layer — symétrique du cbuffer HLSL dans `shaders.hlsl` et de la
/// struct `Layer` de `shaders.metal`. 128 octets.
///
/// HLSL aligne chaque `float4` sur 16 octets ; MSL fait de même, et `repr(C, align(16))`
/// reproduit ce layout champ pour champ : `quad_px` (float2) à 32, `radius_px` à 40,
/// `mode` à 44, puis `color` (float4) à 48 des deux côtés.
#[repr(C, align(16))]
#[derive(Clone, Copy)]
struct Layer {
    dst: [f32; 4],
    src: [f32; 4],
    quad_px: [f32; 2],
    radius_px: f32,
    mode: f32,
    color: [f32; 4],
    fx: [f32; 4],
    src_prev: [f32; 4],
    dst_prev: [f32; 4],
    mb: [f32; 4],
}

#[cfg(test)]
mod tests {
    use super::Layer;

    /// Le contrat cross-backend : `Layer` doit occuper exactement les 128 octets que
    /// `shaders.metal` (et `shaders.hlsl`) décrivent, sinon le shader lit des champs
    /// décalés et le rendu part en vrille sans erreur.
    #[test]
    fn layer_matches_the_shader_constant_buffer() {
        assert_eq!(std::mem::size_of::<Layer>(), 128);
        assert_eq!(std::mem::align_of::<Layer>(), 16);
    }

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
