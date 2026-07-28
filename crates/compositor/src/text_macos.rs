//! Rastérisation du texte des annotations sur macOS — CoreText + CoreGraphics.
//!
//! Équivalent macOS de `text_windows.rs` (DirectWrite + Direct2D sur surface DXGI).
//! Le module exporte la même surface publique (`TextSpec`, `TextRasterizer`) pour que
//! `compositor.rs` puisse appeler `TextRasterizer::new()` / `rasterize(...)` sans
//! connaître la plateforme.
//!
//! # État de ce commit
//!
//! Première implémentation du rastériseur. Le câblage ObjC/CoreText est posé ; il est
//! honnête mais pas testé en runtime — la première fois qu'il tourne sur Mac, ce sera
//! au prochain push (CI macos-14). Les bindings ObjC couvrent le strict minimum
//! nécessaire : `NSString`, `NSMutableAttributedString`, `NSMutableParagraphStyle`,
//! `CGColor`, `CTFont`, `CTFramesetter`, `CTFrame`, et `CGBitmapContextCreate`.
//!
//! L'API suit la policy de la version Windows : `TextSpec::cache_key()` byte-identique,
//! `TextRasterizer::new()` renvoie `Ok` immédiatement (pas de factories CoreText
//! à allouer — CoreText/CoreGraphics sont prêts dès le link des frameworks).

use crate::metal::Gpu;
use anyhow::{anyhow, bail, Result};
use objc2::msg_send;
use objc2::runtime::AnyClass;
use std::ffi::{c_void, CString};
use std::ptr;

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
        use std::hash::{Hash, Hasher};
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        self.content.hash(&mut h);
        self.color.iter().for_each(|f| f.to_bits().hash(&mut h));
        self.background.iter().for_each(|f| f.to_bits().hash(&mut h));
        self.font_size_px.to_bits().hash(&mut h);
        self.font_family.hash(&mut h);
        self.bold.hash(&mut h);
        self.italic.hash(&mut h);
        self.underline.hash(&mut h);
        self.align.hash(&mut h);
        self.box_px.iter().for_each(|u| u.hash(&mut h));
        h
    }
}

/// Frameworks liés.
#[link(name = "CoreText", kind = "framework")]
#[link(name = "CoreGraphics", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
#[link(name = "Foundation", kind = "framework")]
extern "C" {}

/// Bindings CoreText + CG minimaux.
extern "C" {
    fn CFRelease(cf: *const c_void);
    fn CTFontCreateWithName(
        name: *const c_void,
        size: f64,
        matrix: *const c_void,
    ) -> *const c_void;
    fn CTFramesetterCreateWithAttributedString(attr: *const c_void) -> *const c_void;
    fn CTFramesetterCreateFrame(
        framesetter: *const c_void,
        location: usize,
        length: isize,
        path: *const c_void,
        extra: *const c_void,
    ) -> *const c_void;
    fn CTFrameDraw(frame: *const c_void, context: *const c_void);
    fn CGDataProviderCreateWithData(
        info: *const c_void,
        data: *const c_void,
        size: usize,
        release_data: *const c_void,
        release_info: *const c_void,
    ) -> *const c_void;
    // CGBitmapContextCreate : 8 args, bind via extern "C".
    fn CGBitmapContextCreate(
        data: *mut c_void,
        width: usize,
        height: usize,
        bits_per_component: usize,
        bytes_per_row: usize,
        color_space: *const c_void,
        bitmap_info: u32,
    ) -> *const c_void;
}

/// Rastériseur de texte macOS. Pas d'état persistant pour l'instant — CoreText
/// et CoreGraphics sont prêts dès le link des frameworks.
pub struct TextRasterizer;

impl TextRasterizer {
    pub fn new() -> Result<TextRasterizer> {
        Ok(TextRasterizer)
    }

    /// Rastérise `spec` dans une texture Metal neuve (BGRA8Unorm, alpha-prémultiplié).
    /// Le caller (`Compositor`) retient la texture et la stocke dans son cache
    /// text_cache (clé = spec.cache_key()).
    ///
    /// Pipeline :
    ///   1. Alloue une `MTLTexture` BGRA8Unorm, `StorageMode::Shared`.
    ///   2. Crée un `CGContext` bitmap backed par un buffer CPU (la métal-rs 0.29 ne
    ///      permet pas d'obtenir le pointeur GPU d'une Shared texture sans IOSurface —
    ///      le buffer CPU est uploadé via `replace_region` à l'étape finale).
    ///   3. Construit un `NSAttributedString` (content + couleur + font + underline +
    ///      alignement).
    ///   4. Crée un `CTFramesetter` + `CTFrame`, et `CTFrameDraw` dans le context.
    ///   5. Upload du buffer CPU → MTLTexture.
    pub unsafe fn rasterize(
        &self,
        gpu: &Gpu,
        spec: &TextSpec,
    ) -> Result<*mut c_void> {
        let (w, h) = (spec.box_px[0].max(1) as usize, spec.box_px[1].max(1) as usize);
        if spec.content.is_empty() {
            bail!("text_macos::rasterize: texte vide");
        }

        // 1. MTLTexture BGRA8Unorm, Shared.
        let desc = metal::TextureDescriptor::new();
        desc.set_texture_type(metal::TextureType::Type2D);
        desc.set_pixel_format(metal::MTLPixelFormat::BGRA8Unorm);
        desc.set_width(w as u64);
        desc.set_height(h as u64);
        desc.set_usage(metal::MTLTextureUsage::ShaderRead);
        desc.set_storage_mode(metal::MTLStorageMode::Shared);
        let texture = gpu.device.new_texture(&desc);

        // 2. Buffer CPU + CGContext bitmap.
        let bytes_per_row = w * 4;
        let mut buffer: Vec<u8> = vec![0u8; bytes_per_row * h];
        // kCGImageAlphaPremultipliedFirst (1) | kCGBitmapByteOrder32Little (4<<12 = 8192) | kCGImageAlphaNone (0).
        // 1 = premultiplied ; 8192 = 32-bit little-endian byte order ; le | 0x8000 final force BGRA layout (par défaut).
        let bitmap_info: u32 = 0x100 | 0x8000 | (4 << 12);
        let cg_ctx = CGBitmapContextCreate(
            buffer.as_mut_ptr() as *mut c_void,
            w,
            h,
            8, // bits per component
            bytes_per_row,
            ptr::null(), // default device-RGB color space
            bitmap_info,
        );
        if cg_ctx.is_null() {
            bail!("CGBitmapContextCreate a renvoyé NULL");
        }
        // 3. NSAttributedString.
        let attr_str = build_attributed_string(spec)?;
        let attr_len: isize = spec.content.chars().count() as isize;

        // 4. CTFramesetter + CTFrame + draw.
        let framesetter = CTFramesetterCreateWithAttributedString(attr_str);
        CFRelease(attr_str);
        if framesetter.is_null() {
            bail!("CTFramesetterCreateWithAttributedString NULL");
        }
        let frame = CTFramesetterCreateFrame(
            framesetter,
            0, // location
            attr_len,
            ptr::null(), // path = NULL = full context bounds
            ptr::null(),
        );
        CFRelease(framesetter);
        if frame.is_null() {
            bail!("CTFramesetterCreateFrame NULL");
        }
        CTFrameDraw(frame, cg_ctx);
        CFRelease(frame);
        CFRelease(cg_ctx);

        // 5. Upload CPU → texture via replace_region.
        let region = metal::MTLRegionMake2D(0, 0, w as u64, h as u64);
        texture.replace_region(
            region,
            0,    // mipmap level
            0,    // slice
            bytes_per_row as u64,
            buffer.as_ptr() as *const c_void,
        );

        Ok(texture.as_ptr())
    }
}

/// Construit un NSAttributedString ObjC avec les attributs CoreText demandés.
unsafe fn build_attributed_string(spec: &TextSpec) -> Result<*const c_void> {
    // NSString depuis spec.content.
    let ns_string_cls = AnyClass::get(c"NSString").ok_or_else(|| anyhow!("NSString introuvable"))?;
    let utf8 = CString::new(spec.content.as_str())?;
    let ns_string: *mut objc2::runtime::AnyObject =
        msg_send![ns_string_cls, stringWithUTF8String: utf8.as_ptr()];
    if ns_string.is_null() {
        bail!("NSString stringWithUTF8String NULL");
    }
    // NSMutableAttributedString.
    let attr_str_cls =
        AnyClass::get(c"NSMutableAttributedString").ok_or_else(|| anyhow!("NSMutableAttributedString introuvable"))?;
    let attr_str: *mut objc2::runtime::AnyObject =
        msg_send![attr_str_cls, attributedStringWithString: ns_string];
    if attr_str.is_null() {
        bail!("NSMutableAttributedString attributedStringWithString NULL");
    }
    let len: usize = spec.content.chars().count();

    // Set d'attributs via addAttribute:value:range:.
    let range: NSRange = NSRange { location: 0, length: len };

    // Foreground color.
    if let Some(cg_color) = cg_color_create_rgba(spec.color[0], spec.color[1], spec.color[2], spec.color[3]) {
        let _: () = msg_send![attr_str,
            addAttribute: sel_foregroundColor(),
            value: cg_color,
            range: range,
        ];
    }

    // Font.
    if let Some(ctfont) = ct_font_create_with_name(
        &spec.font_family,
        spec.font_size_px.max(1.0) as f64,
    ) {
        let _: () = msg_send![attr_str,
            addAttribute: sel_font(),
            value: ctfont,
            range: range,
        ];
    }

    // Underline.
    if spec.underline {
        let _: () = msg_send![attr_str,
            addAttribute: sel_underlineStyle(),
            value: 1usize,
            range: range,
        ];
    }

    // Alignement.
    let paragraph_cls = AnyClass::get(c"NSMutableParagraphStyle")
        .ok_or_else(|| anyhow!("NSMutableParagraphStyle introuvable"))?;
    let paragraph: *mut objc2::runtime::AnyObject = msg_send![paragraph_cls, new];
    if !paragraph.is_null() {
        let align: isize = match spec.align.as_str() {
            "left" => 0,
            "right" => 1,
            _ => 2,
        };
        let _: () = msg_send![paragraph, setAlignment: align];
        let _: () = msg_send![attr_str,
            addAttribute: sel_paragraphStyle(),
            value: paragraph,
            range: range,
        ];
    }

    Ok(attr_str as *const c_void)
}

#[repr(C)]
#[derive(Clone, Copy)]
struct NSRange {
    location: usize,
    length: usize,
}

/// Sélecteurs Objective-C (constants, enregistrées une seule fois).
unsafe fn sel_foregroundColor() -> *const c_void {
    objc2::runtime::Sel::register(c"NSColor").as_ptr() as *const c_void
}
unsafe fn sel_font() -> *const c_void {
    objc2::runtime::Sel::register(c"NSFont").as_ptr() as *const c_void
}
unsafe fn sel_underlineStyle() -> *const c_void {
    objc2::runtime::Sel::register(c"NSUnderlineStyle").as_ptr() as *const c_void
}
unsafe fn sel_paragraphStyle() -> *const c_void {
    objc2::runtime::Sel::register(c"NSParagraphStyle").as_ptr() as *const c_void
}

/// Crée un CGColorRef (retainable) à partir de (r,g,b,a) en [0,1].
unsafe fn cg_color_create_rgba(r: f64, g: f64, b: f64, a: f64) -> Option<*mut objc2::runtime::AnyObject> {
    let color_cls = AnyClass::get(c"CGColor")?;
    let space_cls = AnyClass::get(c"CGColorSpace")?;
    let device_rgb: *mut objc2::runtime::AnyObject = msg_send![space_cls, deviceRGBColorSpace];
    if device_rgb.is_null() {
        return None;
    }
    let color: *mut objc2::runtime::AnyObject = msg_send![color_cls,
        colorWithRed: r,
        green: g,
        blue: b,
        alpha: a,
    ];
    if color.is_null() {
        None
    } else {
        Some(color)
    }
}

/// Crée un CTFontRef (retainable) depuis un nom de famille et une taille.
unsafe fn ct_font_create_with_name(
    family: &str,
    size: f64,
) -> Option<*mut objc2::runtime::AnyObject> {
    let cf_string_cls = AnyClass::get(c"CFString")?;
    let family_bytes = CString::new(family).ok()?;
    // CFStringCreateWithCString(kCFAllocatorDefault, cstr, kCFStringEncodingUTF8).
    let alloc_default_cls = AnyClass::get(c"kCFAllocatorDefault");
    let alloc: *mut objc2::runtime::AnyObject = if let Some(c) = alloc_default_cls {
        msg_send![c, self]
    } else {
        ptr::null_mut()
    };
    let family_cf: *mut objc2::runtime::AnyObject = msg_send![cf_string_cls,
        stringWithCString: family_bytes.as_ptr()
        encoding: 0x08000100u32 /* kCFStringEncodingUTF8 */
    ];
    if family_cf.is_null() {
        return None;
    }
    let font: *mut objc2::runtime::AnyObject = CTFontCreateWithName(
        family_cf as *const c_void,
        size,
        ptr::null(),
    ) as *mut objc2::runtime::AnyObject;
    if font.is_null() {
        None
    } else {
        Some(font)
    }
}