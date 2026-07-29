//! La marche de timeline partagée par tous les exports composités.
//!
//! Ce module ne contient QUE du code portable : il ne parle qu'au `Decoder` et au
//! `Compositor` ré-exportés par `lib.rs` (`crate::pipeline`, `crate::compositor`), donc
//! D3D11VA sur Windows et VideoToolbox sur macOS sans une seule ligne de `cfg`.
//!
//! Il vivait dans `pipeline_windows.rs`, ce qui n'était pas tenable une fois le port
//! macOS entré : `gif_export.rs` importe `crate::pipeline::walk_composited_timeline`, et
//! `crate::pipeline` pointe sur `pipeline_macos` sur un Mac — l'export GIF ne compilait
//! donc pas du tout côté macOS. Les deux réponses possibles étaient recopier ~170 lignes
//! dans `pipeline_macos.rs`, ou les sortir ici. La duplication est précisément ce que la
//! doc de `walk_composited_timeline` interdit — « a GIF driven by its own loop is how the
//! slow-motion truncation bug happened » — et l'argument vaut autant entre deux
//! plateformes qu'entre deux formats de sortie.

use crate::compositor::Compositor;
use crate::config::Cfg;
use crate::cursor::CursorTrack;
use crate::d3d::Gpu;
use crate::pipeline::{ClipSource, Decoder};
use crate::regions::{speed_segments_for_window, SpeedSegment};
use crate::scene::Scene;
use anyhow::Result;
use std::collections::HashMap;

/// Avance un décodeur jusqu'au premier pts dans le référentiel écran qui atteint la cible.
/// `timeline_offset_sec` remet les pts webcam dans ce référentiel (`webcam + offset = screen`) :
/// chaque source garde ainsi sa cadence propre au lieu d'être consommée 1:1 avec l'autre.
pub(crate) unsafe fn advance_decoder_to(
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

/// The format-agnostic half of a multiclip export: clip iteration, decoder
/// reuse, availability clamping, per-clip scene windowing, keyframe seeks,
/// cursor binding, speed segments, and — the part that matters — advancing the
/// decoders by OUTPUT time rather than by source frames.
///
/// MP4 and GIF differ only in what they do with a composed frame (hardware NV12
/// encode vs CPU readback + palette quantize), so that is all they supply here.
/// Sharing this walk is what keeps "which source frame belongs at output frame
/// N" defined exactly once: a GIF driven by its own loop is how the slow-motion
/// truncation bug happened.
///
/// `on_frame` runs after `compose_frame` with the running output index;
/// `on_clip_end` runs once per clip with its clamped source window, the frames
/// it produced, and the speed segments used (MP4 needs those for audio).
#[allow(clippy::too_many_arguments)]
pub(crate) unsafe fn walk_composited_timeline(
    clips: &[ClipSource],
    gpu: &Gpu,
    comp: &Compositor,
    cfg: &Cfg,
    out_fps: i32,
    scene: &Option<Scene>,
    screen_decs: &mut HashMap<String, Decoder>,
    webcam_decs: &mut HashMap<String, Decoder>,
    on_frame: &mut dyn FnMut(u64) -> Result<()>,
    on_clip_end: &mut dyn FnMut(usize, f64, u64, &[SpeedSegment]) -> Result<()>,
) -> Result<u64> {
    let cursor_enabled = scene.as_ref().map(|s| s.cursor.show).unwrap_or(false);
    let cursor_smoothing = scene.as_ref().map(|s| s.cursor.smoothing).unwrap_or(0.0);
    let mut cursor_tracks: HashMap<String, CursorTrack> = HashMap::new();
    let mut cursor_active_path: Option<String> = None;

    let mut frames: u64 = 0;

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
                let target_source_time =
                    segment.start_sec + segment_frame as f64 * segment.speed / out_fps as f64;
                if !advance_decoder_to(sdec, target_source_time, 0.0)? {
                    break 'clip_frames;
                }
                if !advance_decoder_to(wdec, target_source_time, clip.webcam_offset_sec)? {
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

                on_frame(frames)?;
                frames += 1;
            }
        }
        on_clip_end(
            clip_index,
            source_end_sec,
            frames - frames_before_clip,
            &speed_segments,
        )?;
    }

    comp.set_cursor_time(None);
    comp.set_timeline_time(None);
    Ok(frames)
}
