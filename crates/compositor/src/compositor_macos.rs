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
use anyhow::{anyhow, Result};
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
/// via `CVMetalTextureCache`. Le reste de l'engine (render targets RGBA + NV12, shaders
/// MSL, blend states, sampler, cbuffer `LayerCB`) sera ajouté dans les commits suivants.
pub struct Compositor {
    gpu: Gpu,
    render_w: u32,
    render_h: u32,
    scene: RefCell<Option<Scene>>,
    cursor: RefCell<Option<crate::cursor::CursorTrack>>,
    cursor_time: RefCell<Option<f32>>,
    timeline_time: RefCell<Option<f32>>,
    live_params: RefCell<LiveParams>,
    /// Cache Metal texture cache. Créé lazily au premier `nv12_srvs` (parce que la
    /// création prend le `MTLDevice` qui doit être vivant — `Compositor::new_sized`
    /// garantit ça). Flushé dans Drop.
    metal_texture_cache: RefCell<Option<CVMetalTextureCache>>,
    /// Cache (pixel_buffer_ptr, plane_index) → MTLTexture (id<MTLTexture> opaque).
    /// Le D3D11VA pool tournant fait 32 textures ; le CVPixelBuffer côté macOS est
    /// réutilisé par frame (cf. `mac_frames::CpuFrames`), donc le cache reste petit.
    tex_cache: RefCell<std::collections::HashMap<(usize, usize), *mut std::ffi::c_void>>,
}

impl Compositor {
    /// Crée le moteur sur le GPU donné. Équivalent Metal de
    /// `compositor_windows::Compositor::new`. Renvoie `Err` dans ce commit — les
    /// commits suivants remplissent : render targets RGBA + NV12, shaders MSL,
    /// constant buffer `LayerCB`, blend states, sampler.
    pub fn new(gpu: &Gpu) -> Result<Compositor> {
        Self::new_sized(gpu, OUT_W, OUT_H)
    }

    /// Comme `new`, mais avec une taille de rendu explicite.
    pub fn new_sized(gpu: &Gpu, w: u32, h: u32) -> Result<Compositor> {
        let (rw, rh) = Self::normalize_render_size(w, h);
        let metal_device_ptr = gpu.device.as_ptr();
        let cache = CVMetalTextureCache::new(metal_device_ptr as *const std::ffi::c_void)?;
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
            tex_cache: RefCell::new(std::collections::HashMap::new()),
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

    /// Compose la frame suivante → render target RGBA. Renvoie `Err` tant que le
    /// pipeline Metal de composition (render targets, shaders MSL, blend, cbuffer) n'est
    /// pas implémenté. Le commit « engine » qui suit remplira :
    ///   - `self.rt` : MTLTexture RGBA8 (render target) créé à `new_sized`,
    ///   - `self.nv12` : MTLTexture NV12 (interne, RT-able sur les deux plans),
    ///   - shaders MSL compilés via `MTLDevice.makeLibrary(source:)`,
    ///   - constant buffer `LayerCB` uploadé via `setVertexBytes`,
    ///   - encodeur `MTLRenderCommandEncoder` avec le pipeline state `ps_main`,
    ///   - passes `vs_main` (quads) + `ps_main` (méga-shader 14 modes).
    pub unsafe fn compose_frame(
        &self,
        _screen: *const AVFrame,
        _webcam: *const AVFrame,
        _frame: f32,
        _cfg: &Cfg,
    ) -> Result<()> {
        Err(anyhow!("compositor_macos::compose_frame: non implémenté"))
    }

    pub unsafe fn compose_frame_mb(
        &self,
        _screen: *const AVFrame,
        _webcam: *const AVFrame,
        _frame: u32,
        _cfg: &Cfg,
    ) -> Result<()> {
        Err(anyhow!("compositor_macos::compose_frame_mb: non implémenté"))
    }

    pub unsafe fn rgb_to_nv12(&self, _out_tex: *mut std::ffi::c_void, _slice: u32) -> Result<()> {
        Err(anyhow!("compositor_macos::rgb_to_nv12: non implémenté"))
    }

    pub unsafe fn rgb_to_nv12_scaled(
        &self,
        _target_w: u32,
        _target_h: u32,
        _out_tex: *mut std::ffi::c_void,
        _slice: u32,
    ) -> Result<()> {
        Err(anyhow!("compositor_macos::rgb_to_nv12_scaled: non implémenté"))
    }

    pub unsafe fn readback_resized(
        &self,
        _target_w: u32,
        _target_h: u32,
    ) -> Result<Vec<u8>> {
        Err(anyhow!("compositor_macos::readback_resized: non implémenté"))
    }

    pub unsafe fn readback_direct(&self) -> Result<(u32, u32, Vec<u8>)> {
        Err(anyhow!("compositor_macos::readback_direct: non implémenté"))
    }

    pub unsafe fn read_nv12_scaled(
        &self,
        _target_w: u32,
        _target_h: u32,
        _dst_y: *mut u8,
        _pitch_y: usize,
        _dst_uv: *mut u8,
        _pitch_uv: usize,
    ) -> Result<()> {
        Err(anyhow!("compositor_macos::read_nv12_scaled: non implémenté"))
    }

    pub unsafe fn render_nv12(&self) {
        // No-op tant que le pipeline Metal n'est pas implémenté.
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