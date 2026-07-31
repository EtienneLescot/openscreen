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
use std::time::{Duration, Instant};

use crate::encoder::{Backend, EncodeStats, Muxer, VideoEncoder, VideoParams};
use crate::ffmpeg as ff;
use crate::shim;

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

pub struct Summary {
    pub path: PathBuf,
    pub duration_ms: u64,
    pub frames: u64,
    pub stats: EncodeStats,
}

pub struct Capture {
    encoder: VideoEncoder,
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
        bitrate: i64,
        forced: Option<Backend>,
    ) -> Result<(Self, Selection), String> {
        let mut rejected = Vec::new();
        let encoder = VideoEncoder::open(
            VideoParams { width, height, fps, bitrate },
            forced,
            |backend, error| rejected.push(format!("{}: {error}", backend.as_str())),
        )?;
        let selection = Selection { backend: encoder.backend(), rejected };
        let muxer = Muxer::create(path, &encoder)?;

        Ok((
            Self {
                encoder,
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
            self.encoder
                .encode_staged(self.next_index, |packet| muxer.write(packet))?;
            self.next_index += 1;
            self.frames_written += 1;
            written += 1;
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
        }
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
        self.encoder.finish(|packet| muxer.write(packet))?;
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
            Capture::start(&output, 320, 240, 30, 1_000_000, Some(Backend::Software))
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
            Capture::start(&output, 320, 240, 30, 1_000_000, Some(Backend::Software))
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
            Capture::start(&output, 320, 240, 30, 1_000_000, Some(Backend::Software))
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
    fn catch_up_is_bounded_so_a_stall_cannot_block_stop() {
        let output = std::env::temp_dir().join("openscreen-capture-catchup.mp4");
        let (mut capture, _) =
            Capture::start(&output, 320, 240, 60, 1_000_000, Some(Backend::Software))
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
