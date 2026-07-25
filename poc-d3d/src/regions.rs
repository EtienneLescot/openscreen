//! Zoom regions + camera-fullscreen regions — port des enveloppes ease-in/hold/ease-out du
//! web (`zoomRegionUtils.ts` / `cameraFullscreenUtils.ts`) vers le natif, pour que le timing
//! des transitions soit identique en preview ET en export. Inclut le "connected zoom pan"
//! (chaînage lissé entre deux régions rapprochées), le focus "auto" (suivi de la télémétrie
//! curseur) et la rotation 3D (présets iso/left/right, cf. `compositor.rs` pour le rendu du
//! tilt perspective — ce module ne fait que le calcul temporel, pas le rendu GPU).

use crate::cursor::CursorTrack;
use crate::scene::{SceneCameraFullscreenRegion, SceneSpeedRegion, SceneZoomRegion};

/// Quantification commune vidéo/audio : le web retranche exactement 1 ms avant `ceil`.
pub const SPEED_FRAME_EPSILON_SEC: f64 = 0.001;
const MIN_SPEED_SEGMENT_SEC: f64 = 0.0001;

#[derive(Debug, Clone, Copy)]
pub struct SpeedSegment {
    pub start_sec: f64,
    pub end_sec: f64,
    pub speed: f64,
    pub frame_count: u64,
}

/// Découpe toute la fenêtre gardée en spans contigus ; hors région la vitesse vaut 1×.
/// Les régions sont ordonnées par début et, si un ancien payload en superpose, la première
/// conserve la portion déjà couverte pour ne jamais émettre deux fois le même temps source.
pub fn speed_segments_for_window(
    regions: &[SceneSpeedRegion],
    source_start_sec: f64,
    source_end_sec: f64,
    fps: f64,
) -> Vec<SpeedSegment> {
    if source_end_sec <= source_start_sec || !fps.is_finite() || fps <= 0.0 {
        return Vec::new();
    }
    let mut overlapping: Vec<&SceneSpeedRegion> = regions
        .iter()
        .filter(|r| r.start_sec < source_end_sec && r.end_sec > source_start_sec)
        .collect();
    overlapping.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut spans = Vec::new();
    let mut cursor = source_start_sec;
    for region in overlapping {
        let start = region.start_sec.max(source_start_sec).max(cursor);
        let end = region.end_sec.min(source_end_sec);
        if start > cursor {
            push_speed_segment(&mut spans, cursor, start, 1.0, fps);
        }
        if end > start {
            let speed = if region.speed.is_finite() && region.speed > 0.0 {
                region.speed
            } else {
                1.0
            };
            push_speed_segment(&mut spans, start, end, speed, fps);
            cursor = end;
        }
    }
    if cursor < source_end_sec {
        push_speed_segment(&mut spans, cursor, source_end_sec, 1.0, fps);
    }
    spans
}

/// Multiplicateur de vitesse actif au temps source `t` (temps ABSOLU de la source, même
/// convention que `SceneSpeedRegion.start_sec`/`end_sec` — pas de fenêtre de clip à soustraire).
/// 1.0 hors de toute région. Utilisé par la preview live (`live.rs`) pour moduler le nombre de
/// frames décodées par tick réel — contrairement à `speed_segments_for_window` (export), qui a
/// besoin de pré-découper toute la fenêtre en spans pour connaître le compte de frames total à
/// l'avance, la lecture live avance tick par tick et n'a besoin que de la vitesse "maintenant".
///
/// BUG corrigé : ignorait `region.clip_index`, filtrant seulement par recouvrement temporel sur
/// la scène BRUTE (non filtrée par clip) — dès qu'un projet a plus d'un clip, deux clips peuvent
/// tout à fait partager la même fenêtre de temps source (chacun démarrant près de t=0 de son
/// propre fichier, cas courant), et la région du MAUVAIS clip matchait alors silencieusement (ou
/// aucune ne matchait quand le clip actif est censé être couvert par une région tournée d'un
/// autre index). Même garde-fou que `Scene::for_clip_window`'s `belongs` (scene.rs) : accepte la
/// région seulement si `clip_index` est absent (vieux payload) OU vaut `active_clip_index`.
pub fn speed_at(regions: &[SceneSpeedRegion], active_clip_index: usize, t: f64) -> f64 {
    for region in regions {
        let belongs = region.clip_index.map(|i| i == active_clip_index).unwrap_or(true);
        if belongs && t >= region.start_sec && t < region.end_sec {
            if region.speed.is_finite() && region.speed > 0.0 {
                return region.speed;
            }
            return 1.0;
        }
    }
    1.0
}

fn push_speed_segment(
    spans: &mut Vec<SpeedSegment>,
    start_sec: f64,
    end_sec: f64,
    speed: f64,
    fps: f64,
) {
    let duration = end_sec - start_sec;
    if duration <= MIN_SPEED_SEGMENT_SEC {
        return;
    }
    let frames = (((duration - SPEED_FRAME_EPSILON_SEC) / speed) * fps)
        .ceil()
        .max(0.0) as u64;
    spans.push(SpeedSegment { start_sec, end_sec, speed, frame_count: frames });
}

// mêmes fenêtres de transition que le web (TRANSITION_WINDOW_MS etc., converties en secondes).
const TRANSITION_WINDOW_S: f32 = 1.01505;
const ZOOM_IN_TRANSITION_WINDOW_S: f32 = TRANSITION_WINDOW_S * 1.5;
const ZOOM_IN_OVERLAP_S: f32 = 0.5;
const FULLSCREEN_LEAD_OUT_WINDOW_S: f32 = TRANSITION_WINDOW_S * 1.5;
// port de `CHAINED_ZOOM_PAN_GAP_MS` / `CONNECTED_ZOOM_PAN_DURATION_MS` (TS).
const CHAINED_ZOOM_PAN_GAP_S: f32 = 1.5;
const CONNECTED_ZOOM_PAN_DURATION_S: f32 = 1.0;

fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

fn sample_cubic_bezier(a1: f32, a2: f32, t: f32) -> f32 {
    let o = 1.0 - t;
    3.0 * a1 * o * o * t + 3.0 * a2 * o * t * t + t * t * t
}

fn sample_cubic_bezier_derivative(a1: f32, a2: f32, t: f32) -> f32 {
    let o = 1.0 - t;
    3.0 * a1 * o * o + 6.0 * (a2 - a1) * o * t + 3.0 * (1.0 - a2) * t * t
}

/// Port direct de `cubicBezier` (TS) : Newton-Raphson puis bissection de repli.
fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    let target_x = clamp01(t);
    let mut solved_t = target_x;
    for _ in 0..8 {
        let cur_x = sample_cubic_bezier(x1, x2, solved_t) - target_x;
        let cur_d = sample_cubic_bezier_derivative(x1, x2, solved_t);
        if cur_x.abs() < 1e-6 || cur_d.abs() < 1e-6 {
            break;
        }
        solved_t -= cur_x / cur_d;
    }
    let (mut lower, mut upper) = (0.0f32, 1.0f32);
    solved_t = clamp01(solved_t);
    for _ in 0..10 {
        let cur_x = sample_cubic_bezier(x1, x2, solved_t);
        if (cur_x - target_x).abs() < 1e-6 {
            break;
        }
        if cur_x < target_x {
            lower = solved_t;
        } else {
            upper = solved_t;
        }
        solved_t = (lower + upper) * 0.5;
    }
    sample_cubic_bezier(y1, y2, solved_t)
}

/// Port de `easeOutScreenStudio` (TS) : cubic-bezier(0.16, 1, 0.3, 1).
fn ease_out_screen_studio(t: f32) -> f32 {
    cubic_bezier(0.16, 1.0, 0.3, 1.0, t)
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Port de `computeRegionStrength` (TS, `zoomRegionUtils.ts`) : 0 hors fenêtre, ease-in avant
/// `startSec` (le zoom anticipe légèrement), plein régime pendant la région, ease-out après
/// `endSec`. Les temps reçus sont les temps source échantillonnés par le pipeline, donc ces
/// enveloppes restent alignées quand une speed region répète ou saute des frames.
fn zoom_region_strength(region: &SceneZoomRegion, t: f32) -> f32 {
    let start = region.start_sec as f32;
    let end = region.end_sec as f32;
    let zoom_in_end = start + ZOOM_IN_OVERLAP_S;
    let lead_in_start = zoom_in_end - ZOOM_IN_TRANSITION_WINDOW_S;
    let lead_out_end = end + TRANSITION_WINDOW_S;
    if t < lead_in_start || t > lead_out_end {
        return 0.0;
    }
    if t < zoom_in_end {
        let progress = (t - lead_in_start) / ZOOM_IN_TRANSITION_WINDOW_S;
        return ease_out_screen_studio(progress);
    }
    if t <= end {
        return 1.0;
    }
    let progress = clamp01((t - end) / TRANSITION_WINDOW_S);
    1.0 - ease_out_screen_studio(progress)
}

/// État de zoom complet au temps `t` : échelle, focus, ET tilt 3D (degrés X/Y/Z — rendu en
/// pixel shader par `compositor.rs`, ce module ne fait que le calcul temporel).
pub struct ZoomState {
    pub scale: f32,
    pub focus: [f32; 2],
    pub rotation: [f32; 3],
}

const IDENTITY_ZOOM: ZoomState = ZoomState { scale: 1.0, focus: [0.5, 0.5], rotation: [0.0, 0.0, 0.0] };

/// Port de `easeConnectedPan` (TS) : cubic-bezier(0.1, 0, 0.2, 1).
fn ease_connected_pan(t: f32) -> f32 {
    cubic_bezier(0.1, 0.0, 0.2, 1.0, t)
}

/// Port de `getRotation3D`/`ROTATION_3D_PRESETS` (TS, `types.ts`) — degrés (rotationX, Y, Z).
fn rotation3d_for(rotation: &Option<String>) -> [f32; 3] {
    match rotation.as_deref() {
        Some("iso") => [-10.0, -16.0, 0.0],
        Some("left") => [0.0, -22.0, 0.0],
        Some("right") => [0.0, 22.0, 0.0],
        _ => [0.0, 0.0, 0.0],
    }
}

fn lerp_rotation3d(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

/// Les trois segments d'une flèche d'annotation, en unités du viewBox SVG (0..100), repris
/// VERBATIM des tracés de `ArrowSvgs.tsx` : hampe puis deux barbes, toutes à bouts ronds. Garder
/// les mêmes nombres est ce qui garantit que le rendu natif et la preview dessinent la même
/// flèche — inutile de réinventer une géométrie « équivalente ».
pub fn arrow_segments_viewbox(direction: &str) -> [[f32; 4]; 3] {
    match direction {
        "up" => [[50.0, 20.0, 50.0, 80.0], [50.0, 20.0, 35.0, 35.0], [50.0, 20.0, 65.0, 35.0]],
        "down" => [[50.0, 20.0, 50.0, 80.0], [50.0, 80.0, 35.0, 65.0], [50.0, 80.0, 65.0, 65.0]],
        "left" => [[80.0, 50.0, 20.0, 50.0], [20.0, 50.0, 35.0, 35.0], [20.0, 50.0, 35.0, 65.0]],
        "up-right" => [[25.0, 75.0, 75.0, 25.0], [75.0, 25.0, 54.9, 31.7], [75.0, 25.0, 68.3, 45.1]],
        "up-left" => [[75.0, 75.0, 25.0, 25.0], [25.0, 25.0, 45.1, 31.7], [25.0, 25.0, 31.7, 45.1]],
        "down-right" => {
            [[25.0, 25.0, 75.0, 75.0], [75.0, 75.0, 68.3, 54.9], [75.0, 75.0, 54.9, 68.3]]
        }
        "down-left" => {
            [[75.0, 25.0, 25.0, 75.0], [25.0, 75.0, 31.7, 54.9], [25.0, 75.0, 45.1, 68.3]]
        }
        // "right" et tout ce qui n'est pas reconnu — même défaut que le schéma côté app.
        _ => [[20.0, 50.0, 80.0, 50.0], [80.0, 50.0, 65.0, 35.0], [80.0, 50.0, 65.0, 65.0]],
    }
}

/// Passe les segments du viewBox aux px locaux du quad, et rend la demi-épaisseur du trait.
///
/// Le SVG n'a pas de `preserveAspectRatio` explicite, donc il vaut `xMidYMid meet` : mise à
/// l'échelle **uniforme** au plus petit côté, centrée. La flèche n'est donc jamais étirée quand la
/// boîte n'est pas carrée, et `strokeWidth` suit la même échelle — c'est pour ça qu'il n'a pas
/// besoin de la convention de proportionnalité du `fontSize` : il est déjà exprimé dans le
/// viewBox, donc déjà relatif à la boîte.
pub fn arrow_local_geometry(
    direction: &str,
    stroke_width_viewbox: f32,
    quad_px: [f32; 2],
) -> ([[f32; 4]; 3], f32) {
    let scale = quad_px[0].min(quad_px[1]) / 100.0;
    let off = [(quad_px[0] - 100.0 * scale) * 0.5, (quad_px[1] - 100.0 * scale) * 0.5];
    let to_local = |v: [f32; 4]| {
        [
            off[0] + v[0] * scale,
            off[1] + v[1] * scale,
            off[0] + v[2] * scale,
            off[1] + v[3] * scale,
        ]
    };
    let segments = arrow_segments_viewbox(direction);
    let half_stroke = (stroke_width_viewbox.max(0.0) * scale) * 0.5;
    ([to_local(segments[0]), to_local(segments[1]), to_local(segments[2])], half_stroke)
}

/// Focus effectif d'une région à `t` : sa position fixe, sauf en mode "auto" où elle suit la
/// télémétrie curseur (port de `getResolvedFocus`, sans le clamp — le crop-window de
/// `compositor.rs` clampe déjà après coup, cf. `su0.clamp(...)`, donc redondant ici).
fn resolve_focus(region: &SceneZoomRegion, t: f32, cursor: Option<&CursorTrack>) -> [f32; 2] {
    if region.focus_mode.as_deref() == Some("auto") {
        if let Some(track) = cursor {
            // `follow_at`, pas `at` : la caméra suit la piste LISSÉE. Suivre la télémétrie brute
            // donne un pan nerveux — l'étage de lissage de `cursorFollowUtils.ts` manquait au
            // portage.
            if let Some((cx, cy)) = track.follow_at(t) {
                return [cx, cy];
            }
        }
    }
    [region.focus_x, region.focus_y]
}

/// Paires de régions adjacentes assez proches pour être chaînées (port de
/// `getConnectedRegionPairs`, TS) : (index courant, index suivant, début transition, fin
/// transition), en secondes. Indices dans `regions` (pas d'id nécessaire — contrairement au
/// web qui matche par `region.id` car il travaille sur des objets isolés, ici tout vient du
/// même slice donc les positions suffisent).
fn connected_pairs(regions: &[SceneZoomRegion]) -> Vec<(usize, usize, f32, f32)> {
    let mut order: Vec<usize> = (0..regions.len()).collect();
    order.sort_by(|&a, &b| regions[a].start_sec.partial_cmp(&regions[b].start_sec).unwrap());
    let mut pairs = Vec::new();
    for w in order.windows(2) {
        let (ci, ni) = (w[0], w[1]);
        let gap = regions[ni].start_sec as f32 - regions[ci].end_sec as f32;
        if gap <= CHAINED_ZOOM_PAN_GAP_S {
            let transition_start = regions[ci].end_sec as f32;
            pairs.push((ci, ni, transition_start, transition_start + CONNECTED_ZOOM_PAN_DURATION_S));
        }
    }
    pairs
}

/// État de zoom au temps `t` (secondes source du clip actif). Port de
/// `findDominantRegion` (TS) : régions chaînées d'abord (transition puis
/// hold), sinon la région "dominante" indépendante la plus forte (ties → la plus récente).
/// Hors de toute région → identité (échelle 1, focus centre, tilt nul).
pub fn zoom_state_at(regions: &[SceneZoomRegion], t: f32, cursor: Option<&CursorTrack>) -> ZoomState {
    if regions.is_empty() {
        return IDENTITY_ZOOM;
    }
    let pairs = connected_pairs(regions);

    // 1) transition chaînée : pan lissé de la région courante vers la suivante.
    for &(ci, ni, t_start, t_end) in &pairs {
        if t < t_start || t > t_end {
            continue;
        }
        let progress = ease_connected_pan(clamp01((t - t_start) / (t_end - t_start).max(1e-3)));
        let (cur, next) = (&regions[ci], &regions[ni]);
        let cur_focus = resolve_focus(cur, t, cursor);
        let next_focus = resolve_focus(next, t, cursor);
        return ZoomState {
            scale: lerp(cur.scale, next.scale, progress),
            focus: [lerp(cur_focus[0], next_focus[0], progress), lerp(cur_focus[1], next_focus[1], progress)],
            rotation: lerp_rotation3d(rotation3d_for(&cur.rotation), rotation3d_for(&next.rotation), progress),
        };
    }

    // 2) palier chaîné : entre la fin de la transition et le début officiel de la région
    // suivante, celle-ci est déjà pleinement active (anticipe son propre ease-in).
    for &(_, ni, _, t_end) in &pairs {
        let next = &regions[ni];
        if t > t_end && t < next.start_sec as f32 {
            return ZoomState {
                scale: next.scale,
                focus: resolve_focus(next, t, cursor),
                rotation: rotation3d_for(&next.rotation),
            };
        }
    }

    // 3) région dominante indépendante — exclut celles déjà couvertes par une transition/palier
    // chaîné ci-dessus (sinon leur propre ease-in/out "percerait" à travers la fenêtre chaînée).
    let mut best: Option<(usize, f32)> = None;
    for (i, r) in regions.iter().enumerate() {
        let outgoing_past_end =
            pairs.iter().any(|&(ci, _, _, _)| ci == i && t > regions[i].end_sec as f32);
        let incoming_before_transition_end = pairs.iter().any(|&(_, ni, _, t_end)| ni == i && t < t_end);
        if outgoing_past_end || incoming_before_transition_end {
            continue;
        }
        let s = zoom_region_strength(r, t);
        if s <= 0.0 {
            continue;
        }
        let better = match best {
            None => true,
            Some((bi, bs)) => s > bs || (s == bs && r.start_sec > regions[bi].start_sec),
        };
        if better {
            best = Some((i, s));
        }
    }
    match best {
        Some((i, strength)) => {
            let r = &regions[i];
            let focus = resolve_focus(r, t, cursor);
            let scale = lerp(1.0, r.scale, strength);
            // La référence (`zoomTransform.ts`) fait converger le point de focus vers le centre
            // de l'écran LINÉAIREMENT : screen(f) = 0.5 + (f - 0.5)(1 - strength). Passer
            // `lerp(0.5, f, strength)` comme centre de crop ne donne pas ça — le crop mappant
            // screen(f) = 0.5 + (f - centre) * scale, on obtient
            // 0.5 + (f - 0.5)(1 - strength) * scale, soit un facteur en trop qui retient le point
            // loin du centre en milieu de rampe puis le rattrape. Ce balayage parasite se lit
            // comme si une région manuelle suivait le curseur. On inverse donc le mapping pour
            // trouver le centre qui produit la trajectoire de référence.
            let ease = |f: f32| f - (f - 0.5) * (1.0 - strength) / scale.max(1e-3);
            ZoomState {
                scale,
                focus: [ease(focus[0]), ease(focus[1])],
                rotation: lerp_rotation3d([0.0, 0.0, 0.0], rotation3d_for(&r.rotation), strength),
            }
        }
        None => IDENTITY_ZOOM,
    }
}

/// Port de `computeCameraFullscreenRegionStrength` (TS) : progrès EXACTEMENT contenu dans
/// [startSec, endSec] (contrairement au zoom, qui anticipe avant `startSec`) — ease-in depuis
/// 0 pile à `startSec`, plein régime, ease-out jusqu'à 0 pile à `endSec`. Fenêtres bornées à la
/// moitié de la durée de la région pour que les régions courtes s'animent pleinement sans
/// déborder.
fn camera_fullscreen_region_strength(region: &SceneCameraFullscreenRegion, t: f32) -> f32 {
    let start = region.start_sec as f32;
    let end = region.end_sec as f32;
    if t <= start || t >= end {
        return 0.0;
    }
    let half = (end - start) * 0.5;
    let lead_in = TRANSITION_WINDOW_S.min(half);
    let lead_out = FULLSCREEN_LEAD_OUT_WINDOW_S.min(half);
    let lead_in_end = start + lead_in;
    let lead_out_start = end - lead_out;
    if t < lead_in_end {
        let progress = if lead_in > 0.0 { (t - start) / lead_in } else { 1.0 };
        return ease_out_screen_studio(progress);
    }
    if t <= lead_out_start {
        return 1.0;
    }
    let progress = if lead_out > 0.0 { (end - t) / lead_out } else { 0.0 };
    ease_out_screen_studio(progress)
}

/// Progrès Full Camera (0..1) au temps `t` : 0 = webcam à sa taille normale, 1 = plein cadre.
/// Régions superposées (ne devrait pas arriver, gardé défensif comme le web) → la plus forte
/// gagne.
pub fn camera_fullscreen_progress_at(regions: &[SceneCameraFullscreenRegion], t: f32) -> f32 {
    let mut strongest = 0.0f32;
    for r in regions {
        let s = camera_fullscreen_region_strength(r, t);
        if s > strongest {
            strongest = s;
        }
    }
    strongest
}

// ============ Rotation 3D (tilt perspective, présets iso/left/right) ================
// Port de `computeRotation3DContainScale` (TS, `types.ts`) — même formule, même ordre de
// composition ("CSS rotateX rotateY rotateZ s'applique droite-à-gauche : Z d'abord, puis Y,
// puis X"). `compositor.rs` s'en sert pour construire le quad tilté (4 coins projetés) rendu
// via un warp bilinéaire inverse en pixel shader (mode 8) — ce module ne fait que la géométrie.

/// `true` si la rotation est (quasi) neutre — mêmes seuils que `isRotation3DIdentity` (TS).
pub fn is_identity_rotation(r: [f32; 3]) -> bool {
    r[0].abs() < 0.01 && r[1].abs() < 0.01 && r[2].abs() < 0.01
}

/// Projette un point local (x0,y0,0) par la rotation 3D `rot` (degrés X/Y/Z) puis la
/// perspective `perspective` (distance en px ; <=0 = orthographique). `None` si le point
/// passe derrière le plan de projection (cas pathologique, comme le `return 1` du TS).
fn project_corner(x0: f32, y0: f32, rot: [f32; 3], perspective: f32) -> Option<(f32, f32)> {
    let (a, b, g) = (rot[0].to_radians(), rot[1].to_radians(), rot[2].to_radians());
    let (ca, sa) = (a.cos(), a.sin());
    let (cb, sb) = (b.cos(), b.sin());
    let (cg, sg) = (g.cos(), g.sin());
    let (mut px, mut py, mut pz) = (x0, y0, 0.0f32);
    // rotateZ
    let (zx, zy) = (px * cg - py * sg, px * sg + py * cg);
    px = zx;
    py = zy;
    // rotateY
    let (yx, yz) = (px * cb + pz * sb, -px * sb + pz * cb);
    px = yx;
    pz = yz;
    // rotateX
    let (xy, xz) = (py * ca - pz * sa, py * sa + pz * ca);
    py = xy;
    pz = xz;
    if perspective > 0.0 {
        let denom = perspective - pz;
        if denom <= 0.0 {
            return None;
        }
        let f = perspective / denom;
        px *= f;
        py *= f;
    }
    Some((px, py))
}

/// Échelle uniforme max qui garde les 4 coins projetés dans le rect d'origine (port direct,
/// même formule que `computeRotation3DContainScale`).
fn contain_scale(rot: [f32; 3], width: f32, height: f32, perspective: f32) -> f32 {
    let (half_w, half_h) = (width * 0.5, height * 0.5);
    let corners = [(-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)];
    let (mut max_abs_x, mut max_abs_y) = (0.0f32, 0.0f32);
    for &(x0, y0) in &corners {
        match project_corner(x0, y0, rot, perspective) {
            Some((px, py)) => {
                max_abs_x = max_abs_x.max(px.abs());
                max_abs_y = max_abs_y.max(py.abs());
            }
            None => return 1.0,
        }
    }
    if max_abs_x == 0.0 || max_abs_y == 0.0 {
        return 1.0;
    }
    (half_w / max_abs_x).min(half_h / max_abs_y).min(1.0)
}

/// Les 4 coins (TL, TR, BR, BL) du quad tilté en 3D, en px relatifs au CENTRE du rect d'origine
/// (0,0 = centre — l'appelant les recentre sur le centre réel à l'écran). `width`/`height` en
/// px = la taille du rect d'origine, aussi utilisée comme référence de perspective (comme le
/// web : la perspective/le containScale sont calculés sur la taille de l'élément lui-même).
pub fn rotated_quad_corners_px(width: f32, height: f32, rot: [f32; 3]) -> [(f32, f32); 4] {
    const PERSPECTIVE_FACTOR: f32 = 2.6; // ROTATION_3D_PERSPECTIVE_FACTOR (TS)
    let perspective = width.min(height) * PERSPECTIVE_FACTOR;
    let scale = contain_scale(rot, width, height, perspective);
    let (half_w, half_h) = (width * 0.5 * scale, height * 0.5 * scale);
    let corners = [(-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)];
    let mut out = [(0.0f32, 0.0f32); 4];
    for (i, &(x0, y0)) in corners.iter().enumerate() {
        out[i] = project_corner(x0, y0, rot, perspective).unwrap_or((x0, y0));
    }
    out
}

#[cfg(test)]
mod zoom_focus_tests {
    use super::*;
    use crate::scene::SceneZoomRegion;

    fn region(scale: f32, focus_x: f32) -> SceneZoomRegion {
        SceneZoomRegion {
            id: "z1".into(),
            clip_index: None,
            start_sec: 2.0,
            end_sec: 8.0,
            scale,
            focus_x,
            focus_y: 0.5,
            focus_mode: Some("manual".into()),
            rotation: None,
        }
    }

    /// Où le point source `f` atterrit à l'écran (0..1) : le crop est centré sur `focus` et
    /// couvre `1/scale` de la source, donc l'écran mappe `0.5 + (f - focus) * scale`.
    fn screen_x(state: &ZoomState, f: f32) -> f32 {
        0.5 + (f - state.focus[0]) * state.scale
    }

    #[test]
    fn manual_focus_travels_to_centre_linearly_during_the_ramp() {
        // L'invariant de `zoomTransform.ts` : screen(f) = 0.5 + (f - 0.5)(1 - progress). La
        // régression corrigée ici ajoutait un facteur `scale`, qui retenait le point loin du
        // centre en milieu de rampe puis le rattrapait — lu comme un pan parasite sur une région
        // pourtant en mode manuel.
        let f = 0.8;
        let target_scale = 2.5;
        let regions = [region(target_scale, f)];
        // Plusieurs instants de la fenêtre d'ease-in, pour balayer les progressions partielles.
        for step in 0..=20 {
            let t = 1.0 + step as f32 * 0.15;
            let state = zoom_state_at(&regions, t, None);
            // `progress` déduit du scale rendu, pour ne pas ré-implémenter l'easing dans le test.
            let progress = (state.scale - 1.0) / (target_scale - 1.0);
            let expected = 0.5 + (f - 0.5) * (1.0 - progress);
            assert!(
                (screen_x(&state, f) - expected).abs() < 1e-4,
                "t={t} progress={progress} screen={} attendu={expected}",
                screen_x(&state, f)
            );
        }
    }

    #[test]
    fn manual_focus_is_dead_centre_at_full_strength() {
        let f = 0.8;
        let regions = [region(2.5, f)];
        let state = zoom_state_at(&regions, 5.0, None);
        assert!((state.scale - 2.5).abs() < 1e-4, "plein régime attendu, scale={}", state.scale);
        assert!((screen_x(&state, f) - 0.5).abs() < 1e-4);
        assert!((state.focus[0] - f).abs() < 1e-4);
    }

    #[test]
    fn outside_every_region_the_frame_is_untouched() {
        let regions = [region(2.5, 0.8)];
        let state = zoom_state_at(&regions, 0.0, None);
        assert_eq!(state.scale, 1.0);
        assert_eq!(state.focus, [0.5, 0.5]);
    }
}

#[cfg(test)]
mod arrow_tests {
    use super::*;

    #[test]
    fn a_diagonal_head_is_as_large_as_a_cardinal_one() {
        // Les barbes diagonales faisaient 15,8 unités contre 21,2 pour les cardinales : une
        // flèche en diagonale avait une tête ~25 % plus petite que sa voisine horizontale, ce
        // qui se lisait comme une déformation. Ce test interdit la divergence de revenir.
        let barb_len = |seg: [f32; 4]| ((seg[2] - seg[0]).powi(2) + (seg[3] - seg[1]).powi(2)).sqrt();
        let cardinal = barb_len(arrow_segments_viewbox("up")[1]);
        for dir in ["up-right", "up-left", "down-right", "down-left"] {
            for barb in 1..=2 {
                let len = barb_len(arrow_segments_viewbox(dir)[barb]);
                assert!(
                    (len - cardinal).abs() < 0.2,
                    "{dir} barbe {barb} = {len:.2}, cardinale = {cardinal:.2}"
                );
            }
        }
    }

    #[test]
    fn the_geometry_is_the_svg_geometry_verbatim() {
        // Parité avec `ArrowSvgs.tsx` : si ces nombres divergent, le rendu et la preview
        // dessinent deux flèches différentes.
        assert_eq!(
            arrow_segments_viewbox("right"),
            [[20.0, 50.0, 80.0, 50.0], [80.0, 50.0, 65.0, 35.0], [80.0, 50.0, 65.0, 65.0]]
        );
        assert_eq!(
            arrow_segments_viewbox("up"),
            [[50.0, 20.0, 50.0, 80.0], [50.0, 20.0, 35.0, 35.0], [50.0, 20.0, 65.0, 35.0]]
        );
    }

    #[test]
    fn an_unknown_direction_falls_back_to_right() {
        // Même défaut que le schéma côté app, pour qu'une donnée abîmée dessine quelque chose
        // de sensé plutôt que rien.
        assert_eq!(arrow_segments_viewbox("sideways"), arrow_segments_viewbox("right"));
    }

    #[test]
    fn a_square_quad_maps_the_viewbox_one_to_one() {
        let (segments, half) = arrow_local_geometry("right", 10.0, [100.0, 100.0]);
        // échelle 1, aucun centrage à appliquer
        assert_eq!(segments[0], [20.0, 50.0, 80.0, 50.0]);
        assert!((half - 5.0).abs() < 1e-6);
    }

    #[test]
    fn a_wide_quad_scales_uniformly_and_centres() {
        // `preserveAspectRatio` vaut `xMidYMid meet` par défaut : la flèche tient dans le PLUS
        // PETIT côté et se centre — elle n'est jamais étirée. Ici 400x200 -> échelle 2, et
        // 200px de marge horizontale à répartir, donc +100 sur les x.
        let (segments, half) = arrow_local_geometry("right", 4.0, [400.0, 200.0]);
        assert_eq!(segments[0], [100.0 + 40.0, 100.0, 100.0 + 160.0, 100.0]);
        // l'épaisseur suit la même échelle uniforme
        assert!((half - 4.0).abs() < 1e-6);
    }

    #[test]
    fn a_tall_quad_centres_vertically() {
        let (segments, _) = arrow_local_geometry("up", 4.0, [100.0, 300.0]);
        // échelle 1 (plus petit côté = 100), 200px de marge verticale -> +100 sur les y
        assert_eq!(segments[0], [50.0, 100.0 + 20.0, 50.0, 100.0 + 80.0]);
    }

    #[test]
    fn a_negative_stroke_width_cannot_produce_a_negative_half_width() {
        let (_, half) = arrow_local_geometry("right", -5.0, [100.0, 100.0]);
        assert_eq!(half, 0.0);
    }
}
