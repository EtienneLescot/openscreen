//! Rastérisation du texte des annotations sur macOS — CoreText + CoreGraphics.
//!
//! Équivalent macOS de `text_windows.rs` (DirectWrite + Direct2D sur surface DXGI).
//! Le module exporte la même surface publique (`TextSpec`, `TextRasterizer`) pour que
//! `compositor.rs` puisse appeler `TextRasterizer::new()` / `rasterize(...)` sans
//! connaître la plateforme.
//!
//! # Pipeline
//!
//! Tout passe par les API **C** de CoreText/CoreGraphics, pas par `msg_send!` :
//! `CTFont`, `CTFramesetter`, `CTFrame`, `CGColor` et `CGContext` sont des CFTypes, pas
//! des classes Objective-C. (La première version de ce fichier envoyait
//! `deviceRGBColorSpace` à une classe `CGColorSpace` et `stringWithCString:encoding:` à
//! une classe `CFString` ; aucune des deux n'existe dans le runtime ObjC, donc
//! `AnyClass::get` rendait `None` et chaque attribut était silencieusement sauté. Les
//! clés d'attribut étaient elles aussi fabriquées : `Sel::register("NSColor")` produit un
//! sélecteur, là où `CFAttributedString` attend la CFString `kCTForegroundColorAttributeName`.)
//!
//! 1. `CGBitmapContextCreate` sur un buffer CPU, BGRA prémultiplié
//!    (`kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little`) — l'ordre d'octets
//!    que `MTLPixelFormat::BGRA8Unorm` attend.
//! 2. `CFAttributedString` avec police (`kCTFontAttributeName`), couleur
//!    (`kCTForegroundColorAttributeName`), soulignement (`kCTUnderlineStyleAttributeName`)
//!    et alignement (`kCTParagraphStyleAttributeName`).
//! 3. `CTFramesetterSuggestFrameSizeWithConstraints` mesure le bloc mis en page, puis
//!    `block_layout` en déduit le cadre (centré verticalement) et la plaque de fond
//!    (`spec.background`, alpha 0 = transparent) qui l'habille.
//! 4. `CTFramesetterCreateFrame` sur ce cadre, puis `CTFrameDraw`.
//! 5. `MTLTexture` BGRA8Unorm + `replace_region` depuis le buffer CPU.
//!
//! `TextSpec::cache_key()` est byte-identique à la version Windows — la policy de cache
//! est partagée.

use crate::d3d::Gpu;
use anyhow::{anyhow, bail, Result};
use std::ffi::c_void;

/// Spécification d'un texte à rastériser. Mêmes champs que `text_windows::TextSpec`
/// — le moteur macOS les consomme via `cache_key` pour déterminer si une re-rastérisation
/// est nécessaire.
#[derive(Clone, PartialEq)]
pub struct TextSpec {
    pub content: String,
    /// RGBA 0..1 (déjà parsé depuis la chaîne CSS côté appelant).
    pub color: [f32; 4],
    /// RGBA 0..1 ; alpha 0 = pas de fond (le CSS `transparent`).
    pub background: [f32; 4],
    pub font_size_px: f32,
    pub font_family: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    /// "left" | "center" | "right".
    pub align: String,
    /// "top" | "center" | "bottom" — quelle arête du bloc est épinglée à la boîte.
    /// "center" est le comportement historique (et celui des annotations) ; les
    /// sous-titres passent "bottom" ou "top" pour que l'arête ancrée ne bouge pas
    /// quand le texte gagne une ligne.
    pub valign: String,
    /// Taille de la boîte en px de sortie — la mise en page en dépend (retours à la ligne).
    pub box_px: [u32; 2],
}

impl TextSpec {
    /// Clé de cache : couvre exactement les champs dont la variation provoque un
    /// changement de pixels. Identique côté Windows/macOS (la policy est partagée).
    pub fn cache_key(&self) -> u64 {
        // FNV-1a sur les mêmes octets, dans le même ordre, que
        // `text_windows::TextSpec::cache_key`. La version précédente appelait
        // `Hash::hash(&mut h)` avec un `u64` en guise de `Hasher` — ça ne compile pas,
        // et même corrigé, `DefaultHasher` ne donne pas la même clé que Windows.
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |bytes: &[u8]| {
            for b in bytes {
                h ^= *b as u64;
                h = h.wrapping_mul(0x100_0000_01b3);
            }
        };
        mix(self.content.as_bytes());
        mix(self.font_family.as_bytes());
        mix(&self.font_size_px.to_bits().to_le_bytes());
        for c in self.color.iter().chain(self.background.iter()) {
            mix(&c.to_bits().to_le_bytes());
        }
        mix(&[self.bold as u8, self.italic as u8, self.underline as u8]);
        mix(self.align.as_bytes());
        // Juste après `align`, mêmes octets et même position que sur les deux
        // autres backends : deux specs ne différant que par l'alignement vertical
        // rendraient sinon les pixels l'une de l'autre depuis le cache.
        mix(self.valign.as_bytes());
        mix(&self.box_px[0].to_le_bytes());
        mix(&self.box_px[1].to_le_bytes());
        h
    }
}

// ---------------------------------------------------------------------------
// FFI CoreFoundation / CoreGraphics / CoreText
// ---------------------------------------------------------------------------

type CFTypeRef = *const c_void;
type CFIndex = isize;
type CGFloat = f64;

#[repr(C)]
#[derive(Clone, Copy)]
struct CFRange {
    location: CFIndex,
    length: CFIndex,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: CGFloat,
    y: CGFloat,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: CGFloat,
    height: CGFloat,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

/// `kCGImageAlphaPremultipliedFirst` (=2) | `kCGBitmapByteOrder32Little` (=2 << 12).
/// Ensemble : ARGB prémultiplié en mémoire little-endian, soit l'ordre d'octets B,G,R,A —
/// exactement `MTLPixelFormat::BGRA8Unorm`.
const CG_BITMAP_INFO_BGRA_PREMUL: u32 = 2 | (2 << 12);
/// `kCFStringEncodingUTF8`.
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
/// `kCFNumberSInt32Type`.
const K_CF_NUMBER_S_INT32_TYPE: CFIndex = 3;
/// `kCTParagraphStyleSpecifierAlignment`.
const K_CT_PARAGRAPH_STYLE_SPECIFIER_ALIGNMENT: u32 = 0;
/// `CTFontSymbolicTraits` : italique / gras.
const K_CT_FONT_TRAIT_ITALIC: u32 = 1 << 0;
const K_CT_FONT_TRAIT_BOLD: u32 = 1 << 1;

#[repr(C)]
#[derive(Clone, Copy)]
struct CTParagraphStyleSetting {
    spec: u32,
    value_size: usize,
    value: *const c_void,
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFStringCreateWithBytes(
        alloc: CFTypeRef,
        bytes: *const u8,
        num_bytes: CFIndex,
        encoding: u32,
        is_external_representation: u8,
    ) -> CFTypeRef;
    fn CFNumberCreate(alloc: CFTypeRef, the_type: CFIndex, value_ptr: *const c_void) -> CFTypeRef;
    fn CFDictionaryCreate(
        alloc: CFTypeRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        num_values: CFIndex,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFTypeRef;
    fn CFAttributedStringCreate(
        alloc: CFTypeRef,
        str_: CFTypeRef,
        attributes: CFTypeRef,
    ) -> CFTypeRef;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGColorSpaceCreateDeviceRGB() -> CFTypeRef;
    fn CGColorSpaceRelease(space: CFTypeRef);
    fn CGColorCreate(space: CFTypeRef, components: *const CGFloat) -> CFTypeRef;
    fn CGBitmapContextCreate(
        data: *mut c_void,
        width: usize,
        height: usize,
        bits_per_component: usize,
        bytes_per_row: usize,
        space: CFTypeRef,
        bitmap_info: u32,
    ) -> CFTypeRef;
    fn CGContextRelease(ctx: CFTypeRef);
    fn CGContextSetRGBFillColor(ctx: CFTypeRef, r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat);
    fn CGContextAddPath(ctx: CFTypeRef, path: CFTypeRef);
    fn CGContextFillPath(ctx: CFTypeRef);
    fn CGPathCreateWithRect(rect: CGRect, transform: *const c_void) -> CFTypeRef;
    fn CGPathCreateWithRoundedRect(
        rect: CGRect,
        corner_width: CGFloat,
        corner_height: CGFloat,
        transform: *const c_void,
    ) -> CFTypeRef;
}

#[link(name = "CoreText", kind = "framework")]
extern "C" {
    fn CTFontCreateWithName(name: CFTypeRef, size: CGFloat, matrix: *const c_void) -> CFTypeRef;
    fn CTFontCreateCopyWithSymbolicTraits(
        font: CFTypeRef,
        size: CGFloat,
        matrix: *const c_void,
        sym_trait_value: u32,
        sym_trait_mask: u32,
    ) -> CFTypeRef;
    fn CTParagraphStyleCreate(settings: *const CTParagraphStyleSetting, count: usize) -> CFTypeRef;
    fn CTFramesetterCreateWithAttributedString(attr: CFTypeRef) -> CFTypeRef;
    fn CTFramesetterSuggestFrameSizeWithConstraints(
        framesetter: CFTypeRef,
        string_range: CFRange,
        frame_attributes: CFTypeRef,
        constraints: CGSize,
        fit_range: *mut CFRange,
    ) -> CGSize;
    fn CTFramesetterCreateFrame(
        framesetter: CFTypeRef,
        string_range: CFRange,
        path: CFTypeRef,
        frame_attributes: CFTypeRef,
    ) -> CFTypeRef;
    fn CTFrameDraw(frame: CFTypeRef, context: CFTypeRef);

    static kCTFontAttributeName: CFTypeRef;
    static kCTForegroundColorAttributeName: CFTypeRef;
    static kCTUnderlineStyleAttributeName: CFTypeRef;
    static kCTParagraphStyleAttributeName: CFTypeRef;
}

/// Garde RAII sur un CFType : `CFRelease` au Drop. Sans elle, chaque rastérisation fuit
/// une police, une couleur, un framesetter et une frame — et la rastérisation est
/// re-déclenchée à chaque changement du texte.
struct CFOwned(CFTypeRef);

impl CFOwned {
    fn new(r: CFTypeRef) -> Option<CFOwned> {
        if r.is_null() {
            None
        } else {
            Some(CFOwned(r))
        }
    }
    fn get(&self) -> CFTypeRef {
        self.0
    }
}

impl Drop for CFOwned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}

// ---------------------------------------------------------------------------
// Modèle de boîte du bloc de texte
// ---------------------------------------------------------------------------

/// Marge et rayon de la plaque : `crate::text_plate`, partagé avec le rendu Direct2D.
/// Les deux plateformes DOIVENT lire les mêmes nombres — cf. l'en-tête de ce module.
fn plate_padding(font_px: CGFloat) -> (CGFloat, CGFloat) {
    let (x, y) = crate::text_plate::padding(font_px as f32);
    (x as CGFloat, y as CGFloat)
}

/// `CTTextAlignment` : 0 = left, 1 = right, 2 = center (3 = justified, 4 = natural).
fn ct_alignment(align: &str) -> u8 {
    match align {
        "left" => 0,
        "right" => 1,
        _ => 2,
    }
}

/// Où poser le cadre de mise en page et la plaque de fond dans une boîte `box_w`×`box_h`,
/// une fois le bloc mesuré à `text_w`×`text_h`.
///
/// Repère **CoreGraphics** : origine en BAS à gauche, `y` croissant vers le haut. Le
/// bitmap, lui, range sa ligne 0 en HAUT — d'où la conversion `box_h - haut - hauteur`,
/// faite ici une fois pour toutes plutôt que dispersée dans les appels de dessin.
///
/// Deux choses que la version précédente ne faisait pas :
///
/// * **centrage vertical.** `CTFrameDraw` remplit son cadre du haut vers le bas ; avec un
///   cadre couvrant toute la boîte, les lignes se collaient en haut et laissaient le reste
///   vide. Une bande de sous-titres fait 22 % de la hauteur de l'image
///   (`CAPTION_BAND_HEIGHT_PCT`, volontairement généreuse pour absorber deux lignes), donc
///   « le reste » représentait ~180 px sur 238 en 1080p. C'est l'énorme marge basse.
///   Windows n'avait pas le problème : `DWRITE_PARAGRAPH_ALIGNMENT_CENTER`.
///
///   Ce centrage est aussi la raison pour laquelle une bande de sous-titres peut désormais
///   déborder du cadre : côté app, `captionOffsetRange` la laisse sortir exactement de sa
///   marge vide, sinon les lettres s'arrêteraient à une demi-bande du bord (issue #396).
///   La boîte déborde, l'encre non — rien à changer ici.
/// * **plaque ajustée au texte.** Le fond couvrait la boîte entière, là où le `<span>` du
///   DOM, le renderer canvas et Direct2D (qui remplit `DWRITE_TEXT_METRICS`) l'ajustent
///   tous au bloc mis en page.
///
/// Le cadre garde toute la largeur utile (`box_w` moins la marge de plaque) : c'est sur
/// elle que CoreText applique l'alignement de paragraphe, exactement comme DirectWrite.
/// L'inset horizontal joue le rôle du `p-2` que l'overlay DOM posait sur le conteneur — il
/// réserve la place de la marge de plaque, pour qu'un texte aligné à gauche ou à droite ne
/// la voie pas rognée par le bord de la boîte.
fn block_layout(
    box_w: CGFloat,
    box_h: CGFloat,
    text_w: CGFloat,
    text_h: CGFloat,
    align: u8,
    valign: &str,
    // Une plaque de fond est-elle dessinée ? Elle décide de la marge à réserver du côté
    // ancré — voir `anchor_pad` plus bas. (Commentaire ordinaire et pas `///` : rustc
    // refuse un doc-comment sur un paramètre.)
    has_plate: bool,
    font_px: CGFloat,
) -> (CGRect, CGRect) {
    let (pad_x, pad_y) = plate_padding(font_px);
    let avail_w = layout_width(box_w, font_px);

    // Un cadre haut d'exactement `text_h` perd parfois sa dernière ligne sur un arrondi de
    // la mesure. On l'étend d'un pixel vers le BAS — donc en abaissant l'origine `y`, pas
    // en montant le sommet — pour que le haut du texte ne bouge pas d'un poil.
    const GUARD: CGFloat = 1.0;
    // ANCRAGE. `center` reste le comportement historique (et celui des annotations,
    // qui reproduisent `alignItems: center` de l'overlay web). Les sous-titres
    // épinglent une arête : un bloc centré voit ses DEUX arêtes bouger quand il
    // gagne une ligne, ce qui déplaçait le sous-titre. `top` est ici une distance
    // depuis le HAUT de la boîte, en coordonnées descendantes.
    // `anchor_pad` réserve la marge de la plaque DU CÔTÉ ANCRÉ. Sans elle, coller le
    // bloc de texte au bord laisse la plaque poser toute sa marge du côté opposé et
    // zéro du côté ancré : le fond épouse le bas des lettres au pixel près tout en
    // respirant deux fois trop au-dessus. Ce qui doit toucher le bord de la boîte est
    // la PLAQUE, pas les glyphes. Sans plaque, il n'y a rien à réserver.
    let anchor_pad = if has_plate { pad_y } else { 0.0 };
    let slack_y = (box_h - text_h).max(0.0);
    let top = match valign {
        "top" | "start" => anchor_pad,
        "bottom" | "end" => slack_y - anchor_pad,
        _ => slack_y * 0.5,
    }
    .clamp(0.0, slack_y);
    let frame_x = (box_w - avail_w) * 0.5;
    let frame = CGRect {
        origin: CGPoint {
            x: frame_x,
            y: box_h - top - text_h - GUARD,
        },
        size: CGSize {
            width: avail_w,
            height: text_h + GUARD,
        },
    };

    // La plaque épouse le bloc, marge comprise, sans jamais déborder de la boîte : au-delà
    // elle serait coupée net par le bord de la texture et perdrait ses coins arrondis.
    let plate_w = (text_w + pad_x * 2.0).min(box_w);
    let plate_h = (text_h + pad_y * 2.0).min(box_h);
    let slack_x = (box_w - plate_w).max(0.0);
    let plate_x = match align {
        // À gauche, les lignes commencent au bord gauche du cadre ; à droite, elles
        // finissent au bord droit. La plaque déborde de `pad_x` du côté concerné.
        0 => frame_x - pad_x,
        1 => frame_x + avail_w + pad_x - plate_w,
        _ => slack_x * 0.5,
    }
    .clamp(0.0, slack_x);
    let plate_y = (box_h - top - text_h - pad_y).clamp(0.0, (box_h - plate_h).max(0.0));

    (
        frame,
        CGRect {
            origin: CGPoint {
                x: plate_x,
                y: plate_y,
            },
            size: CGSize {
                width: plate_w,
                height: plate_h,
            },
        },
    )
}

/// Largeur offerte aux lignes — `crate::text_plate::layout_width`, en `CGFloat`.
fn layout_width(box_w: CGFloat, font_px: CGFloat) -> CGFloat {
    crate::text_plate::layout_width(box_w as f32, font_px as f32) as CGFloat
}

unsafe fn cf_string(s: &str) -> Option<CFOwned> {
    CFOwned::new(CFStringCreateWithBytes(
        std::ptr::null(),
        s.as_ptr(),
        s.len() as CFIndex,
        K_CF_STRING_ENCODING_UTF8,
        0,
    ))
}

/// Rastériseur de texte macOS. Pas d'état persistant : CoreText et CoreGraphics sont
/// prêts dès le link des frameworks (côté Windows, `TextRasterizer::new` alloue les
/// factories DirectWrite/Direct2D — d'où le `Result` conservé pour la symétrie).
pub struct TextRasterizer;

impl TextRasterizer {
    pub fn new() -> Result<TextRasterizer> {
        Ok(TextRasterizer)
    }

    /// Rastérise `spec` dans une `MTLTexture` BGRA8Unorm neuve (alpha prémultiplié).
    ///
    /// Rend la texture **possédée** — la version précédente renvoyait `texture.as_ptr()`
    /// alors que le `metal::Texture` local était droppé au `return`, soit un
    /// `id<MTLTexture>` déjà relâché.
    pub unsafe fn rasterize(&self, gpu: &Gpu, spec: &TextSpec) -> Result<metal::Texture> {
        let (w, h) = (spec.box_px[0].max(1) as usize, spec.box_px[1].max(1) as usize);
        if spec.content.is_empty() {
            bail!("text_macos::rasterize: texte vide");
        }

        let bytes_per_row = w * 4;
        let mut buffer: Vec<u8> = vec![0u8; bytes_per_row * h];

        let space = CGColorSpaceCreateDeviceRGB();
        if space.is_null() {
            bail!("CGColorSpaceCreateDeviceRGB a renvoyé NULL");
        }
        let ctx = CGBitmapContextCreate(
            buffer.as_mut_ptr() as *mut c_void,
            w,
            h,
            8,
            bytes_per_row,
            space,
            CG_BITMAP_INFO_BGRA_PREMUL,
        );
        if ctx.is_null() {
            CGColorSpaceRelease(space);
            bail!("CGBitmapContextCreate {w}x{h} a renvoyé NULL");
        }

        // PAS de flip du CTM, et c'est contre-intuitif. `CGBitmapContext` a bien son origine
        // en bas à gauche, MAIS il stocke la ligne 0 du buffer EN HAUT de l'image — et
        // `CTFrameDraw` remplit son cadre du haut vers le bas. Le sommet du cadre atterrit
        // donc déjà dans les premières lignes du buffer, c'est-à-dire en haut de la
        // `MTLTexture`. Le `ScaleCTM(1, -1)` que ce code faisait retournait une image déjà
        // correcte : le texte s'affichait en miroir vertical.

        let drawn = self.draw_text(ctx, space, spec, w as CGFloat, h as CGFloat);

        CGContextRelease(ctx);
        CGColorSpaceRelease(space);
        drawn?;

        let desc = metal::TextureDescriptor::new();
        desc.set_texture_type(metal::MTLTextureType::D2);
        desc.set_pixel_format(metal::MTLPixelFormat::BGRA8Unorm);
        desc.set_width(w as u64);
        desc.set_height(h as u64);
        desc.set_usage(metal::MTLTextureUsage::ShaderRead);
        desc.set_storage_mode(metal::MTLStorageMode::Shared);
        let texture = gpu.device.new_texture(&desc);

        texture.replace_region(
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize {
                    width: w as u64,
                    height: h as u64,
                    depth: 1,
                },
            },
            0,
            buffer.as_ptr() as *const c_void,
            bytes_per_row as u64,
        );

        Ok(texture)
    }

    /// Le corps CoreText, isolé pour que `rasterize` puisse relâcher contexte et
    /// colorspace sur TOUS les chemins de sortie, y compris les `?`.
    unsafe fn draw_text(
        &self,
        ctx: CFTypeRef,
        space: CFTypeRef,
        spec: &TextSpec,
        box_w: CGFloat,
        box_h: CGFloat,
    ) -> Result<()> {
        let content =
            cf_string(&spec.content).ok_or_else(|| anyhow!("CFStringCreateWithBytes NULL"))?;

        // --- police ---
        let family = cf_string(&spec.font_family);
        let base_font = CFOwned::new(CTFontCreateWithName(
            family.as_ref().map(|f| f.get()).unwrap_or(std::ptr::null()),
            spec.font_size_px.max(1.0) as CGFloat,
            std::ptr::null(),
        ))
        .ok_or_else(|| anyhow!("CTFontCreateWithName a renvoyé NULL"))?;
        // Gras/italique : une variante symbolique de la même famille. Si la famille n'a
        // pas la variante, CoreText renvoie NULL — on garde alors la police de base
        // plutôt que d'échouer sur un détail de style.
        let mut traits = 0u32;
        if spec.bold {
            traits |= K_CT_FONT_TRAIT_BOLD;
        }
        if spec.italic {
            traits |= K_CT_FONT_TRAIT_ITALIC;
        }
        let styled_font = if traits != 0 {
            CFOwned::new(CTFontCreateCopyWithSymbolicTraits(
                base_font.get(),
                0.0, // 0 = conserver la taille de la police source
                std::ptr::null(),
                traits,
                K_CT_FONT_TRAIT_BOLD | K_CT_FONT_TRAIT_ITALIC,
            ))
        } else {
            None
        };
        let font = styled_font.as_ref().unwrap_or(&base_font);

        // --- couleur ---
        let components: [CGFloat; 4] = [
            spec.color[0] as CGFloat,
            spec.color[1] as CGFloat,
            spec.color[2] as CGFloat,
            spec.color[3] as CGFloat,
        ];
        let color = CFOwned::new(CGColorCreate(space, components.as_ptr()))
            .ok_or_else(|| anyhow!("CGColorCreate a renvoyé NULL"))?;

        // --- alignement ---
        let alignment: u8 = ct_alignment(&spec.align);
        let settings = [CTParagraphStyleSetting {
            spec: K_CT_PARAGRAPH_STYLE_SPECIFIER_ALIGNMENT,
            value_size: std::mem::size_of::<u8>(),
            value: &alignment as *const u8 as *const c_void,
        }];
        let paragraph = CFOwned::new(CTParagraphStyleCreate(settings.as_ptr(), settings.len()));

        // --- soulignement ---
        let underline_value: i32 = 1;
        let underline = if spec.underline {
            CFOwned::new(CFNumberCreate(
                std::ptr::null(),
                K_CF_NUMBER_S_INT32_TYPE,
                &underline_value as *const i32 as *const c_void,
            ))
        } else {
            None
        };

        // --- dictionnaire d'attributs ---
        let mut keys: Vec<CFTypeRef> = vec![kCTFontAttributeName, kCTForegroundColorAttributeName];
        let mut values: Vec<CFTypeRef> = vec![font.get(), color.get()];
        if let Some(p) = paragraph.as_ref() {
            keys.push(kCTParagraphStyleAttributeName);
            values.push(p.get());
        }
        if let Some(u) = underline.as_ref() {
            keys.push(kCTUnderlineStyleAttributeName);
            values.push(u.get());
        }
        let attrs = CFOwned::new(CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            keys.len() as CFIndex,
            &kCFTypeDictionaryKeyCallBacks as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const c_void,
        ))
        .ok_or_else(|| anyhow!("CFDictionaryCreate (attributs) a renvoyé NULL"))?;

        let attributed = CFOwned::new(CFAttributedStringCreate(
            std::ptr::null(),
            content.get(),
            attrs.get(),
        ))
        .ok_or_else(|| anyhow!("CFAttributedStringCreate a renvoyé NULL"))?;

        let framesetter = CFOwned::new(CTFramesetterCreateWithAttributedString(attributed.get()))
            .ok_or_else(|| anyhow!("CTFramesetterCreateWithAttributedString NULL"))?;

        // `length: 0` = « jusqu'à la fin de la chaîne », la convention CoreText — pas
        // besoin de compter les caractères (et surtout pas en `chars()`, qui compte des
        // scalaires Unicode là où CFAttributedString compte des unités UTF-16).
        let whole = CFRange {
            location: 0,
            length: 0,
        };

        // --- mesure du bloc mis en page ---
        // Hauteur non contrainte (`CGFLOAT_MAX`) : on veut la place que le texte PREND, pas
        // celle qu'on lui offre. Un texte plus haut que la boîte est ensuite recadré sur
        // elle, ce qui le rend coupé en bas plutôt que centré et coupé des deux côtés.
        let font_px = spec.font_size_px.max(1.0) as CGFloat;
        let avail_w = layout_width(box_w, font_px);
        let mut fit = whole;
        let measured = CTFramesetterSuggestFrameSizeWithConstraints(
            framesetter.get(),
            whole,
            std::ptr::null(),
            CGSize {
                width: avail_w,
                height: CGFloat::MAX,
            },
            &mut fit as *mut CFRange,
        );
        // Arrondi au pixel supérieur : la mesure revient parfois une fraction sous la
        // réalité, et il en faut peu pour rogner la dernière ligne.
        let text_w = measured.width.ceil().clamp(0.0, avail_w);
        let text_h = measured.height.ceil().max(0.0);

        let (frame_rect, plate_rect) =
            block_layout(
                box_w,
                box_h,
                text_w,
                text_h,
                alignment,
                &spec.valign,
                spec.background[3] > 0.0,
                font_px,
            );

        // --- plaque de fond, sous le texte ---
        if spec.background[3] > 0.0 && plate_rect.size.width > 0.0 && plate_rect.size.height > 0.0
        {
            let radius = crate::text_plate::radius(
                font_px as f32,
                plate_rect.size.width as f32,
                plate_rect.size.height as f32,
            ) as CGFloat;
            let plate = CFOwned::new(CGPathCreateWithRoundedRect(
                plate_rect,
                radius,
                radius,
                std::ptr::null(),
            ))
            .ok_or_else(|| anyhow!("CGPathCreateWithRoundedRect NULL"))?;
            CGContextSetRGBFillColor(
                ctx,
                spec.background[0] as CGFloat,
                spec.background[1] as CGFloat,
                spec.background[2] as CGFloat,
                spec.background[3] as CGFloat,
            );
            CGContextAddPath(ctx, plate.get());
            CGContextFillPath(ctx);
        }

        let path = CFOwned::new(CGPathCreateWithRect(frame_rect, std::ptr::null()))
            .ok_or_else(|| anyhow!("CGPathCreateWithRect NULL"))?;
        let frame = CFOwned::new(CTFramesetterCreateFrame(
            framesetter.get(),
            whole,
            path.get(),
            std::ptr::null(),
        ))
        .ok_or_else(|| anyhow!("CTFramesetterCreateFrame NULL"))?;

        CTFrameDraw(frame.get(), ctx);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(content: &str) -> TextSpec {
        TextSpec {
            content: content.into(),
            color: [1.0, 1.0, 1.0, 1.0],
            background: [0.0, 0.0, 0.0, 0.0],
            font_size_px: 48.0,
            font_family: "Helvetica".into(),
            bold: false,
            italic: false,
            underline: false,
            align: "center".into(),
            valign: "center".into(),
            box_px: [256, 256],
        }
    }

    /// Rastérise et rend les octets BGRA, ou `None` si la machine n'a pas de device Metal.
    fn raster_bgra(spec: &TextSpec) -> Option<(Vec<u8>, usize, usize)> {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return None;
        };
        let raster = TextRasterizer::new().expect("TextRasterizer::new");
        let tex = unsafe { raster.rasterize(&gpu, spec) }.expect("rasterize");
        let (w, h) = (spec.box_px[0] as usize, spec.box_px[1] as usize);
        let mut px = vec![0u8; w * h * 4];
        tex.get_bytes(
            px.as_mut_ptr() as *mut c_void,
            (w * 4) as u64,
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize {
                    width: w as u64,
                    height: h as u64,
                    depth: 1,
                },
            },
            0,
        );
        Some((px, w, h))
    }

    /// Boîte englobante de l'encre (alpha > 8) : `(x0, y0, x1, y1)`, bornes incluses.
    fn ink_bounds(px: &[u8], w: usize, h: usize) -> (usize, usize, usize, usize) {
        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
        for y in 0..h {
            for x in 0..w {
                if px[(y * w + x) * 4 + 3] > 8 {
                    x0 = x0.min(x);
                    y0 = y0.min(y);
                    x1 = x1.max(x);
                    y1 = y1.max(y);
                }
            }
        }
        assert!(x0 <= x1 && y0 <= y1, "aucune encre : rien n'a été rastérisé");
        (x0, y0, x1, y1)
    }

    /// Le texte n'est pas retourné. Le test regarde où est l'encre plutôt que de faire
    /// confiance au sens du CTM : c'est la seule façon de distinguer « bien orienté » de
    /// « retourné », et le retournement était un vrai bug de ce fichier.
    ///
    /// Il compare les deux moitiés de la boîte ENGLOBANTE, pas de la boîte de sortie :
    /// depuis le centrage vertical, un texte bien orienté n'est plus majoritairement dans
    /// la moitié haute de la texture. `H` sur la première ligne et `.` sur la seconde rend
    /// le bloc très dissymétrique, donc le miroir se voit immédiatement.
    #[test]
    fn text_is_not_mirrored_vertically() {
        let Some((px, w, h)) = raster_bgra(&spec("HHHH\n.")) else {
            return;
        };
        let (_, y0, _, y1) = ink_bounds(&px, w, h);
        let ink = |rows: std::ops::Range<usize>| -> u64 {
            rows.map(|y| (0..w).map(|x| px[(y * w + x) * 4 + 3] as u64).sum::<u64>())
                .sum()
        };
        let mid = (y0 + y1) / 2;
        let (upper, lower) = (ink(y0..mid), ink(mid..y1 + 1));
        assert!(
            upper > lower * 3,
            "texte retourné : encre haut={upper}, bas={lower} (les `HHHH` sont sur la 1re ligne)"
        );
    }

    /// Le bug rapporté : une ligne de sous-titre se collait en haut de sa bande et laissait
    /// ~180 px de vide en dessous. La bande fait 22 % de la hauteur de l'image, donc la
    /// boîte est toujours bien plus haute que le texte — le bloc doit y être centré.
    ///
    /// La mesure porte sur la PLAQUE, pas sur les glyphes : l'encre ne remplit jamais sa
    /// hauteur de ligne (au-dessus des capitales et sous les jambages il reste du vide,
    /// en quantités inégales), donc ses marges ne sont pas symétriques même parfaitement
    /// centrées. La plaque, elle, est le bloc mis en page.
    #[test]
    fn a_single_line_is_centred_in_a_tall_box() {
        let mut s = spec("Bonjour tout le monde");
        s.background = [0.0, 0.0, 0.0, 1.0];
        // Une vraie bande de sous-titres en 1080p : 80 % de large, 22 % de haut.
        s.box_px = [1536, 238];
        let Some((px, w, h)) = raster_bgra(&s) else {
            return;
        };
        let (x0, y0, x1, y1) = ink_bounds(&px, w, h);
        let (top, bottom) = (y0 as i64, (h - 1 - y1) as i64);
        let (left, right) = (x0 as i64, (w - 1 - x1) as i64);
        assert!(
            (top - bottom).abs() <= 1,
            "bloc non centré verticalement : {top} px au-dessus, {bottom} px en dessous"
        );
        assert!(
            (left - right).abs() <= 1,
            "bloc non centré horizontalement : {left} px à gauche, {right} px à droite"
        );
        // Et le vide restant est réparti, pas empilé en bas comme avant le correctif.
        assert!(top > 20, "la boîte fait {h} px de haut : le bloc devrait flotter dedans");
    }

    /// La plaque de fond épouse le bloc de texte au lieu de remplir la boîte. Sans ça, une
    /// bande de sous-titres est un pavé opaque de 22 % de la hauteur de l'image.
    #[test]
    fn the_background_plate_hugs_the_text_not_the_box() {
        let mut s = spec("Bonjour");
        s.background = [0.0, 0.0, 0.0, 1.0];
        s.box_px = [1536, 238];
        let Some((px, w, h)) = raster_bgra(&s) else {
            return;
        };
        let (x0, y0, x1, y1) = ink_bounds(&px, w, h);
        let (plate_w, plate_h) = (x1 - x0 + 1, y1 - y0 + 1);
        assert!(
            plate_h < h / 2,
            "la plaque couvre {plate_h} px sur {h} : elle remplit encore la boîte"
        );
        assert!(
            plate_w < w / 2,
            "la plaque couvre {plate_w} px sur {w} : elle remplit encore la boîte"
        );
        // Le fond est opaque : les coins de la boîte doivent rester vides.
        for (cx, cy) in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)] {
            assert_eq!(
                px[(cy * w + cx) * 4 + 3],
                0,
                "coin ({cx}, {cy}) peint : la plaque déborde du bloc"
            );
        }
    }

    /// La plaque laisse respirer le texte : `0.1em` en haut/bas, `0.2em` à gauche/droite,
    /// le modèle de boîte partagé avec l'overlay DOM et le renderer canvas.
    #[test]
    fn the_plate_keeps_a_margin_around_the_glyphs() {
        let mut s = spec("Bonjour");
        s.box_px = [1536, 238];
        let Some((glyphs, w, h)) = raster_bgra(&s) else {
            return;
        };
        let (gx0, _, gx1, _) = ink_bounds(&glyphs, w, h);

        s.background = [0.0, 0.0, 0.0, 1.0];
        let Some((plate, _, _)) = raster_bgra(&s) else {
            return;
        };
        let (px0, _, px1, _) = ink_bounds(&plate, w, h);

        assert!(
            px0 < gx0 && px1 > gx1,
            "la plaque ({px0}..{px1}) ne dépasse pas les glyphes ({gx0}..{gx1})"
        );
    }

    /// Un texte plus haut que sa boîte se coupe en BAS. Le centrer puis le rogner des deux
    /// côtés mangerait la première ligne, qui est celle qu'on veut lire.
    #[test]
    fn an_overflowing_text_starts_at_the_top() {
        let mut s = spec("Un texte tres long qui deborde largement de la boite prevue pour lui");
        s.box_px = [240, 90];
        let Some((px, w, h)) = raster_bgra(&s) else {
            return;
        };
        let (_, y0, _, _) = ink_bounds(&px, w, h);
        assert!(
            y0 < h / 4,
            "le débordement ne part pas du haut : première ligne d'encre à y={y0} sur {h}"
        );
    }

    /// Géométrie pure — pas de GPU, pas de CoreText.
    #[test]
    fn block_layout_centres_the_frame_and_sizes_the_plate() {
        let (frame, plate) = block_layout(1536.0, 238.0, 500.0, 56.0, 2, "center", true, 48.0);
        // Cadre centré : autant de vide au-dessus qu'en dessous (repère CG, y vers le haut).
        let above = 238.0 - (frame.origin.y + frame.size.height);
        let below = frame.origin.y;
        assert!((above - below).abs() <= 1.5, "cadre décentré : {above} / {below}");
        // Plaque = bloc + 0.2em/0.1em, centrée elle aussi.
        assert!((plate.size.width - (500.0 + 2.0 * 9.6)).abs() < 0.01);
        assert!((plate.size.height - (56.0 + 2.0 * 4.8)).abs() < 0.01);
        assert!((plate.origin.x - (1536.0 - plate.size.width) * 0.5).abs() < 0.01);
    }

    #[test]
    fn block_layout_never_lets_the_plate_leave_the_box() {
        for align in [0u8, 1, 2] {
            // Bloc plus large et plus haut que la boîte : la plaque doit se contenter d'elle.
            let (_, plate) = block_layout(200.0, 60.0, 400.0, 200.0, align, "center", true, 48.0);
            assert!(plate.origin.x >= 0.0, "align={align} : x={}", plate.origin.x);
            assert!(plate.origin.y >= 0.0, "align={align} : y={}", plate.origin.y);
            assert!(plate.origin.x + plate.size.width <= 200.0 + 0.01, "align={align}");
            assert!(plate.origin.y + plate.size.height <= 60.0 + 0.01, "align={align}");
        }
    }

    /// L'invariant de la refonte du placement des sous-titres, en géométrie pure.
    /// Un bloc centré voit ses DEUX arêtes bouger quand il grandit ; ancré, l'arête
    /// ancrée ne bouge pas. Repère CoreGraphics : `y` monte.
    #[test]
    fn block_layout_pins_the_anchored_edge_whatever_the_block_height() {
        let (box_w, box_h) = (1536.0, 238.0);
        let edges = |valign: &str, text_h: f64| {
            let (frame, _) = block_layout(box_w, box_h, 500.0, text_h, 2, valign, true, 48.0);
            // (bas, haut) en distance depuis le bas de la boîte.
            (frame.origin.y, frame.origin.y + frame.size.height)
        };

        // Ancrage bas : l'arête basse est la même à une et à trois lignes.
        let (one_bottom, _) = edges("bottom", 56.0);
        let (three_bottom, _) = edges("bottom", 168.0);
        assert!(
            (one_bottom - three_bottom).abs() < 0.01,
            "ancrage bas : l'arête basse a bougé de {one_bottom} à {three_bottom}"
        );

        // Ancrage haut : l'arête haute est la même.
        let (_, one_top) = edges("top", 56.0);
        let (_, three_top) = edges("top", 168.0);
        assert!(
            (one_top - three_top).abs() < 0.01,
            "ancrage haut : l'arête haute a bougé de {one_top} à {three_top}"
        );

        // Et le centrage, lui, fait bien bouger les deux — c'est le comportement
        // historique qu'on préserve pour les annotations.
        let (c1_bottom, c1_top) = edges("center", 56.0);
        let (c3_bottom, c3_top) = edges("center", 168.0);
        assert!(
            (c1_bottom - c3_bottom).abs() > 1.0 && (c1_top - c3_top).abs() > 1.0,
            "le centrage devrait déplacer les deux arêtes"
        );
    }
}
