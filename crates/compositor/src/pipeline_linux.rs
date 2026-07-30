//! Pipeline Linux (PR #183) : decode software (`linux_decode::SwDecoder`) +
//! upload NV12-split (`linux_frames::CpuFrames`).
//!
//! Equivalent Linux de `pipeline_windows.rs` / `pipeline_macos.rs` : meme
//! surface publique consommee par le code partage (`Decoder`, `ClipSource`,
//! `ExportCodec`, `ExportParams`, `Stats`, `run_composited_multi`).
//!
//! **Export.** `run_composited_multi` (encode + mux MP4) est un **stub** ici,
//! comme `pipeline_macos` stube plusieurs de ses propres fonctions d'export :
//! le cablage VAAPI/libopenh264 + muxer (via le shim C pour `AVFormatContext.
//! streams`, opaque en bindgen) arrive avec WP6. La PREVIEW (le `Decoder`)
//! est, elle, complete -- c'est ce dont `live.rs` a besoin.

use anyhow::{bail, Result};
use std::ptr;

use crate::config::Cfg;
use crate::d3d::Gpu;
use crate::ffi::AVFrame;
use crate::linux_decode::SwDecoder;
use crate::linux_frames::CpuFrames;

/// Bilan d'un run d'export. Memes champs que `pipeline_macos::Stats`.
pub struct Stats {
    pub frames: u64,
    pub wall_s: f64,
    pub fps: f64,
    pub video_duration_s: f64,
}

/// Un clip de la timeline. Memes champs que `pipeline_macos::ClipSource`.
pub struct ClipSource {
    pub screen: String,
    pub webcam: String,
    pub source_start_sec: f64,
    pub source_end_sec: f64,
    pub webcam_offset_sec: f64,
    pub has_audio: bool,
}

/// Codec cible. Memes variantes que `pipeline_macos::ExportCodec`.
#[derive(Clone, Copy, Debug)]
pub enum ExportCodec {
    H264,
    H265,
}

/// Params d'export. Memes champs que `pipeline_macos::ExportParams`.
pub struct ExportParams {
    pub width: u32,
    pub height: u32,
    pub fps: Option<u32>,
    pub codec: ExportCodec,
}

impl Default for ExportParams {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: None,
            codec: ExportCodec::H264,
        }
    }
}

/// Decodeur Linux : software decode (`SwDecoder`) + upload NV12-split
/// (`CpuFrames`). Meme surface que `pipeline_macos::Decoder`
/// (`open`/`seek_to`/`next`/`cur_frame`/`cur_time_sec`/`fps`) pour que `live.rs`
/// le pilote sans connaitre la plateforme.
pub struct Decoder {
    sw: SwDecoder,
    frames: CpuFrames,
    cur: *mut AVFrame,
    /// Index de la prochaine frame a decoder (sequentiel).
    next_idx: u32,
    fps: f64,
}

// SAFETY : les pointeurs FFI n'ont pas d'affinite thread ; le caller uphold la
// regle « un thread a la fois » (idem `pipeline_macos::Decoder`).
unsafe impl Send for Decoder {}

impl Decoder {
    pub fn open(path: &str, gpu: &Gpu) -> Result<Decoder> {
        let sw = SwDecoder::open(path)?;
        let fps = sw.fps();
        let frames = CpuFrames::new(gpu)?;
        Ok(Decoder {
            sw,
            frames,
            cur: ptr::null_mut(),
            next_idx: 0,
            fps,
        })
    }

    /// Decode la frame a `seconds` (seek), la presente en carrier, la retourne.
    pub unsafe fn seek_to(&mut self, seconds: f64) -> Result<*mut AVFrame> {
        let idx = (seconds.max(0.0) * self.fps).round() as u32;
        self.decode_present(idx)
    }

    /// Decode la frame SEQUENTIELLE suivante.
    // ponytail: `decode_at` par index re-seek a chaque frame -- OK pour le
    // scrub/preview, a optimiser en WP si le bench de lecture l'exige.
    pub unsafe fn next(&mut self) -> Result<*mut AVFrame> {
        let idx = self.next_idx;
        self.decode_present(idx)
    }

    unsafe fn decode_present(&mut self, idx: u32) -> Result<*mut AVFrame> {
        let raw = self.sw.decode_at(idx)?;
        let carrier = self.frames.present(raw)?;
        SwDecoder::free_frame(raw);
        self.cur = carrier;
        self.next_idx = idx + 1;
        Ok(carrier)
    }

    pub unsafe fn cur_frame(&self) -> *mut AVFrame {
        self.cur
    }

    /// Temps source (secondes) de la frame courante.
    pub unsafe fn cur_time_sec(&self) -> f64 {
        if self.next_idx == 0 || self.fps <= 0.0 {
            0.0
        } else {
            (self.next_idx as f64 - 1.0) / self.fps
        }
    }

    pub unsafe fn fps(&self) -> f64 {
        self.fps
    }

    /// Duree du flux (secondes). Pendant de
    /// `pipeline_macos::Decoder::available_duration_sec` ; consomme par
    /// `timeline_walk` pour borner la marche d'export.
    pub unsafe fn available_duration_sec(&self) -> Option<f64> {
        self.sw.duration_sec()
    }
}

/// Export multiclip -- **STUB (WP6)**. L'encode (VAAPI/libopenh264) + le muxer
/// MP4 (via shim C pour `AVFormatContext.streams`) arrivent plus tard ;
/// `pipeline_macos` stube de meme son chemin d'export. On echoue lisiblement
/// plutot que d'ecrire un fichier vide.
pub fn run_composited_multi(
    _clips: &[ClipSource],
    _out: &str,
    _gpu: &Gpu,
    _comp: &crate::compositor::Compositor,
    _cfg: &Cfg,
    _params: &ExportParams,
    _progress: &mut dyn FnMut(u64),
) -> Result<Stats> {
    bail!("run_composited_multi: export natif Linux pas encore implemente (WP6)")
}
