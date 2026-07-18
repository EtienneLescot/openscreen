//! C0 (§9) : décode D3D11VA (screen) → encode h264_amf → mux MP4, sur NOTRE device.
//! Aucun composite. Mesuré au plus extérieur (§10) : Instant (mappe QPC) autour de
//! tout le run, deux lectures seulement. Rien dans la boucle ne peut fausser le fps.

use crate::compositor::{Compositor, OUT_H, OUT_W};
use crate::config::Cfg;
use crate::d3d::Gpu;
use crate::ffi::*;
use anyhow::{anyhow, bail, Result};
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
    Ok(Stats { frames, wall_s, fps })
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
    Ok(Stats { frames, wall_s, fps })
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
        (*opkt).stream_index = 0;
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
