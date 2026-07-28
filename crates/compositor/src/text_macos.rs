//! Rastérisation du texte des annotations sur macOS — CoreText/CoreGraphics.
//!
//! Équivalent macOS de `text_windows.rs` (DirectWrite + Direct2D sur surface DXGI).
//! Le module exporte la même surface publique (`TextSpec`, `TextRasterizer`) pour que
//! `compositor.rs` puisse appeler `TextRasterizer::new()` / `rasterize(...)` sans
//! connaître la plateforme.
//!
//! # État de ce commit
//!
//! Seule l'API publique est exposée — la mécanique CoreText/CoreGraphics sera remplie
//! dans un commit ultérieur. Les commits d'implémentation ajouteront :
//!   - Un `CTFramesetter` créé depuis `CTFontCreateWithName` + l'`NSAttributedString`,
//!   - Un `CGContext` mémoire backed par un `MTLTexture` (via `MTKTextureLoader` /
//!     `CGDataProviderCreateWithData`) où le texte est dessiné en alpha-prémultiplié,
//!   - Le cache `text_cache: RefCell<HashMap<String, (MTLTexture, u64)>>` côté Metal
//!     (symétrique du `text_cache` D3D11).
//!
//! Le moteur Metal consomme déjà la texture comme `t0` dans le shader `ps_main` mode
//! 11 (texte D2D prémultiplié) — le port MSL met juste à jour le sampler pour lire
//! depuis le format `RGBA8Unorm` (équivalent direct de `DXGI_FORMAT_R8G8B8A8_UNORM`).
//!
//! Tant que `TextRasterizer::new` renvoie `Err`, le moteur macOS ne peut pas
//! composer du texte, et les annotations qui en dépendent (effets texte, fonds de
//! scène typés) échouent lisiblement. C'est cohérent avec le reste du scaffold.

use anyhow::{anyhow, Result};

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

/// Rastériseur de texte macOS. Conservé comme struct vide dans ce commit — la
/// mécanique CoreText/CoreGraphics sera ajoutée dans un commit ultérieur. Les
/// champs internes (factory CoreText, contexte CoreGraphics) seront ajoutés au fil
/// de l'implémentation.
pub struct TextRasterizer;

impl TextRasterizer {
    /// Crée un rastériseur CoreText/CoreGraphics. Renvoie `Err` dans ce commit.
    pub fn new() -> Result<TextRasterizer> {
        Err(anyhow!(
            "text_macos::TextRasterizer::new: non implémenté — \
             CoreText/CoreGraphics sera ajouté dans un commit ultérieur"
        ))
    }

    /// Rastérise un `TextSpec` vers une texture Metal. Le type de retour
    /// `*mut std::ffi::c_void` est l'opaque « handle de shader-resource-view » —
    /// un `MTLTexture` retainé côté macOS (équivalent direct du `ID3D11ShaderResourceView`
    /// Windows). Les call-sites doivent le cast via cfg : `ID3D11ShaderResourceView::from_raw`
    /// sur Windows, `metal::Texture::from_raw` sur macOS.
    ///
    /// Renvoie `Err` tant que le rastériseur n'est pas implémenté.
    pub unsafe fn rasterize(
        &self,
        _gpu: &crate::metal::Gpu,
        _spec: &TextSpec,
    ) -> Result<*mut std::ffi::c_void> {
        Err(anyhow!("text_macos::TextRasterizer::rasterize: non implémenté"))
    }
}