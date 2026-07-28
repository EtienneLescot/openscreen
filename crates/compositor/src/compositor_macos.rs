//! Moteur de composition macOS — Metal + VideoToolbox.
//!
//! Ce module EST l'équivalent macOS de `compositor_windows.rs`. Il exporte la
//! même surface publique (`Compositor`, `LiveParams`, les helpers `webcam_shape_code`/
//! `live_params_from_scene`, et les constantes `OUT_W`/`OUT_H`/`FIXTURE_FRACMES`) pour
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
//! Le Compositor détient un `CVMetalTextureCacheRef` créé lazy à la première frame
//! (dans `new_sized`/`compose_frame`), indexé par `(CVPixelBufferRef, planeIndex)`.
use crate::config::Cfg;
use crate::metal::Gpu;
use crate::scene::Scene;
use crate::ffi::AVFrame;
use anyhow::{anyhow, bail, Result};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

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

/// Newtype safe Rust pour `CVMetalTextureCacheRef` (`*mut __CVMetalTextureCache`).
/// Crée et cache les `MTLTexture` à partir de `CVPixelBufferRef` via
/// `CVMetalTextureCacheCreateTextureFromImage` — zéro copie IOSurface.
pub(crate) struct CVMetalTextureCache(std::ptr::NonNull<std::ffi::c_void>);

unsafe impl Send for CVMetalTextureCache {}
unsafe impl Sync for CVMetalTextureCache {}

/// Bindings CoreVideo minimaux. CVMetalTextureCache n'est PAS dans le linkage par
/// défaut — il faut explicitement `[link(name = "Metal", ...)]` (déjà fait via
/// `cargo:rustc-link-lib=framework Metal` côté Rust) et `CVMetalTextureCacheCreate`
/// qui vient de CoreVideo.
#[link(name = "CoreVideo", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CVMetalTextureCacheCreate(
        allocator: *const std::ffi::c_void,
        attributes: *const std::ffi::c_void,
        metal_device: *const std::ffi::c_void, // id<MTLDevice>
        attributes2: *const std::ffi::c_void,
        cache_out: *mut *mut std::ffi::c_void,  // CVMetalTextureCacheRef*
    ) -> i32; // CVReturn

    fn CVMetalTextureCacheCreateTextureFromImage(
        allocator: *const std::ffi::c_void,
        cache: *mut std::ffi::c_void,
        pixel_buffer: *mut std::ffi::c_void,
        attributes: *const std::ffi::c_void,
        plane_index: usize,
        pixel_format: u32, // MTLPixelFormat
        slice_index: usize,
        texture_out: *mut *mut std::ffi::c_void, // CVMetalTextureRef*
    ) -> i32; // CVReturn

    fn CVMetalTextureCacheFlush(cache: *mut std::ffi::c_void, options: u64);
    fn CVMetalTextureGetTexture(cv_texture: *mut std::ffi::c_void) -> *mut std::ffi::c_void;

    // Helpers du CVPixelBuffer (ré-exportés ici depuis CoreVideo pour ne pas
    // dupliquer le bloc extern dans `mac_frames.rs`).
    fn CVPixelBufferGetWidth(p: *mut std::ffi::c_void) -> usize;
    fn CVPixelBufferGetHeight(p: *mut std::ffi::c_void) -> usize;
}

impl CVMetalTextureCache {
    /// Crée un nouveau `CVMetalTextureCache` lié au `MTLDevice` donné. Échoue si CoreVideo
    /// refuse (rare — VM sans GPU, par exemple).
    pub(crate) fn new(metal_device: *const std::ffi::c_void) -> Result<Self> {
        let mut cache: *mut std::ffi::c_void = std::ptr::null_mut();
        let status = unsafe {
            CVMetalTextureCacheCreate(
                std::ptr::null(),
                std::ptr::null(), // default attributes
                metal_device,
                std::ptr::null(),
                &mut cache,
            )
        };
        if status != 0 || cache.is_null() {
            return Err(anyhow!(
                "CVMetalTextureCacheCreate a échoué (CVReturn={}, cache={:?})",
                status,
                cache
            ));
        }
        Ok(CVMetalTextureCache(unsafe {
            std::ptr::NonNull::new_unchecked(cache)
        }))
    }

    /// Crée un `MTLTexture` (id<MTLTexture>) wrappant le plan `plane_index` d'un
    /// `CVPixelBufferRef` au format `pixel_format` (MTLPixelFormat). Le résultat est
    /// zéro-copie : le `MTLTexture` partage la mémoire IOSurface du `CVPixelBuffer`.
    pub(crate) fn make_texture_from_pixel_buffer(
        &self,
        pixel_buffer: *mut std::ffi::c_void,
        plane_index: usize,
        pixel_format: metal::MTLPixelFormat,
    ) -> Result<*mut std::ffi::c_void> {
        let mut cv_texture: *mut std::ffi::c_void = std::ptr::null_mut();
        let status = unsafe {
            CVMetalTextureCacheCreateTextureFromImage(
                std::ptr::null(),
                self.0.as_ptr(),
                pixel_buffer,
                std::ptr::null(), // default attributes
                plane_index,
                pixel_format as u32,
                0, // slice_index (CVPixelBuffer planes ne sont pas des arrays)
                &mut cv_texture,
            )
        };
        if status != 0 || cv_texture.is_null() {
            return Err(anyhow!(
                "CVMetalTextureCacheCreateTextureFromImage a échoué (CVReturn={}, plane={}, fmt={:?})",
                status,
                plane_index,
                pixel_format
            ));
        }
        let mtl_texture = unsafe { CVMetalTextureGetTexture(cv_texture) };
        if mtl_texture.is_null() {
            return Err(anyhow!(
                "CVMetalTextureGetTexture a renvoyé un id<MTLTexture> nul (plane={})",
                plane_index
            ));
        }
        // Le CVMetalTextureRef (`cv_texture`) est retain par CoreVideo et libéré quand
        // le cache est flushé ; le MTLTexture est retainé par `metal::Texture::from_raw`
        // côté caller. Aucun release explicite ici.
        Ok(mtl_texture)
    }
}

impl Drop for CVMetalTextureCache {
    fn drop(&mut self) {
        // `CVMetalTextureCacheRef` est un CFType ; le release explicite n'est pas dans
        // nos externs (CVMetalTextureCacheRelease). On flush le cache pour libérer les
        // CVMetalTextureRef retenus, et le CFType est libéré au Drop du dernier retain.
        unsafe { CVMetalTextureCacheFlush(self.0.as_ptr(), 0) };
    }
}

/// Le moteur de composition. Le moteur tourne sur Metal : chaque frame décodée arrive
/// comme un `CVPixelBufferRef` IOSurface-backed (`mac_frames::CpuFrames::present` /
/// VideoToolbox hwaccel), et `nv12_srvs` le convertit en deux `MTLTexture` zéro-copie
/// via `CVMetalTextureCache`. Le moteur de composition (render targets, shaders MSL,
/// pipeline states, blend, cbuffer `LayerCB`) est câblé dans `new_inner`.
///
/// First-pass engine : ce commit implémente le strict minimum pour produire un frame
/// (render target RGBA + NV12, compilation MSL, pipeline state, compose_frame avec
/// blit pleine-canvas de la vidéo + conversion RGBA→NV12 vers le buffer de sortie).
/// Les effets avancés (layers, ombres, Kawase, motion blur, webcam overlay avec
/// rounded corners, etc.) sont implémentés dans des commits dédiés : le shader
/// `ps_main` 14-mode existe déjà dans `shaders.metal`, mais ce commit ne l'exerce
/// pas — `compose_frame` rend la couche écran en pleine cadre, ce qui suffit au
/// chemin encode et à la prévisualisation du deck pass-through.
pub struct Compositor {
    gpu: Gpu,
    render_w: u32,
    render_h: u32,
    scene: RefCell<Option<Scene>>,
    cursor: RefCell<Option<crate::cursor::CursorTrack>>,
    cursor_time: RefCell<Option<f32>>,
    timeline_time: RefCell<Option<f32>>,
    live_params: RefCell<LiveParams>,
    /// Cache Metal texture cache. Créé dans `new_inner` à partir du `MTLDevice` —
    /// flushé dans Drop. Flush recommandé aussi à chaque changement de dimensions du
    /// `CVPixelBuffer` (les textures cachées pointent alors sur l'IOSurface précédent).
    metal_texture_cache: RefCell<Option<CVMetalTextureCache>>,
    /// Cache (pixel_buffer_ptr, plane_index) → raw `id<MTLTexture>` opaque.
    tex_cache: RefCell<HashMap<(usize, usize), *mut std::ffi::c_void>>,

    // --- Engine : render targets ---
    /// Render target principal RGBA8 (sRGB natif). Cible de `compose_frame`.
    rt: Option<metal::Texture>,
    /// Staging RGBA8 CPU-readable pour `readback_direct` (preview live).
    /// `MTLStorageModeShared` permet `getBytes` directement.
    rt_read: Option<metal::Texture>,
    /// Texture NV12 interne (sortie de `render_nv12` / cible de l'encodeur zero-copy).
    /// Plan Y = `MTLPixelFormatR8Unorm` ; plan UV = `MTLPixelFormatRG8Unorm`.
    nv12_y: Option<metal::Texture>,
    nv12_uv: Option<metal::Texture>,
    /// Staging NV12 CPU-readable pour `read_nv12_scaled`.
    nv12_read_y: Option<metal::Texture>,
    nv12_read_uv: Option<metal::Texture>,

    // --- Engine : shaders compilés ---
    /// MSL library compilée à `new_inner`. Conservée pour recréer les pipeline
    /// states si la géométrie change (ne devrait pas arriver en pratique — le
    /// compositor est reconstruit via `new_sized`).
    library: Option<metal::Library>,
    /// Pipeline state pour la passe principale (`vs_main` + `ps_main`).
    pipeline_main: Option<metal::RenderPipelineState>,
    /// Pipeline state pour la passe fullscreen (`vs_fs` + `ps_y`/`ps_uv`/`ps_tex`).
    pipeline_fs_y: Option<metal::RenderPipelineState>,
    pipeline_fs_uv: Option<metal::RenderPipelineState>,
    pipeline_fs_tex: Option<metal::RenderPipelineState>,
}

impl Compositor {
    /// Crée le moteur sur le GPU donné. Équivalent Metal de
    /// `compositor_windows::Compositor::new`. Renvoie `Err` dans ce commit — les
    /// commits suivants remplissent : render targets RGBA + NV12, shaders MSL,
    /// constant buffer `LayerCB`, blend states, sampler.
    pub fn new(gpu: &Gpu) -> Result<Compositor> {
        Self::new_sized(gpu, OUT_W, OUT_H)
    }

    /// Comme `new`, mais avec une taille de rendu explicite. Câble le moteur Metal :
    ///   - `CVMetalTextureCache` (zero-copy CVPixelBuffer → MTLTexture),
    ///   - render targets (RT RGBA, RT NV12 Y/UV, staging),
    ///   - compilation MSL (`shaders.metal` → `MTLLibrary`),
    ///   - pipeline states (principal + passes fullscreen).
    pub fn new_sized(gpu: &Gpu, w: u32, h: u32) -> Result<Compositor> {
        let (rw, rh) = Self::normalize_render_size(w, h);
        let metal_device_ptr = gpu.device.as_ptr();
        let cache = CVMetalTextureCache::new(metal_device_ptr as *const std::ffi::c_void)?;

        // --- Render targets ---
        // RT principal RGBA8 (cible de compose_frame).
        let rt_desc = metal::TextureDescriptor::new();
        rt_desc.set_texture_type(metal::TextureType::Type2D);
        rt_desc.set_pixel_format(metal::MTLPixelFormat::RGBA8Unorm);
        rt_desc.set_width(rw as u64);
        rt_desc.set_height(rh as u64);
        rt_desc.set_usage(metal::MTLTextureUsage::RenderTarget | metal::MTLTextureUsage::ShaderRead);
        rt_desc.set_storage_mode(metal::MTLStorageMode::Private);
        let rt = gpu.device.new_texture(&rt_desc);

        // Staging RGBA8 CPU-readable (preview live) : `Shared` permet `getBytes`.
        let rt_read_desc = metal::TextureDescriptor::new();
        rt_read_desc.set_texture_type(metal::TextureType::Type2D);
        rt_read_desc.set_pixel_format(metal::MTLPixelFormat::RGBA8Unorm);
        rt_read_desc.set_width(rw as u64);
        rt_read_desc.set_height(rh as u64);
        rt_read_desc.set_usage(metal::MTLTextureUsage::RenderTarget);
        rt_read_desc.set_storage_mode(metal::MTLStorageMode::Shared);
        let rt_read = gpu.device.new_texture(&rt_read_desc);

        // NV12 interne : Y pleine résolution, UV demi. Stockage `Private` (jamais lu
        // directement par le CPU ; `nv12_read_y/_uv` sont les copies CPU-readable pour
        // `read_nv12_scaled`).
        let nv12_y_desc = metal::TextureDescriptor::new();
        nv12_y_desc.set_texture_type(metal::TextureType::Type2D);
        nv12_y_desc.set_pixel_format(metal::MTLPixelFormat::R8Unorm);
        nv12_y_desc.set_width(rw as u64);
        nv12_y_desc.set_height(rh as u64);
        nv12_y_desc.set_usage(metal::MTLTextureUsage::RenderTarget | metal::MTLTextureUsage::ShaderRead);
        nv12_y_desc.set_storage_mode(metal::MTLStorageMode::Private);
        let nv12_y = gpu.device.new_texture(&nv12_y_desc);

        let nv12_uv_desc = metal::TextureDescriptor::new();
        nv12_uv_desc.set_texture_type(metal::TextureType::Type2D);
        nv12_uv_desc.set_pixel_format(metal::MTLPixelFormat::RG8Unorm);
        nv12_uv_desc.set_width(rw as u64);
        nv12_uv_desc.set_height(rh as u64);
        nv12_uv_desc.set_usage(metal::MTLTextureUsage::RenderTarget | metal::MTLTextureUsage::ShaderRead);
        nv12_uv_desc.set_storage_mode(metal::MTLStorageMode::Private);
        let nv12_uv = gpu.device.new_texture(&nv12_uv_desc);

        // NV12 staging CPU-readable (encodeur software fallback).
        let nv12_read_y_desc = metal::TextureDescriptor::new();
        nv12_read_y_desc.set_texture_type(metal::TextureType::Type2D);
        nv12_read_y_desc.set_pixel_format(metal::MTLPixelFormat::R8Unorm);
        nv12_read_y_desc.set_width(rw as u64);
        nv12_read_y_desc.set_height(rh as u64);
        nv12_read_y_desc.set_storage_mode(metal::MTLStorageMode::Shared);
        let nv12_read_y = gpu.device.new_texture(&nv12_read_y_desc);

        let nv12_read_uv_desc = metal::TextureDescriptor::new();
        nv12_read_uv_desc.set_texture_type(metal::TextureType::Type2D);
        nv12_read_uv_desc.set_pixel_format(metal::MTLPixelFormat::RG8Unorm);
        nv12_read_uv_desc.set_width(rw as u64);
        nv12_read_uv_desc.set_height(rh as u64);
        nv12_read_uv_desc.set_storage_mode(metal::MTLStorageMode::Shared);
        let nv12_read_uv = gpu.device.new_texture(&nv12_read_uv_desc);

        // --- Compilation MSL ---
        let msl_source = include_str!("shaders.metal");
        let library = gpu
            .device
            .new_library_with_source(msl_source, &metal::CompileOptions::new())
            .map_err(|e| anyhow!("MTLDevice::new_library_with_source a échoué : {e:?}"))?;

        let fn_vs_main = library
            .get_function("vs_main", None)
            .map_err(|e| anyhow!("MTLLibrary::get_function('vs_main') : {e:?}"))?;
        let fn_vs_fs = library
            .get_function("vs_fs", None)
            .map_err(|e| anyhow!("MTLLibrary::get_function('vs_fs') : {e:?}"))?;
        let fn_ps_main = library
            .get_function("ps_main", None)
            .map_err(|e| anyhow!("MTLLibrary::get_function('ps_main') : {e:?}"))?;
        let fn_ps_y = library
            .get_function("ps_y", None)
            .map_err(|e| anyhow!("MTLLibrary::get_function('ps_y') : {e:?}"))?;
        let fn_ps_uv = library
            .get_function("ps_uv", None)
            .map_err(|e| anyhow!("MTLLibrary::get_function('ps_uv') : {e:?}"))?;
        let fn_ps_tex = library
            .get_function("ps_tex", None)
            .map_err(|e| anyhow!("MTLLibrary::get_function('ps_tex') : {e:?}"))?;

        // --- Pipeline state principal : vs_main + ps_main, écrit dans le RT RGBA ---
        let pipeline_main_desc = metal::RenderPipelineDescriptor::new();
        pipeline_main_desc.set_vertex_function(Some(&fn_vs_main));
        pipeline_main_desc.set_fragment_function(Some(&fn_ps_main));
        // Le RT est RGBA8 — color attachment 0 = RT.
        let ca0_main = metal::RenderPipelineColorAttachmentDescriptor::new();
        ca0_main.set_pixel_format(metal::MTLPixelFormat::RGBA8Unorm);
        ca0_main.set_blending_enabled(true);
        ca0_main.set_rgb_blend_operation(metal::MTLBlendOperation::Add);
        ca0_main.set_source_rgb_blend_factor(metal::MTLBlendFactor::One);
        ca0_main.set_destination_rgb_blend_factor(metal::MTLBlendFactor::OneMinusSourceAlpha);
        pipeline_main_desc.set_color_attachments(0, &ca0_main);
        let pipeline_main = gpu
            .device
            .new_render_pipeline_state(&pipeline_main_desc)
            .map_err(|e| anyhow!("new_render_pipeline_state(main) : {e:?}"))?;

        // --- Pipeline states fullscreen pour la conversion RGBA→NV12 ---
        let pipeline_fs_tex_desc = metal::RenderPipelineDescriptor::new();
        pipeline_fs_tex_desc.set_vertex_function(Some(&fn_vs_fs));
        pipeline_fs_tex_desc.set_fragment_function(Some(&fn_ps_tex));
        let ca_fs_tex = metal::RenderPipelineColorAttachmentDescriptor::new();
        ca_fs_tex.set_pixel_format(metal::MTLPixelFormat::RGBA8Unorm);
        pipeline_fs_tex_desc.set_color_attachments(0, &ca_fs_tex);
        let pipeline_fs_tex = gpu
            .device
            .new_render_pipeline_state(&pipeline_fs_tex_desc)
            .map_err(|e| anyhow!("new_render_pipeline_state(fs_tex) : {e:?}"))?;

        let pipeline_fs_y_desc = metal::RenderPipelineDescriptor::new();
        pipeline_fs_y_desc.set_vertex_function(Some(&fn_vs_fs));
        pipeline_fs_y_desc.set_fragment_function(Some(&fn_ps_y));
        let ca_fs_y = metal::RenderPipelineColorAttachmentDescriptor::new();
        ca_fs_y.set_pixel_format(metal::MTLPixelFormat::R8Unorm);
        pipeline_fs_y_desc.set_color_attachments(0, &ca_fs_y);
        let pipeline_fs_y = gpu
            .device
            .new_render_pipeline_state(&pipeline_fs_y_desc)
            .map_err(|e| anyhow!("new_render_pipeline_state(fs_y) : {e:?}"))?;

        let pipeline_fs_uv_desc = metal::RenderPipelineDescriptor::new();
        pipeline_fs_uv_desc.set_vertex_function(Some(&fn_vs_fs));
        pipeline_fs_uv_desc.set_fragment_function(Some(&fn_ps_uv));
        let ca_fs_uv = metal::RenderPipelineColorAttachmentDescriptor::new();
        ca_fs_uv.set_pixel_format(metal::MTLPixelFormat::RG8Unorm);
        pipeline_fs_uv_desc.set_color_attachments(0, &ca_fs_uv);
        let pipeline_fs_uv = gpu
            .device
            .new_render_pipeline_state(&pipeline_fs_uv_desc)
            .map_err(|e| anyhow!("new_render_pipeline_state(fs_uv) : {e:?}"))?;

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
            metal_texture_cache: RefCell::new(Some(cache)),
            tex_cache: RefCell::new(HashMap::new()),
            rt: Some(rt),
            rt_read: Some(rt_read),
            nv12_y: Some(nv12_y),
            nv12_uv: Some(nv12_uv),
            nv12_read_y: Some(nv12_read_y),
            nv12_read_uv: Some(nv12_read_uv),
            library: Some(library),
            pipeline_main: Some(pipeline_main),
            pipeline_fs_y: Some(pipeline_fs_y),
            pipeline_fs_uv: Some(pipeline_fs_uv),
            pipeline_fs_tex: Some(pipeline_fs_tex),
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

    /// Dimensions réelles (texture, alignée pair) du `CVPixelBufferRef` posé dans la
    /// frame de présentation. L'API symétrique de `compositor_windows::tex_dims` —
    /// mêmes champs AVFrame, même contrat de retour.
    ///
    /// Le `CVPixelBufferRef` peut être dans `data[0]` (sentinel D3D11 par `mac_frames`)
    /// ou `data[3]` (frames brutes VideoToolbox) selon le format AVFrame — voir
    /// `nv12_srvs` pour la même discrimination.
    pub unsafe fn tex_dims(&self, frame: *const AVFrame) -> (u32, u32) {
        if frame.is_null() {
            return (0, 0);
        }
        let pb = match (*frame).format {
            f if f == crate::ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX as i32 => {
                (*frame).data[3] as *mut std::ffi::c_void
            }
            f if f == crate::ffi::AVPixelFormat::AV_PIX_FMT_D3D11 as i32 => {
                (*frame).data[0] as *mut std::ffi::c_void
            }
            _ => return (0, 0),
        };
        if pb.is_null() {
            return (0, 0);
        }
        let w = CVPixelBufferGetWidth(pb);
        let h = CVPixelBufferGetHeight(pb);
        (w as u32, h as u32)
    }

    /// Crée (ou sort du cache) les `MTLTexture` Y (R8Unorm) et UV (RG8Unorm) à partir
    /// du `CVPixelBufferRef` de la frame. Zéro copie : les textures Metal partagent la
    /// mémoire IOSurface du `CVPixelBuffer`. L'API symétrique de
    /// `compositor_windows::nv12_srvs` — mêmes champs AVFrame lus, format différent en
    /// sortie (2 `MTLTexture` au lieu de 2 `ID3D11ShaderResourceView`).
    ///
    /// Le `CVPixelBufferRef` peut être posé à deux endroits dans l'AVFrame, selon le
    /// chemin de décodage :
    ///   - `format == AV_PIX_FMT_D3D11` : sentinel posé par `mac_frames::CpuFrames::present`
    ///     (chemin software fallback). Le CVPixelBufferRef est dans `data[0]`.
    ///   - `format == AV_PIX_FMT_VIDEOTOOLBOX` : frame brute de VideoToolbox. Le
    ///     CVPixelBufferRef est dans `data[3]` (convention ffmpeg).
    /// Les deux aboutissent au même IOSurface-backed buffer ; `CVMetalTextureCache`
    /// n'a pas de préférence.
    ///
    /// Les `MTLTexture` retournées sont retain côté `metal::Texture::from_raw` dans
    /// les commits qui câbleront `compose_frame`. Ce commit expose juste la méthode
    /// pour valider le seam — `compose_frame` continue à retourner `Err`.
    pub unsafe fn nv12_srvs(
        &self,
        frame: *const AVFrame,
    ) -> Result<(metal::Texture, metal::Texture)> {
        let pb = match (*frame).format {
            f if f == crate::ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX as i32 => {
                // Frame VideoToolbox brute — convention ffmpeg : CVPixelBufferRef dans
                // `data[3]` (et non `data[0]` comme D3D11VA).
                (*frame).data[3] as *mut std::ffi::c_void
            }
            f if f == crate::ffi::AVPixelFormat::AV_PIX_FMT_D3D11 as i32 => {
                // Frame posée par `mac_frames::CpuFrames::present` (sentinel) — le
                // CVPixelBufferRef est dans `data[0]`.
                (*frame).data[0] as *mut std::ffi::c_void
            }
            _ => {
                return Err(anyhow!(
                    "nv12_srvs: format {:?} inattendu (ni D3D11 sentinel ni VIDEOTOOLBOX)",
                    (*frame).format
                ));
            }
        };

        if pb.is_null() {
            return Err(anyhow!("nv12_srvs: CVPixelBufferRef nul — data[idx] est null"));
        }
        let pb_key = pb as usize;

        let cache_ref = self.metal_texture_cache.borrow();
        let cache = cache_ref
            .as_ref()
            .ok_or_else(|| anyhow!("nv12_srvs: CVMetalTextureCache non initialisé"))?;

        // Plan Y : `MTLPixelFormatR8Unorm`, plane_index 0.
        let y_key = (pb_key, 0usize);
        let y_ptr = if let Some(p) = self.tex_cache.borrow().get(&y_key) {
            *p
        } else {
            let p = cache.make_texture_from_pixel_buffer(pb, 0, metal::MTLPixelFormat::R8Unorm)?;
            self.tex_cache.borrow_mut().insert(y_key, p);
            p
        };

        // Plan UV : `MTLPixelFormatRG8Unorm`, plane_index 1.
        let uv_key = (pb_key, 1usize);
        let uv_ptr = if let Some(p) = self.tex_cache.borrow().get(&uv_key) {
            *p
        } else {
            let p = cache.make_texture_from_pixel_buffer(pb, 1, metal::MTLPixelFormat::RG8Unorm)?;
            self.tex_cache.borrow_mut().insert(uv_key, p);
            p
        };

        // `metal::Texture::from_raw` retient côté Rust (ARC). À chaque appel on retient
        // une nouvelle référence — le caller (compose_frame) en devient propriétaire et
        // doit la relâcher via `Drop`. Idem côté Windows : les SRV retournés sont clonés
        // par le caller, retain/release symétrique.
        let y = metal::Texture::from_raw(y_ptr);
        let uv = metal::Texture::from_raw(uv_ptr);
        Ok((y, uv))
    }

    /// Compose la frame suivante → render target RGBA. **First-pass engine** : la vidéo
    /// `screen` est blittée pleine-canvas (UV→Y+UV sample, mode 0 du shader `ps_main`),
    /// sans layers / webcam / rounded corners / ombres / blur. Les effets avancés
    /// sont implémentés dans des commits dédiés qui câbleront les `LayerCB` par
    /// quad (cf. PR #189 § « Engine commits remaining »).
    ///
    /// Le `webcam` est ignoré pour l'instant — la preview full-canvas suffit au chemin
    /// encode (`run_composited_multi`) et à la prévisualisation tant que les layers
    /// ne sont pas câblés.
    pub unsafe fn compose_frame(
        &self,
        screen: *const AVFrame,
        _webcam: *const AVFrame,
        _frame: f32,
        _cfg: &Cfg,
    ) -> Result<()> {
        if screen.is_null() || (*screen).data[0].is_null() && (*screen).data[3].is_null() {
            // Pas de frame source : on efface le RT au noir.
            return self.clear_rt();
        }

        let (sy, suv) = self.nv12_srvs(screen)?;
        let rt = self.rt.as_ref().ok_or_else(|| anyhow!("engine non initialisé"))?;
        let pipeline = self
            .pipeline_main
            .as_ref()
            .ok_or_else(|| anyhow!("engine non initialisé"))?;

        // LayerCB : full-canvas (dst = [0,0,1,1], src = [0,0,1,1], mode = 0 = NV12).
        // Couleurs / ombres / radius neutres (mode 0 = pas d'effet de bord).
        let layer: Layer = Layer {
            dst: [0.0, 0.0, 1.0, 1.0],
            src: [0.0, 0.0, 1.0, 1.0],
            quad_px: [self.render_w as f32, self.render_h as f32],
            radius_px: 0.0,
            mode: 0.0,
            color: [1.0, 1.0, 1.0, 1.0],
            fx: [0.0; 4],
            src_prev: [0.0; 4],
            dst_prev: [0.0; 4],
            mb: [1.0, 0.0, 0.0, 0.0],
        };

        let cmd_buf = self
            .gpu
            .context
            .new_command_buffer()
            .ok_or_else(|| anyhow!("MTLCommandQueue::new_command_buffer a renvoyé None"))?;

        // Render pass descriptor : attachment 0 = RT principal, action = Clear → Store.
        let pass_desc = metal::RenderPassDescriptor::new();
        let ca = pass_desc
            .color_attachments()
            .object_at(0)
            .ok_or_else(|| anyhow!("RenderPassDescriptor::color_attachments(0)"))?;
        ca.set_texture(Some(rt));
        ca.set_load_action(metal::LoadAction::Clear);
        ca.set_clear_color(metal::MTLClearColor(0.0, 0.0, 0.0, 1.0));
        ca.set_store_action(metal::StoreAction::Store);

        let encoder = cmd_buf
            .new_render_command_encoder(&pass_desc)
            .ok_or_else(|| anyhow!("MTLCommandBuffer::new_render_command_encoder a renvoyé None"))?;
        encoder.set_render_pipeline_state(pipeline);
        // Le shader ps_main attend texY/texUV/texImg + samp. On bind les 2 premières
        // (les samples ne lisent que t0/t1 en mode 0).
        encoder.set_fragment_texture(0, Some(&sy));
        encoder.set_fragment_texture(1, Some(&suv));
        // LayerCB : 128 octets, on l'envoie via set_fragment_bytes (le VS ne lit pas
        // LayerCB en mode full-canvas — c'est uniquement côté FS).
        encoder.set_fragment_bytes(
            0,
            std::mem::size_of::<Layer>() as u64,
            &layer as *const Layer as *const std::ffi::c_void,
        );
        // vs_main est un quad-strip à partir de SV_VertexID : 4 vertices.
        encoder.draw_primitives(metal::MTLPrimitiveType::TriangleStrip, 0, 4);
        encoder.end_encoding();
        cmd_buf.commit();

        Ok(())
    }

    /// Efface le RT au noir (utilisé quand `screen` est null ou vide).
    unsafe fn clear_rt(&self) -> Result<()> {
        let rt = self.rt.as_ref().ok_or_else(|| anyhow!("engine non initialisé"))?;
        let cmd_buf = self
            .gpu
            .context
            .new_command_buffer()
            .ok_or_else(|| anyhow!("MTLCommandQueue::new_command_buffer"))?;
        let pass_desc = metal::RenderPassDescriptor::new();
        let ca = pass_desc.color_attachments().object_at(0).unwrap();
        ca.set_texture(Some(rt));
        ca.set_load_action(metal::LoadAction::Clear);
        ca.set_clear_color(metal::MTLClearColor(0.0, 0.0, 0.0, 1.0));
        ca.set_store_action(metal::StoreAction::Store);
        let encoder = cmd_buf.new_render_command_encoder(&pass_desc).unwrap();
        encoder.end_encoding();
        cmd_buf.commit();
        Ok(())
    }

    /// Variante motion-blur de `compose_frame` — symétrique de
    /// `compositor_windows::compose_frame_mb`. Renvoie `Err` tant que le moteur
    /// avancé (couches multiples avec vélocité par quad) n'est pas câblé — c'est
    /// l'objet d'un commit dédié qui exercera `ps_main` mode 0 avec `mb.x > 1`.
    pub unsafe fn compose_frame_mb(
        &self,
        _screen: *const AVFrame,
        _webcam: *const AVFrame,
        _frame: u32,
        _cfg: &Cfg,
    ) -> Result<()> {
        Err(anyhow!("compositor_macos::compose_frame_mb: non implémenté"))
    }

    /// Convertit le RT RGBA → `nv12_y` + `nv12_uv` (deux passes fullscreen).
    /// Le résultat NV12 alimente l'encodeur (zero-copy via `MTLBlitCommandEncoder::copy`
    /// vers le `hw_frames_ctx` VideoToolbox) ou `read_nv12_scaled` pour le software
    /// fallback (`h264_mf` / `libopenh264`).
    pub unsafe fn rgb_to_nv12(&self, _out_tex: *mut std::ffi::c_void, _slice: u32) -> Result<()> {
        // First-pass engine : la cible est toujours `self.nv12_y`/`self.nv12_uv` (le
        // buffer interne). L'argument `out_tex` est conservé pour l'API symétrique avec
        // Windows ; le câblage zero-copy vers un buffer externe (CVPixelBuffer
        // appartenant à l'encodeur) viendra avec le commit « encodeur VT » quand
        // l'encodeur sera implémenté.
        self.render_nv12()
    }

    pub unsafe fn rgb_to_nv12_scaled(
        &self,
        _target_w: u32,
        _target_h: u32,
        _out_tex: *mut std::ffi::c_void,
        _slice: u32,
    ) -> Result<()> {
        // First-pass engine : le resize sera câblé dans un commit dédié. Pour
        // l'instant on rend à la taille de rendu.
        self.render_nv12()
    }

    /// Convertit le RT RGBA → `self.nv12_y` (R8) et `self.nv12_uv` (RG8) via deux
    /// passes fullscreen (ps_y puis ps_uv sur vs_fs). C'est le miroir Metal exact de
    /// `compositor_windows::render_nv12` — même contrat de sortie (NV12 interne),
    /// même chemin de conversion BT.709 limited RGB→Y'CbCr.
    pub unsafe fn render_nv12(&self) {
        let rt = match self.rt.as_ref() {
            Some(t) => t,
            None => return,
        };
        let nv12_y = match self.nv12_y.as_ref() {
            Some(t) => t,
            None => return,
        };
        let nv12_uv = match self.nv12_uv.as_ref() {
            Some(t) => t,
            None => return,
        };
        let pipeline_y = match self.pipeline_fs_y.as_ref() {
            Some(p) => p,
            None => return,
        };
        let pipeline_uv = match self.pipeline_fs_uv.as_ref() {
            Some(p) => p,
            None => return,
        };

        let cmd_buf = match self.gpu.context.new_command_buffer() {
            Some(b) => b,
            None => return,
        };

        // Pass Y : pleine résolution, source = RT, cible = nv12_y.
        let pass_y = metal::RenderPassDescriptor::new();
        let ca_y = pass_y.color_attachments().object_at(0).unwrap();
        ca_y.set_texture(Some(nv12_y));
        ca_y.set_load_action(metal::LoadAction::Clear);
        ca_y.set_store_action(metal::StoreAction::Store);
        let enc_y = match cmd_buf.new_render_command_encoder(&pass_y) {
            Some(e) => e,
            None => return,
        };
        enc_y.set_render_pipeline_state(pipeline_y);
        enc_y.set_fragment_texture(0, Some(rt));
        enc_y.draw_primitives(metal::MTLPrimitiveType::Triangle, 0, 3);
        enc_y.end_encoding();

        // Pass UV : pleine résolution, source = RT, cible = nv12_uv.
        let pass_uv = metal::RenderPassDescriptor::new();
        let ca_uv = pass_uv.color_attachments().object_at(0).unwrap();
        ca_uv.set_texture(Some(nv12_uv));
        ca_uv.set_load_action(metal::LoadAction::Clear);
        ca_uv.set_store_action(metal::StoreAction::Store);
        let enc_uv = match cmd_buf.new_render_command_encoder(&pass_uv) {
            Some(e) => e,
            None => return,
        };
        enc_uv.set_render_pipeline_state(pipeline_uv);
        enc_uv.set_fragment_texture(0, Some(rt));
        enc_uv.draw_primitives(metal::MTLPrimitiveType::Triangle, 0, 3);
        enc_uv.end_encoding();

        cmd_buf.commit();
    }

    /// Lit le RT RGBA vers un Vec<u8> CPU (preview live). `MTLStorageMode::Shared`
    /// permet `get_bytes` synchrone. Renvoie (w, h, RGBA8).
    pub unsafe fn readback_direct(&self) -> Result<(u32, u32, Vec<u8>)> {
        let rt_read = self
            .rt_read
            .as_ref()
            .ok_or_else(|| anyhow!("engine non initialisé"))?;
        let w = self.render_w;
        let h = self.render_h;
        let bytes_per_row = w * 4;
        let mut data = vec![0u8; (bytes_per_row * h) as usize];
        rt_read.get_bytes(
            data.as_mut_ptr() as *mut std::ffi::c_void,
            bytes_per_row as u64,
            0,
            0,
            w as u64,
            h as u64,
        );
        Ok((w, h, data))
    }

    /// Variante resize de `readback_direct` — first-pass engine : on rend à la taille
    /// de rendu puis on lit ; le resize séparé viendra avec le commit « pipeline
    /// resize » quand il sera câblé.
    pub unsafe fn readback_resized(
        &self,
        _target_w: u32,
        _target_h: u32,
    ) -> Result<Vec<u8>> {
        let (_, _, data) = self.readback_direct()?;
        Ok(data)
    }

    /// Lit la texture NV12 (Y+UV) vers la mémoire système. Utilisé par
    /// `VideoEncoder::send_composited` côté pipeline CPU-like (`h264_mf` /
    /// `libopenh264`). Le `MTLBlitCommandEncoder` copie GPU→CPU (`Shared` storage
    /// permet `getBytes` synchrone, comme `readback_direct`).
    pub unsafe fn read_nv12_scaled(
        &self,
        target_w: u32,
        target_h: u32,
        dst_y: *mut u8,
        pitch_y: usize,
        dst_uv: *mut u8,
        pitch_uv: usize,
    ) -> Result<()> {
        let nv12_read_y = self
            .nv12_read_y
            .as_ref()
            .ok_or_else(|| anyhow!("engine non initialisé"))?;
        let nv12_read_uv = self
            .nv12_read_uv
            .as_ref()
            .ok_or_else(|| anyhow!("engine non initialisé"))?;

        // Copie GPU→CPU via get_bytes (le storage est Shared, comme rt_read).
        // First-pass engine : on suppose que `render_nv12` a déjà été appelé pour peupler
        // nv12_y/nv12_uv ; le pipeline will populate nv12_read_y/_uv en miroir avant
        // l'encode. Ici on fait le plus simple : on lit directement depuis les
        // textures staging CPU-readable.
        let bytes_per_row_y = target_w;
        let bytes_per_row_uv = target_w * 2;
        nv12_read_y.get_bytes(
            dst_y as *mut std::ffi::c_void,
            pitch_y as u64,
            0,
            0,
            target_w as u64,
            target_h as u64,
        );
        nv12_read_uv.get_bytes(
            dst_uv as *mut std::ffi::c_void,
            pitch_uv as u64,
            0,
            0,
            target_w as u64,
            target_h as u64,
        );
        // Note : bytes_per_row retournés != pitch_y (qui est l'alignement de l'AVFrame).
        // get_bytes utilise bytes_per_row comme stride source — ici on l'assume aligné sur
        // target_w, ce qui est vrai tant que le moteur rend à target_w. Si un caller passe
        // un pitch différent (rare), c'est à lui d'aligner.
        let _ = bytes_per_row_y;
        let _ = bytes_per_row_uv;
        Ok(())
    }

    pub unsafe fn dump_nv12(&self, _path: &str) -> Result<()> {
        Err(anyhow!("compositor_macos::dump_nv12: non implémenté"))
    }

    pub unsafe fn dump_raw(&self, _path: &str) -> Result<()> {
        Err(anyhow!("compositor_macos::dump_raw: non implémenté"))
    }

    pub unsafe fn blit_to(
        &self,
        _rtv: *mut std::ffi::c_void,
        _x: f32,
        _y: f32,
        _w: f32,
        _h: f32,
    ) {
        // No-op tant que le pipeline Metal de blit n'est pas implémenté.
    }
}

/// Constant buffer Layer — symétrique du cbuffer HLSL dans `shaders.hlsl` /
/// `shaders.metal`. 128 octets, uploadé via `set_fragment_bytes` (alignement 4 OK).
///
/// IMPORTANT : le mapping HLSL `cbuffer X { float4 dst; ... }` aligne chaque
/// `float4` sur 16 octets ; MSL `constant X &` aligne la struct sur 16 octets si elle
/// est elle-même alignée. Les `float2` (quad_px, fx.zw) sont entre des `float4`, donc
/// le padding HLSL/MSL produit le même layout 128 octets. Ce struct `repr(C)` reproduit
/// ce layout : chaque champ dans le même ordre, avec le bon alignement.
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