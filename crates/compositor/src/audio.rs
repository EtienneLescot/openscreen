//! Piste audio native de l'export multiclip : ffmpeg décode les sources écran, swresample
//! normalise tout en f32 planaire 48 kHz stéréo, WSOLA applique les speed regions, puis un
//! unique encodeur AAC alimente le même muxer que la vidéo.

use crate::ffi::*;
use crate::regions::SpeedSegment;
use crate::scene::SceneAudio;
use anyhow::{bail, Result};
use std::f32::consts::PI;
use std::ffi::CString;
use std::ptr;

pub const AUDIO_OUTPUT_SAMPLE_RATE: i32 = 48_000;
pub const AUDIO_OUTPUT_CHANNELS: usize = 2;
pub const AUDIO_BITRATE: i64 = 128_000;
pub const AUDIO_BOUNDARY_FADE_SAMPLES: usize = 240;

// Valeurs partagées : `AVERROR(EAGAIN)` dépend de la plateforme (-11 vs -35), et ce
// module est compilé sur les deux. Cf. `crate::ffi`.
use crate::ffi::{AVERROR_EAGAIN, AVERROR_EOF};
const AVSEEK_FLAG_BACKWARD: i32 = 1;
const DEFAULT_FRAME_SEC: f64 = 0.04;
const MIN_FRAME_SEC: f64 = 0.005;
const DEFAULT_SEARCH_SEC: f64 = 0.01;
const TARGET_GRAINS: usize = 8;
const PASSTHROUGH_EPSILON: f64 = 1e-3;

pub type PlanarPcm = Vec<Vec<f32>>;

/// Apply the editor's output trim to the assembled timeline.
///
/// One stage, and keeping it that way takes some resisting. This runs on the assembled
/// timeline — trimmed, speed-adjusted, concatenated — while the editor preview plays the
/// untouched SOURCE file, seeked. A linear gain is the only operation that means the same
/// thing on both, which is what lets the editor claim that what you hear is what you export.
///
/// Three things that look like they belong here and do not:
/// - a filter or a compressor, which carries state across cuts here and not in the preview;
/// - a loudness normaliser, whose makeup is a single scalar measured over the whole assembled
///   programme — the preview never holds that programme, and the value moves with every trim;
/// - a sync offset, which shipped here once. It is expressed in TIMELINE seconds at this
///   point in the pipeline, but the preview would apply it in SOURCE seconds, so a 2x speed
///   region halved it; and because the shift is uniform over the assembled programme, near a
///   cut the export pulls audio across the junction while the preview only has the active
///   asset loaded.
///
/// Any of them means either rendering the export's audio assembly preview-side, or accepting
/// and documenting a divergence — not a quiet extra stage in this function.
///
/// The bound mirrors `AUDIO_GAIN_DB_LIMIT` in editorSettings.ts. The result stays the same
/// length so video and following clips cannot drift.
pub fn finish_audio(mut pcm: PlanarPcm, settings: SceneAudio) -> PlanarPcm {
    let samples = pcm.first().map(Vec::len).unwrap_or(0);
    if samples == 0 {
        return pcm;
    }
    for channel in pcm.iter_mut() {
        channel.resize(samples, 0.0);
    }

    let trim = 10.0f32.powf(settings.gain_db.clamp(-12.0, 12.0) / 20.0);
    for sample in pcm.iter_mut().flatten() {
        *sample = (*sample * trim).clamp(-1.0, 1.0);
    }
    pcm
}

extern "C" {
    fn sn_fmt_stream(s: *mut AVFormatContext, i: i32) -> *mut AVStream;
    // bindgen rend `AVFormatContext` opaque (atteinte seulement par pointeur), d'où l'accesseur
    // compilé contre les vrais headers — voir shim.c.
    fn sn_fmt_nb_streams(s: *mut AVFormatContext) -> u32;
}

fn averr(ret: i32, ctx: &str) -> Result<()> {
    if ret < 0 {
        // Surtout pas `[0i8; 256]` : `c_char` est signé sur x86_64 mais NON SIGNÉ sur
        // aarch64, donc un i8 en dur fait du `*mut c_char` d'av_strerror une erreur de
        // type sur arm64.
        let mut buf = [0 as std::ffi::c_char; 256];
        unsafe { av_strerror(ret, buf.as_mut_ptr(), buf.len()) };
        let msg = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) }.to_string_lossy();
        bail!("{ctx}: {ret} ({msg})");
    }
    Ok(())
}

struct AudioResampler {
    ctx: *mut SwrContext,
    input_rate: i32,
}

impl AudioResampler {
    unsafe fn from_frame(frame: *mut AVFrame, dctx: *mut AVCodecContext) -> Result<Self> {
        let mut output_layout = AVChannelLayout::default();
        av_channel_layout_default(&mut output_layout, AUDIO_OUTPUT_CHANNELS as i32);

        let mut fallback_layout = AVChannelLayout::default();
        let input_layout = if (*frame).ch_layout.nb_channels > 0 {
            &(*frame).ch_layout as *const AVChannelLayout
        } else if (*dctx).ch_layout.nb_channels > 0 {
            &(*dctx).ch_layout as *const AVChannelLayout
        } else {
            av_channel_layout_default(&mut fallback_layout, 1);
            &fallback_layout as *const AVChannelLayout
        };
        let input_rate = if (*frame).sample_rate > 0 {
            (*frame).sample_rate
        } else {
            (*dctx).sample_rate
        };
        if input_rate <= 0 {
            av_channel_layout_uninit(&mut output_layout);
            av_channel_layout_uninit(&mut fallback_layout);
            bail!("fréquence audio source invalide");
        }

        let mut ctx: *mut SwrContext = ptr::null_mut();
        let ret = swr_alloc_set_opts2(
            &mut ctx,
            &output_layout,
            AVSampleFormat::AV_SAMPLE_FMT_FLTP,
            AUDIO_OUTPUT_SAMPLE_RATE,
            input_layout,
            (*frame).format as AVSampleFormat::Type,
            input_rate,
            0,
            ptr::null_mut(),
        );
        av_channel_layout_uninit(&mut output_layout);
        av_channel_layout_uninit(&mut fallback_layout);
        averr(ret, "swr_alloc_set_opts2")?;
        if ctx.is_null() {
            bail!("swr_alloc_set_opts2: contexte nul");
        }
        averr(swr_init(ctx), "swr_init")?;
        Ok(Self { ctx, input_rate })
    }

    unsafe fn push(&mut self, frame: *mut AVFrame, output: &mut PlanarPcm) -> Result<()> {
        let out_capacity = swr_get_out_samples(self.ctx, (*frame).nb_samples).max(1) as usize;
        let mut planes = vec![vec![0.0f32; out_capacity]; AUDIO_OUTPUT_CHANNELS];
        let mut output_ptrs: Vec<*mut u8> = planes
            .iter_mut()
            .map(|plane| plane.as_mut_ptr() as *mut u8)
            .collect();
        let input_ptrs = (*frame).extended_data as *const *const u8;
        let converted = swr_convert(
            self.ctx,
            output_ptrs.as_mut_ptr(),
            out_capacity as i32,
            input_ptrs,
            (*frame).nb_samples,
        );
        averr(converted, "swr_convert")?;
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            planes[channel].truncate(converted as usize);
            output[channel].extend_from_slice(&planes[channel]);
        }
        Ok(())
    }

    unsafe fn flush(&mut self, output: &mut PlanarPcm) -> Result<()> {
        loop {
            let delay = swr_get_delay(self.ctx, self.input_rate as i64);
            if delay <= 0 {
                break;
            }
            let out_capacity = (((delay * AUDIO_OUTPUT_SAMPLE_RATE as i64)
                + self.input_rate as i64 - 1)
                / self.input_rate as i64
                + 32) as usize;
            let mut planes = vec![vec![0.0f32; out_capacity]; AUDIO_OUTPUT_CHANNELS];
            let mut output_ptrs: Vec<*mut u8> = planes
                .iter_mut()
                .map(|plane| plane.as_mut_ptr() as *mut u8)
                .collect();
            let converted = swr_convert(
                self.ctx,
                output_ptrs.as_mut_ptr(),
                out_capacity as i32,
                ptr::null(),
                0,
            );
            averr(converted, "swr_convert(flush)")?;
            if converted == 0 {
                break;
            }
            for channel in 0..AUDIO_OUTPUT_CHANNELS {
                planes[channel].truncate(converted as usize);
                output[channel].extend_from_slice(&planes[channel]);
            }
        }
        Ok(())
    }
}

impl Drop for AudioResampler {
    fn drop(&mut self) {
        unsafe { swr_free(&mut self.ctx) };
    }
}

/// Un décodeur + resampler par piste audio du conteneur, tous alimentés par la même passe de
/// démux. Chaque piste produit du f32 planaire 48 kHz stéréo recadré sur la même fenêtre
/// source, si bien que le mixage final est une simple somme échantillon par échantillon.
struct AudioTrackDecoder {
    stream_index: i32,
    dctx: *mut AVCodecContext,
    tb_sec: f64,
    resampler: Option<AudioResampler>,
    decoded: PlanarPcm,
    origin_sec: Option<f64>,
    reached_end: bool,
    decoder_eof: bool,
}

impl Drop for AudioTrackDecoder {
    fn drop(&mut self) {
        unsafe { avcodec_free_context(&mut self.dctx) };
    }
}

/// Décode uniquement la fenêtre source conservée. Le seek audio retombe sur une trame
/// antérieure ; l'origine pts du premier bloc resamplé permet ensuite de couper précisément la
/// prélecture sans supposer que la piste commence à t=0.
///
/// TOUTES les pistes audio sont décodées puis mixées. L'enregistreur natif macOS écrit l'audio
/// système et le micro en deux pistes AAC distinctes, toutes deux marquées `default` :
/// `av_find_best_stream` n'en rendait qu'une — la première, silencieuse dès que rien ne joue sur
/// le système — et le micro disparaissait de l'export (issue #108). La PR #109 avait corrigé ce
/// défaut dans l'exporteur navigateur ; l'app n'emprunte plus ce chemin, d'où la même correction
/// ici, dans le chemin natif.
pub fn decode_clip_audio(path: &str, source_start_sec: f64, source_end_sec: f64) -> Result<Option<PlanarPcm>> {
    unsafe { decode_clip_audio_inner(path, source_start_sec, source_end_sec) }
}

unsafe fn decode_clip_audio_inner(
    path: &str,
    source_start_sec: f64,
    source_end_sec: f64,
) -> Result<Option<PlanarPcm>> {
    let mut fmt: *mut AVFormatContext = ptr::null_mut();
    let cpath = CString::new(path)?;
    averr(
        avformat_open_input(&mut fmt, cpath.as_ptr(), ptr::null_mut(), ptr::null_mut()),
        "audio open_input",
    )?;
    averr(avformat_find_stream_info(fmt, ptr::null_mut()), "audio find_stream_info")?;
    // Énumération de toutes les pistes audio (voir le commentaire de `decode_clip_audio`).
    let mut audio_stream_count = 0usize;
    let mut tracks: Vec<AudioTrackDecoder> = Vec::new();
    for index in 0..sn_fmt_nb_streams(fmt) as i32 {
        let stream = sn_fmt_stream(fmt, index);
        let codecpar = (*stream).codecpar;
        if (*codecpar).codec_type != AVMediaType::AVMEDIA_TYPE_AUDIO {
            continue;
        }
        audio_stream_count += 1;
        // Une piste qu'on ne sait pas ouvrir est ignorée, pas fatale : avant ce mixage une
        // seule piste était ouverte, donc une piste annexe exotique ne pouvait pas casser un
        // export. Le `bail!` plus bas garantit qu'on ne perd pas l'audio en silence pour
        // autant — c'est précisément le défaut qu'on corrige ici.
        let decoder = avcodec_find_decoder((*codecpar).codec_id);
        if decoder.is_null() {
            continue;
        }
        let mut dctx = avcodec_alloc_context3(decoder);
        if dctx.is_null() {
            avformat_close_input(&mut fmt);
            bail!("audio avcodec_alloc_context3");
        }
        if avcodec_parameters_to_context(dctx, codecpar) < 0
            || avcodec_open2(dctx, decoder, ptr::null_mut()) < 0
        {
            avcodec_free_context(&mut dctx);
            continue;
        }
        let time_base = (*stream).time_base;
        tracks.push(AudioTrackDecoder {
            stream_index: index,
            dctx,
            tb_sec: if time_base.den != 0 {
                time_base.num as f64 / time_base.den as f64
            } else {
                0.0
            },
            resampler: None,
            decoded: vec![Vec::<f32>::new(); AUDIO_OUTPUT_CHANNELS],
            origin_sec: None,
            reached_end: false,
            decoder_eof: false,
        });
    }
    if tracks.is_empty() {
        avformat_close_input(&mut fmt);
        if audio_stream_count > 0 {
            bail!("audio : {audio_stream_count} piste(s) présentes, aucune décodable");
        }
        return Ok(None);
    }

    // Un seul seek : il repositionne le conteneur entier. On le cale sur la première piste
    // audio puis on vide tous les décodeurs. Si une autre piste reprend légèrement après le
    // début de la fenêtre demandée, son recadrage (plus bas) la zéro-padde devant — le
    // décalage inter-pistes est absorbé là, pas ici.
    let seek_tb_sec = tracks[0].tb_sec;
    let seek_stream_index = tracks[0].stream_index;
    if seek_tb_sec > 0.0 {
        let target = (source_start_sec / seek_tb_sec).floor() as i64;
        if av_seek_frame(fmt, seek_stream_index, target, AVSEEK_FLAG_BACKWARD) >= 0 {
            for track in tracks.iter_mut() {
                avcodec_flush_buffers(track.dctx);
            }
        }
    }

    let mut packet = av_packet_alloc();
    let mut frame = av_frame_alloc();
    let mut input_eof = false;

    // Une seule passe de démux alimente tous les décodeurs : chaque paquet est routé vers la
    // piste dont il porte l'index. On continue tant qu'AU MOINS une piste a encore quelque
    // chose à produire.
    while tracks.iter().any(|t| !t.reached_end && !t.decoder_eof) {
        if !input_eof {
            let read = av_read_frame(fmt, packet);
            if read == AVERROR_EOF {
                for track in tracks.iter_mut() {
                    avcodec_send_packet(track.dctx, ptr::null());
                }
                input_eof = true;
            } else {
                averr(read, "audio av_read_frame")?;
                let packet_stream = (*packet).stream_index;
                if let Some(track) = tracks
                    .iter_mut()
                    .find(|t| t.stream_index == packet_stream && !t.reached_end)
                {
                    averr(avcodec_send_packet(track.dctx, packet), "audio send_packet")?;
                }
                av_packet_unref(packet);
            }
        }

        for track in tracks.iter_mut() {
            if track.reached_end || track.decoder_eof {
                continue;
            }
            loop {
                let ret = avcodec_receive_frame(track.dctx, frame);
                if ret == AVERROR_EOF {
                    track.decoder_eof = true;
                    break;
                }
                if ret == AVERROR_EAGAIN {
                    if input_eof {
                        track.decoder_eof = true;
                    }
                    break;
                }
                averr(ret, "audio receive_frame")?;

                let pts = (*frame).best_effort_timestamp;
                let frame_sec = if pts != i64::MIN && track.tb_sec > 0.0 {
                    pts as f64 * track.tb_sec
                } else {
                    track.origin_sec.unwrap_or(source_start_sec)
                };
                if frame_sec >= source_end_sec {
                    track.reached_end = true;
                    av_frame_unref(frame);
                    break;
                }
                if track.origin_sec.is_none() {
                    track.origin_sec = Some(frame_sec);
                }
                if track.resampler.is_none() {
                    track.resampler = Some(AudioResampler::from_frame(frame, track.dctx)?);
                }
                track
                    .resampler
                    .as_mut()
                    .unwrap()
                    .push(frame, &mut track.decoded)?;
                av_frame_unref(frame);
            }
        }
    }

    for track in tracks.iter_mut() {
        if let Some(r) = track.resampler.as_mut() {
            r.flush(&mut track.decoded)?;
        }
    }

    av_frame_free(&mut frame);
    av_packet_free(&mut packet);
    avformat_close_input(&mut fmt);

    let target_samples = (((source_end_sec - source_start_sec).max(0.0)
        * AUDIO_OUTPUT_SAMPLE_RATE as f64)
        .round()) as usize;
    let aligned: Vec<(f64, &PlanarPcm)> = tracks
        .iter()
        .map(|track| (track.origin_sec.unwrap_or(source_start_sec), &track.decoded))
        .collect();
    Ok(Some(mix_aligned_tracks(
        &aligned,
        source_start_sec,
        target_samples,
    )))
}

/// Recadre chaque piste sur la MÊME fenêtre (`target_samples` échantillons à partir de
/// `source_start_sec`) puis les somme. Une piste dont le premier paquet décodé arrive après le
/// début de la fenêtre est zéro-paddée devant ; la prélecture d'une piste décodée trop tôt (le
/// seek retombe sur une trame antérieure) est coupée. C'est ce recadrage qui absorbe les
/// décalages de départ entre pistes, si bien que le mixage lui-même n'est qu'une somme.
///
/// Séparé du décodage pour être testable sans ffmpeg.
fn mix_aligned_tracks(
    tracks: &[(f64, &PlanarPcm)],
    source_start_sec: f64,
    target_samples: usize,
) -> PlanarPcm {
    let mut mixed = vec![vec![0.0f32; target_samples]; AUDIO_OUTPUT_CHANNELS];
    for &(origin_sec, decoded) in tracks {
        let relative_start =
            ((source_start_sec - origin_sec) * AUDIO_OUTPUT_SAMPLE_RATE as f64).round() as i64;
        let (src_start, dst_start) = if relative_start >= 0 {
            (relative_start as usize, 0usize)
        } else {
            (0usize, (-relative_start) as usize)
        };
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            if src_start >= decoded[channel].len() || dst_start >= target_samples {
                continue;
            }
            let count = (decoded[channel].len() - src_start).min(target_samples - dst_start);
            for offset in 0..count {
                mixed[channel][dst_start + offset] += decoded[channel][src_start + offset];
            }
        }
    }
    // Sommer plusieurs pistes peut dépasser la pleine échelle : on écrête. Sur une source
    // mono-piste, sommer dans un buffer nul est l'identité et on n'écrête pas — le comportement
    // d'avant ce mixage est conservé tel quel.
    if tracks.len() > 1 {
        for plane in mixed.iter_mut() {
            for sample in plane.iter_mut() {
                *sample = sample.clamp(-1.0, 1.0);
            }
        }
    }
    mixed
}

fn hann(length: usize) -> Vec<f32> {
    let mut window = vec![0.0; length];
    for (i, value) in window.iter_mut().enumerate() {
        *value = 0.5 - 0.5 * ((2.0 * PI * i as f32) / (length - 1) as f32).cos();
    }
    window
}

/// Port direct du WSOLA web. Tous les canaux partagent les positions choisies sur un downmix
/// mono, sinon deux recherches indépendantes déplaceraient l'image stéréo.
pub struct WsolaTimeStretcher {
    channels: usize,
    passthrough: bool,
    n: usize,
    hs: usize,
    ha: f64,
    search_radius: i64,
    window: Vec<f32>,
    buf: PlanarPcm,
    mono: Vec<f32>,
    buf_start: i64,
    out: PlanarPcm,
    win_sum: Vec<f32>,
    out_start: usize,
    ideal_pos: f64,
    grain_pos: i64,
    frame: usize,
    placed_any: bool,
}

impl WsolaTimeStretcher {
    pub fn new(
        sample_rate: i32,
        channels: usize,
        speed: f64,
        expected_output_samples: usize,
    ) -> Self {
        let channels = channels.max(1);
        let passthrough = (speed - 1.0).abs() < PASSTHROUGH_EPSILON;
        let mut n = (sample_rate as f64 * DEFAULT_FRAME_SEC).round() as usize;
        n = n.max(4);
        if n % 2 != 0 {
            n += 1;
        }
        let mut hs = n / 2;
        if expected_output_samples > 0 {
            let min_hs = 2usize.max(
                ((sample_rate as f64 * MIN_FRAME_SEC) / 2.0).round() as usize,
            );
            let target_hs = expected_output_samples / TARGET_GRAINS;
            hs = hs.min(min_hs.max(target_hs));
        }
        let n = hs * 2;
        let search_radius = ((sample_rate as f64 * DEFAULT_SEARCH_SEC).round() as usize)
            .min(hs) as i64;
        Self {
            channels,
            passthrough,
            n,
            hs,
            ha: hs as f64 * speed,
            search_radius,
            window: hann(n),
            buf: vec![Vec::new(); channels],
            mono: Vec::new(),
            buf_start: 0,
            out: vec![Vec::new(); channels],
            win_sum: Vec::new(),
            out_start: 0,
            ideal_pos: 0.0,
            grain_pos: 0,
            frame: 0,
            placed_any: false,
        }
    }

    pub fn push(&mut self, planar: &[Vec<f32>]) -> PlanarPcm {
        if self.passthrough {
            return (0..self.channels)
                .map(|channel| {
                    planar
                        .get(channel)
                        .or_else(|| planar.first())
                        .cloned()
                        .unwrap_or_default()
                })
                .collect();
        }
        self.append(planar);
        self.process(false)
    }

    pub fn flush(&mut self) -> PlanarPcm {
        if self.passthrough {
            return self.empty_chunk();
        }
        self.process(true)
    }

    fn empty_chunk(&self) -> PlanarPcm {
        vec![Vec::new(); self.channels]
    }

    fn append(&mut self, planar: &[Vec<f32>]) {
        let add_len = planar.first().map(|p| p.len()).unwrap_or(0);
        if add_len == 0 {
            return;
        }
        for channel in 0..self.channels {
            if let Some(source) = planar.get(channel).or_else(|| planar.first()) {
                self.buf[channel].extend_from_slice(&source[..add_len.min(source.len())]);
                if source.len() < add_len {
                    let target_len = self.buf[channel].len() + add_len - source.len();
                    self.buf[channel].resize(target_len, 0.0);
                }
            }
        }
        for i in 0..add_len {
            let mut sum = 0.0f32;
            for channel in 0..self.channels {
                sum += planar
                    .get(channel)
                    .and_then(|p| p.get(i))
                    .or_else(|| planar.first().and_then(|p| p.get(i)))
                    .copied()
                    .unwrap_or(0.0);
            }
            self.mono.push(sum / self.channels as f32);
        }
    }

    fn buf_end(&self) -> i64 {
        self.buf_start + self.buf[0].len() as i64
    }

    fn sample_at(&self, channel: usize, absolute_index: i64) -> f32 {
        let index = absolute_index - self.buf_start;
        if index < 0 {
            0.0
        } else {
            self.buf[channel].get(index as usize).copied().unwrap_or(0.0)
        }
    }

    fn mono_at(&self, absolute_index: i64) -> f32 {
        let index = absolute_index - self.buf_start;
        if index < 0 {
            0.0
        } else {
            self.mono.get(index as usize).copied().unwrap_or(0.0)
        }
    }

    fn process(&mut self, final_chunk: bool) -> PlanarPcm {
        let mut emitted = self.empty_chunk();
        loop {
            let search_target = (self.ideal_pos + self.ha).round() as i64;
            let required_end = (self.grain_pos + self.n as i64)
                .max(self.grain_pos + self.hs as i64 + self.n as i64)
                .max(search_target + self.search_radius + self.n as i64);
            if !final_chunk && self.buf_end() < required_end {
                break;
            }
            if self.grain_pos + self.n as i64 > self.buf_end() {
                break;
            }

            self.place_grain(self.grain_pos);
            let placed_frame = self.frame;
            let reference_start = self.grain_pos + self.hs as i64;
            let best_delta = self.find_best_delta(reference_start, search_target);
            self.grain_pos = search_target + best_delta;
            self.ideal_pos += self.ha;
            self.frame += 1;

            self.collect(placed_frame * self.hs, &mut emitted);
            self.discard_below(self.grain_pos);
        }
        if final_chunk {
            self.collect_all(&mut emitted);
        }
        emitted
    }

    fn place_grain(&mut self, position: i64) {
        let output_absolute = self.frame * self.hs;
        self.ensure_out(output_absolute + self.n);
        let base = output_absolute - self.out_start;
        for channel in 0..self.channels {
            for k in 0..self.n {
                let sample = self.sample_at(channel, position + k as i64);
                self.out[channel][base + k] += sample * self.window[k];
            }
        }
        for k in 0..self.n {
            self.win_sum[base + k] += self.window[k];
        }
        self.placed_any = true;
    }

    fn find_best_delta(&self, reference_start: i64, target: i64) -> i64 {
        if reference_start + self.n as i64 > self.buf_end() {
            return 0;
        }
        let mut reference_energy = 0.0f32;
        for k in 0..self.n {
            let sample = self.mono_at(reference_start + k as i64);
            reference_energy += sample * sample;
        }
        if reference_energy == 0.0 {
            return 0;
        }

        let mut best_delta = 0;
        let mut best_score = f32::NEG_INFINITY;
        let low = (-self.search_radius).max(self.buf_start - target);
        let high = self
            .search_radius
            .min(self.buf_end() - self.n as i64 - target);
        for delta in low..=high {
            let candidate_start = target + delta;
            let mut dot = 0.0f32;
            let mut energy = 0.0f32;
            for k in 0..self.n {
                let candidate = self.mono_at(candidate_start + k as i64);
                dot += candidate * self.mono_at(reference_start + k as i64);
                energy += candidate * candidate;
            }
            let score = if energy > 0.0 { dot / energy.sqrt() } else { 0.0 };
            if score > best_score {
                best_score = score;
                best_delta = delta;
            }
        }
        best_delta
    }

    fn ensure_out(&mut self, absolute_end: usize) {
        let needed = absolute_end - self.out_start;
        if needed <= self.out[0].len() {
            return;
        }
        let next_len = needed.max(self.out[0].len() * 2).max(self.n * 4);
        for channel in 0..self.channels {
            self.out[channel].resize(next_len, 0.0);
        }
        self.win_sum.resize(next_len, 0.0);
    }

    fn collect(&mut self, absolute_end: usize, emitted: &mut PlanarPcm) {
        let count = absolute_end.saturating_sub(self.out_start);
        if count == 0 {
            return;
        }
        for channel in 0..self.channels {
            for i in 0..count {
                let weight = self.win_sum[i];
                let mut sample = self.out[channel][i];
                if weight > 1e-6 {
                    sample /= weight;
                }
                emitted[channel].push(sample);
            }
            self.out[channel] = self.out[channel][count..].to_vec();
        }
        self.win_sum = self.win_sum[count..].to_vec();
        self.out_start = absolute_end;
    }

    fn collect_all(&mut self, emitted: &mut PlanarPcm) {
        if !self.placed_any {
            return;
        }
        let end = (self.frame - 1) * self.hs + self.n;
        self.collect(end, emitted);
    }

    fn discard_below(&mut self, absolute_index: i64) {
        let drop_count = absolute_index - self.buf_start;
        if drop_count <= 0 {
            return;
        }
        let drop_count = drop_count as usize;
        for channel in 0..self.channels {
            self.buf[channel] = self.buf[channel][drop_count.min(self.buf[channel].len())..].to_vec();
        }
        self.mono = self.mono[drop_count.min(self.mono.len())..].to_vec();
        self.buf_start = absolute_index;
    }
}

fn stretch_pcm_to_length(pcm: &[Vec<f32>], target_samples: usize) -> PlanarPcm {
    if target_samples == 0 {
        return vec![Vec::new(); AUDIO_OUTPUT_CHANNELS];
    }
    let source_samples = pcm.first().map(|channel| channel.len()).unwrap_or(0);
    if source_samples == 0 {
        return vec![vec![0.0; target_samples]; AUDIO_OUTPUT_CHANNELS];
    }
    if source_samples.abs_diff(target_samples) <= 1 {
        let mut exact = vec![vec![0.0; target_samples]; AUDIO_OUTPUT_CHANNELS];
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            if let Some(source) = pcm.get(channel) {
                let count = source.len().min(target_samples);
                exact[channel][..count].copy_from_slice(&source[..count]);
            }
        }
        return exact;
    }

    let speed = source_samples as f64 / target_samples as f64;
    let mut stretcher = WsolaTimeStretcher::new(
        AUDIO_OUTPUT_SAMPLE_RATE,
        AUDIO_OUTPUT_CHANNELS,
        speed,
        target_samples,
    );
    let chunks = [stretcher.push(pcm), stretcher.flush()];
    let mut exact = vec![vec![0.0; target_samples]; AUDIO_OUTPUT_CHANNELS];
    for channel in 0..AUDIO_OUTPUT_CHANNELS {
        let mut written = 0usize;
        for chunk in &chunks {
            let source = &chunk[channel];
            let count = source.len().min(target_samples - written);
            if count > 0 {
                exact[channel][written..written + count].copy_from_slice(&source[..count]);
                written += count;
            }
            if written == target_samples {
                break;
            }
        }
    }
    exact
}

/// Découpe le PCM gardé avec les mêmes spans et la même quantification frame que la vidéo.
pub fn stretch_clip_pcm_by_speed(
    pcm: &[Vec<f32>],
    speed_segments: &[SpeedSegment],
    output_fps: f64,
) -> PlanarPcm {
    let total_source_samples = pcm.first().map(|channel| channel.len()).unwrap_or(0);
    let mut source_cursor = 0usize;
    let mut chunks: Vec<PlanarPcm> = Vec::with_capacity(speed_segments.len());
    for segment in speed_segments {
        let input_samples = ((segment.end_sec - segment.start_sec)
            * AUDIO_OUTPUT_SAMPLE_RATE as f64)
            .round()
            .max(0.0) as usize;
        let input_start = source_cursor;
        let input_end = (input_start + input_samples).min(total_source_samples);
        source_cursor = input_start + input_samples;
        let output_samples = ((segment.frame_count as f64 / output_fps)
            * AUDIO_OUTPUT_SAMPLE_RATE as f64)
            .round()
            .max(0.0) as usize;
        if input_end <= input_start {
            chunks.push(vec![vec![0.0; output_samples]; AUDIO_OUTPUT_CHANNELS]);
            continue;
        }
        let slice: PlanarPcm = (0..AUDIO_OUTPUT_CHANNELS)
            .map(|channel| pcm[channel][input_start..input_end].to_vec())
            .collect();
        chunks.push(stretch_pcm_to_length(&slice, output_samples));
    }

    let mut output = vec![Vec::new(); AUDIO_OUTPUT_CHANNELS];
    for chunk in chunks {
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            output[channel].extend_from_slice(&chunk[channel]);
        }
    }
    output
}

#[derive(Clone, Copy)]
pub struct AudioConcatSegmentPlan {
    pub start_sample: usize,
    pub sample_count: usize,
    pub silence: bool,
}

pub struct AudioConcatPlan {
    pub total_samples: usize,
    pub segments: Vec<AudioConcatSegmentPlan>,
}

/// Les offsets sont la somme ENTIÈRE des longueurs arrondies clip par clip ; recalculer depuis
/// une durée cumulée ferait dériver les jonctions sur une longue timeline.
pub fn build_audio_concat_plan(
    output_frame_counts: &[u64],
    has_audio: &[bool],
    output_fps: f64,
) -> AudioConcatPlan {
    let mut cursor = 0usize;
    let mut segments = Vec::with_capacity(output_frame_counts.len());
    for (index, &frame_count) in output_frame_counts.iter().enumerate() {
        let sample_count = if output_fps > 0.0 {
            ((frame_count as f64 / output_fps) * AUDIO_OUTPUT_SAMPLE_RATE as f64)
                .round()
                .max(0.0) as usize
        } else {
            0
        };
        segments.push(AudioConcatSegmentPlan {
            start_sample: cursor,
            sample_count,
            silence: !has_audio.get(index).copied().unwrap_or(false),
        });
        cursor += sample_count;
    }
    AudioConcatPlan { total_samples: cursor, segments }
}

pub fn assemble_concatenated_pcm(
    clip_pcm: &[Option<PlanarPcm>],
    plan: &AudioConcatPlan,
) -> PlanarPcm {
    let mut output = vec![vec![0.0f32; plan.total_samples]; AUDIO_OUTPUT_CHANNELS];
    for (index, segment) in plan.segments.iter().enumerate() {
        if segment.sample_count == 0 || segment.silence {
            continue;
        }
        let Some(Some(pcm)) = clip_pcm.get(index) else {
            continue;
        };
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            let Some(source) = pcm.get(channel) else {
                continue;
            };
            let count = segment.sample_count.min(source.len());
            output[channel][segment.start_sample..segment.start_sample + count]
                .copy_from_slice(&source[..count]);
        }
    }

    for boundary in plan.segments.windows(2) {
        let current = boundary[0];
        let next = boundary[1];
        let fade = AUDIO_BOUNDARY_FADE_SAMPLES
            .min(current.sample_count / 2)
            .min(next.sample_count / 2);
        if fade == 0 {
            continue;
        }
        let tail_start = current.start_sample + current.sample_count - fade;
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            for k in 0..fade {
                let phase = (k as f32 / fade as f32) * PI * 0.5;
                output[channel][tail_start + k] *= phase.cos();
                output[channel][next.start_sample + k] *= phase.sin();
            }
        }
    }
    output
}

/// Encodeur AAC attaché au muxer avant son header. Les paquets utilisent le même interleaver
/// que la vidéo ; les pts restent en unités échantillon jusqu'au rescale vers l'AVStream.
pub(crate) struct AacEncoder {
    context: *mut AVCodecContext,
    stream: *mut AVStream,
    packet: *mut AVPacket,
}

impl AacEncoder {
    pub(crate) unsafe fn open(output: *mut AVFormatContext) -> Result<Self> {
        let name = CString::new("aac")?;
        let codec = avcodec_find_encoder_by_name(name.as_ptr());
        if codec.is_null() {
            bail!("encodeur aac introuvable");
        }
        let context = avcodec_alloc_context3(codec);
        if context.is_null() {
            bail!("aac avcodec_alloc_context3");
        }
        (*context).sample_fmt = AVSampleFormat::AV_SAMPLE_FMT_FLTP;
        (*context).sample_rate = AUDIO_OUTPUT_SAMPLE_RATE;
        (*context).bit_rate = AUDIO_BITRATE;
        (*context).time_base = AVRational { num: 1, den: AUDIO_OUTPUT_SAMPLE_RATE };
        av_channel_layout_default(&mut (*context).ch_layout, AUDIO_OUTPUT_CHANNELS as i32);
        averr(avcodec_open2(context, codec, ptr::null_mut()), "aac avcodec_open2")?;

        let stream = avformat_new_stream(output, ptr::null());
        if stream.is_null() {
            bail!("aac avformat_new_stream");
        }
        averr(
            avcodec_parameters_from_context((*stream).codecpar, context),
            "aac parameters_from_context",
        )?;
        (*stream).time_base = (*context).time_base;
        let packet = av_packet_alloc();
        if packet.is_null() {
            bail!("aac av_packet_alloc");
        }
        Ok(Self { context, stream, packet })
    }

    pub(crate) unsafe fn encode(&mut self, pcm: &[Vec<f32>], output: *mut AVFormatContext) -> Result<()> {
        let total_samples = pcm.first().map(|channel| channel.len()).unwrap_or(0);
        let frame_size = if (*self.context).frame_size > 0 {
            (*self.context).frame_size as usize
        } else {
            1024
        };
        let mut offset = 0usize;
        while offset < total_samples {
            let sample_count = frame_size.min(total_samples - offset);
            let mut frame = av_frame_alloc();
            if frame.is_null() {
                bail!("aac av_frame_alloc");
            }
            (*frame).format = (*self.context).sample_fmt as i32;
            (*frame).sample_rate = AUDIO_OUTPUT_SAMPLE_RATE;
            (*frame).nb_samples = sample_count as i32;
            averr(
                av_channel_layout_copy(&mut (*frame).ch_layout, &(*self.context).ch_layout),
                "aac channel_layout_copy",
            )?;
            averr(av_frame_get_buffer(frame, 0), "aac frame_get_buffer")?;
            averr(av_frame_make_writable(frame), "aac frame_make_writable")?;
            for channel in 0..AUDIO_OUTPUT_CHANNELS {
                let destination = *(*frame).extended_data.add(channel) as *mut f32;
                ptr::write_bytes(destination, 0, sample_count);
                if let Some(source) = pcm.get(channel) {
                    let available = source.len().saturating_sub(offset).min(sample_count);
                    if available > 0 {
                        ptr::copy_nonoverlapping(source.as_ptr().add(offset), destination, available);
                    }
                }
            }
            (*frame).pts = offset as i64;
            averr(avcodec_send_frame(self.context, frame), "aac send_frame")?;
            self.drain(output)?;
            av_frame_free(&mut frame);
            offset += sample_count;
        }
        averr(avcodec_send_frame(self.context, ptr::null()), "aac flush")?;
        self.drain(output)
    }

    unsafe fn drain(&mut self, output: *mut AVFormatContext) -> Result<()> {
        loop {
            let ret = avcodec_receive_packet(self.context, self.packet);
            if ret == AVERROR_EAGAIN || ret == AVERROR_EOF {
                return Ok(());
            }
            averr(ret, "aac receive_packet")?;
            (*self.packet).stream_index = (*self.stream).index;
            av_packet_rescale_ts(self.packet, (*self.context).time_base, (*self.stream).time_base);
            averr(
                av_interleaved_write_frame(output, self.packet),
                "aac interleaved_write_frame",
            )?;
            av_packet_unref(self.packet);
        }
    }
}

impl Drop for AacEncoder {
    fn drop(&mut self) {
        unsafe {
            av_packet_free(&mut self.packet);
            avcodec_free_context(&mut self.context);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Même contenu sur les deux canaux : le mixage travaille canal par canal, donc asserter sur
    /// un seul suffit, mais les deux plans doivent exister (le format de sortie est stéréo).
    fn planar(samples: &[f32]) -> PlanarPcm {
        vec![samples.to_vec(), samples.to_vec()]
    }

    #[test]
    fn single_track_passes_through_unchanged() {
        let track = planar(&[0.25, -0.5, 0.75]);
        let mixed = mix_aligned_tracks(&[(0.0, &track)], 0.0, 3);
        assert_eq!(mixed[0], vec![0.25, -0.5, 0.75]);
        assert_eq!(mixed[1], vec![0.25, -0.5, 0.75]);
    }

    #[test]
    fn single_track_is_not_clamped() {
        // Promesse de non-régression : une source mono-piste ressort telle quelle, y compris
        // hors pleine échelle. Seul le mixage multipiste écrête.
        let track = planar(&[1.5, -1.5]);
        let mixed = mix_aligned_tracks(&[(0.0, &track)], 0.0, 2);
        assert_eq!(mixed[0], vec![1.5, -1.5]);
    }

    #[test]
    fn silent_first_track_does_not_swallow_the_microphone() {
        // Le cas de l'issue #108 : l'enregistreur natif macOS écrit l'audio système en première
        // piste (silencieuse si rien ne joue) et le micro en seconde. `av_find_best_stream` ne
        // rendait que la première, et l'export sortait muet.
        let system_audio = planar(&[0.0, 0.0, 0.0]);
        let microphone = planar(&[0.3, -0.4, 0.5]);
        let mixed = mix_aligned_tracks(&[(0.0, &system_audio), (0.0, &microphone)], 0.0, 3);
        assert_eq!(mixed[0], vec![0.3, -0.4, 0.5]);
    }

    #[test]
    fn tracks_are_summed() {
        let a = planar(&[0.1, 0.2]);
        let b = planar(&[0.2, 0.3]);
        let mixed = mix_aligned_tracks(&[(0.0, &a), (0.0, &b)], 0.0, 2);
        assert!((mixed[0][0] - 0.3).abs() < 1e-6);
        assert!((mixed[0][1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn multi_track_sum_is_clamped_to_full_scale() {
        let a = planar(&[0.8, -0.8]);
        let b = planar(&[0.8, -0.8]);
        let mixed = mix_aligned_tracks(&[(0.0, &a), (0.0, &b)], 0.0, 2);
        assert_eq!(mixed[0], vec![1.0, -1.0]);
    }

    #[test]
    fn a_track_starting_late_is_zero_padded_at_the_front() {
        // La piste commence 1 ms après le début de la fenêtre demandée : 48 échantillons de
        // silence devant, son contenu ensuite. Sans ce recadrage, sommer désalignerait les pistes.
        let late = planar(&[0.5; 8]);
        let mixed = mix_aligned_tracks(&[(0.001, &late)], 0.0, 64);
        assert_eq!(&mixed[0][..48], &[0.0f32; 48][..]);
        assert_eq!(&mixed[0][48..56], &[0.5f32; 8][..]);
        assert_eq!(&mixed[0][56..], &[0.0f32; 8][..]);
    }

    #[test]
    fn a_track_decoded_early_has_its_prefetch_trimmed() {
        // Le seek audio retombe sur une trame antérieure à la fenêtre : cette prélecture est
        // coupée, pas mixée.
        let mut samples = vec![0.0f32; 48];
        samples.extend_from_slice(&[0.5; 8]);
        let early = planar(&samples);
        let mixed = mix_aligned_tracks(&[(-0.001, &early)], 0.0, 8);
        assert_eq!(mixed[0], vec![0.5; 8]);
    }

    /// The gain must be the SAME scalar the editor preview feeds its GainNode
    /// (`10 ** (dB / 20)`), because that identity is the whole parity guarantee: nothing
    /// else stands between what the editor plays and what this writes.
    #[test]
    fn output_trim_is_the_same_scalar_the_preview_applies() {
        for gain_db in [-12.0f32, -6.0206, 0.0, 6.0206, 12.0] {
            let result = finish_audio(
                planar(&[0.25, -0.25]),
                SceneAudio { gain_db },
            );
            let expected = (0.25 * 10.0f32.powf(gain_db / 20.0)).clamp(-1.0, 1.0);
            assert!(
                (result[0][0] - expected).abs() < 1e-6,
                "gain {gain_db} dB: got {}, want {expected}",
                result[0][0]
            );
            assert!((result[0][1] + expected).abs() < 1e-6);
        }
    }

    #[test]
    fn out_of_range_gain_is_clamped_to_the_editor_bound() {
        // A hand-edited project, the AI edition agent, or a future UI change must not be
        // able to ask for a gain the slider cannot display.
        let quiet = finish_audio(planar(&[0.5]), SceneAudio { gain_db: -99.0 });
        let floor = 0.5 * 10.0f32.powf(-12.0 / 20.0);
        assert!((quiet[0][0] - floor).abs() < 1e-6);

        let loud = finish_audio(planar(&[0.1]), SceneAudio { gain_db: 99.0 });
        let ceiling = 0.1 * 10.0f32.powf(12.0 / 20.0);
        assert!((loud[0][0] - ceiling).abs() < 1e-6);
    }

    #[test]
    fn output_is_clipped_to_full_scale_and_keeps_its_length() {
        // The trim can push a hot signal past full scale; the timeline must come back the
        // same length either way, or video and the following clips drift against it.
        let result = finish_audio(planar(&[0.9, -0.9, 0.1]), SceneAudio { gain_db: 12.0 });
        assert_eq!(result[0].len(), 3);
        assert_eq!(result[0][0], 1.0);
        assert_eq!(result[0][1], -1.0);
        assert!((result[0][2] - 0.1 * 10.0f32.powf(12.0 / 20.0)).abs() < 1e-6);
    }
}
