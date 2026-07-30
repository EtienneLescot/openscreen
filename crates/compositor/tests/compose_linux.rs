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
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::pipeline::Decoder;
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
