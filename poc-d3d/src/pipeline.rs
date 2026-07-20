//! C0 (§9) : décode D3D11VA (screen) → encode h264_amf → mux MP4, sur NOTRE device.
//! Aucun composite. Mesuré au plus extérieur (§10) : Instant (mappe QPC) autour de
//! tout le run, deux lectures seulement. Rien dans la boucle ne peut fausser le fps.

use crate::audio::{
    assemble_concatenated_pcm, build_audio_concat_plan, decode_clip_audio,
    stretch_clip_pcm_by_speed, AacEncoder, PlanarPcm,
};
use crate::compositor::{Compositor, OUT_H, OUT_W};
use crate::config::Cfg;
use crate::cursor::CursorTrack;
use crate::d3d::Gpu;
use crate::ffi::*;
use crate::regions::speed_segments_for_window;
use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::ffi::{c_void, CString};
use std::ptr;
use std::time::Instant;
use windows::core::Interface;

// Macros libav non générées par bindgen (function-like). Valeurs Windows/MSVC.
const AVERROR_EAGAIN: i32 = -11; // -EAGAIN (EAGAIN=11 sur MSVC)
const AVERROR_EOF: i32 = -541478725; // -MKTAG('E','O','F',' ')
const AVSEEK_FLAG_BACKWARD: i32 = 1; // seek vers la keyframe <= ts (macro non générée)

// Accesseurs shim.c (AVFormatContext opaque côté bindgen).
extern "C" {
    fn sn_fmt_stream(s: *mut AVFormatContext, i: i32) -> *mut AVStream;
    fn sn_fmt_nb_streams(s: *mut AVFormatContext) -> u32;
    fn sn_fmt_get_pb(s: *mut AVFormatContext) -> *mut AVIOContext;
    fn sn_fmt_set_pb(s: *mut AVFormatContext, p: *mut AVIOContext);
}

pub struct Stats {
    pub frames: u64,
    pub wall_s: f64,
    pub fps: f64,
    /// Durée de la vidéo exportée (secondes) = frames / cadence de sortie. Distincte de
    /// `wall_s` (temps de rendu réel) — sert au message de succès ("vidéo de Xs exportée en Ys").
    pub video_duration_s: f64,
}

/// Garde RAII sur une AVFrame (la libère au Drop).
pub struct FrameGuard(pub *mut AVFrame);
impl Drop for FrameGuard {
    fn drop(&mut self) {
        unsafe { av_frame_free(&mut self.0) };
    }
}

/// Décode la n-ième frame d'une source sur NOTRE device (textures échantillonnables).
/// Sert le harnais de composition (S3+), hors mesure. Retourne une frame indépendante.
pub fn decode_frame_n(path: &str, gpu: &Gpu, n: u32) -> Result<FrameGuard> {
    unsafe { decode_frame_n_inner(path, gpu, n) }
}

unsafe fn decode_frame_n_inner(path: &str, gpu: &Gpu, n: u32) -> Result<FrameGuard> {
    let mut fmt: *mut AVFormatContext = ptr::null_mut();
    let cpath = CString::new(path)?;
    averr(
        avformat_open_input(&mut fmt, cpath.as_ptr(), ptr::null_mut(), ptr::null_mut()),
        "open_input",
    )?;
    averr(avformat_find_stream_info(fmt, ptr::null_mut()), "find_stream_info")?;
    let vidx = av_find_best_stream(fmt, AVMediaType::AVMEDIA_TYPE_VIDEO, -1, -1, ptr::null_mut(), 0);
    if vidx < 0 {
        bail!("aucun flux vidéo");
    }
    let stream = sn_fmt_stream(fmt, vidx);
    let codecpar = (*stream).codecpar;
    let dec = avcodec_find_decoder((*codecpar).codec_id);
    let dctx = avcodec_alloc_context3(dec);
    averr(avcodec_parameters_to_context(dctx, codecpar), "params_to_ctx")?;
    allow_d3d11va_h264_baseline(dctx);

    let hwdev = av_hwdevice_ctx_alloc(AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA);
    let hwdc = (*hwdev).data as *mut AVHWDeviceContext;
    let d3dctx = (*hwdc).hwctx as *mut AVD3D11VADeviceContext;
    let dev_clone = gpu.device.clone();
    (*d3dctx).device = dev_clone.as_raw() as *mut ID3D11Device;
    std::mem::forget(dev_clone);
    averr(av_hwdevice_ctx_init(hwdev), "hwdevice_ctx_init")?;
    (*dctx).hw_device_ctx = av_buffer_ref(hwdev);
    (*dctx).get_format = Some(get_hw_format);
    averr(avcodec_open2(dctx, dec, ptr::null_mut()), "avcodec_open2")?;

    let pkt = av_packet_alloc();
    let frame = av_frame_alloc();
    let mut got: u32 = 0;
    let mut result: *mut AVFrame = ptr::null_mut();

    'outer: loop {
        let r = av_read_frame(fmt, pkt);
        if r == AVERROR_EOF {
            avcodec_send_packet(dctx, ptr::null_mut());
        } else {
            averr(r, "read_frame")?;
            if (*pkt).stream_index != vidx {
                av_packet_unref(pkt);
                continue;
            }
            averr(avcodec_send_packet(dctx, pkt), "send_packet")?;
            av_packet_unref(pkt);
        }
        loop {
            let r = avcodec_receive_frame(dctx, frame);
            if r == AVERROR_EAGAIN || r == AVERROR_EOF {
                if r == AVERROR_EOF {
                    break 'outer;
                }
                break;
            }
            averr(r, "receive_frame")?;
            if got == n {
                result = av_frame_clone(frame); // frame indépendante, garde ses refs textures
                break 'outer;
            }
            got += 1;
        }
    }

    av_frame_free(&mut (frame as *mut _));
    av_packet_free(&mut (pkt as *mut _));
    avcodec_free_context(&mut (dctx as *mut _));
    av_buffer_unref(&mut (hwdev as *mut _));
    avformat_close_input(&mut fmt);

    if result.is_null() {
        bail!("frame {n} introuvable");
    }
    Ok(FrameGuard(result))
}

fn averr(ret: i32, ctx: &str) -> Result<()> {
    if ret < 0 {
        let mut buf = [0i8; 256];
        unsafe { av_strerror(ret, buf.as_mut_ptr(), buf.len()) };
        let msg = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) }.to_string_lossy();
        bail!("{ctx}: {ret} ({msg})");
    }
    Ok(())
}

/// FFmpeg's DXVA/D3D11VA profile table accepts Constrained Baseline, Main and High,
/// but not plain H.264 Baseline. Chrome MediaRecorder emits plain Baseline even when
/// the bitstream uses the same hardware-decodable subset (no FMO/ASO); without this
/// opt-in FFmpeg rejects the profile before asking the D3D11 driver for a decoder.
/// Keep the mismatch allowance restricted to that exact profile rather than weakening
/// validation for every codec/profile handled by this shared decoder path.
unsafe fn allow_d3d11va_h264_baseline(dctx: *mut AVCodecContext) {
    if (*dctx).profile == AV_PROFILE_H264_BASELINE as i32 {
        (*dctx).hwaccel_flags |= AV_HWACCEL_FLAG_ALLOW_PROFILE_MISMATCH as i32;
    }
}

// D3D11_TEXTURE2D_DESC.BindFlags (valeurs SDK)
const D3D11_BIND_SHADER_RESOURCE: u32 = 0x8;
const D3D11_BIND_DECODER: u32 = 0x200;

/// get_format du décodeur : impose la surface D3D11 (§5), sinon ffmpeg retombe en NV12 CPU.
/// Et surtout (§5) : crée un frames-context AVEC BIND_SHADER_RESOURCE, pour que le
/// compositeur HLSL de S3+ échantillonne directement les textures décodeur.
unsafe extern "C" fn get_hw_format(
    ctx: *mut AVCodecContext,
    mut fmts: *const AVPixelFormat::Type,
) -> AVPixelFormat::Type {
    while *fmts != AVPixelFormat::AV_PIX_FMT_NONE {
        if *fmts == AVPixelFormat::AV_PIX_FMT_D3D11 {
            // frames-context manuel : impose BindFlags (sinon ffmpeg met BIND_DECODER seul,
            // et les surfaces ne sont pas échantillonnables → §5).
            let frames = av_hwframe_ctx_alloc((*ctx).hw_device_ctx);
            if frames.is_null() {
                return AVPixelFormat::AV_PIX_FMT_NONE;
            }
            let fc = (*frames).data as *mut AVHWFramesContext;
            (*fc).format = AVPixelFormat::AV_PIX_FMT_D3D11;
            (*fc).sw_format = AVPixelFormat::AV_PIX_FMT_NV12;
            (*fc).width = (*ctx).coded_width;
            (*fc).height = (*ctx).coded_height;
            (*fc).initial_pool_size = 32; // DPB H.264 (refs) + frames en vol
            let d3dfc = (*fc).hwctx as *mut AVD3D11VAFramesContext;
            (*d3dfc).BindFlags = D3D11_BIND_DECODER | D3D11_BIND_SHADER_RESOURCE;
            if av_hwframe_ctx_init(frames) < 0 {
                av_buffer_unref(&mut (frames as *mut _));
                return AVPixelFormat::AV_PIX_FMT_NONE;
            }
            (*ctx).hw_frames_ctx = frames;
            return AVPixelFormat::AV_PIX_FMT_D3D11;
        }
        fmts = fmts.add(1);
    }
    AVPixelFormat::AV_PIX_FMT_NONE
}

pub fn run_c0(screen: &str, out: &str, gpu: &Gpu) -> Result<Stats> {
    unsafe { run_c0_inner(screen, out, gpu) }
}

unsafe fn run_c0_inner(screen: &str, out: &str, gpu: &Gpu) -> Result<Stats> {
    // ---- entrée : demux ----
    let mut fmt: *mut AVFormatContext = ptr::null_mut();
    let cpath = CString::new(screen)?;
    averr(
        avformat_open_input(&mut fmt, cpath.as_ptr(), ptr::null_mut(), ptr::null_mut()),
        "avformat_open_input",
    )?;
    averr(avformat_find_stream_info(fmt, ptr::null_mut()), "find_stream_info")?;

    let vidx = av_find_best_stream(
        fmt,
        AVMediaType::AVMEDIA_TYPE_VIDEO,
        -1,
        -1,
        ptr::null_mut(),
        0,
    );
    if vidx < 0 {
        bail!("aucun flux vidéo");
    }
    let stream = sn_fmt_stream(fmt, vidx);
    let codecpar = (*stream).codecpar;

    // ---- décodeur D3D11VA sur NOTRE device ----
    let dec = avcodec_find_decoder((*codecpar).codec_id);
    if dec.is_null() {
        bail!("décodeur introuvable");
    }
    let dctx = avcodec_alloc_context3(dec);
    averr(avcodec_parameters_to_context(dctx, codecpar), "params_to_ctx")?;
    allow_d3d11va_h264_baseline(dctx);

    let hwdev = av_hwdevice_ctx_alloc(AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA);
    if hwdev.is_null() {
        bail!("av_hwdevice_ctx_alloc");
    }
    let hwdc = (*hwdev).data as *mut AVHWDeviceContext;
    let d3dctx = (*hwdc).hwctx as *mut AVD3D11VADeviceContext;
    // AddRef : ffmpeg Release ce device au teardown. On garde un +1 en fuyant un clone.
    let dev_clone = gpu.device.clone();
    (*d3dctx).device = dev_clone.as_raw() as *mut ID3D11Device;
    std::mem::forget(dev_clone);
    averr(av_hwdevice_ctx_init(hwdev), "hwdevice_ctx_init")?;

    (*dctx).hw_device_ctx = av_buffer_ref(hwdev);
    (*dctx).get_format = Some(get_hw_format);
    averr(avcodec_open2(dctx, dec, ptr::null_mut()), "avcodec_open2(dec)")?;

    // ---- encodeur h264_amf (ouvert paresseusement à la 1re frame, pour hw_frames_ctx) ----
    let enc_name = CString::new("h264_amf")?;
    let enc = avcodec_find_encoder_by_name(enc_name.as_ptr());
    if enc.is_null() {
        bail!("h264_amf introuvable");
    }
    let ectx = avcodec_alloc_context3(enc);

    // ---- sortie : mux MP4 ----
    let mut octx: *mut AVFormatContext = ptr::null_mut();
    let outc = CString::new(out)?;
    averr(
        avformat_alloc_output_context2(&mut octx, ptr::null(), ptr::null(), outc.as_ptr()),
        "alloc_output_context2",
    )?;
    let mut ostream: *mut AVStream = ptr::null_mut();
    let mut encoder_open = false;

    let pkt = av_packet_alloc();
    let opkt = av_packet_alloc();
    let frame = av_frame_alloc();

    let mut frames: u64 = 0;

    // =========== MESURE : plus extérieure possible (§10) ===========
    let t0 = Instant::now();

    // pompe : read → decode → (open enc) → encode → mux
    loop {
        let r = av_read_frame(fmt, pkt);
        if r == AVERROR_EOF {
            break;
        }
        averr(r, "av_read_frame")?;
        if (*pkt).stream_index != vidx {
            av_packet_unref(pkt);
            continue;
        }
        averr(avcodec_send_packet(dctx, pkt), "send_packet")?;
        av_packet_unref(pkt);

        loop {
            let r = avcodec_receive_frame(dctx, frame);
            if r == AVERROR_EAGAIN || r == AVERROR_EOF {
                break;
            }
            averr(r, "receive_frame")?;

            if !encoder_open {
                // config depuis la 1re frame décodée : dims réelles + frames_ctx D3D11
                (*ectx).width = (*frame).width;
                (*ectx).height = (*frame).height;
                (*ectx).pix_fmt = AVPixelFormat::AV_PIX_FMT_D3D11;
                (*ectx).time_base = AVRational { num: 1, den: 60 };
                (*ectx).framerate = AVRational { num: 60, den: 1 };
                (*ectx).bit_rate = 8_000_000;
                (*ectx).hw_frames_ctx = av_buffer_ref((*frame).hw_frames_ctx);
                averr(avcodec_open2(ectx, enc, ptr::null_mut()), "avcodec_open2(enc)")?;

                ostream = avformat_new_stream(octx, ptr::null());
                if ostream.is_null() {
                    bail!("avformat_new_stream");
                }
                averr(
                    avcodec_parameters_from_context((*ostream).codecpar, ectx),
                    "params_from_ctx",
                )?;
                (*ostream).time_base = (*ectx).time_base;
                let mut pb: *mut AVIOContext = ptr::null_mut();
                averr(
                    avio_open(&mut pb, outc.as_ptr(), AVIO_FLAG_WRITE as i32),
                    "avio_open",
                )?;
                sn_fmt_set_pb(octx, pb);
                averr(avformat_write_header(octx, ptr::null_mut()), "write_header")?;
                encoder_open = true;
            }

            (*frame).pts = frames as i64;
            averr(avcodec_send_frame(ectx, frame), "send_frame")?;
            drain_encoder(ectx, octx, ostream, opkt)?;
            frames += 1;
        }
    }

    // flush décodeur → encodeur
    avcodec_send_packet(dctx, ptr::null_mut());
    loop {
        let r = avcodec_receive_frame(dctx, frame);
        if r == AVERROR_EAGAIN || r == AVERROR_EOF {
            break;
        }
        averr(r, "flush receive_frame")?;
        (*frame).pts = frames as i64;
        averr(avcodec_send_frame(ectx, frame), "flush send_frame")?;
        drain_encoder(ectx, octx, ostream, opkt)?;
        frames += 1;
    }
    // flush encodeur
    if encoder_open {
        avcodec_send_frame(ectx, ptr::null_mut());
        drain_encoder(ectx, octx, ostream, opkt)?;
        averr(av_write_trailer(octx), "write_trailer")?;
    }

    let wall_s = t0.elapsed().as_secs_f64();
    // =========== fin mesure ===========

    // teardown
    av_frame_free(&mut (frame as *mut _));
    av_packet_free(&mut (pkt as *mut _));
    av_packet_free(&mut (opkt as *mut _));
    let mut pb = sn_fmt_get_pb(octx);
    if !pb.is_null() {
        avio_closep(&mut pb);
        sn_fmt_set_pb(octx, ptr::null_mut());
    }
    avformat_free_context(octx);
    avcodec_free_context(&mut (ectx as *mut _));
    avcodec_free_context(&mut (dctx as *mut _));
    av_buffer_unref(&mut (hwdev as *mut _));
    avformat_close_input(&mut fmt);

    let fps = frames as f64 / wall_s;
    Ok(Stats { frames, wall_s, fps, video_duration_s: frames as f64 / 60.0 })
}

/// Décodeur qui rend une frame à la fois (pour composer 2 sources en lockstep).
/// `pub(crate)` : réutilisé par la preview/playback (voir `app.rs`).
pub(crate) struct Decoder {
    fmt: *mut AVFormatContext,
    dctx: *mut AVCodecContext,
    hwdev: *mut AVBufferRef,
    vidx: i32,
    pkt: *mut AVPacket,
    frame: *mut AVFrame,
    sent_eof: bool,
}

impl Decoder {
    pub(crate) unsafe fn open(path: &str, gpu: &Gpu) -> Result<Decoder> {
        let mut fmt: *mut AVFormatContext = ptr::null_mut();
        let cpath = CString::new(path)?;
        averr(
            avformat_open_input(&mut fmt, cpath.as_ptr(), ptr::null_mut(), ptr::null_mut()),
            "open_input",
        )?;
        averr(avformat_find_stream_info(fmt, ptr::null_mut()), "find_stream_info")?;
        let vidx = av_find_best_stream(fmt, AVMediaType::AVMEDIA_TYPE_VIDEO, -1, -1, ptr::null_mut(), 0);
        if vidx < 0 {
            bail!("aucun flux vidéo dans {path}");
        }
        let stream = sn_fmt_stream(fmt, vidx);
        let codecpar = (*stream).codecpar;
        let dec = avcodec_find_decoder((*codecpar).codec_id);
        let dctx = avcodec_alloc_context3(dec);
        averr(avcodec_parameters_to_context(dctx, codecpar), "params_to_ctx")?;
        allow_d3d11va_h264_baseline(dctx);

        let hwdev = av_hwdevice_ctx_alloc(AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA);
        let hwdc = (*hwdev).data as *mut AVHWDeviceContext;
        let d3dctx = (*hwdc).hwctx as *mut AVD3D11VADeviceContext;
        let dev_clone = gpu.device.clone();
        (*d3dctx).device = dev_clone.as_raw() as *mut ID3D11Device;
        std::mem::forget(dev_clone);
        averr(av_hwdevice_ctx_init(hwdev), "hwdevice_ctx_init")?;
        (*dctx).hw_device_ctx = av_buffer_ref(hwdev);
        (*dctx).get_format = Some(get_hw_format);
        averr(avcodec_open2(dctx, dec, ptr::null_mut()), "avcodec_open2")?;

        Ok(Decoder {
            fmt,
            dctx,
            hwdev,
            vidx,
            pkt: av_packet_alloc(),
            frame: av_frame_alloc(),
            sent_eof: false,
        })
    }

    /// Dernière frame décodée (valide jusqu'au prochain `next`) — pour recomposer
    /// la frame courante après un changement de config, sans réavancer (preview).
    pub(crate) fn cur_frame(&self) -> *mut AVFrame {
        self.frame
    }

    /// Repositionne le flux à la première keyframe (t=0) et vide le codec — pour boucler
    /// la playback sans réallouer les décodeurs. La fixture démarre sur un IDR (§11).
    pub(crate) unsafe fn rewind(&mut self) -> Result<()> {
        averr(av_seek_frame(self.fmt, self.vidx, 0, AVSEEK_FLAG_BACKWARD), "seek")?;
        avcodec_flush_buffers(self.dctx);
        self.sent_eof = false;
        Ok(())
    }

    /// Time_base du flux vidéo (secondes par unité de pts).
    unsafe fn tb_sec(&self) -> f64 {
        let tb = (*sn_fmt_stream(self.fmt, self.vidx)).time_base;
        if tb.den != 0 { tb.num as f64 / tb.den as f64 } else { 0.0 }
    }

    /// Seek keyframe vers `seconds` puis décode-avant jusqu'à la 1re frame dont le temps
    /// ≥ `seconds`. Réutilise le décodeur ouvert (pas de réouverture) : c'est LE point de
    /// perf multiclip — un seul seek par frontière de clip, décodage séquentiel ensuite,
    /// donc le débit par frame ne change pas. Renvoie la frame (ou null à EOF).
    pub(crate) unsafe fn seek_to(&mut self, seconds: f64) -> Result<*mut AVFrame> {
        let tb_sec = self.tb_sec();
        let target = if tb_sec > 0.0 { (seconds / tb_sec) as i64 } else { 0 };
        averr(av_seek_frame(self.fmt, self.vidx, target, AVSEEK_FLAG_BACKWARD), "seek_to")?;
        avcodec_flush_buffers(self.dctx);
        self.sent_eof = false;
        loop {
            let f = self.next()?;
            if f.is_null() {
                return Ok(ptr::null_mut());
            }
            let pts = (*f).best_effort_timestamp;
            // pas de pts fiable ou pas de time_base → on prend la 1re frame après la keyframe.
            if pts == i64::MIN || tb_sec <= 0.0 {
                return Ok(f);
            }
            if (pts as f64) * tb_sec >= seconds - tb_sec * 0.5 {
                return Ok(f);
            }
        }
    }

    /// Temps (s) de la frame courante, via son pts. 0 si pas de pts fiable.
    pub(crate) unsafe fn cur_time_sec(&self) -> f64 {
        let pts = (*self.frame).best_effort_timestamp;
        if pts == i64::MIN { 0.0 } else { pts as f64 * self.tb_sec() }
    }

    /// Cadence moyenne du flux (fps). 30 par défaut si indéterminée.
    pub(crate) unsafe fn fps(&self) -> f64 {
        let r = (*sn_fmt_stream(self.fmt, self.vidx)).avg_frame_rate;
        if r.den != 0 && r.num != 0 { r.num as f64 / r.den as f64 } else { 30.0 }
    }

    /// Durée réellement annoncée par le flux vidéo. La durée du stream est prioritaire ;
    /// `nb_frames / fps` sert de repli pour les conteneurs qui omettent `duration`.
    pub(crate) unsafe fn available_duration_sec(&self) -> Option<f64> {
        let stream = sn_fmt_stream(self.fmt, self.vidx);
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

    /// Rend la prochaine frame (valide jusqu'au prochain appel), ou null à EOF.
    pub(crate) unsafe fn next(&mut self) -> Result<*mut AVFrame> {
        loop {
            let r = avcodec_receive_frame(self.dctx, self.frame);
            if r == 0 {
                return Ok(self.frame);
            }
            if r == AVERROR_EOF {
                return Ok(ptr::null_mut());
            }
            if r != AVERROR_EAGAIN {
                averr(r, "receive_frame")?;
            }
            if self.sent_eof {
                return Ok(ptr::null_mut());
            }
            let rr = av_read_frame(self.fmt, self.pkt);
            if rr == AVERROR_EOF {
                avcodec_send_packet(self.dctx, ptr::null_mut());
                self.sent_eof = true;
            } else {
                averr(rr, "read_frame")?;
                if (*self.pkt).stream_index == self.vidx {
                    averr(avcodec_send_packet(self.dctx, self.pkt), "send_packet")?;
                }
                av_packet_unref(self.pkt);
            }
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            av_frame_free(&mut self.frame);
            av_packet_free(&mut self.pkt);
            avcodec_free_context(&mut self.dctx);
            av_buffer_unref(&mut self.hwdev);
            avformat_close_input(&mut self.fmt);
        }
    }
}

/// Avance un décodeur jusqu'au premier pts dans le référentiel écran qui atteint la cible.
/// `timeline_offset_sec` remet les pts webcam dans ce référentiel (`webcam + offset = screen`) :
/// chaque source garde ainsi sa cadence propre au lieu d'être consommée 1:1 avec l'autre.
unsafe fn advance_decoder_to(
    decoder: &mut Decoder,
    target_source_time: f64,
    timeline_offset_sec: f64,
) -> Result<bool> {
    loop {
        if decoder.cur_frame().is_null() {
            return Ok(false);
        }
        if decoder.cur_time_sec() + timeline_offset_sec >= target_source_time {
            return Ok(true);
        }
        if decoder.next()?.is_null() {
            return Ok(false);
        }
    }
}

/// Frames-context de l'encodeur : NV12 sur notre device, bind RENDER_TARGET (§5) pour
/// que le compositeur rende directement dans les surfaces de l'encodeur.
unsafe fn make_enc_frames(gpu: &Gpu, w: i32, h: i32) -> Result<(*mut AVBufferRef, *mut AVBufferRef)> {
    let hwdev = av_hwdevice_ctx_alloc(AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA);
    let hwdc = (*hwdev).data as *mut AVHWDeviceContext;
    let d3dctx = (*hwdc).hwctx as *mut AVD3D11VADeviceContext;
    let dev_clone = gpu.device.clone();
    (*d3dctx).device = dev_clone.as_raw() as *mut ID3D11Device;
    std::mem::forget(dev_clone);
    averr(av_hwdevice_ctx_init(hwdev), "enc hwdevice init")?;

    let frames = av_hwframe_ctx_alloc(hwdev);
    let fc = (*frames).data as *mut AVHWFramesContext;
    (*fc).format = AVPixelFormat::AV_PIX_FMT_D3D11;
    (*fc).sw_format = AVPixelFormat::AV_PIX_FMT_NV12;
    (*fc).width = w;
    (*fc).height = h;
    (*fc).initial_pool_size = 32; // l'encodeur AMF garde plusieurs frames en vol
    // NV12 array + RENDER_TARGET refusé par ce driver ; NV12 array sans bind aussi.
    // Le combo array qui marche (prouvé par C0) = DECODER|SHADER_RESOURCE. On rend dans
    // notre propre NV12 simple (RT) puis CopySubresourceRegion vers ce pool. GPU->GPU.
    let d3dfc = (*fc).hwctx as *mut AVD3D11VAFramesContext;
    (*d3dfc).BindFlags = D3D11_BIND_DECODER | D3D11_BIND_SHADER_RESOURCE;
    averr(av_hwframe_ctx_init(frames), "enc frames init")?;
    Ok((hwdev, frames))
}

/// C1..C8 (§9) : composite 2 sources → encode, effets gatés par `cfg`. Mesuré au plus extérieur (§10).
/// `progress(frames_encodées)` est appelé à chaque frame — no-op côté bench (mesure inchangée),
/// alimente la barre de progression côté GUI. La mesure reste enveloppante (§10) : la sonde est
/// un simple `SendMessage` throttlé (µs), négligeable devant ~8 ms/frame GPU.
pub fn run_composited(
    screen: &str,
    webcam: &str,
    out: &str,
    gpu: &Gpu,
    comp: &Compositor,
    cfg: &Cfg,
    progress: &mut dyn FnMut(u64),
) -> Result<Stats> {
    unsafe { run_c1_inner(screen, webcam, out, gpu, comp, cfg, progress) }
}

unsafe fn run_c1_inner(
    screen: &str,
    webcam: &str,
    out: &str,
    gpu: &Gpu,
    comp: &Compositor,
    cfg: &Cfg,
    progress: &mut dyn FnMut(u64),
) -> Result<Stats> {
    let mut sdec = Decoder::open(screen, gpu)?;
    let mut wdec = Decoder::open(webcam, gpu)?;
    let (mut enc_hwdev, mut enc_frames) = make_enc_frames(gpu, OUT_W as i32, OUT_H as i32)?;

    let enc_name = CString::new("h264_amf")?;
    let enc = avcodec_find_encoder_by_name(enc_name.as_ptr());
    if enc.is_null() {
        bail!("h264_amf introuvable");
    }
    let ectx = avcodec_alloc_context3(enc);
    (*ectx).width = OUT_W as i32;
    (*ectx).height = OUT_H as i32;
    (*ectx).pix_fmt = AVPixelFormat::AV_PIX_FMT_D3D11;
    (*ectx).time_base = AVRational { num: 1, den: 60 };
    (*ectx).framerate = AVRational { num: 60, den: 1 };
    (*ectx).bit_rate = 8_000_000;
    (*ectx).hw_frames_ctx = av_buffer_ref(enc_frames);
    averr(avcodec_open2(ectx, enc, ptr::null_mut()), "avcodec_open2(enc)")?;

    let mut octx: *mut AVFormatContext = ptr::null_mut();
    let outc = CString::new(out)?;
    averr(
        avformat_alloc_output_context2(&mut octx, ptr::null(), ptr::null(), outc.as_ptr()),
        "alloc_output_context2",
    )?;
    let ostream = avformat_new_stream(octx, ptr::null());
    averr(avcodec_parameters_from_context((*ostream).codecpar, ectx), "params_from_ctx")?;
    (*ostream).time_base = (*ectx).time_base;
    let mut pb: *mut AVIOContext = ptr::null_mut();
    averr(avio_open(&mut pb, outc.as_ptr(), AVIO_FLAG_WRITE as i32), "avio_open")?;
    sn_fmt_set_pb(octx, pb);
    averr(avformat_write_header(octx, ptr::null_mut()), "write_header")?;

    let opkt = av_packet_alloc();
    let mut frames: u64 = 0;

    let t0 = Instant::now();
    loop {
        let sf = sdec.next()?;
        if sf.is_null() {
            break;
        }
        let wf = wdec.next()?;
        if wf.is_null() {
            break;
        }
        comp.compose_frame(sf, wf, frames as f32, cfg)?;

        let outf = av_frame_alloc();
        averr(av_hwframe_get_buffer(enc_frames, outf, 0), "hwframe_get_buffer")?;
        let out_tex = (*outf).data[0] as *mut c_void;
        let out_slice = (*outf).data[1] as u32;
        comp.rgb_to_nv12(out_tex, out_slice)?;
        (*outf).pts = frames as i64;
        averr(avcodec_send_frame(ectx, outf), "send_frame")?;
        drain_encoder(ectx, octx, ostream, opkt)?;
        av_frame_free(&mut (outf as *mut _));
        frames += 1;
        progress(frames);
    }

    avcodec_send_frame(ectx, ptr::null_mut());
    drain_encoder(ectx, octx, ostream, opkt)?;
    averr(av_write_trailer(octx), "write_trailer")?;

    let wall_s = t0.elapsed().as_secs_f64();

    av_packet_free(&mut (opkt as *mut _));
    let mut pb2 = sn_fmt_get_pb(octx);
    if !pb2.is_null() {
        avio_closep(&mut pb2);
        sn_fmt_set_pb(octx, ptr::null_mut());
    }
    avformat_free_context(octx);
    avcodec_free_context(&mut (ectx as *mut _));
    av_buffer_unref(&mut enc_frames);
    av_buffer_unref(&mut enc_hwdev);

    let fps = frames as f64 / wall_s;
    Ok(Stats { frames, wall_s, fps, video_duration_s: frames as f64 / 60.0 })
}

/// Une source de clip pour l'export multiclip : fichiers screen+webcam + fenêtre source
/// (trim, en secondes). `webcam_offset_sec` : temps source webcam = temps source screen - offset.
pub struct ClipSource {
    pub screen: String,
    pub webcam: String,
    pub source_start_sec: f64,
    pub source_end_sec: f64,
    pub webcam_offset_sec: f64,
    pub has_audio: bool,
}

/// Export **multiclip** : rend la timeline (clips ordonnés, avec trims) en un seul MP4.
/// Perf (contrainte §multiclip) : décodeurs ouverts une fois par source (cache) et réutilisés
/// entre clips du même asset ; **un seul seek keyframe par frontière de clip** ; décodage
/// séquentiel dans le clip → coût/frame identique au mono-clip (~120fps préservés).
pub fn run_composited_multi(
    clips: &[ClipSource],
    out: &str,
    gpu: &Gpu,
    comp: &Compositor,
    cfg: &Cfg,
    params: &ExportParams,
    progress: &mut dyn FnMut(u64),
) -> Result<Stats> {
    unsafe { run_multi_inner(clips, out, gpu, comp, cfg, params, progress) }
}

/// Codec vidéo de sortie — mappé sur un encodeur matériel AMF (même famille que h264_amf,
/// déjà mesuré). VP9 a été essayé via un chemin logiciel (libvpx-vp9, pas d'équivalent
/// matériel AMF sur cet iGPU) mais retiré : trop lent pour être utile en pratique sur ce
/// matériel, pas la peine de maintenir ce chemin. Choisir VP9 échoue avec un message clair
/// plutôt que de silencieusement retomber sur H264.
pub enum ExportCodec {
    H264,
    H265,
}

impl ExportCodec {
    fn encoder_name(&self) -> &'static str {
        match self {
            ExportCodec::H264 => "h264_amf",
            ExportCodec::H265 => "hevc_amf",
        }
    }
}

/// Résolution/cadence/codec de sortie. `fps: None` = dérivé du 1er clip (comportement
/// historique) ; `width`/`height` doivent être pairs (NV12 4:2:0) — l'appelant napi arrondit.
pub struct ExportParams {
    pub width: u32,
    pub height: u32,
    pub fps: Option<u32>,
    pub codec: ExportCodec,
}

impl Default for ExportParams {
    fn default() -> Self {
        Self { width: OUT_W, height: OUT_H, fps: None, codec: ExportCodec::H264 }
    }
}

unsafe fn run_multi_inner(
    clips: &[ClipSource],
    out: &str,
    gpu: &Gpu,
    comp: &Compositor,
    cfg: &Cfg,
    params: &ExportParams,
    progress: &mut dyn FnMut(u64),
) -> Result<Stats> {
    if clips.is_empty() {
        bail!("aucun clip à exporter");
    }
    let (out_w, out_h) = (params.width, params.height);
    // décodeurs ouverts une fois par chemin, réutilisés entre clips (screen ≠ webcam → 2 maps
    // pour deux &mut indépendants).
    let mut screen_decs: HashMap<String, Decoder> = HashMap::new();
    let mut webcam_decs: HashMap<String, Decoder> = HashMap::new();

    // fps de sortie : choix explicite de l'app si fourni, sinon dérivé du 1er clip (recordings
    // uniformes) — comportement historique.
    screen_decs.insert(clips[0].screen.clone(), Decoder::open(&clips[0].screen, gpu)?);
    let out_fps = params
        .fps
        .unwrap_or_else(|| screen_decs[&clips[0].screen].fps().round().max(1.0) as u32)
        as i32;

    // Curseur : la scène (déjà posée par l'appelant via comp.set_scene) pilote tout — même
    // parité que le live. Piste par chemin ÉCRAN distinct (convention sidecar `<screen>.cursor.json`,
    // temps ABSOLU non re-basé : chaque décodeur avance dans le même référentiel que la piste).
    let scene = comp.scene_snapshot();
    let cursor_enabled = scene.as_ref().map(|s| s.cursor.show).unwrap_or(false);
    let cursor_smoothing = scene.as_ref().map(|s| s.cursor.smoothing).unwrap_or(0.0);
    let mut cursor_tracks: HashMap<String, CursorTrack> = HashMap::new();
    let mut cursor_active_path: Option<String> = None;

    // ---- encodeur (h264/h265 AMF) + mux, à la taille/cadence demandées ----
    let (mut enc_hwdev, mut enc_frames) = make_enc_frames(gpu, out_w as i32, out_h as i32)?;
    let enc_name_str = params.codec.encoder_name();
    let enc_name = CString::new(enc_name_str)?;
    let enc = avcodec_find_encoder_by_name(enc_name.as_ptr());
    if enc.is_null() {
        bail!("{enc_name_str} introuvable");
    }
    let ectx = avcodec_alloc_context3(enc);
    (*ectx).width = out_w as i32;
    (*ectx).height = out_h as i32;
    (*ectx).pix_fmt = AVPixelFormat::AV_PIX_FMT_D3D11;
    (*ectx).time_base = AVRational { num: 1, den: out_fps };
    (*ectx).framerate = AVRational { num: out_fps, den: 1 };
    // proportionnel à la surface de sortie (référence : 8Mbps @ 1920x1080), plancher 2Mbps
    // pour rester regardable sur les petites tailles.
    (*ectx).bit_rate =
        ((out_w as i64 * out_h as i64 * 8_000_000) / (1920 * 1080)).max(2_000_000);
    (*ectx).hw_frames_ctx = av_buffer_ref(enc_frames);
    averr(avcodec_open2(ectx, enc, ptr::null_mut()), "avcodec_open2(enc)")?;

    let mut octx: *mut AVFormatContext = ptr::null_mut();
    let outc = CString::new(out)?;
    averr(
        avformat_alloc_output_context2(&mut octx, ptr::null(), ptr::null(), outc.as_ptr()),
        "alloc_output_context2",
    )?;
    let ostream = avformat_new_stream(octx, ptr::null());
    if ostream.is_null() {
        bail!("video avformat_new_stream");
    }
    averr(avcodec_parameters_from_context((*ostream).codecpar, ectx), "params_from_ctx")?;
    (*ostream).time_base = (*ectx).time_base;
    // Les deux streams doivent exister avant le header MP4 ; l'AAC reste ouvert pendant le
    // rendu puis reçoit le PCM assemblé à partir des comptes de frames réellement produits.
    let mut audio_encoder = AacEncoder::open(octx)?;
    let mut pb: *mut AVIOContext = ptr::null_mut();
    averr(avio_open(&mut pb, outc.as_ptr(), AVIO_FLAG_WRITE as i32), "avio_open")?;
    sn_fmt_set_pb(octx, pb);
    averr(avformat_write_header(octx, ptr::null_mut()), "write_header")?;

    let opkt = av_packet_alloc();
    let mut frames: u64 = 0;
    let mut clip_frame_counts = vec![0u64; clips.len()];
    let mut clip_pcm: Vec<Option<PlanarPcm>> =
        std::iter::repeat_with(|| None).take(clips.len()).collect();
    let t0 = Instant::now();

    for (clip_index, clip) in clips.iter().enumerate() {
        if !screen_decs.contains_key(&clip.screen) {
            screen_decs.insert(clip.screen.clone(), Decoder::open(&clip.screen, gpu)?);
        }
        if !webcam_decs.contains_key(&clip.webcam) {
            webcam_decs.insert(clip.webcam.clone(), Decoder::open(&clip.webcam, gpu)?);
        }
        let sdec = screen_decs.get_mut(&clip.screen).unwrap();
        let wdec = webcam_decs.get_mut(&clip.webcam).unwrap();

        let screen_available_duration = sdec.available_duration_sec();
        let webcam_available_duration = wdec.available_duration_sec();
        if screen_available_duration.is_none() || webcam_available_duration.is_none() {
            eprintln!(
                "[pipeline] warning: clip #{}: durée de flux indéterminée (screen={}, webcam={}); la borne demandée {:.3}s ne peut pas être entièrement validée",
                clip_index,
                screen_available_duration
                    .map(|v| format!("{v:.3}s"))
                    .unwrap_or_else(|| "inconnue".to_string()),
                webcam_available_duration
                    .map(|v| format!("{v:.3}s"))
                    .unwrap_or_else(|| "inconnue".to_string()),
                clip.source_end_sec,
            );
        }
        // Les bornes de clip sont en temps écran. La disponibilité webcam est donc translatée
        // par le même offset que le seek (`webcam_time = screen_time - offset`).
        let webcam_available_screen_end =
            webcam_available_duration.map(|duration| duration + clip.webcam_offset_sec);
        let mut source_end_sec = clip.source_end_sec;
        if let Some(duration) = screen_available_duration {
            source_end_sec = source_end_sec.min(duration);
        }
        if let Some(duration) = webcam_available_screen_end {
            source_end_sec = source_end_sec.min(duration);
        }
        if source_end_sec + 1e-6 < clip.source_end_sec {
            eprintln!(
                "[pipeline] warning: clip #{} raccourci de {:.3}s (fin demandée {:.3}s, fin disponible {:.3}s; screen=\"{}\", webcam=\"{}\")",
                clip_index,
                clip.source_end_sec - source_end_sec,
                clip.source_end_sec,
                source_end_sec,
                clip.screen,
                clip.webcam,
            );
        }
        if source_end_sec <= clip.source_start_sec {
            continue;
        }

        let clip_scene = scene.as_ref().map(|base_scene| {
            base_scene.for_clip_window(clip_index, clip.source_start_sec, source_end_sec)
        });
        let speed_segments = speed_segments_for_window(
            clip_scene
                .as_ref()
                .map(|s| s.speed_regions.as_slice())
                .unwrap_or(&[]),
            clip.source_start_sec,
            source_end_sec,
            out_fps as f64,
        );
        if clip_scene.is_some() {
            comp.set_scene(clip_scene);
        }

        // un seul seek keyframe, puis chaque décodeur avance selon son propre pts jusqu'aux
        // temps source demandés par les spans de vitesse.
        if sdec.seek_to(clip.source_start_sec)?.is_null() {
            continue; // clip vide / au-delà de la source
        }
        if wdec
            .seek_to((clip.source_start_sec - clip.webcam_offset_sec).max(0.0))?
            .is_null()
        {
            continue;
        }

        if cursor_enabled {
            if !cursor_tracks.contains_key(&clip.screen) {
                let path = format!("{}.cursor.json", clip.screen);
                if let Ok(raw) = CursorTrack::load(&path, 0.0, 24.0 * 3600.0) {
                    cursor_tracks.insert(clip.screen.clone(), raw.smoothed(cursor_smoothing));
                }
                // absente/illisible → pas d'entrée : ce clip s'exporte sans curseur (visible,
                // pas masqué en un curseur fantôme d'un autre clip).
            }
            if cursor_active_path.as_deref() != Some(clip.screen.as_str()) {
                if let Some(track) = cursor_tracks.get(&clip.screen) {
                    comp.set_cursor(track.clone());
                    cursor_active_path = Some(clip.screen.clone());
                } else {
                    comp.clear_cursor();
                    comp.set_cursor_time(None);
                    cursor_active_path = None;
                }
            }
        }

        let frames_before_clip = frames;
        'clip_frames: for segment in &speed_segments {
            for segment_frame in 0..segment.frame_count {
                let target_source_time = segment.start_sec
                    + segment_frame as f64 * segment.speed / out_fps as f64;
                if !advance_decoder_to(sdec, target_source_time, 0.0)? {
                    break 'clip_frames;
                }
                if !advance_decoder_to(
                    wdec,
                    target_source_time,
                    clip.webcam_offset_sec,
                )? {
                    break 'clip_frames;
                }
                let sf = sdec.cur_frame();
                let wf = wdec.cur_frame();
                if sf.is_null() || wf.is_null() {
                    break 'clip_frames;
                }

                comp.set_timeline_time(Some(target_source_time as f32));
                if cursor_enabled && cursor_active_path.is_some() {
                    comp.set_cursor_time(Some(target_source_time as f32));
                }
                comp.compose_frame(sf, wf, frames as f32, cfg)?;

                let outf = av_frame_alloc();
                averr(av_hwframe_get_buffer(enc_frames, outf, 0), "hwframe_get_buffer")?;
                let out_tex = (*outf).data[0] as *mut c_void;
                let out_slice = (*outf).data[1] as u32;
                comp.rgb_to_nv12_scaled(out_w, out_h, out_tex, out_slice)?;
                (*outf).pts = frames as i64;
                averr(avcodec_send_frame(ectx, outf), "send_frame")?;
                drain_encoder(ectx, octx, ostream, opkt)?;
                av_frame_free(&mut (outf as *mut _));
                frames += 1;
                progress(frames);
            }
        }
        clip_frame_counts[clip_index] = frames - frames_before_clip;
        if clip.has_audio && clip_frame_counts[clip_index] > 0 {
            match decode_clip_audio(&clip.screen, clip.source_start_sec, source_end_sec) {
                Ok(Some(pcm)) => {
                    clip_pcm[clip_index] = Some(stretch_clip_pcm_by_speed(
                        &pcm,
                        &speed_segments,
                        out_fps as f64,
                    ));
                }
                Ok(None) => eprintln!(
                    "[pipeline] warning: clip #{} déclaré audio mais sans flux décodable; silence conservé",
                    clip_index,
                ),
                Err(error) => eprintln!(
                    "[pipeline] warning: décodage audio du clip #{} échoué ({error:#}); silence conservé",
                    clip_index,
                ),
            }
        }
    }

    comp.set_cursor_time(None);
    comp.set_timeline_time(None);
    comp.set_scene(scene);

    avcodec_send_frame(ectx, ptr::null_mut());
    drain_encoder(ectx, octx, ostream, opkt)?;

    let declared_audio: Vec<bool> = clips.iter().map(|clip| clip.has_audio).collect();
    let audio_plan = build_audio_concat_plan(
        &clip_frame_counts,
        &declared_audio,
        out_fps as f64,
    );
    let assembled_audio = assemble_concatenated_pcm(&clip_pcm, &audio_plan);
    audio_encoder.encode(&assembled_audio, octx)?;

    averr(av_write_trailer(octx), "write_trailer")?;
    let wall_s = t0.elapsed().as_secs_f64();

    // teardown (les décodeurs du cache sont droppés en fin de scope).
    av_packet_free(&mut (opkt as *mut _));
    let mut pb2 = sn_fmt_get_pb(octx);
    if !pb2.is_null() {
        avio_closep(&mut pb2);
        sn_fmt_set_pb(octx, ptr::null_mut());
    }
    avformat_free_context(octx);
    avcodec_free_context(&mut (ectx as *mut _));
    av_buffer_unref(&mut enc_frames);
    av_buffer_unref(&mut enc_hwdev);

    let fps = frames as f64 / wall_s;
    Ok(Stats { frames, wall_s, fps, video_duration_s: frames as f64 / out_fps as f64 })
}

unsafe fn drain_encoder(
    ectx: *mut AVCodecContext,
    octx: *mut AVFormatContext,
    ostream: *mut AVStream,
    opkt: *mut AVPacket,
) -> Result<()> {
    loop {
        let r = avcodec_receive_packet(ectx, opkt);
        if r == AVERROR_EAGAIN || r == AVERROR_EOF {
            return Ok(());
        }
        averr(r, "receive_packet")?;
        (*opkt).stream_index = (*ostream).index;
        av_packet_rescale_ts(opkt, (*ectx).time_base, (*ostream).time_base);
        averr(
            av_interleaved_write_frame(octx, opkt),
            "interleaved_write_frame",
        )
        .map_err(|e| anyhow!("{e}"))?;
        av_packet_unref(opkt);
    }
}

/// Nombre de frames du flux vidéo (borne de la barre de progression export). `nb_frames`
/// si présent (le cas de la fixture MP4), sinon estimé par durée × cadence, sinon fallback.
pub fn probe_frame_count(path: &str) -> Result<u64> {
    unsafe {
        let mut fmt: *mut AVFormatContext = ptr::null_mut();
        let cpath = CString::new(path)?;
        averr(
            avformat_open_input(&mut fmt, cpath.as_ptr(), ptr::null_mut(), ptr::null_mut()),
            "open_input",
        )?;
        averr(avformat_find_stream_info(fmt, ptr::null_mut()), "find_stream_info")?;
        let vidx = av_find_best_stream(fmt, AVMediaType::AVMEDIA_TYPE_VIDEO, -1, -1, ptr::null_mut(), 0);
        let mut n: u64 = 0;
        if vidx >= 0 {
            let stream = sn_fmt_stream(fmt, vidx);
            let nb = (*stream).nb_frames;
            if nb > 0 {
                n = nb as u64;
            } else {
                let afr = (*stream).avg_frame_rate;
                let dur = (*stream).duration;
                let tb = (*stream).time_base;
                if afr.num != 0 && afr.den != 0 && dur > 0 && tb.den != 0 {
                    let secs = dur as f64 * tb.num as f64 / tb.den as f64;
                    n = (secs * afr.num as f64 / afr.den as f64).round() as u64;
                }
            }
        }
        avformat_close_input(&mut fmt);
        if n == 0 {
            n = crate::compositor::FIXTURE_FRAMES as u64;
        }
        Ok(n)
    }
}
