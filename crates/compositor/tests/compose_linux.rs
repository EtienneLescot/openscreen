//! Verifie que le port Linux reconciliie sur v1.8.0 REND une frame :
//! `d3d::Gpu` -> `compositor::Compositor` -> `pipeline::Decoder` (les modules
//! Linux, via les alias cfg) -> `compose_frame` (geometrie partagee
//! `plan_frame`) -> `readback_direct`. Bypass le render-thread de `live.rs`
//! pour isoler la chaine de rendu elle-meme.
//!
//! Opt-in (rend sur GPU) : `OPENSCREEN_LINUX_COMPOSE=1` + la fixture
//! `crates/fixture/screen.mp4`. Sinon skip (le teardown Vulkan/Mesa segfault a
//! l'exit apres le rendu -- verifier via la sortie, pas l'exit code).

use std::path::Path;

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config::Cfg;
use openscreen_compositor::cursor::CursorTrack;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::pipeline::{
    run_composited_multi, ClipSource, Decoder, ExportCodec, ExportParams,
};
use openscreen_compositor::scene::Scene;

const FIXTURE: &str = "../fixture/screen.mp4";
const W: u32 = 960;
const H: u32 = 540;

#[test]
fn compose_linux_rend_une_frame() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux: opt-in (OPENSCREEN_LINUX_COMPOSE=1 + fixture). Skip.");
        return;
    }

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut dec = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    // Scene : fond gradient + padding (l'ecran est inset -> le fond floute se
    // voit tout autour) pour valider visuellement le blur du background.
    let scene_json = r##"{"clips":[],"layout":{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false},"effects":{"padding":0.18,"blur":true,"shadow":0,"roundnessFrac":0.05,"motionBlur":0},"background":{"kind":"gradient","angleDeg":45,"stops":["#ff3b6b","#3b6bff"]},"zoomRegions":[],"annotations":[],"cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"},"cropByClip":[],"output":{"width":1920,"height":1080,"fps":30}}"##;
    comp.set_scene(Some(Scene::from_json(scene_json).expect("scene json")));

    let (w, h, rgba) = unsafe {
        let sf = dec.seek_to(1.0).expect("Decoder::seek_to");
        let mut cfg = Cfg::c8();
        cfg.bg_blur = true;
        // webcam = screen (mon compose coeur ne dessine que l'ecran).
        comp.compose_frame(sf, sf, 0.0, &cfg).expect("compose_frame");
        comp.readback_direct().expect("readback_direct")
    };

    let n = (rgba.len() / 4) as f32;
    let mut sum = 0u64;
    for px in rgba.chunks_exact(4) {
        sum += px[0] as u64;
    }
    let mean_r = sum as f32 / n;
    println!("compose_linux : {w}x{h} bytes={} mean_R={:.1}", rgba.len(), mean_r);

    // PPM P6 pour inspection visuelle.
    let out = std::env::var("OPENSCREEN_VK_OUT").unwrap_or_else(|_| "target".into());
    let _ = std::fs::create_dir_all(&out);
    let ppm = format!("{out}/compose_linux.ppm");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&ppm).expect("create ppm");
        write!(f, "P6\n{w} {h}\n255\n").unwrap();
        let mut rgb = vec![0u8; (w * h * 3) as usize];
        for (d, s) in rgb.chunks_exact_mut(3).zip(rgba.chunks_exact(4)) {
            d.copy_from_slice(&s[0..3]);
        }
        f.write_all(&rgb).unwrap();
    }
    println!("wrote {ppm}");

    assert_eq!(rgba.len(), (W * H * 4) as usize);
    assert!(
        mean_r > 5.0 && mean_r < 250.0,
        "mean R={mean_r} hors plage plausible (5..250) — frame vide ?"
    );
}

/// Curseur : sprite thematise (mode 7) dessine au centre. Sprite VERT (data URI
/// PNG) distinct du fond sombre et de l'ecran, pour l'affirmer sans ambiguite.
#[test]
fn compose_linux_dessine_le_curseur() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux curseur: opt-in (OPENSCREEN_LINUX_COMPOSE=1 + fixture). Skip.");
        return;
    }

    // Sprite vert 16x16 opaque en data URI (decode_data_uri -> crate image).
    const SPRITE: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAGElEQVR4nGNk+MdAEmAhTfmohlENQ0kDAGoRATwbkCdPAAAAAElFTkSuQmCC";

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut dec = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    // Scene : curseur visible (size 3 pour un sprite bien lisible), sprite "arrow".
    let scene_json = format!(
        r##"{{"clips":[],"layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0,"blur":false,"shadow":0,"roundnessFrac":0.03,"motionBlur":0}},"background":{{"kind":"color","color":"#101015"}},"zoomRegions":[],"annotations":[],"cursor":{{"show":true,"size":3,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default","cursorSprites":{{"arrow":{{"path":"{SPRITE}","hotspotX":0.5,"hotspotY":0.5}}}}}},"cropByClip":[],"output":{{"width":1920,"height":1080,"fps":30}}}}"##
    );
    comp.set_scene(Some(Scene::from_json(&scene_json).expect("scene json")));

    // Piste curseur : un echantillon au centre (0.5, 0.5). `load` lit un fichier.
    let track_path = std::env::temp_dir().join("os_cursor_track.json");
    std::fs::write(
        &track_path,
        r#"{"samples":[{"timeMs":0,"cx":0.5,"cy":0.5,"cursorType":"arrow"}]}"#,
    )
    .expect("write track");
    let track = CursorTrack::load(track_path.to_str().unwrap(), 0.0, 2.0).expect("CursorTrack::load");
    comp.set_cursor(track);
    comp.set_cursor_time(Some(0.0));

    let (w, h, rgba) = unsafe {
        let sf = dec.seek_to(1.0).expect("Decoder::seek_to");
        let cfg = Cfg::c8();
        comp.compose_frame(sf, sf, 0.0, &cfg).expect("compose_frame");
        comp.readback_direct().expect("readback_direct")
    };

    // Le sprite vert doit apparaitre franchement (G haut, R/B bas).
    let green = rgba
        .chunks_exact(4)
        .filter(|p| p[1] > 180 && p[0] < 120 && p[2] < 120)
        .count();
    println!("compose_linux curseur : {w}x{h} pixels verts={green}");

    let out = std::env::var("OPENSCREEN_VK_OUT").unwrap_or_else(|_| "target".into());
    let _ = std::fs::create_dir_all(&out);
    let ppm = format!("{out}/compose_linux_cursor.ppm");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&ppm).expect("create ppm");
        write!(f, "P6\n{w} {h}\n255\n").unwrap();
        let mut rgb = vec![0u8; (w * h * 3) as usize];
        for (d, s) in rgb.chunks_exact_mut(3).zip(rgba.chunks_exact(4)) {
            d.copy_from_slice(&s[0..3]);
        }
        f.write_all(&rgb).unwrap();
    }
    println!("wrote {ppm}");

    assert!(green > 50, "sprite curseur vert absent (verts={green}) — mode 7 ?");
}

/// Export (WP6) : ~1s de la fixture -> MP4 H264 software. Verifie que la marche
/// de timeline + l'encodeur + le muxer produisent un fichier non trivial. Le
/// contenu est re-validable par ffprobe (cf. la commande dans le run manuel).
#[test]
fn export_linux_mp4() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("export_linux: opt-in (OPENSCREEN_LINUX_COMPOSE=1 + fixture). Skip.");
        return;
    }

    let gpu = Gpu::create(false).expect("Gpu::create");
    // Petite sortie : l'export est un smoke test, pas un bench.
    let comp = Compositor::new_sized(&gpu, 640, 360).expect("Compositor::new_sized");

    let out = std::env::var("OPENSCREEN_EXPORT_OUT")
        .unwrap_or_else(|_| std::env::temp_dir().join("os_export_linux.mp4").to_string_lossy().into());
    let clips = vec![ClipSource {
        screen: FIXTURE.to_string(),
        webcam: FIXTURE.to_string(),
        source_start_sec: 0.0,
        source_end_sec: 1.0,
        webcam_offset_sec: 0.0,
        has_audio: true,
    }];
    let params = ExportParams {
        width: 640,
        height: 360,
        fps: Some(30),
        codec: ExportCodec::H264,
    };

    let mut last = 0u64;
    let stats = run_composited_multi(
        &clips,
        &out,
        &gpu,
        &comp,
        &Cfg::c8(),
        &params,
        &mut |n| last = n,
    )
    .expect("run_composited_multi");
    println!(
        "export_linux : {} frames, {:.1} fps encode, {:.2}s video, progress={last} -> {out}",
        stats.frames, stats.fps, stats.video_duration_s
    );

    assert!(stats.frames > 0, "aucune frame exportee");
    let meta = std::fs::metadata(&out).expect("mp4 metadata");
    assert!(meta.len() > 2000, "mp4 trop petit ({} octets) — muxer ?", meta.len());
}
