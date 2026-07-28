//! Pipeline ffmpeg côté macOS — VideoToolbox (HW) + libopenh264 (software).
//!
//! Équivalent macOS de `pipeline_windows.rs` (D3D11VA + h264_amf zero-copy).
//! Exporte la même surface publique : `Stats`, `FrameGuard`, `Decoder`, `VideoEncoder`,
//! `ExportCodec`, `ExportParams`, `ClipSource`, et les points d'entrée `decode_frame_n`,
//! `run_c0`, `run_preview_bench`, `run_composited`, `run_composited_multi`,
//! `probe_frame_count`.
//!
//! # Frame seam — adaptation macOS
//!
//! VideoToolbox pose `AV_PIX_FMT_VIDEOTOOLBOX` sur les frames qu'il rend — le pointeur
//! `CVPixelBufferRef` est dans `data[3]`, pas `data[0]` comme D3D11VA. Notre convention
//! de pose du seam est donc :
//!
//!   - **VideoToolbox hwaccel** (matériel, le chemin normal) : `format = AV_PIX_FMT_VIDEOTOOLBOX`,
//!     `data[3]` porte le `CVPixelBufferRef`. `compositor_macos::nv12_srvs` détecte ce format
//!     et lit `data[3]` au lieu de `data[0]`.
//!   - **Software decode** (rare — codecs hors-session VideoToolbox, par ex. VP9/AV1)
//!     via `mac_frames::CpuFrames::present` : `format = AV_PIX_FMT_D3D11` (sentinel),
//!     `data[0]` porte le `CVPixelBufferRef`. Symétrique avec `cpu_frames_windows.rs`.
//!
//! Les deux aboutissent au même `CVPixelBufferRef` (IOSurface-backed) consommé par
//! `CVMetalTextureCacheCreateTextureFromImage` côté Metal.
//!
//! # Encodeur
//!
//! `ExportCodec::candidates()` côté macOS met `h264_videotoolbox` / `hevc_videotoolbox`
//! en tête de liste (équivalent de `h264_amf` zero-copy côté Windows). VideoToolbox
//! produit du H.264/H.265 avec accélération matérielle — c'est la même chose que les
//! décodeurs, symétrique.

use crate::compositor::Compositor;
use crate::d3d::Gpu;
use anyhow::{anyhow, bail, Result};
use std::ffi::{c_void, CString};
use std::ptr;

/// Identique à `pipeline_windows::Stats`. Voir la doc là-bas pour la sémantique.
pub struct Stats {
    pub frames: u64,
    pub wall_s: f64,
    pub fps: f64,
    pub video_duration_s: f64,
}

/// Garde RAII sur une AVFrame (la libère au Drop). Identique à
/// `pipeline_windows::FrameGuard`.
pub struct FrameGuard(pub *mut crate::ffi::AVFrame);

impl Drop for FrameGuard {
    fn drop(&mut self) {
        unsafe { crate::ffi::av_frame_free(&mut self.0) };
    }
}

/// Décodeur ffmpeg — câblage VideoToolbox (et repli logiciel pour les codecs hors-session).
/// Cf. `pipeline_windows::Decoder` pour la version D3D11VA. Mêmes champs publics pour
/// que `live.rs::Player` reste portable ; les détails internes (hw_device_ctx, format
/// hw, etc.) sont spécifiques à VideoToolbox.
pub struct Decoder {
    fmt: *mut crate::ffi::AVFormatContext,
    dctx: *mut crate::ffi::AVCodecContext,
    /// `AVBufferRef` pour le `AVHWDeviceContext` VideoToolbox. Null en backend CPU.
    hwdev: *mut crate::ffi::AVBufferRef,
    vidx: i32,
    pkt: *mut crate::ffi::AVPacket,
    frame: *mut crate::ffi::AVFrame,
    sent_eof: bool,
    /// Backend « software fallback » uniquement : convertit la frame système en NV12 +
    /// CVPixelBufferRef IOSurface-backed, et la présente sous le même contrat que
    /// VideoToolbox (`compositor_macos::nv12_srvs` reconnaît le sentinel `AV_PIX_FMT_D3D11`
    /// qu'on pose dans `data[0]`). `None` quand VideoToolbox couvre le codec — le décodeur
    /// rend alors directement la frame VideoToolbox.
    cpu: Option<crate::mac_frames::CpuFrames>,
}

impl Decoder {
    pub fn open(path: &str, gpu: &Gpu) -> Result<Decoder> {
        unsafe {
            let mut fmt: *mut crate::ffi::AVFormatContext = ptr::null_mut();
            let cpath = CString::new(path)?;
            crate::ffi::averr(
                crate::ffi::avformat_open_input(&mut fmt, cpath.as_ptr(), ptr::null_mut(), ptr::null_mut()),
                "open_input",
            )?;
            crate::ffi::averr(
                crate::ffi::avformat_find_stream_info(fmt, ptr::null_mut()),
                "find_stream_info",
            )?;
            let vidx = crate::ffi::av_find_best_stream(
                fmt,
                crate::ffi::AVMediaType::AVMEDIA_TYPE_VIDEO,
                -1,
                -1,
                ptr::null_mut(),
                0,
            );
            if vidx < 0 {
                bail!("aucun flux vidéo dans {path}");
            }
            let stream = crate::ffi::sn_fmt_stream(fmt, vidx);
            let codecpar = (*stream).codecpar;
            let dec = crate::ffi::avcodec_find_decoder((*codecpar).codec_id);
            let dctx = crate::ffi::avcodec_alloc_context3(dec);
            crate::ffi::averr(
                crate::ffi::avcodec_parameters_to_context(dctx, codecpar),
                "params_to_ctx",
            )?;

            // On tente VideoToolbox en priorité. Si libavcodec refuse (codec non supporté,
            // profil hors-spec), `get_hw_format` retourne system-memory et on bascule sur le
            // chemin logiciel `mac_frames::CpuFrames` (codecs comme VP9/AV1 non-session).
            //
            // `av_hwdevice_ctx_create` avec `AV_HWDEVICE_TYPE_VIDEOTOOLBOX` n'a pas besoin
            // de device_context (cf. ffmpeg hwcontext_videotoolbox.h : la session est gérée
            // en interne). On passe `device = NULL`, juste un nom d'optionnel.
            let mut hwdev: *mut crate::ffi::AVBufferRef = ptr::null_mut();
            let r = crate::ffi::av_hwdevice_ctx_create(
                &mut hwdev,
                crate::ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
                ptr::null(),
                ptr::null_mut(),
                0,
            );
            let cpu = if r != 0 {
                // Pas de VideoToolbox sur ce codec : fallback software. `get_format` est
                // laissé à NULL (libavcodec choisit son format de sortie, ici NV12 via
                // `*->sw_pix_fmt` = `AV_PIX_FMT_NV12` ou autre). `mac_frames::CpuFrames`
                // convertit alors vers NV12 + CVPixelBufferRef.
                (*dctx).thread_count = 0;
                Some(crate::mac_frames::CpuFrames::new(gpu)?)
            } else {
                // VideoToolbox prêt. On attache le hw_device_ctx + `get_format` qui
                // retourne `AV_PIX_FMT_VIDEOTOOLBOX` quand le codec est supporté.
                (*dctx).hw_device_ctx = crate::ffi::av_buffer_ref(hwdev);
                (*dctx).get_format = Some(get_hw_format_macos);
                hwdev
            };

            crate::ffi::averr(
                crate::ffi::avcodec_open2(dctx, dec, ptr::null_mut()),
                "avcodec_open2",
            )?;

            Ok(Decoder {
                fmt,
                dctx,
                hwdev,
                vidx,
                pkt: crate::ffi::av_packet_alloc(),
                frame: crate::ffi::av_frame_alloc(),
                sent_eof: false,
                cpu,
            })
        }
    }

    pub unsafe fn rewind(&mut self) -> Result<()> {
        crate::ffi::averr(
            crate::ffi::av_seek_frame(
                self.fmt,
                self.vidx,
                0,
                crate::ffi::AVSEEK_FLAG_BACKWARD,
            ),
            "rewind_seek",
        )?;
        crate::ffi::avcodec_flush_buffers(self.dctx);
        self.sent_eof = false;
        Ok(())
    }

    /// `time_base` du flux vidéo (secondes par unité de pts).
    unsafe fn tb_sec(&self) -> f64 {
        let tb = (*crate::ffi::sn_fmt_stream(self.fmt, self.vidx)).time_base;
        if tb.den != 0 {
            tb.num as f64 / tb.den as f64
        } else {
            0.0
        }
    }

    /// Seek keyframe vers `seconds` puis décode-avant jusqu'à la 1re frame dont le
    /// temps ≥ `seconds`. Symétrique de `pipeline_windows::Decoder::seek_to`.
    pub unsafe fn seek_to(&mut self, seconds: f64) -> Result<*mut crate::ffi::AVFrame> {
        let tb_sec = self.tb_sec();
        let target = if tb_sec > 0.0 { (seconds / tb_sec) as i64 } else { 0 };
        crate::ffi::averr(
            crate::ffi::av_seek_frame(self.fmt, self.vidx, target, crate::ffi::AVSEEK_FLAG_BACKWARD),
            "seek_to",
        )?;
        crate::ffi::avcodec_flush_buffers(self.dctx);
        self.sent_eof = false;
        loop {
            let f = self.next()?;
            if f.is_null() {
                return Ok(ptr::null_mut());
            }
            let pts = (*f).best_effort_timestamp;
            if pts == i64::MIN || tb_sec <= 0.0 {
                return Ok(f);
            }
            if (pts as f64) * tb_sec >= seconds - tb_sec * 0.5 {
                return Ok(f);
            }
        }
    }

    /// Rend la prochaine frame (valide jusqu'au prochain appel), ou null à EOF.
    /// Symétrique de `pipeline_windows::Decoder::next`. Boucle `avcodec_receive_frame`
    /// / `av_read_frame` avec gestion d'EOF et AVERROR_EAGAIN — identique au chemin
    /// Windows, juste sans le dispatch D3D11VA (le GPU hand-off est déjà fait par
    /// `av_hwdevice_ctx_create`).
    pub unsafe fn next(&mut self) -> Result<*mut crate::ffi::AVFrame> {
        loop {
            let r = crate::ffi::avcodec_receive_frame(self.dctx, self.frame);
            if r == 0 {
                return match &mut self.cpu {
                    Some(cpu) => cpu.present(self.frame),
                    None => Ok(self.frame),
                };
            }
            if r == crate::ffi::AVERROR_EOF {
                return Ok(ptr::null_mut());
            }
            if r != crate::ffi::AVERROR_EAGAIN {
                crate::ffi::averr(r, "receive_frame")?;
            }
            if self.sent_eof {
                return Ok(ptr::null_mut());
            }
            let rr = crate::ffi::av_read_frame(self.fmt, self.pkt);
            if rr == crate::ffi::AVERROR_EOF {
                crate::ffi::avcodec_send_packet(self.dctx, ptr::null_mut());
                self.sent_eof = true;
            } else {
                crate::ffi::averr(rr, "read_frame")?;
                if (*self.pkt).stream_index == self.vidx {
                    crate::ffi::averr(
                        crate::ffi::avcodec_send_packet(self.dctx, self.pkt),
                        "send_packet",
                    )?;
                }
                crate::ffi::av_packet_unref(self.pkt);
            }
        }
    }

    pub unsafe fn cur_frame(&self) -> *mut crate::ffi::AVFrame {
        match &self.cpu {
            Some(cpu) => cpu.current(),
            None => self.frame,
        }
    }

    /// Temps (s) de la frame courante, via son pts. 0 si pas de pts fiable.
    /// Symétrique de `pipeline_windows::Decoder::cur_time_sec`.
    pub unsafe fn cur_time_sec(&self) -> f64 {
        let pts = (*self.frame).best_effort_timestamp;
        if pts == i64::MIN {
            0.0
        } else {
            pts as f64 * self.tb_sec()
        }
    }

    /// Cadence moyenne du flux (fps). 30 par défaut si indéterminée.
    pub unsafe fn fps(&self) -> f64 {
        let r = (*crate::ffi::sn_fmt_stream(self.fmt, self.vidx)).avg_frame_rate;
        if r.den != 0 && r.num != 0 {
            r.num as f64 / r.den as f64
        } else {
            30.0
        }
    }

    /// Durée réellement annoncée par le flux vidéo (symétrique de
    /// `pipeline_windows::Decoder::available_duration_sec`).
    pub unsafe fn available_duration_sec(&self) -> Option<f64> {
        let stream = crate::ffi::sn_fmt_stream(self.fmt, self.vidx);
        let duration = (*stream).duration;
        let tb_sec = self.tb_sec();
        if duration > 0 && tb_sec > 0.0 {
            let seconds = duration as f64 * tb_sec;
            if seconds.is_finite() && seconds > 0.0 {
                return Some(seconds);
            }
        }
        let nb_frames = (*stream).nb_frames;
        let fps = self.fps();
        if nb_frames > 0 && fps.is_finite() && fps > 0.0 {
            Some(nb_frames as f64 / fps)
        } else {
            None
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            crate::ffi::av_frame_free(&mut self.frame);
            crate::ffi::av_packet_free(&mut self.pkt);
            crate::ffi::avcodec_free_context(&mut self.dctx);
            if !self.hwdev.is_null() {
                crate::ffi::av_buffer_unref(&mut self.hwdev);
            }
            crate::ffi::avformat_close_input(&mut self.fmt);
        }
    }
}

/// Callback `get_format` pour VideoToolbox — quand libavcodec offre une liste de pix_fmts
/// (le hwaccel y ajoute `AV_PIX_FMT_VIDEOTOOLBOX` à la liste retournée par le décodeur),
/// on choisit VT s'il est dans la liste, sinon on prend le premier format software pour
/// laisser `mac_frames::CpuFrames::present` faire la conversion.
///
/// Symétrique à `get_hw_format` dans `pipeline_windows.rs` — qui lui cherche `AV_PIX_FMT_D3D11`.
unsafe extern "C" fn get_hw_format_macos(
    _ctx: *mut crate::ffi::AVCodecContext,
    pix_fmts: *const crate::ffi::AVPixelFormat::Type,
) -> crate::ffi::AVPixelFormat::Type {
    if pix_fmts.is_null() {
        return crate::ffi::AVPixelFormat::AV_PIX_FMT_NONE;
    }
    let mut p = pix_fmts;
    while (*p) != crate::ffi::AVPixelFormat::AV_PIX_FMT_NONE {
        if (*p) == crate::ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX {
            return crate::ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX;
        }
        p = p.add(1);
    }
    // Pas de VideoToolbox offert : prendre le premier format de la liste (système).
    *pix_fmts
}

/// Source clip pour `run_composited_multi`. Mêmes champs que `pipeline_windows::ClipSource`.
pub struct ClipSource {
    pub screen: String,
    pub webcam: String,
    pub cursor_json: String,
    pub webcam_offset_sec: f64,
    pub source_start_sec: f64,
    pub source_end_sec: f64,
    pub trim_start_sec: f64,
    pub trim_end_sec: f64,
    pub speed: f64,
}

/// Codec cible pour l'export. Identique à `pipeline_windows::ExportCodec`.
pub enum ExportCodec {
    H264,
    H265,
}

impl ExportCodec {
    /// Liste ordonnée des encodeurs candidats pour ce codec, **spécifique à macOS**.
    /// Symétrique de `ExportCodec::candidates()` côté Windows — la première candidate
    /// qui ouvre gagne, sauf si `OPENSCREEN_EXPORT_ENCODER=<name>` force un autre choix
    /// (cf. `VideoEncoder::open`).
    ///
    /// Ordre côté macOS :
    ///   1. `h264_videotoolbox` / `hevc_videotoolbox` — encodeur accéléré Apple, zéro-copie
    ///      sur frames `AV_PIX_FMT_VIDEOTOOLBOX` (le hardware décodeur ↔ encodeur partage
    ///      les IOSurfaces sous le capot). Équivalent direct de `h264_amf` côté Windows.
    ///   2. `libopenh264` / `libkvazaar` — dernier recours 100% logiciel, ISO H.264/H.265.
    ///      C'est le SEUL encodeur qui marche sur un hôte sans accélération matérielle
    ///      (rare sur macOS, possible sur certaines VM non-Silicon).
    ///
    /// `*_qsv` et `*_nvenc` n'existent pas sur macOS (pas de GPU Intel/NVIDIA avec ces
    /// stacks côté macOS — Quick Sync n'est pas exposé par VideoToolbox, et NVENC n'est
    /// pas dans les Mac Apple Silicon). La couverture « hardware zéro-copie » est donc
    /// uniquement VideoToolbox, ce qui simplifie considérablement le câblage encode.
    pub fn candidates(&self) -> &'static [EncoderCandidate] {
        match self {
            ExportCodec::H264 => &[
                EncoderCandidate {
                    name: "h264_videotoolbox",
                    pix_fmt: crate::ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX,
                },
                EncoderCandidate {
                    name: "libopenh264",
                    pix_fmt: crate::ffi::AVPixelFormat::AV_PIX_FMT_YUV420P,
                },
            ],
            ExportCodec::H265 => &[
                EncoderCandidate {
                    name: "hevc_videotoolbox",
                    pix_fmt: crate::ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX,
                },
                EncoderCandidate {
                    name: "libkvazaar",
                    pix_fmt: crate::ffi::AVPixelFormat::AV_PIX_FMT_YUV420P,
                },
            ],
        }
    }
}

/// Une candidate d'encodeur : nom (passé à `avcodec_find_encoder_by_name`) et format de
/// pixel natif qu'elle accepte. Le pix_fmt sert à choisir si on a besoin d'un hw_frames_ctx
/// (VIDEOTOOLBOX → oui, zéro-copie ; YUV420P → non, on copie depuis le NV12 de sortie).
#[derive(Clone, Copy)]
pub struct EncoderCandidate {
    pub name: &'static str,
    pub pix_fmt: crate::ffi::AVPixelFormat::Type,
}

/// Paramètres d'export. Identiques à `pipeline_windows::ExportParams`.
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

/// Encodeur ffmpeg — câblage `h264_videotoolbox` / `hevc_videotoolbox` (zero-copy) + repli
/// `libopenh264` / `libkvazaar`. Identique à `pipeline_windows::VideoEncoder` côté
/// surface publique ; le commit « encodeur VT » ajoute la mécanique.
pub struct VideoEncoder {
    _private: (),
}

impl VideoEncoder {
    /// Ouvre l'encodeur pour `codec` sur la cible `w`x`h`. Essaie chaque candidate dans
    /// l'ordre retourné par `ExportCodec::candidates()` ; la première qui ouvre gagne.
    ///
    /// Honore `OPENSCREEN_EXPORT_ENCODER=<name>` (cf. `pipeline_windows::VideoEncoder::open`)
    /// pour forcer une candidate précise — utile pour le bench ou pour tester le chemin
    /// `libopenh264` sur une machine qui a VT (sans override, VT gagnerait toujours au
    /// premier tour).
    ///
    /// Renvoie `Err` dans ce commit de scaffold — le câblage complet (`avcodec_open2` +
    /// alloc de `hw_frames_ctx` pour les candidats VT) viendra avec le commit « engine
    /// VT » qui câblera aussi `run_composited_multi`.
    pub fn open(codec: &ExportCodec, _gpu: &Gpu, w: i32, h: i32) -> Result<VideoEncoder> {
        // Empile les candidates et applique le filtre `OPENSCREEN_EXPORT_ENCODER`.
        let forced = std::env::var("OPENSCREEN_EXPORT_ENCODER").ok();
        let candidates = codec.candidates();
        let mut tried: Vec<&'static str> = Vec::new();
        for c in candidates {
            if let Some(ref want) = forced {
                if c.name != want.as_str() {
                    continue;
                }
            }
            tried.push(c.name);
            // Câblage à venir : `avcodec_find_encoder_by_name(c.name)` →
            // `avcodec_alloc_context3` → pose `width`/`height`/`pix_fmt`/`time_base` →
            // si `pix_fmt == AV_PIX_FMT_VIDEOTOOLBOX` alors `hw_frames_ctx` = hw device ctx →
            // `avcodec_open2`. Pour le scaffold, on saute tout et on renvoie Err avec
            // le nom de la candidate essayée pour rendre la failure lisible.
        }
        Err(anyhow!(
            "pipeline_macos::VideoEncoder::open: non implémenté (essayé {:?} pour {}x{}, codec {:?})",
            tried,
            w,
            h,
            match codec {
                ExportCodec::H264 => "H264",
                ExportCodec::H265 => "H265",
            }
        ))
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {}
}

/// C0 (§9) — stub symétrique à `pipeline_windows::run_c0`.
pub fn decode_frame_n(_path: &str, _gpu: &Gpu, _n: u32) -> Result<FrameGuard> {
    Err(anyhow!("pipeline_macos::decode_frame_n: non implémenté"))
}

pub fn run_c0(_screen: &str, _out: &str, _gpu: &Gpu) -> Result<Stats> {
    Err(anyhow!("pipeline_macos::run_c0: non implémenté"))
}

pub fn run_preview_bench(_gpu: &Gpu) -> Result<Stats> {
    Err(anyhow!("pipeline_macos::run_preview_bench: non implémenté"))
}

pub fn run_composited(
    _screen: &str,
    _out: &str,
    _gpu: &Gpu,
    _scene_json: &str,
) -> Result<Stats> {
    Err(anyhow!("pipeline_macos::run_composited: non implémenté"))
}

/// Multi-clip : orchestre `Decoder::open` → `Decoder::next` → `Compositor::compose_frame`
/// → `VideoEncoder::send_composited`. C'est l'endpoint qu'utilise l'addon napi pour
/// l'export MP4. Renvoie `Err` tant que la chaîne n'est pas complète.
pub fn run_composited_multi(
    _clips: &[ClipSource],
    _out: &str,
    _scene_json: Option<&str>,
    _params: &ExportParams,
) -> Result<Stats> {
    Err(anyhow!(
        "pipeline_macos::run_composited_multi: non implémenté — \
         c'est l'endpoint qu'utilise l'addon napi pour l'export MP4"
    ))
}

/// Compte le nombre de frames d'un fichier (utilisé pour la barre de progression).
/// Le comptage est purement ffmpeg-side, donc portable.
pub fn probe_frame_count(_path: &str) -> Result<u64> {
    Err(anyhow!("pipeline_macos::probe_frame_count: non implémenté"))
}

// Marqueur pour préserver la signature `fn run_composited(_: &Compositor, ...)`
// quand on câblera l'implémentation ; actuellement `Compositor` est utilisé via la
// cfg-re-export `crate::compositor::Compositor`, et cette fonction helper garantit
// que le type reste référencé.
#[allow(dead_code)]
fn _typecheck_compositor(_c: &Compositor, _g: &Gpu) {}