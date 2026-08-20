//! Pipeline Linux (PR #183) : decode software (`linux_decode::SwDecoder`) +
//! upload NV12-split (`linux_frames::CpuFrames`).
//!
//! Equivalent Linux de `pipeline_windows.rs` / `pipeline_macos.rs` : meme
//! surface publique consommee par le code partage (`Decoder`, `ClipSource`,
//! `ExportCodec`, `ExportParams`, `Stats`, `run_composited_multi`).
//!
//! **Export (WP6).** `run_composited_multi` encode + mux un MP4 **vidéo** :
//! encodeur SOFTWARE (`libopenh264` H264 / `libkvazaar` H265 -- les seuls du
//! build LGPL BtbN qui marchent sans device HW, VAAPI/Vulkan-encode = suivi),
//! la frame composée est relue en RGBA (ring de staging à 2, cf.
//! `Compositor::set_readback_depth`) puis convertie
//! YUV420P par `sws_scale`. La marche de timeline est PARTAGÉE
//! (`timeline_walk::walk_composited_timeline`) et le muxer passe par le shim C
//! `sn_fmt_set_pb` (comme Windows/macOS). **L'audio AAC n'est pas encore muxé**
//! (increment suivant : `audio.rs` + `AacEncoder` sont déjà partagés).

use anyhow::{bail, Result};
use std::collections::HashMap;
use std::ffi::CString;
use std::ptr;

use crate::audio::{
    assemble_concatenated_pcm, build_audio_concat_plan, decode_clip_audio, finish_audio,
    stretch_clip_pcm_by_speed, AacEncoder, PlanarPcm,
};
use crate::config::Cfg;
use crate::d3d::Gpu;
use crate::ffi::AVFrame;
use crate::linux_decode::SwDecoder;
use crate::timeline_walk::NextFrameTime;
use crate::linux_frames::CpuFrames;

/// `SWS_POINT` (plus proche voisin). Bindgen ne genere pas les `SWS_*` (macros),
/// valeur figee par l'ABI de libswscale -- comme `linux_frames::SWS_POINT`.
const SWS_POINT: i32 = 0x10;

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

    /// Decode la frame SEQUENTIELLE suivante — pompage `next_frame`, PAS de seek.
    /// La frame rendue appartient au decodeur (valide jusqu'au prochain appel),
    /// donc elle ne se libere pas ici, contrairement au chemin `decode_at`.
    pub unsafe fn next(&mut self) -> Result<*mut AVFrame> {
        let raw = self.sw.next_frame()?;
        if raw.is_null() {
            self.cur = ptr::null_mut();
            return Ok(ptr::null_mut());
        }
        let carrier = self.frames.present(raw)?;
        self.cur = carrier;
        self.next_idx = self.next_idx.saturating_add(1);
        Ok(carrier)
    }

    unsafe fn decode_present(&mut self, idx: u32) -> Result<*mut AVFrame> {
        let raw = self.sw.decode_at(idx)?;
        let carrier = self.frames.present(raw)?;
        SwDecoder::free_frame(raw);
        self.cur = carrier;
        self.next_idx = idx + 1;
        Ok(carrier)
    }

    /// Décode la prochaine frame dans le buffer de lookahead du décodeur sous-jacent et
    /// renvoie son temps, sans la présenter (donc sans toucher `self.cur`).
    /// Cf. `pipeline_macos::Decoder::peek_next_time_sec` pour la sémantique "hold".
    pub(crate) unsafe fn peek_next_time_sec(&mut self) -> Result<NextFrameTime> {
        self.sw.peek_next_time_sec()
    }

    /// Promeut la frame de lookahead au rang de frame courante ET la présente (upload NV12
    /// vers la texture carrier), contrairement au chemin macOS/Windows où la promotion est
    /// un pur échange de pointeurs — ici la présentation est le pas qui manque.
    pub(crate) unsafe fn commit_peek(&mut self) -> Result<*mut AVFrame> {
        let raw = self.sw.commit_peek()?;
        let carrier = self.frames.present(raw)?;
        self.cur = carrier;
        self.next_idx = self.next_idx.saturating_add(1);
        Ok(carrier)
    }

    pub unsafe fn cur_frame(&self) -> *mut AVFrame {
        self.cur
    }

    /// Temps source (secondes) de la frame courante — pts REEL du decodeur, avec
    /// repli sur le compteur d'index si le flux ne porte pas de pts.
    pub unsafe fn cur_time_sec(&self) -> f64 {
        if let Some(t) = self.sw.cur_time_sec() {
            return t.max(0.0);
        }
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

/// Encodeur video SOFTWARE (`libopenh264` / `libkvazaar`). Pas de zero-copy HW
/// (VAAPI/Vulkan-encode = suivi) : la frame composee est relue RGBA par
/// l'appelant puis convertie YUV420P par `sws_scale`. Surface
/// `open`/`send_rgba`/`flush` alignee sur le chemin software de
/// `pipeline_macos::VideoEncoder`.
pub struct VideoEncoder {
    ctx: *mut crate::ffi::AVCodecContext,
    /// AVFrame YUV420P envoyee a l'encodeur.
    sw: *mut AVFrame,
    /// RGBA (sortie compositeur) -> YUV420P. Cree paresseusement (dims du readback).
    sws: *mut crate::ffi::SwsContext,
    w: i32,
    h: i32,
}

// SAFETY : pointeurs FFI sans affinite thread ; caller mono-thread (idem Decoder).
unsafe impl Send for VideoEncoder {}

impl VideoEncoder {
    /// Encodeurs software candidats du build LGPL, par codec. La premiere qui
    /// ouvre gagne ; `OPENSCREEN_EXPORT_ENCODER=<name>` force un choix.
    fn candidate_names(codec: &ExportCodec) -> &'static [&'static str] {
        match codec {
            ExportCodec::H264 => &["libopenh264"],
            ExportCodec::H265 => &["libkvazaar"],
        }
    }

    pub fn open(codec: &ExportCodec, w: i32, h: i32, fps: i32, bit_rate: i64) -> Result<VideoEncoder> {
        let forced = std::env::var("OPENSCREEN_EXPORT_ENCODER").ok();
        let mut refused: Vec<String> = Vec::new();
        // Liste par defaut, plus l'encodeur force s'il n'y figure pas (ex. h264_vaapi).
        let defaults = Self::candidate_names(codec);
        let extra: Vec<&str> = forced
            .as_deref()
            .filter(|f| !defaults.contains(f))
            .into_iter()
            .collect();
        for &name in defaults.iter().chain(extra.iter()) {
            if forced.as_deref().is_some_and(|f| f != name) {
                continue;
            }
            match unsafe { Self::try_open(name, w, h, fps, bit_rate) } {
                Ok(enc) => {
                    eprintln!("[pipeline] encodeur video : {name} (software YUV420P)");
                    return Ok(enc);
                }
                Err(e) => refused.push(format!("{name}: {e}")),
            }
        }
        match forced {
            Some(name) => bail!("OPENSCREEN_EXPORT_ENCODER={name} inutilisable : {}", refused.join(" ; ")),
            None => bail!("aucun encodeur video utilisable : {}", refused.join(" ; ")),
        }
    }

    unsafe fn try_open(name: &str, w: i32, h: i32, fps: i32, bit_rate: i64) -> Result<VideoEncoder> {
        use crate::ffi::*;
        let cname = CString::new(name)?;
        let enc = avcodec_find_encoder_by_name(cname.as_ptr());
        if enc.is_null() {
            bail!("absent de ce build ffmpeg");
        }
        let mut ctx = avcodec_alloc_context3(enc);
        if ctx.is_null() {
            bail!("avcodec_alloc_context3");
        }
        (*ctx).width = w;
        (*ctx).height = h;
        (*ctx).pix_fmt = AVPixelFormat::AV_PIX_FMT_YUV420P;
        (*ctx).time_base = AVRational { num: 1, den: fps };
        (*ctx).framerate = AVRational { num: fps, den: 1 };
        (*ctx).bit_rate = bit_rate;
        // MP4 : header global dans l'extradata (pas par-paquet).
        (*ctx).flags |= AV_CODEC_FLAG_GLOBAL_HEADER as i32;
        if let Err(e) = averr(avcodec_open2(ctx, enc, ptr::null_mut()), "avcodec_open2(enc)") {
            avcodec_free_context(&mut ctx);
            return Err(e);
        }
        match alloc_sw_frame(AVPixelFormat::AV_PIX_FMT_YUV420P, w, h) {
            Ok(sw) => Ok(VideoEncoder { ctx, sw, sws: ptr::null_mut(), w, h }),
            Err(e) => {
                avcodec_free_context(&mut ctx);
                Err(e)
            }
        }
    }

    /// Envoie une frame composee DEJA RELUE (RGBA) a l'encodeur, en YUV420P.
    ///
    /// La relecture est sortie d'ici : avec la ring de staging, la frame rendue
    /// par `readback_submit` n'est pas celle qui vient d'etre composee mais la
    /// precedente, donc l'appelant doit apparier lui-meme la frame et son pts
    /// (cf. `run_composited_multi`).
    pub unsafe fn send_rgba(&mut self, rgba: &[u8], rw: i32, rh: i32, pts: i64) -> Result<()> {
        use crate::ffi::*;
        if self.sws.is_null() {
            self.sws = sws_getContext(
                rw,
                rh,
                AVPixelFormat::AV_PIX_FMT_RGBA,
                self.w,
                self.h,
                AVPixelFormat::AV_PIX_FMT_YUV420P,
                // POINT : le compositeur est dimensionne a la sortie -> pas de
                // mise a l'echelle, donc echantillonnage exact (cf. mac_frames).
                SWS_POINT,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            );
            if self.sws.is_null() {
                bail!("sws_getContext {rw}x{rh} RGBA -> {}x{} YUV420P", self.w, self.h);
            }
        }
        averr(av_frame_make_writable(self.sw), "make_writable")?;
        // RGBA est un plan unique : data[0] + stride rw*4, les autres nuls.
        let src_data: [*const u8; 4] = [rgba.as_ptr(), ptr::null(), ptr::null(), ptr::null()];
        let src_stride: [i32; 4] = [rw * 4, 0, 0, 0];
        let converted = sws_scale(
            self.sws,
            src_data.as_ptr(),
            src_stride.as_ptr(),
            0,
            rh,
            (*self.sw).data.as_ptr() as *const *mut u8,
            (*self.sw).linesize.as_ptr(),
        );
        if converted <= 0 {
            bail!("sws_scale RGBA->YUV420P : {converted} lignes");
        }
        (*self.sw).pts = pts;
        averr(avcodec_send_frame(self.ctx, self.sw), "send_frame")
    }

    /// Flush : une frame nulle finalise le bitstream de l'encodeur.
    pub unsafe fn flush(&mut self) -> Result<()> {
        crate::ffi::averr(
            crate::ffi::avcodec_send_frame(self.ctx, ptr::null_mut()),
            "send_frame_flush",
        )
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        unsafe {
            crate::ffi::avcodec_free_context(&mut self.ctx);
            if !self.sw.is_null() {
                crate::ffi::av_frame_free(&mut self.sw);
            }
            if !self.sws.is_null() {
                crate::ffi::sws_freeContext(self.sws);
            }
        }
    }
}

/// Alloue une AVFrame systeme au format demande. Symetrique de
/// `pipeline_macos::alloc_sw_frame`.
unsafe fn alloc_sw_frame(pix_fmt: crate::ffi::AVPixelFormat::Type, w: i32, h: i32) -> Result<*mut AVFrame> {
    let mut frame = crate::ffi::av_frame_alloc();
    if frame.is_null() {
        bail!("av_frame_alloc (encodeur)");
    }
    (*frame).format = pix_fmt as i32;
    (*frame).width = w;
    (*frame).height = h;
    if crate::ffi::av_frame_get_buffer(frame, 32) < 0 {
        crate::ffi::av_frame_free(&mut frame);
        bail!("av_frame_get_buffer {w}x{h} pix_fmt={pix_fmt}");
    }
    Ok(frame)
}

/// Draine les paquets de l'encodeur vers le muxer. Symetrique de
/// `pipeline_macos::drain_encoder`.
unsafe fn drain_encoder(
    ectx: *mut crate::ffi::AVCodecContext,
    octx: *mut crate::ffi::AVFormatContext,
    ostream: *mut crate::ffi::AVStream,
    opkt: *mut crate::ffi::AVPacket,
) -> Result<()> {
    use crate::ffi::*;
    loop {
        let r = avcodec_receive_packet(ectx, opkt);
        if r == AVERROR_EOF || r == AVERROR_EAGAIN {
            return Ok(());
        }
        averr(r, "receive_packet")?;
        av_packet_rescale_ts(opkt, (*ectx).time_base, (*ostream).time_base);
        averr(av_interleaved_write_frame(octx, opkt), "interleaved_write_frame")?;
        av_packet_unref(opkt);
    }
}

/// Export multiclip VIDEO (WP6). Encode software + mux MP4. Audio AAC = suivi
/// (`audio.rs`/`AacEncoder` partages, il ne manque que le branchement du 2e flux
/// + l'assemblage PCM par clip, cf. `pipeline_macos::run_composited_multi`).
///
/// La marche de timeline est PARTAGEE (`walk_composited_timeline`) : elle compose
/// chaque frame de sortie (vitesse/fenetrage/curseur inclus) puis appelle
/// `on_frame(n)`, ou on relit + encode + draine.
pub fn run_composited_multi(
    clips: &[ClipSource],
    out: &str,
    gpu: &Gpu,
    comp: &crate::compositor::Compositor,
    cfg: &Cfg,
    params: &ExportParams,
    progress: &mut dyn FnMut(u64),
) -> Result<Stats> {
    if clips.is_empty() {
        bail!("run_composited_multi: aucun clip a exporter");
    }
    let (out_w, out_h) = (params.width, params.height);
    let out_fps = params.fps.unwrap_or(30) as i32;
    // bitrate proportionnel a la surface (reference : 8 Mbps @ 1920x1080).
    let bit_rate = ((out_w as i64 * out_h as i64 * 8_000_000) / (1920 * 1080)).max(2_000_000);
    let t0 = std::time::Instant::now();

    let mut enc = VideoEncoder::open(&params.codec, out_w as i32, out_h as i32, out_fps, bit_rate)?;
    let ectx = enc.ctx;

    let mut screen_decs: HashMap<String, Decoder> = HashMap::new();
    let mut webcam_decs: HashMap<String, Decoder> = HashMap::new();

    // ---- muxer MP4 (flux video + flux AAC) ----
    let outc = CString::new(out)?;
    let mut octx: *mut crate::ffi::AVFormatContext = ptr::null_mut();
    let mut pb: *mut crate::ffi::AVIOContext = ptr::null_mut();
    let ostream;
    let opkt;
    let mut audio_encoder;
    unsafe {
        crate::ffi::averr(
            crate::ffi::avformat_alloc_output_context2(&mut octx, ptr::null(), ptr::null(), outc.as_ptr()),
            "alloc_output_context2",
        )?;
        ostream = crate::ffi::avformat_new_stream(octx, ptr::null());
        if ostream.is_null() {
            bail!("avformat_new_stream");
        }
        crate::ffi::averr(
            crate::ffi::avcodec_parameters_from_context((*ostream).codecpar, ectx),
            "params_from_ctx",
        )?;
        (*ostream).time_base = (*ectx).time_base;
        crate::ffi::averr(
            crate::ffi::avio_open(&mut pb, outc.as_ptr(), crate::ffi::AVIO_FLAG_WRITE as i32),
            "avio_open",
        )?;
        crate::ffi::sn_fmt_set_pb(octx, pb);
        // Le flux AAC doit exister AVANT l'en-tete (le muxer y fige sa table de flux).
        // Meme si aucun clip n'a d'audio, on ecrit une piste silencieuse -- parite
        // avec Windows/macOS, qui muxent toujours l'AAC.
        audio_encoder = AacEncoder::open(octx)?;
        crate::ffi::averr(
            crate::ffi::avformat_write_header(octx, ptr::null_mut()),
            "write_header",
        )?;
        opkt = crate::ffi::av_packet_alloc();
    }

    // Un PCM par clip, assemble apres la marche video (elle seule dit combien de
    // frames chaque clip a produit, donc combien d'audio lui revient).
    let mut clip_pcm: Vec<Option<PlanarPcm>> = (0..clips.len()).map(|_| None).collect();
    let mut clip_frame_counts: Vec<u64> = vec![0; clips.len()];

    let scene = comp.scene_snapshot();
    let audio_settings = scene.as_ref().map(|scene| scene.audio).unwrap_or_default();
    // Ring de staging a 2 : l'export ne veut que du debit, une frame de latence
    // ne se voit pas dans un fichier. Voir `Compositor::set_readback_depth` pour
    // la raison pour laquelle la preview, elle, reste a 1.
    comp.set_readback_depth(2)?;
    // pts d'encodage : DECOUPLE de l'index de marche `n`, puisque la frame
    // recoltee a l'iteration n est celle composee a n-1. Il reste contigu (les
    // frames sortent de la ring dans l'ordre de composition), donc le fichier
    // produit est identique a celui du chemin synchrone.
    let mut encoded_pts: i64 = 0;
    let frames = unsafe {
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
                // Soumet la copie de la frame n SANS l'attendre et recolte la
                // precedente : c'est tout le pipelining. Pendant que le CPU
                // passe ses ~12,6 ms dans sws_scale + avcodec_send_frame sur la
                // frame n-1, le GPU finit la composition et la copie de n.
                if let Some((rw, rh, rgba)) = comp.readback_submit()? {
                    enc.send_rgba(&rgba, rw as i32, rh as i32, encoded_pts)?;
                    encoded_pts += 1;
                    drain_encoder(ectx, octx, ostream, opkt)?;
                }
                // Progression = frames COMPOSEES (inchangee) : la barre ne doit
                // pas reculer d'une frame parce que l'encodage a un tour de
                // retard.
                progress(n + 1);
                Ok(())
            },
            &mut |clip_index, source_end_sec, frames_in_clip, speed_segments| {
                clip_frame_counts[clip_index] = frames_in_clip;
                let clip = &clips[clip_index];
                if clip.has_audio && frames_in_clip > 0 {
                    match decode_clip_audio(&clip.screen, clip.source_start_sec, source_end_sec) {
                        Ok(Some(pcm)) => {
                            clip_pcm[clip_index] =
                                Some(stretch_clip_pcm_by_speed(&pcm, speed_segments, out_fps as f64));
                        }
                        Ok(None) => eprintln!(
                            "[pipeline] warning: clip #{clip_index} declare audio mais sans flux decodable; silence",
                        ),
                        Err(error) => eprintln!(
                            "[pipeline] warning: decodage audio clip #{clip_index} echoue ({error:#}); silence",
                        ),
                    }
                }
                Ok(())
            },
        )?
    };

    unsafe {
        // Drain de la ring AVANT le flush de l'encodeur : les `depth - 1`
        // dernieres copies sont encore en vol, et sans ce drain la derniere
        // frame composee ne serait jamais encodee (video amputee d'une frame).
        while let Some((rw, rh, rgba)) = comp.readback_take()? {
            enc.send_rgba(&rgba, rw as i32, rh as i32, encoded_pts)?;
            encoded_pts += 1;
            drain_encoder(ectx, octx, ostream, opkt)?;
        }
        // Le compositeur peut survivre a l'export (l'appelant le possede) : on
        // lui rend sa profondeur par defaut plutot que de lui laisser une ring
        // a 2 et le buffer de 8 Mo qui va avec.
        comp.set_readback_depth(1)?;
        enc.flush()?;
        drain_encoder(ectx, octx, ostream, opkt)?;
        // Audio : le plan part des frames REELLEMENT produites par clip (un clip
        // raccourci voit son audio raccourci d'autant), puis un seul encode AAC.
        let declared_audio: Vec<bool> = clips.iter().map(|c| c.has_audio).collect();
        let plan = build_audio_concat_plan(&clip_frame_counts, &declared_audio, out_fps as f64);
        audio_encoder.encode(
            &finish_audio(assemble_concatenated_pcm(&clip_pcm, &plan), audio_settings),
            octx,
        )?;
        crate::ffi::averr(crate::ffi::av_write_trailer(octx), "write_trailer")?;
        crate::ffi::avio_closep(&mut pb);
        crate::ffi::avformat_free_context(octx);
        let mut opkt = opkt;
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
