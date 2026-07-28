//! Compositeur D3D11 : rend les calques dans un render target RGBA8, un draw par quad.
//! NV12 échantillonné depuis les textures décodeur (SRV par plan), effets en HLSL (§7).

use crate::config::Cfg;
use crate::cursor::CursorTrack;
use crate::scene::{Scene, SceneBackground, SceneCrop, SceneCursorSprite};
use crate::d3d::Gpu;
use crate::ffi::AVFrame;
use anyhow::{bail, Result};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use windows::core::{Interface, PCSTR};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::{
    ID3DBlob, D3D11_SRV_DIMENSION_TEXTURE2DARRAY, D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP,
};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;

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
fn decode_data_uri(uri: &str) -> Option<Vec<u8>> {
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

fn parse_hex(s: &str) -> Option<[f32; 4]> {
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
fn strip_color_fn<'a>(s: &'a str, name: &str) -> Option<&'a str> {
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
fn parse_rgb_components(s: &str) -> Option<[f32; 4]> {
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

fn parse_color_channel(raw: &str, max: f32) -> Option<f32> {
    let n: f32 = raw.parse().ok()?;
    if !n.is_finite() || n < 0.0 || n > max {
        return None;
    }
    Some(n / max)
}

/// Rect source après crop puis zoom, dans les UV de la texture D3D. `u_max`/`v_max`
/// excluent le padding NV12 ; le crop reste donc exprimé dans le frame visible (0..1),
/// comme `VirtualPreview.cropVideoStyle`, puis le focus du zoom est remappé dans ce crop.
fn screen_source_rect(
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
fn remap_box(base: [f32; 4], cut_ref: [f32; 4], cut: [f32; 4]) -> [f32; 4] {
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
fn cover_crop_uv(visible: [f32; 2], tex: [f32; 2], box_ar: f32) -> (f32, f32, f32, f32) {
    let (cam_w, cam_h) = (visible[0].max(1.0), visible[1].max(1.0));
    let (tex_w, tex_h) = (tex[0].max(1.0), tex[1].max(1.0));
    let full = [0.0, 0.0, cam_w / tex_w, cam_h / tex_h];
    let [u0, v0, u1, v1] = cover_uv_rect(full, tex, box_ar);
    (u0, v0, u1, v1)
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
fn cover_uv_rect(uv: [f32; 4], tex: [f32; 2], box_ar: f32) -> [f32; 4] {
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

/// Constant buffer d'un calque (doit matcher `cbuffer Layer` du HLSL, 64 octets).
#[repr(C)]
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
    /// that case duplicates the screen video into its own corner. Live-only: derived in
    /// `live.rs` by comparing the active clip's screen/webcam paths; defaults `true` (draw)
    /// so fixture/bench renders and any caller that never sets it keep their old behavior.
    pub has_webcam: bool,
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

pub struct Compositor {
    dev: ID3D11Device,
    ctx: ID3D11DeviceContext,
    rt: ID3D11Texture2D,
    rtv: ID3D11RenderTargetView,
    rt_srv: ID3D11ShaderResourceView,
    staging: ID3D11Texture2D,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    vs_fs: ID3D11VertexShader,
    ps_y: ID3D11PixelShader,
    ps_uv: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    cbuf: ID3D11Buffer,
    blend: ID3D11BlendState,
    blend_none: ID3D11BlendState,
    nv12: ID3D11Texture2D, // notre NV12 simple (RT), source de la copie vers le pool encodeur
    rtv_y: ID3D11RenderTargetView,
    rtv_uv: ID3D11RenderTargetView,
    // ping-pong demi-résolution pour le flou séparable (§7 E3)
    ps_blur: ID3D11PixelShader,
    ps_tex: ID3D11PixelShader,
    half_a_rtv: ID3D11RenderTargetView,
    half_a_srv: ID3D11ShaderResourceView,
    half_b_rtv: ID3D11RenderTargetView,
    half_b_srv: ID3D11ShaderResourceView,
    // dual-Kawase : chaîne quart (480x270) + huitième (240x135)
    ps_kdown: ID3D11PixelShader,
    ps_kup: ID3D11PixelShader,
    q_rtv: ID3D11RenderTargetView,
    q_srv: ID3D11ShaderResourceView,
    e_rtv: ID3D11RenderTargetView,
    e_srv: ID3D11ShaderResourceView,
    /// Copie pleine réso de l'image composée, pour les annotations de type flou : on ne peut pas
    /// échantillonner le render target sur lequel on dessine, donc on le recopie ici d'abord.
    /// Distincte de `accum` à dessein — `accum` sert au motion blur, qui appelle `compose_frame`
    /// plusieurs fois par frame et dont l'accumulation serait écrasée.
    ann_copy: ID3D11Texture2D,
    ann_copy_srv: ID3D11ShaderResourceView,
    // accumulateur pour le flou de mouvement (supersampling temporel)
    accum: ID3D11Texture2D,
    accum_rtv: ID3D11RenderTargetView,
    accum_srv: ID3D11ShaderResourceView,
    blend_add: ID3D11BlendState,
    /// RefCell (pas un simple champ) pour que `set_cursor` reste `&self`, comme `set_scene` /
    /// `set_live_params` — nécessaire pour le rebrancher par clip dans l'export multiclip, qui
    /// n'a qu'une référence partagée au `Compositor`.
    cursor: RefCell<Option<CursorTrack>>,
    /// Override du temps d'échantillonnage curseur (secondes) — `None` = comportement fixture
    /// (`frame / FPS`). L'export multiclip et le live le positionnent au PTS écran courant,
    /// c'est-à-dire au temps source absolu du clip actif.
    cursor_t_override: RefCell<Option<f32>>,
    /// Override du temps des zoom/full-camera regions (secondes source du clip actif). Le nom
    /// `timeline_t_override` est conservé pour l'API existante, mais ce temps n'est plus cumulé
    /// entre clips : les régions projetées par l'app portent elles aussi des temps source.
    /// Séparé de l'override curseur pour préserver les chemins fixture sans télémétrie.
    timeline_t_override: RefCell<Option<f32>>,
    // cache des SRV décodeur par (texture array, slice) : le pool réutilise ~32 textures,
    // donc après warmup plus aucune création de SRV par frame (overhead CPU supprimé).
    srv_cache: RefCell<HashMap<(usize, u32), (ID3D11ShaderResourceView, ID3D11ShaderResourceView)>>,
    live_params: RefCell<LiveParams>,
    /// Scène pilotée par l'app (contrat) : quand présente, remplace le layout fixture de
    /// `timeline()`. Voir `scene.rs` / `SceneDescription` (TS).
    scene: RefCell<Option<Scene>>,
    /// Rastériseur de texte (Direct2D/DirectWrite). `Option` parce qu'un échec d'init des
    /// fabriques ne doit pas empêcher tout le compositeur de tourner : sans lui, les annotations
    /// texte sont simplement absentes, comme avant.
    text_raster: Option<crate::text::TextRasterizer>,
    /// Cache des textures de texte, indexé sur l'ID d'annotation. La `u64` est la clé de contenu
    /// (`TextSpec::cache_key`) : on ne re-rastérise que si elle change, donc jamais pour un
    /// déplacement ou une animation.
    text_cache: RefCell<HashMap<String, (ID3D11ShaderResourceView, u64)>>,
    /// Cache des textures d'annotation image, indexé sur l'ID d'annotation (SRV, w, h, longueur
    /// de la source). Séparé de `img_cache` : les wallpapers sont des chemins disque, ces images
    /// des data URL de plusieurs Mo qu'on ne veut pas utiliser comme clés de hachage.
    ann_img_cache: RefCell<HashMap<String, (ID3D11ShaderResourceView, u32, u32, usize)>>,
    /// Cache des textures wallpaper image (clé = chemin absolu) : décodage/upload une seule
    /// fois, puis réutilisées par frame. (SRV, largeur, hauteur).
    img_cache: RefCell<HashMap<String, (ID3D11ShaderResourceView, u32, u32)>>,
    /// Dimensions du RENDER TARGET en pixels — la taille à laquelle `compose_frame`
    /// rastérise réellement, et donc le dénominateur de TOUTE conversion
    /// normalisé↔px de ce fichier.
    ///
    /// Historiquement c'était la constante `OUT_W`×`OUT_H` : un canvas 16:9 figé,
    /// étiré en fin de pipeline vers la vraie sortie. Cette constante produisait
    /// deux défauts distincts, tous deux issus d'elle seule :
    ///   - une **forme** fausse dès que la sortie n'est pas 16:9 → rattrapée en
    ///     aval par `apply_undistort` (9 correctifs successifs sur l'écran, la
    ///     webcam, le curseur, les ombres, les coins, le crop, le fond) ;
    ///   - une **résolution** plafonnée → jamais rattrapée, parce qu'aucun
    ///     correctif au niveau du calque ne peut recréer des pixels qui n'ont pas
    ///     été rastérisés (un export 4K était du 1080p agrandi).
    ///
    /// Rendre cette taille variable retire la cause commune. `OUT_W`/`OUT_H` ne
    /// sont plus qu'une valeur par défaut, jamais une référence géométrique.
    render_size: Cell<(u32, u32)>,
    /// Ressources de resize export (allouées paresseusement à la 1re taille de sortie ≠
    /// OUT_W×OUT_H — le live et les exports "Source"/1080p restent sur `rgb_to_nv12` inchangé,
    /// zéro coût). Voir `rgb_to_nv12_scaled`.
    resize_target: RefCell<Option<ResizeTarget>>,
    /// Cache de la staging texture de readback live, dimensionnée à la dernière taille
    /// de prévisualisation demandée (variable, contrairement au `staging` fixe à
    /// OUT_W×OUT_H). Recréée quand la taille change — voir `readback_resized`.
    live_readback_staging: RefCell<Option<(u32, u32, ID3D11Texture2D)>>,
    /// Staging NV12 du readback d'ENCODAGE (backend CPU) — même motif de cache par taille
    /// que `live_readback_staging`, mais en NV12 et non en RGBA : l'encodeur logiciel veut
    /// les plans Y/UV, pas des pixels RGBA. Voir `read_nv12_scaled`.
    nv12_readback_staging: RefCell<Option<(u32, u32, ID3D11Texture2D)>>,
}

/// Ressources d'un resize export à une taille cible : RGBA intermédiaire (résultat du
/// redimensionnement bilinéaire du RT composé, toujours rendu en interne à OUT_W×OUT_H) +
/// sa propre texture NV12 à cette même taille cible (le NV12 principal du `Compositor` reste
/// fixé à OUT_W×OUT_H, partagé par le live).
struct ResizeTarget {
    w: u32,
    h: u32,
    rgba_rtv: ID3D11RenderTargetView,
    rgba_srv: ID3D11ShaderResourceView,
    nv12: ID3D11Texture2D,
    nv12_rtv_y: ID3D11RenderTargetView,
    nv12_rtv_uv: ID3D11RenderTargetView,
}

pub const HALF_W: u32 = OUT_W / 2;
pub const HALF_H: u32 = OUT_H / 2;

pub const FIXTURE_FRAMES: u32 = 360;
const FPS: f32 = 60.0;

/// Longueurs de style exprimées en FRACTION du petit côté du cadre, et non en pixels.
///
/// Elles étaient écrites en px bruts au point d'appel, ce qui voulait dire « px du render
/// target » — donc une proportion DIFFÉRENTE selon la taille de rendu : 40 px, c'est 3,7 % d'un
/// cadre 1080 mais 1,9 % d'un 2160. L'ombre était donc deux fois plus douce en preview qu'à
/// l'export, et un export 4K la recevait deux fois plus faible qu'un 1080p — même famille de bug
/// que les rayons venus de l'app, mais née à l'intérieur du natif. Les valeurs ci-dessous sont
/// les anciennes constantes rapportées au cadre 1080 contre lequel elles avaient été réglées :
/// le rendu à cette résolution est donc inchangé, et devient enfin identique partout ailleurs.
const SHADOW_TUNING_REF_PX: f32 = 1080.0;
const SCREEN_SHADOW_SPREAD_FRAC: f32 = 40.0 / SHADOW_TUNING_REF_PX;
const SCREEN_SHADOW_OFFSET_FRAC: f32 = 16.0 / SHADOW_TUNING_REF_PX;
const WEBCAM_SHADOW_SPREAD_FRAC: f32 = 32.0 / SHADOW_TUNING_REF_PX;
const WEBCAM_SHADOW_OFFSET_FRAC: f32 = 12.0 / SHADOW_TUNING_REF_PX;
/// Opacité FIXE de l'ombre portée de la caméra (layout PiP uniquement). Contrairement à
/// l'ombre de l'écran — dont l'opacité est pilotée par le slider Shadow (`shadow_scale`) —
/// l'ombre de la caméra est une ombre légère NON paramétrable : même valeur quelle que soit
/// la position du slider. Parité avec le preset PiP côté web (`compositeLayout.ts`,
/// `rgba(0,0,0,0.35)`), dont l'ombre est elle aussi un forfait fixe et PiP-only.
const WEBCAM_SHADOW_OPACITY: f32 = 0.35;
/// Taille de base du curseur, même convention (34 px réglés contre un cadre 1080).
const CURSOR_BASE_SIZE_FRAC: f32 = 34.0 / SHADOW_TUNING_REF_PX;

/// Rect [x,y,w,h] normalisé d'un sprite de curseur de taille `w`×`h` dont le pivot `hotspot`
/// (fraction 0..1 de l'image) doit tomber exactement sur `center`.
///
/// L'invariant est que `center` reste sur le pixel désigné QUELLE QUE SOIT la taille : le
/// décalage grandit avec le sprite, donc il doit être une fraction de `w`/`h` et pas une
/// constante. Un pivot centré en dur (0.5) laissait la pointe dériver de plus en plus loin de
/// la zone visée à mesure qu'on agrandissait le curseur.
fn cursor_sprite_dst(center: [f32; 2], w: f32, h: f32, hotspot: [f32; 2]) -> [f32; 4] {
    [center[0] - w * hotspot[0], center[1] - h * hotspot[1], w, h]
}

/// Où poser le curseur, et dans quel repère.
///
/// Le curseur remplace un pointeur qui faisait partie de l'image capturée, donc il vit SUR la
/// surface de l'écran, pas dans un calque au-dessus. Quand cet écran est incliné en 3D, ce n'est
/// donc pas seulement sa position qu'il faut projeter mais son sprite entier : autrement il se
/// lit comme un autocollant plat posé sur une scène en perspective.
#[derive(Clone, Copy)]
enum CursorPlacement {
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
    fn lerp(self, other: CursorPlacement, f: f32) -> CursorPlacement {
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
    fn upright_center(self) -> [f32; 2] {
        match self {
            CursorPlacement::Upright { center } => center,
            CursorPlacement::Tilted { plane_pt, quad, center_px, render_px, .. } => {
                let (px, py) = quad.point_px(plane_pt[0], plane_pt[1]);
                [(center_px[0] + px) / render_px[0], (center_px[1] + py) / render_px[1]]
            }
        }
    }
}

fn ease_in_out_cubic(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x < 0.5 {
        4.0 * x * x * x
    } else {
        1.0 - (-2.0 * x + 2.0).powi(3) / 2.0
    }
}
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
fn lerp4(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
    [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)]
}

/// Un calque vidéo animé (rect sortie, taille px, rayon) — screen ou webcam.
#[derive(Clone, Copy)]
struct Placement {
    dst: [f32; 4],
    radius: f32,
}

/// Paramètres d'une frame : dérivés du temps par la timeline (§8).
#[derive(Clone, Copy)]
struct FrameParams {
    zoom: f32,
    focus: [f32; 2],
    screen: Placement,
    webcam: Placement, // dst carré (w en px via OUT_W)
}

/// Timeline figée de la fixture (6 s) : zoom 1.0→1.8→1.0, layout A(PIP)↔B(côte à côte).
/// `frame` fractionnaire pour permettre le supersampling temporel (flou de mouvement).
/// Gaté par `cfg` : zoom et layout ne bougent que si activés.
fn timeline(frame: f32, cfg: &Cfg) -> FrameParams {
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
fn preset_placements(preset: &str) -> FrameParams {
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

unsafe fn compile(src: &[u8], entry: &[u8], target: &[u8]) -> Result<ID3DBlob> {
    let mut code: Option<ID3DBlob> = None;
    let mut err: Option<ID3DBlob> = None;
    let r = D3DCompile(
        src.as_ptr() as *const c_void,
        src.len(),
        PCSTR::null(),
        None,
        None,
        PCSTR(entry.as_ptr()),
        PCSTR(target.as_ptr()),
        D3DCOMPILE_OPTIMIZATION_LEVEL3,
        0,
        &mut code,
        Some(&mut err),
    );
    if r.is_err() {
        if let Some(e) = err {
            let msg = std::slice::from_raw_parts(
                e.GetBufferPointer() as *const u8,
                e.GetBufferSize(),
            );
            bail!("D3DCompile {}: {}", String::from_utf8_lossy(entry), String::from_utf8_lossy(msg));
        }
        bail!("D3DCompile a échoué");
    }
    Ok(code.unwrap())
}

impl Compositor {
    /// Compositeur à la taille de rendu par défaut (`OUT_W`×`OUT_H`).
    /// Préférer `new_sized` dès qu'on connaît la géométrie de sortie réelle.
    pub fn new(gpu: &Gpu) -> Result<Compositor> {
        Self::new_sized(gpu, OUT_W, OUT_H)
    }

    /// Compositeur rastérisant à `w`×`h`.
    ///
    /// La taille de rendu est fixée à la construction plutôt que mutable à chaud :
    /// la rendre variable imposerait de passer le RT, la NV12, la staging et toute
    /// la pyramide de flou en `RefCell`, donc d'ajouter de la mutabilité intérieure
    /// sur le chemin GPU chaud — pour un événement qui n'arrive quasiment jamais
    /// (l'utilisateur change de ratio, ou on bascule preview↔export). L'appelant
    /// reconstruit le compositeur quand la sortie change ; c'est quelques dizaines
    /// de ms, sur un changement rare.
    ///
    /// Les dimensions passées sont arrondies via `normalize_render_size` (pair,
    /// ≥2 — contrainte NV12). L'appelant qui décide de reconstruire DOIT comparer
    /// sa taille voulue à `normalize_render_size(...)` et non à la valeur brute :
    /// sinon une cible impaire ne serait jamais atteinte par `render_size()` (qui
    /// renvoie la valeur arrondie), et le compositeur se reconstruirait à chaque
    /// frame. C'est justement pour rendre cette règle partageable qu'elle est une
    /// fonction publique et non un calcul enfoui ici.
    pub fn new_sized(gpu: &Gpu, w: u32, h: u32) -> Result<Compositor> {
        let (w, h) = Self::normalize_render_size(w, h);
        unsafe { Self::new_inner(gpu, w, h) }
    }

    /// Arrondit une taille de rendu voulue à ce qu'un render target peut réellement
    /// être : au pair supérieur (la texture NV12 est en 4:2:0, chroma
    /// sous-échantillonnée 2×2, et `CreateTexture2D` refuse une dimension impaire),
    /// jamais sous 2. UNE seule définition de la règle, appelée par `new_sized`
    /// (côté production de la taille) et par la boucle de preview (côté décision de
    /// reconstruire) — les deux ne peuvent donc pas diverger.
    pub fn normalize_render_size(w: u32, h: u32) -> (u32, u32) {
        (((w.max(2) + 1) & !1), ((h.max(2) + 1) & !1))
    }

    unsafe fn new_inner(gpu: &Gpu, out_w: u32, out_h: u32) -> Result<Compositor> {
        let dev = gpu.device.clone();
        let ctx = gpu.context.clone();

        // --- render target RGBA8 (gamma natif de la vidéo ; voir note couleur docs) ---
        let mut td = D3D11_TEXTURE2D_DESC {
            Width: out_w,
            Height: out_h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut rt: Option<ID3D11Texture2D> = None;
        dev.CreateTexture2D(&td, None, Some(&mut rt))?;
        let rt = rt.unwrap();
        let mut rtv: Option<ID3D11RenderTargetView> = None;
        dev.CreateRenderTargetView(&rt, None, Some(&mut rtv))?;
        let mut rt_srv: Option<ID3D11ShaderResourceView> = None;
        dev.CreateShaderResourceView(&rt, None, Some(&mut rt_srv))?;

        // staging pour readback PNG
        td.Usage = D3D11_USAGE_STAGING;
        td.BindFlags = 0;
        td.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging: Option<ID3D11Texture2D> = None;
        dev.CreateTexture2D(&td, None, Some(&mut staging))?;

        // --- shaders ---
        let hlsl = include_bytes!("shaders.hlsl");
        let vsb = compile(hlsl, b"vs_main\0", b"vs_5_0\0")?;
        let psb = compile(hlsl, b"ps_main\0", b"ps_5_0\0")?;
        let vs_bytes =
            std::slice::from_raw_parts(vsb.GetBufferPointer() as *const u8, vsb.GetBufferSize());
        let ps_bytes =
            std::slice::from_raw_parts(psb.GetBufferPointer() as *const u8, psb.GetBufferSize());
        let mut vs: Option<ID3D11VertexShader> = None;
        dev.CreateVertexShader(vs_bytes, None, Some(&mut vs))?;
        let mut ps: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(ps_bytes, None, Some(&mut ps))?;

        // shaders RGB->NV12
        let fsb = compile(hlsl, b"vs_fs\0", b"vs_5_0\0")?;
        let yb = compile(hlsl, b"ps_y\0", b"ps_5_0\0")?;
        let uvb = compile(hlsl, b"ps_uv\0", b"ps_5_0\0")?;
        let fs_bytes =
            std::slice::from_raw_parts(fsb.GetBufferPointer() as *const u8, fsb.GetBufferSize());
        let y_bytes =
            std::slice::from_raw_parts(yb.GetBufferPointer() as *const u8, yb.GetBufferSize());
        let uv_bytes =
            std::slice::from_raw_parts(uvb.GetBufferPointer() as *const u8, uvb.GetBufferSize());
        let mut vs_fs: Option<ID3D11VertexShader> = None;
        dev.CreateVertexShader(fs_bytes, None, Some(&mut vs_fs))?;
        let mut ps_y: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(y_bytes, None, Some(&mut ps_y))?;
        let mut ps_uv: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(uv_bytes, None, Some(&mut ps_uv))?;

        // --- sampler bilinéaire clamp ---
        let sd = D3D11_SAMPLER_DESC {
            Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
            AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
            ComparisonFunc: D3D11_COMPARISON_NEVER,
            MaxLOD: f32::MAX,
            ..Default::default()
        };
        let mut sampler: Option<ID3D11SamplerState> = None;
        dev.CreateSamplerState(&sd, Some(&mut sampler))?;

        // --- constant buffer dynamique ---
        let bd = D3D11_BUFFER_DESC {
            ByteWidth: std::mem::size_of::<LayerCB>() as u32,
            Usage: D3D11_USAGE_DYNAMIC,
            BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
            CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
            ..Default::default()
        };
        let mut cbuf: Option<ID3D11Buffer> = None;
        dev.CreateBuffer(&bd, None, Some(&mut cbuf))?;

        // --- blend alpha prémultiplié ---
        let mut bl = D3D11_BLEND_DESC::default();
        bl.RenderTarget[0] = D3D11_RENDER_TARGET_BLEND_DESC {
            BlendEnable: true.into(),
            SrcBlend: D3D11_BLEND_ONE,
            DestBlend: D3D11_BLEND_INV_SRC_ALPHA,
            BlendOp: D3D11_BLEND_OP_ADD,
            SrcBlendAlpha: D3D11_BLEND_ONE,
            DestBlendAlpha: D3D11_BLEND_INV_SRC_ALPHA,
            BlendOpAlpha: D3D11_BLEND_OP_ADD,
            RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
        };
        let mut blend: Option<ID3D11BlendState> = None;
        dev.CreateBlendState(&bl, Some(&mut blend))?;

        // blend désactivé mais écriture ACTIVE (le défaut a WriteMask=0 -> rien n'est écrit)
        let mut bl_none = D3D11_BLEND_DESC::default();
        bl_none.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8;
        let mut blend_none: Option<ID3D11BlendState> = None;
        dev.CreateBlendState(&bl_none, Some(&mut blend_none))?;

        // notre texture NV12 simple (ArraySize=1) : NV12+RT n'est autorisé qu'en non-array
        // sur cet iGPU. On y rend la conversion, puis copie GPU->GPU vers le pool encodeur.
        let nvd = D3D11_TEXTURE2D_DESC {
            Width: out_w,
            Height: out_h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut nv12: Option<ID3D11Texture2D> = None;
        dev.CreateTexture2D(&nvd, None, Some(&mut nv12))?;
        let nv12 = nv12.unwrap();
        let mk_rtv = |fmt: DXGI_FORMAT| -> Result<ID3D11RenderTargetView> {
            let d = D3D11_RENDER_TARGET_VIEW_DESC {
                Format: fmt,
                ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_RTV { MipSlice: 0 },
                },
            };
            let mut rtv: Option<ID3D11RenderTargetView> = None;
            dev.CreateRenderTargetView(&nv12, Some(&d), Some(&mut rtv))?;
            Ok(rtv.unwrap())
        };
        let rtv_y = mk_rtv(DXGI_FORMAT_R8_UNORM)?;
        let rtv_uv = mk_rtv(DXGI_FORMAT_R8G8_UNORM)?;

        // shaders de flou + copie
        let blurb = compile(hlsl, b"ps_blur\0", b"ps_5_0\0")?;
        let texb = compile(hlsl, b"ps_tex\0", b"ps_5_0\0")?;
        let mut ps_blur: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(
            std::slice::from_raw_parts(blurb.GetBufferPointer() as *const u8, blurb.GetBufferSize()),
            None,
            Some(&mut ps_blur),
        )?;
        let mut ps_tex: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(
            std::slice::from_raw_parts(texb.GetBufferPointer() as *const u8, texb.GetBufferSize()),
            None,
            Some(&mut ps_tex),
        )?;

        // shaders dual-Kawase
        let kdb = compile(hlsl, b"ps_kawase_down\0", b"ps_5_0\0")?;
        let kub = compile(hlsl, b"ps_kawase_up\0", b"ps_5_0\0")?;
        let mut ps_kdown: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(
            std::slice::from_raw_parts(kdb.GetBufferPointer() as *const u8, kdb.GetBufferSize()),
            None,
            Some(&mut ps_kdown),
        )?;
        let mut ps_kup: Option<ID3D11PixelShader> = None;
        dev.CreatePixelShader(
            std::slice::from_raw_parts(kub.GetBufferPointer() as *const u8, kub.GetBufferSize()),
            None,
            Some(&mut ps_kup),
        )?;

        // textures RGBA RT+SRV à une taille donnée (chaîne de flou)
        let mk_rgba = |w: u32, h: u32| -> Result<(ID3D11RenderTargetView, ID3D11ShaderResourceView)> {
            let hd = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut t: Option<ID3D11Texture2D> = None;
            dev.CreateTexture2D(&hd, None, Some(&mut t))?;
            let t = t.unwrap();
            let mut rtv: Option<ID3D11RenderTargetView> = None;
            dev.CreateRenderTargetView(&t, None, Some(&mut rtv))?;
            let mut srv: Option<ID3D11ShaderResourceView> = None;
            dev.CreateShaderResourceView(&t, None, Some(&mut srv))?;
            Ok((rtv.unwrap(), srv.unwrap()))
        };
        // Pyramide dual-Kawase derivee de la taille de rendu (et non d'un demi de
        // 1080 fige) : sinon le rayon effectif du flou de fond changerait d'un format
        // a l'autre. `.max(1)` protege les tres petites tailles de preview.
        let (half_w, half_h) = ((out_w / 2).max(1), (out_h / 2).max(1));
        let (half_a_rtv, half_a_srv) = mk_rgba(half_w, half_h)?;
        let (half_b_rtv, half_b_srv) = mk_rgba(half_w, half_h)?;
        let (q_rtv, q_srv) = mk_rgba((half_w / 2).max(1), (half_h / 2).max(1))?;
        let (e_rtv, e_srv) = mk_rgba((half_w / 4).max(1), (half_h / 4).max(1))?;

        // accumulateur pleine réso (RGBA) + blend additif pondéré (facteur = 1/N)
        let ad = D3D11_TEXTURE2D_DESC {
            Width: out_w,
            Height: out_h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut accum: Option<ID3D11Texture2D> = None;
        dev.CreateTexture2D(&ad, None, Some(&mut accum))?;
        let accum = accum.unwrap();
        let mut accum_rtv: Option<ID3D11RenderTargetView> = None;
        dev.CreateRenderTargetView(&accum, None, Some(&mut accum_rtv))?;
        let mut accum_srv: Option<ID3D11ShaderResourceView> = None;
        dev.CreateShaderResourceView(&accum, None, Some(&mut accum_srv))?;

        // Copie de travail des annotations flou. Chaîne de mips COMPLÈTE (`MipLevels: 0`) : c'est
        // elle qui fournit le flou. Échantillonner un niveau plus bas donne un vrai lissage pour
        // n'importe quel rayon à coût constant, là où un noyau de quelques taps espacés produit
        // des copies fantômes au lieu d'un flou.
        let ann_desc = D3D11_TEXTURE2D_DESC {
            MipLevels: 0,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            MiscFlags: D3D11_RESOURCE_MISC_GENERATE_MIPS.0 as u32,
            ..ad
        };
        let mut ann_copy: Option<ID3D11Texture2D> = None;
        dev.CreateTexture2D(&ann_desc, None, Some(&mut ann_copy))?;
        let ann_copy = ann_copy.unwrap();
        let mut ann_copy_srv: Option<ID3D11ShaderResourceView> = None;
        dev.CreateShaderResourceView(&ann_copy, None, Some(&mut ann_copy_srv))?;

        let mut bla = D3D11_BLEND_DESC::default();
        bla.RenderTarget[0] = D3D11_RENDER_TARGET_BLEND_DESC {
            BlendEnable: true.into(),
            SrcBlend: D3D11_BLEND_BLEND_FACTOR,
            DestBlend: D3D11_BLEND_ONE,
            BlendOp: D3D11_BLEND_OP_ADD,
            SrcBlendAlpha: D3D11_BLEND_BLEND_FACTOR,
            DestBlendAlpha: D3D11_BLEND_ONE,
            BlendOpAlpha: D3D11_BLEND_OP_ADD,
            RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
        };
        let mut blend_add: Option<ID3D11BlendState> = None;
        dev.CreateBlendState(&bla, Some(&mut blend_add))?;

        Ok(Compositor {
            dev,
            ctx,
            rt,
            rtv: rtv.unwrap(),
            rt_srv: rt_srv.unwrap(),
            staging: staging.unwrap(),
            vs: vs.unwrap(),
            ps: ps.unwrap(),
            vs_fs: vs_fs.unwrap(),
            ps_y: ps_y.unwrap(),
            ps_uv: ps_uv.unwrap(),
            sampler: sampler.unwrap(),
            cbuf: cbuf.unwrap(),
            blend: blend.unwrap(),
            blend_none: blend_none.unwrap(),
            nv12,
            rtv_y,
            rtv_uv,
            ps_blur: ps_blur.unwrap(),
            ps_tex: ps_tex.unwrap(),
            half_a_rtv,
            half_a_srv,
            half_b_rtv,
            half_b_srv,
            ps_kdown: ps_kdown.unwrap(),
            ps_kup: ps_kup.unwrap(),
            q_rtv,
            q_srv,
            e_rtv,
            e_srv,
            ann_copy,
            ann_copy_srv: ann_copy_srv.unwrap(),
            accum,
            accum_rtv: accum_rtv.unwrap(),
            accum_srv: accum_srv.unwrap(),
            blend_add: blend_add.unwrap(),
            cursor: RefCell::new(None),
            cursor_t_override: RefCell::new(None),
            timeline_t_override: RefCell::new(None),
            srv_cache: RefCell::new(HashMap::new()),
            live_params: RefCell::new(LiveParams::default()),
            scene: RefCell::new(None),
            text_raster: match crate::text::TextRasterizer::new() {
                Ok(r) => Some(r),
                Err(e) => {
                    eprintln!("[texte] init Direct2D/DirectWrite impossible, annotations texte désactivées: {e}");
                    None
                }
            },
            text_cache: RefCell::new(HashMap::new()),
            ann_img_cache: RefCell::new(HashMap::new()),
            img_cache: RefCell::new(HashMap::new()),
            render_size: Cell::new((out_w, out_h)),
            resize_target: RefCell::new(None),
            live_readback_staging: RefCell::new(None),
            nv12_readback_staging: RefCell::new(None),
        })
    }

    /// Largeur du render target en px. **Le** dénominateur de toute conversion
    /// px→normalisé de ce fichier : à utiliser partout où `OUT_W` servait de
    /// référence géométrique. Cf. `Compositor::render_size`.
    #[inline]
    fn rw(&self) -> f32 {
        self.render_size.get().0 as f32
    }

    /// Hauteur du render target en px. Cf. `Compositor::rw`.
    #[inline]
    fn rh(&self) -> f32 {
        self.render_size.get().1 as f32
    }

    /// Dimensions entières du render target — pour les viewports et les boucles
    /// de readback, qui veulent des `u32` et non des `f32`.
    #[inline]
    fn render_dims(&self) -> (u32, u32) {
        self.render_size.get()
    }

    /// Taille à laquelle ce compositeur rastérise, après l'arrondi au pair de
    /// `new_sized`. L'appelant la compare à la géométrie qu'il veut produire pour
    /// savoir s'il doit reconstruire le compositeur (cf. `new_sized`).
    pub fn render_size(&self) -> (u32, u32) {
        self.render_size.get()
    }

    /// Met à jour les paramètres continus pilotés par l'inspector (thread live uniquement).
    pub fn set_live_params(&self, p: LiveParams) {
        *self.live_params.borrow_mut() = p;
    }

    /// Installe (ou retire) la scène de l'app. Présente → `compose_frame` prend ses placements
    /// depuis le layout preset au lieu du planning fixture.
    pub fn set_scene(&self, s: Option<Scene>) {
        *self.scene.borrow_mut() = s;
    }

    /// Crée les SRV Y (R8) et UV (R8G8) sur la tranche d'array de la frame décodeur.
    pub unsafe fn nv12_srvs(
        &self,
        frame: *const AVFrame,
    ) -> Result<(ID3D11ShaderResourceView, ID3D11ShaderResourceView)> {
        let tex_ptr = (*frame).data[0] as *mut c_void;
        let slice = (*frame).data[1] as u32;
        // cache hit : le pool réutilise les mêmes textures -> zéro création après warmup
        let key = (tex_ptr as usize, slice);
        if let Some((y, uv)) = self.srv_cache.borrow().get(&key) {
            return Ok((y.clone(), uv.clone()));
        }
        let tex = ID3D11Texture2D::from_raw_borrowed(&tex_ptr)
            .ok_or_else(|| anyhow::anyhow!("frame sans texture D3D11"))?
            .clone();

        let mk = |fmt: DXGI_FORMAT| -> Result<ID3D11ShaderResourceView> {
            let mut d = D3D11_SHADER_RESOURCE_VIEW_DESC {
                Format: fmt,
                ViewDimension: D3D11_SRV_DIMENSION_TEXTURE2DARRAY,
                ..Default::default()
            };
            d.Anonymous.Texture2DArray = D3D11_TEX2D_ARRAY_SRV {
                MostDetailedMip: 0,
                MipLevels: 1,
                FirstArraySlice: slice,
                ArraySize: 1,
            };
            let mut srv: Option<ID3D11ShaderResourceView> = None;
            self.dev.CreateShaderResourceView(&tex, Some(&d), Some(&mut srv))?;
            Ok(srv.unwrap())
        };
        let y = mk(DXGI_FORMAT_R8_UNORM)?;
        let uv = mk(DXGI_FORMAT_R8G8_UNORM)?;
        self.srv_cache.borrow_mut().insert(key, (y.clone(), uv.clone()));
        Ok((y, uv))
    }

    /// Dimensions réelles de la texture décodeur (alignée macrobloc : 1080->1088, etc.).
    pub unsafe fn tex_dims(&self, frame: *const AVFrame) -> (u32, u32) {
        let tex_ptr = (*frame).data[0] as *mut c_void;
        let tex = ID3D11Texture2D::from_raw_borrowed(&tex_ptr).unwrap();
        let mut d = D3D11_TEXTURE2D_DESC::default();
        tex.GetDesc(&mut d);
        (d.Width, d.Height)
    }

    /// État de composition : RT principal, viewport plein, shaders de calque, blend prémultiplié.
    /// (Sans clear — sert à reprendre après les passes de flou.)
    pub unsafe fn bind_compose_state(&self) {
        self.ctx.OMSetRenderTargets(Some(&[Some(self.rtv.clone())]), None);
        let vp = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: self.rw(), Height: self.rh(), MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp]));
        self.ctx.VSSetShader(&self.vs, None);
        self.ctx.PSSetShader(&self.ps, None);
        self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
        self.ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
        self.ctx.OMSetBlendState(&self.blend, None, 0xffffffff);
    }

    /// Prépare la passe : état de composition + clear.
    pub unsafe fn begin(&self, clear: [f32; 4]) {
        self.bind_compose_state();
        self.ctx.ClearRenderTargetView(&self.rtv, &clear);
    }

    /// Passe plein écran générique (triangle unique) : `srv` -> `rtv` via `ps`, avec `fx`.
    unsafe fn fs_pass(
        &self,
        rtv: &ID3D11RenderTargetView,
        srv: &ID3D11ShaderResourceView,
        ps: &ID3D11PixelShader,
        w: u32,
        h: u32,
        fx: [f32; 4],
    ) {
        self.ctx.OMSetBlendState(&self.blend_none, None, 0xffffffff);
        self.ctx.OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);
        self.ctx.PSSetShaderResources(0, Some(&[Some(srv.clone())]));
        self.ctx.VSSetShader(&self.vs_fs, None);
        self.ctx.PSSetShader(ps, None);
        self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
        let vp = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: w as f32, Height: h as f32, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp]));
        self.upload_cb(&LayerCB { fx, ..Default::default() });
        self.ctx.Draw(3, 0);
        self.ctx.PSSetShaderResources(0, Some(&[None]));
    }

    /// Fond flouté (§7), dual-Kawase : suppose le screen déjà dessiné plein écran dans le RT.
    /// Chaîne down (RT→960→480→240) puis up (240→480→960→RT). ~6 passes de 5-8 taps
    /// à résolution décroissante, vs 2 passes gaussiennes 49-tap. Le RT devient le fond.
    pub unsafe fn blur_bg(&self, _sigma: f32) {
        let off = 2.2; // spread par passe
        // La pyramide se dérive de la taille de rendu, pas d'une constante : sinon
        // le rayon effectif du flou changerait avec la résolution de sortie (un
        // demi de 1080 n'est pas un demi de 2160), et le fond flouté ne serait plus
        // le même effet d'un format à l'autre.
        let (rw_i, rh_i) = self.render_dims();
        let (half_w, half_h) = (rw_i / 2, rh_i / 2);
        let hw = half_w as f32;
        let hh = half_h as f32;
        // DOWN : texel = 1/(dims de la SOURCE échantillonnée)
        self.fs_pass(&self.half_a_rtv, &self.rt_srv, &self.ps_kdown, half_w, half_h,
            [1.0 / self.rw(), 1.0 / self.rh(), off, 0.0]);
        self.fs_pass(&self.q_rtv, &self.half_a_srv, &self.ps_kdown, half_w / 2, half_h / 2,
            [1.0 / hw, 1.0 / hh, off, 0.0]);
        self.fs_pass(&self.e_rtv, &self.q_srv, &self.ps_kdown, half_w / 4, half_h / 4,
            [2.0 / hw, 2.0 / hh, off, 0.0]);
        // UP
        self.fs_pass(&self.q_rtv, &self.e_srv, &self.ps_kup, half_w / 2, half_h / 2,
            [4.0 / hw, 4.0 / hh, off, 0.0]);
        self.fs_pass(&self.half_a_rtv, &self.q_srv, &self.ps_kup, half_w, half_h,
            [2.0 / hw, 2.0 / hh, off, 0.0]);
        self.fs_pass(&self.rtv, &self.half_a_srv, &self.ps_kup, rw_i, rh_i,
            [1.0 / hw, 1.0 / hh, off, 0.0]);
    }

    unsafe fn upload_cb(&self, cb: &LayerCB) {
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        self.ctx
            .Map(&self.cbuf, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut m))
            .unwrap();
        std::ptr::copy_nonoverlapping(cb as *const LayerCB as *const u8, m.pData as *mut u8, std::mem::size_of::<LayerCB>());
        self.ctx.Unmap(&self.cbuf, 0);
        self.ctx.VSSetConstantBuffers(0, Some(&[Some(self.cbuf.clone())]));
        self.ctx.PSSetConstantBuffers(0, Some(&[Some(self.cbuf.clone())]));
    }

    /// Calque vidéo NV12.
    pub unsafe fn draw_video(
        &self,
        cb: &LayerCB,
        srv_y: &ID3D11ShaderResourceView,
        srv_uv: &ID3D11ShaderResourceView,
    ) {
        self.upload_cb(cb);
        self.ctx
            .PSSetShaderResources(0, Some(&[Some(srv_y.clone()), Some(srv_uv.clone())]));
        self.ctx.Draw(4, 0);
    }

    /// Calque couleur pleine (fond).
    pub unsafe fn draw_solid(&self, cb: &LayerCB) {
        self.upload_cb(cb);
        self.ctx.Draw(4, 0);
    }

    /// Fond wallpaper image (cover-fit). `path` = chemin absolu (résolu côté app). Décodé et
    /// uploadé une fois (cache), puis échantillonné en mode 6. Err → l'appelant retombe sur une
    /// couleur plate. Le rect uv `src` recouvre toute la sortie en rognant le débordement.
    unsafe fn draw_image_bg(&self, path: &str, output_aspect: f32) -> Result<()> {
        // NB : la recherche est isolée dans un `let` pour que l'emprunt immuable soit relâché
        // AVANT le `borrow_mut()` (sinon double-emprunt RefCell → panic sur la 1re frame image).
        let cached = self.img_cache.borrow().get(path).cloned();
        let (srv, iw, ih) = match cached {
            Some(v) => v,
            None => {
                let loaded = self.load_image_srv(path)?;
                self.img_cache.borrow_mut().insert(path.to_string(), loaded.clone());
                loaded
            }
        };
        let ai = iw as f32 / ih as f32;
        // Le fond remplit TOUJOURS le cadre (dst=[0,0,1,1], jamais rétréci par `undistort`),
        // mais le canvas interne est un 16:9 fixe étiré ensuite vers le VRAI ratio de sortie
        // (`blit_resized`, non uniforme) : le crop "cover" doit donc être calculé contre ce vrai
        // ratio de sortie (`output_aspect`, = final_out_w/final_out_h), pas contre le ratio fixe
        // du canvas — sinon l'image, déjà cover-fittée pour du 16:9, se retrouve re-déformée par
        // l'étirement final vers un ratio différent (ex. 9:16, cf. rapport utilisateur).
        let ao = output_aspect;
        let (u0, v0, u1, v1) = if ai > ao {
            let vis = ao / ai; // rogne horizontalement
            ((1.0 - vis) * 0.5, 0.0, 1.0 - (1.0 - vis) * 0.5, 1.0)
        } else {
            let vis = ai / ao; // rogne verticalement
            (0.0, (1.0 - vis) * 0.5, 1.0, 1.0 - (1.0 - vis) * 0.5)
        };
        self.upload_cb(&LayerCB {
            dst: [0.0, 0.0, 1.0, 1.0],
            src: [u0, v0, u1, v1],
            mode: 6.0,
            ..Default::default()
        });
        self.ctx.PSSetShaderResources(2, Some(&[Some(srv)]));
        self.ctx.Draw(4, 0);
        Ok(())
    }

    /// Décode un fichier image (jpg/png) → texture RGBA immuable + SRV.
    unsafe fn load_image_srv(&self, path: &str) -> Result<(ID3D11ShaderResourceView, u32, u32)> {
        // Les annotations image stockent une data URL (cf. `types.ts` : « Separate storage for
        // image data URL »), pas un chemin : on décode alors depuis la mémoire. Les wallpapers
        // continuent de passer par le disque.
        let img = if let Some(bytes) = decode_data_uri(path) {
            image::load_from_memory(&bytes)
                .map_err(|e| anyhow::anyhow!("data URI image ({} octets): {}", bytes.len(), e))?
                .to_rgba8()
        } else {
            image::open(path)
                .map_err(|e| anyhow::anyhow!("wallpaper {}: {}", path, e))?
                .to_rgba8()
        };
        let (w, h) = (img.width(), img.height());
        let pixels = img.into_raw();
        let td = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_IMMUTABLE,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let init = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr() as *const c_void,
            SysMemPitch: w * 4,
            SysMemSlicePitch: 0,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        self.dev.CreateTexture2D(&td, Some(&init), Some(&mut tex))?;
        let tex = tex.unwrap();
        let mut srv: Option<ID3D11ShaderResourceView> = None;
        self.dev.CreateShaderResourceView(&tex, None, Some(&mut srv))?;
        Ok((srv.unwrap(), w, h))
    }

    pub fn set_cursor(&self, track: CursorTrack) {
        *self.cursor.borrow_mut() = Some(track);
    }

    pub fn clear_cursor(&self) {
        *self.cursor.borrow_mut() = None;
    }

    /// Voir `cursor_t_override`. `None` restaure le comportement fixture (`frame / FPS`).
    pub fn set_cursor_time(&self, t: Option<f32>) {
        *self.cursor_t_override.borrow_mut() = t;
    }

    /// Voir `timeline_t_override`. `None` restaure le comportement fixture (`frame / FPS`).
    pub fn set_timeline_time(&self, t: Option<f32>) {
        *self.timeline_t_override.borrow_mut() = t;
    }

    /// Copie de la scène courante (si présente) — utilisé par l'export multiclip pour lire les
    /// réglages curseur (thème/lissage/show) sans dupliquer le contrat de scène côté pipeline.
    pub fn scene_snapshot(&self) -> Option<Scene> {
        self.scene.borrow().clone()
    }

    /// Curseur custom (dot+ring) centré en `center` (0..1 sortie), taille `size_px`, opacité `a`.
    /// `clip` = rect "Clip to canvas" en espace sortie [x,y,w,h] ; passer un rect englobant tout
    /// (ex. [-1,-1,3,3]) pour désactiver l'effet.
    unsafe fn draw_cursor(&self, center: [f32; 2], size_px: f32, a: f32, clip: [f32; 4]) {
        let w = size_px / self.rw();
        let h = size_px / self.rh();
        let dst = [center[0] - w * 0.5, center[1] - h * 0.5, w, h];
        self.draw_solid(&LayerCB {
            dst,
            quad_px: [size_px, size_px],
            mode: 4.0,
            color: [1.0, 1.0, 1.0, a],
            fx: clip,
            ..Default::default()
        });
    }

    /// Curseur thème (sprite PNG, ex. arrow.png) dont le PIVOT `hotspot` (fraction 0..1 de
    /// l'image) tombe sur `center`, à la taille de référence `size_px`. `Err` → l'appelant
    /// retombe sur `draw_cursor` (math dot+ring).
    unsafe fn draw_cursor_sprite(
        &self,
        placement: CursorPlacement,
        size_px: f32,
        a: f32,
        sprite: &SceneCursorSprite,
        clip: [f32; 4],
    ) -> Result<()> {
        let path = sprite.path.as_str();
        let cached = self.img_cache.borrow().get(path).cloned();
        let (srv, iw, ih) = match cached {
            Some(v) => v,
            None => {
                let loaded = self.load_image_srv(path)?;
                self.img_cache.borrow_mut().insert(path.to_string(), loaded.clone());
                loaded
            }
        };
        let ar = iw as f32 / ih as f32;
        let (pw, ph) = if ar >= 1.0 { (size_px, size_px / ar) } else { (size_px * ar, size_px) };
        let hotspot = [sprite.hotspot_x, sprite.hotspot_y];

        let cb = match placement {
            CursorPlacement::Upright { center } => LayerCB {
                dst: cursor_sprite_dst(center, pw / self.rw(), ph / self.rh(), hotspot),
                src: [0.0, 0.0, 1.0, 1.0],
                mode: 7.0,
                color: [1.0, 1.0, 1.0, a],
                fx: clip,
                ..Default::default()
            },
            CursorPlacement::Tilted { plane_pt, quad, center_px, screen_px, .. } => {
                // Le sprite est posé DANS le plan : sa taille devient une fraction du plan
                // (l'unité de `size_px` est le rect d'écran non incliné), et ses 4 coins
                // traversent la même projection que la vidéo. La réduction due au tilt vient
                // donc de la projection elle-même — rien à multiplier à la main.
                let (wf, hf) = (pw / screen_px[0], ph / screen_px[1]);
                let x0 = plane_pt[0] - hotspot[0] * wf;
                let y0 = plane_pt[1] - hotspot[1] * hf;
                let corners = [(x0, y0), (x0 + wf, y0), (x0 + wf, y0 + hf), (x0, y0 + hf)]
                    .map(|(fx, fy)| {
                        let (px, py) = quad.point_px(fx, fy);
                        (center_px[0] + px, center_px[1] + py)
                    });
                let (min_x, max_x) = corners
                    .iter()
                    .fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
                let (min_y, max_y) = corners
                    .iter()
                    .fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
                // Le quad projeté d'un sprite peut être très fin de biais : une bbox d'un pixel
                // de large ferait diverger le warp inverse, donc plancher à 1 px.
                let (bw, bh) = ((max_x - min_x).max(1.0), (max_y - min_y).max(1.0));
                let local = |(x, y): (f32, f32)| [x - min_x, y - min_y];
                let [tl0, tl1] = local(corners[0]);
                let [tr0, tr1] = local(corners[1]);
                let [br0, br1] = local(corners[2]);
                let [bl0, bl1] = local(corners[3]);
                LayerCB {
                    dst: [min_x / self.rw(), min_y / self.rh(), bw / self.rw(), bh / self.rh()],
                    quad_px: [bw, bh],
                    mode: 13.0,
                    color: [1.0, 1.0, 1.0, a],
                    fx: [tl0, tl1, tr0, tr1],
                    src_prev: [br0, br1, bl0, bl1],
                    dst_prev: clip,
                    ..Default::default()
                }
            }
        };

        self.upload_cb(&cb);
        self.ctx.PSSetShaderResources(2, Some(&[Some(srv)]));
        self.ctx.Draw(4, 0);
        Ok(())
    }

    /// Sprite de l'état courant (`cursor_type`, ex. `"text"`), à défaut celui de la flèche,
    /// à défaut le curseur math (dot+ring).
    ///
    /// Le repli sur la flèche compte : un thème n'apporte que sa flèche et son pointeur, les
    /// autres états venant de l'art intégrée — mais si un état inconnu apparaît, mieux vaut
    /// une flèche qu'un point dans un cercle.
    unsafe fn draw_cur_themed(
        &self,
        sprites: &HashMap<String, SceneCursorSprite>,
        cursor_type: Option<&str>,
        placement: CursorPlacement,
        size_px: f32,
        a: f32,
        clip: [f32; 4],
    ) {
        let sprite = cursor_type.and_then(|t| sprites.get(t)).or_else(|| sprites.get("arrow"));
        if let Some(sprite) = sprite {
            if self.draw_cursor_sprite(placement, size_px, a, sprite, clip).is_ok() {
                return;
            }
        }
        // Le repli math reste droit même sur un plan incliné : il ne devrait plus apparaître
        // maintenant que l'art par défaut existe, et lui donner sa propre passe de warp pour
        // un cas de secours ne se justifie pas.
        self.draw_cursor(placement.upright_center(), size_px, a, clip);
    }

    /// Ombre portée (§7 E4) sous un quad `dst` (normalisé) de taille `size_px`.
    /// Le quad d'ombre est élargi de `spread` px et décalé de `offset_px`.
    /// `spread`/`offset_px` sont des px RÉELS de la sortie finale (même convention que
    /// `radius_px` pour l'arrondi normal, cf. `compose_frame`) — PAS des px du canvas fixe
    /// 16:9. Convertis ici en marge/décalage CANVAS (avant l'étirement final anisotrope de
    /// `blit_resized`), par axe (`/stretch_x`, `/stretch_y`), pour que ce halo redevienne un
    /// vrai halo isotrope une fois cet étirement appliqué — sans ça (ancien calcul : marge
    /// identique en fraction canvas quel que soit l'axe) l'ombre ressort visiblement elliptique
    /// dès que la sortie n'est pas 16:9 (rapport utilisateur, ex. export vertical 9:16).
    /// `stretch_x`/`stretch_y` sont aussi transmis au shader (`mb.yz`) pour pré-déformer la SDF
    /// elle-même — même technique que l'arrondi normal (mode 0) — sinon la COURBURE des coins
    /// de l'ombre reste elliptique même une fois sa taille globale corrigée.
    pub unsafe fn draw_shadow(
        &self,
        dst: [f32; 4],
        size_px: [f32; 2],
        radius: f32,
        spread: f32,
        offset_px: [f32; 2],
        opacity: f32,
    ) {
        let sx = spread / self.rw();
        let sy = spread / self.rh();
        let ox = offset_px[0] / self.rw();
        let oy = offset_px[1] / self.rh();
        let cb = LayerCB {
            dst: [dst[0] - sx + ox, dst[1] - sy + oy, dst[2] + 2.0 * sx, dst[3] + 2.0 * sy],
            quad_px: [size_px[0] + 2.0 * spread, size_px[1] + 2.0 * spread],
            radius_px: radius,
            mode: 2.0,
            color: [0.0, 0.0, 0.0, opacity],
            fx: [spread, 0.0, 0.0, 0.0],
            mb: [0.0, 1.0, 1.0, 0.0],
            ..Default::default()
        };
        self.draw_solid(&cb);
    }

    /// Ombre d'un écran incliné en 3D : la pénombre suit le QUADRILATÈRE projeté (mode 12), pas
    /// son rect englobant. `corners` sont les 4 coins (TL, TR, BR, BL) en px relatifs au centre,
    /// tels que `rotated_quad_corners_px` les rend ; `center_px` est ce centre à l'écran.
    ///
    /// `radius` est le rayon des coins du PLAN, réutilisé tel quel : la projection l'étire de
    /// ±10 % selon l'endroit du bord, écart invisible sur une ombre floue, alors qu'une ombre à
    /// coins vifs derrière un écran arrondi dépasse en pointe et se voit tout de suite.
    pub unsafe fn draw_quad_shadow(
        &self,
        corners: &[(f32, f32); 4],
        center_px: [f32; 2],
        radius: f32,
        spread: f32,
        offset_px: [f32; 2],
        opacity: f32,
    ) {
        let (min_x, max_x) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
        let (min_y, max_y) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
        // La boîte de rendu doit contenir la pénombre entière, sinon elle se coupe net — le
        // quadrilatère seul ne suffit pas.
        let box_w = (max_x - min_x) + 2.0 * spread;
        let box_h = (max_y - min_y) + 2.0 * spread;
        let origin_x = center_px[0] + min_x - spread + offset_px[0];
        let origin_y = center_px[1] + min_y - spread + offset_px[1];
        // Coins en px locaux à cette boîte, même convention que le mode 8.
        let local = |(x, y): (f32, f32)| -> [f32; 2] { [x - min_x + spread, y - min_y + spread] };
        let [tl0, tl1] = local(corners[0]);
        let [tr0, tr1] = local(corners[1]);
        let [br0, br1] = local(corners[2]);
        let [bl0, bl1] = local(corners[3]);
        self.draw_solid(&LayerCB {
            dst: [
                origin_x / self.rw(),
                origin_y / self.rh(),
                box_w / self.rw(),
                box_h / self.rh(),
            ],
            quad_px: [box_w, box_h],
            radius_px: radius,
            mode: 12.0,
            color: [0.0, 0.0, 0.0, opacity],
            fx: [tl0, tl1, tr0, tr1],
            src_prev: [br0, br1, bl0, bl1],
            mb: [0.0, spread, 1.0, 0.0],
            ..Default::default()
        });
    }

    /// Compose une frame animée (§6/§8) : fond flouté + screen zoomé (padding, coins, ombre)
    /// + webcam crop carré (coins, ombre), placements interpolés A↔B par la timeline.
    pub unsafe fn compose_frame(
        &self,
        screen: *const AVFrame,
        webcam: *const AVFrame,
        frame: f32,
        cfg: &Cfg,
    ) -> Result<()> {
        let (sy, suv) = self.nv12_srvs(screen)?;
        let (wy, wuv) = self.nv12_srvs(webcam)?;
        let (stw, sth) = self.tex_dims(screen);
        let (wtw, wth) = self.tex_dims(webcam);
        let (scw, sch) = ((*screen).width as f32, (*screen).height as f32);
        let (wcw, wch) = ((*webcam).width as f32, (*webcam).height as f32);
        let u_max = scw / stw as f32;
        let v_max = sch / sth as f32;

        // Scène de l'app présente → placements du layout preset (ou, mieux, le rect résolu par
        // l'app dans `layout.webcam_rect`) ; sinon planning fixture (bench).
        let scene_ref = self.scene.borrow();
        let scene_preset: Option<String> =
            scene_ref.as_ref().map(|s| s.layout.preset.clone());
        // Webcam rect résolu par l'app (= `computeCompositeLayout`, source de vérité unique
        // entre preview et natif) : quand il est présent ET que la scène est posée, on l'utilise
        // COMME placement de base. Sinon, fallback sur `preset_placements` historique (PiP
        // codé en dur à 320 px + 40 px de marge — l'arrangement qui dérivait de la preview).
        let app_webcam_rect: Option<[f32; 4]> = scene_ref
            .as_ref()
            .and_then(|s| s.layout.webcam_rect)
            .map(|r| [r.x, r.y, r.width, r.height]);
        // Idem pour l'écran. Les deux rects viennent du MÊME appel `computeCompositeLayout`, donc
        // les consommer ensemble est la seule façon de garder le bloc écran+caméra cohérent :
        // n'en prendre qu'un revenait à mélanger la géométrie de l'app et un placement fixture.
        let app_screen_rect: Option<[f32; 4]> = scene_ref
            .as_ref()
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
        let lp = *self.live_params.borrow();
        // Motion blur écran : quand la scène (contrat de l'app) est posée, c'est elle qui pilote
        // (parité inspector : 1.0 + motion_blur*15 taps), sinon on retombe sur `cfg.mblur_n`
        // (le bench fixture continue d'utiliser ses taps explicites).
        let mb_taps = scene_ref
            .as_ref()
            .map(|s| 1.0 + s.effects.motion_blur.clamp(0.0, 1.0) * 15.0)
            .unwrap_or(cfg.mblur_n as f32);

        // Zoom regions + Full Camera : filtrées en amont pour le clip actif et échantillonnées
        // dans le même référentiel source que le PTS du décodeur écran.
        let empty_zoom: Vec<crate::scene::SceneZoomRegion> = Vec::new();
        let empty_cam: Vec<crate::scene::SceneCameraFullscreenRegion> = Vec::new();
        let zoom_regions = scene_ref.as_ref().map(|s| &s.zoom_regions).unwrap_or(&empty_zoom);
        let cam_regions =
            scene_ref.as_ref().map(|s| &s.camera_fullscreen_regions).unwrap_or(&empty_cam);
        let webcam_reactive = scene_ref.as_ref().map(|s| s.layout.webcam_reactive_zoom).unwrap_or(false);
        let source_t = self.timeline_t_override.borrow().unwrap_or(frame / FPS);
        let source_t_prev = source_t - 1.0 / FPS;
        // le focus "auto" (suivi curseur) réutilise la même piste que le rendu du curseur.
        let cursor_ref = self.cursor.borrow();
        let cursor_for_zoom = cursor_ref.as_ref();
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
            let s = (dst[2] * self.rw()).min(dst[3] * self.rh()); // côté carré de base (px)
            let (pw, ph) = if cam_ar >= 1.0 { (s, s / cam_ar) } else { (s * cam_ar, s) };
            let (nw, nh) = (pw / self.rw(), ph / self.rh());
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
        let active_crop = scene_ref.as_ref().and_then(|scene| {
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
            let box_w_px = dst[2] * self.rw();
            let box_h_px = dst[3] * self.rh();
            let box_ar = box_w_px / box_h_px.max(0.0001);
            let (nw_px, nh_px) = if aspect > box_ar {
                (box_w_px, box_w_px / aspect.max(0.0001))
            } else {
                (box_h_px * aspect, box_h_px)
            };
            let (nw, nh) = (nw_px / self.rw(), nh_px / self.rh());
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
        let cover_box_ar = scene_ref.as_ref().and_then(|s| {
            s.layout
                .screen_cover
                .then_some((s_base[2] * self.rw()) / (s_base[3] * self.rh()).max(0.0001))
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
        let w_nominal_min = (w_dst[2] * self.rw()).min(w_dst[3] * self.rh());
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
        let frame_min_px = self.rw().min(self.rh());
        let s_min_px = (s_dst[2] * self.rw()).min(s_dst[3] * self.rh());
        let app_screen_radius_frac = scene_ref.as_ref().and_then(|s| s.layout.screen_radius_frac);
        let scene_roundness_frac = scene_ref.as_ref().map(|s| s.effects.roundness_frac);
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
        let w_px = [w_dst[2] * self.rw(), w_dst[3] * self.rh()];
        // Rayon caméra. Le slider Roundness ne s'y applique jamais (il ne vaut que pour l'ÉCRAN).
        // Quand l'app le résout (`computeCompositeLayout`, source unique), on le prend : c'est la
        // seule façon que les deux moitiés d'un layout en bloc soient encadrées à l'identique,
        // l'écran consommant déjà `screen_radius_frac` du même calcul. La table ci-dessous en
        // était une SECONDE, indépendante — fraction différente (0.12 vs 0.06 côté web) et sans
        // bornes — donc écran et caméra ne pouvaient pas s'accorder.
        let app_webcam_radius_frac = scene_ref.as_ref().and_then(|s| s.layout.webcam_radius_frac);
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

        self.begin([0.0, 0.0, 0.0, 1.0]);

        // --- fond ---
        // Parité web (frameRenderer.blurredBackgroundLayer) : le fond est le WALLPAPER sélectionné
        // (image/couleur/gradient) et « Blur BG » floute CE wallpaper, PAS la vidéo. Le natif
        // dupliquait la vidéo floutée → le « vieux flou ». Côté APP (scène présente) on dessine
        // donc le wallpaper (couleur pour l'instant ; gradient/image rendus depuis la scène
        // ensuite ; pour une couleur plate le flou est un no-op visuel). Côté fixture/bench
        // (pas de scène) on garde le fond screen-flouté, dont le coût est mesuré (C4).
        let scene_bg = self.scene.borrow().as_ref().map(|s| (s.background.clone(), s.effects.blur));
        if let Some((bg, blur_wallpaper)) = scene_bg {
            match bg {
                SceneBackground::Color { color } => {
                    let c = parse_hex(&color).unwrap_or(lp.bg_color);
                    self.draw_solid(&LayerCB {
                        dst: [0.0, 0.0, 1.0, 1.0],
                        mode: 1.0,
                        color: c,
                        ..Default::default()
                    });
                }
                SceneBackground::Gradient { angle_deg, stops } => {
                    let c0 = stops.first().and_then(|s| parse_hex(s)).unwrap_or(lp.bg_color);
                    let c1 = stops.last().and_then(|s| parse_hex(s)).unwrap_or(c0);
                    // angle CSS → direction unitaire (espace sortie, y vers le bas) :
                    // 0° = vers le haut, 90° = vers la droite.
                    let a = angle_deg.to_radians();
                    let dir = [a.sin(), -a.cos()];
                    self.draw_solid(&LayerCB {
                        dst: [0.0, 0.0, 1.0, 1.0],
                        src: [c1[0], c1[1], c1[2], c1[3]],
                        mode: 5.0,
                        color: c0,
                        fx: [dir[0], dir[1], 0.0, 0.0],
                        ..Default::default()
                    });
                }
                SceneBackground::Image { path } => {
                    // image bg (cover-fit, mise en cache) ; fallback couleur si chargement échoue
                    // (loggé — un fallback silencieux masquerait un chemin cassé, cf. le panic
                    // borrow qu'on a déjà eu : toute panne doit être visible/traçable).
                    if let Err(e) = self.draw_image_bg(&path, self.rw() / self.rh()) {
                        eprintln!("[compositor] wallpaper image \"{}\" : {:#}", path, e);
                        self.draw_solid(&LayerCB {
                            dst: [0.0, 0.0, 1.0, 1.0],
                            mode: 1.0,
                            color: lp.bg_color,
                            ..Default::default()
                        });
                    }
                }
            }
            // « Blur BG » (parité web blurredBackgroundLayer) : floute CE wallpaper qu'on vient
            // de dessiner (dual-Kawase, déjà utilisé pour le fond fixture ci-dessous). No-op
            // visuel sur une couleur plate, effet réel sur gradient/image.
            if blur_wallpaper {
                self.blur_bg(18.0);
                self.bind_compose_state();
            }
        } else if cfg.bg_blur {
            let over = 0.06;
            self.draw_video(
                &LayerCB {
                    dst: [-over, -over, 1.0 + 2.0 * over, 1.0 + 2.0 * over],
                    src: [0.0, 0.0, u_max, v_max],
                    quad_px: [self.rw(), self.rh()],
                    mode: 0.0,
                    color: [1.0, 1.0, 1.0, 1.0],
                    ..Default::default()
                },
                &sy,
                &suv,
            );
            self.blur_bg(18.0);
            self.bind_compose_state();
            self.draw_solid(&LayerCB {
                dst: [0.0, 0.0, 1.0, 1.0],
                mode: 1.0,
                color: [0.0, 0.0, 0.0, 0.35],
                ..Default::default()
            });
        } else {
            self.draw_solid(&LayerCB {
                dst: [0.0, 0.0, 1.0, 1.0],
                mode: 1.0,
                color: lp.bg_color,
                ..Default::default()
            });
        }

        // --- screen : crop du clip actif, puis zoom appliqué dans ce rect source (§8) ---
        // `for_clip_window` conserve l'index pour distinguer plusieurs clips du même asset.
        // `active_crop` déjà résolu plus haut (utilisé pour dimensionner `s_dst`) — une seule
        // source de vérité pour ce lookup.
        let s_px = [s_dst[2] * self.rw(), s_dst[3] * self.rh()];
        // Coupes calculées plus haut (elles dimensionnent `s_dst`) : le zoom vit désormais
        // dans la boîte, la coupe ne porte que le crop. `dst_prev` porte la vélocité du
        // motion blur — la coupe, elle, est la même aux deux frames.
        let [su0, sv0, su1, sv1] = cut;
        let (hu, hv) = ((su1 - su0) * 0.5, (sv1 - sv0) * 0.5);
        let [su0_p, sv0_p, su1_p, sv1_p] = cut;
        let (hu_p, hv_p) = ((su1_p - su0_p) * 0.5, (sv1_p - sv0_p) * 0.5);
        // Géométrie du tilt, calculée UNE fois : l'ombre et l'écran doivent porter exactement le
        // même quadrilatère. Deux calculs séparés, c'est une ombre qui se décolle dès qu'un des
        // deux change.
        let tilt = (!crate::regions::is_identity_rotation(zoom_rotation))
            .then(|| crate::regions::rotated_quad_corners_px(s_px[0], s_px[1], zoom_rotation));
        let quad_center_px =
            [(s_dst[0] + s_dst[2] * 0.5) * self.rw(), (s_dst[1] + s_dst[3] * 0.5) * self.rh()];
        // L'ombre suit la silhouette réellement affichée : le rect arrondi quand l'écran est
        // droit, le quadrilatère projeté quand il est incliné. Un rect droit derrière un écran
        // penché ne se lisait pas comme son ombre mais comme une seconde surface. Elle suit
        // aussi la croissance de la boîte pendant un zoom (issue #179) : quand la boîte sort
        // du cadre, l'ombre en sort avec elle, sans jamais se lire comme une bande noire.
        if cfg.shadow {
            let spread = SCREEN_SHADOW_SPREAD_FRAC * frame_min_px;
            let offset = [0.0, SCREEN_SHADOW_OFFSET_FRAC * frame_min_px];
            let opacity = 0.45 * lp.shadow_scale;
            match tilt.as_ref() {
                None => self.draw_shadow(s_dst, s_px, s_radius, spread, offset, opacity),
                Some(quad) => self.draw_quad_shadow(
                    &quad.corners,
                    quad_center_px,
                    // Même rayon que le plan incliné lui-même (cf. le dessin du mode 8).
                    s_radius * quad.scale,
                    spread,
                    offset,
                    opacity,
                ),
            }
        }
        if crate::regions::is_identity_rotation(zoom_rotation) {
            self.draw_video(
                &LayerCB {
                    dst: s_dst,
                    src: [su0, sv0, su0 + 2.0 * hu, sv0 + 2.0 * hv],
                    quad_px: s_px,
                    radius_px: s_radius,
                    mode: 0.0,
                    color: [0.0, 0.0, 0.0, 1.0],
                    src_prev: [su0_p, sv0_p, su0_p + 2.0 * hu_p, sv0_p + 2.0 * hv_p],
                    dst_prev: s_dst_prev,
                    mb: [mb_taps, 1.0, 1.0, 0.0],
                    ..Default::default()
                },
                &sy,
                &suv,
            );
        } else {
            // Tilt 3D (zoom "rotation" iso/left/right) : warp bilinéaire inverse (mode 8, voir
            // shaders.hlsl). Pas de motion blur dans ce chemin — le tilt est un effet bref, la
            // simplification ne se voit pas. Les coins arrondis, eux, se voyaient : sans eux le
            // plan a des arêtes de couteau qui tranchent le contenu en pleine phrase, et l'œil lit
            // une découpe (« un overflow hidden qui tronque l'enregistrement ») là où il devrait
            // lire une inclinaison. Ils sont donc rendus, dans le repère DU PLAN.
            let quad = tilt.unwrap_or_else(|| {
                crate::regions::rotated_quad_corners_px(s_px[0], s_px[1], zoom_rotation)
            });
            let corners = quad.corners;
            // Taille du plan dans son propre repère, avant projection : c'est là que vit le rayon,
            // pour qu'il reste un rayon constant le long du bord et non un arrondi qui s'étire avec
            // la perspective.
            let plane_px = [s_px[0] * quad.scale, s_px[1] * quad.scale];
            let (cx_px, cy_px) = (quad_center_px[0], quad_center_px[1]);
            let (min_x, max_x) = corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| {
                (mn.min(x), mx.max(x))
            });
            let (min_y, max_y) = corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| {
                (mn.min(y), mx.max(y))
            });
            let bbox_w = (max_x - min_x).max(1.0);
            let bbox_h = (max_y - min_y).max(1.0);
            let bbox_dst = [
                (cx_px + min_x) / self.rw(),
                (cy_px + min_y) / self.rh(),
                bbox_w / self.rw(),
                bbox_h / self.rh(),
            ];
            // coins en px LOCAUX à la bbox (0..bbox_w/h), pour matcher `i.local` du shader.
            let local = |(x, y): (f32, f32)| -> [f32; 2] { [x - min_x, y - min_y] };
            let [tl0, tl1] = local(corners[0]);
            let [tr0, tr1] = local(corners[1]);
            let [br0, br1] = local(corners[2]);
            let [bl0, bl1] = local(corners[3]);
            self.draw_video(
                &LayerCB {
                    dst: bbox_dst,
                    src: [su0, sv0, su0 + 2.0 * hu, sv0 + 2.0 * hv],
                    quad_px: [bbox_w, bbox_h],
                    // Le rayon suit la réduction du plan : l'écran incliné est plus petit, ses
                    // coins le sont d'autant, exactement comme s'il s'éloignait.
                    radius_px: s_radius * quad.scale,
                    mode: 8.0,
                    fx: [tl0, tl1, tr0, tr1],
                    src_prev: [br0, br1, bl0, bl1],
                    dst_prev: [plane_px[0], plane_px[1], 0.0, 0.0],
                    ..Default::default()
                },
                &sy,
                &suv,
            );
        }

        // --- curseur custom : suit le mapping src/dst (zoom+layout), click bounce,
        // et flou de mouvement par fantômes le long de sa vélocité (frame-1 -> frame) ---
        // Jeu de sprites résolu par l'app (art du thème + art intégrée pour les états qu'il ne
        // fournit pas), sinon math dot+ring — fixture/bench sans scène uniquement.
        let cursor_sprites: HashMap<String, SceneCursorSprite> = self
            .scene
            .borrow()
            .as_ref()
            .map(|s| s.cursor.cursor_sprites.clone())
            .unwrap_or_default();
        // « Clip to canvas » : tronque le curseur aux bords de l'écran (utile quand le padding
        // crée une marge et que la pointe, près du bord de la vidéo, dépasserait dedans).
        // Rect englobant tout par défaut = pas d'effet (le mode 4/7 du shader clippe sur `fx`).
        // Écran incliné : le rect droit d'origine rognerait le curseur sur les parties du plan
        // qui débordent au-dessus/en dessous, donc on clippe sur la bbox du quad projeté. Un
        // rect reste une approximation du quadrilatère — `fx` ne sait pas exprimer autre chose —
        // mais qui ne coupe plus rien de ce qui est réellement affiché.
        let cursor_bounds: [f32; 4] = match tilt.as_ref() {
            None => s_dst,
            Some(quad) => {
                let (hx, hy) = quad.half_extents_px();
                [
                    (quad_center_px[0] - hx) / self.rw(),
                    (quad_center_px[1] - hy) / self.rh(),
                    2.0 * hx / self.rw(),
                    2.0 * hy / self.rh(),
                ]
            }
        };
        let cursor_clip_rect: [f32; 4] = match self.scene.borrow().as_ref() {
            Some(s) if s.cursor.clip_to_bounds => cursor_bounds,
            _ => [-1.0, -1.0, 3.0, 3.0],
        };
        // « Show cursor » : piloté par la scène (contrat de l'app) quand elle est posée ; sinon
        // par `cfg.cursor` (inspector / bench fixture).
        let cursor_show = scene_ref
            .as_ref()
            .map(|s| s.cursor.show)
            .unwrap_or(cfg.cursor);
        if cursor_show {
            let cursor_ref = self.cursor.borrow();
            if let Some(track) = cursor_ref.as_ref() {
                let t = self.cursor_t_override.borrow().unwrap_or(frame / FPS);
                // position sortie à un temps donné via un mapping screen (src rect + dst)
                let map = |cxy: Option<(f32, f32)>, s0: [f32; 2], h: [f32; 2], dst: [f32; 4]| {
                    cxy.and_then(|(cx2, cy2)| {
                        let fx = (cx2 * u_max - s0[0]) / (2.0 * h[0]);
                        let fy = (cy2 * v_max - s0[1]) / (2.0 * h[1]);
                        if !(0.0..=1.0).contains(&fx) || !(0.0..=1.0).contains(&fy) {
                            return None;
                        }
                        // Écran incliné : le curseur vit SUR le plan, pas dans un calque
                        // au-dessus. On garde donc sa position dans le repère DU PLAN et c'est
                        // le dessin qui projette — position ET sprite. Le poser sur `dst`, le
                        // rect droit d'origine, le laissait flotter à côté de l'image, l'écart
                        // se comptant en dizaines de pixels là où le plan s'éloigne le plus.
                        Some(match tilt.as_ref() {
                            Some(&quad) => CursorPlacement::Tilted {
                                plane_pt: [fx, fy],
                                quad,
                                center_px: quad_center_px,
                                screen_px: s_px,
                                render_px: [self.rw(), self.rh()],
                            },
                            None => CursorPlacement::Upright {
                                center: [dst[0] + fx * dst[2], dst[1] + fy * dst[3]],
                            },
                        })
                    })
                };
                let raw_xy = track.at(t);
                // Hors de [0,1] = pointeur hors du rect source actuel (zoom serré / hors écran) —
                // état normal en cours de lecture, pas une erreur : rien à dessiner cette frame.
                let mapped = map(raw_xy, [su0, sv0], [hu, hv], s_dst);
                if let Some(cur) = mapped {
                    // taille + amplitude du bounce pilotées par l'inspector (défauts = fixture).
                    // `padding_scale` : le curseur est un recouvrement synthétique, pas cuit dans
                    // la vidéo — quand le padding rétrécit l'écran, le curseur doit rétrécir
                    // pareil pour rester à l'échelle du contenu (sinon sa pointe semble se
                    // décaler/dériver à mesure que le padding grandit).
                    let bounce = 1.0 + (track.bounce(t) - 1.0) * lp.cursor_bounce_scale;
                    // Pas de facteur de tilt ici : sur un plan incliné la taille est convertie
                    // en fraction du plan puis projetée avec lui (voir `draw_cursor_sprite`),
                    // donc la réduction vient de la projection. L'ajouter en plus rétrécirait
                    // le curseur deux fois.
                    let sz = CURSOR_BASE_SIZE_FRAC
                        * frame_min_px
                        * lp.cursor_size_scale
                        * bounce
                        * padding_scale;
                    // flou de mouvement DU CURSEUR, indépendant de cfg.mblur_n (écran/vidéo).
                    // BUG corrigé : augmenter l'intensité ne faisait auparavant que sur-échantillonner
                    // (plus de taps) un écart figé d'1 frame (1/60s) -> la traînée ne s'allongeait
                    // JAMAIS, donc restait quasi invisible quel que soit le réglage. L'intensité doit
                    // étirer la FENÊTRE temporelle de la traînée, pas seulement sa densité d'échantillons.
                    // 0 -> 1 frame en arrière (net) ; 1 -> ~8 frames (~130 ms à 60fps, traînée nette).
                    let blur01 = lp.cursor_motion_blur.clamp(0.0, 1.0);
                    let has_scene = self.scene.borrow().is_some();
                    let trail_frames = if has_scene { 1.0 + blur01 * 7.0 } else { 1.0 };
                    // BUG corrigé : le plancher était 2 (pas 1) -> même à blur=0 le curseur
                    // passait TOUJOURS par le chemin additif multi-tap (poids 1/taps=0.5 chacun),
                    // et comme prev≠cur au pixel près, les deux copies à 0.5 d'alpha ne se
                    // recouvraient jamais parfaitement -> curseur en permanence semi-transparent
                    // (quasi invisible sur fond clair), même sans aucun flou demandé.
                    let taps = if has_scene {
                        (1.0 + blur01 * 10.0).round() as u32 // 0 -> 1 (net) ; 1 -> 11 (traînée)
                    } else {
                        cfg.mblur_n // fixture/bench : comportement historique inchangé
                    };
                    // L'état est celui de l'instant rendu : la traînée de flou reprend le même
                    // sprite pour toutes ses copies, un changement d'état en plein mouvement
                    // n'a pas à laisser une traînée hybride.
                    let cursor_type = track.type_at(t).map(str::to_string);
                    let cursor_type = cursor_type.as_deref();
                    if taps <= 1 {
                        self.draw_cur_themed(
                            &cursor_sprites,
                            cursor_type,
                            cur,
                            sz,
                            1.0,
                            cursor_clip_rect,
                        );
                    } else {
                        let tp = t - trail_frames / FPS;
                        let prev = map(track.at(tp), [su0_p, sv0_p], [hu_p, hv_p], s_dst_prev)
                            .unwrap_or(cur);
                        // Flou RÉEL, pas des copies discrètes : accumule les N échantillons dans un
                        // buffer ISOLÉ (transparent), pas directement sur la scène déjà composée.
                        // BUG précédent : additionner directement sur `self.rtv` revient à AJOUTER
                        // la couleur du curseur (blanc) à ce qu'il y a déjà dessous — sur un fond
                        // clair, ajouter du blanc*petit-alpha ne change presque rien de visible
                        // (déjà proche du blanc) -> curseur quasi invisible. En accumulant d'abord
                        // dans un buffer à part (parti de zéro, même mécanisme que le motion blur
                        // écran de `compose_frame_mb`), la somme reste correctement normalisée
                        // (alpha final ~1 si les échantillons se recouvrent), puis on la composite
                        // sur la scène par un blend "over" classique — correct quel que soit le fond.
                        self.ctx.ClearRenderTargetView(&self.accum_rtv, &[0.0, 0.0, 0.0, 0.0]);
                        self.ctx.OMSetRenderTargets(Some(&[Some(self.accum_rtv.clone())]), None);
                        let w = 1.0 / taps as f32;
                        self.ctx.OMSetBlendState(&self.blend_add, Some(&[w, w, w, w]), 0xffffffff);
                        for k in 0..taps {
                            let f = k as f32 / (taps - 1) as f32;
                            self.draw_cur_themed(
                                &cursor_sprites,
                                cursor_type,
                                prev.lerp(cur, f),
                                sz,
                                1.0,
                                cursor_clip_rect,
                            );
                        }
                        // composite le buffer accumulé sur la scène (blend "over" normal, prémultiplié).
                        self.ctx.OMSetRenderTargets(Some(&[Some(self.rtv.clone())]), None);
                        self.ctx.PSSetShaderResources(0, Some(&[Some(self.accum_srv.clone())]));
                        self.ctx.VSSetShader(&self.vs_fs, None);
                        self.ctx.PSSetShader(&self.ps_tex, None);
                        self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
                        let vp = D3D11_VIEWPORT {
                            TopLeftX: 0.0, TopLeftY: 0.0,
                            Width: self.rw(), Height: self.rh(), MinDepth: 0.0, MaxDepth: 1.0,
                        };
                        self.ctx.RSSetViewports(Some(&[vp]));
                        self.ctx.OMSetBlendState(&self.blend, None, 0xffffffff);
                        self.ctx.Draw(3, 0);
                        self.ctx.PSSetShaderResources(0, Some(&[None]));
                        // restaure l'état de composition standard (VS/PS/topologie quad-strip) pour
                        // le dessin de la webcam qui suit juste après.
                        self.bind_compose_state();
                    }
                }
            }
        }

        // --- webcam : sous-rect SOURCE couvrant la boîte de destination ---
        // La coupe est dérivée du ratio RÉEL de la boîte (`cover_crop_uv`), donc la caméra
        // n'est jamais étirée quel que soit le rect qu'on lui donne.
        //
        // Avant, la source était prise PLEIN CADRE pour rectangle/rounded, en supposant que
        // « le dst matche le ratio de la source ». C'est vrai du placement par DÉFAUT
        // (`fit_cam_aspect` façonne alors le dst), mais faux dès que l'app fournit le rect :
        // le preset side-by-side donne à la caméra un slot de colonne au ratio arbitraire
        // (cf. `computeCompositeLayout`, branche dual-frame — `webcamRect = webcamSlot`, sans
        // aucun ajustement d'aspect), et la caméra y était étirée. L'hypothèse était donc
        // portée par l'appelant ; la dériver ici la rend vraie par construction.
        //
        // Le center-crop carré de square/circle en est un cas particulier (boîte 1:1) — il n'a
        // plus besoin d'être traité à part.
        let (su0, sv0, su1, sv1) = cover_crop_uv(
            [wcw, wch],
            [wtw as f32, wth as f32],
            w_px[0] / w_px[1].max(0.0001),
        );
        // miroir = échanger les bornes u du rect source (flip horizontal).
        let (u0, u1) = if lp.webcam_mirror { (su1, su0) } else { (su0, su1) };
        if lp.has_webcam {
            // L'ombre portée appartient à la bulle flottante PiP : elle se retire avec elle
            // (`shape_fade`), pour qu'au plein écran plus rien n'encadre la caméra. C'est une
            // ombre légère NON paramétrable — indépendante du slider Shadow, qui ne pilote plus
            // que l'écran (`WEBCAM_SHADOW_OPACITY`, pas `shadow_scale`) — et propre au PiP : les
            // blocs side-by-side / top-bottom soudent la caméra à l'écran et n'en portent aucune
            // (parité `preset.shadow` web, `null` hors PiP dans `compositeLayout.ts`).
            let webcam_is_block = matches!(
                scene_preset.as_deref(),
                Some("dual-frame") | Some("vertical-stack"),
            );
            if cfg.shadow && !webcam_is_block && shape_fade > 0.0 {
                let strength = WEBCAM_SHADOW_OPACITY * shape_fade;
                self.draw_shadow(
                    w_dst,
                    w_px,
                    w_radius,
                    WEBCAM_SHADOW_SPREAD_FRAC * frame_min_px,
                    [0.0, WEBCAM_SHADOW_OFFSET_FRAC * frame_min_px],
                    strength,
                );
            }
            self.draw_video(
                &LayerCB {
                    dst: w_dst,
                    src: [u0, sv0, u1, sv1],
                    quad_px: w_px,
                    radius_px: w_radius,
                    mode: 0.0,
                    color: [0.0, 0.0, 0.0, 1.0],
                    src_prev: [u0, sv0, u1, sv1], // src fixe (pas de zoom webcam)
                    dst_prev: w_dst_prev,
                    mb: [mb_taps, 1.0, 1.0, 0.0],
                    ..Default::default()
                },
                &wy,
                &wuv,
            );
        }

        // --- annotations : calque le plus haut, comme dans le DOM de la preview (le calque y est
        // monté après la vidéo). Ancrées sur `s_dst`, le rect ÉCRAN — c'est le conteneur que reçoit
        // l'overlay web (`layout.screenRect`) — et volontairement pas sur le rect de sortie, ni
        // sujettes au crop de zoom : dans la preview l'overlay est frère de l'élément qui porte la
        // transform, donc les annotations restent en place pendant que le contenu zoome dessous.
        // `source_t`, la même base de temps que les zoom/speed regions : le temps SOURCE du clip,
        // pas le compteur de frames. C'est ce qui garde une annotation alignée sur l'image quand
        // une speed region répète ou saute des frames.
        self.draw_annotations(scene_ref.as_ref(), source_t, s_dst);
        Ok(())
    }

    /// Dessine les annotations visibles à `t`. `screen_dst` = rect écran en fractions de sortie.
    ///
    /// Seule la « figure » (flèche) est rendue à ce stade ; texte, image et flou suivront. Les
    /// types non gérés sont ignorés silencieusement plutôt que dessinés de travers : mieux vaut
    /// l'absence connue qu'un placeholder qui ferait croire à un bug de style.
    unsafe fn draw_annotations(&self, scene: Option<&Scene>, t: f32, screen_dst: [f32; 4]) {
        let Some(scene) = scene else { return };
        if scene.annotations.is_empty() {
            return;
        }
        let visible = |a: &crate::scene::SceneAnnotation| {
            t >= a.start_sec as f32 && t < a.end_sec as f32
        };
        // Une seule recopie du render target pour TOUTES les annotations flou de la frame — leur
        // lecture doit voir l'image composée sans les flous eux-mêmes, sinon deux zones qui se
        // recouvrent s'échantillonneraient l'une l'autre selon l'ordre de dessin.
        let needs_copy = scene
            .annotations
            .iter()
            .any(|a| visible(a) && a.kind == "blur" && a.blur.is_some());
        if needs_copy {
            // `CopySubresourceRegion` et non `CopyResource` : les deux textures n'ont pas le même
            // nombre de niveaux, on ne remplit que le mip 0 puis on laisse le GPU dériver le reste.
            self.ctx.CopySubresourceRegion(&self.ann_copy, 0, 0, 0, 0, &self.rt, 0, None);
            self.ctx.GenerateMips(&self.ann_copy_srv);
        }
        // La liste arrive déjà triée par zIndex croissant côté app, donc l'ordre d'itération EST
        // l'ordre de peinture — pas de tri par frame.
        for annotation in &scene.annotations {
            if !visible(annotation) {
                continue;
            }
            let dst = [
                screen_dst[0] + annotation.x * screen_dst[2],
                screen_dst[1] + annotation.y * screen_dst[3],
                annotation.w * screen_dst[2],
                annotation.h * screen_dst[3],
            ];
            let quad_px = [dst[2] * self.rw(), dst[3] * self.rh()];
            if quad_px[0] <= 0.0 || quad_px[1] <= 0.0 {
                continue;
            }
            match annotation.kind.as_str() {
                "figure" => {
                    let Some(figure) = annotation.figure.as_ref() else { continue };
                    let (segments, half_stroke) = crate::regions::arrow_local_geometry(
                        &figure.direction,
                        figure.stroke_width,
                        quad_px,
                    );
                    let rgba = parse_hex(&figure.color).unwrap_or([1.0, 1.0, 1.0, 1.0]);
                    self.draw_solid(&LayerCB {
                        dst,
                        quad_px,
                        mode: 9.0,
                        color: rgba,
                        fx: segments[0],
                        src_prev: segments[1],
                        dst_prev: segments[2],
                        mb: [1.0, half_stroke, 0.0, 0.0],
                        ..Default::default()
                    });
                }
                "blur" => {
                    let Some(blur) = annotation.blur.as_ref() else { continue };
                    // Le masque en tracé libre demande une liste de points côté GPU (buffer
                    // structuré), pas encore faite : on masque alors la BOÎTE ENGLOBANTE.
                    //
                    // Ce choix est délibéré et asymétrique. Ne rien dessiner laisserait passer en
                    // clair, dans le fichier exporté, ce que l'utilisateur a explicitement désigné
                    // comme à cacher — un masque de confidentialité qui ne masque pas est pire que
                    // pas de masque, parce qu'il donne confiance à tort. Sur-flouter une marge
                    // autour de la zone ne trahit personne.
                    let freehand_fallback = blur.shape == "freehand";
                    let is_blur = if blur.style == "blur" { 1.0 } else { 0.0 };
                    // `intensity` pilote le rayon du flou, `block_size` la grille de mosaïque —
                    // deux réglages distincts côté app, un seul paramètre ici selon le style.
                    let amount = if is_blur > 0.5 { blur.intensity } else { blur.block_size };
                    // Le repli du tracé libre passe par le rectangle, pas l'ovale : un ovale
                    // inscrit dans la boîte englobante en retirerait les coins, donc une partie de
                    // ce que l'utilisateur a couvert.
                    let is_oval = if blur.shape == "oval" && !freehand_fallback { 1.0 } else { 0.0 };
                    // La teinte n'a de sens qu'en mosaïque : elle sert à marquer visiblement une
                    // zone caviardée. Un flou teinté ne ressemblerait plus à un flou.
                    let tinted = if is_blur > 0.5 { 0.0 } else { 1.0 };
                    let tint = if blur.color == "black" {
                        [0.0, 0.0, 0.0, 1.0]
                    } else {
                        [1.0, 1.0, 1.0, 1.0]
                    };
                    self.ctx.PSSetShaderResources(2, Some(&[Some(self.ann_copy_srv.clone())]));
                    self.draw_solid(&LayerCB {
                        dst,
                        quad_px,
                        mode: 10.0,
                        color: tint,
                        fx: [is_blur, amount.max(1.0), is_oval, tinted],
                        ..Default::default()
                    });
                }
                "image" => {
                    let Some(src) = annotation.image_path.as_ref() else { continue };
                    if src.is_empty() {
                        continue;
                    }
                    // Cache indexé sur l'ID de l'annotation, pas sur la data URL : celle-ci pèse
                    // souvent des mégaoctets, et la prendre comme clé de HashMap la ferait hacher
                    // à chaque frame. La longueur, stockée à côté, sert de garde-fou quand
                    // l'utilisateur change l'image (une nouvelle image de longueur identique au
                    // bit près serait manquée jusqu'au rechargement — coût accepté en connaissance).
                    let key = annotation.id.clone();
                    let cached = {
                        let cache = self.ann_img_cache.borrow();
                        cache.get(&key).filter(|(_, _, _, len)| *len == src.len()).cloned()
                    };
                    let Some((srv, iw, ih, _)) = cached.or_else(|| {
                        match self.load_image_srv(src) {
                            Ok((srv, w, h)) => {
                                let entry = (srv, w, h, src.len());
                                self.ann_img_cache.borrow_mut().insert(key, entry.clone());
                                Some(entry)
                            }
                            Err(e) => {
                                eprintln!("[annotation image] {}: {e}", annotation.id);
                                None
                            }
                        }
                    }) else {
                        continue;
                    };
                    if iw == 0 || ih == 0 {
                        continue;
                    }
                    // `object-contain`, comme la preview : mise à l'échelle uniforme pour tenir
                    // DANS la boîte, centrée. On rétrécit le rect de destination au ratio de
                    // l'image plutôt que de recadrer la source, ce qui donne exactement ça.
                    let box_aspect = quad_px[0] / quad_px[1];
                    let img_aspect = iw as f32 / ih as f32;
                    let (fit_w, fit_h) = if img_aspect > box_aspect {
                        (dst[2], dst[3] * (box_aspect / img_aspect))
                    } else {
                        (dst[2] * (img_aspect / box_aspect), dst[3])
                    };
                    let fit = [
                        dst[0] + (dst[2] - fit_w) * 0.5,
                        dst[1] + (dst[3] - fit_h) * 0.5,
                        fit_w,
                        fit_h,
                    ];
                    self.ctx.PSSetShaderResources(2, Some(&[Some(srv)]));
                    self.draw_solid(&LayerCB {
                        dst: fit,
                        src: [0.0, 0.0, 1.0, 1.0],
                        quad_px: [fit_w * self.rw(), fit_h * self.rh()],
                        // mode 7 = sprite RGBA avec alpha, déjà utilisé par les thèmes de curseur :
                        // exactement ce qu'il faut ici, donc aucun shader de plus. `fx` est son
                        // rect de clip — plein cadre, pour ne rien découper.
                        mode: 7.0,
                        color: [1.0, 1.0, 1.0, 1.0],
                        fx: [0.0, 0.0, 1.0, 1.0],
                        ..Default::default()
                    });
                }
                "text" => {
                    let Some(text) = annotation.text.as_ref() else { continue };
                    let Some(raster) = self.text_raster.as_ref() else { continue };
                    if text.content.trim().is_empty() {
                        continue;
                    }
                    // `font_size_rel` est une fraction de la HAUTEUR DU RECT ÉCRAN (cf. le contrat
                    // et `annotationScale.ts`) : on la ramène en pixels de sortie ici, avec le même
                    // produit que la preview applique contre sa propre boîte.
                    let screen_h_px = screen_dst[3] * self.rh();
                    let spec = crate::text::TextSpec {
                        content: text.content.clone(),
                        color: parse_hex(&text.color).unwrap_or([1.0, 1.0, 1.0, 1.0]),
                        // "transparent" ne parse pas en hex : alpha 0 => pas de fond, ce qui est
                        // exactement la sémantique CSS.
                        background: parse_hex(&text.background_color).unwrap_or([0.0, 0.0, 0.0, 0.0]),
                        font_size_px: text.font_size_rel * screen_h_px,
                        font_family: text.font_family.clone(),
                        bold: text.font_weight == "bold",
                        italic: text.font_style == "italic",
                        underline: text.text_decoration == "underline",
                        align: text.text_align.clone(),
                        box_px: [quad_px[0].round() as u32, quad_px[1].round() as u32],
                    };
                    let key = spec.cache_key();
                    let cached = {
                        let cache = self.text_cache.borrow();
                        cache.get(&annotation.id).filter(|(_, k)| *k == key).map(|(srv, _)| srv.clone())
                    };
                    let Some(srv) = cached.or_else(|| match raster.rasterize(&self.dev, &spec) {
                        Ok(srv) => {
                            self.text_cache
                                .borrow_mut()
                                .insert(annotation.id.clone(), (srv.clone(), key));
                            Some(srv)
                        }
                        Err(e) => {
                            eprintln!("[annotation texte] {}: {e}", annotation.id);
                            None
                        }
                    }) else {
                        continue;
                    };
                    // Animation d'apparition. Elle est comptée en temps SOURCE (le seul dont on
                    // dispose ici) : dans une région accélérée, elle défile donc au rythme du
                    // clip. À vitesse 1 — le cas de toutes les annotations existantes — c'est
                    // exactement le timing de l'aperçu DOM.
                    let anim = crate::text_anim::text_animation_state(
                        text.animation.as_deref(),
                        (t - annotation.start_sec as f32) * 1000.0,
                    );
                    // Les décalages sont donnés à la hauteur de référence : on les ramène à la
                    // sortie, comme la taille de police, pour que l'animation ait la même
                    // amplitude visuelle quelle que soit la résolution.
                    let anim_px = self.rh() / crate::text_anim::ANIMATION_REFERENCE_HEIGHT;
                    let (mut ax, mut ay, mut aw, mut ah) = (
                        dst[0] + anim.translate_x * anim_px / self.rw(),
                        dst[1] + anim.translate_y * anim_px / self.rh(),
                        dst[2],
                        dst[3],
                    );
                    if (anim.scale - 1.0).abs() > 1e-4 {
                        // Mise à l'échelle autour du CENTRE de la boîte : un texte qui grossit par
                        // son coin haut-gauche glisserait en biais au lieu de gonfler sur place.
                        let (cx, cy) = (ax + aw * 0.5, ay + ah * 0.5);
                        aw *= anim.scale;
                        ah *= anim.scale;
                        ax = cx - aw * 0.5;
                        ay = cy - ah * 0.5;
                    }
                    // Machine à écrire : on ne rogne que la LARGEUR, source et destination
                    // ensemble, ce qui reproduit le `inset(0 X% 0 0)` de l'aperçu sans redemander
                    // une rastérisation par caractère.
                    let reveal = anim.reveal.clamp(0.0, 1.0);
                    if reveal <= 0.0 {
                        continue;
                    }
                    self.ctx.PSSetShaderResources(2, Some(&[Some(srv)]));
                    self.draw_solid(&LayerCB {
                        dst: [ax, ay, aw * reveal, ah],
                        src: [0.0, 0.0, reveal, 1.0],
                        quad_px: [aw * reveal * self.rw(), ah * self.rh()],
                        // mode 11 : sprite en alpha DÉJÀ prémultiplié (ce que produit D2D).
                        mode: 11.0,
                        color: [1.0, 1.0, 1.0, anim.opacity],
                        ..Default::default()
                    });
                }
                _ => {}
            }
        }
        self.ctx.PSSetShaderResources(2, Some(&[None]));
    }

    /// Flou de mouvement (§8) : moyenne de `n` sous-frames aux temps intermédiaires
    /// (mêmes textures vidéo, params d'animation à frame+k/n). Résultat laissé dans le RT.
    pub unsafe fn compose_frame_mb(
        &self,
        screen: *const AVFrame,
        webcam: *const AVFrame,
        frame: u32,
        cfg: &Cfg,
    ) -> Result<()> {
        let n = cfg.mblur_n;
        if n <= 1 {
            return self.compose_frame(screen, webcam, frame as f32, cfg);
        }
        // accumulateur à zéro
        self.ctx.ClearRenderTargetView(&self.accum_rtv, &[0.0, 0.0, 0.0, 0.0]);
        let w = 1.0 / n as f32;
        for k in 0..n {
            let tf = frame as f32 + (k as f32 + 0.5) / n as f32 - 0.5;
            self.compose_frame(screen, webcam, tf, cfg)?; // -> self.rt
            // accum += rt * (1/n)  (blend factor = 1/n, dest = ONE)
            self.ctx.OMSetRenderTargets(Some(&[Some(self.accum_rtv.clone())]), None);
            self.ctx.PSSetShaderResources(0, Some(&[Some(self.rt_srv.clone())]));
            self.ctx.VSSetShader(&self.vs_fs, None);
            self.ctx.PSSetShader(&self.ps_tex, None);
            self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            let vp = D3D11_VIEWPORT {
                TopLeftX: 0.0, TopLeftY: 0.0,
                Width: self.rw(), Height: self.rh(), MinDepth: 0.0, MaxDepth: 1.0,
            };
            self.ctx.RSSetViewports(Some(&[vp]));
            self.ctx.OMSetBlendState(&self.blend_add, Some(&[w, w, w, w]), 0xffffffff);
            self.upload_cb(&LayerCB::default());
            self.ctx.Draw(3, 0);
            self.ctx.PSSetShaderResources(0, Some(&[None]));
        }
        // recopie l'accumulateur dans le RT (pour rgb_to_nv12 qui échantillonne rt_srv)
        let src: ID3D11Resource = self.accum.cast()?;
        let dst: ID3D11Resource = self.rt.cast()?;
        self.ctx.CopyResource(&dst, &src);
        Ok(())
    }

    /// Rend le RT RGBA vers notre texture NV12 puis copie vers la surface `out_tex`/`slice`.
    pub unsafe fn rgb_to_nv12(&self, out_tex: *mut c_void, slice: u32) -> Result<()> {
        self.render_nv12();
        let src: ID3D11Resource = self.nv12.cast()?;
        let dst_tex = ID3D11Texture2D::from_raw_borrowed(&out_tex).unwrap().clone();
        let dst: ID3D11Resource = dst_tex.cast()?;
        self.ctx.CopySubresourceRegion(&dst, slice, 0, 0, 0, &src, 0, None);
        Ok(())
    }

    /// Alloue (une fois par taille) les ressources du resize export : RGBA intermédiaire +
    /// sa propre texture NV12 à `w`×`h`. `w`/`h` doivent être pairs (exigé par NV12 4:2:0,
    /// le plan UV fait exactement la moitié) — l'appelant (export_multi côté napi) arrondit.
    unsafe fn ensure_resize_target(&self, w: u32, h: u32) -> Result<()> {
        if let Some(t) = self.resize_target.borrow().as_ref() {
            if t.w == w && t.h == h {
                return Ok(());
            }
        }
        let rd = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut rgba: Option<ID3D11Texture2D> = None;
        self.dev.CreateTexture2D(&rd, None, Some(&mut rgba))?;
        let rgba = rgba.unwrap();
        let mut rgba_rtv: Option<ID3D11RenderTargetView> = None;
        self.dev.CreateRenderTargetView(&rgba, None, Some(&mut rgba_rtv))?;
        let mut rgba_srv: Option<ID3D11ShaderResourceView> = None;
        self.dev.CreateShaderResourceView(&rgba, None, Some(&mut rgba_srv))?;

        // NV12 non-array à la taille cible (même contrainte que le NV12 principal).
        let nvd = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut nv12: Option<ID3D11Texture2D> = None;
        self.dev.CreateTexture2D(&nvd, None, Some(&mut nv12))?;
        let nv12 = nv12.unwrap();
        let mk_rtv = |fmt: DXGI_FORMAT| -> Result<ID3D11RenderTargetView> {
            let d = D3D11_RENDER_TARGET_VIEW_DESC {
                Format: fmt,
                ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_RTV { MipSlice: 0 } },
            };
            let mut rtv: Option<ID3D11RenderTargetView> = None;
            self.dev.CreateRenderTargetView(&nv12, Some(&d), Some(&mut rtv))?;
            Ok(rtv.unwrap())
        };
        let nv12_rtv_y = mk_rtv(DXGI_FORMAT_R8_UNORM)?;
        let nv12_rtv_uv = mk_rtv(DXGI_FORMAT_R8G8_UNORM)?;

        *self.resize_target.borrow_mut() = Some(ResizeTarget {
            w,
            h,
            rgba_rtv: rgba_rtv.unwrap(),
            rgba_srv: rgba_srv.unwrap(),
            nv12,
            nv12_rtv_y,
            nv12_rtv_uv,
        });
        Ok(())
    }

    /// Redimensionne (bilinéaire) le RT composé (OUT_W×OUT_H) vers `resize_target.rgba`, avant
    /// la conversion NV12 dans `rgb_to_nv12_scaled`.
    ///
    /// Étirement PLEIN CADRE volontaire, y compris non uniforme quand `target_w`×`target_h`
    /// n'a pas le ratio de OUT_W×OUT_H : le fond (wallpaper) doit remplir tout le cadre de
    /// sortie quel que soit le ratio choisi — ce n'est PAS lui qu'il faut préserver en "fit".
    /// L'écran et la webcam, eux, sont protégés de cet étirement en amont, dans
    /// `compose_frame` (rétrécissement inverse de leur rect de destination AVANT ce blit —
    /// voir le commentaire sur `undistort` juste avant leur dessin) : ils gardent leur ratio
    /// d'origine (letterboxé/pillarboxé sur le fond, qui lui reste plein cadre) sans qu'il
    /// faille toucher au viewport ici.
    unsafe fn blit_resized(&self, target_w: u32, target_h: u32) -> Result<()> {
        self.ensure_resize_target(target_w, target_h)?;
        let cache = self.resize_target.borrow();
        let t = cache.as_ref().unwrap();
        self.ctx.OMSetBlendState(&self.blend_none, None, 0xffffffff);
        self.ctx.OMSetRenderTargets(Some(&[Some(t.rgba_rtv.clone())]), None);
        self.ctx.PSSetShaderResources(0, Some(&[Some(self.rt_srv.clone())]));
        self.ctx.VSSetShader(&self.vs_fs, None);
        self.ctx.PSSetShader(&self.ps_tex, None);
        self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
        let vp = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: target_w as f32, Height: target_h as f32, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp]));
        self.ctx.Draw(3, 0);
        self.ctx.PSSetShaderResources(0, Some(&[None]));
        Ok(())
    }

    /// Lit le RT composité (résolu à `target_w`×`target_h`, via le même `blit_resized`
    /// réutilisé par `rgb_to_nv12_scaled` pour l'export) vers un `Vec<u8>` RGBA8
    /// tightly-packed (`target_w * target_h * 4` octets, ordre R,G,B,A en mémoire — ce
    /// que `putImageData(..., 'rgba8')` attend côté JS).
    ///
    /// Pourquoi un helper dédié plutôt qu'un open-coding dans `live.rs` : tout le
    /// pattern GPU→CPU de ce fichier (staging `D3D11_USAGE_STAGING`, `CopyResource`,
    /// `Map`/`D3D11_MAP_READ` + copie ligne par ligne qui respecte `RowPitch`) vit déjà
    /// dans `dump_nv12`/`dump_raw` — le partager garde la connaissance D3D11 confinée
    /// à ce fichier et assure que le live et l'export ne divergent pas sur un détail de
    /// copie. La staging est cachée par taille (`live_readback_staging`) — recréée quand
    /// `target_w`/`target_h` changent — pour ne pas payer une allocation par frame.
    ///
    /// Pré-requis : `target_w`/`target_h` ≥ 1. Aucun effet sur le pipeline d'export
    /// (les sites d'appel de `rgb_to_nv12_scaled` et `blit_resized` ne sont pas touchés
    /// — ce helper réutilise `blit_resized` mais n'est pas sur le chemin d'export).
    pub unsafe fn readback_resized(
        &self,
        target_w: u32,
        target_h: u32,
    ) -> Result<Vec<u8>> {
        // `ensure_resize_target` (partagé avec l'export) crée INCONDITIONNELLEMENT une
        // texture NV12 en plus de la RGBA, même si ce chemin RGBA-only ne s'en sert jamais —
        // et NV12 (4:2:0, chroma sous-échantillonnée 2×2) exige des dimensions PAIRES.
        // Le canvas Electron (taille device-pixel arbitraire, ex. 910×513) atterrit souvent
        // sur une dimension impaire → `CreateTexture2D` de la texture NV12 échouait avec
        // E_INVALIDARG (0x80070057), et donc TOUT le readback live (jamais une seule frame
        // publiée). On arrondit au pair supérieur ici uniquement — l'export appelle
        // `rgb_to_nv12_scaled`/`blit_resized` directement avec ses propres dimensions et
        // n'est pas concerné par cet arrondi.
        let w = (target_w.max(1) + 1) & !1;
        let h = (target_h.max(1) + 1) & !1;
        // Dims RÉELLEMENT demandées par l'appelant — le buffer retourné doit rester à cette
        // taille exacte (le canvas JS attend `target_w*target_h*4` octets pile), même si le GPU
        // travaille en interne à `w`×`h` (arrondi pair) pour satisfaire la contrainte NV12.
        let out_w = target_w.max(1);
        let out_h = target_h.max(1);

        // 1) Resize GPU exactement comme `rgb_to_nv12_scaled` : remplit le `resize_target`
        //    RGBA à `w`×`h`. On s'arrête avant la conversion NV12 — on copie le RGBA.
        self.blit_resized(w, h)?;
        // BUG corrigé : un SRV n'est PAS la ressource (`ID3D11ShaderResourceView` et
        // `ID3D11Texture2D` sont des interfaces COM sans rapport de parenté) — un
        // `.cast::<ID3D11Texture2D>()` direct sur le SRV échoue avec E_NOINTERFACE
        // (0x80004002, confirmé à l'exécution). Il faut passer par `GetResource()`
        // (méthode de `ID3D11View`, implémentée par tout SRV/RTV) pour récupérer la
        // ressource sous-jacente, ici directement en `ID3D11Resource` — le type que
        // `CopyResource` attend de toute façon, donc pas besoin d'aller jusqu'à
        // `ID3D11Texture2D`.
        let rgba_resource: ID3D11Resource = {
            let cache = self.resize_target.borrow();
            let t = cache.as_ref().unwrap();
            t.rgba_srv.GetResource()?
        };

        // 2) Staging texture CPU-readable à la taille cible, recréée paresseusement
        //    quand la taille change (cache : `live_readback_staging`).
        let staging = {
            let mut slot = self.live_readback_staging.borrow_mut();
            match slot.as_ref() {
                Some((sw, sh, t)) if *sw == w && *sh == h => t.clone(),
                _ => {
                    let desc = D3D11_TEXTURE2D_DESC {
                        Width: w,
                        Height: h,
                        MipLevels: 1,
                        ArraySize: 1,
                        // Même format que `resize_target.rgba` créé dans
                        // `ensure_resize_target` (R8G8B8A8_UNORM) — la `CopyResource`
                        // est valide sans conversion GPU.
                        Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                        Usage: D3D11_USAGE_STAGING,
                        BindFlags: 0,
                        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                        MiscFlags: 0,
                    };
                    let mut tex: Option<ID3D11Texture2D> = None;
                    self.dev.CreateTexture2D(&desc, None, Some(&mut tex))?;
                    let tex = tex.unwrap();
                    *slot = Some((w, h, tex.clone()));
                    tex
                }
            }
        };

        // 3) GPU → CPU : `CopyResource` resize_target → staging, puis `Map` + copie
        //    ligne par ligne qui respecte `RowPitch` (cf. `dump_nv12`/`dump_raw`).
        // `ID3D11Texture2D` hérite réellement de `ID3D11Resource` (contrairement au
        // SRV plus haut) donc ce `.cast()` est valide.
        let dst: ID3D11Resource = staging.cast()?;
        self.ctx.CopyResource(&dst, &rgba_resource);
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        self.ctx.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut m))?;
        // Crop implicite : on ne lit que les `out_w`×`out_h` premiers pixels de la texture
        // (arrondie pair) — le reliquat éventuel (au plus 1px en largeur/hauteur) est ignoré.
        let mut out: Vec<u8> = vec![0u8; (out_w * out_h * 4) as usize];
        let row_bytes = (out_w * 4) as usize;
        for y in 0..out_h as usize {
            let src_row = (m.pData as *const u8).add(y * m.RowPitch as usize);
            let dst_row = out.as_mut_ptr().add(y * row_bytes);
            std::ptr::copy_nonoverlapping(src_row, dst_row, row_bytes);
        }
        self.ctx.Unmap(&staging, 0);
        Ok(out)
    }

    /// Readback du RT composité vers CPU **à sa résolution de rendu**, sans aucun resize.
    ///
    /// Contrairement à `readback_resized` (qui passe par `blit_resized` → un `resize_target`
    /// incluant une texture NV12 jamais lue par ce chemin RGBA-only, puis une staging séparée),
    /// on copie directement `rt → staging` : la `staging` du compositeur est DÉJÀ dimensionnée
    /// à la résolution de rendu (`new_inner`), exactement le patron de `dump_raw`. Depuis la
    /// refonte ratio, le RT est rastérisé à la géométrie de sortie ramenée au panneau — soit
    /// précisément la taille que la preview veut afficher —, donc le resize de `readback_resized`
    /// était devenu une copie identité doublée d'une alloc NV12 inutile, du coût pur à chaque
    /// frame. `readback_resized` reste pour le golden test (qui readback à une taille arbitraire).
    ///
    /// Retourne `(render_w, render_h, pixels)` avec `pixels.len() == render_w * render_h * 4`
    /// octets RGBA8 tightly-packed. L'appelant (`live.rs`) publie ces dims dans le packet ; le
    /// canvas côté JS se dimensionne dessus (frame auto-descriptive), donc aucun couplage de
    /// taille à maintenir des deux côtés.
    pub unsafe fn readback_direct(&self) -> Result<(u32, u32, Vec<u8>)> {
        let (rw, rh) = self.render_dims();
        self.ctx.CopyResource(&self.staging, &self.rt);
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        self.ctx.Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut m))?;
        // Copie ligne par ligne qui respecte `RowPitch` (la staging peut être paddée par le
        // driver) — même idiome que `dump_raw`/`readback_resized`.
        let row = (rw * 4) as usize;
        let mut out = vec![0u8; row * rh as usize];
        for y in 0..rh as usize {
            let src = (m.pData as *const u8).add(y * m.RowPitch as usize);
            let dst = out.as_mut_ptr().add(y * row);
            std::ptr::copy_nonoverlapping(src, dst, row);
        }
        self.ctx.Unmap(&self.staging, 0);
        Ok((rw, rh, out))
    }

    /// Comme `rgb_to_nv12`, mais redimensionne d'abord (bilinéaire, `ps_tex`/`sampler` déjà
    /// utilisés partout ailleurs dans le fichier) le RT composé — toujours rendu en interne à
    /// OUT_W×OUT_H, quelle que soit la taille de sortie demandée — vers `target_w`×`target_h`
    /// avant la conversion NV12. Identique à `rgb_to_nv12` (donc coût inchangé) quand la cible
    /// égale la résolution interne : le live et les exports "Source"/1080p ne paient rien pour
    /// cette fonctionnalité.
    pub unsafe fn rgb_to_nv12_scaled(
        &self,
        target_w: u32,
        target_h: u32,
        out_tex: *mut c_void,
        slice: u32,
    ) -> Result<()> {
        // Raccourci : la cible est déjà la taille à laquelle on vient de rastériser
        // → aucun resize à faire, on convertit le RT directement. Comparé à la
        // taille de rendu COURANTE et non à une constante : une fois le RT aligné
        // sur `output`, c'est justement le cas nominal.
        // Produire le NV12 (partagé avec l'encodeur logiciel), puis le copier GPU→GPU
        // vers le pool de l'encodeur matériel — la seule partie qui lui soit propre.
        let src_tex = self.nv12_source(target_w, target_h)?;
        let src: ID3D11Resource = src_tex.cast()?;
        let dst_tex = ID3D11Texture2D::from_raw_borrowed(&out_tex).unwrap().clone();
        let dst: ID3D11Resource = dst_tex.cast()?;
        self.ctx.CopySubresourceRegion(&dst, slice, 0, 0, 0, &src, 0, None);
        Ok(())
    }

    /// Rastérise le NV12 de sortie à `target_w`×`target_h` et rend LA TEXTURE du
    /// compositeur qui le porte. C'est la moitié commune aux deux encodeurs : le matériel
    /// la copie GPU→GPU vers le pool AMF (`rgb_to_nv12_scaled` ci-dessus), le logiciel la
    /// relit vers la RAM (`read_nv12_scaled` ci-dessous). Extraite pour que les deux
    /// backends produisent le MÊME NV12 — sinon l'export CPU dériverait du matériel sur
    /// un détail de conversion, exactement ce que l'iso doit empêcher.
    unsafe fn nv12_source(&self, target_w: u32, target_h: u32) -> Result<ID3D11Texture2D> {
        let (rw_i, rh_i) = self.render_dims();
        if target_w == rw_i && target_h == rh_i {
            self.render_nv12();
            return Ok(self.nv12.clone());
        }
        // Même séquence que `rgb_to_nv12_scaled`, dont c'est la partie « produire ».
        self.blit_resized(target_w, target_h)?;
        let cache = self.resize_target.borrow();
        let t = cache.as_ref().unwrap();
        self.ctx.OMSetRenderTargets(Some(&[Some(t.nv12_rtv_y.clone())]), None);
        self.ctx.PSSetShaderResources(0, Some(&[Some(t.rgba_srv.clone())]));
        let vp_y = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: target_w as f32, Height: target_h as f32, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp_y]));
        self.ctx.PSSetShader(&self.ps_y, None);
        self.ctx.Draw(3, 0);

        self.ctx.OMSetRenderTargets(Some(&[Some(t.nv12_rtv_uv.clone())]), None);
        let vp_uv = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: (target_w / 2) as f32, Height: (target_h / 2) as f32, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp_uv]));
        self.ctx.PSSetShader(&self.ps_uv, None);
        self.ctx.Draw(3, 0);
        self.ctx.PSSetShaderResources(0, Some(&[None]));
        Ok(t.nv12.clone())
    }

    /// Le NV12 de sortie LU vers la mémoire système, plan Y puis plan UV.
    ///
    /// Pendant de `rgb_to_nv12_scaled` pour un encodeur LOGICIEL : `libopenh264` ne sait
    /// pas prendre une texture D3D11, il veut des plans en RAM. C'est la seule copie
    /// GPU→CPU du chemin d'export CPU, et elle est inévitable — le backend CPU rastérise
    /// sur WARP (donc déjà en RAM côté pilote) mais D3D11 n'expose pas ces octets
    /// autrement que par une staging.
    ///
    /// `dst_y`/`dst_uv` doivent tenir `target_h * pitch_y` et `target_h/2 * pitch_uv`
    /// octets — typiquement les `data[0]`/`data[1]` d'une `AVFrame` NV12.
    pub unsafe fn read_nv12_scaled(
        &self,
        target_w: u32,
        target_h: u32,
        dst_y: *mut u8,
        pitch_y: usize,
        dst_uv: *mut u8,
        pitch_uv: usize,
    ) -> Result<()> {
        let src_tex = self.nv12_source(target_w, target_h)?;

        // Staging NV12 cachée par taille (même idiome que `live_readback_staging`) :
        // une allocation par changement de résolution, pas une par frame.
        let mut cache = self.nv12_readback_staging.borrow_mut();
        if cache.as_ref().map(|(w, h, _)| (*w, *h)) != Some((target_w, target_h)) {
            let sd = D3D11_TEXTURE2D_DESC {
                Width: target_w,
                Height: target_h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut t: Option<ID3D11Texture2D> = None;
            self.dev.CreateTexture2D(&sd, None, Some(&mut t))?;
            *cache = Some((target_w, target_h, t.unwrap()));
        }
        let staging = &cache.as_ref().unwrap().2;

        let src: ID3D11Resource = src_tex.cast()?;
        let dst: ID3D11Resource = staging.cast()?;
        self.ctx.CopyResource(&dst, &src);

        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        self.ctx.Map(&dst, 0, D3D11_MAP_READ, 0, Some(&mut m))?;
        // Disposition NV12 mappée : Y sur `target_h` lignes de `RowPitch`, puis UV sur
        // `target_h/2` lignes au même pitch. Copie ligne par ligne — les deux pitchs
        // diffèrent (le driver pad, ffmpeg aligne sur son propre SIMD).
        let row = (target_w as usize).min(m.RowPitch as usize).min(pitch_y);
        for y in 0..target_h as usize {
            let s = (m.pData as *const u8).add(y * m.RowPitch as usize);
            std::ptr::copy_nonoverlapping(s, dst_y.add(y * pitch_y), row);
        }
        let uv_src = (m.pData as *const u8).add(m.RowPitch as usize * target_h as usize);
        let uv_row = (target_w as usize).min(m.RowPitch as usize).min(pitch_uv);
        for y in 0..(target_h as usize / 2) {
            let s = uv_src.add(y * m.RowPitch as usize);
            std::ptr::copy_nonoverlapping(s, dst_uv.add(y * pitch_uv), uv_row);
        }
        self.ctx.Unmap(&dst, 0);
        Ok(())
    }

    /// Convertit le RT RGBA vers notre texture NV12 (§5) : Y pleine réso, UV demi-réso.
    pub unsafe fn render_nv12(&self) {
        self.ctx.OMSetBlendState(&self.blend_none, None, 0xffffffff);
        self.ctx.VSSetShader(&self.vs_fs, None);
        self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));

        // passe Y : basculer le RT AVANT de binder le SRV (le RGBA RT était encore RTV via
        // begin() ; D3D11 rejetterait le SRV d'une ressource encore liée en RTV).
        self.ctx.OMSetRenderTargets(Some(&[Some(self.rtv_y.clone())]), None);
        self.ctx.PSSetShaderResources(0, Some(&[Some(self.rt_srv.clone())]));
        let vp_y = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: self.rw(), Height: self.rh(), MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp_y]));
        self.ctx.PSSetShader(&self.ps_y, None);
        self.ctx.Draw(3, 0);

        // passe UV (demi-résolution)
        self.ctx.OMSetRenderTargets(Some(&[Some(self.rtv_uv.clone())]), None);
        let vp_uv = D3D11_VIEWPORT {
            TopLeftX: 0.0, TopLeftY: 0.0,
            Width: self.rw() / 2.0, Height: self.rh() / 2.0, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp_uv]));
        self.ctx.PSSetShader(&self.ps_uv, None);
        self.ctx.Draw(3, 0);

        // libère le SRV du RT (il redevient RTV au prochain begin())
        self.ctx.PSSetShaderResources(0, Some(&[None]));
    }

    /// Debug : dump notre NV12 (Y puis UV entrelacé) en RAW, pour inspecter la conversion.
    pub unsafe fn dump_nv12(&self, path: &str) -> Result<()> {
        let sd = D3D11_TEXTURE2D_DESC {
            Width: OUT_W,
            Height: OUT_H,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut stg: Option<ID3D11Texture2D> = None;
        self.dev.CreateTexture2D(&sd, None, Some(&mut stg))?;
        let stg = stg.unwrap();
        let src: ID3D11Resource = self.nv12.cast()?;
        let dstr: ID3D11Resource = stg.cast()?;
        self.ctx.CopyResource(&dstr, &src);
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        self.ctx.Map(&stg, 0, D3D11_MAP_READ, 0, Some(&mut m))?;
        let (rw_i, rh_i) = self.render_dims();
        let mut out = Vec::with_capacity((rw_i * rh_i * 3 / 2) as usize);
        // plan Y
        for y in 0..rh_i as usize {
            let row = (m.pData as *const u8).add(y * m.RowPitch as usize);
            out.extend_from_slice(std::slice::from_raw_parts(row, rw_i as usize));
        }
        // plan UV : commence à RowPitch*Height (offset donné par le pitch), demi-hauteur
        let uv_off = m.RowPitch as usize * rh_i as usize;
        for y in 0..(rh_i / 2) as usize {
            let row = (m.pData as *const u8).add(uv_off + y * m.RowPitch as usize);
            out.extend_from_slice(std::slice::from_raw_parts(row, rw_i as usize));
        }
        self.ctx.Unmap(&stg, 0);
        std::fs::write(path, &out)?;
        Ok(())
    }

    /// Recopie le RT en RAM (RGBA tightly-packed) — vérification uniquement.
    pub unsafe fn dump_raw(&self, path: &str) -> Result<()> {
        self.ctx.CopyResource(&self.staging, &self.rt);
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        self.ctx.Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut m))?;
        let (rw_i, rh_i) = self.render_dims();
        let mut out = vec![0u8; (rw_i * rh_i * 4) as usize];
        for y in 0..rh_i as usize {
            let src = (m.pData as *const u8).add(y * m.RowPitch as usize);
            let dst = out.as_mut_ptr().add(y * rw_i as usize * 4);
            std::ptr::copy_nonoverlapping(src, dst, rw_i as usize * 4);
        }
        self.ctx.Unmap(&self.staging, 0);
        std::fs::write(path, &out)?;
        Ok(())
    }

    /// Blit du RT composité (RGBA) vers un render target externe (backbuffer swapchain),
    /// mis à l'échelle dans le viewport `(x,y,w,h)` en pixels — sert la preview (§preview).
    /// Passe de copie `ps_tex` : même échantillonnage que `render_nv12`, sans conversion.
    /// Le caller a déjà clear le RTV (barres letterbox) avant l'appel.
    pub unsafe fn blit_to(&self, rtv: &ID3D11RenderTargetView, x: f32, y: f32, w: f32, h: f32) {
        self.ctx.OMSetBlendState(&self.blend_none, None, 0xffffffff);
        self.ctx.OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);
        self.ctx.PSSetShaderResources(0, Some(&[Some(self.rt_srv.clone())]));
        self.ctx.VSSetShader(&self.vs_fs, None);
        self.ctx.PSSetShader(&self.ps_tex, None);
        self.ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
        self.ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
        let vp = D3D11_VIEWPORT {
            TopLeftX: x, TopLeftY: y, Width: w, Height: h, MinDepth: 0.0, MaxDepth: 1.0,
        };
        self.ctx.RSSetViewports(Some(&[vp]));
        self.upload_cb(&LayerCB::default());
        self.ctx.Draw(3, 0);
        self.ctx.PSSetShaderResources(0, Some(&[None]));
    }

    /// Vide le cache de SRV décodeur. À appeler après la fermeture d'un jeu de décodeurs
    /// (p.ex. après un export) pour ne pas retenir indéfiniment des textures de pool.
    pub fn clear_srv_cache(&self) {
        self.srv_cache.borrow_mut().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Le HLSL est compilé au démarrage du compositeur : jusqu'ici une faute dedans ne se voyait
    /// qu'à l'exécution, donc après un rebuild du natif ET un relancement de l'app. `D3DCompile`
    /// ne demande aucun device — le compilateur seul suffit, et ça tient en quelques
    /// millisecondes.
    #[test]
    fn every_shader_entry_point_compiles() {
        let hlsl = include_bytes!("shaders.hlsl");
        for (entry, target) in [
            (&b"vs_main\0"[..], &b"vs_5_0\0"[..]),
            (&b"ps_main\0"[..], &b"ps_5_0\0"[..]),
            (&b"vs_fs\0"[..], &b"vs_5_0\0"[..]),
            (&b"ps_y\0"[..], &b"ps_5_0\0"[..]),
            (&b"ps_uv\0"[..], &b"ps_5_0\0"[..]),
            (&b"ps_blur\0"[..], &b"ps_5_0\0"[..]),
            (&b"ps_tex\0"[..], &b"ps_5_0\0"[..]),
            (&b"ps_kawase_down\0"[..], &b"ps_5_0\0"[..]),
            (&b"ps_kawase_up\0"[..], &b"ps_5_0\0"[..]),
        ] {
            let name = String::from_utf8_lossy(&entry[..entry.len() - 1]).to_string();
            unsafe { compile(hlsl, entry, target) }
                .unwrap_or_else(|e| panic!("{name} ne compile pas : {e}"));
        }
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
}
