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
//! 2. fond optionnel (`spec.background`, alpha 0 = transparent).
//! 3. `CFAttributedString` avec police (`kCTFontAttributeName`), couleur
//!    (`kCTForegroundColorAttributeName`), soulignement (`kCTUnderlineStyleAttributeName`)
//!    et alignement (`kCTParagraphStyleAttributeName`).
//! 4. `CTFramesetterCreateFrame` sur un `CGPath` rectangulaire couvrant la boîte, puis
//!    `CTFrameDraw`.
//! 5. `MTLTexture` BGRA8Unorm + `replace_region` depuis le buffer CPU.
//!
//! CoreGraphics a son origine en BAS à gauche : le contexte est retourné
//! (`CGContextTranslateCTM` + `CGContextScaleCTM`) pour que la boîte `box_px` se lise
//! comme côté Windows, origine en haut à gauche.
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
    fn CGContextTranslateCTM(ctx: CFTypeRef, tx: CGFloat, ty: CGFloat);
    fn CGContextScaleCTM(ctx: CFTypeRef, sx: CGFloat, sy: CGFloat);
    fn CGContextSetRGBFillColor(ctx: CFTypeRef, r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat);
    fn CGContextFillRect(ctx: CFTypeRef, rect: CGRect);
    fn CGPathCreateWithRect(rect: CGRect, transform: *const c_void) -> CFTypeRef;
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

        let box_rect = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: CGSize {
                width: w as CGFloat,
                height: h as CGFloat,
            },
        };

        // Fond avant le flip : un rect plein est invariant par retournement.
        if spec.background[3] > 0.0 {
            CGContextSetRGBFillColor(
                ctx,
                spec.background[0] as CGFloat,
                spec.background[1] as CGFloat,
                spec.background[2] as CGFloat,
                spec.background[3] as CGFloat,
            );
            CGContextFillRect(ctx, box_rect);
        }

        // CoreGraphics a son origine en bas à gauche ; on retourne pour que la boîte se
        // lise en coordonnées « écran », comme côté DirectWrite.
        CGContextTranslateCTM(ctx, 0.0, h as CGFloat);
        CGContextScaleCTM(ctx, 1.0, -1.0);

        let drawn = self.draw_text(ctx, space, spec, box_rect);

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
        box_rect: CGRect,
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
        // `CTTextAlignment` : 0 = left, 1 = right, 2 = center, 3 = justified, 4 = natural.
        let alignment: u8 = match spec.align.as_str() {
            "left" => 0,
            "right" => 1,
            _ => 2,
        };
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
        let path = CFOwned::new(CGPathCreateWithRect(box_rect, std::ptr::null()))
            .ok_or_else(|| anyhow!("CGPathCreateWithRect NULL"))?;
        // `length: 0` = « jusqu'à la fin de la chaîne », la convention CoreText — pas
        // besoin de compter les caractères (et surtout pas en `chars()`, qui compte des
        // scalaires Unicode là où CFAttributedString compte des unités UTF-16).
        let frame = CFOwned::new(CTFramesetterCreateFrame(
            framesetter.get(),
            CFRange {
                location: 0,
                length: 0,
            },
            path.get(),
            std::ptr::null(),
        ))
        .ok_or_else(|| anyhow!("CTFramesetterCreateFrame NULL"))?;

        CTFrameDraw(frame.get(), ctx);
        Ok(())
    }
}
