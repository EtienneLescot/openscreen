//! Harnais de mesure du POC (§9/§10) et aiguillage des modes.
//!
//! Vivait dans `lib.rs` de l'ancienne crate `poc-d3d`, quand bibliothèque et POC étaient le même
//! paquet. Rien ici n'est packagé : c'est du banc de mesure au-dessus d'`openscreen-compositor`.

use anyhow::{Context as _, Result};
use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::gif_export::{GifExportParams, GifStats};
use openscreen_compositor::{config, cursor, d3d, gif_export, live, pipeline, scene};
use std::fmt::Write as _;
use std::path::Path;

fn arg(args: &[String], k: &str, d: &str) -> String {
    args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| d.to_string())
}

// Trois modes :
//   GUI (défaut)  : poc-d3d.exe [--fixture <dir>] [--out <dir>]  → preview + export
//   Bench (§9/10) : poc-d3d.exe --cfg C0..C8 [--fixture <dir>] [--repeat N] [--out <dir>]
//   Bench GIF     : poc-d3d.exe --cfg GIF [--fixture <dir>] [--repeat N] [--out <dir>]
//                   (slice 1 du chemin natif GIF : `compositor::export_gif` end-to-end)
//   Live (POC)    : poc-d3d.exe --live [--fixture <dir>]  → vue D3D enfant embarquée (test embed)
pub fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--live") {
        let fixture = arg(&args, "--fixture", "fixture");
        return live::run_standalone(
            &format!("{fixture}/screen.mp4"),
            &format!("{fixture}/webcam.mp4"),
            &format!("{fixture}/screen.cursor.json"),
        );
    }
    let is_bench = args.iter().any(|a| a == "--cfg" || a == "--bench");
    if is_bench {
        run_bench(&args)
    } else {
        let fixture = arg(&args, "--fixture", "fixture");
        let out = arg(&args, "--out", "out");
        crate::app::run_gui(
            &format!("{fixture}/screen.mp4"),
            &format!("{fixture}/webcam.mp4"),
            &format!("{fixture}/screen.cursor.json"),
            &out,
        )
    }
}

// poc-d3d.exe --cfg C0..C8 --fixture <dir> --repeat 3 --out out/
//              --cfg GIF          → bench natif GIF (slice 1)
fn run_bench(args: &[String]) -> Result<()> {
    let get = |k: &str, d: &str| -> String { arg(args, k, d) };
    let fixture = get("--fixture", "fixture");
    let out = get("--out", "out");
    let repeat: u32 = get("--repeat", "3").parse().unwrap_or(3);
    let cfg_arg = get("--cfg", "C0..C8");

    // The GIF bench is a different shape (single clip, no encoder chain,
    // reads out to a `.gif` file). Detected by name so a typical
    // `--cfg C0..C8,GIF` invocation still works.
    if cfg_arg.split(',').any(|n| n.trim().eq_ignore_ascii_case("gif")) {
        return run_gif_bench(args, &fixture, &out, repeat);
    }

    let screen = format!("{fixture}/screen.mp4");
    let webcam = format!("{fixture}/webcam.mp4");
    std::fs::create_dir_all(&out).ok();

    // sélection des cfg
    let all = config::all();
    let cfgs: Vec<config::Cfg> = if cfg_arg.contains("..") {
        all
    } else {
        cfg_arg
            .split(',')
            .filter_map(|n| config::Cfg::by_name(n.trim()))
            .collect()
    };

    let gpu = d3d::Gpu::create(false)?;
    println!("d3d11 device ok (feature_level 0x{:X})", gpu.feature_level.0 as u32);
    let mut comp = Compositor::new(&gpu)?;
    let track = cursor::CursorTrack::load(&format!("{fixture}/screen.cursor.json"), 100_000.0, 6.0)?;
    comp.set_cursor(track);

    // `--scene <fichier.json>` : compose avec une VRAIE scène d'app au lieu du planning fixture.
    // Sert à deux choses : sortir une preuve visuelle pour ce que seule une scène peut décrire
    // (les annotations, qu'aucune UI ne crée encore pour certains types), et mesurer un
    // avant/après perf sur une scène représentative.
    let scene_arg = get("--scene", "");
    if !scene_arg.is_empty() {
        let json = std::fs::read_to_string(&scene_arg)
            .with_context(|| format!("lecture de la scène {scene_arg}"))?;
        comp.set_scene(Some(scene::Scene::from_json(&json)?));
        println!("scène chargée depuis {scene_arg}");
    }

    let mut rows: Vec<(String, u64, f64, f64, f64, String)> = Vec::new(); // name, frames, best_wall, fps, ms/f, spread
    let mut json = String::from("{\n  \"runs\": [\n");

    for cfg in &cfgs {
        let mut fps_runs = Vec::new();
        let mut frames = 0u64;
        for r in 0..repeat {
            let path = format!("{out}/{}.mp4", cfg.name);
            let s = if cfg.composite {
                pipeline::run_composited(&screen, &webcam, &path, &gpu, &comp, cfg, &mut |_| {})?
            } else {
                pipeline::run_c0(&screen, &path, &gpu)?
            };
            frames = s.frames;
            fps_runs.push(s.fps);
            if r == 0 {
                // extraction PNG f60/f180/f300 sur le 1er run (§11)
                extract_pngs(&path, &out, cfg.name);
            }
        }
        let best = fps_runs.iter().cloned().fold(f64::MIN, f64::max);
        let worst = fps_runs.iter().cloned().fold(f64::MAX, f64::min);
        let spread = if worst > 0.0 { 100.0 * (best - worst) / worst } else { 0.0 };
        let wall = frames as f64 / best;
        let msf = 1000.0 / best;
        println!(
            "{:<4} {:>4}f  {:>7.3}s  {:>7.1} fps  {:>6.2} ms/f  spread {:.1}%   {}",
            cfg.name, frames, wall, best, msf, spread, cfg.desc
        );
        rows.push((cfg.name.to_string(), frames, wall, best, msf, format!("{spread:.1}%")));
        let _ = write!(
            json,
            "    {{ \"cfg\": \"{}\", \"frames\": {}, \"fps\": {:.2}, \"ms_per_frame\": {:.3}, \"spread_pct\": {:.1}, \"repeat\": {}, \"desc\": \"{}\" }}{}\n",
            cfg.name, frames, best, msf, spread, repeat, cfg.desc,
            if cfg.name == cfgs.last().unwrap().name { "" } else { "," }
        );
    }
    json.push_str("  ]\n}\n");
    std::fs::write(format!("{out}/report.json"), &json)?;

    // table markdown récap
    println!("\ncfg  frames  wall_s  fps      ms/f    spread");
    for (n, f, w, fps, msf, sp) in &rows {
        println!("{n:<4} {f:<7} {w:<7.3} {fps:<8.1} {msf:<7.2} {sp}");
    }
    println!("\nreport.json + out/C*.mp4 + out/C*_f{{60,180,300}}.png écrits dans {out}/");
    Ok(())
}

/// Native GIF export bench (slice 1). Drives `gif_export::export_gif`
/// end-to-end on the same fixture as the C0..C8 bench and reports:
///   - wall time (render)
///   - frame count
///   - resulting FPS (input vs output)
///   - output file size
///   - ms/frame
///   - spread across `--repeat` runs (same gate as the MP4 bench)
///
/// This is the only honest signal for the "is the native GIF export a
/// win" question. The C0..C8 numbers above show the GPU compositor
/// itself is fast — what this bench prices is the readback + NeuQuant
/// + LZW encode on top, the layers a 5× regression would hide. See
/// `technical-documentation/engineering/rendering-performance.md` →
/// `Native GIF export — initial bench` for the recorded wall-time and
/// the comparison with the renderer-side `gif.js` path.
fn run_gif_bench(
    args: &[String],
    fixture: &str,
    out: &str,
    repeat: u32,
) -> Result<()> {
    let get = |k: &str, d: &str| -> String { arg(args, k, d) };
    let screen = format!("{fixture}/screen.mp4");
    let webcam = format!("{fixture}/webcam.mp4");
    let cursor = format!("{fixture}/screen.cursor.json");
    let out_path = Path::new(out).join("gif.gif");
    std::fs::create_dir_all(out).ok();

    // The bench defaults to 854×480 / 12 fps / no dithering — exactly
    // what `GifExportParams::default()` produces, which is the slice-1
    // target. The user can override via `--gif-width`, `--gif-height`,
    // `--gif-fps` flags if they want to probe the readback cost at
    // different sizes.
    let width: u32 = get("--gif-width", "854").parse().unwrap_or(854);
    let height: u32 = get("--gif-height", "480").parse().unwrap_or(480);
    let fps: u32 = get("--gif-fps", "12").parse().unwrap_or(12);
    let dither: bool = get("--gif-dither", "0") == "1";
    let params = GifExportParams {
        width: Some(width),
        height: Some(height),
        fps: Some(fps),
        loop_count: None,
        dither,
    };

    println!("GIF bench: {screen} + {webcam} → {}", out_path.display());
    println!(
        "           output={}x{} @ {}fps dither={}  runs={repeat}",
        width, height, fps, dither
    );

    let mut frames = 0u64;
    let mut wall_runs = Vec::new();
    let mut file_bytes: u64 = 0;
    let mut last_stats: Option<GifStats> = None;
    for r in 0..repeat {
        // Each run writes to the same path — the last frame wins. The
        // encoder itself is `Drop`-flushed, so re-running is safe and
        // produces a fresh file (the `gif` crate writes the trailer
        // on drop, not on each frame).
        let s = gif_export::export_gif(
            &screen,
            &webcam,
            Some(&cursor),
            &out_path,
            &params,
            &mut |_| {},
        )?;
        // Snapshot the fields we still need before `s` is moved into
        // `last_stats` for the JSON dump at the end of the bench.
        let run_frames = s.frames;
        let run_wall = s.wall_s;
        let run_fps = s.fps;
        let run_bytes = s.file_bytes;
        frames = run_frames;
        file_bytes = run_bytes;
        wall_runs.push(run_wall);
        last_stats = Some(s);
        println!(
            "  run {:>2}: {:>4}f  {:>7.3}s  {:>7.1} fps  {:>6.2} ms/f  {} KiB",
            r + 1,
            run_frames,
            run_wall,
            run_fps,
            1000.0 / run_fps.max(0.001),
            run_bytes / 1024
        );
    }

    // Same spread gate as the MP4 bench: best/worst wall across runs.
    // Smaller-is-better for wall, so we use the inverse of the MP4
    // "best of fps" idiom — best wall is the minimum, worst is the max.
    let best_wall = wall_runs.iter().cloned().fold(f64::INFINITY, f64::min);
    let worst_wall = wall_runs.iter().cloned().fold(0.0_f64, f64::max);
    let spread = if best_wall > 0.0 { 100.0 * (worst_wall - best_wall) / best_wall } else { 0.0 };
    let avg_fps = last_stats
        .as_ref()
        .map(|s| s.fps)
        .unwrap_or_else(|| if best_wall > 0.0 { frames as f64 / best_wall } else { 0.0 });

    // JSON output (parity with the C0..C8 bench's `report.json`).
    let json = format!(
        "{{\n  \"runs\": [\n    {{ \"cfg\": \"GIF\", \"frames\": {frames}, \"fps\": {fps:.2}, \"ms_per_frame\": {msf:.3}, \"wall_s_best\": {wall_best:.3}, \"wall_s_worst\": {wall_worst:.3}, \"spread_pct\": {spread:.1}, \"file_bytes\": {bytes}, \"output\": \"{w}x{h}@{out_fps}fps\", \"repeat\": {repeat}, \"dither\": {dither} }}\n  ]\n}}\n",
        frames = frames,
        fps = avg_fps,
        msf = 1000.0 / avg_fps.max(0.001),
        wall_best = best_wall,
        wall_worst = worst_wall,
        spread = spread,
        bytes = file_bytes,
        w = width,
        h = height,
        out_fps = fps,
        repeat = repeat,
        dither = dither,
    );
    std::fs::write(format!("{out}/report-gif.json"), &json)?;

    println!(
        "\nGIF  {frames}f  {wall:.3}s  {fps:.1} fps  {msf:.2} ms/f  spread {spread:.1}%  {kb} KiB  → {out_path}",
        frames = frames,
        wall = best_wall,
        fps = avg_fps,
        msf = 1000.0 / avg_fps.max(0.001),
        spread = spread,
        kb = file_bytes / 1024,
        out_path = out_path.display(),
    );
    println!("\nreport-gif.json + out/gif.gif écrits dans {out}/");
    Ok(())
}

/// Extrait 3 frames (f60/f180/f300) d'un MP4 via ffmpeg (§11) — vérification à l'œil.
fn extract_pngs(mp4: &str, out: &str, cfg: &str) {
    for f in [60u32, 180, 300] {
        let _ = std::process::Command::new("ffmpeg")
            .args([
                "-v", "error", "-y", "-i", mp4,
                "-vf", &format!("select=eq(n\\,{f})"),
                "-frames:v", "1",
                &format!("{out}/{cfg}_f{f}.png"),
            ])
            .status();
    }
}
