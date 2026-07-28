//! L'axe DÉCODAGE du backend CPU : une frame libavcodec en mémoire système devient une
//! texture NV12 D3D11, présentée exactement comme si D3D11VA l'avait produite.
//!
//! Pourquoi ce fichier existe séparément : le rendu et le décodage sont deux axes
//! indépendants (voir `d3d::Backend`). WARP couvre le premier et *rien* du second — aucun
//! rastériseur logiciel, sur aucune plateforme, ne décode de la vidéo. Le repli logiciel
//! demandait donc cette pièce-ci en plus, et c'est elle (avec `d3d.rs`) qu'un portage
//! Metal/Vulkan réécrit. `compositor.rs`, les shaders HLSL et le contrat de scène ne
//! bougent pas d'un octet.
//!
//! Le contrat tenu ici est minuscule et c'est ce qui rend le tout iso. Tout ce que le
//! compositeur lit d'une frame, c'est (`compositor::nv12_srvs` / `compositor::tex_dims`) :
//!   - `data[0]` : un `ID3D11Texture2D*` NV12,
//!   - `data[1]` : l'index de tranche d'array,
//!   - `width`/`height` : les dimensions VISIBLES dans cette texture.
//! On remplit ces quatre champs et rien d'autre change.

use crate::ffi::*;
use anyhow::{bail, Result};
use std::ptr;
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11 as d3d11;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};

/// Le flag d'algorithme de swscale. Bindgen ne génère pas les `SWS_*` d'algorithme (des
/// macros), et leurs valeurs sont figées par l'ABI de libswscale. `POINT` (plus proche
/// voisin) est le choix honnête : la conversion se fait à dimensions ÉGALES, donc aucun
/// rééchantillonnage n'a lieu — seul le convertisseur de format travaille, et le filtre
/// choisi n'a aucun effet sur la sortie.
const SWS_POINT: i32 = 0x10;

/// Source de frames du backend CPU, attachée à un `Decoder` quand `Backend::Cpu`.
pub(crate) struct CpuFrames {
    dev: d3d11::ID3D11Device,
    ctx: d3d11::ID3D11DeviceContext,
    sws: *mut SwsContext,
    /// `(w, h, format source)` du contexte swscale courant. Un flux qui change de
    /// résolution en cours de route (rare mais légal) le reconstruit au lieu de
    /// convertir de travers.
    sws_key: (i32, i32, i32),
    /// NV12 en mémoire système : la cible de swscale, la source de l'upload.
    nv12: *mut AVFrame,
    /// La texture NV12 échantillonnée par les shaders. UNE seule, réécrite à chaque
    /// frame — le `srv_cache` du compositeur (clé `(ptr, slice)`) n'a donc qu'une entrée
    /// et ne recrée jamais de SRV, contrairement au pool tournant de D3D11VA.
    // ponytail: une seule texture = le CPU peut attendre que le GPU ait fini de lire la
    // frame précédente. Sur WARP tout est CPU et le pilote sérialise déjà ; si un backend
    // GPU réutilise ce chemin un jour et que le Map bloque, double-bufferiser ici.
    tex: Option<d3d11::ID3D11Texture2D>,
    tex_dims: (u32, u32),
    /// La frame remise au compositeur. Ne possède aucun pixel : ses `data[0]`/`data[1]`
    /// pointent la texture ci-dessus, exactement comme une frame `AV_PIX_FMT_D3D11`.
    present: *mut AVFrame,
}

impl CpuFrames {
    pub(crate) fn new(gpu: &crate::d3d::Gpu) -> Result<CpuFrames> {
        let present = unsafe { av_frame_alloc() };
        let nv12 = unsafe { av_frame_alloc() };
        if present.is_null() || nv12.is_null() {
            bail!("av_frame_alloc (backend CPU)");
        }
        Ok(CpuFrames {
            dev: gpu.device.clone(),
            ctx: gpu.context.clone(),
            sws: ptr::null_mut(),
            sws_key: (0, 0, -1),
            nv12,
            tex: None,
            tex_dims: (0, 0),
            present,
        })
    }

    /// Convertit `src` (sortie décodeur, mémoire système) en NV12, l'uploade, et rend la
    /// frame de présentation. Le pointeur reste valide jusqu'au prochain appel — même
    /// contrat que `Decoder::next` côté matériel.
    pub(crate) unsafe fn present(&mut self, src: *mut AVFrame) -> Result<*mut AVFrame> {
        let (w, h) = ((*src).width, (*src).height);
        if w <= 0 || h <= 0 {
            bail!("frame décodée sans dimensions ({w}x{h})");
        }
        self.ensure_sws(w, h, (*src).format)?;
        self.ensure_nv12(w, h)?;

        // Les plans NV12 de destination sont ceux de `self.nv12` : swscale écrit
        // directement au bon format, on n'entrelace rien à la main (10 bits, 4:2:2 et
        // consorts passent donc aussi, là où une boucle écrite ici casserait en silence).
        let converted = sws_scale(
            self.sws,
            (*src).data.as_ptr() as *const *const u8,
            (*src).linesize.as_ptr(),
            0,
            h,
            (*self.nv12).data.as_mut_ptr(),
            (*self.nv12).linesize.as_ptr(),
        );
        if converted <= 0 {
            bail!("sws_scale a converti {converted} lignes");
        }

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

    /// (Re)crée la texture NV12 si les dimensions ont changé. NV12 impose des dimensions
    /// paires : on arrondit AU-DESSUS pour la texture et on laisse `present.width/height`
    /// aux dimensions visibles — c'est le même écart texture/visible que produit
    /// l'alignement macrobloc de D3D11VA (1080 → 1088), et le compositeur le gère déjà.
    unsafe fn ensure_tex(&mut self, w: i32, h: i32) -> Result<()> {
        let dims = ((w as u32 + 1) & !1, (h as u32 + 1) & !1);
        if self.tex.is_some() && self.tex_dims == dims {
            return Ok(());
        }
        let desc = d3d11::D3D11_TEXTURE2D_DESC {
            Width: dims.0,
            Height: dims.1,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: d3d11::D3D11_USAGE_DYNAMIC,
            BindFlags: d3d11::D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: d3d11::D3D11_CPU_ACCESS_WRITE.0 as u32,
            MiscFlags: 0,
        };
        let mut tex: Option<d3d11::ID3D11Texture2D> = None;
        self.dev.CreateTexture2D(&desc, None, Some(&mut tex))?;
        self.tex = Some(tex.ok_or_else(|| anyhow::anyhow!("CreateTexture2D NV12 sans texture"))?);
        self.tex_dims = dims;
        Ok(())
    }

    /// Copie le NV12 système dans la texture. `Map(WRITE_DISCARD)` rend UN pointeur pour
    /// les deux plans : Y sur `tex_h` lignes de `RowPitch`, puis UV sur `tex_h/2` lignes
    /// au même pitch — c'est la disposition NV12 mappée que documente D3D11.
    unsafe fn upload(&mut self, w: i32, h: i32) -> Result<()> {
        self.ensure_tex(w, h)?;
        let tex = self.tex.clone().expect("texture créée juste au-dessus");
        let resource: d3d11::ID3D11Resource = tex.cast()?;

        let mut mapped = d3d11::D3D11_MAPPED_SUBRESOURCE::default();
        self.ctx.Map(&resource, 0, d3d11::D3D11_MAP_WRITE_DISCARD, 0, Some(&mut mapped))?;

        let dst = mapped.pData as *mut u8;
        let pitch = mapped.RowPitch as usize;
        let (tex_w, tex_h) = (self.tex_dims.0 as usize, self.tex_dims.1 as usize);
        let src_y = (*self.nv12).data[0];
        let src_uv = (*self.nv12).data[1];
        let sp_y = (*self.nv12).linesize[0] as usize;
        let sp_uv = (*self.nv12).linesize[1] as usize;
        // Ne copier que ce qui existe des deux côtés : la texture est arrondie au pair et
        // les lignes de swscale sont paddées à leur propre alignement SIMD.
        let row = tex_w.min(sp_y).min(pitch);
        for y in 0..tex_h.min(h as usize) {
            ptr::copy_nonoverlapping(src_y.add(y * sp_y), dst.add(y * pitch), row);
        }
        let uv_base = dst.add(pitch * tex_h);
        let uv_row = tex_w.min(sp_uv).min(pitch);
        for y in 0..(tex_h / 2).min((h as usize).div_ceil(2)) {
            ptr::copy_nonoverlapping(src_uv.add(y * sp_uv), uv_base.add(y * pitch), uv_row);
        }

        self.ctx.Unmap(&resource, 0);

        // Le contrat que lit le compositeur, et rien de plus : texture, tranche, visible.
        // `data` n'est adossé à aucun `buf[]`, donc `av_frame_free` ne libérera jamais la
        // texture — c'est nous qui la possédons, via `self.tex`.
        (*self.present).data[0] = tex.as_raw() as *mut u8;
        (*self.present).data[1] = ptr::null_mut(); // tranche 0 : notre texture n'est pas un array
        (*self.present).width = w;
        (*self.present).height = h;
        (*self.present).format = AVPixelFormat::AV_PIX_FMT_D3D11 as i32;
        Ok(())
    }

    /// La frame de présentation courante (jamais nulle) — `Decoder::cur_frame` en backend CPU.
    pub(crate) fn current(&self) -> *mut AVFrame {
        self.present
    }
}

impl Drop for CpuFrames {
    fn drop(&mut self) {
        unsafe {
            // `present` n'a que des pointeurs empruntés : les remettre à zéro avant de
            // libérer, pour qu'aucun code ffmpeg ne croie posséder notre texture.
            (*self.present).data[0] = ptr::null_mut();
            (*self.present).data[1] = ptr::null_mut();
            av_frame_free(&mut self.present);
            av_frame_free(&mut self.nv12);
            if !self.sws.is_null() {
                sws_freeContext(self.sws);
            }
        }
    }
}
