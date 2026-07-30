//! Rastérisation du texte des annotations, via DirectWrite (mise en page) et Direct2D (dessin)
//! sur une surface DXGI partagée avec D3D11.
//!
//! Pourquoi DirectWrite et pas un rasterizer de glyphes maison : l'app expédie en 13 langues,
//! dont l'arabe, et le texte d'une annotation est saisi librement. Le façonnage (ligatures,
//! bidirectionnel, CJK, sélection de police de repli) est un travail que DirectWrite fait
//! correctement et qu'on ne réécrira pas. Le device D3D11 est déjà créé avec
//! `D3D11_CREATE_DEVICE_BGRA_SUPPORT` (cf. `d3d.rs`, dont le commentaire anticipait cet usage),
//! donc l'interop ne coûte aucun changement de pipeline.
//!
//! Pourquoi ça ne coûte rien par frame : le texte d'une annotation est un contenu STATIQUE. On le
//! rastérise une fois dans une texture, et la boucle de rendu ne fait plus qu'un quad texturé de
//! plus. Le travail cher — façonnage, mise en page, rendu des glyphes — sort du chemin chaud, et
//! le cache est invalidé sur le contenu, le style et la taille de boîte, JAMAIS sur la
//! transformation : déplacer, redimensionner ou animer une annotation n'est pas une raison de
//! re-rastériser (c'est l'affaire du vertex shader).

use anyhow::{bail, Result};
use windows::core::Interface;
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COLOR_F, D2D1_PIXEL_FORMAT, D2D_POINT_2F, D2D_RECT_F,
};
use windows::Win32::Graphics::Direct2D::{
    D2D1CreateFactory, ID2D1Factory, D2D1_DRAW_TEXT_OPTIONS_NONE, D2D1_FACTORY_TYPE_SINGLE_THREADED,
    D2D1_FEATURE_LEVEL_DEFAULT, D2D1_RENDER_TARGET_PROPERTIES, D2D1_RENDER_TARGET_TYPE_DEFAULT,
    D2D1_RENDER_TARGET_USAGE_NONE, D2D1_ROUNDED_RECT,
};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11ShaderResourceView, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, DWRITE_FACTORY_TYPE_SHARED,
    DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_ITALIC, DWRITE_FONT_STYLE_NORMAL,
    DWRITE_FONT_WEIGHT_BOLD, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_PARAGRAPH_ALIGNMENT_CENTER,
    DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_TEXT_ALIGNMENT_TRAILING,
    DWRITE_TEXT_METRICS, DWRITE_TEXT_RANGE,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::IDXGISurface;

/// Tout ce dont le rendu d'un texte dépend. Sert aussi de clé de cache : deux specs égales
/// donnent la même texture, donc `cache_key` couvre exactement ces champs.
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
    /// FNV-1a sur les champs. Utilisé pour décider s'il faut re-rastériser ; volontairement
    /// insensible à tout ce qui n'affecte pas les pixels (position, opacité d'animation…).
    pub fn cache_key(&self) -> u64 {
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

/// Chaîne UTF-16 terminée par un zéro, pour les API Win32 qui prennent un `PCWSTR`.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub struct TextRasterizer {
    d2d: ID2D1Factory,
    dwrite: IDWriteFactory,
}

impl TextRasterizer {
    pub fn new() -> Result<TextRasterizer> {
        unsafe {
            // SINGLE_THREADED : tout le rendu du compositeur vit sur un seul thread, et le mode
            // multithread ajoute un verrou par appel pour rien.
            let d2d: ID2D1Factory =
                D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
            let dwrite: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
            Ok(TextRasterizer { d2d, dwrite })
        }
    }

    /// Rastérise `spec` dans une texture neuve et rend sa SRV. Le fond éventuel est dessiné
    /// derrière le texte, ajusté aux métriques de la mise en page — comme le CSS, où
    /// `backgroundColor` est porté par le `<span>` et épouse donc le texte, pas la boîte —
    /// avec la marge et les coins arrondis de `crate::text_plate`, partagés avec CoreText.
    pub unsafe fn rasterize(
        &self,
        dev: &ID3D11Device,
        spec: &TextSpec,
    ) -> Result<ID3D11ShaderResourceView> {
        let (w, h) = (spec.box_px[0].max(1), spec.box_px[1].max(1));
        if spec.content.is_empty() {
            bail!("texte vide");
        }

        // B8G8R8A8 : le format qu'exige une cible de rendu D2D. DXGI expose déjà les composantes
        // dans l'ordre RGBA au shader, donc rien à ré-échanger côté HLSL.
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        dev.CreateTexture2D(&desc, None, Some(&mut tex))?;
        let tex = tex.unwrap();

        let surface: IDXGISurface = tex.cast()?;
        let props = D2D1_RENDER_TARGET_PROPERTIES {
            r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                // PREMULTIPLIED : ce que D2D produit sur une surface DXGI. Le shader ne doit donc
                // PAS re-multiplier par l'alpha (cf. mode 11 dans shaders.hlsl).
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            // 96 dpi = 1 unité D2D pour 1 pixel : la mise en page se fait donc directement en
            // pixels de sortie, ce qui rend `font_size_px` littéral.
            dpiX: 96.0,
            dpiY: 96.0,
            usage: D2D1_RENDER_TARGET_USAGE_NONE,
            minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
        };
        let rt = self.d2d.CreateDxgiSurfaceRenderTarget(&surface, &props)?;

        let family = wide(&spec.font_family);
        let locale = wide("");
        let format = self.dwrite.CreateTextFormat(
            windows::core::PCWSTR(family.as_ptr()),
            None,
            if spec.bold { DWRITE_FONT_WEIGHT_BOLD } else { DWRITE_FONT_WEIGHT_NORMAL },
            if spec.italic { DWRITE_FONT_STYLE_ITALIC } else { DWRITE_FONT_STYLE_NORMAL },
            DWRITE_FONT_STRETCH_NORMAL,
            spec.font_size_px.max(1.0),
            windows::core::PCWSTR(locale.as_ptr()),
        )?;
        format.SetTextAlignment(match spec.align.as_str() {
            "left" => DWRITE_TEXT_ALIGNMENT_LEADING,
            "right" => DWRITE_TEXT_ALIGNMENT_TRAILING,
            _ => DWRITE_TEXT_ALIGNMENT_CENTER,
        })?;
        // Centrage vertical : l'overlay web met `alignItems: center` sur le conteneur.
        format.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)?;

        let text: Vec<u16> = spec.content.encode_utf16().collect();
        // La boîte de mise en page est rentrée de la marge de plaque (cf. `text_plate`), et
        // le texte se dessine à `pad_x` : sans cet inset, un texte aligné à gauche ou à
        // droite colle au bord de la boîte et sa plaque se fait rogner du côté où elle
        // devrait respirer.
        let font_px = spec.font_size_px.max(1.0);
        let (pad_x, pad_y) = crate::text_plate::padding(font_px);
        let layout_w = crate::text_plate::layout_width(w as f32, font_px);
        let layout = self
            .dwrite
            .CreateTextLayout(&text, &format, layout_w, h as f32)?;
        if spec.underline {
            layout.SetUnderline(
                true,
                DWRITE_TEXT_RANGE { startPosition: 0, length: text.len() as u32 },
            )?;
        }

        let color = D2D1_COLOR_F {
            r: spec.color[0],
            g: spec.color[1],
            b: spec.color[2],
            a: spec.color[3],
        };
        let brush = rt.CreateSolidColorBrush(&color, None)?;

        rt.BeginDraw();
        rt.Clear(Some(&D2D1_COLOR_F { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }));
        if spec.background[3] > 0.0 {
            let mut m = DWRITE_TEXT_METRICS::default();
            layout.GetMetrics(&mut m)?;
            let bg = D2D1_COLOR_F {
                r: spec.background[0],
                g: spec.background[1],
                b: spec.background[2],
                a: spec.background[3],
            };
            let bg_brush = rt.CreateSolidColorBrush(&bg, None)?;
            // Le texte commence à `pad_x + m.left`, donc la plaque à `m.left` — l'inset de la
            // boîte de mise en page et la marge de plaque s'annulent exactement, quel que soit
            // l'alignement. Elle est ensuite bornée à la boîte : au-delà, elle serait coupée
            // net par le bord de la texture et perdrait ses coins arrondis.
            let rect = D2D_RECT_F {
                left: m.left.max(0.0),
                top: (m.top - pad_y).max(0.0),
                right: (m.left + m.width + pad_x * 2.0).min(w as f32),
                bottom: (m.top + m.height + pad_y).min(h as f32),
            };
            let radius = crate::text_plate::radius(
                font_px,
                (rect.right - rect.left).max(0.0),
                (rect.bottom - rect.top).max(0.0),
            );
            rt.FillRoundedRectangle(
                &D2D1_ROUNDED_RECT {
                    rect,
                    radiusX: radius,
                    radiusY: radius,
                },
                &bg_brush,
            );
        }
        rt.DrawTextLayout(
            D2D_POINT_2F { x: pad_x, y: 0.0 },
            &layout,
            &brush,
            D2D1_DRAW_TEXT_OPTIONS_NONE,
        );
        // `EndDraw` rapporte une perte de device par son HRESULT plutôt qu'en échouant tout de
        // suite : on le propage pour que l'appelant sache que la texture n'est pas exploitable.
        rt.EndDraw(None, None)?;

        let mut srv: Option<ID3D11ShaderResourceView> = None;
        dev.CreateShaderResourceView(&tex, None, Some(&mut srv))?;
        Ok(srv.unwrap())
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
            font_size_px: 32.0,
            font_family: "Inter".into(),
            bold: true,
            italic: false,
            underline: false,
            align: "center".into(),
            box_px: [400, 120],
        }
    }

    #[test]
    fn identical_specs_share_a_cache_key() {
        assert_eq!(spec("Bonjour").cache_key(), spec("Bonjour").cache_key());
    }

    #[test]
    fn the_key_changes_with_anything_that_changes_the_pixels() {
        let base = spec("Bonjour").cache_key();
        let mut other = spec("Bonsoir");
        assert_ne!(other.cache_key(), base, "contenu");
        other = spec("Bonjour");
        other.font_size_px = 33.0;
        assert_ne!(other.cache_key(), base, "taille");
        other = spec("Bonjour");
        other.italic = true;
        assert_ne!(other.cache_key(), base, "style");
        other = spec("Bonjour");
        other.color = [1.0, 0.0, 0.0, 1.0];
        assert_ne!(other.cache_key(), base, "couleur");
        other = spec("Bonjour");
        other.align = "left".into();
        assert_ne!(other.cache_key(), base, "alignement");
        other = spec("Bonjour");
        // La taille de boîte compte : elle décide des retours à la ligne, donc des pixels.
        other.box_px = [401, 120];
        assert_ne!(other.cache_key(), base, "boîte");
    }

    #[test]
    fn the_key_is_stable_across_unicode_content() {
        // Le façonnage est délégué à DirectWrite ; la clé ne doit pas pour autant se briser sur
        // du non-ASCII (l'app expédie en 13 langues).
        for text in ["مرحبا", "こんにちは", "Grüße", "Здравствуйте"] {
            assert_eq!(spec(text).cache_key(), spec(text).cache_key());
        }
        assert_ne!(spec("مرحبا").cache_key(), spec("こんにちは").cache_key());
    }
}
