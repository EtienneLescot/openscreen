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
    /// Dernier command buffer soumis, gardé pour pouvoir l'attendre AU MOMENT où le CPU lit
    /// vraiment. Soumettre puis attendre tout de suite vide le pipeline à chaque frame :
    /// le GPU finit, le CPU décode et encode pendant que le GPU dort, et on paie la latence
    /// d'un aller-retour complet par passe au lieu de laisser les deux se recouvrir.
    last_cmd: RefCell<Option<metal::CommandBuffer>>,
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
    /// Copie MIPMAPPÉE du render target, pour les annotations « flou ». On ne peut pas
    /// échantillonner la cible sur laquelle on dessine, et le mode 10 lit un niveau de mip
    /// pour flouter à coût constant.
    ann_copy: metal::Texture,
    /// Images d'annotation, indexées par ID d'annotation (pas par data-URL : celle-ci pèse
    /// souvent des mégaoctets et la hacher à chaque frame coûterait plus que le décodage).
    /// La longueur sert de garde-fou quand l'utilisateur change l'image.
    ann_img_cache: RefCell<std::collections::HashMap<String, (metal::Texture, u32, u32, usize)>>,
    /// Textes rastérisés, indexés par ID, avec la `cache_key` du spec pour invalider.
    text_cache: RefCell<std::collections::HashMap<String, (metal::Texture, u64)>>,
    text_raster: Option<crate::text::TextRasterizer>,
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
        let ann_copy = {
            let d = metal::TextureDescriptor::new();
            d.set_texture_type(metal::MTLTextureType::D2);
            d.set_pixel_format(metal::MTLPixelFormat::RGBA8Unorm);
            d.set_width(rw as u64);
            d.set_height(rh as u64);
            d.set_storage_mode(metal::MTLStorageMode::Private);
            d.set_usage(rt_usage);
            // Assez de niveaux pour que `log2(rayon)` du mode 10 en trouve toujours un.
            d.set_mipmap_level_count(
                (32 - rw.max(rh).max(1).leading_zeros()).max(1) as u64,
            );
            device.new_texture(&d)
        };

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
            last_cmd: RefCell::new(None),
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
            ann_copy,
            ann_img_cache: RefCell::new(std::collections::HashMap::new()),
            text_cache: RefCell::new(std::collections::HashMap::new()),
            text_raster: crate::text::TextRasterizer::new().ok(),
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

    /// Cf. `compositor_windows::set_has_webcam` — le seul champ de `LiveParams` qui dépend du
    /// clip courant, rebranché par `walk_composited_timeline` sans écraser le reste.
    pub fn set_has_webcam(&self, v: bool) {
        self.live_params.borrow_mut().has_webcam = v;
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

    /// Vide le `CVMetalTextureCache` — API symétrique de
    /// `compositor_windows::Compositor::clear_srv_cache`, même contrat côté appelant
    /// (`live.rs` l'appelle sans savoir sur quelle plateforme il tourne) : à invoquer
    /// quand un jeu de décodeurs vient d'être fermé, pour ne pas garder de textures
    /// pointant sur un IOSurface déjà libéré.
    ///
    /// Pas de `HashMap` keyée par adresse à vider ici (contrairement à Windows) — voir
    /// la doc de `CVMetalTextureCache` : CoreVideo est déjà ce cache et le réutilise par
    /// IOSurface, pas par pointeur Rust. `flush()` est donc la vidange elle-même.
    pub fn clear_srv_cache(&self) {
        self.metal_texture_cache.flush();
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


    /// Ombre d'un écran incliné en 3D : la pénombre suit le QUADRILATÈRE projeté (mode 12),
    /// pas son rect englobant. Port de `compositor_windows::draw_quad_shadow`.
    #[allow(clippy::too_many_arguments)]
    unsafe fn draw_quad_shadow(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        corners: &[(f32, f32); 4],
        center_px: [f32; 2],
        radius: f32,
        spread: f32,
        offset_px: [f32; 2],
        opacity: f32,
    ) {
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let (min_x, max_x) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
        let (min_y, max_y) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
        // La boîte doit contenir la pénombre entière, sinon elle se coupe net.
        let box_w = (max_x - min_x) + 2.0 * spread;
        let box_h = (max_y - min_y) + 2.0 * spread;
        let local = |(x, y): (f32, f32)| -> [f32; 2] { [x - min_x + spread, y - min_y + spread] };
        let [tl0, tl1] = local(corners[0]);
        let [tr0, tr1] = local(corners[1]);
        let [br0, br1] = local(corners[2]);
        let [bl0, bl1] = local(corners[3]);
        self.draw_solid(
            enc,
            &LayerCB {
                dst: [
                    (center_px[0] + min_x - spread + offset_px[0]) / rw,
                    (center_px[1] + min_y - spread + offset_px[1]) / rh,
                    box_w / rw,
                    box_h / rh,
                ],
                quad_px: [box_w, box_h],
                radius_px: radius,
                mode: 12.0,
                color: [0.0, 0.0, 0.0, opacity],
                fx: [tl0, tl1, tr0, tr1],
                src_prev: [br0, br1, bl0, bl1],
                mb: [0.0, spread, 1.0, 0.0],
                ..Default::default()
            },
        );
    }

    /// Écran incliné (mode 8) : warp bilinéaire inverse dans la bbox du quad projeté.
    /// Pas de motion blur sur ce chemin — le tilt est bref, la simplification ne se voit pas.
    unsafe fn draw_tilted_screen(
        &self,
        enc: &metal::RenderCommandEncoderRef,
        quad: &crate::regions::TiltedQuad,
        s_px: [f32; 2],
        center_px: [f32; 2],
        cut: [f32; 4],
        radius: f32,
        y: &metal::Texture,
        uv: &metal::Texture,
    ) {
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let corners = quad.corners;
        // Taille du plan dans son propre repère, avant projection : c'est là que vit le rayon,
        // pour qu'il reste constant le long du bord au lieu de s'étirer avec la perspective.
        let plane_px = [s_px[0] * quad.scale, s_px[1] * quad.scale];
        let (min_x, max_x) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
        let (min_y, max_y) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
        let bbox_w = (max_x - min_x).max(1.0);
        let bbox_h = (max_y - min_y).max(1.0);
        // coins en px LOCAUX à la bbox, pour matcher `i.local` du shader.
        let local = |(x, y): (f32, f32)| -> [f32; 2] { [x - min_x, y - min_y] };
        let [tl0, tl1] = local(corners[0]);
        let [tr0, tr1] = local(corners[1]);
        let [br0, br1] = local(corners[2]);
        let [bl0, bl1] = local(corners[3]);
        self.draw_video(
            enc,
            &LayerCB {
                dst: [
                    (center_px[0] + min_x) / rw,
                    (center_px[1] + min_y) / rh,
                    bbox_w / rw,
                    bbox_h / rh,
                ],
                src: cut,
                quad_px: [bbox_w, bbox_h],
                radius_px: radius * quad.scale,
                mode: 8.0,
                fx: [tl0, tl1, tr0, tr1],
                src_prev: [br0, br1, bl0, bl1],
                dst_prev: [plane_px[0], plane_px[1], 0.0, 0.0],
                ..Default::default()
            },
            y,
            uv,
        );
    }


    /// Annotations : calque le plus haut, ancré sur `s_ann` — le rect écran SANS ZOOM, le
    /// conteneur que reçoit l'overlay web. Port de `compositor_windows::draw_annotations`.
    ///
    /// Le paramètre s'appelle `s_ann` et pas `screen_dst` parce que c'est le seul rect
    /// correct : lui passer `s_dst` fait dériver et grossir les sous-titres sous un zoom
    /// (issue #179, puis #397 sur Linux). L'arithmétique elle-même vit dans
    /// `frame_geometry::annotation_dst_in`, partagée par les trois backends.
    unsafe fn draw_annotations(
        &self,
        cmd: &metal::CommandBufferRef,
        scene: Option<&Scene>,
        t: f32,
        s_ann: [f32; 4],
    ) -> Result<()> {
        let Some(scene) = scene else { return Ok(()) };
        if scene.annotations.is_empty() {
            return Ok(());
        }
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let visible = |a: &crate::scene::SceneAnnotation| {
            t >= a.start_sec as f32 && t < a.end_sec as f32
        };
        // UNE seule recopie pour toutes les annotations flou de la frame : leur lecture doit
        // voir l'image composée SANS les flous eux-mêmes, sinon deux zones qui se recouvrent
        // s'échantillonneraient l'une l'autre selon l'ordre de dessin.
        if scene.annotations.iter().any(|a| a.kind == "blur" && visible(a)) {
            let blit = cmd.new_blit_command_encoder();
            blit.copy_from_texture(
                &self.rt, 0, 0,
                metal::MTLOrigin { x: 0, y: 0, z: 0 },
                metal::MTLSize { width: rw as u64, height: rh as u64, depth: 1 },
                &self.ann_copy, 0, 0,
                metal::MTLOrigin { x: 0, y: 0, z: 0 },
            );
            // Seul le mip 0 est rempli ; le GPU dérive le reste.
            blit.generate_mipmaps(&self.ann_copy);
            blit.end_encoding();
        }

        let enc = self.begin_pass(cmd, &self.rt, None, &self.pipeline_main)?;
        // La liste arrive déjà triée par zIndex côté app : l'ordre d'itération EST l'ordre
        // de peinture.
        for a in &scene.annotations {
            if !visible(a) {
                continue;
            }
            // `anchor` et non `s_ann` : un sous-titre (`space: "frame"`) se mesure sur le
            // cadre de sortie. Le dénominateur de la police plus bas lit le MÊME `anchor`.
            let anchor = a.anchor_rect(s_ann);
            let dst = crate::frame_geometry::annotation_dst_in(anchor, a.x, a.y, a.w, a.h);
            let quad_px = [dst[2] * rw, dst[3] * rh];
            if quad_px[0] <= 0.0 || quad_px[1] <= 0.0 {
                continue;
            }
            match a.kind.as_str() {
                "figure" => {
                    let Some(figure) = a.figure.as_ref() else { continue };
                    let (segments, half_stroke) = crate::regions::arrow_local_geometry(
                        &figure.direction,
                        figure.stroke_width,
                        quad_px,
                    );
                    self.draw_solid(enc, &LayerCB {
                        dst,
                        quad_px,
                        mode: 9.0,
                        color: parse_hex(&figure.color).unwrap_or([1.0, 1.0, 1.0, 1.0]),
                        fx: segments[0],
                        src_prev: segments[1],
                        dst_prev: segments[2],
                        mb: [1.0, half_stroke, 0.0, 0.0],
                        ..Default::default()
                    });
                }
                "blur" => {
                    let Some(blur) = a.blur.as_ref() else { continue };
                    // Le masque en tracé libre demanderait une liste de points côté GPU : on
                    // masque la BOÎTE ENGLOBANTE. Choix délibérément asymétrique — ne rien
                    // dessiner laisserait passer en clair ce que l'utilisateur a désigné comme
                    // à cacher, et un masque qui ne masque pas donne confiance à tort.
                    let freehand = blur.shape == "freehand";
                    let is_blur = if blur.style == "blur" { 1.0 } else { 0.0 };
                    let amount = if is_blur > 0.5 { blur.intensity } else { blur.block_size };
                    // Le repli passe par le rectangle, pas l'ovale : un ovale inscrit
                    // retirerait les coins, donc une partie de ce qui est couvert.
                    let is_oval = if blur.shape == "oval" && !freehand { 1.0 } else { 0.0 };
                    // La teinte n'a de sens qu'en mosaïque : un flou teinté ne ressemble plus
                    // à un flou.
                    let tinted = if is_blur > 0.5 { 0.0 } else { 1.0 };
                    let tint = if blur.color == "black" {
                        [0.0, 0.0, 0.0, 1.0]
                    } else {
                        [1.0, 1.0, 1.0, 1.0]
                    };
                    enc.set_fragment_texture(2, Some(&self.ann_copy));
                    self.draw_solid(enc, &LayerCB {
                        dst,
                        quad_px,
                        mode: 10.0,
                        color: tint,
                        fx: [is_blur, amount.max(1.0), is_oval, tinted],
                        ..Default::default()
                    });
                }
                "image" => {
                    let Some(src) = a.image_path.as_ref().filter(|s| !s.is_empty()) else {
                        continue;
                    };
                    let cached = {
                        let c = self.ann_img_cache.borrow();
                        c.get(&a.id).filter(|(_, _, _, len)| *len == src.len()).cloned()
                    };
                    let Some((tex, iw, ih, _)) = cached.or_else(|| {
                        match self.load_image_texture(src) {
                            Ok((tex, w, h)) => {
                                let e = (tex, w, h, src.len());
                                self.ann_img_cache.borrow_mut().insert(a.id.clone(), e.clone());
                                Some(e)
                            }
                            Err(e) => {
                                eprintln!("[annotation image] {}: {e:#}", a.id);
                                None
                            }
                        }
                    }) else {
                        continue;
                    };
                    if iw == 0 || ih == 0 {
                        continue;
                    }
                    let box_aspect = quad_px[0] / quad_px[1];
                    let img_aspect = iw as f32 / ih as f32;
                    let (fit_w, fit_h) = if img_aspect > box_aspect {
                        (dst[2], dst[3] * (box_aspect / img_aspect))
                    } else {
                        (dst[2] * (img_aspect / box_aspect), dst[3])
                    };
                    enc.set_fragment_texture(2, Some(&tex));
                    self.draw_solid(enc, &LayerCB {
                        dst: [
                            dst[0] + (dst[2] - fit_w) * 0.5,
                            dst[1] + (dst[3] - fit_h) * 0.5,
                            fit_w,
                            fit_h,
                        ],
                        src: [0.0, 0.0, 1.0, 1.0],
                        quad_px: [fit_w * rw, fit_h * rh],
                        mode: 7.0,
                        color: [1.0, 1.0, 1.0, 1.0],
                        fx: [0.0, 0.0, 1.0, 1.0],
                        ..Default::default()
                    });
                }
                "text" => {
                    let Some(text) = a.text.as_ref() else { continue };
                    let Some(raster) = self.text_raster.as_ref() else { continue };
                    if text.content.trim().is_empty() {
                        continue;
                    }
                    let spec = crate::text::TextSpec {
                        content: text.content.clone(),
                        color: parse_hex(&text.color).unwrap_or([1.0, 1.0, 1.0, 1.0]),
                        background: parse_hex(&text.background_color)
                            .unwrap_or([0.0, 0.0, 0.0, 0.0]),
                        font_size_px: text.font_size_rel * (anchor[3] * rh),
                        font_family: text.font_family.clone(),
                        bold: text.font_weight == "bold",
                        italic: text.font_style == "italic",
                        underline: text.text_decoration == "underline",
                        align: text.text_align.clone(),
                        // Absent = "center", le comportement historique : les
                        // annotations ne changent pas d'un pixel.
                        valign: text.vertical_align.clone().unwrap_or_default(),
                        box_px: [quad_px[0].round() as u32, quad_px[1].round() as u32],
                    };
                    let key = spec.cache_key();
                    let cached = {
                        let c = self.text_cache.borrow();
                        c.get(&a.id).filter(|(_, k)| *k == key).map(|(tex, _)| tex.clone())
                    };
                    let Some(tex) = cached.or_else(|| match raster.rasterize(&self.gpu, &spec) {
                        Ok(tex) => {
                            self.text_cache.borrow_mut().insert(a.id.clone(), (tex.clone(), key));
                            Some(tex)
                        }
                        Err(e) => {
                            eprintln!("[annotation texte] {}: {e:#}", a.id);
                            None
                        }
                    }) else {
                        continue;
                    };
                    let anim = crate::text_anim::text_animation_state(
                        text.animation.as_deref(),
                        (t - a.start_sec as f32) * 1000.0,
                    );
                    let anim_px = rh / crate::text_anim::ANIMATION_REFERENCE_HEIGHT;
                    let (mut ax, mut ay, mut aw, mut ah) = (
                        dst[0] + anim.translate_x * anim_px / rw,
                        dst[1] + anim.translate_y * anim_px / rh,
                        dst[2],
                        dst[3],
                    );
                    if (anim.scale - 1.0).abs() > 1e-4 {
                        let (cx, cy) = (ax + aw * 0.5, ay + ah * 0.5);
                        aw *= anim.scale;
                        ah *= anim.scale;
                        ax = cx - aw * 0.5;
                        ay = cy - ah * 0.5;
                    }
                    let reveal = anim.reveal.clamp(0.0, 1.0);
                    if reveal <= 0.0 {
                        continue;
                    }
                    enc.set_fragment_texture(2, Some(&tex));
                    self.draw_solid(enc, &LayerCB {
                        dst: [ax, ay, aw * reveal, ah],
                        src: [0.0, 0.0, reveal, 1.0],
                        quad_px: [aw * reveal * rw, ah * rh],
                        mode: 11.0,
                        color: [1.0, 1.0, 1.0, anim.opacity],
                        ..Default::default()
                    });
                }
                _ => {}
            }
        }
        enc.end_encoding();
        Ok(())
    }


    /// Soumet sans attendre, et retient le buffer pour `sync`.
    fn submit(&self, cmd: &metal::CommandBufferRef) {
        cmd.commit();
        *self.last_cmd.borrow_mut() = Some(cmd.to_owned());
    }

    /// Attend la fin de tout ce qui a été soumis. Metal exécute dans l'ordre sur une même
    /// file, donc attendre le DERNIER buffer suffit à garantir les précédents.
    fn sync(&self) {
        if let Some(cmd) = self.last_cmd.borrow().as_ref() {
            cmd.wait_until_completed();
        }
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
        let hotspot = [sprite.hotspot_x, sprite.hotspot_y];
        let cb = match placement {
            crate::frame_geometry::CursorPlacement::Upright { center } => LayerCB {
                dst: crate::frame_geometry::cursor_sprite_dst(center, pw / rw, ph / rh, hotspot),
                src: [0.0, 0.0, 1.0, 1.0],
                mode: 7.0,
                color: [1.0, 1.0, 1.0, a],
                fx: clip,
                ..Default::default()
            },
            crate::frame_geometry::CursorPlacement::Tilted {
                plane_pt, quad, center_px, screen_px, ..
            } => {
                // Le sprite est posé DANS le plan : sa taille devient une fraction du plan et
                // ses quatre coins traversent la même projection que la vidéo. La réduction
                // due au tilt vient donc de la projection — rien à multiplier à la main.
                let (wf, hf) = (pw / screen_px[0], ph / screen_px[1]);
                let x0 = plane_pt[0] - hotspot[0] * wf;
                let y0 = plane_pt[1] - hotspot[1] * hf;
                let corners = [(x0, y0), (x0 + wf, y0), (x0 + wf, y0 + hf), (x0, y0 + hf)]
                    .map(|(fx, fy)| {
                        let (px, py) = quad.point_px(fx, fy);
                        (center_px[0] + px, center_px[1] + py)
                    });
                let (min_x, max_x) = corners
                    .iter()
                    .fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
                let (min_y, max_y) = corners
                    .iter()
                    .fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
                // Le quad projeté d'un sprite peut être très fin de biais : une bbox d'un pixel
                // de large ferait diverger le warp inverse, donc plancher à 1 px.
                let (bw, bh) = ((max_x - min_x).max(1.0), (max_y - min_y).max(1.0));
                let local = |(x, y): (f32, f32)| [x - min_x, y - min_y];
                let [tl0, tl1] = local(corners[0]);
                let [tr0, tr1] = local(corners[1]);
                let [br0, br1] = local(corners[2]);
                let [bl0, bl1] = local(corners[3]);
                LayerCB {
                    dst: [min_x / rw, min_y / rh, bw / rw, bh / rh],
                    quad_px: [bw, bh],
                    mode: 13.0,
                    color: [1.0, 1.0, 1.0, a],
                    fx: [tl0, tl1, tr0, tr1],
                    src_prev: [br0, br1, bl0, bl1],
                    dst_prev: clip,
                    ..Default::default()
                }
            }
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
        // Géométrie du tilt calculée UNE fois : l'ombre et l'écran doivent porter exactement
        // le même quadrilatère, sinon l'ombre se décolle dès que l'un des deux change.
        let tilt = (!crate::regions::is_identity_rotation(g.zoom_rotation))
            .then(|| crate::regions::rotated_quad_corners_px(s_px[0], s_px[1], g.zoom_rotation));
        let quad_center_px = [
            (g.s_dst[0] + g.s_dst[2] * 0.5) * rw,
            (g.s_dst[1] + g.s_dst[3] * 0.5) * rh,
        ];
        if cfg.shadow {
            let spread = SCREEN_SHADOW_SPREAD_FRAC * g.frame_min_px;
            let offset = [0.0, SCREEN_SHADOW_OFFSET_FRAC * g.frame_min_px];
            let opacity = 0.45 * lp.shadow_scale;
            // L'ombre suit la silhouette réellement affichée : rect arrondi quand l'écran est
            // droit, quadrilatère projeté quand il est penché. Un rect droit derrière un écran
            // incliné se lit comme une seconde surface, pas comme son ombre.
            match tilt.as_ref() {
                None => self.draw_shadow(enc, g.s_dst, s_px, g.s_radius, spread, offset, opacity),
                Some(quad) => self.draw_quad_shadow(
                    enc,
                    &quad.corners,
                    quad_center_px,
                    g.s_radius * quad.scale,
                    spread,
                    offset,
                    opacity,
                ),
            }
        }
        let [su0, sv0, su1, sv1] = g.cut;
        match tilt.as_ref() {
            None => self.draw_video(
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
            ),
            Some(quad) => self.draw_tilted_screen(
                enc, quad, s_px, quad_center_px, g.cut, g.s_radius, &sy, &suv,
            ),
        }

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
            let [cu0, cv0, cu1, cv1] = crate::frame_geometry::webcam_source_rect(
                [wcw, wch],
                [wtw as f32, wth as f32],
                scene_ref.as_ref().and_then(|scene| scene.layout.webcam_crop),
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

        // --- annotations : calque le plus haut, ancré sur le rect ÉCRAN SANS ZOOM ---
        // `s_ann`, pas `s_dst` : le zoom vit dans la boîte depuis l'issue #179, donc `s_dst`
        // grandit avec lui et emmenait annotations et sous-titres dans le mouvement.
        self.draw_annotations(cmd_buf, scene_ref.as_ref(), g.source_t, g.s_ann)?;

        // Ni miroir RGBA ni attente ici : le miroir ne sert qu'à `readback_direct` (la
        // preview), et l'export ne lit jamais le RGBA — le blit pleine résolution était payé
        // à chaque frame pour rien.
        self.submit(cmd_buf);
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

        // Ni miroir RGBA ni attente ici : le miroir ne sert qu'à `readback_direct` (la
        // preview), et l'export ne lit jamais le RGBA — le blit pleine résolution était payé
        // à chaque frame pour rien.
        self.submit(cmd_buf);
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
    /// Rend le RT composé en NV12 **directement dans le `CVPixelBuffer` de l'encodeur**.
    ///
    /// `out_tex` est un `CVPixelBufferRef` (celui d'une frame `AV_PIX_FMT_VIDEOTOOLBOX`
    /// tirée du pool de l'encodeur) ; nul = cible interne, chemin de lecture CPU.
    ///
    /// C'est le pendant macOS du zero-copy Windows : au lieu de rendre en interne, relire
    /// 1,4 Mo vers le CPU puis laisser VideoToolbox les ré-uploader, on wrappe les deux
    /// plans du buffer de l'encodeur en `MTLTexture` via le même `CVMetalTextureCache` que
    /// le décodage, et on rend dedans. La frame ne quitte jamais le GPU.
    pub unsafe fn rgb_to_nv12(&self, out_tex: *mut std::ffi::c_void, _slice: u32) -> Result<()> {
        if out_tex.is_null() {
            return self.render_nv12();
        }
        let cache = &self.metal_texture_cache;
        let y = cache.make_texture_from_pixel_buffer(out_tex, 0, metal::MTLPixelFormat::R8Unorm)?;
        let uv = cache.make_texture_from_pixel_buffer(out_tex, 1, metal::MTLPixelFormat::RG8Unorm)?;

        let cmd_buf = self.gpu.context.new_command_buffer();
        for (target, pipeline) in [(&y, &self.pipeline_fs_y), (&uv, &self.pipeline_fs_uv)] {
            let enc = self.begin_pass(
                cmd_buf,
                target,
                Some(metal::MTLClearColor::new(0.0, 0.0, 0.0, 1.0)),
                pipeline,
            )?;
            enc.set_fragment_texture(0, Some(&self.rt));
            enc.draw_primitives(metal::MTLPrimitiveType::Triangle, 0, 3);
            enc.end_encoding();
        }
        // Pas de miroir `Shared`, pas de `getBytes` : c'est tout l'intérêt. On attend
        // quand même, parce que `avcodec_send_frame` va lire ce buffer juste après.
        self.submit(cmd_buf);
        self.sync();
        Ok(())
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

        self.submit(cmd_buf);
        Ok(())
    }

    /// Lit le RT RGBA vers un `Vec<u8>` CPU (preview live). Renvoie `(w, h, RGBA8)`.
    pub unsafe fn readback_direct(&self) -> Result<(u32, u32, Vec<u8>)> {
        // Le miroir `Shared` se fait ICI plutôt qu'à chaque composition : seul ce chemin le
        // lit, et il n'est emprunté que par la preview.
        let cmd_buf = self.gpu.context.new_command_buffer();
        self.mirror_rt(cmd_buf);
        self.submit(cmd_buf);
        self.sync();
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
        // `render_nv12` a soumis sans attendre ; c'est ici, avant la première lecture CPU,
        // que la synchronisation est nécessaire.
        self.sync();
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
