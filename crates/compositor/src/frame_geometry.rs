//! La géométrie de composition, sans backend.
//!
//! Tout ce qui décide OÙ va un calque et de quoi il a l'air — placements de preset,
//! coupe source, cover-fit, rayons, ombres, timeline de la fixture, parsing des
//! couleurs CSS — par opposition à ce qui l'envoie au GPU. Rien ici ne connaît
//! D3D11 ni Metal, et le module est donc compilé sur les deux plateformes
//! (`pub mod frame_geometry;` sans `cfg`, comme `regions.rs` juste à côté).
//!
//! # Pourquoi ce module existe
//!
//! Ce code vivait dans `compositor_windows.rs`. Le port macOS a besoin des mêmes
//! placements au pixel près — c'est la propriété « iso-render » que le projet
//! mesure — et la seule façon de garantir que deux backends s'accordent est qu'ils
//! lisent la même fonction, pas qu'ils entretiennent deux copies qui doivent rester
//! d'accord. C'est le même raisonnement que `timeline_walk.rs`.
//!
//! Effet de bord immédiat : cette géométrie et ses tests, qui n'avaient jamais été
//! exécutés ailleurs que sur Windows, tournent maintenant aussi dans le job macOS.

// Sur macOS, la moitié de ce module est encore sans consommateur : le moteur Metal
// n'a pas de `compose_frame` en couches, donc rien n'appelle encore `screen_source_rect`,
// `cover_uv_rect`, les fractions d'ombre ou `CursorPlacement`. Ce n'est PAS du code mort —
// c'est du code que le port n'a pas encore atteint, et il est exercé par ses tests sur les
// deux plateformes. Le `allow` saute quand le pilotage des couches arrive côté Metal.
#![allow(dead_code)]

use crate::config::Cfg;
use crate::scene::{Scene, SceneCrop};

/// Constant buffer d'un calque : **128 octets**, un par draw.
///
/// C'est le contrat partagé par les trois côtés — `cbuffer Layer` dans `shaders.hlsl`,
/// `struct Layer` dans `shaders.metal`, et ce struct. Les trois doivent s'accorder champ
/// pour champ ET octet pour octet : un décalage ne produit pas d'erreur, il produit un
/// shader qui lit `color` là où on a écrit `fx`.
///
/// `align(16)` vient de la version macOS ; sous `repr(C)` seul, les offsets sont déjà
/// 0/16/32/40/44/48/64/80/96/112 des deux côtés — l'alignement Rust ne change que
/// l'adresse du struct, pas son contenu, et Windows le `copy_nonoverlapping` dans un
/// constant buffer mappé où l'alignement source est sans effet. Les deux formes étaient
/// donc compatibles ; les unifier évite qu'elles cessent de l'être.
///
/// (Le commentaire d'origine annonçait « 64 octets ». Il n'a jamais été juste : dix champs,
/// trente-deux `f32`.)
#[repr(C, align(16))]
#[derive(Clone, Copy, Default)]
pub struct LayerCB {
    pub dst: [f32; 4],
    pub src: [f32; 4],
    pub quad_px: [f32; 2],
    pub radius_px: f32,
    pub mode: f32,
    pub color: [f32; 4],
    pub fx: [f32; 4],
    pub src_prev: [f32; 4],
    pub dst_prev: [f32; 4],
    pub mb: [f32; 4], // mb[0] = nombre de taps de motion blur
}

pub const OUT_W: u32 = 1920;
pub const OUT_H: u32 = 1080;
/// Parse une couleur "#rgb" / "#rrggbb" (sRGB, comme les wallpapers web) → [r,g,b,a] 0..1.
/// Les couleurs plates suivent le même chemin que `bg_color` (pas de linéarisation).
/// Décode une data URL base64 (`data:image/png;base64,AAAA…`) en octets. `None` si ce n'en est
/// pas une — l'appelant retombe alors sur une lecture disque.
///
/// Écrit à la main plutôt qu'avec une dépendance : c'est le seul usage de base64 du projet, et le
/// décodeur tient en quinze lignes vérifiables. Les caractères hors alphabet (retours à la ligne
/// d'un URI replié, `=` de padding) sont ignorés, ce qui rend la fonction tolérante sans être
/// laxiste : un caractère invalide ne peut pas décaler le flux, il est simplement absent.
pub(crate) fn decode_data_uri(uri: &str) -> Option<Vec<u8>> {
    let rest = uri.strip_prefix("data:")?;
    let comma = rest.find(',')?;
    if !rest[..comma].contains("base64") {
        return None;
    }
    let payload = &rest[comma + 1..];
    let sextet = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(payload.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for byte in payload.bytes() {
        let Some(v) = sextet(byte) else { continue };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}
pub(crate) fn parse_hex(s: &str) -> Option<[f32; 4]> {
    // Le contrat accepte du CSS, pas seulement de l'hex : la bridge des captions produit du
    // `rgba(r, g, b, a)` (l'inspector stocke couleur + opacité séparément, et `captionBackgroundCss`
    // les recombine en rgba pour la preview) et les stops de gradient arrivent aussi sous cette
    // forme. `transparent` est un cas particulier documenté : alpha 0, pas de plaque. Tout le
    // reste tombe sur None → l'appelant applique son fallback (alpha 0 pour un fond, alpha 1
    // pour un texte, etc.) — la même sémantique qu'avant l'ajout du parseur rgba.
    let trimmed = s.trim();
    if trimmed.eq_ignore_ascii_case("transparent") {
        return Some([0.0, 0.0, 0.0, 0.0]);
    }
    // CSS Color 4 fait de `rgb()` et `rgba()` des synonymes : les deux acceptent 3 ou 4
    // composantes. On les traite donc par le même chemin plutôt que d'imposer une arité par
    // nom — refuser `rgba(0, 0, 0)` ne « signalerait » rien d'utile, ça retomberait sur le
    // fallback de l'appelant, c'est-à-dire une plaque invisible : exactement le bug #178.
    if let Some(inner) =
        strip_color_fn(trimmed, "rgba").or_else(|| strip_color_fn(trimmed, "rgb"))
    {
        return parse_rgb_components(inner);
    }
    let h = trimmed.trim_start_matches('#');
    // Un corps hex est ASCII par définition, et les découpes par octet ci-dessous (`h[i..=i]`,
    // `h[0..2]`…) paniqueraient au milieu d'un caractère multi-octets qui ferait pile 3 ou 6
    // octets (`éa`, `€€`). On refuse avant de découper.
    if !h.is_ascii() {
        return None;
    }
    let (r, g, b) = match h.len() {
        3 => {
            let d = |i: usize| u8::from_str_radix(&h[i..=i], 16).ok().map(|v| v * 17);
            (d(0)?, d(1)?, d(2)?)
        }
        6 => (
            u8::from_str_radix(&h[0..2], 16).ok()?,
            u8::from_str_radix(&h[2..4], 16).ok()?,
            u8::from_str_radix(&h[4..6], 16).ok()?,
        ),
        _ => return None,
    };
    Some([r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0])
}
/// `rgba(0, 0, 0, 0.55)` → `"0, 0, 0, 0.55"` (le contenu entre les parenthèses), None si
/// l'enveloppe n'est pas de la forme `fn(...)`. Tolère les espaces et les tabs, refuse les
/// virgules finales et les arguments vides — le gradient parser a déjà démontré que la couche
/// application produit des chaînes propres, donc rester strict ici évite d'avaler des CSS
/// tordus qu'on ne maîtrise pas. La casse du préfixe est libre (`RGBA(...)` est valide) parce
/// que CSS le permet.
pub(crate) fn strip_color_fn<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    // `get` rend None si `name.len()` n'est pas une frontière de caractère : c'est ce qui rend
    // le slice `s[..name.len()]` juste en dessous sûr par construction. Un `&s[..n]` direct
    // paniquerait au milieu d'un caractère multi-octets (`#ab€cd` coupe dans le `€`), et une
    // panique traverserait le pont N-API au lieu de retomber sur le fallback de l'appelant —
    // le contraire de ce que ce parseur promet.
    let after_name = s.get(name.len()..)?;
    if !s[..name.len()].eq_ignore_ascii_case(name) {
        return None;
    }
    let inner = after_name.strip_prefix('(')?.strip_suffix(')')?.trim();
    if inner.is_empty() {
        return None;
    }
    Some(inner)
}
/// `"r, g, b"` ou `"r, g, b, a"` (floats 0..255 pour r/g/b, 0..1 pour a) → `[r, g, b, a]` en
/// 0..1, l'alpha valant 1 (opaque) quand elle est absente. Toute autre arité → None. Tolère
/// les espaces autour des virgules, pas les pourcentages : le gradient parser n'envoie pas de
/// `rgb(50%, …)` et les couches UI qui le font n'arrivent pas ici (les couleurs wallpaper
/// passent par une autre route, cf. `parseWallpaper`).
pub(crate) fn parse_rgb_components(s: &str) -> Option<[f32; 4]> {
    let parts: Vec<&str> = s.split(',').map(str::trim).collect();
    let (rgb, alpha) = match parts.as_slice() {
        [r, g, b] => ([r, g, b], 1.0),
        // L'alpha est déjà sur [0..1] par convention (`rgba(...,0.55)`, pas `rgba(...,55)`).
        [r, g, b, a] => ([r, g, b], parse_color_channel(a, 1.0)?),
        _ => return None,
    };
    Some([
        parse_color_channel(rgb[0], 255.0)?,
        parse_color_channel(rgb[1], 255.0)?,
        parse_color_channel(rgb[2], 255.0)?,
        alpha,
    ])
}
pub(crate) fn parse_color_channel(raw: &str, max: f32) -> Option<f32> {
    let n: f32 = raw.parse().ok()?;
    if !n.is_finite() || n < 0.0 || n > max {
        return None;
    }
    Some(n / max)
}
/// Rect source après crop puis zoom, dans les UV de la texture D3D. `u_max`/`v_max`
/// excluent le padding NV12 ; le crop reste donc exprimé dans le frame visible (0..1),
/// comme `VirtualPreview.cropVideoStyle`, puis le focus du zoom est remappé dans ce crop.
pub(crate) fn screen_source_rect(
    u_max: f32,
    v_max: f32,
    crop: Option<SceneCrop>,
    zoom: f32,
    focus: [f32; 2],
) -> [f32; 4] {
    let normalized_crop = crop.and_then(|crop| {
        if !crop.x.is_finite() || !crop.y.is_finite()
            || !crop.width.is_finite() || !crop.height.is_finite()
        {
            return None;
        }
        let x0 = crop.x.clamp(0.0, 1.0);
        let y0 = crop.y.clamp(0.0, 1.0);
        let x1 = (crop.x + crop.width).clamp(x0, 1.0);
        let y1 = (crop.y + crop.height).clamp(y0, 1.0);
        (x1 > x0 && y1 > y0).then_some([x0, y0, x1, y1])
    });
    let [x0, y0, x1, y1] = normalized_crop.unwrap_or([0.0, 0.0, 1.0, 1.0]);
    let (cu0, cv0, cu1, cv1) = (x0 * u_max, y0 * v_max, x1 * u_max, y1 * v_max);
    let (cw, ch) = (cu1 - cu0, cv1 - cv0);
    let zoom = if zoom.is_finite() && zoom >= 1.0 { zoom } else { 1.0 };
    let fx = if focus[0].is_finite() { focus[0].clamp(0.0, 1.0) } else { 0.5 };
    let fy = if focus[1].is_finite() { focus[1].clamp(0.0, 1.0) } else { 0.5 };
    let (hu, hv) = (cw / (2.0 * zoom), ch / (2.0 * zoom));
    // `.max(cu0/cv0)` absorbs the tiny float inversion possible at zoom=1.
    let su0 = (cu0 + fx * cw - hu).clamp(cu0, (cu1 - 2.0 * hu).max(cu0));
    let sv0 = (cv0 + fy * ch - hv).clamp(cv0, (cv1 - 2.0 * hv).max(cv0));
    [su0, sv0, su0 + 2.0 * hu, sv0 + 2.0 * hv]
}
/// Rect DESTINATION de l'écran quand on dessine une coupe source PLUS LARGE que celle qui
/// remplissait la boîte — le cœur du correctif #179.
///
/// Le zoom natif se jouait entièrement dans la coupe source (`screen_source_rect` rétrécit
/// la coupe autour du focus) pendant que la boîte, elle, ne bougeait pas : le zoom
/// s'arrêtait donc à la frontière paddée au lieu d'atteindre les bords du cadre. La
/// référence fait l'inverse — `applyZoomTransform` (TS) met à l'échelle et translate le
/// CONTENEUR CAMÉRA, masque compris, donc la boîte paddée grandit avec le zoom, sort de
/// l'étage, et le padding s'efface.
///
/// On rend donc le zoom à la boîte : la coupe dessinée redevient le simple crop
/// (`cut`, zoom 1) et c'est la boîte qui porte le grossissement. `cut_ref` est la coupe
/// d'AVANT (zoom entier, celle qui remplissait `base`) et sert de référence : on reporte
/// `cut` à travers le mapping `cut_ref → base`.
///
/// C'est ce report qui fait toute la sûreté du correctif. Le mapping image→écran est
/// conservé PAR CONSTRUCTION — même grossissement, même cadrage, même point de focus au
/// même pixel — quel que soit le crop, le clamp de bord ou le `cover`, puisque tout cela
/// est déjà cuit dans les deux coupes. Seule l'ÉTENDUE dessinée grandit, et c'est
/// exactement elle qui déborde le padding. Tout ce qui roule sur ce mapping (curseur,
/// tilt 3D, motion blur) est donc inchangé.
///
/// Pas de clamp dans le cadre : la boîte doit pouvoir en sortir (« No stage clamping »,
/// `frameRenderer.cameraAwareMaskRect`) — le rasterizer coupe ce qui dépasse, comme il le
/// fait déjà pour le fond flouté.
pub(crate) fn remap_box(base: [f32; 4], cut_ref: [f32; 4], cut: [f32; 4]) -> [f32; 4] {
    let (rw, rh) = ((cut_ref[2] - cut_ref[0]), (cut_ref[3] - cut_ref[1]));
    if !(rw > 1e-6 && rh > 1e-6) {
        return base;
    }
    [
        base[0] + base[2] * (cut[0] - cut_ref[0]) / rw,
        base[1] + base[3] * (cut[1] - cut_ref[1]) / rh,
        base[2] * (cut[2] - cut[0]) / rw,
        base[3] * (cut[3] - cut[1]) / rh,
    ]
}
/// Sous-rect SOURCE (en UV de texture) qui remplit une boîte de ratio `box_ar` **sans
/// déformer** l'image : le plus grand rect centré ayant ce ratio, tiré de la frame
/// visible — l'équivalent de `object-fit: cover` côté web.
///
/// C'est LA primitive qui garantit qu'une couche vidéo n'est jamais étirée. Le
/// contrat est déplacé de l'appelant (« donne-moi un dst au ratio de la source »,
/// hypothèse qu'un preset pouvait violer en silence) vers le calcul lui-même
/// (« quel que soit le dst, je choisis la coupe qui l'habille »).
///
/// * `visible` : dimensions RÉELLES de l'image dans la texture (`AVFrame::width/height`) ;
///   elles peuvent être plus petites que la texture, qui est allouée avec du padding
///   décodeur — d'où la division finale par `tex`.
/// * `tex` : dimensions de la texture, pour normaliser en UV.
/// * `box_ar` : ratio largeur/hauteur de la boîte de destination, en pixels de rendu.
///
/// Retourne `(u0, v0, u1, v1)`. Quand la boîte a déjà le ratio de la source, la coupe
/// est la frame entière — donc aucun changement de pixel sur les placements qui étaient
/// déjà corrects.
pub(crate) fn cover_crop_uv(visible: [f32; 2], tex: [f32; 2], box_ar: f32) -> (f32, f32, f32, f32) {
    let (cam_w, cam_h) = (visible[0].max(1.0), visible[1].max(1.0));
    let (tex_w, tex_h) = (tex[0].max(1.0), tex[1].max(1.0));
    let full = [0.0, 0.0, cam_w / tex_w, cam_h / tex_h];
    let [u0, v0, u1, v1] = cover_uv_rect(full, tex, box_ar);
    (u0, v0, u1, v1)
}

/// Camera equivalent of the screen crop pipeline: apply the user crop first, then a centred
/// cover-crop inside that authored window so arbitrary layout slots never stretch the image.
pub(crate) fn webcam_source_rect(
    visible: [f32; 2],
    tex: [f32; 2],
    crop: Option<SceneCrop>,
    box_ar: f32,
) -> [f32; 4] {
    let u_max = visible[0].max(1.0) / tex[0].max(1.0);
    let v_max = visible[1].max(1.0) / tex[1].max(1.0);
    cover_uv_rect(
        screen_source_rect(u_max, v_max, crop, 1.0, [0.5, 0.5]),
        tex,
        box_ar,
    )
}
/// Rétrécit un rect SOURCE déjà exprimé en UV (`[u0, v0, u1, v1]`) autour de son
/// centre pour qu'il porte le ratio `box_ar` une fois rapporté aux pixels de la
/// texture. C'est la forme générale de `object-fit: cover`, et LA primitive qui
/// garantit qu'une couche vidéo n'est jamais étirée.
///
/// Deux appelants, deux points d'entrée dans le rect :
///   - la **webcam** part de la frame visible entière (`cover_crop_uv`) ;
///   - l'**écran** part du rect déjà réduit par le crop utilisateur ET le zoom,
///     et n'applique ce cover que dans les layouts qui le demandent
///     (`Scene.layout.screen_cover` — les blocs side-by-side / top-bottom, où le
///     web fait exactement la même chose via `screenCover`).
///
/// Rogner APRÈS le crop et le zoom est ce qui rend l'opération composable : le
/// crop décide quoi montrer, le zoom où regarder, le cover comment habiller la
/// boîte. Chacun réduit le rect précédent, jamais ne le déforme.
///
/// Quand le rect a déjà le ratio de la boîte, il est renvoyé inchangé — donc
/// aucun placement déjà correct ne bouge.
pub(crate) fn cover_uv_rect(uv: [f32; 4], tex: [f32; 2], box_ar: f32) -> [f32; 4] {
    let (tex_w, tex_h) = (tex[0].max(1.0), tex[1].max(1.0));
    let (w_uv, h_uv) = ((uv[2] - uv[0]).max(1e-6), (uv[3] - uv[1]).max(1e-6));
    // ratio du rect courant, en PIXELS (les UV sont anisotropes dès que la
    // texture n'est pas carrée — d'où le passage par `tex`).
    let (w_px, h_px) = (w_uv * tex_w, h_uv * tex_h);
    let cur_ar = w_px / h_px;
    let box_ar = if box_ar.is_finite() && box_ar > 0.0 { box_ar } else { cur_ar };
    let (new_w_px, new_h_px) = if box_ar >= cur_ar {
        (w_px, w_px / box_ar) // boîte plus large → pleine largeur, on rogne en hauteur
    } else {
        (h_px * box_ar, h_px) // boîte plus haute → pleine hauteur, on rogne en largeur
    };
    let (new_w, new_h) = (new_w_px / tex_w, new_h_px / tex_h);
    let (cx, cy) = (uv[0] + w_uv * 0.5, uv[1] + h_uv * 0.5);
    [cx - new_w * 0.5, cy - new_h * 0.5, cx + new_w * 0.5, cy + new_h * 0.5]
}
pub const HALF_W: u32 = OUT_W / 2;
pub const HALF_H: u32 = OUT_H / 2;
pub const FIXTURE_FRAMES: u32 = 360;
pub(crate) const FPS: f32 = 60.0;
/// Longueurs de style exprimées en FRACTION du petit côté du cadre, et non en pixels.
///
/// Elles étaient écrites en px bruts au point d'appel, ce qui voulait dire « px du render
/// target » — donc une proportion DIFFÉRENTE selon la taille de rendu : 40 px, c'est 3,7 % d'un
/// cadre 1080 mais 1,9 % d'un 2160. L'ombre était donc deux fois plus douce en preview qu'à
/// l'export, et un export 4K la recevait deux fois plus faible qu'un 1080p — même famille de bug
/// que les rayons venus de l'app, mais née à l'intérieur du natif. Les valeurs ci-dessous sont
/// les anciennes constantes rapportées au cadre 1080 contre lequel elles avaient été réglées :
/// le rendu à cette résolution est donc inchangé, et devient enfin identique partout ailleurs.
pub(crate) const SHADOW_TUNING_REF_PX: f32 = 1080.0;
pub(crate) const SCREEN_SHADOW_SPREAD_FRAC: f32 = 40.0 / SHADOW_TUNING_REF_PX;
pub(crate) const SCREEN_SHADOW_OFFSET_FRAC: f32 = 16.0 / SHADOW_TUNING_REF_PX;
pub(crate) const WEBCAM_SHADOW_SPREAD_FRAC: f32 = 32.0 / SHADOW_TUNING_REF_PX;
pub(crate) const WEBCAM_SHADOW_OFFSET_FRAC: f32 = 12.0 / SHADOW_TUNING_REF_PX;
/// Opacité FIXE de l'ombre portée de la caméra (layout PiP uniquement). Contrairement à
/// l'ombre de l'écran — dont l'opacité est pilotée par le slider Shadow (`shadow_scale`) —
/// l'ombre de la caméra est une ombre légère NON paramétrable : même valeur quelle que soit
/// la position du slider. Parité avec le preset PiP côté web (`compositeLayout.ts`,
/// `rgba(0,0,0,0.35)`), dont l'ombre est elle aussi un forfait fixe et PiP-only.
pub(crate) const WEBCAM_SHADOW_OPACITY: f32 = 0.35;
/// Taille de base du curseur, même convention (34 px réglés contre un cadre 1080).
pub(crate) const CURSOR_BASE_SIZE_FRAC: f32 = 34.0 / SHADOW_TUNING_REF_PX;
/// Rect [x,y,w,h] normalisé d'un sprite de curseur de taille `w`×`h` dont le pivot `hotspot`
/// (fraction 0..1 de l'image) doit tomber exactement sur `center`.
///
/// L'invariant est que `center` reste sur le pixel désigné QUELLE QUE SOIT la taille : le
/// décalage grandit avec le sprite, donc il doit être une fraction de `w`/`h` et pas une
/// constante. Un pivot centré en dur (0.5) laissait la pointe dériver de plus en plus loin de
/// la zone visée à mesure qu'on agrandissait le curseur.
pub(crate) fn cursor_sprite_dst(center: [f32; 2], w: f32, h: f32, hotspot: [f32; 2]) -> [f32; 4] {
    [center[0] - w * hotspot[0], center[1] - h * hotspot[1], w, h]
}
/// Où poser le curseur, et dans quel repère.
///
/// Le curseur remplace un pointeur qui faisait partie de l'image capturée, donc il vit SUR la
/// surface de l'écran, pas dans un calque au-dessus. Quand cet écran est incliné en 3D, ce n'est
/// donc pas seulement sa position qu'il faut projeter mais son sprite entier : autrement il se
/// lit comme un autocollant plat posé sur une scène en perspective.
#[derive(Clone, Copy)]
pub(crate) enum CursorPlacement {
    /// Écran droit : centre en coordonnées sortie 0..1.
    Upright { center: [f32; 2] },
    /// Écran incliné : position 0..1 DANS le plan, plus de quoi projeter les coins du sprite.
    Tilted {
        /// Position du pivot dans le plan (0..1 depuis son coin haut-gauche).
        plane_pt: [f32; 2],
        quad: crate::regions::TiltedQuad,
        /// Centre du plan en px sortie — `quad.corners` y est relatif.
        center_px: [f32; 2],
        /// Taille du rect d'écran NON incliné en px : l'unité dans laquelle la taille du
        /// curseur est exprimée, et donc ce qui la convertit en fraction du plan.
        screen_px: [f32; 2],
        /// Taille de la cible de rendu en px, pour repasser des px aux 0..1 de la sortie.
        render_px: [f32; 2],
    },
}
impl CursorPlacement {
    /// Interpolation entre deux placements, pour les copies de la traînée de flou. Sur un plan
    /// incliné on interpole DANS le plan : la traînée suit alors la surface au lieu de couper
    /// droit à travers la perspective.
    pub(crate) fn lerp(self, other: CursorPlacement, f: f32) -> CursorPlacement {
        match (self, other) {
            (
                CursorPlacement::Tilted { plane_pt: a, quad, center_px, screen_px, render_px },
                CursorPlacement::Tilted { plane_pt: b, .. },
            ) => CursorPlacement::Tilted {
                plane_pt: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
                quad,
                center_px,
                screen_px,
                render_px,
            },
            (a, b) => {
                let (p, q) = (a.upright_center(), b.upright_center());
                CursorPlacement::Upright {
                    center: [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f],
                }
            }
        }
    }

    /// Le centre en coordonnées sortie, quel que soit le repère — ce dont ont besoin le curseur
    /// math de secours et le calcul de vélocité.
    pub(crate) fn upright_center(self) -> [f32; 2] {
        match self {
            CursorPlacement::Upright { center } => center,
            CursorPlacement::Tilted { plane_pt, quad, center_px, render_px, .. } => {
                let (px, py) = quad.point_px(plane_pt[0], plane_pt[1]);
                [(center_px[0] + px) / render_px[0], (center_px[1] + py) / render_px[1]]
            }
        }
    }
}
pub(crate) fn ease_in_out_cubic(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x < 0.5 {
        4.0 * x * x * x
    } else {
        1.0 - (-2.0 * x + 2.0).powi(3) / 2.0
    }
}
pub(crate) fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
pub(crate) fn lerp4(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
    [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)]
}
/// Un calque vidéo animé (rect sortie, taille px, rayon) — screen ou webcam.
#[derive(Clone, Copy)]
pub(crate) struct Placement {
    pub(crate) dst: [f32; 4],
    pub(crate) radius: f32,
}
/// Paramètres d'une frame : dérivés du temps par la timeline (§8).
#[derive(Clone, Copy)]
pub(crate) struct FrameParams {
    pub(crate) zoom: f32,
    pub(crate) focus: [f32; 2],
    pub(crate) screen: Placement,
    pub(crate) webcam: Placement, // dst carré (w en px via OUT_W)
}
/// Timeline figée de la fixture (6 s) : zoom 1.0→1.8→1.0, layout A(PIP)↔B(côte à côte).
/// `frame` fractionnaire pour permettre le supersampling temporel (flou de mouvement).
/// Gaté par `cfg` : zoom et layout ne bougent que si activés.
pub(crate) fn timeline(frame: f32, cfg: &Cfg) -> FrameParams {
    let t = frame / FPS; // secondes

    // zoom : montée [0,3s] puis descente [3s,6s], easeInOutCubic
    let zoom = if cfg.zoom {
        let zt = if t < 3.0 { ease_in_out_cubic(t / 3.0) } else { ease_in_out_cubic((6.0 - t) / 3.0) };
        1.0 + 0.8 * zt
    } else {
        1.0
    };

    // layout A = PIP bas-droite ; B = côte à côte. Transitions A→B [2,2.5]s, B→A [4,4.5]s.
    let lf = if !cfg.layout_anim {
        0.0
    } else if t < 2.0 {
        0.0
    } else if t < 2.5 {
        ease_in_out_cubic((t - 2.0) / 0.5)
    } else if t < 4.0 {
        1.0
    } else if t < 4.5 {
        1.0 - ease_in_out_cubic((t - 4.0) / 0.5)
    } else {
        0.0
    };

    // Layout A (PIP)
    let a_screen = Placement { dst: [0.05, 0.05, 0.90, 0.90], radius: 24.0 };
    let a_side = 320.0_f32;
    let a_webcam = Placement {
        dst: [
            (OUT_W as f32 - 40.0 - a_side) / OUT_W as f32,
            (OUT_H as f32 - 40.0 - a_side) / OUT_H as f32,
            a_side / OUT_W as f32,
            a_side / OUT_H as f32,
        ],
        radius: 40.0,
    };
    // Layout B (côte à côte) : screen à gauche (16:9), webcam carré à droite
    let b_screen = Placement { dst: [0.035, 0.22, 0.60, 0.5625], radius: 20.0 };
    let b_side = 520.0_f32;
    let b_webcam = Placement {
        dst: [
            0.70,
            (OUT_H as f32 - b_side) * 0.5 / OUT_H as f32,
            b_side / OUT_W as f32,
            b_side / OUT_H as f32,
        ],
        radius: 40.0,
    };

    FrameParams {
        zoom,
        focus: [0.5, 0.32],
        screen: Placement { dst: lerp4(a_screen.dst, b_screen.dst, lf), radius: lerp(a_screen.radius, b_screen.radius, lf) },
        webcam: Placement { dst: lerp4(a_webcam.dst, b_webcam.dst, lf), radius: lerp(a_webcam.radius, b_webcam.radius, lf) },
    }
}
/// Placements statiques screen+webcam pour un preset de layout de l'app (contrat de scène) —
/// remplace le planning A↔B fixture de `timeline()`. Zoom = 1 (les zoom regions viennent ensuite).
/// La taille/forme/miroir webcam restent appliqués par-dessus via `LiveParams`.
pub(crate) fn preset_placements(preset: &str) -> FrameParams {
    // plein cadre : le padding l'insère ensuite (padding 0 → bord à bord).
    let full_screen = Placement { dst: [0.0, 0.0, 1.0, 1.0], radius: 24.0 };
    // PiP bas-droite (≈ layout A fixture).
    let a_side = 320.0_f32;
    let pip_webcam = Placement {
        dst: [
            (OUT_W as f32 - 40.0 - a_side) / OUT_W as f32,
            (OUT_H as f32 - 40.0 - a_side) / OUT_H as f32,
            a_side / OUT_W as f32,
            a_side / OUT_H as f32,
        ],
        radius: 40.0,
    };
    // webcam hors écran (no-webcam) : quad de taille nulle, jamais visible.
    let off_webcam = Placement { dst: [2.0, 2.0, 0.0, 0.0], radius: 0.0 };

    let (screen, webcam) = match preset {
        "dual-frame" => {
            // côte à côte : screen 16:9 à gauche, webcam carré à droite (≈ layout B fixture).
            let b_side = 520.0_f32;
            (
                Placement { dst: [0.035, 0.22, 0.60, 0.5625], radius: 20.0 },
                Placement {
                    dst: [
                        0.70,
                        (OUT_H as f32 - b_side) * 0.5 / OUT_H as f32,
                        b_side / OUT_W as f32,
                        b_side / OUT_H as f32,
                    ],
                    radius: 40.0,
                },
            )
        }
        "vertical-stack" => {
            // haut/bas : screen en haut, webcam carré centré en bas.
            let w_side = 360.0_f32;
            (
                Placement { dst: [0.13, 0.04, 0.74, 0.52], radius: 20.0 },
                Placement {
                    dst: [
                        0.5 - (w_side * 0.5) / OUT_W as f32,
                        0.60,
                        w_side / OUT_W as f32,
                        w_side / OUT_H as f32,
                    ],
                    radius: 40.0,
                },
            )
        }
        "no-webcam" => (full_screen, off_webcam),
        _ => (full_screen, pip_webcam), // "picture-in-picture" (défaut)
    };

    FrameParams { zoom: 1.0, focus: [0.5, 0.5], screen, webcam }
}

// Les quatre items qui suivent existaient en DOUBLE, un exemplaire par backend, et les
// commentaires macOS affirmaient « mêmes champs et même layout » puis « mêmes formules ».
// Les deux affirmations étaient fausses sur trois valeurs :
//
//     bg_color défaut          windows [0.10, 0.11, 0.14, 1.0]   macos [0, 0, 0, 0]
//     has_webcam défaut        windows true                       macos false
//     webcam_shape_code(_)     windows 3 ("rounded")              macos 0 ("rectangle")
//
// La troisième est celle qui mord : `live_params_from_scene` l'appelle, et `webcam_shape`
// vaut "rounded" par défaut côté app — donc la même scène décrivait une caméra arrondie
// sur Windows et rectangulaire sur macOS. Les valeurs Windows font foi : c'est le backend
// qui rend en production aujourd'hui.

/// Valeurs continues pilotées par l'inspector (celles qui étaient codées en dur dans
/// `compose_frame`). Le défaut reproduit le rendu actuel → bench/export inchangés.
/// Les booléens/taps (fond flouté, ombre on/off, coins on/off, motion blur) restent
/// portés par le `Cfg` que le thread live reconstruit depuis les switches.
#[derive(Clone, Copy)]
pub struct LiveParams {
    pub bg_color: [f32; 4],       // fond plat (mode couleur) quand non flouté
    pub shadow_scale: f32,        // multiplie l'opacité des ombres (1 = défaut, 0 = off)
    pub radius_scale: f32,        // multiplie le rayon des coins (1 = défaut, 0 = carré)
    pub padding: f32,             // 0..1 : inset supplémentaire du screen (0 = défaut fixture)
    pub webcam_size_scale: f32,   // multiplie la taille de la webcam (1 = défaut)
    pub webcam_mirror: bool,      // miroir horizontal de la webcam
    pub webcam_shape: u32,        // 0=rect, 1=circle, 2=square, 3=rounded (défaut)
    pub cursor_size_scale: f32,   // multiplie la taille du curseur (1 = défaut)
    pub cursor_bounce_scale: f32, // multiplie l'amplitude du click-bounce (1 = défaut, 0 = off)
    /// 0..1 : flou de mouvement DU CURSEUR (indépendant du motion blur écran/`cfg.mblur_n`).
    /// Approximé par le même mécanisme de traînée fantôme (taps décalés le long de la
    /// vélocité), pas par un flou gaussien variable comme le canvas web — plus simple à
    /// réutiliser côté GPU, effet de streak équivalent.
    pub cursor_motion_blur: f32,
    /// False when the "webcam" decoder is actually just the screen video again (the TS side
    /// falls `webcamPath` back to the screen asset's own path when a clip has no real camera,
    /// purely so the decoder pipeline has something valid to open) — drawing the PiP box in
    /// that case duplicates the screen video into its own corner. Derived per clip from the
    /// screen/webcam paths via `webcam_is_real`: in `live.rs` for the preview, in
    /// `timeline_walk.rs` for every export. Defaults `true` (draw) so fixture/bench renders
    /// and any caller that never sets it keep their old behavior.
    pub has_webcam: bool,
}

fn same_source_path(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// True when this clip really has a camera to draw.
///
/// TWO ways the app says "no camera", and both must be caught here, because the
/// webcam decoder is opened either way — the live path falls back to the SCREEN
/// file when the webcam path won't open, and `ExportDialog` sends the screen path
/// outright, so the decoder always yields frames. Whether those frames are the
/// camera or a second copy of the screen is decided HERE and nowhere else.
///
///   - the empty string, which is what `sceneDescription.ts` and
///     `NativeCompositorOverlay` send for an asset with no `cameraTrack`;
///   - the screen's own path, which `ExportDialog.tsx` sends and which older
///     scenes still use.
///
/// Missing the empty-string case is what put the screen recording inside the PiP
/// box: `"" != "/…/recording.mp4"`, so the box was drawn, and the decoder behind
/// it was the screen fallback.
pub fn webcam_is_real(webcam_path: &str, screen_path: &str) -> bool {
    !webcam_path.trim().is_empty() && !same_source_path(webcam_path, screen_path)
}

impl Default for LiveParams {
    fn default() -> Self {
        Self {
            bg_color: [0.10, 0.11, 0.14, 1.0],
            shadow_scale: 1.0,
            radius_scale: 1.0,
            padding: 0.0,
            webcam_size_scale: 1.0,
            webcam_mirror: false,
            webcam_shape: 3,
            cursor_size_scale: 1.0,
            cursor_bounce_scale: 1.0,
            cursor_motion_blur: 0.0,
            has_webcam: true,
        }
    }
}

/// "rectangle"|"circle"|"square"|"rounded" -> code webcam_shape (0/1/2/3). Partagé entre le
/// live (`live.rs::set_param_str`) et l'export (construit `LiveParams` depuis la scène) — une
/// seule table de vérité pour ce mapping.
pub fn webcam_shape_code(shape: &str) -> u32 {
    match shape {
        "rectangle" => 0,
        "circle" => 1,
        "square" => 2,
        _ => 3, // "rounded" (défaut)
    }
}

/// Construit les `LiveParams` équivalents à ce que l'inspector pousse en live, mais depuis la
/// scène de l'app — l'export est un rendu one-shot sans historique de sliders, donc il doit lire
/// directement la config déjà posée dans la scène plutôt que dupliquer un mécanisme d'inspector.
/// Unités identiques à `RightPanes.tsx` (mêmes conversions, pas de re-normalisation) : voir
/// `sceneDescription.ts` pour la correspondance settings -> champs de scène.
pub fn live_params_from_scene(s: &crate::scene::Scene) -> LiveParams {
    LiveParams {
        shadow_scale: s.effects.shadow,
        // `radius_scale` reste le multiplicateur du chemin INSPECTOR (bench/GUI standalone) ; le
        // rayon écran d'une scène vient désormais de `effects.roundness_frac`, lu directement
        // dans `compose_frame`. Le faire transiter ici obligeait à le normaliser par un rayon de
        // fixture (`p.screen.radius`, 24 px) pour ressortir la valeur de départ — un aller-retour
        // qui ne servait qu'à faire passer des pixels pour un ratio.
        padding: s.effects.padding,
        webcam_size_scale: s.layout.webcam_size,
        webcam_mirror: s.layout.webcam_mirror,
        webcam_shape: webcam_shape_code(&s.layout.webcam_shape),
        cursor_size_scale: s.cursor.size,
        cursor_bounce_scale: s.cursor.click_bounce,
        cursor_motion_blur: s.cursor.motion_blur,
        ..LiveParams::default()
    }
}

/// Ce que `plan_frame` a besoin de savoir. Rien ici n'est un objet backend : ce sont des
/// dimensions, la scène, et les réglages live. C'est ce qui rend la fonction partageable.
pub struct FrameGeometryInput<'a> {
    /// Taille de la cible de rendu en px (`Compositor::rw()`/`rh()` côté Windows,
    /// `render_w`/`render_h` côté macOS).
    pub render_px: [f32; 2],
    /// Dimensions de la TEXTURE écran. Sur D3D11VA elles sont alignées macrobloc
    /// (1080 → 1088) ; sur CoreVideo elles sont nominales. L'écart est voulu et c'est
    /// exactement pourquoi `u_max`/`v_max` existent — ne jamais supposer texture == visible.
    pub screen_tex_px: [f32; 2],
    pub screen_visible_px: [f32; 2],
    pub webcam_visible_px: [f32; 2],
    /// Fraction utile de la texture écran : `visible / texture`.
    pub u_max: f32,
    pub v_max: f32,
    pub frame: f32,
    pub cfg: &'a Cfg,
    pub live: LiveParams,
    pub scene: Option<&'a Scene>,
    pub cursor: Option<&'a crate::cursor::CursorTrack>,
    pub timeline_t_override: Option<f32>,
}

/// Les 15 valeurs que la moitié « dessin » consomme. Sur les 75 locaux que le calcul
/// produit, 60 meurent avant le premier draw — ce sont ceux-là, et seulement ceux-là,
/// qui traversent.
pub struct FrameGeometry {
    pub scene_preset: Option<String>,
    pub mb_taps: f32,
    pub source_t: f32,
    pub zoom_rotation: [f32; 3],
    pub padding_scale: f32,
    /// Coupe source de l'écran en UV texture (crop utilisateur + zoom).
    pub cut: [f32; 4],
    pub s_dst: [f32; 4],
    pub s_dst_prev: [f32; 4],
    /// Boîte écran **sans le zoom** : le conteneur auquel les annotations et les
    /// sous-titres sont ancrés.
    ///
    /// C'est `s_dst` avant le `remap_box` du zoom, donc le rect que l'app a résolu
    /// (`layout.screenRect`) et que l'overlay web reçoit comme conteneur. Le contrat de
    /// `SceneAnnotation` est explicite : « deliberately NOT affected by the zoom crop — the
    /// overlay is a sibling of the element carrying the zoom transform, so annotations hold
    /// still while the content zooms underneath them ». Tant que le zoom vivait dans la
    /// coupe source, `s_dst` tenait ce rôle ; depuis l'issue #179 il vit dans la BOÎTE, donc
    /// `s_dst` grandit et se déplace avec lui — et les annotations le suivaient, sous-titres
    /// compris, qui se mettaient à zoomer avec l'écran.
    pub s_ann: [f32; 4],
    pub s_radius: f32,
    pub frame_min_px: f32,
    pub w_dst: [f32; 4],
    pub w_dst_prev: [f32; 4],
    pub w_px: [f32; 2],
    pub w_radius: f32,
    pub shape_fade: f32,
}

/// Rect de destination d'une annotation dans un rect d'ancrage, en fractions de la sortie.
///
/// `anchor` est TOUJOURS `s_ann`, le rect écran sans le zoom — jamais `s_dst`. Les deux
/// coïncident sans zoom, ce qui rend l'erreur invisible sur la moitié des scènes ; sous
/// zoom, `s_dst` grandit et emmène annotations et sous-titres avec lui, alors que le
/// contrat de `SceneAnnotation` les veut « deliberately NOT affected by the zoom crop ».
///
/// Version libre plutôt que méthode : Windows déstructure `FrameGeometry` dès l'entrée de
/// `compose_frame`, donc il n'a plus de `&self` à offrir quand il dessine les annotations.
/// Les trois backends partagent malgré tout CETTE arithmétique-ci — le bug est reparu sur
/// Linux après avoir été corrigé sur Windows et macOS (issue #179) parce que chacun en
/// gardait sa copie.
///
/// Attention : le choix du rect passé en `anchor` reste, lui, au call site des backends
/// Metal et D3D (leur `draw_annotations` prend le rect en paramètre). Seul Linux part
/// directement de `FrameGeometry`. Passer `s_dst` ici reste donc possible sur deux
/// backends sur trois — d'où le nom du paramètre côté appelants, et les tests.
pub fn annotation_dst_in(anchor: [f32; 4], x: f32, y: f32, w: f32, h: f32) -> [f32; 4] {
    [anchor[0] + x * anchor[2], anchor[1] + y * anchor[3], w * anchor[2], h * anchor[3]]
}

impl FrameGeometry {
    /// `annotation_dst_in` appliqué à `s_ann`, pour les backends qui tiennent la géométrie
    /// entière — c'est-à-dire ceux qui n'ont aucune raison de choisir un rect.
    pub fn annotation_dst(&self, x: f32, y: f32, w: f32, h: f32) -> [f32; 4] {
        annotation_dst_in(self.s_ann, x, y, w, h)
    }

    /// Hauteur en px du rect d'ancrage des annotations, pour `rh` px de sortie.
    ///
    /// `font_size_rel` est une fraction de cette hauteur (cf. `annotationScale.ts`) :
    /// la prendre sur `s_dst` ferait grossir le texte avec le zoom, exactement comme
    /// `annotation_dst` le déplacerait.
    pub fn annotation_anchor_h_px(&self, rh: f32) -> f32 {
        self.s_ann[3] * rh
    }
}

/// Où va chaque calque, pour une frame — sans toucher au GPU.
///
/// C'est la première moitié de `compose_frame`, mot pour mot : 353 lignes qui ne
/// contenaient pas un seul appel D3D11. Les deux backends doivent produire ces
/// placements au pixel près (la propriété « iso-render » que le projet mesure), et la
/// seule façon fiable d'y arriver est qu'ils appellent la même fonction.
pub fn plan_frame(input: &FrameGeometryInput) -> FrameGeometry {
    let (rw, rh) = (input.render_px[0], input.render_px[1]);
    let (stw, sth) = (input.screen_tex_px[0], input.screen_tex_px[1]);
    let (scw, sch) = (input.screen_visible_px[0], input.screen_visible_px[1]);
    let (wcw, wch) = (input.webcam_visible_px[0], input.webcam_visible_px[1]);
    let (u_max, v_max) = (input.u_max, input.v_max);
    let (frame, cfg) = (input.frame, input.cfg);
    let lp = input.live;
    let scene = input.scene;
    let cursor = input.cursor;

        // Scène de l'app présente → placements du layout preset (ou, mieux, le rect résolu par
        // l'app dans `layout.webcam_rect`) ; sinon planning fixture (bench).
        let scene_preset: Option<String> =
            scene.map(|s| s.layout.preset.clone());
        // Webcam rect résolu par l'app (= `computeCompositeLayout`, source de vérité unique
        // entre preview et natif) : quand il est présent ET que la scène est posée, on l'utilise
        // COMME placement de base. Sinon, fallback sur `preset_placements` historique (PiP
        // codé en dur à 320 px + 40 px de marge — l'arrangement qui dérivait de la preview).
        let app_webcam_rect: Option<[f32; 4]> = scene
            .and_then(|s| s.layout.webcam_rect)
            .map(|r| [r.x, r.y, r.width, r.height]);
        // Idem pour l'écran. Les deux rects viennent du MÊME appel `computeCompositeLayout`, donc
        // les consommer ensemble est la seule façon de garder le bloc écran+caméra cohérent :
        // n'en prendre qu'un revenait à mélanger la géométrie de l'app et un placement fixture.
        let app_screen_rect: Option<[f32; 4]> = scene
            .and_then(|s| s.layout.screen_rect)
            .map(|r| [r.x, r.y, r.width, r.height]);
        let (mut p, mut pp) = match &scene_preset {
            Some(preset) => {
                // Chaque rect résolu par l'app remplace INDÉPENDAMMENT sa contrepartie du
                // preset ; sinon celle du preset reste (le padding slider l'insèrera ensuite
                // dans `scale_frame`).
                //
                // Avant, ce match portait sur `app_webcam_rect` et le rect ÉCRAN n'était donc
                // honoré que si un rect webcam arrivait aussi. Un layout sans caméra gardait
                // l'écran plein cadre du preset — pendant que `fit_screen` (plus bas) coupait
                // quand même son fit au ratio du crop, puisqu'un `app_screen_rect` était bien
                // présent. Résultat : un clip recadré sans caméra était étiré, et aucune des
                // deux voies ne le rattrapait. Coupler l'écran à la présence de la caméra
                // n'avait aucune raison d'être — ce sont deux calques indépendants.
                let mut fp = preset_placements(preset);
                if let Some(wr) = app_webcam_rect {
                    fp.webcam.dst = wr;
                }
                if let Some(sr) = app_screen_rect {
                    fp.screen.dst = sr;
                }
                (fp, fp) // layout statique → vélocité nulle
            }
            None => (timeline(frame, cfg), timeline(frame - 1.0, cfg)),
        };
        // Motion blur écran : quand la scène (contrat de l'app) est posée, c'est elle qui pilote
        // (parité inspector : 1.0 + motion_blur*15 taps), sinon on retombe sur `cfg.mblur_n`
        // (le bench fixture continue d'utiliser ses taps explicites).
        let mb_taps = scene
            .map(|s| 1.0 + s.effects.motion_blur.clamp(0.0, 1.0) * 15.0)
            .unwrap_or(cfg.mblur_n as f32);

        // Zoom regions + Full Camera : filtrées en amont pour le clip actif et échantillonnées
        // dans le même référentiel source que le PTS du décodeur écran.
        let empty_zoom: Vec<crate::scene::SceneZoomRegion> = Vec::new();
        let empty_cam: Vec<crate::scene::SceneCameraFullscreenRegion> = Vec::new();
        let zoom_regions = scene.map(|s| &s.zoom_regions).unwrap_or(&empty_zoom);
        let cam_regions =
            scene.map(|s| &s.camera_fullscreen_regions).unwrap_or(&empty_cam);
        let webcam_reactive = scene.map(|s| s.layout.webcam_reactive_zoom).unwrap_or(false);
        let source_t = input.timeline_t_override.unwrap_or(frame / FPS);
        let source_t_prev = source_t - 1.0 / FPS;
        // le focus "auto" (suivi curseur) réutilise la même piste que le rendu du curseur.
        let cursor_for_zoom = cursor;
        // La rotation 3D (mode 8, pas de motion blur dans ce chemin — cf. le commentaire au
        // point d'appel) n'est calculée QUE pour la frame courante ; `pp` ne sert qu'au zoom
        // écran normal (vélocité pour le motion blur du chemin non-tilté).
        let mut zoom_rotation = [0.0f32; 3];
        if !zoom_regions.is_empty() {
            let zs = crate::regions::zoom_state_at(zoom_regions, source_t, cursor_for_zoom);
            p.zoom = zs.scale;
            p.focus = zs.focus;
            zoom_rotation = zs.rotation;
            let zs_p = crate::regions::zoom_state_at(zoom_regions, source_t_prev, cursor_for_zoom);
            pp.zoom = zs_p.scale;
            pp.focus = zs_p.focus;
        }
        // Full Camera ignore le rétrécissement réactif de la webcam (design web : mélanger
        // "rétrécit pour le zoom" et "grandit en plein cadre" dans la même frame n'a pas de sens).
        let cam_progress = crate::regions::camera_fullscreen_progress_at(cam_regions, source_t);
        let cam_progress_prev =
            crate::regions::camera_fullscreen_progress_at(cam_regions, source_t_prev);
        // rétrécissement réactif : la webcam rétrécit pendant un zoom actif (1/zoom, plancher
        // 0.35 — parité `reactiveWebcamScale`, TS). Ignoré pendant Full Camera (voir ci-dessus).
        let reactive_scale = |zoom: f32, progress: f32| -> f32 {
            if webcam_reactive && progress <= 0.0 && zoom.is_finite() && zoom > 0.0 {
                (1.0 / zoom).clamp(0.35, 1.0)
            } else {
                1.0
            }
        };
        // `lp.webcam_size_scale` vient de `scene.layout.webcamSize` (voir `live_params_from_scene`)
        // — le MÊME nombre que le fraction webcamSizePreset déjà pris en compte côté app pour
        // calculer `wr` (`computeCompositeLayout`, TS). Quand l'app fournit un `webcam_rect`
        // explicite, la taille y est donc déjà cuite : réappliquer `lp.webcam_size_scale` ici
        // double-échelonnerait la boîte (ex. un preset 34% → webcam rendue à ~34%×34% ≈ 12% au
        // lieu de 34%, la webcam apparaissant bien plus petite que ce que montre l'aperçu web).
        // Seul `reactive_scale` (rétrécissement pendant un zoom, une valeur ANIMÉE par frame que
        // le rect statique de l'app ne capture pas) doit encore s'appliquer dans ce cas.
        let base_size_scale = if app_webcam_rect.is_some() { 1.0 } else { lp.webcam_size_scale };
        let webcam_size_scale = base_size_scale * reactive_scale(p.zoom, cam_progress);
        let webcam_size_scale_prev = base_size_scale * reactive_scale(pp.zoom, cam_progress_prev);

        // padding : échelle globale du layout autour du centre du cadre (parité web frameRenderer :
        // paddingScale = 1 - padding*0.4 → padding 0 = plein cadre). S'applique à TOUS les presets :
        // côté web, side-by-side et top/bottom soudent écran+caméra en un bloc unique et c'est ce
        // bloc que le padding rétrécit (cf. `compositeLayout.ts`, branche `block`). Vertical-stack
        // en était exempté tant qu'il était full-bleed ; il ne l'est plus.
        let padding_scale = 1.0 - lp.padding * 0.4;
        let scale_frame = |dst: [f32; 4], s: f32| -> [f32; 4] {
            [0.5 + (dst[0] - 0.5) * s, 0.5 + (dst[1] - 0.5) * s, dst[2] * s, dst[3] * s]
        };
        // webcam : ancrée à son coin bas-droite (grandit vers le haut-gauche, pas depuis le centre).
        let scale_corner_br = |dst: [f32; 4], s: f32| -> [f32; 4] {
            let (brx, bry) = (dst[0] + dst[2], dst[1] + dst[3]);
            let (nw, nh) = (dst[2] * s, dst[3] * s);
            [brx - nw, bry - nh, nw, nh]
        };
        // parité web (compositeLayout) : rectangle/rounded gardent le ratio natif de la webcam ;
        // square/circle forcent un carré (side = min). Le placement de base est carré → on ajuste
        // ici, en gardant le coin bas-droite fixe (cohérent avec le size-scale).
        let is_square_shape = matches!(lp.webcam_shape, 1 | 2); // circle | square
        let cam_ar = if is_square_shape { 1.0 } else { (wcw / wch).max(0.01) };
        let fit_cam_aspect = |dst: [f32; 4]| -> [f32; 4] {
            let s = (dst[2] * rw).min(dst[3] * rh); // côté carré de base (px)
            let (pw, ph) = if cam_ar >= 1.0 { (s, s / cam_ar) } else { (s * cam_ar, s) };
            let (nw, nh) = (pw / rw, ph / rh);
            let (brx, bry) = (dst[0] + dst[2], dst[1] + dst[3]);
            [brx - nw, bry - nh, nw, nh]
        };
        // Variantes ancrées au CENTRE (au lieu du coin bas-droite) de `dst`, pour le cas où
        // `dst` vient de `app_webcam_rect` : ce rect est déjà la position que l'utilisateur a
        // choisie/déplacée (résolue côté app via `computeCompositeLayout`, même convention
        // centre-fraction que `cx`/`cy` dans `compositeLayout.ts`) — l'ancrer au coin bas-droite
        // comme le fait `fit_cam_aspect` (pensé pour le placement par DÉFAUT, ancré à ce coin
        // avec une marge fixe) réancre silencieusement la webcam glissée n'importe où d'autre à
        // ce coin, ignorant la position réelle choisie par l'utilisateur — le bug rapporté
        // (webcam glissée au coin bas-gauche, DOM/JSON envoyé au natif confirmant une position
        // flush, mais rendu natif visiblement décalé). Le centre est le point fixe qui a un sens
        // pour un rect DÉJÀ positionné par l'app ; le coin bas-droite n'a de sens que pour le
        // placement par défaut, qui grandit depuis ce coin faute de position explicite.
        let scale_center = |dst: [f32; 4], s: f32| -> [f32; 4] {
            let (cx, cy) = (dst[0] + dst[2] * 0.5, dst[1] + dst[3] * 0.5);
            let (nw, nh) = (dst[2] * s, dst[3] * s);
            [cx - nw * 0.5, cy - nh * 0.5, nw, nh]
        };
        // Le ratio de sortie réel (peut différer du canvas interne 16:9 fixe) et le facteur
        // d'étirement non uniforme que `blit_resized` appliquera en fin de pipeline — nécessaires
        // ici (avant `undistort`, plus bas) pour que le fit ci-dessous cible le ratio de boîte tel
        // qu'il apparaîtra APRÈS cet étirement, pas tel qu'il est dans l'espace canvas pré-étirement
        // (sinon le fit et l'undistort composent deux corrections indépendantes et sur-rétrécissent
        // le contenu — cf. rapport utilisateur : crop 9:16 + sortie 9:16 + padding 0% laissait
        // quand même une grosse marge, alors que le crop correspond déjà exactement au cadre).
        // Le crop de l'utilisateur (dialogue "Edit clip") a son PROPRE ratio (ex. une bande
        // verticale 9:16 recadrée dans une source 16:9) — le zoom appliqué ensuite (§
        // `screen_source_rect`) le préserve (mêmes facteurs sur les deux axes), donc c'est bien
        // le ratio du CROP qui doit dimensionner le quad de destination, pas celui (fixe, issu
        // du preset de layout) de `p.screen.dst`. Sans ça, le rect recadré (dont le ratio propre
        // diffère de la boîte du preset) se retrouve étiré pour remplir cette boîte — parité web
        // cassée : `computeCompositeLayout`/`centerRectInBounds` (TS) contiennent déjà le crop
        // dans sa boîte en respectant son ratio, le natif ne le faisait pas (rapport utilisateur).
        let active_crop = scene.and_then(|scene| {
            scene.crop_by_clip.get(scene.active_clip_index).copied().flatten()
        });
        let crop_aspect = match active_crop {
            Some(c) if c.width > 0.0001 && c.height > 0.0001 => {
                (c.width * scw) / (c.height * sch).max(0.0001)
            }
            _ => scw / sch.max(0.0001),
        };
        // Contain (parité `centerRectInBounds`) : rétrécit `dst` (centré) pour que son ratio
        // devienne `aspect`, sans jamais dépasser sa boîte d'origine — mais la boîte de référence
        // doit être mesurée telle qu'elle apparaîtra APRÈS l'étirement de sortie (`dst` * ratio de
        // sortie), pas dans l'espace canvas 16:9 pré-étirement : sinon le fit cible le mauvais
        // ratio de boîte dès que la sortie n'est pas 16:9. `undistort` (plus bas) annule ensuite
        // exactement ce même facteur, donc convertir le résultat en fraction canvas se fait par
        // `/ uniform_stretch` (propriété de `undistort` : le ratio final ne dépend que de la
        // taille de `dst` en PIXELS CANVAS, jamais du ratio de sortie choisi).
        let fit_dst_to_aspect = |dst: [f32; 4], aspect: f32| -> [f32; 4] {
            let box_w_px = dst[2] * rw;
            let box_h_px = dst[3] * rh;
            let box_ar = box_w_px / box_h_px.max(0.0001);
            let (nw_px, nh_px) = if aspect > box_ar {
                (box_w_px, box_w_px / aspect.max(0.0001))
            } else {
                (box_h_px * aspect, box_h_px)
            };
            let (nw, nh) = (nw_px / rw, nh_px / rh);
            let (cx, cy) = (dst[0] + dst[2] * 0.5, dst[1] + dst[3] * 0.5);
            [cx - nw * 0.5, cy - nh * 0.5, nw, nh]
        };
        // Quand l'app a résolu la boîte écran, elle a DÉJÀ appliqué le padding (le rect est
        // calculé contre `maxContentSize`) et l'a DÉJÀ mise au ratio du crop
        // (`computeCompositeLayout` reçoit la taille de la source recadrée) : rejouer
        // `scale_frame` + `fit_dst_to_aspect` par-dessus appliquerait le padding deux fois et
        // re-contiendrait une boîte déjà au bon ratio. Même raisonnement que pour la webcam.
        let fit_screen = |dst: [f32; 4]| {
            if app_screen_rect.is_some() {
                dst
            } else {
                fit_dst_to_aspect(scale_frame(dst, padding_scale), crop_aspect)
            }
        };
        // Issue #179 : le zoom se jouait entièrement dans la coupe source, donc la boîte
        // écran restait au rect paddé et le zoom butait sur cette frontière au lieu
        // d'atteindre les bords du cadre. On rend le zoom à la BOÎTE (cf. `remap_box`) :
        // la coupe dessinée redevient le crop nu, la boîte porte le grossissement et
        // déborde le padding — c'est la géométrie de `applyZoomTransform` (TS).
        let s_base = fit_screen(p.screen.dst);
        let s_base_prev = fit_screen(pp.screen.dst);
        // Layouts "bloc" (side-by-side / top-bottom) : la boîte écran est un SLOT au ratio
        // arbitraire, et le web y fait tenir l'image en `cover` (`computeCompositeLayout`
        // renvoie `screenCover: true`, honoré par `frameRenderer`). Le natif l'ignorait, donc
        // il étirait la source pour remplir le slot — visible dès que le clip est recadré,
        // puisque le crop éloigne encore le ratio de la source de celui du slot.
        //
        // Le cover s'applique APRÈS le crop et le zoom, sur leur rect résultant : le crop
        // décide quoi montrer, le zoom où regarder, le cover comment habiller la boîte. Son
        // ratio de boîte se lit sur `s_base` : `remap_box` met les deux axes à la même
        // échelle, donc la boîte finale a le même ratio et le cover ne dépend pas d'elle
        // (ce qui casserait la circularité coupe → boîte → coupe).
        let cover_box_ar = scene.and_then(|s| {
            s.layout
                .screen_cover
                .then_some((s_base[2] * rw) / (s_base[3] * rh).max(0.0001))
        });
        let cover = |uv: [f32; 4]| -> [f32; 4] {
            match cover_box_ar {
                Some(ar) => cover_uv_rect(uv, [stw as f32, sth as f32], ar),
                None => uv,
            }
        };
        // La coupe RÉFÉRENCE (zoom entier) est celle qui remplissait la boîte paddée avant
        // ce correctif ; la coupe DESSINÉE ne porte plus que le crop. `remap_box` reporte la
        // seconde à travers le mapping de la première, ce qui conserve le cadrage exact.
        // Le focus courant reste volontairement utilisé pour la frame précédente, comme avant.
        let cut_ref = cover(screen_source_rect(u_max, v_max, active_crop, p.zoom, p.focus));
        let cut_ref_prev = cover(screen_source_rect(u_max, v_max, active_crop, pp.zoom, p.focus));
        let cut = cover(screen_source_rect(u_max, v_max, active_crop, 1.0, p.focus));
        let s_dst = remap_box(s_base, cut_ref, cut);
        let s_dst_prev = remap_box(s_base_prev, cut_ref_prev, cut);
        // le padding n'affecte QUE l'écran (la quantité de fond révélée). La webcam reste ancrée
        // en bas-droite à sa marge fixe, quelle que soit la valeur de padding (pas de scale_frame)
        // — SAUF quand l'app a résolu un placement explicite (`app_webcam_rect`, drag-to-reposition
        // compris). Ce rect est déjà exprimé en fraction du VRAI output (calculé côté web par
        // `computeCompositeLayout` avec les vraies dimensions de sortie), position ET aspect déjà
        // corrects — `fit_cam_aspect`/`scale_corner_br` (chemin preset par défaut) sont donc
        // doublement inadaptés ici : ils réancrent au coin bas-droite (ignorant la position
        // choisie par l'utilisateur) ET recalculent l'aspect en pixels du canvas fixe 16:9
        // (`OUT_W`×`OUT_H`), une référence différente du vrai output dès que la sortie n'est pas
        // 16:9 (rapport utilisateur : webcam glissée au coin bas-gauche en 9:16, JSON envoyé au
        // natif confirmant une position flush, mais rendu native visiblement décalé ET trop
        // petit). On garde seulement `scale_center` (zoom réactif, préserve position+aspect) puis
        // on pré-compense par `inverse_undistort` pour annuler le `undistort()` générique
        // appliqué plus bas à tous les calques (écran compris) — sans quoi ce rect déjà correct
        // se ferait déformer une seconde fois par cet undistort partagé.
        let mut w_dst = if app_webcam_rect.is_some() {
            scale_center(p.webcam.dst, webcam_size_scale)
        } else {
            fit_cam_aspect(scale_corner_br(p.webcam.dst, webcam_size_scale))
        };
        let mut w_dst_prev = if app_webcam_rect.is_some() {
            scale_center(pp.webcam.dst, webcam_size_scale_prev)
        } else {
            fit_cam_aspect(scale_corner_br(pp.webcam.dst, webcam_size_scale_prev))
        };

        // Full Camera : la caméra PREND le cadre — parité `computeCameraFullscreenRect` (TS).
        // La cible est exactement [0,0,1,1] : pas de marge, pas de padding, pas d'arrondi, et
        // plus rien de la composition (fond, écran, ombre) derrière. Le rect change de ratio en
        // chemin, mais `cover_crop_uv` (plus bas) dérive la coupe source du ratio RÉEL de la
        // boîte à chaque frame : la caméra n'est donc jamais étirée pendant l'animation.
        let fullscreen_dst = |dst: [f32; 4], progress: f32| -> [f32; 4] {
            if progress <= 0.0 {
                return dst;
            }
            let lerp = |a: f32, b: f32| a + (b - a) * progress;
            [lerp(dst[0], 0.0), lerp(dst[1], 0.0), lerp(dst[2], 1.0), lerp(dst[3], 1.0)]
        };
        // Petit côté de la boîte caméra AVANT que Full Camera ne la fasse grandir. C'est la
        // référence du rayon de coin : le zoom réactif est déjà dedans (il rétrécit la boîte,
        // donc l'arrondi suit tout seul — parité `borderRadius * reactiveFactor` côté TS), alors
        // que Full Camera ne fait pas grossir l'arrondi, il le DISSOUT (cf. `shape_fade`).
        let w_nominal_min = (w_dst[2] * rw).min(w_dst[3] * rh);
        w_dst = fullscreen_dst(w_dst, cam_progress);
        w_dst_prev = fullscreen_dst(w_dst_prev, cam_progress_prev);

        // Contre-étirement "fit" : le canvas interne compose TOUJOURS en OUT_W×OUT_H (16:9),
        // puis `blit_resized` étire tout, de façon non uniforme si besoin, vers la résolution
        // de sortie demandée — voulu pour que le FOND (dessiné plus bas en dst=[0,0,1,1])
        // remplisse tout le cadre quel que soit le ratio choisi. Mais l'écran et la webcam ne
        // doivent PAS être déformés par cet étirement : on rétrécit ici leur rect de
        // destination (centré, dans cet espace 16:9 PRÉ-étirement) par l'inverse du plus fort
        // des deux facteurs d'étirement, pour qu'après l'étirement final leur ratio d'origine
        // reste préservé (letterboxé/pillarboxé sur le fond, qui lui reste plein cadre) — mode
        // "fit"/contain. Si l'utilisateur veut un rendu "fill" (remplir sans bandes), il ajuste
        // le crop lui-même ; le natif ne fait plus ce choix à sa place en étirant l'image.
        // Le dessin du coin (SDF, shaders.hlsl) compare le rayon à `quad_px`, exprimé en px du
        // RENDER TARGET : c'est donc dans cet espace-là qu'il faut le lui donner.
        //
        // Toutes les longueurs de la scène sont des FRACTIONS ; on les multiplie ici par ce
        // qu'elles mesurent, dans l'espace du render target. C'est ce qui rend preview et export
        // identiques : « un pixel » n'y désigne pas la même chose (la preview rastérise dans un
        // cadre contain-fitté plus petit, cf. `preview_render_size`), alors qu'une fraction, si.
        // `frame_min_px` est la référence des quantités relatives au CADRE ; un rayon de coin,
        // lui, se mesure contre sa propre boîte — il doit rester en place quand on redimensionne
        // la boîte, pas suivre le cadre.
        let frame_min_px = rw.min(rh);
        let s_min_px = (s_dst[2] * rw).min(s_dst[3] * rh);
        let app_screen_radius_frac = scene.and_then(|s| s.layout.screen_radius_frac);
        let scene_roundness_frac = scene.map(|s| s.effects.roundness_frac);
        // Le rayon suit la boîte : quand le zoom l'agrandit (issue #179), les coins grandissent
        // avec elle puis sortent du cadre — comme le masque de la référence, qui porte le même
        // `br: maskBorderRadius * camS` et quitte l'étage au même moment.
        let s_radius = match (cfg.rounded, app_screen_radius_frac, scene_roundness_frac) {
            (false, _, _) => 0.0,
            // Preset en bloc : le rayon appartient à la boîte écran (parité exacte avec la caméra).
            (true, Some(f), _) => f * s_min_px,
            // Scène sans rayon imposé : slider Roundness, relatif au cadre.
            (true, None, Some(f)) => f * frame_min_px,
            // Fixture/bench (pas de scène) : chemin inspector historique, inchangé.
            (true, None, None) => p.screen.radius * lp.radius_scale,
        };
        let w_px = [w_dst[2] * rw, w_dst[3] * rh];
        // Rayon caméra. Le slider Roundness ne s'y applique jamais (il ne vaut que pour l'ÉCRAN).
        // Quand l'app le résout (`computeCompositeLayout`, source unique), on le prend : c'est la
        // seule façon que les deux moitiés d'un layout en bloc soient encadrées à l'identique,
        // l'écran consommant déjà `screen_radius_frac` du même calcul. La table ci-dessous en
        // était une SECONDE, indépendante — fraction différente (0.12 vs 0.06 côté web) et sans
        // bornes — donc écran et caméra ne pouvaient pas s'accorder.
        let app_webcam_radius_frac = scene.and_then(|s| s.layout.webcam_radius_frac);
        // Full Camera dissout la forme en même temps qu'elle prend le cadre : le rayon fond
        // vers 0 avec `cam_progress`, donc le cercle devient un rect à coins de plus en plus
        // francs puis un plein cadre net — aucun masque ne survit au plein écran (parité
        // `computeCameraFullscreenRect`, qui ramène `maskShape` à "rectangle" et lerpe le
        // rayon vers 0 pour exactement la même raison).
        let shape_fade = (1.0 - cam_progress).clamp(0.0, 1.0);
        let w_radius = shape_fade
            * w_nominal_min
            * match app_webcam_radius_frac {
                Some(f) => f,
                // Fallback (payload sans fraction, fixture/bench) : l'ancienne table, keyée sur la
                // forme. Rectangle ET square n'ont qu'un léger arrondi (0.12) et ne diffèrent que
                // par le ratio ; rounded est nettement plus arrondi (0.3) ; circle = demi-côté.
                None => match lp.webcam_shape {
                    1 => 0.5,
                    3 => 0.3,
                    _ => 0.12,
                },
            };

    FrameGeometry {
        scene_preset,
        mb_taps,
        source_t,
        zoom_rotation,
        padding_scale,
        cut,
        s_dst,
        s_dst_prev,
        // La boîte écran telle qu'elle serait sans zoom : `remap_box` n'est PAS appliqué.
        s_ann: s_base,
        s_radius,
        frame_min_px,
        w_dst,
        w_dst_prev,
        w_px,
        w_radius,
        shape_fade,
    }
}

/// Le curseur, prêt à dessiner : où, à quelle taille, avec quelle traînée.
///
/// Extrait de la moitié « dessin » de `compose_frame` pour la même raison que
/// `plan_frame` : deux backends qui doivent poser le curseur au pixel près ne peuvent pas
/// entretenir deux copies de ce mapping. Le placement dépend de la coupe source, du zoom,
/// du padding et de l'inclinaison — autant d'endroits où deux implémentations dérivent.
pub struct CursorPlan {
    pub placement: CursorPlacement,
    /// Placement à `t - trail_frames/FPS`, pour la traînée. `placement` quand il n'y en a pas.
    pub prev_placement: CursorPlacement,
    /// Côté du sprite en px de sortie (bounce et padding déjà appliqués).
    pub size_px: f32,
    /// Nombre d'échantillons de la traînée. 1 = curseur net, pas d'accumulation.
    pub taps: u32,
    /// Rect de clip « Clip to canvas » (mode 4/7 du shader lit `fx`).
    pub clip: [f32; 4],
    /// État du curseur à cet instant (`arrow`, `pointer`, …) pour choisir le sprite.
    pub cursor_type: Option<String>,
}

/// Ce que `plan_cursor` doit savoir en plus de `FrameGeometry`.
pub struct CursorPlanInput<'a> {
    pub render_px: [f32; 2],
    pub u_max: f32,
    pub v_max: f32,
    pub cfg: &'a Cfg,
    pub live: LiveParams,
    pub scene: Option<&'a Scene>,
    pub track: &'a crate::cursor::CursorTrack,
    /// Temps curseur, déjà résolu (`cursor_t_override` ou `frame / FPS`).
    pub t: f32,
}

/// `None` = rien à dessiner cette frame : curseur masqué, ou pointeur hors du rect source
/// courant (zoom serré, hors écran) — un état normal en lecture, pas une erreur.
pub fn plan_cursor(g: &FrameGeometry, input: &CursorPlanInput) -> Option<CursorPlan> {
    let (rw, rh) = (input.render_px[0], input.render_px[1]);
    let show = input.scene.map(|s| s.cursor.show).unwrap_or(input.cfg.cursor);
    if !show {
        return None;
    }
    let s_px = [g.s_dst[2] * rw, g.s_dst[3] * rh];
    let tilt = (!crate::regions::is_identity_rotation(g.zoom_rotation))
        .then(|| crate::regions::rotated_quad_corners_px(s_px[0], s_px[1], g.zoom_rotation));
    let quad_center_px = [
        (g.s_dst[0] + g.s_dst[2] * 0.5) * rw,
        (g.s_dst[1] + g.s_dst[3] * 0.5) * rh,
    ];
    let cursor_bounds: [f32; 4] = match tilt.as_ref() {
        None => g.s_dst,
        Some(quad) => {
            let (hx, hy) = quad.half_extents_px();
            [
                (quad_center_px[0] - hx) / rw,
                (quad_center_px[1] - hy) / rh,
                2.0 * hx / rw,
                2.0 * hy / rh,
            ]
        }
    };
    let clip = match input.scene {
        Some(s) if s.cursor.clip_to_bounds => cursor_bounds,
        _ => [-1.0, -1.0, 3.0, 3.0],
    };

    let [su0, sv0, su1, sv1] = g.cut;
    let (hu, hv) = ((su1 - su0) * 0.5, (sv1 - sv0) * 0.5);
    let place = |cxy: Option<(f32, f32)>, dst: [f32; 4]| -> Option<CursorPlacement> {
        cxy.and_then(|(cx2, cy2)| {
            let fx = (cx2 * input.u_max - su0) / (2.0 * hu);
            let fy = (cy2 * input.v_max - sv0) / (2.0 * hv);
            if !(0.0..=1.0).contains(&fx) || !(0.0..=1.0).contains(&fy) {
                return None;
            }
            Some(match tilt.as_ref() {
                Some(&quad) => CursorPlacement::Tilted {
                    plane_pt: [fx, fy],
                    quad,
                    center_px: quad_center_px,
                    screen_px: s_px,
                    render_px: [rw, rh],
                },
                None => CursorPlacement::Upright {
                    center: [dst[0] + fx * dst[2], dst[1] + fy * dst[3]],
                },
            })
        })
    };
    let placement = place(input.track.at(input.t), g.s_dst)?;

    let lp = input.live;
    let bounce = 1.0 + (input.track.bounce(input.t) - 1.0) * lp.cursor_bounce_scale;
    let size_px =
        CURSOR_BASE_SIZE_FRAC * g.frame_min_px * lp.cursor_size_scale * bounce * g.padding_scale;

    let blur01 = lp.cursor_motion_blur.clamp(0.0, 1.0);
    let has_scene = input.scene.is_some();
    let trail_frames = if has_scene { 1.0 + blur01 * 7.0 } else { 1.0 };
    let taps = if has_scene {
        (1.0 + blur01 * 10.0).round() as u32
    } else {
        input.cfg.mblur_n
    };
    let prev_placement = if taps <= 1 {
        placement
    } else {
        place(input.track.at(input.t - trail_frames / FPS), g.s_dst_prev).unwrap_or(placement)
    };

    Some(CursorPlan {
        placement,
        prev_placement,
        size_px,
        taps,
        clip,
        cursor_type: input.track.type_at(input.t).map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// La scène de référence du golden : un cas qui exerce le padding, le crop, le zoom,
    /// une caméra PiP décalée, un rayon et une inclinaison nulle.
    fn golden_scene() -> Scene {
        Scene::from_json(
            r##"{
            "clips":[{"screenPath":"/s.mp4","webcamPath":"/w.mp4","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":true}],
            "layout":{"preset":"picture-in-picture","webcamSize":0.44,"webcamShape":"circle","webcamMirror":false,
                      "webcamPosition":{"cx":0.8577,"cy":0.8159},"webcamReactiveZoom":false},
            "effects":{"padding":0.51,"blur":false,"shadow":0.35,"roundnessFrac":0.0255,"motionBlur":0.35},
            "background":{"kind":"color","color":"#1e1e2e"},
            "zoomRegions":[],
            "cursor":{"show":true,"size":7.76,"smoothing":0,"motionBlur":0.35,"clickBounce":1,"clipToBounds":false,"theme":"default"},
            "cropByClip":[{"x":0,"y":0,"width":0.61,"height":0.61}],
            "output":{"width":1170,"height":658,"fps":60}
        }"##,
        )
        .expect("golden scene")
    }

    fn golden_input(scene: &Scene, cfg: &Cfg) -> FrameGeometryInput<'static> {
        // SAFETY-free: on fuit volontairement les deux références pour obtenir un
        // `'static` dans le test — la scène et le cfg vivent jusqu'à la fin du process.
        let scene: &'static Scene = Box::leak(Box::new(scene.clone()));
        let cfg: &'static Cfg = Box::leak(Box::new(cfg.clone()));
        FrameGeometryInput {
            render_px: [1170.0, 658.0],
            screen_tex_px: [1920.0, 1088.0],
            screen_visible_px: [1920.0, 1080.0],
            webcam_visible_px: [1280.0, 720.0],
            u_max: 1920.0 / 1920.0,
            v_max: 1080.0 / 1088.0,
            frame: 90.0,
            cfg,
            live: live_params_from_scene(scene),
            scene: Some(scene),
            cursor: None,
            timeline_t_override: Some(1.5),
        }
    }

    /// Le JSON de la scène zoomée, brut : `tilted_golden_scene` n'en change QUE la
    /// rotation, et le faire par substitution garantit que les deux scènes ne diffèrent
    /// pas ailleurs sans qu'on s'en aperçoive.
    fn zoomed_golden_scene_json() -> &'static str {
        r##"{
            "clips":[{"screenPath":"/s.mp4","webcamPath":"/w.mp4","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":true}],
            "layout":{"preset":"picture-in-picture","webcamSize":0.44,"webcamShape":"circle","webcamMirror":false,
                      "webcamPosition":{"cx":0.8577,"cy":0.8159},"webcamReactiveZoom":false},
            "effects":{"padding":0.51,"blur":false,"shadow":0.35,"roundnessFrac":0.0255,"motionBlur":0.35},
            "background":{"kind":"color","color":"#1e1e2e"},
            "zoomRegions":[{"clipIndex":0,"startSec":0.0,"endSec":5.0,"scale":2.0,"focusX":0.5,"focusY":0.3,"rotation":"none"}],
            "cursor":{"show":true,"size":7.76,"smoothing":0,"motionBlur":0.35,"clickBounce":1,"clipToBounds":false,"theme":"default"},
            "cropByClip":[{"x":0,"y":0,"width":0.61,"height":0.61}],
            "output":{"width":1170,"height":658,"fps":60}
        }"##
    }

    /// La même scène, avec une région de zoom active à `t = 1.5 s`.
    fn zoomed_golden_scene() -> Scene {
        Scene::from_json(zoomed_golden_scene_json()).expect("zoomed golden scene")
    }

    /// L'ancre des annotations ne bouge PAS avec le zoom, alors que la boîte écran, si.
    ///
    /// C'est tout le contrat de `SceneAnnotation` : l'overlay web est frère de l'élément qui
    /// porte la transform de zoom, donc annotations et sous-titres tiennent en place pendant
    /// que le contenu grossit dessous. Tant que le zoom vivait dans la coupe source, `s_dst`
    /// jouait ce rôle sans effort ; depuis l'issue #179 il vit dans la BOÎTE, et le natif
    /// zoomait les sous-titres avec l'écran. Ce test échoue si `s_ann` se remet à suivre.
    #[test]
    fn the_annotation_anchor_ignores_the_zoom() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let plain = golden_scene();
        let zoomed = zoomed_golden_scene();
        let a = plan_frame(&golden_input(&plain, &cfg));
        let b = plan_frame(&golden_input(&zoomed, &cfg));

        assert_ne!(
            a.s_dst, b.s_dst,
            "le zoom doit bel et bien agir sur la boîte écran (issue #179) — \
             sinon ce test ne prouve rien"
        );
        assert_eq!(
            a.s_ann, b.s_ann,
            "l'ancre des annotations a suivi le zoom : sans zoom {:?}, avec zoom {:?}",
            a.s_ann, b.s_ann
        );
        // Et sans zoom, l'ancre EST la boîte écran : `s_ann` ne doit pas devenir un rect
        // parallèle qui dériverait de `s_dst` pour d'autres raisons (padding, cover, crop).
        assert_eq!(a.s_ann, a.s_dst, "sans zoom, ancre et boîte écran coïncident");
    }

    /// La même scène, zoomée ET inclinée par un préset de rotation 3D.
    fn tilted_golden_scene() -> Scene {
        Scene::from_json(
            &zoomed_golden_scene_json().replace(r#""rotation":"none""#, r#""rotation":"iso""#),
        )
        .expect("tilted golden scene")
    }

    /// Le rect et la taille de police d'une annotation ne bougent ni sous le zoom ni sous
    /// une rotation 3D.
    ///
    /// `the_annotation_anchor_ignores_the_zoom` prouve que `plan_frame` **calcule** la
    /// bonne ancre ; il ne dit rien de ce que le backend en fait. Linux, lui, refaisait
    /// l'arithmétique contre `s_dst` — donc sous-titres qui grossissent et dérivent, sur
    /// la seule plateforme qui n'avait pas été corrigée. Ce test porte sur les fonctions
    /// que les backends appellent maintenant, pas sur le champ brut : la méthode côté
    /// Linux ET `annotation_dst_in`, par où passent Metal et D3D.
    ///
    /// Ce qu'il ne couvre toujours PAS : le choix du rect au call site de Metal et D3D,
    /// qui prennent leur ancre en paramètre. Ce niveau-là n'est vérifiable qu'en rendant
    /// des pixels — c'est `compose_linux_annotation_ancree_hors_zoom`, opt-in.
    ///
    /// La rotation compte autant que le zoom : un préset iso/left/right est une propriété
    /// de région de zoom, donc l'incliner amenait aussi la boîte — et les sous-titres
    /// partaient avec elle, sans pour autant suivre le plan incliné. Les deux symptômes,
    /// une seule cause.
    #[test]
    fn the_annotation_rect_and_font_ignore_zoom_and_rotation() {
        let cfg = crate::config::all().pop().expect("au moins une config");
        let rh = 658.0;
        // Un rect d'annotation quelconque, décentré : au centre, un rect qui suivrait le
        // zoom garderait le même centre et la moitié de l'erreur passerait inaperçue.
        let (x, y, w, h) = (0.04, 0.78, 0.92, 0.22);

        let plain = plan_frame(&golden_input(&golden_scene(), &cfg));
        let zoomed = plan_frame(&golden_input(&zoomed_golden_scene(), &cfg));
        let tilted = plan_frame(&golden_input(&tilted_golden_scene(), &cfg));

        // Le garde-fou : sans lui, un `plan_frame` qui cesserait d'appliquer le zoom
        // rendrait les assertions suivantes vraies pour la mauvaise raison.
        assert_ne!(
            plain.s_dst, zoomed.s_dst,
            "le zoom doit agir sur la boîte écran — sinon ce test ne prouve rien"
        );
        assert!(
            !crate::regions::is_identity_rotation(tilted.zoom_rotation),
            "le préset iso doit produire une rotation — sinon ce test ne prouve rien"
        );

        let expected = plain.annotation_dst(x, y, w, h);
        for (name, g) in [("zoom", &zoomed), ("rotation 3D", &tilted)] {
            let got = g.annotation_dst(x, y, w, h);
            assert_eq!(
                got, expected,
                "le rect de l'annotation a suivi le {name} : {got:?} au lieu de {expected:?}"
            );
            assert_eq!(
                g.annotation_anchor_h_px(rh),
                plain.annotation_anchor_h_px(rh),
                "la taille de police a suivi le {name}"
            );
            // Metal et D3D n'appellent pas la méthode : ils passent leur rect d'ancrage à
            // `annotation_dst_in`. Les deux chemins doivent rendre le MÊME rect, sinon le
            // « corrigé sur une plateforme seulement » recommence par le bas.
            assert_eq!(
                annotation_dst_in(g.s_ann, x, y, w, h),
                got,
                "le chemin des backends Metal/D3D diverge de la méthode sous le {name}"
            );
            // Et le garde-fou qui donne un sens aux deux précédents : nourrie avec `s_dst`,
            // la même fonction rend un rect DIFFÉRENT. Sans ça, un `annotation_dst_in`
            // devenu constant satisferait tout ce qui précède.
            assert_ne!(
                annotation_dst_in(g.s_dst, x, y, w, h),
                expected,
                "sous le {name}, ancrer sur `s_dst` devrait déplacer le rect — \
                 si les deux coïncident, ce test ne prouve plus rien"
            );
        }
    }

    /// **Le golden iso-render.**
    ///
    /// Les deux backends ne peuvent pas tourner sur la même machine, donc « iso avec
    /// D3D » ne peut pas être mesuré en comparant deux images rendues. Ce qui PEUT l'être,
    /// et qui est la couche où la divergence s'est effectivement produite, c'est la
    /// géométrie : `plan_frame` est le MÊME code des deux côtés, et ce test épingle ses 15
    /// sorties au bit près. Il tourne dans le job macOS ET dans le job Windows, donc si un
    /// jour les deux plateformes calculent des placements différents, l'un des deux vire au
    /// rouge — ce qui est exactement la garantie qu'on cherche.
    ///
    /// Ce que ce test ne couvre PAS, et qu'il ne faut pas lui faire dire : la rastérisation.
    /// D3D11 et Metal ne rendront jamais bit-à-bit identique (la PR #162 a mesuré 93-95 %
    /// de canaux identiques, écart max 3/255, entre deux backends sur la MÊME machine).
    /// La parité des shaders est tenue séparément, par le fait que `shaders.metal` et
    /// `shaders.hlsl` ont été diffés ligne à ligne sur les 14 modes.
    #[test]
    fn plan_frame_is_pinned_bit_for_bit() {
        let scene = golden_scene();
        let cfg = crate::config::all().pop().expect("au moins une config");
        let g = plan_frame(&golden_input(&scene, &cfg));
        let got = [
            g.s_dst[0], g.s_dst[1], g.s_dst[2], g.s_dst[3],
            g.w_dst[0], g.w_dst[1], g.w_dst[2], g.w_dst[3],
            g.cut[0], g.cut[1], g.cut[2], g.cut[3],
            g.s_radius, g.w_radius, g.w_px[0], g.w_px[1],
            g.frame_min_px, g.padding_scale, g.shape_fade, g.mb_taps, g.source_t,
        ];
        // Valeurs mesurées, pas devinées : toute dérive est une divergence à expliquer,
        // pas un seuil à relâcher.
        // Mesuré sur ce code, pas deviné : toute dérive est une divergence à expliquer,
        // pas un seuil à relâcher. Ordre : s_dst[4], w_dst[4], cut[4], s_radius, w_radius,
        // w_px[2], frame_min_px, padding_scale, shape_fade, mb_taps, source_t.
        let want: [f32; 21] = [
            0.10207555, 0.102, 0.7958489, 0.796,
            0.9058473, 0.8325926, 0.0733194, 0.13037036,
            0.0, 0.0, 0.61, 0.6055147,
            16.779, 42.89185, 85.7837, 85.7837,
            658.0, 0.796, 1.0, 6.25, 1.5,
        ];
        for (i, (a, b)) in got.iter().zip(want.iter()).enumerate() {
            assert_eq!(
                a.to_bits(),
                b.to_bits(),
                "sortie #{i} de plan_frame : {a} != {b}",
            );
        }
    }

    /// Le contrat cross-backend, verrouillé octet par octet. Un shader qui lit un champ
    /// décalé ne lève rien : il rend faux, en silence.
    #[test]
    fn layer_cb_matches_the_shader_constant_buffer() {
        use std::mem::{align_of, offset_of, size_of};
        assert_eq!(size_of::<LayerCB>(), 128);
        assert_eq!(align_of::<LayerCB>(), 16);
        for (name, got, want) in [
            ("dst", offset_of!(LayerCB, dst), 0),
            ("src", offset_of!(LayerCB, src), 16),
            ("quad_px", offset_of!(LayerCB, quad_px), 32),
            ("radius_px", offset_of!(LayerCB, radius_px), 40),
            ("mode", offset_of!(LayerCB, mode), 44),
            ("color", offset_of!(LayerCB, color), 48),
            ("fx", offset_of!(LayerCB, fx), 64),
            ("src_prev", offset_of!(LayerCB, src_prev), 80),
            ("dst_prev", offset_of!(LayerCB, dst_prev), 96),
            ("mb", offset_of!(LayerCB, mb), 112),
        ] {
            assert_eq!(got, want, "offset de `{name}`");
        }
    }

    /// Le pivot doit rester collé à `center` quand le sprite grandit — c'est exactement ce qui
    /// était cassé (ancrage centré en dur : la pointe s'éloignait proportionnellement à la
    /// taille). On dessine la même flèche à deux tailles et on vérifie que le point désigné
    /// ne bouge pas.
    #[test]
    fn sprite_hotspot_stays_on_target_at_any_size() {
        let center = [0.4, 0.6];
        let hotspot = [0.119, 0.0874]; // flèche intégrée : la pointe, près du coin haut-gauche

        for (w, h) in [(0.02, 0.04), (0.08, 0.16)] {
            let dst = cursor_sprite_dst(center, w, h, hotspot);
            let pivot = [dst[0] + dst[2] * hotspot[0], dst[1] + dst[3] * hotspot[1]];
            assert!((pivot[0] - center[0]).abs() < 1e-6, "x drifted at {w}x{h}: {pivot:?}");
            assert!((pivot[1] - center[1]).abs() < 1e-6, "y drifted at {w}x{h}: {pivot:?}");
            assert_eq!([dst[2], dst[3]], [w, h], "taille altérée");
        }

        // Et un pivot centré reste bien l'ancien comportement, pour les sprites qui le veulent
        // (viseur, I-beam, poignées de redimensionnement).
        assert_eq!(cursor_sprite_dst([0.5, 0.5], 0.2, 0.2, [0.5, 0.5]), [0.4, 0.4, 0.2, 0.2]);
    }
    fn assert_rect(actual: [f32; 4], expected: [f32; 4]) {
        for (actual, expected) in actual.into_iter().zip(expected) {
            assert!((actual - expected).abs() < 1e-6, "actual={actual}, expected={expected}");
        }
    }

    #[test]
    fn decodes_a_base64_data_uri() {
        // "Hi!" -> SGkh
        assert_eq!(decode_data_uri("data:image/png;base64,SGkh").unwrap(), b"Hi!".to_vec());
    }

    /// L'inspector stocke les couleurs de caption comme `couleur_hex` + `opacité` puis la
    /// bridge JS recombine en `rgba(r, g, b, a)` pour la preview. Le natif doit rendre la même
    /// plaque (couleur et opacité) — sinon le calque disparaît silencieusement et la caption
    /// n'apparaît qu'en texte brut dans l'export. C'était exactement le bug de l'issue #178.
    #[test]
    fn parse_hex_understands_rgba_caption_backgrounds() {
        let parsed = parse_hex("rgba(0, 0, 0, 0.55)").expect("rgba doit parser");
        assert!((parsed[3] - 0.55).abs() < 1e-6, "alpha 0.55 transmise, pas tombée à 0");
        assert_eq!([parsed[0], parsed[1], parsed[2]], [0.0, 0.0, 0.0]);
    }

    /// `rgb(...)` sans alpha est sémantiquement `rgba(..., 1)` — il faut le supporter pour
    /// qu'un inspector qui n'expose pas d'opacité n'écrive pas un fond invisible.
    #[test]
    fn parse_hex_treats_rgb_as_opaque() {
        let parsed = parse_hex("rgb(255, 128, 0)").expect("rgb doit parser");
        assert_eq!(parsed, [1.0, 128.0 / 255.0, 0.0, 1.0]);
    }

    /// Le cas "transparent" est documenté dans le code d'appel : on garde la sémantique
    /// historique (alpha 0) — la plaque est sautée côté rastérisation, ce qui est exactement ce
    /// que veut le CSS. Le nouveau parseur ne doit pas le casser.
    #[test]
    fn parse_hex_keeps_transparent_at_alpha_zero() {
        assert_eq!(parse_hex("transparent"), Some([0.0, 0.0, 0.0, 0.0]));
        // La casse ne doit pas non plus casser : CSS autorise `TRANSPARENT` en théorie, et
        // refuse une chaîne qui ressemble à un rgba mal formé.
        assert_eq!(parse_hex("Transparent"), Some([0.0, 0.0, 0.0, 0.0]));
        assert_eq!(parse_hex("rgba(0, 0, 0, 0)"), Some([0.0, 0.0, 0.0, 0.0]));
    }

    /// Le contrat historique `#rrggbb` / `rrggbb` ne doit pas régresser : les annotations
    /// normales (saisies via `ColorField`) ne passent que par ce chemin, et leurs snapshots
    /// ne pardonneraient pas un changement d'alpha implicite.
    #[test]
    fn parse_hex_still_understands_hex_colours() {
        assert_eq!(parse_hex("#fff"), Some([1.0, 1.0, 1.0, 1.0]));
        assert_eq!(parse_hex("#000000"), Some([0.0, 0.0, 0.0, 1.0]));
        assert_eq!(
            parse_hex("ff8800"),
            Some([1.0, 136.0 / 255.0, 0.0, 1.0])
        );
    }

    /// Hors-format (channel > 255, chaîne vide, named color) → None → l'appelant retombe sur
    /// son fallback. C'est la même politique qu'avant l'ajout du parseur rgba, on la garde
    /// explicite pour qu'elle ne dérive pas.
    #[test]
    fn parse_hex_rejects_malformed_colours() {
        assert_eq!(parse_hex(""), None);
        assert_eq!(parse_hex("not-a-color"), None);
        assert_eq!(parse_hex("rgba(256, 0, 0, 1)"), None); // canal >255
        assert_eq!(parse_hex("rgba(0, 0, 0, 1.5)"), None); // alpha >1
        assert_eq!(parse_hex("rgba(0, 0, 0, 0.5, 1)"), None); // 5 composantes
        assert_eq!(parse_hex("rgb(0, 0)"), None); // 2 composantes
    }

    /// CSS Color 4 : `rgb()` et `rgba()` sont synonymes, les deux prennent 3 ou 4 composantes.
    /// Une couleur bien formée ne doit pas finir sur le fallback de l'appelant — pour un fond
    /// c'est alpha 0, donc une plaque invisible, soit très exactement le symptôme de #178.
    #[test]
    fn parse_hex_accepts_both_arities_on_both_names() {
        assert_eq!(parse_hex("rgba(0, 0, 0)"), Some([0.0, 0.0, 0.0, 1.0]));
        assert_eq!(parse_hex("rgb(0, 0, 0, 0.5)"), Some([0.0, 0.0, 0.0, 0.5]));
    }

    /// Une couleur non-ASCII doit être refusée, pas paniquer : `strip_color_fn` découpait
    /// `s[..3]` / `s[..4]` sans vérifier la frontière de caractère, donc `#ab€cd` (le `€` occupe
    /// les octets 3..6) tuait le process au lieu de retomber sur le fallback. `parseWallpaper`
    /// laisse passer n'importe quelle chaîne préfixée `#` jusqu'ici, une panique côté natif
    /// traverserait le pont N-API et emporterait l'export.
    #[test]
    fn parse_hex_refuses_non_ascii_without_panicking() {
        assert_eq!(parse_hex("#ab€cd"), None);
        assert_eq!(parse_hex("rg€(0, 0, 0)"), None);
        assert_eq!(parse_hex("é"), None);
        assert_eq!(parse_hex("🎨🎨"), None);
        // Le chemin hex découpe par octet sur les longueurs 3 et 6 : `éa` fait 3 octets et
        // `€€` en fait 6, donc les deux tombaient pile sur une découpe intra-caractère.
        assert_eq!(parse_hex("éa"), None);
        assert_eq!(parse_hex("€€"), None);
    }

    #[test]
    fn ignores_padding_and_line_breaks_inside_the_payload() {
        // Un URI replié ou paddé doit décoder à l'identique : les caractères hors alphabet sont
        // sautés, donc ils ne peuvent pas décaler le flux.
        let folded = "data:image/png;base64,SGkh
==";
        assert_eq!(decode_data_uri(folded).unwrap(), b"Hi!".to_vec());
    }

    #[test]
    fn a_plain_path_is_not_a_data_uri() {
        // Le repli lecture-disque des wallpapers en dépend.
        assert!(decode_data_uri("/wallpapers/x.jpg").is_none());
        assert!(decode_data_uri("C:/img/y.png").is_none());
    }

    #[test]
    fn a_non_base64_data_uri_is_refused() {
        // `data:image/svg+xml,<svg…>` n'est pas du base64 : mieux vaut échouer que décoder du
        // texte comme des octets.
        assert!(decode_data_uri("data:image/svg+xml,<svg/>").is_none());
    }

    #[test]
    fn crop_maps_visible_frame_fractions_to_texture_uvs() {
        let crop = SceneCrop { x: 0.25, y: 0.1, width: 0.5, height: 0.6 };
        assert_rect(screen_source_rect(0.8, 0.9, None, 1.0, [0.2, 0.7]), [0.0, 0.0, 0.8, 0.9]);
        assert_rect(screen_source_rect(0.8, 0.9, Some(crop), 1.0, [0.5, 0.5]), [0.2, 0.09, 0.6, 0.63]);
    }

    #[test]
    fn zoom_focus_is_applied_inside_the_crop() {
        let crop = SceneCrop { x: 0.25, y: 0.1, width: 0.5, height: 0.6 };
        assert_rect(screen_source_rect(0.8, 0.9, Some(crop), 2.0, [0.5, 0.5]), [0.3, 0.225, 0.5, 0.495]);
        assert_rect(screen_source_rect(0.8, 0.9, Some(crop), 2.0, [1.0, 1.0]), [0.4, 0.36, 0.6, 0.63]);
    }

    // --- le zoom rendu à la boîte (issue #179) ------------------------------
    // Le zoom déplace et agrandit la boîte au lieu de rétrécir la coupe. Deux choses à
    // figer, et elles tirent en sens inverse : la boîte DOIT déborder le padding (l'issue),
    // et le mapping image→écran ne doit PAS bouger (tout le reste du compositeur en
    // dépend). Une version antérieure de ce correctif protégeait si bien le second qu'elle
    // annulait le premier dès que le focus n'était pas centré — d'où le balayage sur des
    // focus décentrés dans les deux tests.

    /// Boîte paddée (padding 50 % → `scale_frame` 0.8) dans une sortie carrée : le cas
    /// plein cadre de l'issue.
    const PADDED: [f32; 4] = [0.1, 0.1, 0.8, 0.8];

    /// Les zooms d'un preset (`ZOOM_DEPTH_SCALES`, TS) et des focus réalistes — dont des
    /// focus très décentrés, que le suivi de curseur produit en permanence.
    const ZOOMS: [f32; 6] = [1.0, 1.25, 1.5, 1.8, 2.2, 3.5];
    const FOCUSES: [[f32; 2]; 6] = [
        [0.5, 0.5],
        [0.3, 0.5],
        [0.5, 0.8],
        [0.15, 0.9],
        [0.85, 0.2],
        [0.0, 1.0],
    ];

    /// Le couple (boîte, coupe) réellement envoyé au GPU. `u_max`/`v_max` à 1 et pas de
    /// crop : la coupe est donc directement en fractions d'image.
    fn drawn(base: [f32; 4], zoom: f32, focus: [f32; 2]) -> ([f32; 4], [f32; 4]) {
        let cut_ref = screen_source_rect(1.0, 1.0, None, zoom, focus);
        let cut = screen_source_rect(1.0, 1.0, None, 1.0, focus);
        (remap_box(base, cut_ref, cut), cut)
    }

    /// Où un point de l'image atterrit à l'écran, en fraction du CADRE.
    fn on_screen(base: [f32; 4], zoom: f32, focus: [f32; 2], point: [f32; 2]) -> [f32; 2] {
        let (dst, src) = drawn(base, zoom, focus);
        let at = |f: f32, s0: f32, s1: f32, d0: f32, dw: f32| d0 + dw * (f - s0) / (s1 - s0);
        [
            at(point[0], src[0], src[2], dst[0], dst[2]),
            at(point[1], src[1], src[3], dst[1], dst[3]),
        ]
    }

    /// Le mapping d'avant : la coupe zoomée remplissait la boîte paddée, sans la bouger.
    fn on_screen_before(base: [f32; 4], zoom: f32, focus: [f32; 2], point: [f32; 2]) -> [f32; 2] {
        let src = screen_source_rect(1.0, 1.0, None, zoom, focus);
        let at = |f: f32, s0: f32, s1: f32, d0: f32, dw: f32| d0 + dw * (f - s0) / (s1 - s0);
        [
            at(point[0], src[0], src[2], base[0], base[2]),
            at(point[1], src[1], src[3], base[1], base[3]),
        ]
    }

    /// L'invariant : rendre le zoom à la boîte ne déplace AUCUN point de l'image — même
    /// grossissement, même cadrage. Seule l'étendue dessinée change.
    #[test]
    fn handing_the_zoom_to_the_box_moves_no_pixel() {
        for &zoom in &ZOOMS {
            for &focus in &FOCUSES {
                for &point in &[[0.5, 0.5], [0.0, 0.0], [1.0, 1.0], [0.25, 0.75]] {
                    let (was, now) = (
                        on_screen_before(PADDED, zoom, focus, point),
                        on_screen(PADDED, zoom, focus, point),
                    );
                    assert!(
                        (was[0] - now[0]).abs() < 1e-4 && (was[1] - now[1]).abs() < 1e-4,
                        "point {point:?} déplacé (zoom {zoom}, focus {focus:?}) : {was:?} → {now:?}"
                    );
                }
            }
        }
    }

    /// Ce que l'issue demande, et la régression que le testeur a vue : dès qu'on zoome, la
    /// boîte doit déborder le rect paddé — y compris (surtout) avec un focus décentré.
    #[test]
    fn any_zoom_overflows_the_padding() {
        for &zoom in &ZOOMS {
            for &focus in &FOCUSES {
                let (dst, _) = drawn(PADDED, zoom, focus);
                let grew = dst[2] / PADDED[2];
                assert!(
                    (grew - zoom).abs() < 1e-4,
                    "la boîte n'a pas pris le zoom (zoom {zoom}, focus {focus:?}) : ×{grew}"
                );
                if zoom > 1.0 {
                    // Elle dépasse le rect paddé d'au moins un bord, donc mange du padding.
                    assert!(
                        dst[0] < PADDED[0] - 1e-6 || dst[0] + dst[2] > PADDED[0] + PADDED[2] + 1e-6,
                        "boîte encore dans le padding (zoom {zoom}, focus {focus:?}) : {dst:?}"
                    );
                }
            }
        }
        // Focus centré : le padding disparaît des QUATRE côtés dès que le zoom suffit à
        // couvrir le cadre (ici 1/0.8 = 1.25).
        let (dst, _) = drawn(PADDED, 1.25, [0.5, 0.5]);
        assert_rect(dst, [0.0, 0.0, 1.0, 1.0]);
        // Sans padding il n'y a rien à déborder, mais la boîte porte quand même le zoom.
        let (dst, _) = drawn([0.0, 0.0, 1.0, 1.0], 2.0, [0.5, 0.5]);
        assert_rect(dst, [-0.5, -0.5, 2.0, 2.0]);
    }

    // --- cover_crop_uv : la caméra n'est jamais étirée --------------------
    // Le ratio de la coupe source, ramené en pixels d'image, doit TOUJOURS égaler
    // celui de la boîte : c'est la définition de « pas de déformation ».

    /// Ratio largeur/hauteur de la coupe, exprimé en pixels de l'image source.
    fn crop_aspect(uv: (f32, f32, f32, f32), tex: [f32; 2]) -> f32 {
        ((uv.2 - uv.0) * tex[0]) / ((uv.3 - uv.1) * tex[1])
    }

    /// L'invariant, balayé sur des boîtes très diverses — dont le slot en colonne
    /// du preset side-by-side, qui est précisément le cas qui étirait la caméra.
    #[test]
    fn cover_crop_never_distorts_whatever_the_destination_box() {
        let tex = [1024.0, 1024.0];
        for &cam in &[[1280.0, 720.0], [960.0, 720.0], [640.0, 480.0]] {
            for &box_ar in &[0.35, 0.5, 0.75, 1.0, 16.0 / 9.0, 2.4] {
                let uv = cover_crop_uv(cam, tex, box_ar);
                let got = crop_aspect(uv, tex);
                assert!(
                    (got - box_ar).abs() < 1e-3,
                    "cam {cam:?} boite {box_ar} → coupe de ratio {got}, attendu {box_ar}",
                );
            }
        }
    }

    /// La coupe reste DANS l'image visible et centrée — on ne va jamais chercher
    /// le padding décodeur au-delà de `visible`, qui contient des pixels indéfinis.
    #[test]
    fn cover_crop_stays_inside_the_visible_frame_and_is_centred() {
        let (cam, tex) = ([1280.0, 720.0], [2048.0, 1024.0]);
        for &box_ar in &[0.35, 1.0, 2.4] {
            let (u0, v0, u1, v1) = cover_crop_uv(cam, tex, box_ar);
            assert!(u0 >= 0.0 && v0 >= 0.0, "coupe hors image: {u0},{v0}");
            assert!(u1 <= cam[0] / tex[0] + 1e-6, "u1 {u1} deborde la largeur visible");
            assert!(v1 <= cam[1] / tex[1] + 1e-6, "v1 {v1} deborde la hauteur visible");
            let (mx, my) = (u0 + u1, v0 + v1);
            assert!((mx - cam[0] / tex[0]).abs() < 1e-6, "pas centre en x");
            assert!((my - cam[1] / tex[1]).abs() < 1e-6, "pas centre en y");
        }
    }

    /// L'écran en layout bloc : le cover s'applique au rect DÉJÀ réduit par le crop
    /// et le zoom. Quel que soit ce rect de départ, ce qui atterrit dans la boîte a
    /// le ratio de la boîte — c'est ce qui empêche l'étirement.
    #[test]
    fn cover_uv_rect_gives_the_box_aspect_whatever_the_crop_and_zoom_left() {
        let tex = [2048.0, 1024.0];
        // rects source plausibles : plein cadre, bande verticale (crop portrait), zoom serré
        for &uv in &[
            [0.0, 0.0, 0.9375, 0.7031],
            [0.41, 0.04, 0.55, 0.67],
            [0.30, 0.20, 0.55, 0.45],
        ] {
            for &box_ar in &[0.4, 0.75, 1.0, 1.9, 3.2] {
                let out = cover_uv_rect(uv, tex, box_ar);
                let got = ((out[2] - out[0]) * tex[0]) / ((out[3] - out[1]) * tex[1]);
                assert!(
                    (got - box_ar).abs() / box_ar < 1e-3,
                    "uv {uv:?} boite {box_ar} -> ratio {got}",
                );
                // le cover RÉDUIT : il ne va jamais chercher des pixels hors du rect source
                assert!(out[0] >= uv[0] - 1e-6 && out[1] >= uv[1] - 1e-6, "deborde en haut/gauche");
                assert!(out[2] <= uv[2] + 1e-6 && out[3] <= uv[3] + 1e-6, "deborde en bas/droite");
            }
        }
    }

    /// Propriété de sûreté : quand la boîte a DÉJÀ le ratio de la source (tous les
    /// placements qui étaient corrects — PiP par défaut, vertical-stack, et le
    /// center-crop carré de square/circle), la coupe est la frame entière. Le
    /// correctif ne peut donc pas déplacer un pixel de ces cas-là.
    #[test]
    fn cover_crop_is_the_whole_frame_when_the_box_already_matches() {
        let (cam, tex) = ([1280.0, 720.0], [2048.0, 1024.0]);
        let uv = cover_crop_uv(cam, tex, cam[0] / cam[1]);
        assert!((uv.0).abs() < 1e-6 && (uv.1).abs() < 1e-6);
        assert!((uv.2 - cam[0] / tex[0]).abs() < 1e-6);
        assert!((uv.3 - cam[1] / tex[1]).abs() < 1e-6);
        // et une boîte carrée sur une source 4:3 redonne bien le center-crop carré
        // que l'ancien branchement `is_square_shape` codait à la main.
        let (su0, _, su1, _) = cover_crop_uv([960.0, 720.0], tex, 1.0);
        assert!((su0 - (960.0 - 720.0) * 0.5 / tex[0]).abs() < 1e-6);
        assert!((su1 - (960.0 + 720.0) * 0.5 / tex[0]).abs() < 1e-6);
    }

    #[test]
    fn webcam_crop_identity_keeps_the_full_visible_frame() {
        let uv = webcam_source_rect([1280.0, 720.0], [2048.0, 1024.0], None, 16.0 / 9.0);
        assert_rect(uv, [0.0, 0.0, 1280.0 / 2048.0, 720.0 / 1024.0]);
    }

    #[test]
    fn webcam_crop_applies_authored_zoom_and_pan_before_layout_cover() {
        let crop = SceneCrop {
            x: 0.25,
            y: 0.20,
            width: 0.50,
            height: 0.60,
        };
        let uv = webcam_source_rect([100.0, 100.0], [100.0, 100.0], Some(crop), 0.50 / 0.60);
        assert_rect(uv, [0.25, 0.20, 0.75, 0.80]);
    }
}
