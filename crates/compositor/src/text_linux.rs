//! Rasterisation de texte Linux (PR #183) -- `cosmic-text` (rustybuzz + swash +
//! fontdb) au lieu de DirectWrite (Windows) / CoreText (macOS).
//!
//! Equivalent Linux de `text_windows.rs` / `text_macos.rs` : meme surface
//! publique (`TextSpec` + `cache_key`, `TextRasterizer::new()`,
//! `rasterize(&self, gpu, spec)`) pour que `compositor` (cfg-re-exporte) et
//! `text_anim` (partage) l'utilisent sans connaitre la plateforme.
//!
//! **Difference de format.** macOS/Windows bakent la couleur dans une texture
//! BGRA premultipliee (CoreText/Direct2D). Ici on produit un **atlas de
//! couverture R8** (alpha) que le shader WGSL (`layer.wgsl` mode 11) teinte par
//! `layer.color` -- meme resultat visuel, et le contrat d'iso-render porte sur
//! la GEOMETRIE (`frame_geometry::plan_frame`), pas sur la rasterisation texte
//! (dont l'ecart d'antialiasing est deja exclu des goldens cross-backend).

use anyhow::{bail, Result};
use std::cell::RefCell;

use cosmic_text::{Attrs, Buffer, FontSystem, Metrics, Shaping, SwashCache};

use crate::d3d::Gpu;

/// Tout ce dont le rendu d'un texte depend. Meme structure et meme `cache_key`
/// que `text_windows::TextSpec` / `text_macos::TextSpec` : la cle est partagee
/// entre plateformes, donc deux specs identiques produisent la meme texture.
#[derive(Clone, PartialEq)]
pub struct TextSpec {
    pub content: String,
    /// RGBA 0..1 (deja parse depuis la chaine CSS cote appelant).
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
    /// Taille de la boite en px de sortie.
    pub box_px: [u32; 2],
}

impl TextSpec {
    /// FNV-1a sur les memes octets, dans le meme ordre, que
    /// `text_macos::TextSpec::cache_key` / `text_windows` -- la policy est
    /// partagee (cache cross-plateforme coherent).
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

/// Le resultat d'une rasterisation : la texture R8 de couverture + ses dims.
pub struct RasterizedGlyphs {
    pub view: wgpu::TextureView,
    pub width: u32,
    pub height: u32,
}

/// Le rasterizer Linux. `fontdb` lit `/usr/share/fonts` a la construction du
/// `FontSystem`. Etat (font_system, swash_cache) en `RefCell` pour que
/// `rasterize(&self, ...)` matche la signature `&self` des autres plateformes
/// (le compositor tient un `Option<TextRasterizer>` et l'appelle sur `&self`).
pub struct TextRasterizer {
    font_system: RefCell<FontSystem>,
    swash_cache: RefCell<SwashCache>,
}

impl TextRasterizer {
    pub fn new() -> Result<TextRasterizer> {
        Ok(TextRasterizer {
            font_system: RefCell::new(FontSystem::new()),
            swash_cache: RefCell::new(SwashCache::new()),
        })
    }

    /// Rasterise `spec` dans une texture R8Unorm (couverture alpha) et rend sa
    /// view. `gpu` fournit le device/queue wgpu (passe au rasterize comme cote
    /// macOS). Le cache par `cache_key()` est gere par le caller (compositor).
    pub fn rasterize(&self, gpu: &Gpu, spec: &TextSpec) -> Result<RasterizedGlyphs> {
        let (w, h) = (spec.box_px[0].max(1), spec.box_px[1].max(1));
        if spec.content.is_empty() {
            bail!("text_linux::rasterize: texte vide");
        }

        let mut font_system = self.font_system.borrow_mut();
        let mut swash_cache = self.swash_cache.borrow_mut();

        let font_size = spec.font_size_px.max(1.0);
        let line_height = font_size * 1.4; // heuristique standard.
        let metrics = Metrics::new(font_size, line_height);
        let mut buffer = Buffer::new(&mut font_system, metrics);
        buffer.set_size(Some(w as f32), Some(h as f32));

        let mut attrs = Attrs::new();
        attrs = attrs.family(cosmic_text::Family::Name(&spec.font_family));
        if spec.bold {
            attrs = attrs.weight(cosmic_text::Weight::BOLD);
        }
        if spec.italic {
            attrs = attrs.style(cosmic_text::Style::Italic);
        }
        if spec.underline {
            attrs = attrs.underline(cosmic_text::UnderlineStyle::Single);
        }
        buffer.set_text(&spec.content, &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut font_system, false);

        // Atlas R8 : on n'ecrit que le canal alpha (couverture). Le tint par
        // `spec.color` se fait cote shader (mode 11).
        let mut atlas: Vec<u8> = vec![0u8; (w * h) as usize];
        for run in buffer.layout_runs() {
            for glyph in run.glyphs.iter() {
                let physical = glyph.physical((0.0, 0.0), 1.0);
                let img = swash_cache.get_image(&mut font_system, physical.cache_key);
                let glyph_x = physical.x + run.line_top as i32;
                let glyph_y = physical.y;
                let Some(img) = img else { continue };
                let placement = img.placement;
                let (img_w, img_h) = (placement.width, placement.height);
                if img_w == 0 || img_h == 0 {
                    continue;
                }
                let stride = match img.content {
                    cosmic_text::SwashContent::Mask => img_w as usize,
                    cosmic_text::SwashContent::Color => img_w as usize * 4,
                    _ => continue,
                };
                let alpha_offset = if matches!(img.content, cosmic_text::SwashContent::Color) {
                    3
                } else {
                    0
                };
                let bpp = if alpha_offset == 0 { 1 } else { 4 };
                for row in 0..img_h as i32 {
                    let dest_y = glyph_y + placement.top + row;
                    if dest_y < 0 || dest_y >= h as i32 {
                        continue;
                    }
                    let dest_x = glyph_x + placement.left;
                    if dest_x >= w as i32 {
                        continue;
                    }
                    let copy_len = (img_w as i32).min(w as i32 - dest_x).max(0) as usize;
                    if copy_len == 0 {
                        continue;
                    }
                    let src_row = &img.data[(row as usize) * stride..(row as usize + 1) * stride];
                    let atlas_row_start = (dest_y as usize) * w as usize;
                    for col in 0..copy_len {
                        let atlas_idx = atlas_row_start + (dest_x as usize + col);
                        let src_idx = col * bpp + alpha_offset;
                        if src_idx < src_row.len() {
                            atlas[atlas_idx] = src_row[src_idx];
                        }
                    }
                }
            }
        }

        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("text-atlas"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        gpu.context.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &atlas,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w),
                rows_per_image: Some(h),
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Ok(RasterizedGlyphs {
            view,
            width: w,
            height: h,
        })
    }
}
