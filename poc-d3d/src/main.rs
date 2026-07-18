mod app;
mod compositor;
mod config;
mod cursor;
mod d3d;
mod ffi;
mod pipeline;

use anyhow::Result;
use compositor::Compositor;
use std::fmt::Write as _;

fn arg(args: &[String], k: &str, d: &str) -> String {
    args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| d.to_string())
}

// Deux modes :
//   GUI (défaut)  : poc-d3d.exe [--fixture <dir>] [--out <dir>]  → preview + export
//   Bench (§9/10) : poc-d3d.exe --cfg C0..C8 [--fixture <dir>] [--repeat N] [--out <dir>]
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let is_bench = args.iter().any(|a| a == "--cfg" || a == "--bench");
    if is_bench {
        run_bench(&args)
    } else {
        let fixture = arg(&args, "--fixture", "fixture");
        let out = arg(&args, "--out", "out");
        app::run_gui(
            &format!("{fixture}/screen.mp4"),
            &format!("{fixture}/webcam.mp4"),
            &format!("{fixture}/screen.cursor.json"),
            &out,
        )
    }
}

// spike-native.exe --cfg C0..C8 --fixture <dir> --repeat 3 --out out/
fn run_bench(args: &[String]) -> Result<()> {
    let get = |k: &str, d: &str| -> String { arg(args, k, d) };
    let fixture = get("--fixture", "fixture");
    let out = get("--out", "out");
    let repeat: u32 = get("--repeat", "3").parse().unwrap_or(3);
    let cfg_arg = get("--cfg", "C0..C8");

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
