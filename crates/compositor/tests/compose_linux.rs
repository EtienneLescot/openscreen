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
        // `frame` = 90 -> source_t = 3 s, au coeur de la region [0, 6] : la rampe
        // d'entree est finie, la rotation est a pleine force.
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
    comp.set_scene(Some(Scene::from_json(scene_json).expect("scene json")));

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
