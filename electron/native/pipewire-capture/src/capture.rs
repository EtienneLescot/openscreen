//! The video half of Stage 2: PipeWire frames in, MP4 on disk out.
//!
//! CONSTANT FRAME RATE, DRIVEN BY A CLOCK, NOT BY ARRIVALS.
//!
//! A compositor delivers frames on damage. Nothing moves on screen, no frames
//! arrive — mutter will happily go seconds without one while the user reads a
//! page. Writing one output frame per delivered frame would therefore produce a
//! file whose playback speed depends on how busy the screen was, which is not a
//! recording of anything.
//!
//! So the output rate comes from a monotonic clock instead. [`Capture::advance`]
//! asks what frame index the wall clock is on and encodes forward to it, holding
//! the last staged picture across the gap. That is why [`crate::encoder`] splits
//! conversion from encoding: a held frame costs an upload and an encode (1.4 ms
//! here) but not the colour conversion (3.6 ms), which is the expensive part.
//!
//! The clock is ours, not the compositor's. `SPA_META_Header.pts` is more precise
//! per frame, but pause/resume and — once Stage 2's audio lands — the audio
//! epoch all live on this process's monotonic clock, and quantising to 1/60 s
//! makes the difference between the two immaterial.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::encoder::{
    AudioEncoder, Backend, EncodeStats, Muxer, TrackId, VideoEncoder, VideoParams,
    AUDIO_CHANNELS, AUDIO_SAMPLE_RATE,
};
use crate::ffmpeg as ff;
use crate::shim::{self, AudioRing};

/// An audio capture to mux alongside the video.
pub struct AudioSource {
    /// "system" or "microphone" — the label a warning names.
    pub label: &'static str,
    pub ring: Arc<AudioRing>,
    /// Linear multiplier applied before encoding. 1.0 for the system mix; the
    /// microphone carries the UI's boost.
    pub gain: f32,
    pub bitrate: i64,
}

/// One capture feeding the mix.
struct AudioInput {
    label: &'static str,
    ring: Arc<AudioRing>,
    gain: f32,
    /// Samples drained but not yet mixed, because the other inputs had fewer.
    pending: Vec<f32>,
}

/// The single AAC track, and everything mixed into it.
///
/// ONE TRACK, NOT ONE PER SOURCE. The first shape of this code followed macOS
/// and wrote system audio and the microphone as two separate AAC tracks, on the
/// grounds that the export mixes every track it finds
/// (`crates/compositor/src/audio.rs`). What that missed is that THE PREVIEW DOES
/// NOT: it plays an HTML5 `<video>` element, which plays only the default audio
/// track and cannot be told to switch, because Chromium does not implement the
/// `audioTracks` API. With system audio first and nothing playing, the preview
/// was silent while the microphone sat in a track nothing would ever select.
///
/// The Windows helper has always written one mixed track
/// (`mf_encoder.cpp` has a single `audioStreamIndex_`, fed by `AudioMixer`), and
/// macOS has since done the same (`AudioTrackMixer` feeding the helper's single
/// `AVAssetWriterInput(mediaType: .audio)`). All three now agree.
struct AudioMix {
    inputs: Vec<AudioInput>,
    encoder: AudioEncoder,
    track: TrackId,
    /// Reused across drains so the steady state allocates nothing.
    scratch: Vec<f32>,
}

/// How far one input may lag behind another before it is treated as silent
/// rather than allowed to stall the track.
///
/// Mixing consumes `min(available)` across inputs so that neither runs ahead of
/// the other. Taken literally that means one dead input — a microphone
/// unplugged mid-recording — freezes the whole track, because its `min` stays
/// zero forever. A quarter of a second of slack is far more than the jitter
/// between two streams of the same 48 kHz graph, and far less than anyone can
/// hear as a gap.
const AUDIO_STARVE_SAMPLES: usize = AUDIO_SAMPLE_RATE as usize / 4 * AUDIO_CHANNELS;

impl AudioMix {
    /// Drains every input, mixes what they have in common, and encodes it.
    ///
    /// `flush` is set once at stop: it mixes whatever remains even when the
    /// inputs are unevenly filled, because there will be no more samples to even
    /// them out.
    fn pump(&mut self, muxer: &mut Muxer, flush: bool) -> Result<(), String> {
        for input in &mut self.inputs {
            input.ring.drain_into(&mut input.pending);
        }

        let shortest = self.inputs.iter().map(|i| i.pending.len()).min().unwrap_or(0);
        let longest = self.inputs.iter().map(|i| i.pending.len()).max().unwrap_or(0);
        // Normally consume only what every input can supply, so none runs ahead.
        // When one has fallen far behind — or at flush, when nothing more is
        // coming — take the longest and let the short ones contribute silence,
        // rather than letting a dead input freeze the track. See
        // AUDIO_STARVE_SAMPLES.
        let take = if flush || longest.saturating_sub(shortest) > AUDIO_STARVE_SAMPLES {
            longest
        } else {
            shortest
        };
        if take == 0 {
            return Ok(());
        }

        self.scratch.clear();
        self.scratch.resize(take, 0.0);
        for input in &mut self.inputs {
            let n = input.pending.len().min(take);
            for (out, sample) in self.scratch.iter_mut().zip(input.pending.drain(..n)) {
                // Summed, then clamped ONCE at the end rather than per input:
                // clamping each contribution would quietly attenuate the mix
                // whenever one source alone is already near full scale.
                *out += sample * input.gain;
            }
        }
        for sample in &mut self.scratch {
            // A boosted microphone over loud system audio must clip flat. An
            // out-of-range float survives until AAC quantises it and then wraps
            // to the opposite polarity, which sounds like a burst of noise.
            *sample = sample.clamp(-1.0, 1.0);
        }

        let id = self.track;
        let scratch = std::mem::take(&mut self.scratch);
        let result = self.encoder.push(&scratch, |packet| muxer.write(id, packet));
        self.scratch = scratch;
        result
    }

    /// Samples the rings had to discard, per input. Audible, unlike a dropped
    /// video frame.
    fn dropped(&self) -> Vec<(&'static str, u64)> {
        self.inputs
            .iter()
            .map(|input| (input.label, input.ring.dropped_samples()))
            .filter(|(_, dropped)| *dropped > 0)
            .collect()
    }
}

/// Frames encoded in one `advance` before returning to the event loop.
///
/// Without a bound, a long stall would be paid back in a single burst that also
/// blocks `stop` for as long as it takes. At the measured 1.4 ms per held frame
/// this is ~11 ms of work per wakeup, which still catches up eight times faster
/// than real time while leaving the loop responsive.
const MAX_CATCHUP_FRAMES: u32 = 8;

pub struct Selection {
    pub backend: Backend,
    /// One line per backend the ladder tried and refused, in order.
    pub rejected: Vec<String>,
}

/// Bits per pixel per frame for H.264 screen content.
///
/// Screen recordings are mostly static and compress far better than camera
/// footage, so this sits well below the ~0.2 a live-action encode would want.
/// At 1920×1080/60 it comes to about 12 Mbit/s.
const BITS_PER_PIXEL: f64 = 0.1;

/// Picks a video bitrate from the size the compositor actually negotiated.
///
/// THE CALLER CANNOT DO THIS. On Wayland the app does not know the capture
/// resolution until the portal has negotiated it — the user picks the source in
/// the compositor's own dialog, and it may be a window rather than a display.
/// The renderer therefore sends no bitrate at all. It used to send
/// `computeBitrate(TARGET_WIDTH, TARGET_HEIGHT)`, whose constants are 4K, so a
/// 1080p capture asked for 76.5 Mbit/s and produced 44 MB for 18 seconds.
fn default_bitrate(width: i32, height: i32, fps: i32) -> i64 {
    let pixels_per_second = f64::from(width.max(1)) * f64::from(height.max(1)) * f64::from(fps.max(1));
    // Floor so that a tiny window capture still gets enough bits to look sharp,
    // ceiling so that a 4K/120 stream cannot ask for something no disk wants.
    ((pixels_per_second * BITS_PER_PIXEL) as i64).clamp(2_000_000, 60_000_000)
}

pub struct Summary {
    pub path: PathBuf,
    pub duration_ms: u64,
    pub frames: u64,
    pub stats: EncodeStats,
}

pub struct Capture {
    encoder: VideoEncoder,
    /// The dmabuf → VAAPI importer, present only on the zero-copy path (issue
    /// #507). When set, [`Self::stage`] imports the frame's descriptor into an
    /// NV12 surface instead of running swscale, and the encoder was opened
    /// against this importer's pool.
    importer: Option<crate::dmabuf_import::DmabufImporter>,
    video_track: TrackId,
    audio: Option<AudioMix>,
    /// `None` only between [`Self::finish`] taking it and the struct dropping.
    muxer: Option<Muxer>,
    path: PathBuf,
    fps: i32,
    /// Monotonic instant of output frame 0. Set when the FIRST frame is staged,
    /// not at construction: the gap between opening the encoder and the
    /// compositor's first frame is portal and negotiation latency, and starting
    /// the timeline before it would put that latency at the head of every
    /// recording.
    epoch: Option<Instant>,
    /// Time spent paused, subtracted from the elapsed clock so a resumed
    /// recording continues where it left off instead of leaving a gap.
    paused_total: Duration,
    paused_at: Option<Instant>,
    /// The next output frame index to write.
    next_index: i64,
    frames_written: u64,
    /// The size the encoder was opened at, latched for the whole file.
    ///
    /// An MP4 track cannot change resolution mid-file, but a window's crop rect
    /// can change on ANY buffer — mutter never renegotiates the format for a
    /// window stream, so a resize travels down the crop and nothing else. The
    /// committed size is therefore the contract, and a later crop is read
    /// through it rather than replacing it.
    committed_width: i32,
    committed_height: i32,
}

/// The outcome of staging one captured frame.
#[derive(Debug, PartialEq, Eq)]
pub enum StageOutcome {
    /// A new frame was staged; `advance` will encode it.
    Staged,
    /// A recoverable per-frame failure — one dmabuf the GPU could not map, or a
    /// transient EAGAIN. The frame is skipped and `advance` holds the previously
    /// staged one forward, so a single bad frame costs one frame, not the whole
    /// recording. Carries the reason for a log warning.
    Dropped(String),
}

impl Capture {
    pub fn start(
        path: &Path,
        width: i32,
        height: i32,
        fps: i32,
        // `None` derives one from the negotiated size, which is almost always
        // what the caller wants — see `default_bitrate`.
        bitrate: Option<i64>,
        forced: Option<Backend>,
        audio_sources: Vec<AudioSource>,
        // Present when the first frame is a tiled dmabuf: the encoder is then
        // opened to consume the importer's NV12 pool directly (issue #507).
        dmabuf: Option<&shim::DmabufDesc>,
    ) -> Result<(Self, Selection), String> {
        let bitrate = bitrate.unwrap_or_else(|| default_bitrate(width, height, fps));
        let mut rejected = Vec::new();
        // Shared with the negotiation offer (`prefer_dmabuf` in main) so the two
        // never disagree: offering dmabuf that this then refuses to import is what
        // makes a forced-software recording fail on its first frame.
        let use_dmabuf = crate::encoder::forced_allows_dmabuf(forced);
        let (encoder, importer) = match dmabuf.filter(|_| use_dmabuf) {
            Some(desc) => {
                // The importer maps the full stream (`desc`) and its VPP crops to
                // the committed record size (`width`/`height`): equal to the source
                // for a monitor, or the window's crop rectangle for a window. The
                // encoder is FORCED to VAAPI — the only backend that can consume the
                // mapped surface; a non-VAAPI machine never negotiates dmabuf.
                let importer = crate::dmabuf_import::DmabufImporter::new(
                    desc.width,
                    desc.height,
                    width,
                    height,
                    desc.drm_fourcc,
                )?;
                // SAFETY: the importer's device and NV12 frames context are live
                // for as long as the returned encoder, which the Capture owns
                // alongside it below.
                let encoder = unsafe {
                    VideoEncoder::open_importing(
                        VideoParams { width, height, fps, bitrate },
                        importer.device(),
                        importer.output_frames_ctx(),
                    )?
                };
                (encoder, Some(importer))
            }
            None => {
                let encoder = VideoEncoder::open(
                    VideoParams { width, height, fps, bitrate },
                    forced,
                    |backend, error| rejected.push(format!("{}: {error}", backend.as_str())),
                )?;
                (encoder, None)
            }
        };
        let selection = Selection { backend: encoder.backend(), rejected };

        // Every track must exist before the header: MP4 fixes its track list
        // there, so an audio stream opened later could not be added at all.
        let mut muxer = Muxer::create(path)?;
        let video_track = muxer.add_stream(encoder.codec_context())?;
        // ONE encoder and ONE track for however many captures there are.
        let audio = if audio_sources.is_empty() {
            None
        } else {
            let bitrate = audio_sources.iter().map(|s| s.bitrate).max().unwrap_or(128_000);
            let encoder = AudioEncoder::open(bitrate)?;
            let track = muxer.add_stream(encoder.codec_context())?;
            Some(AudioMix {
                inputs: audio_sources
                    .into_iter()
                    .map(|source| AudioInput {
                        label: source.label,
                        ring: source.ring,
                        gain: source.gain,
                        pending: Vec::new(),
                    })
                    .collect(),
                encoder,
                track,
                scratch: Vec::new(),
            })
        };
        muxer.write_header()?;

        Ok((
            Self {
                encoder,
                importer,
                video_track,
                audio,
                muxer: Some(muxer),
                path: path.to_path_buf(),
                fps,
                epoch: None,
                paused_total: Duration::ZERO,
                paused_at: None,
                next_index: 0,
                frames_written: 0,
                committed_width: width,
                committed_height: height,
            },
            selection,
        ))
    }

    /// Whether this frame's crop still matches what the encoder was opened at.
    ///
    /// A divergence means the recorded window was resized. The recording keeps
    /// its original dimensions — see [`Self::committed_width`] — so the caller
    /// reports it once rather than silently reframing.
    pub fn crop_diverged(&self, frame: &shim::Frame) -> bool {
        // Compared at ENCODED parity, not raw. The committed size was rounded
        // down to even for H.264 chroma, so a window sitting stably at 321x241
        // commits 320x240 and would otherwise be reported as resized on every
        // single frame — a warning about a window that never moved.
        (frame.crop.width & !1) != self.committed_width
            || (frame.crop.height & !1) != self.committed_height
    }

    /// Where to start reading this frame, in source pixels.
    ///
    /// Follows the LIVE crop origin, so moving the recorded window tracks it,
    /// but clamps so a committed-size read always stays inside the buffer. That
    /// clamp is the only thing standing between a shrunken window and an
    /// out-of-bounds read inside swscale.
    fn read_origin(&self, frame: &shim::Frame) -> (i32, i32) {
        let max_x = (frame.width - self.committed_width).max(0);
        let max_y = (frame.height - self.committed_height).max(0);
        (
            frame.crop.x.clamp(0, max_x),
            frame.crop.y.clamp(0, max_y),
        )
    }

    /// Converts a captured frame into the encoder's staging buffer. Nothing is
    /// written until [`Self::advance`] runs. A recoverable per-frame failure (a
    /// dmabuf the GPU cannot map) returns `Ok(Dropped)` rather than `Err`, so it
    /// costs one frame, not the recording; a genuine encoder error still errors.
    pub fn stage(&mut self, frame: &shim::Frame) -> Result<StageOutcome, String> {
        // Zero-copy dmabuf path: import the tiled GPU buffer into an NV12 VAAPI
        // surface (the VPP crops a window to its committed rectangle) and hand it
        // to the encoder as-is — no swscale. See issue #507.
        if frame.dmabuf.is_some() {
            // The crop origin, clamped to stay inside the buffer — same rule as the
            // CPU path. Computed before the mutable importer borrow. For a monitor
            // this is (0, 0).
            let (crop_x, crop_y) = self.read_origin(frame);
            let desc = frame.dmabuf.as_ref().expect("checked is_some above");
            let importer = self
                .importer
                .as_mut()
                .ok_or_else(|| "dmabuf frame arrived but no importer was built".to_owned())?;
            // Borrow the descriptor's planes directly — they are already
            // `shim::DmabufPlane`, the exact type `import` takes — instead of
            // reallocating a plane vector on every frame.
            let nv12 = match importer.import(
                &crate::dmabuf_import::DmabufFrame {
                    width: desc.width,
                    height: desc.height,
                    drm_fourcc: desc.drm_fourcc,
                    modifier: desc.modifier,
                    planes: &desc.planes,
                },
                crop_x,
                crop_y,
            ) {
                Ok(nv12) => nv12,
                // A single un-mappable buffer must not end the recording. Skip it;
                // `advance` holds the previous frame, and the shm path is still in
                // the offer for a full downgrade later (a planned follow-up).
                Err(reason) => return Ok(StageOutcome::Dropped(reason)),
            };
            // SAFETY: `nv12` is a VAAPI NV12 frame from the pool the encoder was
            // opened against; the encoder takes ownership.
            unsafe { self.encoder.stage_hw(nv12) };
            self.mark_started();
            return Ok(StageOutcome::Staged);
        }

        let format = pixel_format(frame.video_format)?;

        // Address the crop by moving the START of the slice, and hand swscale the
        // frame's OWN stride unchanged. The stride is the distance between rows
        // in the source buffer, which cropping does not alter — WebRTC's memfd
        // path subtracts the x offset from it, which is wrong for any non-zero x
        // and is latent there only because no shipping compositor sets one.
        let (x, y) = self.read_origin(frame);
        let offset = (y as usize)
            .checked_mul(frame.stride)
            .and_then(|rows| rows.checked_add((x as usize) * BYTES_PER_SOURCE_PIXEL))
            .ok_or_else(|| "crop offset overflows".to_owned())?;
        let pixels = frame
            .pixels
            .get(offset..)
            .ok_or_else(|| format!("crop offset {offset} is past the end of the frame"))?;

        self.encoder.stage(pixels, frame.stride, format)?;
        self.mark_started();
        Ok(StageOutcome::Staged)
    }

    /// Starts the timeline on the first staged frame and drops the audio backlog.
    ///
    /// Audio has been accumulating since the process started, while the portal
    /// picker was up and the format was being negotiated. None of it belongs to
    /// the recording: video frame 0 is now, so audio sample 0 is now too. Keeping
    /// the backlog would shift the whole track earlier by however long the user
    /// took to click.
    fn mark_started(&mut self) {
        if self.epoch.is_some() {
            return;
        }
        self.epoch = Some(Instant::now());
        if let Some(mix) = &mut self.audio {
            for input in &mut mix.inputs {
                input.ring.clear();
                input.pending.clear();
            }
        }
    }

    /// Whether a picture has been staged, which is also whether the timeline has
    /// started.
    pub fn started(&self) -> bool {
        self.epoch.is_some()
    }

    /// Encodes forward to the current clock position. Returns how many frames
    /// were written.
    pub fn advance(&mut self) -> Result<u32, String> {
        if self.paused_at.is_some() || !self.encoder.has_staged_frame() {
            return Ok(0);
        }
        let target = self.current_index();
        let mut written = 0;
        let Some(muxer) = self.muxer.as_mut() else {
            return Ok(0);
        };
        while self.next_index <= target && written < MAX_CATCHUP_FRAMES {
            let track = self.video_track;
            self.encoder
                .encode_staged(self.next_index, |packet| muxer.write(track, packet))?;
            self.next_index += 1;
            self.frames_written += 1;
            written += 1;
        }

        // Audio is NOT bounded the way video is. A held video frame can be
        // recreated at any time; a missed audio sample cannot, and the ring
        // drops the oldest once it fills. Draining every wakeup keeps it far
        // from that cap — at 48 kHz a 16 ms tick carries about 768 samples.
        if let Some(mix) = self.audio.as_mut() {
            mix.pump(muxer, false)?;
        }
        Ok(written)
    }

    pub fn pause(&mut self) {
        if self.paused_at.is_none() {
            self.paused_at = Some(Instant::now());
            // The rings stop taking samples for the duration. What they already
            // hold is audio from before the pause: it is part of the take and
            // stays, and the first drain after resume places it. See
            // AudioRing::pause for what discarding it used to cost.
            //
            // THE CLOCK IS STOPPED FIRST, AND THAT ORDER IS THE RIGHT WAY ROUND.
            // It leaves a window of a microsecond or so in which a capture
            // thread can still be admitted — but a PipeWire buffer is delivered
            // AFTER the audio in it was captured, so a buffer arriving in that
            // window carries sound from before the pause instant, which the
            // video timeline does cover. Keeping it is correct. Closing the
            // gates first would reject that same buffer instead, and a
            // rejection owes no silence, so it would drop a quantum of audio
            // the video still accounts for — the same error, in the direction
            // that actually loses something.
            if let Some(mix) = &mut self.audio {
                for input in &mut mix.inputs {
                    input.ring.pause();
                }
            }
        }
    }

    pub fn resume(&mut self) {
        if let Some(since) = self.paused_at.take() {
            self.paused_total += since.elapsed();
            // Nothing was captured while paused, so there is nothing here to
            // throw away — the rings only have to start taking samples again.
            // `pending` is left alone for the same reason the rings are: it
            // holds samples drained before the pause, which are take audio.
            if let Some(mix) = &mut self.audio {
                for input in &mut mix.inputs {
                    input.ring.resume();
                }
            }
        }
    }

    /// Samples the rings had to discard because the encoder fell behind, per
    /// track. Audible if non-zero, unlike a dropped video frame.
    pub fn dropped_audio(&self) -> Vec<(&'static str, u64)> {
        self.audio.as_ref().map(AudioMix::dropped).unwrap_or_default()
    }

    pub fn is_paused(&self) -> bool {
        self.paused_at.is_some()
    }

    /// Flushes the encoder, writes the trailer, and closes the file.
    pub fn finish(mut self) -> Result<Summary, String> {
        let mut muxer = self
            .muxer
            .take()
            .ok_or_else(|| "capture was already finished".to_owned())?;

        // Audio first: whatever is still in the rings is real recorded sound,
        // and draining it before the video flush keeps both ending at roughly
        // the same timestamp. `flush` lets the mix take unevenly-filled inputs,
        // since no more samples are coming to even them out.
        if let Some(mix) = self.audio.as_mut() {
            mix.pump(&mut muxer, true)?;
            let id = mix.track;
            mix.encoder.finish(|packet| muxer.write(id, packet))?;
        }

        let video_track = self.video_track;
        self.encoder
            .finish(|packet| muxer.write(video_track, packet))?;
        muxer.finish()?;

        Ok(Summary {
            path: self.path.clone(),
            // From the frames actually written, not from the clock: those are
            // the same number only when the machine kept up, and the file's real
            // duration is the one the app should be told about.
            duration_ms: (self.frames_written as u64 * 1000) / self.fps.max(1) as u64,
            frames: self.frames_written,
            stats: self.encoder.stats(),
        })
    }

    /// Output frame index the wall clock is currently on, excluding paused time.
    fn current_index(&self) -> i64 {
        let Some(epoch) = self.epoch else {
            return -1;
        };
        let mut elapsed = epoch.elapsed();
        elapsed = elapsed.saturating_sub(self.paused_total);
        if let Some(since) = self.paused_at {
            elapsed = elapsed.saturating_sub(since.elapsed());
        }
        (elapsed.as_nanos() as i64 * self.fps as i64) / 1_000_000_000
    }
}

/// SPA video format id → ffmpeg pixel format.
///
/// The ids come from the compiled shim rather than from hardcoded numbers (see
/// [`shim::constants`]), so this cannot silently mis-map the day upstream
/// inserts an enum value. Only the four formats
/// `osc_build_enum_format` advertises can appear here; anything else means the
/// two lists drifted apart, which is worth an error rather than a guess at the
/// channel order.
/// Bytes per pixel in every format [`pixel_format`] accepts.
///
/// All four that `osc_build_enum_format` advertises are 32-bit, so this is a
/// constant rather than a lookup. It lives HERE, next to the table it describes,
/// because the two must change together: adding a 24-bit format below without
/// revisiting this would silently mis-address every cropped row.
pub const BYTES_PER_SOURCE_PIXEL: usize = 4;

fn pixel_format(spa_format: u32) -> Result<ff::AVPixelFormat, String> {
    let constants = shim::constants();
    // `*0` rather than `*A`: the padding byte carries no alpha, and telling
    // swscale it does would make it blend against uninitialised data.
    let table = [
        (constants.video_format_bgrx, ff::AV_PIX_FMT_BGR0),
        (constants.video_format_rgbx, ff::AV_PIX_FMT_RGB0),
        (constants.video_format_bgra, ff::AV_PIX_FMT_BGRA),
        (constants.video_format_rgba, ff::AV_PIX_FMT_RGBA),
    ];
    table
        .iter()
        .find(|(id, _)| *id == spa_format)
        .map(|(_, format)| *format)
        .ok_or_else(|| {
            format!(
                "the compositor negotiated SPA video format {spa_format}, which this helper \
                 does not know how to convert. It should only ever pick one of the four \
                 formats osc_build_enum_format advertises."
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: i32, height: i32, format: u32) -> shim::Frame {
        let stride = width as usize * 4;
        shim::Frame {
            pixels: vec![0x30; stride * height as usize],
            stride,
            width,
            height,
            video_format: format,
            pts_ns: -1,
            crop: shim::CropRect { x: 0, y: 0, width, height },
            has_crop: false,
            dmabuf: None,
        }
    }

    /// A window's frame: a monitor-sized buffer whose content is the rectangle
    /// at (x, y). This is what mutter actually delivers for a window stream.
    fn cropped_frame(
        width: i32,
        height: i32,
        crop: shim::CropRect,
        format: u32,
    ) -> shim::Frame {
        let mut frame = frame(width, height, format);
        frame.crop = crop;
        frame.has_crop = true;
        frame
    }

    #[test]
    fn advertised_formats_all_map_to_a_pixel_format() {
        // The two lists — what osc_build_enum_format offers and what
        // pixel_format accepts — must not drift. A compositor picking a format
        // we advertised but cannot convert kills the recording at the first
        // frame, on that user's machine only.
        let c = shim::constants();
        for id in [
            c.video_format_bgrx,
            c.video_format_rgbx,
            c.video_format_bgra,
            c.video_format_rgba,
        ] {
            assert!(pixel_format(id).is_ok(), "SPA format {id} is offered but not convertible");
        }
    }

    #[test]
    fn an_unadvertised_format_is_reported_not_guessed() {
        let error = pixel_format(u32::MAX).expect_err("must reject");
        assert!(error.contains("does not know how to convert"), "{error}");
    }

    #[test]
    fn the_timeline_does_not_start_until_the_first_frame_is_staged() {
        let output = std::env::temp_dir().join("openscreen-capture-epoch.mp4");
        let (mut capture, _) =
            Capture::start(&output, 320, 240, 30, Some(1_000_000), Some(Backend::Software), Vec::new(), None)
                .expect("start");
        assert!(!capture.started());
        // Nothing staged: advance must not write a frame of uninitialised memory.
        assert_eq!(capture.advance().expect("advance"), 0);

        capture
            .stage(&frame(320, 240, shim::constants().video_format_bgrx))
            .expect("stage");
        assert!(capture.started());
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn a_static_screen_still_produces_frames() {
        // The whole reason the clock drives the output: one staged frame, no
        // further arrivals, and the file must still fill with frames.
        let output = std::env::temp_dir().join("openscreen-capture-static.mp4");
        let (mut capture, _) =
            Capture::start(&output, 320, 240, 30, Some(1_000_000), Some(Backend::Software), Vec::new(), None)
                .expect("start");
        capture
            .stage(&frame(320, 240, shim::constants().video_format_bgrx))
            .expect("stage");

        std::thread::sleep(Duration::from_millis(150));
        let written = capture.advance().expect("advance");
        assert!(written >= 3, "150 ms at 30 fps should hold at least 3 frames, wrote {written}");

        let summary = capture.finish().expect("finish");
        assert_eq!(summary.frames, written as u64);
        let _ = std::fs::remove_file(&output);
    }

    /// The window-capture bug, at the layer where it produced wrong pixels.
    ///
    /// mutter hands a window stream MONITOR-sized buffers and reports the
    /// window's rectangle as SPA_META_VideoCrop. Encoding the buffer without
    /// applying that rectangle is what padded window recordings out to screen
    /// size with black.
    #[test]
    fn a_window_is_staged_from_its_crop_inside_a_larger_frame() {
        let output = std::env::temp_dir().join("openscreen-capture-crop.mp4");
        let (mut capture, _) =
            Capture::start(&output, 320, 240, 30, Some(1_000_000), Some(Backend::Software), Vec::new(), None)
                .expect("start");

        // A 1920x1080 stream carrying a 320x240 window at (100, 50).
        let staged = capture.stage(&cropped_frame(
            1920,
            1080,
            shim::CropRect { x: 100, y: 50, width: 320, height: 240 },
            shim::constants().video_format_bgrx,
        ));

        assert!(staged.is_ok(), "a crop inside the frame must stage: {staged:?}");

        // Frames are clock-driven, so let the timeline advance far enough for the
        // staged picture to actually reach the encoder at the cropped geometry.
        std::thread::sleep(Duration::from_millis(120));
        let written = capture.advance().expect("advance");
        assert!(written >= 1, "the cropped picture should have been encoded, wrote {written}");

        let summary = capture.finish().expect("finish");
        assert_eq!(summary.frames, written as u64);
        let _ = std::fs::remove_file(&output);
    }

    /// A crop flush against the right edge leaves the last row short of a full
    /// stride. The old `stride * height` bounds check rejected exactly those —
    /// i.e. every window not touching the left edge.
    #[test]
    fn a_crop_against_the_right_edge_is_not_rejected_as_truncated() {
        let output = std::env::temp_dir().join("openscreen-capture-edge.mp4");
        let (mut capture, _) =
            Capture::start(&output, 320, 240, 30, Some(1_000_000), Some(Backend::Software), Vec::new(), None)
                .expect("start");

        let staged = capture.stage(&cropped_frame(
            1920,
            1080,
            shim::CropRect { x: 1600, y: 840, width: 320, height: 240 },
            shim::constants().video_format_bgrx,
        ));

        assert!(staged.is_ok(), "a crop at the far corner must stage: {staged:?}");
        let _ = capture.finish();
        let _ = std::fs::remove_file(&output);
    }

    /// The safety property. A window that SHRANK after the encoder was opened
    /// still reports its own smaller rect, and reading a committed-sized picture
    /// from its origin must stay inside the buffer rather than running off the
    /// end into whatever follows it in the mapping.
    #[test]
    fn a_shrunken_window_is_read_from_inside_the_frame() {
        let output = std::env::temp_dir().join("openscreen-capture-shrunk.mp4");
        let (mut capture, _) =
            Capture::start(&output, 320, 240, 30, Some(1_000_000), Some(Backend::Software), Vec::new(), None)
                .expect("start");

        // Origin so close to the edge that a 320x240 read from it would overrun.
        let frame = cropped_frame(
            400,
            300,
            shim::CropRect { x: 380, y: 290, width: 20, height: 10 },
            shim::constants().video_format_bgrx,
        );
        assert!(capture.crop_diverged(&frame), "20x10 must not look like the committed 320x240");

        let staged = capture.stage(&frame);
        assert!(staged.is_ok(), "the read must be clamped back inside the frame: {staged:?}");
        let _ = capture.finish();
        let _ = std::fs::remove_file(&output);
    }

    /// A window whose size is odd is rounded down once, at encoder open. Judging
    /// later frames against the raw rect would then report a resize on every
    /// frame of a window that never moved.
    #[test]
    fn a_stable_odd_sized_window_is_not_reported_as_resized() {
        let output = std::env::temp_dir().join("openscreen-capture-odd.mp4");
        // 321x241 rounds to the 320x240 the encoder is opened at.
        let (mut capture, _) =
            Capture::start(&output, 320, 240, 30, Some(1_000_000), Some(Backend::Software), Vec::new(), None)
                .expect("start");

        let frame = cropped_frame(
            1920,
            1080,
            shim::CropRect { x: 0, y: 0, width: 321, height: 241 },
            shim::constants().video_format_bgrx,
        );

        assert!(!capture.crop_diverged(&frame), "an unchanged odd crop is not a resize");
        let _ = capture.finish();
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn an_uncropped_frame_reports_no_divergence() {
        let output = std::env::temp_dir().join("openscreen-capture-nocrop.mp4");
        let (mut capture, _) =
            Capture::start(&output, 320, 240, 30, Some(1_000_000), Some(Backend::Software), Vec::new(), None)
                .expect("start");

        assert!(!capture.crop_diverged(&frame(320, 240, shim::constants().video_format_bgrx)));
        let _ = capture.finish();
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn paused_time_does_not_advance_the_timeline() {
        let output = std::env::temp_dir().join("openscreen-capture-pause.mp4");
        let (mut capture, _) =
            Capture::start(&output, 320, 240, 30, Some(1_000_000), Some(Backend::Software), Vec::new(), None)
                .expect("start");
        capture
            .stage(&frame(320, 240, shim::constants().video_format_bgrx))
            .expect("stage");

        capture.pause();
        assert!(capture.is_paused());
        std::thread::sleep(Duration::from_millis(150));
        // A paused capture writes nothing, however long it is paused for.
        assert_eq!(capture.advance().expect("advance"), 0);
        capture.resume();
        // And the paused interval is not owed back as a burst of held frames.
        assert_eq!(capture.advance().expect("advance"), 1, "only frame 0 is due");

        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn audio_captured_before_the_first_frame_is_discarded_without_being_called_a_drop() {
        // Regression: the audio stream opens before the portal picker is
        // raised, so it records for as long as the user takes to click — easily
        // past the ring's cap. Those samples are deliberately thrown away when
        // the video epoch is set. Counting them as overflow made every single
        // recording report "the encoder could not keep up", which was measured
        // on a real 29-second capture: 78336 samples, all of them pre-roll.
        let ring = Arc::new(AudioRing::new(1, 8, AUDIO_CHANNELS));
        let capacity = 1 * 8 * AUDIO_CHANNELS;
        ring.push_for_test(&vec![0.5; capacity * 3]);
        assert!(ring.dropped_samples() > 0, "the ring must have overflowed for this test to mean anything");

        let output = std::env::temp_dir().join("openscreen-capture-audio-preroll.mp4");
        let (mut capture, _) = Capture::start(
            &output,
            320,
            240,
            30,
            Some(1_000_000),
            Some(Backend::Software),
            vec![AudioSource { label: "system", ring: ring.clone(), gain: 1.0, bitrate: 128_000 }],
            None,
        )
        .expect("start");

        capture
            .stage(&frame(320, 240, shim::constants().video_format_bgrx))
            .expect("stage");

        assert_eq!(
            ring.dropped_samples(),
            0,
            "pre-roll overflow must not be reported as the encoder falling behind"
        );
        assert!(capture.dropped_audio().is_empty());
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn a_real_drop_before_a_pause_still_reaches_the_warning_after_it() {
        // Regression: resume() threw away what arrived during the pause by
        // clearing the ring, and the clear reset `dropped` — so an overflow that
        // happened for real earlier in the take was forgotten, and the
        // `audio-dropped` warning (main.rs) never fired for it. Pausing is the
        // only thing between the user and the only report that a recording lost
        // audio.
        let ring = Arc::new(AudioRing::new(1, 8, AUDIO_CHANNELS));
        let capacity = 1 * 8 * AUDIO_CHANNELS;

        let output = std::env::temp_dir().join("openscreen-capture-audio-pause-drop.mp4");
        let (mut capture, _) = Capture::start(
            &output,
            320,
            240,
            30,
            Some(1_000_000),
            Some(Backend::Software),
            vec![AudioSource { label: "system", ring: ring.clone(), gain: 1.0, bitrate: 128_000 }],
            None,
        )
        .expect("start");
        capture
            .stage(&frame(320, 240, shim::constants().video_format_bgrx))
            .expect("stage");

        // Mid-take: the encoder falls far enough behind that the ring overflows.
        ring.push_for_test(&vec![0.5; capacity * 3]);
        let dropped = ring.dropped_samples();
        assert!(dropped > 0, "the ring must have overflowed for this test to mean anything");

        capture.pause();
        // A long pause. Nothing that arrives during it belongs to the recording,
        // and none of it is the encoder falling behind either.
        ring.push_for_test(&vec![0.5; capacity * 10]);
        capture.resume();

        assert_eq!(
            capture.dropped_audio(),
            vec![("system", dropped)],
            "the pause must not spend the tally of a drop that happened before it"
        );
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn microphone_gain_clamps_instead_of_wrapping() {
        // A boosted microphone that clips must clip flat. An out-of-range float
        // survives until AAC quantises it, and then wraps to the opposite
        // polarity — which sounds like a burst of noise, not like clipping.
        let ring = Arc::new(AudioRing::new(1, AUDIO_SAMPLE_RATE as usize, AUDIO_CHANNELS));
        ring.push_for_test(&[0.9, -0.9, 0.4, -0.4]);

        let output = std::env::temp_dir().join("openscreen-capture-gain.mp4");
        let (mut capture, _) = Capture::start(
            &output,
            320,
            240,
            30,
            Some(1_000_000),
            Some(Backend::Software),
            vec![AudioSource { label: "microphone", ring, gain: 4.0, bitrate: 128_000 }],
            None,
        )
        .expect("start");
        capture
            .stage(&frame(320, 240, shim::constants().video_format_bgrx))
            .expect("stage");

        // stage() cleared the pre-roll, so feed the samples the run will see.
        let mix = capture.audio.as_ref().expect("a mix exists");
        mix.inputs[0].ring.push_for_test(&[0.9, -0.9, 0.4, -0.4]);
        capture.advance().expect("advance");
        for sample in &capture.audio.as_ref().unwrap().scratch {
            assert!(
                (-1.0..=1.0).contains(sample),
                "gain produced {sample}, which is outside the representable range"
            );
        }
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn two_captures_become_one_muxed_track() {
        // THE regression this guards. Two separate AAC tracks meant the preview
        // — an HTML5 <video>, which plays only the default track and cannot
        // switch — heard whichever came first. With system audio silent, that
        // was silence, while the microphone sat in a track nothing selects.
        let system = Arc::new(AudioRing::new(1, AUDIO_SAMPLE_RATE as usize, AUDIO_CHANNELS));
        let mic = Arc::new(AudioRing::new(1, AUDIO_SAMPLE_RATE as usize, AUDIO_CHANNELS));
        let output = std::env::temp_dir().join("openscreen-capture-one-track.mp4");
        let (mut capture, _) = Capture::start(
            &output,
            320,
            240,
            30,
            Some(1_000_000),
            Some(Backend::Software),
            vec![
                AudioSource { label: "system", ring: system.clone(), gain: 1.0, bitrate: 128_000 },
                AudioSource { label: "microphone", ring: mic.clone(), gain: 1.0, bitrate: 128_000 },
            ],
            None,
        )
        .expect("start");

        let mix = capture.audio.as_ref().expect("a mix exists");
        assert_eq!(mix.inputs.len(), 2, "both captures feed the mix");
        let track = mix.track;

        capture
            .stage(&frame(320, 240, shim::constants().video_format_bgrx))
            .expect("stage");
        // stage() cleared the pre-roll, so feed after it.
        system.push_for_test(&vec![0.25; 4096]);
        mic.push_for_test(&vec![0.5; 4096]);
        capture.advance().expect("advance");

        let mix = capture.audio.as_ref().unwrap();
        assert_eq!(mix.track, track, "there is exactly one audio track, and it never changes");
        // The mixed scratch must carry BOTH contributions summed, not one of them.
        assert!(
            mix.scratch.iter().any(|s| (*s - 0.75).abs() < 1e-4),
            "system 0.25 + mic 0.5 should sum to 0.75; got {:?}",
            &mix.scratch[..mix.scratch.len().min(4)]
        );

        let summary = capture.finish().expect("finish");
        assert!(summary.frames > 0);
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn a_silent_input_cannot_freeze_the_track() {
        // A microphone unplugged mid-recording stops filling its ring. Mixing
        // strictly on min(available) would then wait for it forever and the
        // whole audio track would stop — including the system audio that is
        // still arriving. AUDIO_STARVE_SAMPLES is what breaks that deadlock.
        let system = Arc::new(AudioRing::new(2, AUDIO_SAMPLE_RATE as usize, AUDIO_CHANNELS));
        let dead = Arc::new(AudioRing::new(2, AUDIO_SAMPLE_RATE as usize, AUDIO_CHANNELS));
        let output = std::env::temp_dir().join("openscreen-capture-starve.mp4");
        let (mut capture, _) = Capture::start(
            &output,
            320,
            240,
            30,
            Some(1_000_000),
            Some(Backend::Software),
            vec![
                AudioSource { label: "system", ring: system.clone(), gain: 1.0, bitrate: 128_000 },
                AudioSource { label: "microphone", ring: dead, gain: 1.0, bitrate: 128_000 },
            ],
            None,
        )
        .expect("start");
        capture
            .stage(&frame(320, 240, shim::constants().video_format_bgrx))
            .expect("stage");

        // Well past the quarter-second slack, with the other input silent.
        system.push_for_test(&vec![0.4; AUDIO_STARVE_SAMPLES + 8192]);
        capture.advance().expect("advance");

        let mix = capture.audio.as_ref().unwrap();
        assert!(
            mix.inputs[0].pending.len() < AUDIO_STARVE_SAMPLES,
            "the live input should have been consumed, not held hostage: {} left",
            mix.inputs[0].pending.len()
        );
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn catch_up_is_bounded_so_a_stall_cannot_block_stop() {
        let output = std::env::temp_dir().join("openscreen-capture-catchup.mp4");
        let (mut capture, _) =
            Capture::start(&output, 320, 240, 60, Some(1_000_000), Some(Backend::Software), Vec::new(), None)
                .expect("start");
        capture
            .stage(&frame(320, 240, shim::constants().video_format_bgrx))
            .expect("stage");

        // 500 ms at 60 fps is 30 frames due; one advance must not write them all.
        std::thread::sleep(Duration::from_millis(500));
        let written = capture.advance().expect("advance");
        assert_eq!(written, MAX_CATCHUP_FRAMES);
        let _ = std::fs::remove_file(&output);
    }
}
