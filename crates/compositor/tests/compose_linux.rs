//! Verifie que le port Linux reconciliie sur v1.8.0 REND une frame :
//! `d3d::Gpu` -> `compositor::Compositor` -> `pipeline::Decoder` (les modules
//! Linux, via les alias cfg) -> `compose_frame` (geometrie partagee
//! `plan_frame`) -> `readback_direct`. Bypass le render-thread de `live.rs`
//! pour isoler la chaine de rendu elle-meme.
//!
//! Opt-in (rend sur GPU) : `OPENSCREEN_LINUX_COMPOSE=1` + la fixture
//! `crates/fixture/screen.mp4`. Sinon skip (le teardown Vulkan/Mesa segfault a
//! l'exit apres le rendu -- verifier via la sortie, pas l'exit code).

// Linux UNIQUEMENT, comme `warp_device_cannot_decode.rs` l'est a Windows. Les
// fichiers de `tests/` sont compiles quelle que soit la plateforme : sans cette
// porte, `cargo check` sous Windows resout `pipeline::Decoder` vers
// `pipeline_windows::Decoder`, qui est `pub(crate)` -- et le check Windows casse
// sur un test qui ne s'y executera jamais.
#![cfg(target_os = "linux")]

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

/// Ecrit un PPM P6 dans `OPENSCREEN_VK_OUT` (defaut `target`) pour inspection.
fn write_ppm(name: &str, w: u32, h: u32, rgba: &[u8]) {
    use std::io::Write;
    let out = std::env::var("OPENSCREEN_VK_OUT").unwrap_or_else(|_| "target".into());
    let _ = std::fs::create_dir_all(&out);
    let path = format!("{out}/{name}.ppm");
    let mut f = std::fs::File::create(&path).expect("create ppm");
    write!(f, "P6\n{w} {h}\n255\n").unwrap();
    let mut rgb = vec![0u8; (w * h * 3) as usize];
    for (d, s) in rgb.chunks_exact_mut(3).zip(rgba.chunks_exact(4)) {
        d.copy_from_slice(&s[0..3]);
    }
    f.write_all(&rgb).unwrap();
    println!("wrote {path}");
}

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

// ---------------------------------------------------------------------------
// Rotation 3D (modes 8 et 12)
// ---------------------------------------------------------------------------

/// Scene « ecran seul sur fond plat magenta », avec ou sans preset de rotation.
/// Le fond est une couleur SATUREE que l'enregistrement d'ecran de la fixture ne
/// produit nulle part : c'est ce qui permet de separer l'ecran du fond au pixel
/// pres, donc de mesurer la forme reellement dessinee.
fn tilt_scene_json(rotation: &str, shadow: u32, roundness: f32) -> String {
    format!(
        r##"{{"clips":[],"layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0.2,"blur":false,"shadow":{shadow},"roundnessFrac":{roundness},"motionBlur":0}},"background":{{"kind":"color","color":"#ff00ff"}},"zoomRegions":[{{"clipIndex":0,"startSec":0,"endSec":6,"scale":1.0,"focusX":0.5,"focusY":0.5,"rotation":{rotation}}}],"annotations":[],"cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},"cropByClip":[],"output":{{"width":1920,"height":1080,"fps":30}}}}"##
    )
}

/// `true` si le pixel n'est PAS le fond magenta. Seuil large : le feather des
/// bords et le degrade du sampler ne doivent pas compter comme du fond.
fn not_bg(px: &[u8]) -> bool {
    !(px[0] > 200 && px[1] < 60 && px[2] > 200)
}

/// Pour chaque colonne, la premiere ligne non-fond. `None` = colonne entierement
/// de fond. C'est la trace du BORD HAUT de ce qui est dessine : horizontale pour
/// un ecran droit, oblique pour un ecran incline.
fn top_edge(rgba: &[u8], w: u32, h: u32) -> Vec<Option<u32>> {
    (0..w)
        .map(|x| {
            (0..h).find(|&y| {
                let i = ((y * w + x) * 4) as usize;
                not_bg(&rgba[i..i + 4])
            })
        })
        .collect()
}

/// Ecart max du bord haut, mesure sur les colonnes centrales uniquement : aux
/// deux extremites le bord haut d'un quad incline bascule sur le bord LATERAL,
/// ce qui ajouterait une variation qui n'est pas celle qu'on veut mesurer.
fn top_edge_swing(edge: &[Option<u32>]) -> u32 {
    let n = edge.len();
    let seen: Vec<u32> = edge[n / 4..3 * n / 4].iter().flatten().copied().collect();
    match (seen.iter().min(), seen.iter().max()) {
        (Some(&lo), Some(&hi)) => hi - lo,
        _ => 0,
    }
}

/// Ecran incline (mode 8). Rend DEUX fois la meme scene, seule la rotation
/// change, et compare la silhouette obtenue.
///
/// L'assertion porte sur la GEOMETRIE, pas sur la presence d'un fichier : le
/// bord haut de l'ecran droit est horizontal a moins de 2 px pres, celui de
/// l'ecran incline balaie des dizaines de lignes. Un mode 8 non branche cote
/// Rust, un warp inverse faux, ou un `quad_st_for_root` qui rejetterait tout
/// casse l'une des trois bornes.
#[test]
fn compose_linux_ecran_tilte() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux tilt: opt-in (OPENSCREEN_LINUX_COMPOSE=1 + fixture). Skip.");
        return;
    }

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut dec = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    let mut cfg = Cfg::c8();
    cfg.shadow = false;
    let (w, h, upright, tilted) = unsafe {
        let sf = dec.seek_to(1.0).expect("Decoder::seek_to");
        // `frame` = 90 -> source_t = 90 / 60 = 1,5 s (`FPS` vaut 60 en dur dans
        // `frame_geometry`, ce n'est pas le `fps` de la scene), dans la region [0, 6] et
        // au-dela de la rampe d'entree : la rotation est a pleine force.
        let render = |json: String| {
            let scene = Scene::from_json(&json).expect("scene json");
            // Le padding transite par les live_params, pas la scene brute.
            comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&scene));
            comp.set_scene(Some(scene));
            comp.compose_frame(sf, sf, 90.0, &cfg).expect("compose_frame");
            comp.readback_direct().expect("readback_direct")
        };
        let (w, h, upright) = render(tilt_scene_json("null", 0, 0.0));
        let tilted: Vec<(&str, Vec<u8>)> = ["iso", "left", "right"]
            .iter()
            .map(|p| (*p, render(tilt_scene_json(&format!("\"{p}\""), 0, 0.0)).2))
            .collect();
        (w, h, upright, tilted)
    };

    write_ppm("compose_linux_tilt_upright", w, h, &upright);

    let up_swing = top_edge_swing(&top_edge(&upright, w, h));
    let up_area = upright.chunks_exact(4).filter(|p| not_bg(p)).count();
    println!("compose_linux tilt : {w}x{h} droit bord_haut={up_swing}px aire={up_area}");

    // Garde-fou du detecteur lui-meme : si le fond magenta ne separait pas
    // proprement l'ecran, le bord de la reference droite ne serait pas plat et
    // toute la mesure serait du bruit.
    assert!(
        up_swing <= 2,
        "reference droite : bord haut non horizontal ({up_swing} px) — le detecteur de fond derape"
    );

    // Les TROIS presets. Ils ne donnent pas le meme quadrilatere : iso penche le
    // plus, left/right sont dominés par leur rotateY, donc leur quad approche le
    // cas quasi affine que `quad_inverse_bilinear` traite par une branche a part.
    for (preset, tilted) in &tilted {
        write_ppm(&format!("compose_linux_tilt_{preset}"), w, h, tilted);
        let swing = top_edge_swing(&top_edge(tilted, w, h));
        let area = tilted.chunks_exact(4).filter(|p| not_bg(p)).count();
        println!("compose_linux tilt {preset} : bord_haut={swing}px aire={area}");

        // Chaque preset combine un rotateX et un rotateZ non nuls : sur une largeur
        // d'ecran de ~600 px le bord haut ne peut pas rester horizontal.
        assert!(
            swing >= 15,
            "{preset} : bord haut plat a {swing} px — mode 8 pas dessine (rect droit ?)"
        );
        // Le containment reduit le plan pour qu'il tienne dans le rect d'origine :
        // l'aire couverte baisse. La borne basse attrape le cas « mode 8 ne rend
        // rien » (quad_inverse_bilinear qui rejette tout, alpha a zero...).
        assert!(
            area > up_area * 4 / 10 && area < up_area * 95 / 100,
            "{preset} : aire {area} hors de (0.40, 0.95) x {up_area} — mode 8 vide ou inopérant"
        );
    }
}

/// Ombre du quad projete (mode 12). L'ombre doit suivre le QUADRILATERE : si
/// elle retombait sur le mode 2 (rect arrondi axis-aligned), sa bordure exterieure
/// serait horizontale en haut. On isole l'ombre en soustrayant le meme rendu sans
/// ombre, puis on mesure la pente de la bordure de la zone assombrie.
#[test]
fn compose_linux_ombre_du_quad_tilte() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux ombre tiltee: opt-in. Skip.");
        return;
    }

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut dec = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    let (w, h, sans, avec) = unsafe {
        let sf = dec.seek_to(1.0).expect("Decoder::seek_to");
        let render = |json: String, shadow: bool| {
            let scene = Scene::from_json(&json).expect("scene json");
            comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&scene));
            comp.set_scene(Some(scene));
            let mut cfg = Cfg::c8();
            cfg.shadow = shadow;
            comp.compose_frame(sf, sf, 90.0, &cfg).expect("compose_frame");
            comp.readback_direct().expect("readback_direct")
        };
        // Rayon non nul : c'est la seule facon d'exercer `inset_corner`/`line_cross`
        // (le rentrant des coins de l'ombre) et l'arrondi en repere PLAN du mode 8.
        let (w, h, sans) = render(tilt_scene_json("\"iso\"", 0, 0.04), false);
        let (_, _, avec) = render(tilt_scene_json("\"iso\"", 1, 0.04), true);
        (w, h, sans, avec)
    };

    write_ppm("compose_linux_tilt_shadow", w, h, &avec);

    // Masque de l'ombre : pixels du FOND assombris par le calque 12. On ignore
    // l'ecran lui-meme (l'ombre passe dessous, il n'y change rien).
    let mut mask = vec![false; (w * h) as usize];
    let mut count = 0usize;
    for p in 0..(w * h) as usize {
        let i = p * 4;
        let dark = sans[i] as i32 - avec[i] as i32 > 12 && !not_bg(&sans[i..i + 4]);
        mask[p] = dark;
        count += dark as usize;
    }
    // Bordure HAUTE de la penombre, colonne par colonne.
    let edge: Vec<Option<u32>> = (0..w)
        .map(|x| (0..h).find(|&y| mask[(y * w + x) as usize]))
        .collect();
    let swing = top_edge_swing(&edge);
    println!("compose_linux ombre tiltee : {count} px assombris, bordure haute swing={swing}px");

    assert!(count > 3000, "ombre absente ({count} px assombris) — mode 12 pas dessine ?");
    // Un repli sur le mode 2 donnerait une bordure haute rigoureusement plate.
    assert!(
        swing >= 15,
        "bordure haute de l'ombre plate a {swing} px — l'ombre est un rect droit, pas le quad projete"
    );
}

/// Curseur pose sur l'ecran incline (mode 13). Le curseur est place HORS du
/// centre : c'est la que le plan incline le deplace vraiment. Au centre, la
/// position tiltee et la position droite coincident et le test ne prouverait rien.
///
/// L'assertion est que le sprite BOUGE quand on incline. Un repli sur le
/// placement droit (mode 7) laisserait les deux barycentres au meme endroit ; un
/// mode 13 absent ferait disparaitre le curseur (compte a zero).
#[test]
fn compose_linux_curseur_sur_ecran_tilte() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux curseur tilte: opt-in. Skip.");
        return;
    }
    // Sprite vert 16x16 opaque (le meme que le test du mode 7).
    const SPRITE: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAGElEQVR4nGNk+MdAEmAhTfmohlENQ0kDAGoRATwbkCdPAAAAAElFTkSuQmCC";

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut dec = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    let track_path = std::env::temp_dir().join("os_cursor_track_tilt.json");
    std::fs::write(
        &track_path,
        r#"{"samples":[{"timeMs":3000,"cx":0.22,"cy":0.24,"cursorType":"arrow"}]}"#,
    )
    .expect("write track");
    let track = CursorTrack::load(track_path.to_str().unwrap(), 0.0, 6.0).expect("CursorTrack::load");
    comp.set_cursor(track);
    comp.set_cursor_time(Some(3.0));

    let scene_json = |rotation: &str| {
        format!(
            r##"{{"clips":[],"layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0.2,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0}},"background":{{"kind":"color","color":"#ff00ff"}},"zoomRegions":[{{"clipIndex":0,"startSec":0,"endSec":6,"scale":1.0,"focusX":0.5,"focusY":0.5,"rotation":{rotation}}}],"annotations":[],"cursor":{{"show":true,"size":4,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default","cursorSprites":{{"arrow":{{"path":"{SPRITE}","hotspotX":0.5,"hotspotY":0.5}}}}}},"cropByClip":[],"output":{{"width":1920,"height":1080,"fps":30}}}}"##
        )
    };

    let (w, h, upright, tilted) = unsafe {
        let sf = dec.seek_to(1.0).expect("Decoder::seek_to");
        let render = |json: String| {
            let scene = Scene::from_json(&json).expect("scene json");
            comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&scene));
            comp.set_scene(Some(scene));
            comp.compose_frame(sf, sf, 90.0, &Cfg::c8()).expect("compose_frame");
            comp.readback_direct().expect("readback_direct")
        };
        let (w, h, upright) = render(scene_json("null"));
        let (_, _, tilted) = render(scene_json("\"iso\""));
        (w, h, upright, tilted)
    };

    write_ppm("compose_linux_tilt_cursor", w, h, &tilted);

    // Barycentre des pixels verts du sprite.
    let centroid = |rgba: &[u8]| -> (f32, f32, usize) {
        let (mut sx, mut sy, mut n) = (0.0f32, 0.0f32, 0usize);
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                if rgba[i + 1] > 180 && rgba[i] < 120 && rgba[i + 2] < 120 {
                    sx += x as f32;
                    sy += y as f32;
                    n += 1;
                }
            }
        }
        (sx / n.max(1) as f32, sy / n.max(1) as f32, n)
    };
    let (ux, uy, un) = centroid(&upright);
    let (tx, ty, tn) = centroid(&tilted);
    let shift = ((tx - ux).powi(2) + (ty - uy).powi(2)).sqrt();
    println!(
        "compose_linux curseur tilte : droit=({ux:.1},{uy:.1}) n={un} \
         incline=({tx:.1},{ty:.1}) n={tn} deplacement={shift:.1}px"
    );

    assert!(un > 50, "curseur droit absent (n={un}) — la scene de reference est cassee");
    assert!(tn > 50, "curseur absent sous rotation (n={tn}) — mode 13 pas dessine");
    assert!(
        shift >= 12.0,
        "curseur deplace de {shift:.1}px seulement — il est reste sur le rect droit (mode 7 ?)"
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

/// Fond image (mode 6 wallpaper) : un PNG orange en data URI remplit le fond
/// (cover-fit) autour de l'ecran inset (padding). Distinct de l'ecran et du
/// gris par defaut, pour l'affirmer sans ambiguite.
#[test]
fn compose_linux_fond_image() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux fond image: opt-in. Skip.");
        return;
    }
    const BG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAKklEQVR4nO3NwQ0AAAQAMRJ721wswa83wDWn47X63QMAAAAAAAAAAIC7FhLfAfuIQEbyAAAAAElFTkSuQmCC";

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut dec = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    let scene_json = format!(
        r##"{{"clips":[],"layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0.4,"blur":false,"shadow":0,"roundnessFrac":0.05,"motionBlur":0}},"background":{{"kind":"image","path":"{BG}"}},"zoomRegions":[],"annotations":[],"cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},"cropByClip":[],"output":{{"width":1920,"height":1080,"fps":30}}}}"##
    );
    let scene = Scene::from_json(&scene_json).expect("scene json");
    // Le padding (et les autres effets) transitent par les live_params, pas la
    // scene brute -> sans ca l'ecran remplit tout le cadre et masque le fond.
    comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&scene));
    comp.set_scene(Some(scene));

    let (w, h, rgba) = unsafe {
        let sf = dec.seek_to(1.0).expect("Decoder::seek_to");
        let cfg = Cfg::c8();
        comp.compose_frame(sf, sf, 0.0, &cfg).expect("compose_frame");
        comp.readback_direct().expect("readback_direct")
    };
    // Orange (255,128,0) : R haut, G moyen, B bas.
    let orange = rgba
        .chunks_exact(4)
        .filter(|p| p[0] > 200 && p[1] > 90 && p[1] < 170 && p[2] < 70)
        .count();
    println!("compose_linux fond image : {w}x{h} pixels orange={orange}");

    let out = std::env::var("OPENSCREEN_VK_OUT").unwrap_or_else(|_| "target".into());
    let _ = std::fs::create_dir_all(&out);
    {
        use std::io::Write;
        let mut f = std::fs::File::create(format!("{out}/compose_linux_bgimage.ppm")).expect("ppm");
        write!(f, "P6\n{w} {h}\n255\n").unwrap();
        let mut rgb = vec![0u8; (w * h * 3) as usize];
        for (d, s) in rgb.chunks_exact_mut(3).zip(rgba.chunks_exact(4)) {
            d.copy_from_slice(&s[0..3]);
        }
        f.write_all(&rgb).unwrap();
    }
    assert!(orange > 2000, "fond image absent (orange={orange}) — mode 6 ?");
}

/// Flou de mouvement par VELOCITE du calque ecran (mode 0 du shader).
///
/// La velocite vient d'un zoom en pleine rampe : `plan_frame` calcule alors un
/// `s_dst_prev` different de `s_dst`, et le shader floute chaque pixel le long
/// du segment qui relie son UV d'avant a son UV d'aujourd'hui.
///
/// La MEME frame decodee est composee deux fois, seul `effects.motionBlur`
/// change — toute difference mesuree ne peut donc venir que de l'effet. Deux
/// assertions, parce que « les deux images different » ne dirait pas dans quel
/// SENS : on verifie aussi que la version floutee a moins de detail haute
/// frequence. Un cablage errone de `src_prev`/`dst_prev` ferait bien differer
/// les images, mais pas forcement dans ce sens-la.
#[test]
fn compose_linux_flou_de_velocite_ecran() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux flou de velocite: opt-in. Skip.");
        return;
    }

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut dec = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    // La region de zoom demarre a 2 s ; sa rampe d'entree commence ~1 s plus tot
    // (`ZOOM_IN_TRANSITION_WINDOW_S`). A t = 66/60 = 1,1 s on est donc en pleine
    // montee : `plan_frame` y donne s_dst 1,629 contre s_dst_prev 1,559, soit
    // 4,5 % d'echelle en une frame — largement de quoi etaler le calque.
    let scene_of = |mblur: f32| {
        format!(
            r##"{{"clips":[],"layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":{mblur}}},"background":{{"kind":"color","color":"#101015"}},"zoomRegions":[{{"id":"z1","startSec":2,"endSec":4,"scale":2.5,"focusX":0.5,"focusY":0.5,"focusMode":"manual","rotation":null}}],"annotations":[],"cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},"cropByClip":[],"output":{{"width":1920,"height":1080,"fps":30}}}}"##
        )
    };

    // UN SEUL `seek_to` : les deux rendus partagent la meme AVFrame, donc le
    // decodeur ne peut pas introduire de difference qu'on prendrait pour l'effet.
    let (sharp, blurred) = unsafe {
        let sf = dec.seek_to(1.1).expect("Decoder::seek_to");
        let cfg = Cfg::c8();
        let render = |mblur: f32| {
            comp.set_scene(Some(Scene::from_json(&scene_of(mblur)).expect("scene json")));
            comp.compose_frame(sf, sf, 66.0, &cfg).expect("compose_frame");
            comp.readback_direct().expect("readback_direct").2
        };
        (render(0.0), render(1.0))
    };

    write_ppm("compose_linux_mb_screen_off", W, H, &sharp);
    write_ppm("compose_linux_mb_screen_on", W, H, &blurred);

    let mut diff_sum = 0u64;
    for (a, b) in sharp.chunks_exact(4).zip(blurred.chunks_exact(4)) {
        for c in 0..3 {
            diff_sum += (a[c] as i32 - b[c] as i32).unsigned_abs() as u64;
        }
    }
    let mean_diff = diff_sum as f32 / (W * H * 3) as f32;

    // Detail haute frequence : somme des gradients voisins sur le canal vert.
    let sharpness = |img: &[u8]| -> f32 {
        let g = |x: u32, y: u32| img[((y * W + x) * 4 + 1) as usize] as i32;
        let mut acc = 0u64;
        for y in 0..H - 1 {
            for x in 0..W - 1 {
                acc += (g(x + 1, y) - g(x, y)).unsigned_abs() as u64;
                acc += (g(x, y + 1) - g(x, y)).unsigned_abs() as u64;
            }
        }
        acc as f32 / ((W - 1) * (H - 1) * 2) as f32
    };
    let (s_sharp, s_blur) = (sharpness(&sharp), sharpness(&blurred));
    println!(
        "compose_linux flou de velocite : mean_diff={mean_diff:.2} gradient net={s_sharp:.2} floute={s_blur:.2}"
    );

    // Mesure observee : mean_diff 12,5 et gradient 7,9 -> 3,0. Les seuils gardent
    // de la marge tout en restant loin du « ca a bouge d'un poil ».
    assert!(
        mean_diff > 4.0,
        "motionBlur 0 vs 1 rend (quasi) la MEME image (mean_diff={mean_diff:.3}) — mb/src_prev/dst_prev non cables ?"
    );
    assert!(
        s_blur < s_sharp * 0.7,
        "le rendu floute n'est pas plus doux (gradient {s_blur:.2} vs {s_sharp:.2}) — le flou ne suit pas la velocite"
    );
}

/// Meme flou de velocite, mais sur le calque CAMERA — un draw distinct, avec son
/// propre `src_prev` (qui doit suivre le cover-crop et le miroir) et son propre
/// `dst_prev`.
///
/// La velocite vient d'une region « Full Camera » en pleine ouverture : la boite
/// camera passe de 0,526 a 0,579 de large en une frame pendant que `s_dst` ne
/// bouge PAS d'un pouce. C'est ce qui rend le test concluant — une difference
/// mesuree dans la boite camera ne peut pas venir du calque ecran, et
/// l'assertion sur le coin haut-gauche (hors boite) le verifie explicitement.
#[test]
fn compose_linux_flou_de_velocite_camera() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux flou de velocite camera: opt-in. Skip.");
        return;
    }
    let webcam_fixture = "../fixture/webcam.mp4";
    if !Path::new(webcam_fixture).is_file() {
        eprintln!("compose_linux flou de velocite camera: pas de fixture webcam. Skip.");
        return;
    }

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut screen = Decoder::open(FIXTURE, &gpu).expect("Decoder::open screen");
    let mut cam = Decoder::open(webcam_fixture, &gpu).expect("Decoder::open webcam");

    // `webcamMirror: true` : le miroir inverse les bornes u de `src`, et
    // `src_prev` doit inverser les MEMES. S'il gardait l'ancien [0,0,1,1] la
    // reprojection viserait une zone de texture jamais affichee.
    let scene_of = |mblur: f32| {
        format!(
            r##"{{"clips":[],"layout":{{"preset":"picture-in-picture","webcamSize":1,"webcamShape":"rectangle","webcamMirror":true,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":{mblur}}},"background":{{"kind":"color","color":"#101015"}},"zoomRegions":[],"cameraFullscreenRegions":[{{"startSec":2,"endSec":4}}],"annotations":[],"cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},"cropByClip":[],"output":{{"width":1920,"height":1080,"fps":30}}}}"##
        )
    };

    let (sharp, blurred) = unsafe {
        let sf = screen.seek_to(2.1).expect("seek screen");
        let wf = cam.seek_to(2.1).expect("seek webcam");
        let cfg = Cfg::c8();
        let render = |mblur: f32| {
            let scene = Scene::from_json(&scene_of(mblur)).expect("scene json");
            comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&scene));
            comp.set_scene(Some(scene));
            // frame 126 = t 2,1 s : la camera est a mi-ouverture.
            comp.compose_frame(sf, wf, 126.0, &cfg).expect("compose_frame");
            comp.readback_direct().expect("readback_direct").2
        };
        (render(0.0), render(1.0))
    };

    write_ppm("compose_linux_mb_camera_off", W, H, &sharp);
    write_ppm("compose_linux_mb_camera_on", W, H, &blurred);

    let mean_diff = |x0: u32, x1: u32, y0: u32, y1: u32| -> f32 {
        let mut sum = 0u64;
        for y in y0..y1 {
            for x in x0..x1 {
                let i = ((y * W + x) * 4) as usize;
                for c in 0..3 {
                    sum += (sharp[i + c] as i32 - blurred[i + c] as i32).unsigned_abs() as u64;
                }
            }
        }
        sum as f32 / ((x1 - x0) * (y1 - y0) * 3) as f32
    };
    // Boite camera a t = 2,1 s : [0,411 ; 0,403 ; 0,579 ; 0,579] de la sortie,
    // soit x 394..950 et y 217..530 en pixels — retrecie ici pour rester loin des
    // bords adoucis. Le coin haut-gauche, lui, ne montre que l'ecran.
    let inside = mean_diff(420, 920, 245, 505);
    let outside = mean_diff(0, 300, 0, 150);
    println!("compose_linux flou de velocite camera : dans la boite={inside:.2} hors boite={outside:.4}");

    assert!(
        inside > 4.0,
        "la camera n'est pas floutee (diff={inside:.3}) — src_prev/dst_prev du calque webcam non cables ?"
    );
    assert!(
        outside < 0.01,
        "l'ecran a bouge aussi (diff={outside:.3}) — le test ne prouve alors rien sur la camera"
    );
}

/// Trainee fantome du curseur (accumulation temporelle, pas un mode de shader).
///
/// Le curseur traverse le cadre ; a `cursor.motionBlur = 1` `plan_cursor` rend
/// 11 taps entre sa position d'il y a 8 frames (8/60 s) et sa position courante.
/// On compare au meme rendu sans trainee : la seule difference possible etant le
/// curseur, un exces de vert la ou le curseur N'EST PAS (mais est PASSE) est la
/// signature de la trainee.
///
/// « Exces de vert » = G - max(R,B), pas G brut : une copie a 1/taps d'opacite
/// sur un fond CLAIR fait a peine monter le vert (le fond y est deja) mais fait
/// nettement chuter le rouge et le bleu. Mesurer G seul rendrait le test
/// dependant de ce qui passe sous le curseur dans la video.
///
/// Le trajet est volontairement hors de l'axe median (cy = 0,28) : une passe de
/// composition qui retournerait `accum` verticalement enverrait la trainee dans
/// la bande miroir, ce que la seconde assertion interdit. A cy = 0,5 le defaut
/// serait invisible.
#[test]
fn compose_linux_trainee_de_curseur() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux trainee curseur: opt-in. Skip.");
        return;
    }
    const SPRITE: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAGElEQVR4nGNk+MdAEmAhTfmohlENQ0kDAGoRATwbkCdPAAAAAElFTkSuQmCC";

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut dec = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    // Piste : deplacement horizontal regulier cx 0,1 -> 0,9 en 0,4 s, a cy fixe.
    // Assez rapide pour que les 8/60 s de recul de la trainee separent nettement
    // les deux extremites (~256 px a 960 de large) : sans quoi la trainee se
    // superpose au curseur lui-meme et on ne pourrait plus les distinguer.
    let mut samples = String::new();
    for k in 0..=8 {
        let (ms, cx) = (k * 50, 0.1 + 0.1 * k as f32);
        if k > 0 {
            samples.push(',');
        }
        samples.push_str(&format!(
            r#"{{"timeMs":{ms},"cx":{cx},"cy":0.28,"cursorType":"arrow"}}"#
        ));
    }
    let track_path = std::env::temp_dir().join("os_cursor_trail_track.json");
    std::fs::write(&track_path, format!(r#"{{"samples":[{samples}]}}"#)).expect("write track");
    let track = CursorTrack::load(track_path.to_str().unwrap(), 0.0, 2.0).expect("CursorTrack::load");
    comp.set_cursor(track);
    comp.set_cursor_time(Some(0.35));

    let scene_of = |mblur: f32| {
        format!(
            r##"{{"clips":[],"layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0}},"background":{{"kind":"color","color":"#101015"}},"zoomRegions":[],"annotations":[],"cursor":{{"show":true,"size":3,"smoothing":0,"motionBlur":{mblur},"clickBounce":0,"clipToBounds":false,"theme":"default","cursorSprites":{{"arrow":{{"path":"{SPRITE}","hotspotX":0.5,"hotspotY":0.5}}}}}},"cropByClip":[],"output":{{"width":1920,"height":1080,"fps":30}}}}"##
        )
    };

    let (sharp, trail) = unsafe {
        let sf = dec.seek_to(1.0).expect("Decoder::seek_to");
        let cfg = Cfg::c8();
        let render = |mblur: f32| {
            let scene = Scene::from_json(&scene_of(mblur)).expect("scene json");
            // `cursor.motionBlur` ET `cursor.size` transitent par les LiveParams,
            // pas par la scene brute : sans ca `plan_cursor` verrait toujours 0.
            comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&scene));
            comp.set_scene(Some(scene));
            comp.compose_frame(sf, sf, 15.0, &cfg).expect("compose_frame");
            comp.readback_direct().expect("readback_direct").2
        };
        (render(0.0), render(1.0))
    };

    write_ppm("compose_linux_cursor_trail_off", W, H, &sharp);
    write_ppm("compose_linux_cursor_trail_on", W, H, &trail);

    // A t = 0,35 s le curseur est en cx 0,8 (x ~ 768 px) et 8/60 s plus tot en
    // cx ~ 0,533 (x ~ 512 px) ; le sprite fait 51 px de cote a size 3 (34/1080
    // de frame_min_px, x3), donc le curseur COURANT occupe x = 742..794. La
    // fenetre ci-dessous couvre le milieu du trajet, franchement a sa gauche :
    // sans trainee il n'y a rien du tout. La bande miroir est son reflet par
    // rapport a l'axe horizontal de l'image (cy = 0,28 est hors de cet axe
    // exprès), donc un `accum` composite a l'envers y atterrirait.
    let greener = |x0: u32, x1: u32, y0: u32, y1: u32| -> usize {
        let excess = |img: &[u8], i: usize| {
            img[i + 1] as i32 - (img[i] as i32).max(img[i + 2] as i32)
        };
        let mut n = 0;
        for y in y0..y1 {
            for x in x0..x1 {
                let i = ((y * W + x) * 4) as usize;
                if excess(&trail, i) - excess(&sharp, i) > 10 {
                    n += 1;
                }
            }
        }
        n
    };
    let on_path = greener(530, 700, 130, 172);
    let mirrored = greener(530, 700, 368, 410);
    println!("compose_linux trainee curseur : sur le trajet={on_path} bande miroir={mirrored}");

    // La fenetre fait 170x42 = 7140 px et la trainee la remplit entierement.
    // Le seuil a 4000 laisse de la marge tout en refusant une trainee qui ne
    // couvrirait qu'un bout du trajet.
    assert!(
        on_path > 4000,
        "pas de trainee au milieu du trajet ({on_path} px plus verts) — le curseur n'est dessine qu'a sa position courante"
    );
    assert!(
        mirrored < 50,
        "trainee dans la bande MIROIR ({mirrored} px) — la passe de composition d'accum retourne l'image en Y"
    );
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

/// Rend une frame qui exerce EN MEME TEMPS les trois corrections de cette
/// serie : ombre portee (ecran + camera), cover-crop de la webcam sous un
/// masque CERCLE (le cas ou l'etirement etait le plus violent : la boite est
/// forcee carree, donc une camera 16:9 s'ecrasait de 1,78x), et une annotation
/// texte avec un fond.
///
/// Opt-in comme les autres tests de ce fichier ; ecrit un PPM a inspecter.
#[test]
fn compose_linux_ombre_webcam_ronde_et_texte() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux ombre/webcam/texte: opt-in. Skip.");
        return;
    }
    let webcam_fixture = "../fixture/webcam.mp4";
    if !Path::new(webcam_fixture).is_file() {
        eprintln!("compose_linux ombre/webcam/texte: pas de fixture webcam. Skip.");
        return;
    }

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut screen = Decoder::open(FIXTURE, &gpu).expect("Decoder::open screen");
    let mut cam = Decoder::open(webcam_fixture, &gpu).expect("Decoder::open webcam");

    // `shadow: 1` + camera en cercle + une annotation texte visible a t=1s.
    let scene_json = r##"{"clips":[],"layout":{"preset":"picture-in-picture","webcamSize":1,"webcamShape":"circle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false},"effects":{"padding":0.14,"blur":false,"shadow":1,"roundnessFrac":0.04,"motionBlur":0},"background":{"kind":"gradient","angleDeg":45,"stops":["#1f2933","#3b6bff"]},"zoomRegions":[],"annotations":[{"id":"a1","kind":"text","x":0.08,"y":0.08,"w":0.5,"h":0.14,"startSec":0,"endSec":10,"zIndex":1,"text":{"content":"Ombre + fond","color":"#ffffff","backgroundColor":"#e0245e","fontSizeRel":0.09,"fontFamily":"","fontWeight":"normal","fontStyle":"normal","textDecoration":"none","textAlign":"center"}}],"cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"},"cropByClip":[],"output":{"width":1920,"height":1080,"fps":30}}"##;
    let parsed = Scene::from_json(scene_json).expect("scene json");
    // Cf. le commentaire dans compose_linux_forme_webcam_cercle : sans les
    // LiveParams, la scene est parsee et ignoree.
    comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&parsed));
    comp.set_scene(Some(parsed));

    let (w, h, rgba) = unsafe {
        let sf = screen.seek_to(1.0).expect("seek screen");
        let wf = cam.seek_to(1.0).expect("seek webcam");
        let mut cfg = Cfg::c8();
        cfg.shadow = true;
        comp.compose_frame(sf, wf, 1.0, &cfg).expect("compose_frame");
        comp.readback_direct().expect("readback_direct")
    };

    let out = std::env::var("OPENSCREEN_VK_OUT").unwrap_or_else(|_| "target".into());
    let _ = std::fs::create_dir_all(&out);
    let ppm = format!("{out}/compose_linux_shadow_webcam_text.ppm");
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

    // L'annotation a un fond ROSE (#e0245e) : il doit exister des pixels
    // nettement rouges-magenta dans le quart haut-gauche, ce qui n'etait pas le
    // cas quand la plaque n'etait pas dessinee du tout.
    let mut plate_px = 0usize;
    for y in 0..(h / 3) {
        for x in 0..(w / 2) {
            let i = ((y * w + x) * 4) as usize;
            let (r, g_, b) = (rgba[i] as i32, rgba[i + 1] as i32, rgba[i + 2] as i32);
            if r > 140 && g_ < 90 && b > 40 && b < 140 {
                plate_px += 1;
            }
        }
    }
    assert!(
        plate_px > 200,
        "fond d'annotation introuvable ({plate_px} px roses) — la plaque n'est pas dessinee"
    );
}

/// Forme de la webcam : `rectangle` contre `circle`.
///
/// Le masque n'est pas un mode de shader dedie — il sort de `radius_px`, que
/// `plan_frame` met a la moitie du cote pour `circle`. Ce test le MESURE au
/// lieu de le supposer.
///
/// La methode : rendre trois fois la meme scene — sans camera, camera
/// rectangle, camera cercle — et diffe chacune des deux dernieres contre la
/// premiere. Le diff EST l'empreinte de la camera, masque compris, sans avoir
/// a deviner ou `plan_frame` l'a posee ni a distinguer la camera du fond. Un
/// disque remplit pi/4 ~= 0,785 de sa boite englobante, un rectangle la
/// remplit entierement : le taux de remplissage separe les deux sans ambiguite.
#[test]
fn compose_linux_forme_webcam_cercle() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux forme webcam: opt-in. Skip.");
        return;
    }
    let webcam_fixture = "../fixture/webcam.mp4";
    if !Path::new(webcam_fixture).is_file() {
        eprintln!("compose_linux forme webcam: pas de fixture webcam. Skip.");
        return;
    }

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut screen = Decoder::open(FIXTURE, &gpu).expect("Decoder::open screen");
    let mut cam = Decoder::open(webcam_fixture, &gpu).expect("Decoder::open webcam");

    let scene = |preset: &str, shape: &str| {
        format!(
            r##"{{"clips":[],"layout":{{"preset":"{preset}","webcamSize":1.6,"webcamShape":"{shape}","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0.1,"blur":false,"shadow":0,"roundnessFrac":0.0,"motionBlur":0}},"background":{{"kind":"color","color":"#00ff00"}},"zoomRegions":[],"annotations":[],"cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},"cropByClip":[],"output":{{"width":1920,"height":1080,"fps":30}}}}"##
        )
    };

    let mut render = |preset: &str, shape: &str| -> Vec<u8> {
        let parsed = Scene::from_json(&scene(preset, shape)).expect("scene json");
        // OBLIGATOIRE. `compose_frame` lit les LiveParams, PAS la scene brute :
        // la forme webcam, le padding et les effets y transitent. Sans cette
        // ligne la scene est parsee mais ignoree, et le test mesure la forme par
        // defaut ("rounded") en croyant mesurer celle qu'il a demandee.
        comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&parsed));
        comp.set_scene(Some(parsed));
        unsafe {
            let sf = screen.seek_to(1.0).expect("seek screen");
            let wf = cam.seek_to(1.0).expect("seek webcam");
            let mut cfg = Cfg::c8();
            cfg.shadow = false;
            comp.compose_frame(sf, wf, 1.0, &cfg).expect("compose_frame");
            comp.readback_direct().expect("readback").2
        }
    };

    let none = render("no-webcam", "rectangle");
    let rect = render("picture-in-picture", "rectangle");
    let circle = render("picture-in-picture", "circle");
    write_ppm("compose_linux_webcam_rect", W, H, &rect);
    write_ppm("compose_linux_webcam_circle", W, H, &circle);

    // Empreinte = pixels qui changent quand la camera apparait.
    let footprint = |with: &[u8]| -> Vec<bool> {
        with.chunks_exact(4)
            .zip(none.chunks_exact(4))
            .map(|(a, b)| {
                (a[0] as i32 - b[0] as i32).abs()
                    + (a[1] as i32 - b[1] as i32).abs()
                    + (a[2] as i32 - b[2] as i32).abs()
                    > 24
            })
            .collect()
    };
    // Taux de remplissage de la boite englobante de l'empreinte.
    let fill = |mask: &[bool], label: &str| -> f32 {
        let (mut x0, mut y0, mut x1, mut y1) = (W, H, 0u32, 0u32);
        let mut n = 0u32;
        for y in 0..H {
            for x in 0..W {
                if mask[(y * W + x) as usize] {
                    x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x); y1 = y1.max(y); n += 1;
                }
            }
        }
        assert!(x1 > x0 && y1 > y0, "{label} : aucune empreinte de camera");
        let (bw, bh) = (x1 - x0 + 1, y1 - y0 + 1);
        let ar = bw as f32 / bh as f32;
        let f = n as f32 / (bw * bh) as f32;
        println!("{label} : boite {bw}x{bh} (AR {ar:.3}), {n} px, remplissage {f:.3}");
        f
    };

    let rect_fill = fill(&footprint(&rect), "rectangle");
    let circle_fill = fill(&footprint(&circle), "cercle");

    assert!(rect_fill > 0.95, "le rectangle devrait remplir sa boite ({rect_fill:.3})");
    // pi/4 = 0,785 ; on tolere l'antialiasing du SDF sur le pourtour.
    assert!(
        (circle_fill - 0.785).abs() < 0.06,
        "le masque cercle ne rogne pas comme un disque (remplissage {circle_fill:.3}, attendu ~0.785)"
    );
}

/// Un enregistrement SANS camera ne doit rien dessiner dans la boite PiP.
///
/// Le cas est reproduit tel quel : le decodeur « webcam » recoit la frame de
/// l'ECRAN, ce que `open_and_seek_clip` fait en production des que le chemin
/// webcam est vide ou illisible. Seul `LiveParams::has_webcam` distingue alors
/// une vraie camera d'une seconde copie de l'ecran, et ce backend ne le lisait
/// pas : l'enregistrement d'ecran apparaissait dans sa propre vignette.
///
/// L'assertion est une egalite stricte avec le rendu « no-webcam » : pas un
/// seuil, parce qu'il ne s'agit pas de mesurer une empreinte plus petite mais
/// de verifier qu'il n'y en a aucune.
#[test]
fn compose_linux_sans_camera_ne_dessine_pas_de_vignette() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux sans camera: opt-in. Skip.");
        return;
    }

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut screen = Decoder::open(FIXTURE, &gpu).expect("Decoder::open screen");

    let scene_json = r##"{"clips":[],"layout":{"preset":"picture-in-picture","webcamSize":1.6,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false},"effects":{"padding":0.1,"blur":false,"shadow":0,"roundnessFrac":0.0,"motionBlur":0},"background":{"kind":"color","color":"#00ff00"},"zoomRegions":[],"annotations":[],"cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"},"cropByClip":[],"output":{"width":1920,"height":1080,"fps":30}}"##;

    let mut render = |has_webcam: bool| -> Vec<u8> {
        let parsed = Scene::from_json(scene_json).expect("scene json");
        let mut lp = openscreen_compositor::compositor::live_params_from_scene(&parsed);
        lp.has_webcam = has_webcam;
        comp.set_live_params(lp);
        comp.set_scene(Some(parsed));
        unsafe {
            let sf = screen.seek_to(1.0).expect("seek screen");
            let mut cfg = Cfg::c8();
            cfg.shadow = false;
            // La frame ecran passee AUSSI comme webcam : le repli exact de
            // `open_and_seek_clip` quand il n'y a pas de fichier camera.
            comp.compose_frame(sf, sf, 1.0, &cfg).expect("compose_frame");
            comp.readback_direct().expect("readback").2
        }
    };

    let with_camera = render(true);
    let without_camera = render(false);
    write_ppm("compose_linux_sans_camera", W, H, &without_camera);

    let differing = with_camera
        .chunks_exact(4)
        .zip(without_camera.chunks_exact(4))
        .filter(|(a, b)| {
            (a[0] as i32 - b[0] as i32).abs()
                + (a[1] as i32 - b[1] as i32).abs()
                + (a[2] as i32 - b[2] as i32).abs()
                > 24
        })
        .count();
    println!("vignette ecran-dans-la-camera : {differing} px");
    assert!(
        differing > 1000,
        "le rendu de controle ne dessine aucune vignette — le test ne prouve rien ({differing} px)"
    );

    // Reference : le preset qui ne veut pas de camera du tout. Il pose le meme
    // rectangle d'ecran (`plan_frame` : « no-webcam » et « picture-in-picture »
    // partagent `full_screen`), donc seule la vignette peut les separer.
    let no_webcam_preset = {
        let parsed = Scene::from_json(&scene_json.replace(
            r#""preset":"picture-in-picture""#,
            r#""preset":"no-webcam""#,
        ))
        .expect("scene json");
        comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&parsed));
        comp.set_scene(Some(parsed));
        unsafe {
            let sf = screen.seek_to(1.0).expect("seek screen");
            let mut cfg = Cfg::c8();
            cfg.shadow = false;
            comp.compose_frame(sf, sf, 1.0, &cfg).expect("compose_frame");
            comp.readback_direct().expect("readback").2
        }
    };
    let residual = without_camera
        .chunks_exact(4)
        .zip(no_webcam_preset.chunks_exact(4))
        .filter(|(a, b)| {
            (a[0] as i32 - b[0] as i32).abs()
                + (a[1] as i32 - b[1] as i32).abs()
                + (a[2] as i32 - b[2] as i32).abs()
                > 24
        })
        .count();
    assert_eq!(
        residual, 0,
        "sans camera, le rendu devrait etre celui du preset no-webcam ({residual} px d'ecart)"
    );
}

// ---------------------------------------------------------------------------
// Annotations : figure (fleche), flou/mosaique, image, et animations du texte.
//
// Ces quatre familles existaient dans le schema et arrivaient jusqu'au
// compositeur, mais le chemin Linux ne dessinait QUE le texte -- tout le reste
// etait ignore en silence. Les tests ci-dessous les MESURENT sur le GPU au lieu
// de supposer qu'un draw ajoute suffit : la methode est toujours la meme, rendre
// deux fois la meme scene (avec et sans l'annotation) et lire l'empreinte dans
// le diff. Elle ne demande de connaitre ni ou `plan_frame` a pose l'ecran, ni
// quelle couleur la video porte a cet endroit.
// ---------------------------------------------------------------------------

/// Scene de base des tests d'annotation : fond uni, pas d'effets, une liste
/// d'annotations injectee telle quelle.
fn annotation_scene(annotations: &str) -> String {
    annotation_scene_with_zoom("", annotations)
}

/// La meme, avec une liste de regions de zoom injectee telle quelle. Le zoom est
/// ce qui separe le rect d'ancrage des annotations (`s_ann`) de la boite ecran
/// (`s_dst`) : sans lui les deux coincident et rien ne peut le mesurer.
fn annotation_scene_with_zoom(zoom_regions: &str, annotations: &str) -> String {
    format!(
        r##"{{"clips":[],"layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0.1,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0}},"background":{{"kind":"color","color":"#00ff00"}},"zoomRegions":[{zoom_regions}],"annotations":[{annotations}],"cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},"cropByClip":[],"output":{{"width":1920,"height":1080,"fps":30}}}}"##
    )
}

/// Indices des pixels qui different entre deux rendus. C'est l'empreinte exacte
/// de ce que l'annotation a ajoute.
fn changed_pixels(a: &[u8], b: &[u8]) -> Vec<usize> {
    a.chunks_exact(4)
        .zip(b.chunks_exact(4))
        .enumerate()
        .filter(|(_, (p, q))| {
            // Seuil 6/255 : au-dessus du bruit de quantification du YUV->RGB,
            // bien en-dessous de tout trait ou masque reel.
            (0..3).any(|c| (p[c] as i32 - q[c] as i32).abs() > 6)
        })
        .map(|(i, _)| i)
        .collect()
}

/// Boite englobante (x0, y0, x1, y1) inclusive d'une liste d'indices de pixels.
fn bbox(px: &[usize], w: u32) -> (u32, u32, u32, u32) {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for &i in px {
        let (x, y) = (i as u32 % w, i as u32 / w);
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    (x0, y0, x1, y1)
}

/// Une fleche est un TRACE, pas un aplat — et elle suit sa direction.
///
/// Deux pieges que ce test ferme. Le premier : ne rien dessiner du tout, ce que
/// faisait le chemin Linux. Le second, plus sournois : dessiner le quad entier
/// (un mode inconnu tombe sur la branche « ombre » du shader et remplit la
/// boite), ce qui se voit comme un rectangle colore et non comme une fleche.
/// L'aire couverte les separe : trois segments d'epaisseur fixe ne peuvent pas
/// remplir la moitie de leur boite.
#[test]
fn compose_linux_annotation_fleche() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux annotation fleche: opt-in. Skip.");
        return;
    }
    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut screen = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    let mut render = |annotations: &str| -> Vec<u8> {
        let parsed = Scene::from_json(&annotation_scene(annotations)).expect("scene json");
        // Cf. compose_linux_forme_webcam_cercle : sans les LiveParams la scene
        // est parsee puis ignoree, et le test mesure les valeurs par defaut.
        comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&parsed));
        comp.set_scene(Some(parsed));
        // Le 3e argument de `compose_frame` est un NUMERO DE FRAME (source_t =
        // frame / 60), pas des secondes. `set_timeline_time` fixe directement
        // l'instant que lit la fenetre temporelle des annotations -- sans lui,
        // une annotation a `startSec: 1` ne serait tout simplement pas visible,
        // et un test d'animation mesurerait sa propre erreur de cadrage.
        comp.set_timeline_time(Some(1.0));
        unsafe {
            let sf = screen.seek_to(1.0).expect("seek");
            comp.compose_frame(sf, std::ptr::null(), 60.0, &Cfg::c8()).expect("compose_frame");
            comp.readback_direct().expect("readback").2
        }
    };

    let figure = |direction: &str| {
        format!(
            r##"{{"id":"f1","kind":"figure","x":0.2,"y":0.2,"w":0.4,"h":0.4,"startSec":0,"endSec":10,"zIndex":1,"figure":{{"direction":"{direction}","color":"#ff0000","strokeWidth":8}}}}"##
        )
    };
    let none = render("");
    let right = render(&figure("right"));
    let up = render(&figure("up"));

    let right_px = changed_pixels(&none, &right);
    let up_px = changed_pixels(&none, &up);
    assert!(
        right_px.len() > 200,
        "aucune fleche dessinee ({} px changes) — le mode 9 n'atteint pas le shader",
        right_px.len()
    );

    // La boite fait 0.4 x 0.4 du rect ecran ; la fleche s'y inscrit en carre
    // (preserveAspectRatio). Un trait de 8/100 d'epaisseur sur trois segments
    // couvre nettement moins de la moitie de ce carre.
    let (x0, y0, x1, y1) = bbox(&right_px, W);
    let box_area = ((x1 - x0 + 1) * (y1 - y0 + 1)) as f64;
    let fill = right_px.len() as f64 / box_area;
    assert!(
        fill < 0.5,
        "la fleche remplit {fill:.2} de sa boite — c'est un aplat, pas un trace"
    );

    // La direction est vraiment lue : « right » et « up » sont deux tracés
    // differents, donc leurs empreintes ne peuvent pas coincider.
    let common = right_px
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .intersection(&up_px.iter().collect::<std::collections::HashSet<_>>())
        .count();
    let overlap = common as f64 / right_px.len().min(up_px.len()) as f64;
    assert!(
        overlap < 0.75,
        "« right » et « up » se recouvrent a {overlap:.2} — la direction est ignoree"
    );
}

/// Le flou floute vraiment, et la mosaique fait des blocs.
///
/// Mesure sur l'ENERGIE HAUTE FREQUENCE (somme des ecarts entre voisins
/// horizontaux) dans la zone masquee. Compter des pixels changes ne suffirait
/// pas : un masque qui recopierait la frame telle quelle changerait aussi des
/// pixels au bord et passerait. Ce qu'on veut prouver, c'est que le detail a
/// DISPARU — c'est la seule propriete qui rend l'annotation utile.
#[test]
fn compose_linux_annotation_flou_et_mosaique() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux annotation flou: opt-in. Skip.");
        return;
    }
    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut screen = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    let mut render = |annotations: &str| -> Vec<u8> {
        let parsed = Scene::from_json(&annotation_scene(annotations)).expect("scene json");
        comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&parsed));
        comp.set_scene(Some(parsed));
        // Le 3e argument de `compose_frame` est un NUMERO DE FRAME (source_t =
        // frame / 60), pas des secondes. `set_timeline_time` fixe directement
        // l'instant que lit la fenetre temporelle des annotations -- sans lui,
        // une annotation a `startSec: 1` ne serait tout simplement pas visible,
        // et un test d'animation mesurerait sa propre erreur de cadrage.
        comp.set_timeline_time(Some(1.0));
        unsafe {
            let sf = screen.seek_to(1.0).expect("seek");
            comp.compose_frame(sf, std::ptr::null(), 60.0, &Cfg::c8()).expect("compose_frame");
            comp.readback_direct().expect("readback").2
        }
    };

    // Boite bien a l'interieur du rect ecran, sur de la video (pas sur le fond).
    let blur_ann = |style: &str, amount: f32| {
        format!(
            r##"{{"id":"b1","kind":"blur","x":0.25,"y":0.25,"w":0.5,"h":0.5,"startSec":0,"endSec":10,"zIndex":1,"blur":{{"style":"{style}","shape":"rectangle","color":"white","intensity":{amount},"blockSize":{amount}}}}}"##
        )
    };
    let none = render("");
    let blurred = render(&blur_ann("blur", 24.0));
    let mosaic = render(&blur_ann("mosaic", 16.0));

    let changed = changed_pixels(&none, &blurred);
    assert!(
        changed.len() > 2000,
        "le flou n'a rien change ({} px) — le mode 10 n'atteint pas le shader",
        changed.len()
    );
    let (x0, y0, x1, y1) = bbox(&changed, W);

    // Energie haute frequence sur le canal vert, a l'interieur de la zone, en
    // s'ecartant du bord (les 2 px de bord melangent masque et image nette).
    let hf = |px: &[u8]| -> f64 {
        let mut sum = 0f64;
        let mut n = 0usize;
        for y in (y0 + 2)..=(y1 - 2) {
            for x in (x0 + 2)..(x1 - 2) {
                let i = ((y * W + x) * 4) as usize;
                let j = i + 4;
                sum += (px[i + 1] as i32 - px[j + 1] as i32).abs() as f64;
                n += 1;
            }
        }
        sum / n.max(1) as f64
    };
    let sharp_hf = hf(&none);
    let blur_hf = hf(&blurred);
    assert!(
        sharp_hf > 1.0,
        "la fixture est trop plate a cet endroit ({sharp_hf:.2}) pour mesurer un flou"
    );
    assert!(
        blur_hf < sharp_hf * 0.5,
        "detail toujours present sous le flou : {blur_hf:.2} contre {sharp_hf:.2} sans masque"
    );

    // Mosaique : a l'interieur d'un bloc les pixels sont IDENTIQUES, donc la
    // proportion de voisins strictement egaux explose par rapport a l'image
    // nette. C'est la signature d'un aplat par blocs, qu'un simple flou n'a pas.
    let flat_ratio = |px: &[u8]| -> f64 {
        let (mut eq, mut n) = (0usize, 0usize);
        for y in (y0 + 2)..=(y1 - 2) {
            for x in (x0 + 2)..(x1 - 2) {
                let i = ((y * W + x) * 4) as usize;
                let j = i + 4;
                if px[i..i + 3] == px[j..j + 3] {
                    eq += 1;
                }
                n += 1;
            }
        }
        eq as f64 / n.max(1) as f64
    };
    let sharp_flat = flat_ratio(&none);
    let mosaic_flat = flat_ratio(&mosaic);
    assert!(
        mosaic_flat > sharp_flat + 0.3,
        "pas de blocs : {mosaic_flat:.2} de voisins egaux contre {sharp_flat:.2} sans masque"
    );
}

/// Une image d'annotation tient dans sa boite SANS etre etiree.
///
/// C'est le meme defaut que celui corrige pour la webcam : coller la source au
/// rect deforme tout ce qui n'a pas exactement son rapport. On rend une image
/// 4:1 dans une boite qui ne l'est pas, et on mesure le rapport de l'empreinte
/// — il doit rester 4:1, quelle que soit la boite.
#[test]
fn compose_linux_annotation_image() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux annotation image: opt-in. Skip.");
        return;
    }
    // Aplat magenta 400x100 : un rapport 4:1 franc, et une couleur que la
    // fixture ne porte pas.
    let img_path = std::env::temp_dir().join("openscreen-annotation-4x1.png");
    let img = image::RgbaImage::from_pixel(400, 100, image::Rgba([255, 0, 255, 255]));
    img.save(&img_path).expect("ecrire le png de test");

    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut screen = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    let mut render = |annotations: &str| -> Vec<u8> {
        let parsed = Scene::from_json(&annotation_scene(annotations)).expect("scene json");
        comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&parsed));
        comp.set_scene(Some(parsed));
        // Le 3e argument de `compose_frame` est un NUMERO DE FRAME (source_t =
        // frame / 60), pas des secondes. `set_timeline_time` fixe directement
        // l'instant que lit la fenetre temporelle des annotations -- sans lui,
        // une annotation a `startSec: 1` ne serait tout simplement pas visible,
        // et un test d'animation mesurerait sa propre erreur de cadrage.
        comp.set_timeline_time(Some(1.0));
        unsafe {
            let sf = screen.seek_to(1.0).expect("seek");
            comp.compose_frame(sf, std::ptr::null(), 60.0, &Cfg::c8()).expect("compose_frame");
            comp.readback_direct().expect("readback").2
        }
    };

    let none = render("");
    // Boite carree en fraction du rect ecran — donc PAS carree en pixels, et
    // dans tous les cas pas 4:1.
    let with_image = render(&format!(
        r##"{{"id":"i1","kind":"image","x":0.25,"y":0.3,"w":0.4,"h":0.4,"startSec":0,"endSec":10,"zIndex":1,"imagePath":"{}"}}"##,
        img_path.display()
    ));

    let changed = changed_pixels(&none, &with_image);
    assert!(
        changed.len() > 500,
        "aucune image dessinee ({} px changes)",
        changed.len()
    );
    let (x0, y0, x1, y1) = bbox(&changed, W);
    let (bw, bh) = ((x1 - x0 + 1) as f64, (y1 - y0 + 1) as f64);
    let aspect = bw / bh;
    assert!(
        (aspect - 4.0).abs() < 0.25,
        "image etiree : empreinte {bw}x{bh} (rapport {aspect:.2}), attendu 4:1"
    );

    // Et c'est bien l'image qui est peinte, pas un aplat de la couleur du bord :
    // le centre doit etre magenta.
    let (cx, cy) = ((x0 + x1) / 2, (y0 + y1) / 2);
    let i = ((cy * W + cx) * 4) as usize;
    let (r, g_, b) = (with_image[i] as i32, with_image[i + 1] as i32, with_image[i + 2] as i32);
    assert!(
        r > 200 && g_ < 80 && b > 200,
        "centre de l'empreinte non magenta : ({r}, {g_}, {b})"
    );
    let _ = std::fs::remove_file(&img_path);
}

/// Les animations d'apparition du texte sont JOUEES.
///
/// `text_anim.rs` etait porte, teste unitairement et transporte par la scene,
/// mais aucun appelant Linux ne l'invoquait : une annotation animee s'affichait
/// simplement d'un bloc. On rend la MEME frame video a deux instants differents
/// de l'animation en deplaçant `startSec` — le seul ecart possible entre les
/// deux rendus est donc l'animation elle-meme.
#[test]
fn compose_linux_animation_texte() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux animation texte: opt-in. Skip.");
        return;
    }
    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut screen = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    let mut render = |annotations: &str| -> Vec<u8> {
        let parsed = Scene::from_json(&annotation_scene(annotations)).expect("scene json");
        comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&parsed));
        comp.set_scene(Some(parsed));
        // Le 3e argument de `compose_frame` est un NUMERO DE FRAME (source_t =
        // frame / 60), pas des secondes. `set_timeline_time` fixe directement
        // l'instant que lit la fenetre temporelle des annotations -- sans lui,
        // une annotation a `startSec: 1` ne serait tout simplement pas visible,
        // et un test d'animation mesurerait sa propre erreur de cadrage.
        comp.set_timeline_time(Some(1.0));
        unsafe {
            let sf = screen.seek_to(1.0).expect("seek");
            comp.compose_frame(sf, std::ptr::null(), 60.0, &Cfg::c8()).expect("compose_frame");
            comp.readback_direct().expect("readback").2
        }
    };

    // `startSec` deplace l'instant DANS l'animation sans toucher la frame video :
    // a t=1.0s, start=1.0 donne 0 ms ecoulees, start=0.0 en donne 1000 (fini).
    let text = |animation: &str, start: f32| {
        format!(
            r##"{{"id":"t1","kind":"text","x":0.1,"y":0.1,"w":0.6,"h":0.2,"startSec":{start},"endSec":10,"zIndex":1,"text":{{"content":"Hello","color":"#ffffff","backgroundColor":"transparent","fontSizeRel":0.12,"fontFamily":"","fontWeight":"bold","fontStyle":"normal","textDecoration":"none","textAlign":"center","animation":"{animation}"}}}}"##
        )
    };
    let none = render("");
    let settled = render(&text("fade", 0.0));
    let ink_settled = changed_pixels(&none, &settled).len();
    assert!(
        ink_settled > 200,
        "aucun texte rendu ({ink_settled} px) — le test ne mesure rien"
    );

    // Fondu a 0 ms : opacite 0, donc RIEN ne doit apparaitre. Sans l'animation
    // le texte serait deja a pleine opacite et ce compte vaudrait `ink_settled`.
    let starting = render(&text("fade", 1.0));
    let ink_starting = changed_pixels(&none, &starting).len();
    assert!(
        ink_starting < ink_settled / 10,
        "le fondu n'est pas applique : {ink_starting} px a 0 ms contre {ink_settled} px a la fin"
    );

    // Machine a ecrire a mi-course (350 ms sur 700) : la moitie gauche du bloc
    // est revelee, donc l'empreinte est nettement plus etroite qu'a la fin.
    let typed_full = render(&text("typewriter", 0.0));
    let typed_half = render(&text("typewriter", 0.65));
    let full_px = changed_pixels(&none, &typed_full);
    let half_px = changed_pixels(&none, &typed_half);
    assert!(!half_px.is_empty(), "la machine a ecrire n'a rien revele a mi-course");
    let full_right = bbox(&full_px, W).2;
    let half_right = bbox(&half_px, W).2;
    assert!(
        half_right < full_right,
        "le texte n'est pas revele progressivement : bord droit {half_right} a mi-course \
         contre {full_right} a la fin"
    );
}

/// Une caption ne bouge ni ne grossit quand le contenu zoome ou s'incline.
///
/// C'est le contrat de `SceneAnnotation` — l'overlay de la preview est FRERE de
/// l'element qui porte la transform, donc les sous-titres tiennent en place
/// pendant que la video zoome dessous — et c'est celui que ce backend violait :
/// il ancrait les annotations sur `s_dst`, la boite ecran, au lieu de `s_ann`.
/// Windows et macOS avaient ete corriges a l'issue #179, Linux non. Le natif
/// etant la SEULE source de pixels de l'apercu (le DOM ne peint que la poignee
/// de selection, cf. `AnnotationOverlay.tsx`), la derive se voyait des l'edition
/// sur cette plateforme, pas seulement a l'export.
///
/// La bande porte un fond OPAQUE : son empreinte est un RECT PLEIN et non la
/// silhouette des glyphes, donc la boite englobante mesure une geometrie de
/// placement et pas ce que la video montre dessous. Ce rect est la plaque du
/// rasteriseur (`glyphs.plate`), serree sur les lignes posees — pas la boite
/// 0.92x0.22 de l'annotation : peu importe ici, la plaque est une fonction
/// deterministe de `dst` et de `font_size_px`, tous deux ancres sur `s_ann`.
/// Chaque rendu est diffe contre son propre rendu sans annotation, sinon le
/// changement du calque video sous le zoom dominerait la mesure.
///
/// La rotation compte autant que le zoom : un preset iso/left/right est une
/// propriete de region de zoom, donc l'incliner amenait la boite avec lui — et
/// les sous-titres partaient avec elle sans pour autant suivre le plan incline.
#[test]
fn compose_linux_annotation_ancree_hors_zoom() {
    if std::env::var("OPENSCREEN_LINUX_COMPOSE").is_err() || !Path::new(FIXTURE).is_file() {
        eprintln!("compose_linux annotation hors zoom: opt-in. Skip.");
        return;
    }
    let gpu = Gpu::create(false).expect("Gpu::create");
    let comp = Compositor::new_sized(&gpu, W, H).expect("Compositor::new_sized");
    let mut screen = Decoder::open(FIXTURE, &gpu).expect("Decoder::open");

    // UN SEUL `seek_to`, comme `compose_linux_ecran_tilte` : les six rendus partagent
    // la meme AVFrame, donc le decodeur ne peut pas introduire une difference qu'on
    // prendrait pour un deplacement de la bande.
    let sf = unsafe { screen.seek_to(1.0).expect("seek") };

    let render = |zoom: &str, annotations: &str| -> Vec<u8> {
        let parsed =
            Scene::from_json(&annotation_scene_with_zoom(zoom, annotations)).expect("scene json");
        comp.set_live_params(openscreen_compositor::compositor::live_params_from_scene(&parsed));
        comp.set_scene(Some(parsed));
        // C'est CET override qui fixe le temps echantillonne, pas le 3e argument de
        // `compose_frame` : `plan_frame` lit `timeline_t_override.unwrap_or(frame / FPS)`,
        // et `FPS` y vaut 60 en dur (pas le `fps` de la scene). t = 3 s tombe au coeur
        // de la region [0, 6], rampe d'entree finie, zoom et rotation a pleine force.
        comp.set_timeline_time(Some(3.0));
        unsafe {
            comp.compose_frame(sf, sf, 90.0, &Cfg::c8()).expect("compose_frame");
            comp.readback_direct().expect("readback").2
        }
    };

    let zoom = |rotation: &str| {
        format!(
            r##"{{"id":"z1","clipIndex":0,"startSec":0,"endSec":6,"scale":2.5,"focusX":0.5,"focusY":0.3,"focusMode":"manual","rotation":{rotation}}}"##
        )
    };
    // Bande basse pleine largeur, comme une vraie caption : hors du centre, donc
    // un ancrage qui suivrait le zoom la deplacerait ET la ferait deborder.
    const BAND: &str = r##"{"id":"c1","kind":"text","x":0.04,"y":0.74,"w":0.92,"h":0.22,"startSec":0,"endSec":10,"zIndex":1,"text":{"content":"Sous-titre","color":"#ffffff","backgroundColor":"#e0245e","fontSizeRel":0.09,"fontFamily":"","fontWeight":"bold","fontStyle":"normal","textDecoration":"none","textAlign":"center"}}"##;

    let (z, tilt) = (zoom("null"), zoom(r#""iso""#));
    let bare_plain = render("", "");
    let with_plain = render("", BAND);
    let bare_zoom = render(&z, "");
    let with_zoom = render(&z, BAND);
    let bare_tilt = render(&tilt, "");
    let with_tilt = render(&tilt, BAND);

    let band_bbox = |bare: &[u8], with: &[u8], label: &str| {
        let px = changed_pixels(bare, with);
        // C'est CE garde-fou qui saute en premier quand le bug est present : ancree sur
        // `s_dst`, la bande part a y ~= 840 px dans un cadre de 540 et sort du champ, donc
        // elle ne change plus aucun pixel au lieu de se decaler de quelques-uns.
        assert!(
            px.len() > 500,
            "bande absente ({} px changes) — {label} : sortie du cadre, donc ancree sur \
             `s_dst` au lieu de `s_ann`",
            px.len()
        );
        bbox(&px, W)
    };
    let plain = band_bbox(&bare_plain, &with_plain, "sans zoom");
    let zoomed = band_bbox(&bare_zoom, &with_zoom, "avec zoom");
    let tilted = band_bbox(&bare_tilt, &with_tilt, "avec rotation 3D");

    // Garde-fou : le zoom doit vraiment agir sur l'image, sinon les egalites
    // ci-dessous seraient vraies pour la mauvaise raison.
    let moved = changed_pixels(&bare_plain, &bare_zoom);
    assert!(
        moved.len() > 10_000,
        "le zoom n'a change que {} px — la scene zoomee n'est pas appliquee",
        moved.len()
    );

    // 2 px de tolerance pour l'antialiasing du bord de la plaque. L'erreur visee est
    // d'un tout autre ordre : sous zoom 2.5 la bande ancree sur `s_dst` descend de
    // ~450 px et grossit d'autant, donc en pratique elle quitte le cadre et c'est le
    // garde-fou « bande absente » ci-dessus qui tranche. Cette boucle attrape le reste :
    // un ancrage qui deriverait sans sortir du champ.
    for (name, got) in [("zoom", zoomed), ("rotation 3D", tilted)] {
        let d = [
            got.0.abs_diff(plain.0),
            got.1.abs_diff(plain.1),
            got.2.abs_diff(plain.2),
            got.3.abs_diff(plain.3),
        ];
        assert!(
            d.iter().all(|&v| v <= 2),
            "la bande a suivi le {name} : {got:?} contre {plain:?} sans — \
             les annotations sont ancrees sur `s_dst` au lieu de `s_ann`"
        );
    }
}
