//! Golden pixel de la refonte « le RT est le cadre de sortie ».
//!
//! Le filet unitaire de `compositor::tests` verrouille la GÉOMÉTRIE (un carré
//! atterrit carré, un calque centré reste centré). Il ne peut rien dire des
//! PIXELS : or le contrat le plus fort de la refonte est « le 16:9 ne doit pas
//! bouger d'un pixel ». D'où ce golden, qui rend de vraies frames.
//!
//! Il est **piloté par l'environnement** et se saute proprement quand les
//! sources manquent — pas de fixture vidéo dans le dépôt, et la machine de CI
//! n'a pas forcément de GPU D3D11 :
//!
//! ```powershell
//! $env:OPENSCREEN_GOLDEN_SCREEN = "...\recording-<id>.mp4"
//! $env:OPENSCREEN_GOLDEN_WEBCAM = "...\recording-<id>-webcam.webm"
//! cargo test --test output_geometry_golden -- --nocapture
//! ```
//!
//! Mode d'emploi de la refonte : lancer AVANT la phase 1, garder la sortie,
//! relancer APRÈS, comparer.
//!   - le hash du 16:9 doit être **identique** (c'est le contrat 4 : en 16:9 la
//!     compensation est déjà l'identité, donc rien ne doit changer) ;
//!   - le hash des autres formats CHANGE — c'est le but ;
//!   - `grad_y` (énergie de gradient vertical) doit **monter** sur les formats
//!     portrait : c'est la mesure du détail regagné, aujourd'hui perdu parce
//!     que le canvas plafonne à 1080 lignes et que `blit_resized` agrandit.

use poc_d3d::compositor::Compositor;
use poc_d3d::d3d::Gpu;
use poc_d3d::live::Player;
use poc_d3d::scene::Scene;
use poc_d3d::config;

/// Instant fixe dans la source. Un seek explicite (`present_frame`) plutôt que
/// la lecture libre : le golden doit être reproductible à l'octet près.
const AT_SEC: f64 = 2.0;

/// Mêmes formats que le filet unitaire, pour que les deux racontent la même
/// histoire. `native *` rappelle que « native » n'est borné par aucune liste.
const FORMATS: &[(&str, u32, u32)] = &[
    ("16-9", 1920, 1080),
    ("9-16", 1080, 1920),
    ("1-1", 1920, 1920),
    ("4-5", 1536, 1920),
    ("native-ultrawide", 3440, 1440),
    ("4k-16-9", 3840, 2160),
];

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Énergie de gradient moyenne par axe (|Δluma| entre pixels adjacents).
/// Un agrandissement lisse les transitions et fait donc CHUTER cette valeur sur
/// l'axe agrandi — c'est exactement la perte que la phase 1 doit récupérer.
fn gradient_energy(rgba: &[u8], w: usize, h: usize) -> (f64, f64) {
    let lum = |i: usize| {
        0.299 * rgba[i * 4] as f64 + 0.587 * rgba[i * 4 + 1] as f64 + 0.114 * rgba[i * 4 + 2] as f64
    };
    let (mut gx, mut gy) = (0.0, 0.0);
    let (mut nx, mut ny) = (0usize, 0usize);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if x + 1 < w {
                gx += (lum(i + 1) - lum(i)).abs();
                nx += 1;
            }
            if y + 1 < h {
                gy += (lum(i + w) - lum(i)).abs();
                ny += 1;
            }
        }
    }
    (gx / nx.max(1) as f64, gy / ny.max(1) as f64)
}

/// PPM P6 — pas de dépendance à encoder, et ça s'ouvre dans n'importe quel
/// visionneur. Permet l'inspection à l'œil en plus de la comparaison de hash.
fn write_ppm(path: &std::path::Path, rgba: &[u8], w: u32, h: u32) -> std::io::Result<()> {
    let mut out = Vec::with_capacity(rgba.len() / 4 * 3 + 32);
    out.extend_from_slice(format!("P6\n{w} {h}\n255\n").as_bytes());
    for px in rgba.chunks_exact(4) {
        out.extend_from_slice(&px[..3]);
    }
    std::fs::write(path, out)
}

fn scene_json(screen: &str, webcam: &str, w: u32, h: u32) -> String {
    // Chemins en slashes : le JSON n'échappe pas les backslashes Windows.
    let (s, c) = (screen.replace('\\', "/"), webcam.replace('\\', "/"));
    format!(
        r##"{{
        "clips": [{{"screenPath":"{s}","webcamPath":"{c}","sourceStartSec":0,"sourceEndSec":30,"webcamOffsetSec":0,"hasAudio":true}}],
        "layout": {{"preset":"picture-in-picture","webcamSize":1.0,"webcamShape":"rounded","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
        "effects": {{"padding":0.1,"blur":true,"shadow":1.0,"roundnessPx":24,"motionBlur":0.0}},
        "background": {{"kind":"gradient","angleDeg":135,"stops":["#eaebed","#bcc0c6"]}},
        "zoomRegions": [],
        "speedRegions": [],
        "cursor": {{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},
        "cropByClip": [null],
        "output": {{"width":{w},"height":{h},"fps":null}}
    }}"##
    )
}

#[test]
fn golden_frames_per_output_format() {
    let (screen, webcam) = match (
        std::env::var("OPENSCREEN_GOLDEN_SCREEN"),
        std::env::var("OPENSCREEN_GOLDEN_WEBCAM"),
    ) {
        (Ok(s), Ok(w)) => (s, w),
        _ => {
            println!(
                "SKIP: definir OPENSCREEN_GOLDEN_SCREEN et OPENSCREEN_GOLDEN_WEBCAM \
                 (chemins d'un enregistrement reel) pour produire le golden."
            );
            return;
        }
    };

    let out_dir = std::env::var("OPENSCREEN_GOLDEN_OUT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("target/golden"));
    std::fs::create_dir_all(&out_dir).expect("creer le dossier de sortie");

    // C8 = tous les effets (ombres, coins, fond flouté, motion blur) : le golden
    // doit couvrir les calques que les 9 correctifs ont touchés. Zoom et anim de
    // layout coupés — ce sont les plannings FIXTURE, pas le contrat de scène
    // (même neutralisation que `live::render_thread`).
    let mut cfg = config::all().pop().expect("au moins une config");
    cfg.zoom = false;
    cfg.layout_anim = false;

    let gpu = Gpu::create(false).expect("device d3d11");

    println!("\n{:<18} {:>11}  {:>18}  {:>9} {:>9}", "format", "sortie", "hash", "grad_x", "grad_y");
    println!("{}", "-".repeat(72));

    for &(name, w, h) in FORMATS {
        // Un compositeur PAR FORMAT, rastérisant à la géométrie de sortie — c'est
        // exactement ce que fait le chemin d'export. Avant la refonte il n'y avait
        // qu'un seul compositeur 1920x1080 pour tous les formats.
        let comp = Compositor::new_sized(&gpu, w, h).expect("compositor");
        let scene = Scene::from_json(&scene_json(&screen, &webcam, w, h)).expect("scene valide");
        comp.set_scene(Some(scene));
        comp.clear_cursor();

        // Un Player par format : `present_frame` fait avancer les décodeurs, on
        // repart donc d'un état propre pour que AT_SEC désigne bien la même
        // image source d'un format à l'autre.
        let rgba = unsafe {
            let mut player = Player::open(&screen, &webcam, &gpu).expect("ouvrir les sources");
            player.present_frame(&comp, &cfg, AT_SEC).expect("composer la frame");
            comp.readback_resized(w, h).expect("readback")
        };

        assert_eq!(
            rgba.len(),
            (w as usize) * (h as usize) * 4,
            "{name}: le readback ne fait pas w*h*4"
        );

        let (gx, gy) = gradient_energy(&rgba, w as usize, h as usize);
        let hash = fnv1a(&rgba);
        write_ppm(&out_dir.join(format!("{name}.ppm")), &rgba, w, h).expect("ecrire le ppm");

        println!("{name:<18} {:>5}x{:<5} {hash:>18x}  {gx:>9.3} {gy:>9.3}", w, h);
    }

    println!("\nFrames ecrites dans {}", out_dir.display());
    println!(
        "Apres la phase 1 : le hash du 16-9 doit etre INCHANGE ; grad_y doit MONTER \
         sur 9-16, 1-1, 4-5 et 4k-16-9."
    );
}
