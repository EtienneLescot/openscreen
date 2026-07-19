//! Piste audio native de l'export multiclip : ffmpeg décode les sources écran, swresample
//! normalise tout en f32 planaire 48 kHz stéréo, WSOLA applique les speed regions, puis un
//! unique encodeur AAC alimente le même muxer que la vidéo.

use crate::ffi::*;
use crate::regions::SpeedSegment;
use anyhow::{bail, Result};
use std::f32::consts::PI;
use std::ffi::CString;
use std::ptr;

pub const AUDIO_OUTPUT_SAMPLE_RATE: i32 = 48_000;
pub const AUDIO_OUTPUT_CHANNELS: usize = 2;
pub const AUDIO_BITRATE: i64 = 128_000;
pub const AUDIO_BOUNDARY_FADE_SAMPLES: usize = 240;

const AVERROR_EAGAIN: i32 = -11;
const AVERROR_EOF: i32 = -541478725;
const AVSEEK_FLAG_BACKWARD: i32 = 1;
const DEFAULT_FRAME_SEC: f64 = 0.04;
const MIN_FRAME_SEC: f64 = 0.005;
const DEFAULT_SEARCH_SEC: f64 = 0.01;
const TARGET_GRAINS: usize = 8;
const PASSTHROUGH_EPSILON: f64 = 1e-3;

pub type PlanarPcm = Vec<Vec<f32>>;

extern "C" {
    fn sn_fmt_stream(s: *mut AVFormatContext, i: i32) -> *mut AVStream;
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

/// Décode uniquement la fenêtre source conservée. Le seek audio retombe sur une trame
/// antérieure ; l'origine pts du premier bloc resamplé permet ensuite de couper précisément la
/// prélecture sans supposer que la piste commence à t=0.
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
    let audio_index = av_find_best_stream(
        fmt,
        AVMediaType::AVMEDIA_TYPE_AUDIO,
        -1,
        -1,
        ptr::null_mut(),
        0,
    );
    if audio_index < 0 {
        avformat_close_input(&mut fmt);
        return Ok(None);
    }

    let stream = sn_fmt_stream(fmt, audio_index);
    let codecpar = (*stream).codecpar;
    let decoder = avcodec_find_decoder((*codecpar).codec_id);
    if decoder.is_null() {
        avformat_close_input(&mut fmt);
        return Ok(None);
    }
    let mut dctx = avcodec_alloc_context3(decoder);
    if dctx.is_null() {
        avformat_close_input(&mut fmt);
        bail!("audio avcodec_alloc_context3");
    }
    averr(avcodec_parameters_to_context(dctx, codecpar), "audio params_to_ctx")?;
    averr(avcodec_open2(dctx, decoder, ptr::null_mut()), "audio avcodec_open2")?;

    let time_base = (*stream).time_base;
    let tb_sec = if time_base.den != 0 {
        time_base.num as f64 / time_base.den as f64
    } else {
        0.0
    };
    if tb_sec > 0.0 {
        let target = (source_start_sec / tb_sec).floor() as i64;
        if av_seek_frame(fmt, audio_index, target, AVSEEK_FLAG_BACKWARD) >= 0 {
            avcodec_flush_buffers(dctx);
        }
    }

    let mut packet = av_packet_alloc();
    let mut frame = av_frame_alloc();
    let mut resampler: Option<AudioResampler> = None;
    let mut decoded = vec![Vec::<f32>::new(); AUDIO_OUTPUT_CHANNELS];
    let mut decoded_origin_sec: Option<f64> = None;
    let mut input_eof = false;
    let mut decoder_eof = false;
    let mut reached_end = false;

    while !reached_end && !decoder_eof {
        if !input_eof {
            let read = av_read_frame(fmt, packet);
            if read == AVERROR_EOF {
                avcodec_send_packet(dctx, ptr::null());
                input_eof = true;
            } else {
                averr(read, "audio av_read_frame")?;
                if (*packet).stream_index == audio_index {
                    averr(avcodec_send_packet(dctx, packet), "audio send_packet")?;
                }
                av_packet_unref(packet);
            }
        }

        loop {
            let ret = avcodec_receive_frame(dctx, frame);
            if ret == AVERROR_EOF {
                decoder_eof = true;
                break;
            }
            if ret == AVERROR_EAGAIN {
                if input_eof {
                    decoder_eof = true;
                }
                break;
            }
            averr(ret, "audio receive_frame")?;

            let pts = (*frame).best_effort_timestamp;
            let frame_sec = if pts != i64::MIN && tb_sec > 0.0 {
                pts as f64 * tb_sec
            } else {
                decoded_origin_sec.unwrap_or(source_start_sec)
            };
            if frame_sec >= source_end_sec {
                reached_end = true;
                av_frame_unref(frame);
                break;
            }
            if decoded_origin_sec.is_none() {
                decoded_origin_sec = Some(frame_sec);
            }
            if resampler.is_none() {
                resampler = Some(AudioResampler::from_frame(frame, dctx)?);
            }
            resampler.as_mut().unwrap().push(frame, &mut decoded)?;
            av_frame_unref(frame);
        }
    }

    if let Some(r) = resampler.as_mut() {
        r.flush(&mut decoded)?;
    }

    av_frame_free(&mut frame);
    av_packet_free(&mut packet);
    avcodec_free_context(&mut dctx);
    avformat_close_input(&mut fmt);

    let target_samples = (((source_end_sec - source_start_sec).max(0.0)
        * AUDIO_OUTPUT_SAMPLE_RATE as f64)
        .round()) as usize;
    let mut trimmed = vec![vec![0.0f32; target_samples]; AUDIO_OUTPUT_CHANNELS];
    let origin_sec = decoded_origin_sec.unwrap_or(source_start_sec);
    let relative_start = ((source_start_sec - origin_sec) * AUDIO_OUTPUT_SAMPLE_RATE as f64).round() as i64;
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
        trimmed[channel][dst_start..dst_start + count]
            .copy_from_slice(&decoded[channel][src_start..src_start + count]);
    }
    Ok(Some(trimmed))
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
