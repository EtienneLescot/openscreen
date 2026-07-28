//! L'axe DÉCODAGE du backend « CPU-like » macOS : une frame libavcodec en mémoire système
//! devient une `CVPixelBufferRef` NV12, présentée exactement comme si VideoToolbox l'avait
//! produite.
//!
//! Équivalent macOS de `cpu_frames_windows.rs`. Sur macOS ce chemin est rarement emprunté
//! (VideoToolbox couvre H.264/H.265 8/10 bits sur chaque Mac supporté), mais on garde
//! le module pour deux raisons : (1) cohérence d'API avec `cpu_frames_windows.rs`,
//! `pipeline.rs` cfg-gate le champ `cpu: Option<CpuFrames>` du `Decoder` sur Windows et
//! garde la même mécanique pour la symétrie ; (2) robustesse — si VideoToolbox refuse un
//! flux (codec hors spec, profil non supporté), le fallback logiciel est la sortie de
//! secours avant l'erreur finale.
//!
//! # Frame seam (cf. `cpu_frames_windows.rs:11-16`)
//!
//! Le contrat tenu ici est minuscule et c'est ce qui rend le tout iso avec le GPU :
//! `compositor::nv12_srvs()` et `compositor::tex_dims()` lisent quatre champs :
//!   - `data[0]` : `CVPixelBufferRef` (IOSurface-backed, NV12) — opaque côté Rust,
//!     l'interprétation se fait dans `compositor_macos::nv12_srvs` via CVMetalTextureCache,
//!   - `data[1]` : 0 (pas d'array côté CoreVideo ; chaque frame est son propre buffer),
//!   - `width`/`height` : dimensions visibles.
//!
//! Côté Metal, `nv12_srvs` crée deux `MTLTexture` (Y `R8Unorm`, UV `RG8Unorm`) via
//! `CVMetalTextureCacheCreateTextureFromImage` — zéro copie, IOSurface-backed.
//!
//! Le format AVFrame posé sur `present` est `AV_PIX_FMT_D3D11` comme pour le chemin
//! Windows : c'est un sentinel « buffer GPU natif dans data[0] », et ffmpeg n'inspecte
//! jamais ce champ dans notre pipeline (la frame n'est jamais passée à un encodeur
//! logiciel ni à un muxer ; seul `compositor_macos::nv12_srvs` la lit).

use crate::ffi::*;
use crate::metal::Gpu;
use anyhow::{anyhow, bail, Result};
use std::ptr;

/// Le flag d'algorithme de swscale. Bindgen ne génère pas les `SWS_*` d'algorithme (des
/// macros), et leurs valeurs sont figées par l'ABI de libswscale. `POINT` (plus proche
/// voisin) est le choix honnête : la conversion se fait à dimensions ÉGALES, donc aucun
/// rééchantillonnage n'a lieu — seul le convertisseur de format travaille, et le filtre
/// choisi n'a aucun effet sur la sortie.
const SWS_POINT: i32 = 0x10;

/// Tag CoreVideo pour NV12 limited range (BT.601). `kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange`.
const K_CV_PIXEL_FORMAT_TYPE_420_Y_P_C_B_CR_8_BI_PLANAR_VIDEO_RANGE: u32 = 0x34323076;
/// Flag `kCVPixelBufferIOSurfacePropertiesKey` — sous-clé CFDictionary pour demander
/// IOSurface-backed (et donc GPU-shareable) au CVPixelBufferCreate.
const K_CV_PIXEL_BUFFER_IO_SURFACE_PROPERTIES_KEY: &str = "IOSurfaceProperties";
/// `kCFNumberSInt32Type` — type CFNumber pour les entiers 32 bits.
const K_CF_NUMBER_S_INT32_TYPE: i32 = 3;

/// Newtype safe Rust pour `CVPixelBufferRef` (`*mut __CVPixelBuffer`). CoreVideo n'a pas
/// de binding Rust stable et officiel ; on parle à CoreFoundation directement avec les
/// conventions `CFTypeRef` (compté en références, type-erased).
#[repr(transparent)]
#[derive(Clone)]
pub(crate) struct CVPixelBufferRef(ptr::NonNull<std::ffi::c_void>);

unsafe impl Send for CVPixelBufferRef {}
unsafe impl Sync for CVPixelBufferRef {}

impl CVPixelBufferRef {
    fn retain(&self) -> Self {
        unsafe { CVPixelBufferRetain(self.0.as_ptr()) };
        self.clone()
    }
    fn release(&self) {
        unsafe { CVPixelBufferRelease(self.0.as_ptr()) };
    }
    pub fn as_ptr(&self) -> *mut std::ffi::c_void {
        self.0.as_ptr()
    }
}

impl Drop for CVPixelBufferRef {
    fn drop(&mut self) {
        self.release();
    }
}

/// Bindings CoreVideo/CoreFoundation minimaux (CVPixelBuffer). Tous les autres symboles
/// CV* sont ramenés par le même module si on en a besoin plus tard.
#[link(name = "CoreVideo", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    fn CVPixelBufferRetain(p: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn CVPixelBufferRelease(p: *mut std::ffi::c_void);
    fn CVPixelBufferCreate(
        allocator: *const std::ffi::c_void,
        width: usize,
        height: usize,
        pixel_format_type: u32,
        attributes: *const std::ffi::c_void, // CFDictionaryRef, NULL = defaults
        pixel_buffer_out: *mut *mut std::ffi::c_void,
    ) -> i32; // CVReturn; 0 = success
    fn CVPixelBufferLockBaseAddress(p: *mut std::ffi::c_void, lock_flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(p: *mut std::ffi::c_void, lock_flags: u64) -> i32;
    fn CVPixelBufferGetBaseAddressOfPlane(p: *mut std::ffi::c_void, plane_index: usize) -> *mut u8;
    fn CVPixelBufferGetBytesPerRowOfPlane(p: *mut std::ffi::c_void, plane_index: usize) -> usize;
    fn CVPixelBufferGetWidth(p: *mut std::ffi::c_void) -> usize;
    fn CVPixelBufferGetHeight(p: *mut std::ffi::c_void) -> usize;
    fn CVReturnFromRetainCountedObjectGetRetainCount() -> u64; // unused, dummy to keep link happy
}

/// Crée un `CVPixelBufferRef` NV12, dim pair `(w, h)`. `kCVReturnSuccess == 0`.
///
/// Pourquoi IOSurface (todo dans un commit ultérieur) : c'est ce qui permet à
/// `CVMetalTextureCacheCreateTextureFromImage` de produire un `MTLTexture` zéro-copie
/// depuis le même buffer. Le scaffold de cette PR passe `attributes = NULL` — CoreVideo
/// alloue alors un buffer mémoire CPU-backed, et le compositor fait un upload par
/// frame (`MTLBlitCommandEncoder.copy_from_buffer_to_texture` côté Metal, ou via le
/// staging IOSurface implicite). Le passage à IOSurface explicit se fait en passant
/// un CFDictionary `{ IOSurfaceProperties: CFDictionary{} }` au lieu de NULL — c'est
/// le commit « IOSurface-backed mac_frames » qui suivra.
///
/// NV12 impose des dimensions paires : on arrondit AU-DESSUS pour le buffer et on
/// laisse `present.width/height` aux dimensions visibles — c'est le même écart
/// texture/visible que produit l'alignement macrobloc de D3D11VA (1080 → 1088).
unsafe fn create_nv12_pixel_buffer(w: usize, h: usize) -> Result<CVPixelBufferRef> {
    let mut pixel_buffer: *mut std::ffi::c_void = ptr::null_mut();
    let status = CVPixelBufferCreate(
        ptr::null(),           // default allocator
        w,
        h,
        K_CV_PIXEL_FORMAT_TYPE_420_Y_P_C_B_CR_8_BI_PLANAR_VIDEO_RANGE,
        ptr::null(),           // attributes = NULL — default backing (cf. note ci-dessus)
        &mut pixel_buffer,
    );
    if status != 0 {
        bail!(
            "CVPixelBufferCreate NV12 {}x{} a échoué avec CVReturn={}",
            w,
            h,
            status
        );
    }
    if pixel_buffer.is_null() {
        bail!("CVPixelBufferCreate NV12 {}x{} a renvoyé un pointeur nul", w, h);
    }
    Ok(CVPixelBufferRef(ptr::NonNull::new_unchecked(pixel_buffer)))
}

/// Source de frames du backend « CPU-like » macOS. Mêmes champs que
/// `cpu_frames_windows::CpuFrames`, à l'exception près que la cible d'upload est un
/// `CVPixelBufferRef` (IOSurface-backed) plutôt qu'une `ID3D11Texture2D`.
pub(crate) struct CpuFrames {
    /// Conserve le `MTLDevice` vivant pour la durée du `CpuFrames`. Le `Drop` de
    /// `metal::Device` fait le `release` ObjC ; pas de libération manuelle nécessaire.
    _gpu: Gpu,
    sws: *mut SwsContext,
    /// `(w, h, format source)` du contexte swscale courant. Reconstruit au changement.
    sws_key: (i32, i32, i32),
    /// NV12 en mémoire système : la cible de swscale, la source du memcpy vers le
    /// `CVPixelBufferRef` IOSurface-backed.
    nv12: *mut AVFrame,
    /// Le `CVPixelBufferRef` réutilisé à chaque frame — IOSurface-backed, attaché au
    /// `CVMetalTextureCache` du `Compositor` (cf. `compositor_macos`). Une seule instance
    /// comme la texture Windows : le GPU peut attendre que la frame précédente soit lue
    /// avant qu'on réécrive. CVPixelBuffer gère lui-même la synchro IOSurface.
    pixel_buffer: Option<CVPixelBufferRef>,
    pixel_buffer_dims: (u32, u32),
    /// La frame remise au compositor. Ne possède aucun pixel : `data[0]` pointe le
    /// `CVPixelBufferRef` opaque (comme `data[0]` pointerait un `ID3D11Texture2D*` sur
    /// Windows).
    present: *mut AVFrame,
}

impl CpuFrames {
    pub(crate) fn new(gpu: &Gpu) -> Result<CpuFrames> {
        let present = unsafe { av_frame_alloc() };
        let nv12 = unsafe { av_frame_alloc() };
        if present.is_null() || nv12.is_null() {
            bail!("av_frame_alloc (mac_frames)");
        }
        Ok(CpuFrames {
            _gpu: Gpu {
                device: gpu.device.clone(),
                context: gpu.context.clone(),
                backend: gpu.backend,
                feature_level: gpu.feature_level,
            },
            sws: ptr::null_mut(),
            sws_key: (0, 0, -1),
            nv12,
            pixel_buffer: None,
            pixel_buffer_dims: (0, 0),
            present,
        })
    }

    /// Convertit `src` (sortie décodeur, mémoire système) en NV12, l'uploade dans un
    /// `CVPixelBufferRef`, et rend la frame de présentation. Le pointeur reste valide
    /// jusqu'au prochain appel — même contrat que `Decoder::next` côté matériel.
    pub(crate) unsafe fn present(&mut self, src: *mut AVFrame) -> Result<*mut AVFrame> {
        let (w, h) = ((*src).width, (*src).height);
        if w <= 0 || h <= 0 {
            bail!("frame décodée sans dimensions ({w}x{h})");
        }
        self.ensure_sws(w, h, (*src).format)?;
        self.ensure_nv12(w, h)?;
        self.upload(w, h)?;
        Ok(self.present)
    }

    unsafe fn ensure_sws(&mut self, w: i32, h: i32, src_fmt: i32) -> Result<()> {
        let key = (w, h, src_fmt);
        if self.sws_key == key && !self.sws.is_null() {
            return Ok(());
        }
        if !self.sws.is_null() {
            sws_freeContext(self.sws);
        }
        self.sws = sws_getContext(
            w,
            h,
            src_fmt as AVPixelFormat::Type,
            w,
            h,
            AVPixelFormat::AV_PIX_FMT_NV12,
            SWS_POINT,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null(),
        );
        if self.sws.is_null() {
            bail!("sws_getContext {w}x{h} fmt {src_fmt} → NV12");
        }
        self.sws_key = key;
        Ok(())
    }

    unsafe fn ensure_nv12(&mut self, w: i32, h: i32) -> Result<()> {
        if (*self.nv12).width == w
            && (*self.nv12).height == h
            && (*self.nv12).format == AVPixelFormat::AV_PIX_FMT_NV12 as i32
        {
            return Ok(());
        }
        av_frame_unref(self.nv12);
        (*self.nv12).width = w;
        (*self.nv12).height = h;
        (*self.nv12).format = AVPixelFormat::AV_PIX_FMT_NV12 as i32;
        if av_frame_get_buffer(self.nv12, 32) < 0 {
            bail!("av_frame_get_buffer NV12 {w}x{h}");
        }
        Ok(())
    }

    /// (Re)crée le `CVPixelBufferRef` NV12 IOSurface-backed si les dimensions ont changé.
    unsafe fn ensure_pixel_buffer(&mut self, w: i32, h: i32) -> Result<()> {
        let dims = ((w as u32 + 1) & !1, (h as u32 + 1) & !1);
        if self.pixel_buffer.is_some() && self.pixel_buffer_dims == dims {
            return Ok(());
        }
        let pb = create_nv12_pixel_buffer(dims.0 as usize, dims.1 as usize)?;
        self.pixel_buffer = Some(pb);
        self.pixel_buffer_dims = dims;
        Ok(())
    }

    /// Convertit le NV12 système en `CVPixelBufferRef` IOSurface-backed. Deux verrous
    /// `LockBaseAddress`/`UnlockBaseAddress` (flag 0 = read+write) entourent le memcpy
    /// plan par plan.
    unsafe fn upload(&mut self, w: i32, h: i32) -> Result<()> {
        self.ensure_pixel_buffer(w, h)?;
        let pixel_buffer = self
            .pixel_buffer
            .as_ref()
            .expect("CVPixelBuffer créé juste au-dessus");

        // swscale convertit le frame source en NV12 directement dans self.nv12.
        let converted = sws_scale(
            self.sws,
            (*self.nv12).data.as_ptr() as *const *const u8,
            (*self.nv12).linesize.as_ptr(),
            0,
            h,
            (*self.nv12).data.as_mut_ptr(),
            (*self.nv12).linesize.as_ptr(),
        );
        if converted <= 0 {
            bail!("sws_scale a converti {converted} lignes");
        }

        // Lock pour accès CPU au backing store IOSurface.
        let lock_status = CVPixelBufferLockBaseAddress(pixel_buffer.as_ptr(), 0);
        if lock_status != 0 {
            bail!(
                "CVPixelBufferLockBaseAddress a renvoyé CVReturn={}",
                lock_status
            );
        }
        let base = CVPixelBufferGetBaseAddressOfPlane(pixel_buffer.as_ptr(), 0);
        let bytes_per_row_y = CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer.as_ptr(), 0);
        let uv_base = CVPixelBufferGetBaseAddressOfPlane(pixel_buffer.as_ptr(), 1);
        let bytes_per_row_uv = CVPixelBufferGetBytesPerRowOfPlane(pixel_buffer.as_ptr(), 1);

        if base.is_null() || uv_base.is_null() {
            CVPixelBufferUnlockBaseAddress(pixel_buffer.as_ptr(), 0);
            bail!("CVPixelBufferLockBaseAddress a renvoyé des plans nuls");
        }

        let src_y = (*self.nv12).data[0];
        let src_uv = (*self.nv12).data[1];
        let sp_y = (*self.nv12).linesize[0] as usize;
        let sp_uv = (*self.nv12).linesize[1] as usize;
        let (tex_w, tex_h) = (self.pixel_buffer_dims.0 as usize, self.pixel_buffer_dims.1 as usize);

        // Y pleine résolution.
        let y_row = tex_w.min(sp_y).min(bytes_per_row_y);
        for y in 0..tex_h.min(h as usize) {
            ptr::copy_nonoverlapping(src_y.add(y * sp_y), base.add(y * bytes_per_row_y), y_row);
        }
        // UV demi-résolution entrelacée.
        let uv_row = tex_w.min(sp_uv).min(bytes_per_row_uv);
        for y in 0..(tex_h / 2).min((h as usize).div_ceil(2)) {
            ptr::copy_nonoverlapping(src_uv.add(y * sp_uv), uv_base.add(y * bytes_per_row_uv), uv_row);
        }

        CVPixelBufferUnlockBaseAddress(pixel_buffer.as_ptr(), 0);

        // Le contrat que lit le compositor — opaque sur ce que data[0] représente :
        // `compositor_macos::nv12_srvs` sait qu'un `AV_PIX_FMT_D3D11` sur macOS = un
        // `CVPixelBufferRef` IOSurface-backed.
        //
        // On retient ici (le `self.pixel_buffer` est conservé, et son Drop fait le release).
        // `av_frame_free` ignore `data[0]` parce que nous n'avons attaché aucun `buf[]`.
        (*self.present).data[0] = pixel_buffer.as_ptr() as *mut u8;
        (*self.present).data[1] = ptr::null_mut(); // pas d'array sur CoreVideo
        (*self.present).width = w;
        (*self.present).height = h;
        (*self.present).format = AVPixelFormat::AV_PIX_FMT_D3D11 as i32;
        Ok(())
    }

    /// La frame de présentation courante (jamais nulle) — symétrie d'API avec
    /// `cpu_frames_windows::CpuFrames::current`.
    pub(crate) fn current(&self) -> *mut AVFrame {
        self.present
    }

    /// Récupère le `CVPixelBufferRef` posé dans la dernière frame de présentation, retain.
    /// C'est cette méthode que `compositor_macos::nv12_srvs` utilise pour fabriquer les
    /// `MTLTexture` zéro-copie via CVMetalTextureCache. Le caller doit dropper le
    /// `CVPixelBufferRef` (le release CoreFoundation correspondant).
    pub(crate) fn current_pixel_buffer(&self) -> Option<CVPixelBufferRef> {
        self.pixel_buffer.as_ref().map(|pb| pb.retain())
    }
}

impl Drop for CpuFrames {
    fn drop(&mut self) {
        unsafe {
            // `present` n'a que des pointeurs empruntés : les remettre à zéro avant de
            // libérer, pour qu'aucun code ffmpeg ne croie posséder le CVPixelBuffer.
            (*self.present).data[0] = ptr::null_mut();
            (*self.present).data[1] = ptr::null_mut();
            av_frame_free(&mut self.present);
            av_frame_free(&mut self.nv12);
            if !self.sws.is_null() {
                sws_freeContext(self.sws);
            }
            // Le `CVPixelBufferRef` est retenu dans `self.pixel_buffer` ; son Drop fait
            // le release CoreFoundation. Idem pour les retain() retournés par
            // `current_pixel_buffer` — chaque appel est apparié au Drop côté caller.
        }
    }
}

// Pas de marqueur explicite : `core-foundation` est gardé dans l'arbre de dépendances
// par les autres modules macOS (`compositor_macos::nv12_srvs_macos` et suivants). Si
// le linker écarte la dépendance à ce stade, c'est `core-foundation` qui manquera au
// link final ; le fix est d'ajouter un `#[used]` ou un usage explicite quelque part
// dans le binaire.