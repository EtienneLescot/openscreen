//! C0 (§9) : décode D3D11VA (screen) → encode h264_amf → mux MP4, sur NOTRE device.
//! Aucun composite. Mesuré au plus extérieur (§10) : Instant (mappe QPC) autour de
//! tout le run, deux lectures seulement. Rien dans la boucle ne peut fausser le fps.

use crate::audio::{
    assemble_concatenated_pcm, build_audio_concat_plan, decode_clip_audio, finish_audio,
    stretch_clip_pcm_by_speed, AacEncoder, PlanarPcm,
};
use crate::compositor::{Compositor, OUT_H, OUT_W};
use crate::config::Cfg;
use crate::cpu_frames::CpuFrames;
use crate::cursor::CursorTrack;
use crate::d3d::{Backend, Gpu};
use crate::ffi::*;
use crate::regions::{speed_segments_for_window, SpeedSegment};
use crate::scene::Scene;
// `walk_composited_timeline` / `advance_decoder_to` vivaient ici ; ils sont
// portables et servent aussi au pipeline macOS et à `gif_export` — voir
// `timeline_walk.rs` pour le pourquoi du déplacement.
use crate::timeline_walk::{walk_composited_timeline, NextFrameTime};
use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::ffi::{c_void, CString};
use std::ptr;
use std::time::Instant;
use windows::core::Interface;

// Macros libav non générées par bindgen (function-like). Valeurs Windows/MSVC.
// `AVERROR(EAGAIN)` dépend de la plateforme (cf. `crate::ffi`) ; ce fichier est
// Windows-only, mais garder une troisième copie de la valeur est ce qui a laissé
// le port macOS naître avec la mauvaise.
use crate::ffi::{AVERROR_EAGAIN, AVERROR_EOF};
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
    discard_partial_output(out, unsafe { run_c0_inner(screen, out, gpu) })
}

/// Un run interrompu laisse le MP4 sans son `moov` : illisible, et portant exactement le nom du
/// fichier que l'utilisateur croit avoir exporté. Le retirer plutôt que le laisser traîner.
///
/// Posé sur les façades plutôt que sur chaque `?` : les `*_inner` sortent par une trentaine de
/// points, tous concernés de la même façon.
///
/// ponytail: seul le fichier est nettoyé ; les contextes ffmpeg alloués dans les `*_inner` fuient
/// toujours sur ces sorties-là (il faudrait une garde RAII par pointeur, comme `FrameGuard`).
/// Un export raté est rare et ne boucle pas — à reprendre si ça devient un mode de marche.
fn discard_partial_output(out: &str, result: Result<Stats>) -> Result<Stats> {
    if result.is_err() {
        let _ = std::fs::remove_file(out);
    }
    result
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

    // ---- encodeur (ouvert paresseusement à la 1re frame : il lui faut ses dims + hw_frames_ctx) ----
    let mut enc: Option<VideoEncoder> = None;
    let mut ectx: *mut AVCodecContext = ptr::null_mut();

    // ---- sortie : mux MP4 ----
    let mut octx: *mut AVFormatContext = ptr::null_mut();
    let outc = CString::new(out)?;
    averr(
        avformat_alloc_output_context2(&mut octx, ptr::null(), ptr::null(), outc.as_ptr()),
        "alloc_output_context2",
    )?;
    let mut ostream: *mut AVStream = ptr::null_mut();

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

            if enc.is_none() {
                // config depuis la 1re frame décodée : dims réelles + frames_ctx D3D11
                let opened = VideoEncoder::open(
                    &ExportCodec::H264,
                    (*frame).width,
                    (*frame).height,
                    60,
                    8_000_000,
                    (*frame).hw_frames_ctx,
                )?;
                ectx = opened.ctx;
                enc = Some(opened);

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
            }

            (*frame).pts = frames as i64;
            enc.as_mut().unwrap().send(frame)?;
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
        let Some(encoder) = enc.as_mut() else {
            bail!("flush : première frame reçue au flush, encodeur jamais ouvert");
        };
        (*frame).pts = frames as i64;
        encoder.send(frame)?;
        drain_encoder(ectx, octx, ostream, opkt)?;
        frames += 1;
    }
    // flush encodeur
    if let Some(encoder) = enc.as_mut() {
        encoder.send(ptr::null_mut())?;
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
    // `enc` est libéré par son Drop en fin de portée (voir run_multi_inner).
    avcodec_free_context(&mut (dctx as *mut _));
    av_buffer_unref(&mut (hwdev as *mut _));
    avformat_close_input(&mut fmt);

    let fps = frames as f64 / wall_s;
    Ok(Stats { frames, wall_s, fps, video_duration_s: frames as f64 / 60.0 })
}

/// Boucle de PREVIEW mesurée : décode → compose → readback, sans encodeur.
///
/// Pourquoi pas `run_composited` : celui-ci encode en h264_amf, qui exige le vrai GPU.
/// Le backend CPU ne peut donc pas le traverser, et les deux backends ne seraient pas
/// comparables. L'encodage est de toute façon un TROISIÈME axe (comme le rendu et le
/// décodage) et il n'a pas de repli logiciel ici — ce qui fait de la preview la seule
/// surface que le backend CPU vise réellement. C'est exactement ce que cette boucle mesure,
/// et c'est la même séquence que le thread de rendu de `live.rs`.
///
/// `frames` = nombre de frames composées ; la source boucle (`seek_to(0)`) si elle est
/// plus courte, pour que les deux backends voient exactement la même charge.
///
/// Rend aussi le DERNIER readback (`w`, `h`, RGBA8) : un backend qui compose du noir
/// serait rapide et parfaitement inutile, donc le chiffre ne veut rien dire sans l'image
/// qui va avec. C'est ce qui permet de comparer pixel à pixel les deux backends.
pub fn run_preview_bench(
    screen: &str,
    webcam: &str,
    gpu: &Gpu,
    comp: &Compositor,
    cfg: &Cfg,
    frames: u64,
) -> Result<(Stats, (u32, u32, Vec<u8>))> {
    unsafe {
        let mut sdec = Decoder::open(screen, gpu)?;
        let mut wdec = Decoder::open(webcam, gpu)?;

        // Hors mesure : première frame de chaque source. Le premier décodage porte
        // l'allocation du pool (matériel) ou de la texture NV12 + du contexte swscale
        // (CPU) ; le compter fausserait surtout les runs courts.
        let mut sf = sdec.next()?;
        let mut wf = wdec.next()?;
        if sf.is_null() || wf.is_null() {
            bail!("source vide (screen ou webcam ne rend aucune frame)");
        }
        comp.compose_frame(sf, wf, 0.0, cfg)?;
        let _ = comp.readback_direct()?;

        let mut last = (0u32, 0u32, Vec::new());
        let t0 = Instant::now();
        for i in 0..frames {
            sf = sdec.next()?;
            if sf.is_null() {
                sf = sdec.seek_to(0.0)?;
            }
            wf = wdec.next()?;
            if wf.is_null() {
                wf = wdec.seek_to(0.0)?;
            }
            if sf.is_null() || wf.is_null() {
                bail!("source épuisée après rembobinage à la frame {i}");
            }
            comp.compose_frame(sf, wf, i as f32, cfg)?;
            // Le readback fait partie de la mesure : c'est ce que la preview paie
            // réellement pour afficher une frame (GPU→CPU puis canvas).
            last = comp.readback_direct()?;
        }
        let wall_s = t0.elapsed().as_secs_f64();

        Ok((
            Stats {
                frames,
                wall_s,
                fps: frames as f64 / wall_s,
                video_duration_s: frames as f64 / 60.0,
            },
            last,
        ))
    }
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
    /// PTS de la frame actuellement décodée dans `frame`, ou `None` si l'état du décodeur
    /// vient d'être jeté (ouverture, seek). Sert au chemin rapide de `seek_to` : sans lui,
    /// impossible de savoir si `frame` contient quoi que ce soit d'exploitable — un
    /// `AVFrame` fraîchement alloué a un `best_effort_timestamp` indéterminé.
    cur_pts: Option<i64>,
    /// Backend CPU uniquement : convertit la frame système en texture NV12 et la présente
    /// sous le même contrat que D3D11VA (voir `cpu_frames`). `None` en matériel — le
    /// décodeur rend alors directement la texture du pool D3D11VA, sans copie.
    cpu: Option<CpuFrames>,
    /// Buffer de lookahead pour `peek_next_time_sec` : symétrique de
    /// `pipeline_macos::Decoder::peek_frame`. Cf. là-bas pour la justification.
    peek_frame: *mut AVFrame,
    /// `true` si `peek_frame` porte une frame décodée en attente de `commit_peek`.
    has_peek: bool,
}

// SAFETY: `Decoder` only owns FFI pointers into FFmpeg's own heap-allocated state, which
// has no OS thread affinity — safe to create on one thread and hand off to another as long
// as it's touched from a single thread at a time (never concurrently), which is exactly the
// live-preview prefetch pattern in `live.rs`: a background thread opens+seeks a `Decoder`,
// then sends it across a channel to the render thread, which alone uses it from then on.
unsafe impl Send for Decoder {}

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

        // Backend CPU : on n'attache AUCUN hw_device_ctx et on ne force pas `get_format`,
        // donc libavcodec choisit son décodeur logiciel et sort en mémoire système. Passer
        // le device WARP à D3D11VA ne marcherait pas de toute façon — WARP n'expose pas
        // d'`ID3D11VideoDevice` (`tests/warp_device_cannot_decode.rs`).
        let cpu = if gpu.backend == Backend::Cpu {
            // `threads = 0` : libavcodec prend le nombre de cœurs. C'est le seul réglage
            // qui compte vraiment ici — sans lui le décodage logiciel est mono-thread et
            // le benchmark mesurerait surtout ça.
            (*dctx).thread_count = 0;
            Some(CpuFrames::new(gpu)?)
        } else {
            None
        };

        let hwdev = if cpu.is_some() {
            ptr::null_mut()
        } else {
            let hwdev = av_hwdevice_ctx_alloc(AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA);
            let hwdc = (*hwdev).data as *mut AVHWDeviceContext;
            let d3dctx = (*hwdc).hwctx as *mut AVD3D11VADeviceContext;
            let dev_clone = gpu.device.clone();
            (*d3dctx).device = dev_clone.as_raw() as *mut ID3D11Device;
            std::mem::forget(dev_clone);
            averr(av_hwdevice_ctx_init(hwdev), "hwdevice_ctx_init")?;
            (*dctx).hw_device_ctx = av_buffer_ref(hwdev);
            (*dctx).get_format = Some(get_hw_format);
            hwdev
        };
        averr(avcodec_open2(dctx, dec, ptr::null_mut()), "avcodec_open2")?;

        Ok(Decoder {
            fmt,
            dctx,
            hwdev,
            vidx,
            pkt: av_packet_alloc(),
            frame: av_frame_alloc(),
            sent_eof: false,
            cur_pts: None,
            cpu,
            peek_frame: av_frame_alloc(),
            has_peek: false,
        })
    }

    /// Dernière frame décodée (valide jusqu'au prochain `next`) — pour recomposer
    /// la frame courante après un changement de config, sans réavancer (preview).
    ///
    /// En backend CPU c'est la frame de PRÉSENTATION (la texture NV12 uploadée), pas la
    /// frame système du décodeur : `cur_frame` alimente `compose_frame` au même titre que
    /// `next`, donc les deux doivent rendre la même chose. Le temps (`cur_time_sec`), lui,
    /// continue de se lire sur la vraie frame décodée.
    pub(crate) fn cur_frame(&self) -> *mut AVFrame {
        match &self.cpu {
            Some(cpu) => cpu.current(),
            None => self.frame,
        }
    }

    /// Repositionne le flux à la première keyframe (t=0) et vide le codec — pour boucler
    /// la playback sans réallouer les décodeurs. La fixture démarre sur un IDR (§11).
    pub(crate) unsafe fn rewind(&mut self) -> Result<()> {
        // Même règle que `seek_to` : tout repositionnement invalide le peek en attente.
        // Il portait sur « la frame d'après l'ancienne position », qui n'a plus de sens
        // ici — sans ça le `next()` suivant promouvait une frame décodée avant le rewind,
        // avec son ancien `cur_pts`.
        self.has_peek = false;
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
        // Tout seek invalide un éventuel peek en attente — cf. pipeline_macos::Decoder::seek_to.
        self.has_peek = false;
        let tb_sec = self.tb_sec();

        // Chemin rapide. Le seek complet ci-dessous jette TOUT l'état du décodeur et repart
        // de l'image clé précédente — jusqu'à `gop_size` frames à redécoder (60 sur nos
        // captures), et deux fois puisque écran et webcam ont chacun leur décodeur, soit
        // ~50 ms par pas de scrub mesurés. Or le cas dominant en édition n'est pas un saut :
        // c'est « la frame suivante » (scrub, pas-à-pas) ou « la même frame » (un paramètre
        // a changé, la scène est recomposée au même instant). Aucun des deux ne justifie de
        // repartir d'une image clé.
        //
        // Le critère d'arrêt du déroulement est la MÊME expression que celui du seek complet
        // (cf. `decode_forward_to`), donc les deux chemins rendent la même frame : c'est une
        // optimisation, pas un changement de comportement.
        if tb_sec > 0.0 {
            if let Some(pts) = self.cur_pts {
                let cur = pts as f64 * tb_sec;
                let frame_dur = 1.0 / self.fps().max(1.0);
                // 1) La frame courante EST celle demandée : rien à décoder du tout.
                //    `cur_frame()`, pas `self.frame` : en backend CPU la frame exploitable
                //    est la texture NV12 déjà présentée, pas la frame système du décodeur.
                if (cur - seconds).abs() < frame_dur * 0.5 {
                    return Ok(self.cur_frame());
                }
                // 2) La cible est DEVANT et à portée : dérouler depuis ici. Au-delà du seuil,
                //    repartir d'une image clé redevient moins cher — un seek coûte en moyenne
                //    un demi-GOP, soit ~0,5 s sur nos captures.
                if cur < seconds && seconds - cur <= SEEK_FORWARD_MAX_SEC {
                    let f = self.decode_forward_to(seconds, tb_sec)?;
                    if !f.is_null() {
                        return Ok(f);
                    }
                    // `decode_forward_to` a atteint l'EOF avant la cible — typiquement un
                    // décodeur réactivé depuis le pool (`live::swap_clip_pooled`), laissé en fin
                    // de flux (`sent_eof`), qui ne peut plus avancer. On NE rend PAS `null` : ça
                    // forçait l'appelant à tout ROUVRIR (~190 ms mesurés), le pire à-coup ressenti
                    // au franchissement. On retombe sur le seek keyframe complet ci-dessous, qui
                    // rembobine + réarme le décodeur et repart proprement. Si la cible est
                    // réellement au-delà de l'EOF, ce seek complet rendra `null` lui aussi :
                    // comportement inchangé pour ce cas.
                }
            }
        }

        let target = if tb_sec > 0.0 { (seconds / tb_sec) as i64 } else { 0 };
        averr(av_seek_frame(self.fmt, self.vidx, target, AVSEEK_FLAG_BACKWARD), "seek_to")?;
        avcodec_flush_buffers(self.dctx);
        // L'état vient d'être jeté : plus aucune frame courante exploitable.
        self.cur_pts = None;
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

    /// Déroule le décodeur en avant jusqu'à la première frame à `seconds` ou après, SANS
    /// jeter son état. Critère d'arrêt identique à celui du seek complet — c'est ce qui
    /// garantit que les deux chemins rendent exactement la même frame.
    unsafe fn decode_forward_to(&mut self, seconds: f64, tb_sec: f64) -> Result<*mut AVFrame> {
        loop {
            let f = self.next()?;
            if f.is_null() {
                return Ok(ptr::null_mut());
            }
            let pts = (*f).best_effort_timestamp;
            if pts == i64::MIN {
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
        if self.has_peek {
            return self.commit_peek();
        }
        if !self.receive_into(self.frame)? {
            return Ok(ptr::null_mut());
        }
        let pts = (*self.frame).best_effort_timestamp;
        self.cur_pts = if pts == i64::MIN { None } else { Some(pts) };
        match &mut self.cpu {
            Some(cpu) => cpu.present(self.frame),
            None => Ok(self.frame),
        }
    }

    /// Décode dans `into` (buffer courant ou de lookahead) jusqu'à obtenir une frame ou
    /// l'EOF — cf. `pipeline_macos::Decoder::receive_into` pour la justification.
    unsafe fn receive_into(&mut self, into: *mut AVFrame) -> Result<bool> {
        loop {
            let r = avcodec_receive_frame(self.dctx, into);
            if r == 0 {
                return Ok(true);
            }
            if r == AVERROR_EOF {
                return Ok(false);
            }
            if r != AVERROR_EAGAIN {
                averr(r, "receive_frame")?;
            }
            if self.sent_eof {
                return Ok(false);
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

    /// Décode la prochaine frame dans le buffer de lookahead et renvoie son temps.
    /// Cf. `pipeline_macos::Decoder::peek_next_time_sec`.
    pub(crate) unsafe fn peek_next_time_sec(&mut self) -> Result<NextFrameTime> {
        if !self.has_peek {
            if !self.receive_into(self.peek_frame)? {
                return Ok(NextFrameTime::Eof);
            }
            self.has_peek = true;
        }
        let pts = (*self.peek_frame).best_effort_timestamp;
        let tb_sec = self.tb_sec();
        // Sans pts ni time_base exploitables on ne PEUT pas dire si la frame est due :
        // `Unknown`, et non `0.0` — qui passait pour « due » à tous les coups.
        Ok(if pts == i64::MIN || tb_sec <= 0.0 {
            NextFrameTime::Unknown
        } else {
            NextFrameTime::At(pts as f64 * tb_sec)
        })
    }

    /// Promeut la frame de lookahead au rang de frame courante. Cf.
    /// `pipeline_macos::Decoder::commit_peek`.
    pub(crate) unsafe fn commit_peek(&mut self) -> Result<*mut AVFrame> {
        // `bail!` et non `debug_assert!` : compilée en release, l'assertion disparaissait
        // et l'échange promouvait un `AVFrame` jamais rempli, avec un
        // `best_effort_timestamp` indéterminé, jusque dans le chemin de présentation.
        if !self.has_peek {
            anyhow::bail!("commit_peek sans peek_next_time_sec préalable");
        }
        std::mem::swap(&mut self.frame, &mut self.peek_frame);
        self.has_peek = false;
        let pts = (*self.frame).best_effort_timestamp;
        self.cur_pts = if pts == i64::MIN { None } else { Some(pts) };
        match &mut self.cpu {
            Some(cpu) => cpu.present(self.frame),
            None => Ok(self.frame),
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            av_frame_free(&mut self.frame);
            av_frame_free(&mut self.peek_frame);
            av_packet_free(&mut self.pkt);
            avcodec_free_context(&mut self.dctx);
            av_buffer_unref(&mut self.hwdev);
            avformat_close_input(&mut self.fmt);
        }
    }
}

/// Frames-context de l'encodeur : NV12 sur notre device, bind RENDER_TARGET (§5) pour
/// que le compositeur rende directement dans les surfaces de l'encodeur.
/// Au-delà de cette distance vers l'avant, `seek_to` repart d'une image clé plutôt que de
/// dérouler. Calé sur le demi-GOP de nos captures (GOP=60 à 60 fps) : en deçà, dérouler
/// coûte moins cher que de jeter l'état du décodeur et redécoder depuis la clé précédente.
const SEEK_FORWARD_MAX_SEC: f64 = 0.5;

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
    discard_partial_output(out, unsafe {
        run_c1_inner(screen, webcam, out, gpu, comp, cfg, progress)
    })
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

    let mut enc = VideoEncoder::open(
        &ExportCodec::H264,
        OUT_W as i32,
        OUT_H as i32,
        60,
        8_000_000,
        enc_frames,
    )?;
    let ectx = enc.ctx;

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
        enc.send(outf)?;
        drain_encoder(ectx, octx, ostream, opkt)?;
        av_frame_free(&mut (outf as *mut _));
        frames += 1;
        progress(frames);
    }

    enc.send(ptr::null_mut())?;
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
    // `enc` est libéré par son Drop en fin de portée (voir run_multi_inner).
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
    discard_partial_output(out, unsafe {
        run_multi_inner(clips, out, gpu, comp, cfg, params, progress)
    })
}

/// Codec vidéo de sortie. L'encodeur concret est choisi à l'exécution (voir `candidates`).
/// VP9 a été essayé via un chemin logiciel (libvpx-vp9) mais retiré : trop lent pour être
/// utile en pratique, pas la peine de maintenir ce chemin. Choisir VP9 échoue avec un message
/// clair plutôt que de silencieusement retomber sur H264.
pub enum ExportCodec {
    H264,
    H265,
}

/// Un candidat encodeur : son nom ffmpeg, et le format d'entrée qu'on lui présentera.
/// `AV_PIX_FMT_D3D11` = zéro-copie, la texture du compositeur part telle quelle ; tout autre
/// format impose une descente GPU→système par frame (voir `VideoEncoder::send`).
type EncoderCandidate = (&'static str, AVPixelFormat::Type);

impl ExportCodec {
    /// Ordre de préférence, du plus rapide au plus universel. Le premier dont `avcodec_open2`
    /// réussit **vraiment** gagne : figurer dans la liste `-encoders` du build ne prouve rien
    /// (les back-ends AMF/NVENC sont compilés en dur dans ffmpeg, sans le GPU correspondant
    /// derrière), seule l'ouverture négocie avec le driver.
    ///
    /// - `*_amf` / `*_nvenc` — AMD / NVIDIA, avalent nos textures D3D11 directement. AMF
    ///   d'abord : c'est le chemin mesuré (§9, C0..C8), le garder en tête laisse les chiffres
    ///   du banc comparables sur la machine de dev.
    /// - `*_mf` — MediaFoundation, c'est-à-dire *n'importe quel* MFT installé : le seul
    ///   candidat qui ne présuppose aucun vendeur, et celui qui rattrape le MFT logiciel de
    ///   Windows (VM, RDP, machine sans encodeur), son `hw_encoding` valant `false` par défaut.
    ///   **En NV12 seulement.** Il annonce `d3d11` et s'ouvre en d3d11, mais meurt ensuite au
    ///   premier envoi (« Failed to set D3D manager: 80004001 ») quand MediaFoundation lui a
    ///   résolu le MFT logiciel — mesuré ici. Comme le choix est acté à l'ouverture, ce
    ///   candidat-là ferait échouer l'export au lieu de glisser au suivant : ne pas le remettre.
    /// - `*_qsv` — Intel ; n'accepte pas `AV_PIX_FMT_D3D11`, seulement du NV12 système.
    ///   ponytail: donc descente GPU→CPU puis remontée CPU→GPU sur Intel, une frame à la fois.
    ///   Le zéro-copie y demanderait un device QSV dérivé du nôtre et `AV_PIX_FMT_QSV` ; à
    ///   faire quand on aura une machine Intel pour le mesurer, pas avant.
    /// - `libopenh264` / `libkvazaar` — dernier recours 100 % logiciel. **Pas** libx264/libx265 :
    ///   le ffmpeg vendorisé est le build LGPL, `--disable-libx264 --disable-libx265`. Ces deux
    ///   là y sont, et sont les seuls encodeurs logiciels H264/H265 dont on dispose.
    fn candidates(&self) -> &'static [EncoderCandidate] {
        const D3D11: AVPixelFormat::Type = AVPixelFormat::AV_PIX_FMT_D3D11;
        const NV12: AVPixelFormat::Type = AVPixelFormat::AV_PIX_FMT_NV12;
        const YUV420P: AVPixelFormat::Type = AVPixelFormat::AV_PIX_FMT_YUV420P;
        match self {
            ExportCodec::H264 => &[
                ("h264_amf", D3D11),
                ("h264_nvenc", D3D11),
                ("h264_qsv", NV12),
                ("h264_mf", NV12),
                ("libopenh264", YUV420P),
            ],
            ExportCodec::H265 => &[
                ("hevc_amf", D3D11),
                ("hevc_nvenc", D3D11),
                ("hevc_qsv", NV12),
                ("hevc_mf", NV12),
                ("libkvazaar", YUV420P),
            ],
        }
    }
}

/// L'encodeur vidéo retenu pour ce run, plus ce qu'il faut pour le nourrir.
///
/// Le reste du pipeline continue de produire des frames GPU sans savoir qui encode : quand le
/// candidat retenu n'avale pas les textures D3D11, la descente vers la mémoire système se fait
/// ici et nulle part ailleurs.
struct VideoEncoder {
    ctx: *mut AVCodecContext,
    /// Frame système au format attendu par l'encodeur. Null si zéro-copie D3D11.
    sw: *mut AVFrame,
    /// Intermédiaire NV12 : `av_hwframe_transfer_data` ne convertit pas, il ne sait descendre
    /// que vers le `sw_format` du pool. Non-null seulement si l'encodeur veut du planaire.
    nv12: *mut AVFrame,
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        unsafe {
            avcodec_free_context(&mut self.ctx);
            if !self.sw.is_null() {
                av_frame_free(&mut self.sw);
            }
            if !self.nv12.is_null() {
                av_frame_free(&mut self.nv12);
            }
        }
    }
}

impl VideoEncoder {
    /// Retient le premier candidat que cette machine accepte d'ouvrir, et dit lequel dans les
    /// logs. `hw_frames` : le pool D3D11 dans lequel le compositeur rend.
    ///
    /// `OPENSCREEN_EXPORT_ENCODER=<nom>` n'essaie que celui-là. C'est le seul moyen d'exercer
    /// les chemins non-AMD depuis une machine AMD, où `h264_amf` gagne toujours au premier tour
    /// et laisse la descente mémoire système de `send` jamais exécutée. Le forçage ne retombe
    /// délibérément sur rien : un repli silencieux sur AMF ferait croire au test d'être passé.
    unsafe fn open(
        codec: &ExportCodec,
        w: i32,
        h: i32,
        fps: i32,
        bit_rate: i64,
        hw_frames: *mut AVBufferRef,
    ) -> Result<VideoEncoder> {
        let forced = std::env::var("OPENSCREEN_EXPORT_ENCODER").ok();
        let mut refused: Vec<String> = Vec::new();
        for &candidate in codec.candidates() {
            let (name, pix_fmt) = candidate;
            if forced.as_deref().is_some_and(|forced| forced != name) {
                continue;
            }
            // Sans pool D3D11 (backend CPU), les candidats zéro-copie n'ont rien à consommer :
            // les écarter ici plutôt que de leur passer un `hw_frames_ctx` nul, dont l'échec
            // remonterait comme un refus de driver et masquerait la vraie raison.
            if hw_frames.is_null() && pix_fmt == AVPixelFormat::AV_PIX_FMT_D3D11 {
                refused.push(format!("{name}: pas de pool D3D11 (backend CPU)"));
                continue;
            }
            let encoder = match Self::try_open(candidate, w, h, fps, bit_rate, hw_frames) {
                Ok(encoder) => encoder,
                Err(error) => {
                    refused.push(format!("{name}: {error}"));
                    continue;
                }
            };
            // Journalisé sans condition : un rapport de support doit dire qui a encodé.
            eprintln!(
                "[pipeline] encodeur vidéo : {name} ({}){}",
                if encoder.sw.is_null() { "textures D3D11, zéro-copie" } else { "frames système" },
                if refused.is_empty() {
                    String::new()
                } else {
                    format!(" — écartés : {}", refused.join(" ; "))
                },
            );
            return Ok(encoder);
        }
        match forced {
            // Un nom forcé qui ne figure dans aucune liste ne produit aucun refus : sans ce cas
            // le message serait un « aucun encodeur : » suivi de rien, et on chercherait le
            // problème du côté du driver plutôt que du côté de la faute de frappe.
            Some(name) if refused.is_empty() => {
                bail!("OPENSCREEN_EXPORT_ENCODER={name} ne nomme aucun candidat de ce codec")
            }
            Some(name) => bail!("OPENSCREEN_EXPORT_ENCODER={name} inutilisable ici : {}", refused[0]),
            None => bail!(
                "aucun encodeur vidéo utilisable sur cette machine : {}",
                refused.join(" ; "),
            ),
        }
    }

    /// Ouvre un candidat. L'ouverture est la sonde : elle négocie pour de bon avec le driver
    /// (c'est elle qui échoue sur une machine sans AMF), et tous les candidats de la liste
    /// échouent proprement ici quand ils ne conviennent pas — mesuré sur cette machine :
    /// `h264_nvenc` « Operation not permitted », `h264_qsv` « Unknown error ».
    ///
    /// ponytail: encoder une frame d'essai serait la sonde forte, mais l'essai a été fait et
    /// retiré : tirer une frame quelconque du pool n'équivaut pas à une vraie frame composée,
    /// et AMF la refusait dans C0 (pool du décodeur) — faux négatif qui coûtait 179→60 fps sur
    /// un chemin qui marchait. Le vrai remède serait de sonder avec la 1re frame réelle, avant
    /// l'écriture de l'en-tête MP4 ; à faire si un candidat se met à passer l'ouverture pour
    /// mourir ensuite.
    unsafe fn try_open(
        (name, pix_fmt): EncoderCandidate,
        w: i32,
        h: i32,
        fps: i32,
        bit_rate: i64,
        hw_frames: *mut AVBufferRef,
    ) -> Result<VideoEncoder> {
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
        (*ctx).pix_fmt = pix_fmt;
        (*ctx).time_base = AVRational { num: 1, den: fps };
        (*ctx).framerate = AVRational { num: fps, den: 1 };
        (*ctx).bit_rate = bit_rate;
        // Toutes nos sorties sont du MP4, qui veut SPS/PPS (et VPS en HEVC) dans l'extradata
        // plutôt qu'en ligne dans le flux. Le muxer mov sait à défaut les repêcher dans le
        // premier paquet, mais c'est un rattrapage : les encodeurs logiciels qu'on vient
        // d'ajouter n'émettent pas d'extradata sans ce drapeau, et personne ici n'a de machine
        // pour constater le MP4 bancal qui en sortirait.
        (*ctx).flags |= AV_CODEC_FLAG_GLOBAL_HEADER as i32;
        if pix_fmt == AVPixelFormat::AV_PIX_FMT_D3D11 {
            (*ctx).hw_frames_ctx = av_buffer_ref(hw_frames);
        }
        if let Err(error) = averr(avcodec_open2(ctx, enc, ptr::null_mut()), "avcodec_open2(enc)") {
            avcodec_free_context(&mut ctx);
            return Err(error);
        }

        // À partir d'ici le contexte est à nous : le mettre dans la struct d'abord, pour que
        // le Drop le libère si l'allocation des tampons échoue.
        let mut encoder = VideoEncoder { ctx, sw: ptr::null_mut(), nv12: ptr::null_mut() };
        if pix_fmt != AVPixelFormat::AV_PIX_FMT_D3D11 {
            encoder.sw = alloc_sw_frame(pix_fmt, w, h)?;
            if pix_fmt != AVPixelFormat::AV_PIX_FMT_NV12 {
                encoder.nv12 = alloc_sw_frame(AVPixelFormat::AV_PIX_FMT_NV12, w, h)?;
            }
        }
        Ok(encoder)
    }

    /// Envoie une frame du compositeur (texture D3D11) à l'encodeur ; `frame` null = flush.
    unsafe fn send(&mut self, frame: *mut AVFrame) -> Result<()> {
        if self.sw.is_null() || frame.is_null() {
            return averr(avcodec_send_frame(self.ctx, frame), "send_frame");
        }
        // L'encodeur garde une référence sur les frames en vol : ne jamais réécrire par-dessus.
        averr(av_frame_make_writable(self.sw), "frame_make_writable")?;
        let landing = if self.nv12.is_null() { self.sw } else { self.nv12 };
        averr(av_hwframe_transfer_data(landing, frame, 0), "hwframe_transfer_data")?;
        if !self.nv12.is_null() {
            nv12_to_yuv420p(self.nv12, self.sw);
        }
        (*self.sw).pts = (*frame).pts;
        averr(avcodec_send_frame(self.ctx, self.sw), "send_frame")
    }

    /// Même chose depuis le backend CPU, où il n'y a PAS de frame D3D11 à descendre.
    ///
    /// `av_hwframe_transfer_data` suppose un pool `hw_frames_ctx`, et sur WARP il n'y en a
    /// pas : `av_hwdevice_ctx_init(D3D11VA)` échoue faute d'`ID3D11VideoDevice` — le même
    /// manque qui interdit le décodage matériel. Le compositeur lit donc son NV12
    /// directement en mémoire système, et le reste (conversion planaire, réutilisation des
    /// tampons, pts) suit exactement le chemin logiciel de `send`.
    unsafe fn send_composited(
        &mut self,
        comp: &Compositor,
        w: u32,
        h: u32,
        pts: i64,
    ) -> Result<()> {
        debug_assert!(!self.sw.is_null(), "backend CPU : aucun candidat D3D11 ne doit gagner");
        averr(av_frame_make_writable(self.sw), "frame_make_writable")?;
        let landing = if self.nv12.is_null() { self.sw } else { self.nv12 };
        comp.read_nv12_scaled(
            w,
            h,
            (*landing).data[0],
            (*landing).linesize[0] as usize,
            (*landing).data[1],
            (*landing).linesize[1] as usize,
        )?;
        if !self.nv12.is_null() {
            nv12_to_yuv420p(self.nv12, self.sw);
        }
        (*self.sw).pts = pts;
        averr(avcodec_send_frame(self.ctx, self.sw), "send_frame")
    }
}

/// Frame système allouée une fois, réutilisée à chaque envoi.
unsafe fn alloc_sw_frame(pix_fmt: AVPixelFormat::Type, w: i32, h: i32) -> Result<*mut AVFrame> {
    let frame = av_frame_alloc();
    if frame.is_null() {
        bail!("av_frame_alloc (tampon encodeur)");
    }
    (*frame).format = pix_fmt;
    (*frame).width = w;
    (*frame).height = h;
    if let Err(error) = averr(av_frame_get_buffer(frame, 0), "av_frame_get_buffer (tampon encodeur)")
    {
        av_frame_free(&mut (frame as *mut _));
        return Err(error);
    }
    Ok(frame)
}

/// NV12 (Y puis UV entrelacé) → YUV420P (Y, U, V séparés), pour les encodeurs logiciels qui
/// ne prennent que du planaire. Les `linesize` des deux frames diffèrent : copier plan par
/// plan, ligne par ligne, jamais d'un bloc.
///
/// ponytail: désentrelacement scalaire, O(w·h) par frame. Négligeable devant l'encodeur
/// logiciel qui suit (des dizaines de ms/frame) — c'est le seul chemin qui l'emprunte.
/// Brancher swscale si ce chemin devient un jour chaud.
unsafe fn nv12_to_yuv420p(src: *mut AVFrame, dst: *mut AVFrame) {
    let (w, h) = ((*src).width as usize, (*src).height as usize);
    for y in 0..h {
        ptr::copy_nonoverlapping(
            (*src).data[0].add(y * (*src).linesize[0] as usize),
            (*dst).data[0].add(y * (*dst).linesize[0] as usize),
            w,
        );
    }
    // `div_ceil` et non `/ 2` : en largeur ou hauteur impaire le plan chroma compte une colonne
    // et une ligne de plus, que la division tronquée laisserait telles que `av_frame_get_buffer`
    // les a rendues — un bord vert. D3D11 refuse les textures NV12 impaires, donc le cas n'est
    // pas atteignable aujourd'hui ; au même coût, autant que la fonction soit juste seule.
    for y in 0..h.div_ceil(2) {
        let uv = (*src).data[1].add(y * (*src).linesize[1] as usize);
        let u = (*dst).data[1].add(y * (*dst).linesize[1] as usize);
        let v = (*dst).data[2].add(y * (*dst).linesize[2] as usize);
        for x in 0..w.div_ceil(2) {
            *u.add(x) = *uv.add(2 * x);
            *v.add(x) = *uv.add(2 * x + 1);
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

    // La scène (déjà posée par l'appelant via comp.set_scene) pilote le curseur et le
    // fenêtrage par clip ; `walk_composited_timeline` s'en charge.
    let scene = comp.scene_snapshot();
    let audio_settings = scene.as_ref().map(|scene| scene.audio).unwrap_or_default();

    // ---- encodeur (choisi à l'exécution, cf. ExportCodec::candidates) + mux ----
    // Backend CPU : pas de pool D3D11 du tout. `av_hwdevice_ctx_init(D3D11VA)` échoue sur
    // WARP (pas d'`ID3D11VideoDevice`), donc on n'essaie même pas — `VideoEncoder::open`
    // écarte alors les candidats zéro-copie et le compositeur alimente l'encodeur en
    // mémoire système via `send_composited`.
    let software_frames = gpu.backend == Backend::Cpu;
    let (mut enc_hwdev, mut enc_frames) = if software_frames {
        (ptr::null_mut(), ptr::null_mut())
    } else {
        make_enc_frames(gpu, out_w as i32, out_h as i32)?
    };
    // débit proportionnel à la surface de sortie (référence : 8Mbps @ 1920x1080), plancher
    // 2Mbps pour rester regardable sur les petites tailles.
    let bit_rate = ((out_w as i64 * out_h as i64 * 8_000_000) / (1920 * 1080)).max(2_000_000);
    let mut enc = VideoEncoder::open(
        &params.codec,
        out_w as i32,
        out_h as i32,
        out_fps,
        bit_rate,
        enc_frames,
    )?;
    let ectx = enc.ctx;

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
    let mut clip_frame_counts = vec![0u64; clips.len()];
    let mut clip_pcm: Vec<Option<PlanarPcm>> =
        std::iter::repeat_with(|| None).take(clips.len()).collect();
    let t0 = Instant::now();

    let frames = walk_composited_timeline(
        clips,
        gpu,
        comp,
        cfg,
        out_fps,
        &scene,
        &mut screen_decs,
        &mut webcam_decs,
        &mut |frame_index| {
            // Backend CPU (WARP) : la frame composée descend en mémoire système via
            // `send_composited` (le compositeur relit son NV12 interne vers un AVFrame
            // YUV420P / NV12 et l'encodeur le consomme directement). Pas de hw_frames_ctx,
            // pas de rgb_to_nv12 — c'est exactement le repli WARP que PR #162 a câblé.
            if software_frames {
                enc.send_composited(comp, out_w, out_h, frame_index as i64)?;
                drain_encoder(ectx, octx, ostream, opkt)?;
            } else {
                // Hardware path: the composed texture goes straight into an NV12
                // encoder frame, so nothing ever descends to system memory.
                let outf = av_frame_alloc();
                averr(av_hwframe_get_buffer(enc_frames, outf, 0), "hwframe_get_buffer")?;
                let out_tex = (*outf).data[0] as *mut c_void;
                let out_slice = (*outf).data[1] as u32;
                comp.rgb_to_nv12_scaled(out_w, out_h, out_tex, out_slice)?;
                (*outf).pts = frame_index as i64;
                enc.send(outf)?;
                drain_encoder(ectx, octx, ostream, opkt)?;
                av_frame_free(&mut (outf as *mut _));
            }
            progress(frame_index + 1);
            Ok(())
        },
        &mut |clip_index, source_end_sec, frames_in_clip, speed_segments| {
            clip_frame_counts[clip_index] = frames_in_clip;
            let clip = &clips[clip_index];
            if clip.has_audio && frames_in_clip > 0 {
                match decode_clip_audio(&clip.screen, clip.source_start_sec, source_end_sec) {
                    Ok(Some(pcm)) => {
                        clip_pcm[clip_index] = Some(stretch_clip_pcm_by_speed(
                            &pcm,
                            speed_segments,
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
            Ok(())
        },
    )?;

    comp.set_cursor_time(None);
    comp.set_timeline_time(None);
    comp.set_scene(scene);

    enc.send(ptr::null_mut())?;
    drain_encoder(ectx, octx, ostream, opkt)?;

    let declared_audio: Vec<bool> = clips.iter().map(|clip| clip.has_audio).collect();
    let audio_plan = build_audio_concat_plan(
        &clip_frame_counts,
        &declared_audio,
        out_fps as f64,
    );
    let assembled_audio = finish_audio(
        assemble_concatenated_pcm(&clip_pcm, &audio_plan),
        audio_settings,
    );
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
    // `enc` (donc le contexte encodeur) est libéré par son Drop en fin de portée — après
    // ces unref, ce qui est l'ordre voulu : il garde sa propre référence sur le pool.
    av_buffer_unref(&mut enc_frames);
    av_buffer_unref(&mut enc_hwdev);

    let fps = frames as f64 / wall_s;
    Ok(Stats { frames, wall_s, fps, video_duration_s: frames as f64 / out_fps as f64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// L'ordre EST le contrat : tous les candidats zéro-copie d'abord, ceux qui exigent la
    /// mémoire système ensuite (`*_qsv` et `*_mf` sont matériels eux aussi — ce qui les
    /// distingue est le format d'entrée, pas le silicium). Un candidat système remonté
    /// au-dessus d'un D3D11 coûterait une descente GPU→CPU par frame sur une machine qui n'en
    /// a pas besoin, sans que rien n'échoue — donc sans que personne ne le voie.
    #[test]
    fn les_candidats_vont_du_zero_copie_a_la_memoire_systeme() {
        for codec in [ExportCodec::H264, ExportCodec::H265] {
            let candidates = codec.candidates();
            let last_d3d11 = candidates
                .iter()
                .rposition(|&(_, fmt)| fmt == AVPixelFormat::AV_PIX_FMT_D3D11)
                .expect("au moins un candidat zéro-copie");
            let first_sw = candidates
                .iter()
                .position(|&(_, fmt)| fmt != AVPixelFormat::AV_PIX_FMT_D3D11)
                .expect("au moins un candidat en mémoire système");
            assert!(last_d3d11 < first_sw, "candidats mal ordonnés : {candidates:?}");
        }
    }

    /// Le dernier recours doit être 100 % logiciel, sinon une machine sans encodeur matériel
    /// (VM, RDP) n'exporte pas du tout — la régression que cette sélection corrige.
    /// libx264/libx265 sont GPL et absents du build LGPL vendorisé : les nommer ferait un
    /// filet de sécurité qui n'existe pas.
    #[test]
    fn le_dernier_recours_est_un_encodeur_logiciel_present_dans_le_build_lgpl() {
        let fallbacks: Vec<&str> = [ExportCodec::H264, ExportCodec::H265]
            .iter()
            .map(|codec| codec.candidates().last().expect("liste non vide").0)
            .collect();
        assert_eq!(fallbacks, ["libopenh264", "libkvazaar"]);
        for codec in [ExportCodec::H264, ExportCodec::H265] {
            for &(name, _) in codec.candidates() {
                assert!(!matches!(name, "libx264" | "libx265"), "{name} absent du build LGPL");
            }
        }
    }

    /// Le désentrelacement chroma est la seule vraie logique du chemin logiciel, et la seule
    /// qui puisse se tromper en silence (image verte / couleurs inversées plutôt qu'une
    /// erreur). Les deux frames ont des `linesize` différents — c'est exactement ce qu'un
    /// `copy` d'un bloc raterait.
    ///
    /// 5x3 autant que 4x4 : en dimension impaire le plan chroma compte une colonne et une ligne
    /// de plus que la moitié, et une division tronquée les laisserait non initialisées.
    #[test]
    fn nv12_vers_yuv420p_desentrelace_le_chroma() {
        for (w, h) in [(4usize, 4usize), (5, 3)] {
            let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
            unsafe {
                let src =
                    alloc_sw_frame(AVPixelFormat::AV_PIX_FMT_NV12, w as i32, h as i32).unwrap();
                let dst =
                    alloc_sw_frame(AVPixelFormat::AV_PIX_FMT_YUV420P, w as i32, h as i32).unwrap();

                // luma = 10, 11, 12... ligne par ligne ; chroma = U pair, V impair, distinguables.
                for y in 0..h {
                    let row = (*src).data[0].add(y * (*src).linesize[0] as usize);
                    for x in 0..w {
                        *row.add(x) = (10 + y * w + x) as u8;
                    }
                }
                for y in 0..ch {
                    let row = (*src).data[1].add(y * (*src).linesize[1] as usize);
                    for x in 0..cw {
                        *row.add(2 * x) = (100 + y * cw + x) as u8; // U
                        *row.add(2 * x + 1) = (200 + y * cw + x) as u8; // V
                    }
                }

                nv12_to_yuv420p(src, dst);

                for y in 0..h {
                    let row = (*dst).data[0].add(y * (*dst).linesize[0] as usize);
                    for x in 0..w {
                        assert_eq!(*row.add(x), (10 + y * w + x) as u8, "luma ({x},{y}) en {w}x{h}");
                    }
                }
                for y in 0..ch {
                    let u = (*dst).data[1].add(y * (*dst).linesize[1] as usize);
                    let v = (*dst).data[2].add(y * (*dst).linesize[2] as usize);
                    for x in 0..cw {
                        assert_eq!(*u.add(x), (100 + y * cw + x) as u8, "U ({x},{y}) en {w}x{h}");
                        assert_eq!(*v.add(x), (200 + y * cw + x) as u8, "V ({x},{y}) en {w}x{h}");
                    }
                }

                av_frame_free(&mut (src as *mut _));
                av_frame_free(&mut (dst as *mut _));
            }
        }
    }
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
