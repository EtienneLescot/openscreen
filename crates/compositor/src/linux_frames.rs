//! L'axe DECODAGE du backend « CPU-like » Linux : une frame libavcodec en
//! memoire systeme devient deux textures wgpu NV12-split (Y `R8Unorm`, UV
//! entrelacee `Rg8Unorm`), presentees exactement comme si un decodeur materiel
//! les avait produites.
//!
//! Equivalent Linux de `cpu_frames_windows.rs` / `mac_frames.rs`. Meme contrat
//! de « frame seam » (cf. `mac_frames.rs:12-19`) : `compositor::nv12_srvs()`
//! lit quatre champs de l'AVFrame presentee —
//!   - `data[0]` : un carrier `Box<VkFrameTex>` (les deux textures wgpu),
//!     opaque cote Rust, relu par `compositor_linux::nv12_srvs`,
//!   - `data[1]` : 0 (pas d'array),
//!   - `width`/`height` : dimensions visibles.
//! `format` est pose a `AV_PIX_FMT_D3D11` comme sur Windows/macOS : un sentinel
//! « buffer GPU natif dans data[0] », jamais inspecte par ffmpeg dans ce pipeline.
//!
//! # Difference avec D3D11/Metal
//!
//! D3D11 a un format NV12 natif (une texture, deux sous-ressources) ; macOS a
//! le CVPixelBuffer IOSurface (zero-copy via CVMetalTextureCache). Vulkan/wgpu
//! n'a pas de format NV12 portable, donc on le decompose en DEUX textures
//! (Y + UV) uploadees par `write_texture`. Le shader WGSL echantillonne les deux
//! et fait le YUV->RGB (cf. `vk_shaders/layer.wgsl`).

use anyhow::{bail, Result};
use std::ptr;

use crate::d3d::Gpu;
use crate::ffi::{
    av_frame_alloc, av_frame_free, av_frame_get_buffer, av_frame_unref, sws_freeContext,
    sws_getContext, sws_scale, AVFrame, AVPixelFormat, SwsContext,
};

/// `SWS_POINT` (plus proche voisin) : la conversion se fait a dimensions EGALES,
/// aucun reechantillonnage. Valeur figee par l'ABI de libswscale (bindgen ne
/// genere pas les `SWS_*`, ce sont des macros).
const SWS_POINT: i32 = 0x10;

/// Une frame decodee presentee au compositor sous forme de deux textures wgpu :
/// plane Y (`R8Unorm`, `w x h`) et plane UV entrelacee (`Rg8Unorm`,
/// `(w/2) x (h/2)`). Equivalent NV12-split de la `ID3D11Texture2D` NV12 (D3D11)
/// / du CVPixelBuffer (macOS).
pub(crate) struct VkFrameTex {
    pub y: wgpu::Texture,
    pub uv: wgpu::Texture,
    pub width: u32,
    pub height: u32,
}

#[inline]
fn pack_carrier(tex: Box<VkFrameTex>) -> *mut u8 {
    Box::into_raw(tex) as *mut u8
}

#[inline]
unsafe fn unpack_carrier<'a>(p: *const u8) -> &'a VkFrameTex {
    debug_assert!(!p.is_null());
    &*(p as *const VkFrameTex)
}

/// Source de frames du backend « CPU-like » Linux. Meme surface que
/// `mac_frames::CpuFrames` (`new` / `present` / `current`) : `pipeline` garde la
/// meme mecanique. Allocation unique de textures reecrites a chaque frame.
pub(crate) struct CpuFrames {
    device: wgpu::Device,
    queue: wgpu::Queue,
    sws: *mut SwsContext,
    /// `(w, h, format source)` du contexte swscale courant.
    sws_key: (i32, i32, i32),
    /// NV12 en memoire systeme : cible de swscale, source de l'upload.
    nv12: *mut AVFrame,
    tex: Option<Box<VkFrameTex>>,
    tex_dims: (u32, u32),
    /// La frame remise au compositor. Ne possede aucun pixel : `data[0]` pointe
    /// le carrier `VkFrameTex`.
    present: *mut AVFrame,
}

impl CpuFrames {
    pub(crate) fn new(gpu: &Gpu) -> Result<CpuFrames> {
        let present = unsafe { av_frame_alloc() };
        let nv12 = unsafe { av_frame_alloc() };
        if present.is_null() || nv12.is_null() {
            bail!("av_frame_alloc (linux_frames)");
        }
        Ok(CpuFrames {
            device: gpu.device.clone(),
            queue: gpu.context.clone(),
            sws: ptr::null_mut(),
            sws_key: (0, 0, -1),
            nv12,
            tex: None,
            tex_dims: (0, 0),
            present,
        })
    }

    /// Convertit `src` (sortie decodeur, memoire systeme) en NV12, l'uploade dans
    /// les textures wgpu, et rend la frame de presentation dont `data[0]` est un
    /// carrier `Box<VkFrameTex>`. Le pointeur reste valide jusqu'au prochain
    /// `present()` — meme contrat que `mac_frames::present`.
    pub(crate) unsafe fn present(&mut self, src: *mut AVFrame) -> Result<*mut AVFrame> {
        if src.is_null() {
            bail!("linux_frames::present: frame source nulle");
        }
        let w = (*src).width;
        let h = (*src).height;
        if w <= 0 || h <= 0 {
            bail!("frame decodee sans dimensions ({w}x{h})");
        }
        self.ensure_sws(w, h, (*src).format)?;
        self.ensure_nv12(w, h)?;
        self.ensure_textures(w as u32, h as u32)?;

        let converted = sws_scale(
            self.sws,
            (*src).data.as_ptr() as *const *const u8,
            (*src).linesize.as_ptr(),
            0,
            h,
            (*self.nv12).data.as_ptr(),
            (*self.nv12).linesize.as_ptr(),
        );
        if converted <= 0 {
            bail!("sws_scale a converti {converted} lignes");
        }

        self.upload()?;
        self.attach_carrier(w, h)?;
        // Contrat lu par le compositor : sentinel + timestamps recopies (sinon la
        // timeline se croit a t=0).
        (*self.present).format = AVPixelFormat::AV_PIX_FMT_D3D11 as i32;
        (*self.present).pts = (*src).pts;
        (*self.present).best_effort_timestamp = (*src).best_effort_timestamp;
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
            bail!("sws_getContext {w}x{h} fmt {src_fmt} -> NV12");
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

    fn ensure_textures(&mut self, w: u32, h: u32) -> Result<()> {
        // NV12 impose des dimensions paires pour le chroma : arrondi au-dessus pour
        // les textures, `present.width/height` reste aux dimensions visibles (meme
        // ecart texture/visible que l'alignement macrobloc D3D11VA, 1080 -> 1088).
        let dims = ((w + 1) & !1, (h + 1) & !1);
        if let Some(tex) = &self.tex {
            if tex.width == dims.0 && tex.height == dims.1 {
                return Ok(());
            }
        }
        let y = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("nv12-y"),
            size: wgpu::Extent3d {
                width: dims.0,
                height: dims.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let uv = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("nv12-uv"),
            size: wgpu::Extent3d {
                width: dims.0 / 2,
                height: dims.1 / 2,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rg8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.tex = Some(Box::new(VkFrameTex {
            y,
            uv,
            width: dims.0,
            height: dims.1,
        }));
        self.tex_dims = dims;
        Ok(())
    }

    /// Upload du NV12 swscale dans les deux textures wgpu. `linesize[0]/[1]` sont
    /// les strides memoire (paddes SIMD par swscale), passes tels quels a
    /// `bytes_per_row`.
    unsafe fn upload(&mut self) -> Result<()> {
        let tex = match self.tex.as_ref() {
            Some(t) => t,
            None => bail!("upload avant ensure_textures"),
        };
        let y_stride = (*self.nv12).linesize[0] as usize;
        let uv_stride = (*self.nv12).linesize[1] as usize;
        let y_size = y_stride * tex.height as usize;
        let uv_size = uv_stride * tex.height.div_ceil(2) as usize;
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &tex.y,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            std::slice::from_raw_parts((*self.nv12).data[0], y_size),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(y_stride as u32),
                rows_per_image: Some(tex.height),
            },
            wgpu::Extent3d {
                width: tex.width,
                height: tex.height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &tex.uv,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            std::slice::from_raw_parts((*self.nv12).data[1], uv_size),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(uv_stride as u32),
                rows_per_image: Some(tex.height / 2),
            },
            wgpu::Extent3d {
                width: tex.width / 2,
                height: tex.height / 2,
                depth_or_array_layers: 1,
            },
        );
        Ok(())
    }

    /// Attache le carrier `Box<VkFrameTex>` a `present.data[0]` et fixe les
    /// dimensions visibles (avant padding pair).
    unsafe fn attach_carrier(&mut self, w: i32, h: i32) -> Result<()> {
        let tex = match self.tex.as_ref() {
            Some(t) => t,
            None => bail!("attach_carrier avant ensure_textures"),
        };
        // Libere un carrier precedent eventuel avant de le remplacer.
        if !(*self.present).data[0].is_null() {
            let _ = Box::from_raw((*self.present).data[0] as *mut VkFrameTex);
        }
        (*self.present).data[0] = pack_carrier(Box::new(VkFrameTex {
            y: tex.y.clone(),
            uv: tex.uv.clone(),
            width: tex.width,
            height: tex.height,
        }));
        (*self.present).data[1] = ptr::null_mut();
        (*self.present).width = w;
        (*self.present).height = h;
        Ok(())
    }

    /// La frame de presentation courante (jamais nulle) — symetrie d'API avec
    /// `mac_frames::CpuFrames::current`.
    pub(crate) fn current(&self) -> *mut AVFrame {
        self.present
    }
}

/// Dimensions (texture, padded pair) du carrier `frame.data[0]`. `(1, 1)` si nul.
pub(crate) unsafe fn carrier_dims(frame: *const AVFrame) -> (u32, u32) {
    if (*frame).data[0].is_null() {
        return (1, 1);
    }
    let tex = unpack_carrier((*frame).data[0]);
    (tex.width, tex.height)
}

/// Equivalent Linux de `nv12_srvs` : retourne les deux `TextureView` samplables
/// depuis le carrier `frame.data[0]`. Appele par `compositor_linux`.
pub(crate) unsafe fn nv12_planes(
    frame: *const AVFrame,
) -> Result<(wgpu::TextureView, wgpu::TextureView)> {
    if (*frame).data[0].is_null() {
        bail!("nv12_planes: carrier nul dans data[0]");
    }
    let tex = unpack_carrier((*frame).data[0]);
    Ok((
        tex.y.create_view(&wgpu::TextureViewDescriptor::default()),
        tex.uv.create_view(&wgpu::TextureViewDescriptor::default()),
    ))
}

impl Drop for CpuFrames {
    fn drop(&mut self) {
        unsafe {
            if !self.sws.is_null() {
                sws_freeContext(self.sws);
            }
            if !(*self.present).data[0].is_null() {
                let _ = Box::from_raw((*self.present).data[0] as *mut VkFrameTex);
                (*self.present).data[0] = ptr::null_mut();
            }
            av_frame_free(&mut self.present);
            av_frame_free(&mut self.nv12);
        }
    }
}
