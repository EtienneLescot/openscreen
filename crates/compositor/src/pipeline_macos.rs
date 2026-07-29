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
                // Pas de repli logiciel sur ce chemin : VideoToolbox rend les frames.
                None
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

/// Même contrat que `pipeline_windows`: le `Decoder` est déplacé vers le thread de
/// rendu de `live.rs` (et vers le thread de préchargement du clip suivant). Tous ses
/// pointeurs ffmpeg sont possédés exclusivement par lui, et rien n'y accède depuis
/// deux threads à la fois — d'où `Send` mais pas `Sync`.
unsafe impl Send for Decoder {}

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
    pub source_start_sec: f64,
    pub source_end_sec: f64,
    pub webcam_offset_sec: f64,
    pub has_audio: bool,
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
                // `h264_videotoolbox` annonce `videotoolbox_vld nv12 yuv420p` : il accepte
                // donc des frames LOGICIELLES NV12 et fait l'upload lui-même. C'est
                // exactement le format que le compositeur produit, donc pas de
                // `hw_frames_ctx` à construire ni de pool à partager entre décodeur et
                // encodeur — un étage de complexité que le port avait écrit et qui n'a
                // jamais tourné.
                EncoderCandidate {
                    name: "h264_videotoolbox",
                    pix_fmt: crate::ffi::AVPixelFormat::AV_PIX_FMT_NV12,
                },
                EncoderCandidate {
                    name: "libopenh264",
                    pix_fmt: crate::ffi::AVPixelFormat::AV_PIX_FMT_YUV420P,
                },
            ],
            ExportCodec::H265 => &[
                EncoderCandidate {
                    name: "hevc_videotoolbox",
                    pix_fmt: crate::ffi::AVPixelFormat::AV_PIX_FMT_NV12,
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

/// Encodeur ffmpeg — câblage `h264_videotoolbox` / `hevc_videotoolbox` (zero-copy
/// sur `AV_PIX_FMT_VIDEOTOOLBOX`) + repli `libopenh264` / `libkvazaar` (software).
/// Symétrique de `pipeline_windows::VideoEncoder` côté surface publique, à la
/// différence `pix_fmt` près :
///   - `AV_PIX_FMT_VIDEOTOOLBOX` (zéro-copie sur frames VT issues du décodeur
///     VideoToolbox, partage IOSurface sous le capot),
///   - `AV_PIX_FMT_YUV420P` (software, le décodeur a déjà fait swscale via
///     `mac_frames::CpuFrames::present` côté macOS).
pub struct VideoEncoder {
    ctx: *mut crate::ffi::AVCodecContext,
    /// Tampon système (YUV420P) quand l'encodeur ne supporte pas zero-copy VT.
    /// Null quand l'encodeur choisi est VT (il consomme directement les frames VT).
    sw: *mut crate::ffi::AVFrame,
    /// Tampon NV12 transitoire (libopenh264 n'accepte pas YUV420P en input — il
    /// faut passer par NV12 puis dé-interleave). Null quand l'encodeur est VT ou
    /// quand `pix_fmt == AV_PIX_FMT_YUV420P` directement (libkvazaar).
    nv12: *mut crate::ffi::AVFrame,
}

impl VideoEncoder {
    /// Ouvre l'encodeur pour `codec` sur la cible `w`x`h` à `fps` fps et `bit_rate` bits/s.
    /// Essaie chaque candidate retournée par `ExportCodec::candidates()` (honorant
    /// `OPENSCREEN_EXPORT_ENCODER=<name>`) ; la première qui ouvre gagne.
    ///
    /// Côté VideoToolbox (`h264_videotoolbox` / `hevc_videotoolbox`) : `pix_fmt` est
    /// `AV_PIX_FMT_VIDEOTOOLBOX`. On alloue un `hw_frames_ctx` (`AVHWFramesContext`)
    /// via `av_hwframe_ctx_alloc` + `av_hwframe_ctx_init`, qui crée le pool IOSurface-backed
    /// partagé avec le décodeur VT. Zero-copie GPU→encodeur.
    ///
    /// Côté software (`libopenh264` / `libkvazaar`) : `pix_fmt` est `AV_PIX_FMT_YUV420P`.
    /// On alloue deux tampons AVFrame (un pour le format logiciel, un pour le transitoire
    /// NV12 si l'encodeur ne supporte pas YUV420P directement — `libopenh264`).
    pub fn open(
        codec: &ExportCodec,
        _gpu: &Gpu,
        w: i32,
        h: i32,
        fps: i32,
        bit_rate: i64,
    ) -> Result<VideoEncoder> {
        let forced = std::env::var("OPENSCREEN_EXPORT_ENCODER").ok();
        let mut refused: Vec<String> = Vec::new();
        for &candidate in codec.candidates() {
            if forced.as_deref().is_some_and(|f| f != candidate.name) {
                continue;
            }
            match unsafe { Self::try_open(candidate, w, h, fps, bit_rate) } {
                Ok(encoder) => {
                    eprintln!(
                        "[pipeline] encodeur vidéo : {} ({}{})",
                        candidate.name,
                        if encoder.sw.is_null() {
                            "zero-copy VT"
                        } else {
                            "frames système"
                        },
                        if refused.is_empty() {
                            String::new()
                        } else {
                            format!(" — écartés : {}", refused.join(" ; "))
                        },
                    );
                    return Ok(encoder);
                }
                Err(e) => {
                    refused.push(format!("{}: {}", candidate.name, e));
                }
            }
        }
        match forced {
            Some(name) if refused.is_empty() => {
                bail!("OPENSCREEN_EXPORT_ENCODER={name} ne nomme aucun candidat de ce codec")
            }
            Some(name) => bail!("OPENSCREEN_EXPORT_ENCODER={name} inutilisable ici : {}", refused[0]),
            None => bail!(
                "aucun encodeur vidéo utilisable sur cette machine : {}",
                refused.join(" ; ")
            ),
        }
    }

    unsafe fn try_open(
        candidate: EncoderCandidate,
        w: i32,
        h: i32,
        fps: i32,
        bit_rate: i64,
    ) -> Result<VideoEncoder> {
        let cname = std::ffi::CString::new(candidate.name)?;
        let enc = crate::ffi::avcodec_find_encoder_by_name(cname.as_ptr());
        if enc.is_null() {
            bail!("absent de ce build ffmpeg");
        }
        let mut ctx = crate::ffi::avcodec_alloc_context3(enc);
        if ctx.is_null() {
            bail!("avcodec_alloc_context3");
        }
        (*ctx).width = w;
        (*ctx).height = h;
        (*ctx).pix_fmt = candidate.pix_fmt;
        (*ctx).time_base = crate::ffi::AVRational { num: 1, den: fps };
        (*ctx).framerate = crate::ffi::AVRational { num: fps, den: 1 };
        (*ctx).bit_rate = bit_rate;
        (*ctx).flags |= crate::ffi::AV_CODEC_FLAG_GLOBAL_HEADER as i32;

        // VT : on attache le hw_frames_ctx. En pratique le call-site (run_composited_multi)
        // nous passera un `hw_frames_ctx` pré-construit lié au même device VideoToolbox
        // que le décodeur. Pour l'instant, on crée un hw_frames_ctx frais à partir du
        // device VT par défaut (un seul device VideoToolbox par process — OK pour un
        // export mono-clip).

        if let Err(e) = crate::ffi::averr(
            crate::ffi::avcodec_open2(ctx, enc, ptr::null_mut()),
            "avcodec_open2(enc)",
        ) {
            crate::ffi::avcodec_free_context(&mut ctx);
            return Err(e);
        }

        let mut encoder = VideoEncoder { ctx, sw: ptr::null_mut(), nv12: ptr::null_mut() };
        if candidate.pix_fmt != crate::ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX {
            encoder.sw = alloc_sw_frame(candidate.pix_fmt, w, h)?;
            if candidate.pix_fmt != crate::ffi::AVPixelFormat::AV_PIX_FMT_YUV420P {
                // libopenh264 accepte NV12 directement ; sinon (rare), il faudrait un
                // buffer YUV420P intermédiaire + nv12_to_yuv420p.
                encoder.nv12 = alloc_sw_frame(crate::ffi::AVPixelFormat::AV_PIX_FMT_NV12, w, h)?;
            }
        }
        Ok(encoder)
    }

    /// Envoie une frame à l'encodeur. `frame` null = flush.
    ///
    /// Côté VT (`sw.is_null()`) : la frame est passée directement à `avcodec_send_frame`
    /// (zero-copy, le format est `AV_PIX_FMT_VIDEOTOOLBOX`).
    ///
    /// Côté software : la frame est copiée dans `self.sw` (le format attendu par
    /// l'encodeur — `AV_PIX_FMT_YUV420P` pour `libopenh264` / `libkvazaar`). Si
    /// `libopenh264` (NV12 input) attend du NV12 plutôt que YUV420P, le passage
    /// par `self.nv12` + de-interleave dans `nv12_to_yuv420p` est appliqué ici.
    pub fn send(&mut self, frame: *mut crate::ffi::AVFrame) -> Result<()> {
        unsafe {
            if self.sw.is_null() || frame.is_null() {
                return crate::ffi::averr(
                    crate::ffi::avcodec_send_frame(self.ctx, frame),
                    "send_frame",
                );
            }
            crate::ffi::averr(crate::ffi::av_frame_make_writable(self.sw), "make_writable_sw")?;
            let landing = if self.nv12.is_null() { self.sw } else { self.nv12 };
            // Côté macOS, le décodeur VT rend du VIDEOTOOLBOX ; on doit le transférer vers
            // le format attendu par l'encodeur logiciel. Le `av_hwframe_transfer_data`
            // fait ça si l'encodeur attend du NV12 ; sinon, `nv12_to_yuv420p` est notre
            // dernier recours (cf. `pipeline_windows::send` pour la version D3D11VA).
            crate::ffi::averr(
                crate::ffi::av_hwframe_transfer_data(landing, frame, 0),
                "hwframe_transfer_data",
            )?;
            if !self.nv12.is_null() {
                nv12_to_yuv420p(self.nv12, self.sw);
            }
            crate::ffi::averr(
                crate::ffi::avcodec_send_frame(self.ctx, self.sw),
                "send_frame",
            )
        }
    }

    /// Envoie la frame suivante depuis le compositor. Contrairement à `send` (qui prend
    /// un AVFrame déjà formé), cette méthode :
    ///   1. déclenche `compositor.render_nv12` (RT → NV12 interne),
    ///   2. lit les plans NV12 depuis les textures staging (zero-copy GPU→CPU),
    ///   3. les copie dans une AVFrame YUV420P (le `dst_y`/`dst_uv` du caller).
    ///
    /// Côté macOS, `dst_y`/`dst_uv` pointent dans une AVFrame `sw` que `send` peut
    /// consommer. C'est le même pattern que `pipeline_windows::VideoEncoder::send_composited`.
    pub fn send_composited(
        &mut self,
        compositor: &crate::compositor::Compositor,
        w: u32,
        h: u32,
        pts: i64,
    ) -> Result<()> {
        unsafe {
            if self.sw.is_null() {
                bail!("send_composited: pas de frame logicielle (encodeur zero-copy non câblé)");
            }
            // Rendre le RGBA composé en NV12 côté GPU, PUIS le relire dans les plans de la
            // frame. Le port appelait bien `render_nv12()` mais envoyait ensuite une frame
            // que rien n'avait remplie, sans pts : l'encodeur recevait du contenu
            // indéterminé et des timestamps absents.
            compositor.render_nv12()?;
            crate::ffi::averr(
                crate::ffi::av_frame_make_writable(self.sw),
                "make_writable_sw",
            )?;
            compositor.read_nv12_scaled(
                w,
                h,
                (*self.sw).data[0],
                (*self.sw).linesize[0] as usize,
                (*self.sw).data[1],
                (*self.sw).linesize[1] as usize,
            )?;
            (*self.sw).pts = pts;
            crate::ffi::averr(
                crate::ffi::avcodec_send_frame(self.ctx, self.sw),
                "send_frame_composited",
            )
        }
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        unsafe {
            crate::ffi::avcodec_free_context(&mut self.ctx);
            if !self.sw.is_null() {
                crate::ffi::av_frame_free(&mut self.sw);
            }
            if !self.nv12.is_null() {
                crate::ffi::av_frame_free(&mut self.nv12);
            }
        }
    }
}

/// Alloue une AVFrame système (memory-backed) au format demandé. Conservé pour
/// l'encodeur software fallback (`libopenh264` / `libkvazaar`). Symétrique de
/// `pipeline_windows::alloc_sw_frame`.
unsafe fn alloc_sw_frame(
    pix_fmt: crate::ffi::AVPixelFormat::Type,
    w: i32,
    h: i32,
) -> Result<*mut crate::ffi::AVFrame> {
    let mut frame = crate::ffi::av_frame_alloc();
    if frame.is_null() {
        bail!("av_frame_alloc (encodeur)");
    }
    (*frame).format = pix_fmt as i32;
    (*frame).width = w;
    (*frame).height = h;
    if crate::ffi::av_frame_get_buffer(frame, 32) < 0 {
        crate::ffi::av_frame_free(&mut frame);
        bail!("av_frame_get_buffer (encodeur) {}x{} pix_fmt={}", w, h, pix_fmt);
    }
    Ok(frame)
}

/// Dé-interleave NV12 → YUV420P (utilisé quand l'encodeur attend YUV420P mais la
/// frame source est NV12 — rare sur macOS puisque libopenh264 accepte NV12
/// directement, mais `libkvazaar` HEVC et quelques encodeurs logiciels anciens
/// veulent du YUV420P). Symétrique de `pipeline_windows::nv12_to_yuv420p`.
unsafe fn nv12_to_yuv420p(_src: *mut crate::ffi::AVFrame, _dst: *mut crate::ffi::AVFrame) {
    // Le câblage memcpy plan-par-plan viendra avec le commit « export zero-copy » quand
    // un encodeur macOS en aura effectivement besoin — pour l'instant, NV12→YUV420P n'est
    // pas exercé (libopenh264 prend NV12, h264_videotoolbox prend VT).
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
/// → `VideoEncoder::send_composited` → muxer MP4. C'est l'endpoint qu'utilise l'addon
/// napi pour l'export. Symétrique de `pipeline_windows::run_composited_multi`, à la
/// difference près :
///   - l'encodeur choisi via `ExportCodec::candidates()` est typiquement
///     `h264_videotoolbox` (zero-copy sur frames `AV_PIX_FMT_VIDEOTOOLBOX`),
///   - le compose_frame est le first-pass engine (full-canvas), pas la version
///     layer-by-layer (les layers câblés sont un commit ultérieur).
///
/// First-pass : l'audio AAC est ignoré (sera câblé par un commit dédié sur le module
/// `audio.rs` qui est pour l'instant toujours Windows-only via la même cfg-re-export).
/// Le mux MP4 est écrit, les paquets vidéo sont encodés.
pub fn run_composited_multi(
    clips: &[ClipSource],
    out: &str,
    gpu: &Gpu,
    comp: &crate::compositor::Compositor,
    cfg: &crate::config::Cfg,
    params: &ExportParams,
    progress: &mut dyn FnMut(u64),
) -> Result<Stats> {
    if clips.is_empty() {
        bail!("run_composited_multi: aucun clip à exporter");
    }
    let (out_w, out_h) = (params.width, params.height);
    let t0 = std::time::Instant::now();
    let mut frames: u64 = 0;

    // fps : explicite > dérivé du premier clip.
    let out_fps = params.fps.unwrap_or(30) as i32;
    // bitrate proportionnel à la surface de sortie (référence : 8Mbps @ 1920x1080).
    let bit_rate = ((out_w as i64 * out_h as i64 * 8_000_000) / (1920 * 1080)).max(2_000_000);

    // ---- decodeurs : un par chemin, réutilisés entre clips (screen ≠ webcam → 2 maps) ----
    let mut screen_decs: std::collections::HashMap<String, Decoder> =
        std::collections::HashMap::new();
    let mut webcam_decs: std::collections::HashMap<String, Decoder> =
        std::collections::HashMap::new();

    // ---- encodeur (candidat VT ou software) ----
    let mut enc =
        VideoEncoder::open(&params.codec, gpu, out_w as i32, out_h as i32, out_fps, bit_rate)?;
    let ectx = enc.ctx;

    // ---- muxer MP4 ----
    let mut octx: *mut crate::ffi::AVFormatContext = ptr::null_mut();
    let outc = CString::new(out)?;
    unsafe {
        crate::ffi::averr(
            crate::ffi::avformat_alloc_output_context2(
                &mut octx,
                ptr::null(),
                ptr::null(),
                outc.as_ptr(),
            ),
            "alloc_output_context2",
        )?;
    }
    let ostream = unsafe { crate::ffi::avformat_new_stream(octx, ptr::null()) };
    if ostream.is_null() {
        bail!("avformat_new_stream");
    }
    unsafe {
        crate::ffi::averr(
            crate::ffi::avcodec_parameters_from_context((*ostream).codecpar, ectx),
            "params_from_ctx",
        )?;
        (*ostream).time_base = (*ectx).time_base;
    }

    let mut pb: *mut crate::ffi::AVIOContext = ptr::null_mut();
    unsafe {
        crate::ffi::averr(
            crate::ffi::avio_open(&mut pb, outc.as_ptr(), crate::ffi::AVIO_FLAG_WRITE as i32),
            "avio_open",
        )?;
        crate::ffi::sn_fmt_set_pb(octx, pb);
        crate::ffi::averr(
            crate::ffi::avformat_write_header(octx, ptr::null_mut()),
            "write_header",
        )?;
    }

    let mut opkt = unsafe { crate::ffi::av_packet_alloc() };

    // La marche de timeline est PARTAGÉE (`timeline_walk`) : c'est elle qui décide quelle
    // frame source appartient à quelle frame de sortie, en tenant compte des régions de
    // vitesse, du fenêtrage de scène par clip et du curseur. La version maison qui vivait
    // ici décodait 1:1 en avançant `t` de `1/fps`, donc elle ignorait tout cela — et c'est
    // exactement le bug de troncature en slow-motion que la doc de `walk_composited_timeline`
    // raconte avoir déjà coûté une fois.
    let scene = comp.scene_snapshot();
    frames = unsafe {
        crate::timeline_walk::walk_composited_timeline(
            clips,
            gpu,
            comp,
            cfg,
            out_fps,
            &scene,
            &mut screen_decs,
            &mut webcam_decs,
            &mut |n| {
                enc.send_composited(comp, out_w, out_h, n as i64)?;
                drain_encoder(ectx, octx, ostream, opkt)?;
                progress(n + 1);
                Ok(())
            },
            &mut |_, _, _, _| Ok(()),
        )?
    };

    // Flush : un null frame à l'encodeur finalise son bitstream.
    unsafe {
        crate::ffi::averr(
            crate::ffi::avcodec_send_frame(ectx, ptr::null_mut()),
            "send_frame_flush",
        )?;
        drain_encoder(ectx, octx, ostream, opkt)?;
        crate::ffi::averr(
            crate::ffi::av_write_trailer(octx),
            "write_trailer",
        )?;
        crate::ffi::avio_closep(&mut pb);
        crate::ffi::avformat_free_context(octx);
        crate::ffi::av_packet_free(&mut opkt);
    }

    let wall_s = t0.elapsed().as_secs_f64();
    Ok(Stats {
        frames,
        wall_s,
        fps: if wall_s > 0.0 { frames as f64 / wall_s } else { 0.0 },
        video_duration_s: frames as f64 / out_fps as f64,
    })
}

/// Draine les paquets de l'encodeur vers le muxer — symétrique de
/// `pipeline_windows::drain_encoder`.
unsafe fn drain_encoder(
    ectx: *mut crate::ffi::AVCodecContext,
    octx: *mut crate::ffi::AVFormatContext,
    ostream: *mut crate::ffi::AVStream,
    opkt: *mut crate::ffi::AVPacket,
) -> Result<()> {
    use crate::ffi::*;
    loop {
        let r = avcodec_receive_packet(ectx, opkt);
        if r == AVERROR_EOF {
            return Ok(());
        }
        if r == AVERROR_EAGAIN {
            return Ok(());
        }
        averr(r, "receive_packet")?;
        av_packet_rescale_ts(opkt, (*ectx).time_base, (*ostream).time_base);
        averr(
            av_interleaved_write_frame(octx, opkt),
            "interleaved_write_frame",
        )?;
        av_packet_unref(opkt);
    }
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