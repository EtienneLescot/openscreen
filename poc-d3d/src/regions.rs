//! Zoom regions + camera-fullscreen regions — port des enveloppes ease-in/hold/ease-out du
//! web (`zoomRegionUtils.ts` / `cameraFullscreenUtils.ts`) vers le natif, pour que le timing
//! des transitions soit identique en preview ET en export. Inclut le "connected zoom pan"
//! (chaînage lissé entre deux régions rapprochées), le focus "auto" (suivi de la télémétrie
//! curseur) et la rotation 3D (présets iso/left/right, cf. `compositor.rs` pour le rendu du
//! tilt perspective — ce module ne fait que le calcul temporel, pas le rendu GPU).

use crate::cursor::CursorTrack;
use crate::scene::{SceneCameraFullscreenRegion, SceneZoomRegion};

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
/// `endSec`. `playbackRate` toujours 1 côté natif (pas de speed regions dans l'export natif).
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

/// Focus effectif d'une région à `t` : sa position fixe, sauf en mode "auto" où elle suit la
/// télémétrie curseur (port de `getResolvedFocus`, sans le clamp — le crop-window de
/// `compositor.rs` clampe déjà après coup, cf. `su0.clamp(...)`, donc redondant ici).
fn resolve_focus(region: &SceneZoomRegion, t: f32, cursor: Option<&CursorTrack>) -> [f32; 2] {
    if region.focus_mode.as_deref() == Some("auto") {
        if let Some(track) = cursor {
            if let Some((cx, cy)) = track.at(t) {
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

/// État de zoom au temps `t` (secondes, référentiel TIMELINE — pas le temps source d'un clip
/// individuel). Port de `findDominantRegion` (TS) : régions chaînées d'abord (transition puis
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
            ZoomState {
                scale: lerp(1.0, r.scale, strength),
                focus: [lerp(0.5, focus[0], strength), lerp(0.5, focus[1], strength)],
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
