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

struct AudioTrack {
    label: &'static str,
    ring: Arc<AudioRing>,
    gain: f32,
    encoder: AudioEncoder,
    track: TrackId,
    /// Reused across drains so the steady state allocates nothing.
    scratch: Vec<f32>,
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
    video_track: TrackId,
    audio: Vec<AudioTrack>,
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
    ) -> Result<(Self, Selection), String> {
        let bitrate = bitrate.unwrap_or_else(|| default_bitrate(width, height, fps));
        let mut rejected = Vec::new();
        let encoder = VideoEncoder::open(
            VideoParams { width, height, fps, bitrate },
            forced,
            |backend, error| rejected.push(format!("{}: {error}", backend.as_str())),
        )?;
        let selection = Selection { backend: encoder.backend(), rejected };

        // Every track must exist before the header: MP4 fixes its track list
        // there, so an audio stream opened later could not be added at all.
        let mut muxer = Muxer::create(path)?;
        let video_track = muxer.add_stream(encoder.codec_context())?;
        let mut audio = Vec::with_capacity(audio_sources.len());
        for source in audio_sources {
            let encoder = AudioEncoder::open(source.bitrate)?;
            let track = muxer.add_stream(encoder.codec_context())?;
            audio.push(AudioTrack {
                label: source.label,
                ring: source.ring,
                gain: source.gain,
                encoder,
                track,
                scratch: Vec::new(),
            });
        }
        muxer.write_header()?;

        Ok((
            Self {
                encoder,
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
            },
            selection,
        ))
    }

    /// Converts a captured frame into the encoder's staging buffer. Nothing is
    /// written until [`Self::advance`] runs.
    pub fn stage(&mut self, frame: &shim::Frame) -> Result<(), String> {
        let format = pixel_format(frame.video_format)?;
        self.encoder.stage(&frame.pixels, frame.stride, format)?;
        if self.epoch.is_none() {
            self.epoch = Some(Instant::now());
            // Audio has been accumulating since the process started, while the
            // portal picker was up and the format was being negotiated. None of
            // it belongs to the recording: video frame 0 is now, so audio
            // sample 0 is now too. Keeping the backlog would shift the whole
            // track earlier by however long the user took to click.
            for track in &self.audio {
                track.ring.clear();
            }
        }
        Ok(())
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
        for track in &mut self.audio {
            track.scratch.clear();
            track.ring.drain_into(&mut track.scratch);
            if track.scratch.is_empty() {
                continue;
            }
            if track.gain != 1.0 {
                for sample in &mut track.scratch {
                    // Clamped: a boosted microphone that clips should clip
                    // flat, not wrap around to the opposite polarity, which is
                    // what an out-of-range float does once AAC quantises it.
                    *sample = (*sample * track.gain).clamp(-1.0, 1.0);
                }
            }
            let id = track.track;
            track
                .encoder
                .push(&track.scratch, |packet| muxer.write(id, packet))?;
        }
        Ok(written)
    }

    pub fn pause(&mut self) {
        if self.paused_at.is_none() {
            self.paused_at = Some(Instant::now());
        }
    }

    pub fn resume(&mut self) {
        if let Some(since) = self.paused_at.take() {
            self.paused_total += since.elapsed();
            // Whatever arrived while paused is thrown away rather than encoded:
            // the video timeline did not advance across the pause, so keeping
            // the audio would push every later sample out of sync by the length
            // of the pause.
            for track in &self.audio {
                track.ring.clear();
            }
        }
    }

    /// Samples the rings had to discard because the encoder fell behind, per
    /// track. Audible if non-zero, unlike a dropped video frame.
    pub fn dropped_audio(&self) -> Vec<(&'static str, u64)> {
        self.audio
            .iter()
            .map(|track| (track.label, track.ring.dropped_samples()))
            .filter(|(_, dropped)| *dropped > 0)
            .collect()
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
        // and draining it after the video flush keeps both tracks ending at
        // roughly the same timestamp.
        for track in &mut self.audio {
            track.scratch.clear();
            track.ring.drain_into(&mut track.scratch);
            if track.gain != 1.0 {
                for sample in &mut track.scratch {
                    *sample = (*sample * track.gain).clamp(-1.0, 1.0);
                }
            }
            let id = track.track;
            track
                .encoder
                .push(&track.scratch, |packet| muxer.write(id, packet))?;
            track.encoder.finish(|packet| muxer.write(id, packet))?;
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
        }
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
            Capture::start(&output, 320, 240, 30, Some(1_000_000), Some(Backend::Software), Vec::new())
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
            Capture::start(&output, 320, 240, 30, Some(1_000_000), Some(Backend::Software), Vec::new())
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

    #[test]
    fn paused_time_does_not_advance_the_timeline() {
        let output = std::env::temp_dir().join("openscreen-capture-pause.mp4");
        let (mut capture, _) =
            Capture::start(&output, 320, 240, 30, Some(1_000_000), Some(Backend::Software), Vec::new())
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
        )
        .expect("start");
        capture
            .stage(&frame(320, 240, shim::constants().video_format_bgrx))
            .expect("stage");

        // stage() cleared the pre-roll, so feed the samples the run will see.
        capture.audio[0].ring.push_for_test(&[0.9, -0.9, 0.4, -0.4]);
        capture.advance().expect("advance");
        for sample in &capture.audio[0].scratch {
            assert!(
                (-1.0..=1.0).contains(sample),
                "gain produced {sample}, which is outside the representable range"
            );
        }
        let _ = std::fs::remove_file(&output);
    }

    #[test]
    fn catch_up_is_bounded_so_a_stall_cannot_block_stop() {
        let output = std::env::temp_dir().join("openscreen-capture-catchup.mp4");
        let (mut capture, _) =
            Capture::start(&output, 320, 240, 60, Some(1_000_000), Some(Backend::Software), Vec::new())
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
