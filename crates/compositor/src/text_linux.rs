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
    /// "top" | "center" | "bottom" -- quelle arete du bloc de texte est epinglee
    /// a la boite. "center" est le comportement historique (et celui des
    /// annotations, qui reproduisent `alignItems: center` de l'overlay web) ; les
    /// sous-titres passent "bottom" ou "top" pour que l'arete ancree ne bouge pas
    /// quand le texte gagne une ligne.
    pub valign: String,
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
        // Juste apres `align`, memes octets et meme position que sur les deux
        // autres backends : deux specs ne differant que par l'alignement vertical
        // rendraient sinon les pixels l'une de l'autre depuis le cache.
        mix(self.valign.as_bytes());
        mix(&self.box_px[0].to_le_bytes());
        mix(&self.box_px[1].to_le_bytes());
        h
    }
}

/// Le resultat d'une rasterisation : la texture R8 de couverture + ses dims,
/// plus la plaque de fond que le compositeur doit poser dessous.
pub struct RasterizedGlyphs {
    pub view: wgpu::TextureView,
    pub width: u32,
    pub height: u32,
    /// `[x, y, w, h]` en px DANS la boite (origine coin haut-gauche) : la
    /// plaque de fond epousant le bloc de texte, marge `text_plate` comprise.
    ///
    /// Elle voyage avec l'atlas parce qu'elle sort de la MEME mise en page :
    /// seul le rasteriseur sait ou cosmic-text a effectivement pose les lignes.
    /// Windows et macOS bakent la plaque dans la texture ; l'atlas R8 d'ici ne
    /// porte qu'une couverture alpha, donc le compositeur la dessine en quad
    /// separe (mode 1) et a besoin du rect.
    pub plate: [f32; 4],
}

/// Un atlas de couverture + la plaque mesuree sur la meme mise en page.
pub struct TextAtlas {
    /// Couverture R8 tightly-packed, `box_px[0] * box_px[1]` octets.
    pub pixels: Vec<u8>,
    /// Cf. [`RasterizedGlyphs::plate`].
    pub plate: [f32; 4],
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
        let atlas = self.build_atlas(spec)?;

        Self::upload(gpu, &atlas.pixels, w, h, atlas.plate)
    }

    /// La moitie CPU de [`Self::rasterize`] : shaping + placement des glyphes
    /// dans un atlas R8 de `spec.box_px`.
    ///
    /// Separee du GPU EXPRES. Le placement des glyphes est de l'arithmetique
    /// pure, et c'est exactement la ou le portage s'etait trompe (origine au
    /// coin au lieu de la ligne de base, `line_top` ajoute au X, signe de
    /// `placement.top` inverse). Tant que ce code vivait derriere un `&Gpu`, il
    /// etait intestable sans peripherique. Il ne l'est plus.
    pub fn build_atlas(&self, spec: &TextSpec) -> Result<TextAtlas> {
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
        // LARGEUR DE MISE EN PAGE : la boite RENTREE de la marge de plaque, comme
        // sur les deux autres backends (`text_plate::layout_width`). Composer sur
        // la largeur pleine coupait les lignes ailleurs que la ou la plaque est
        // dimensionnee, et collait un texte ferre a gauche/droite contre le bord,
        // ou sa plaque se fait rogner du cote ou elle devrait respirer.
        let (pad_x, pad_y) = crate::text_plate::padding(font_size);
        let avail_w = crate::text_plate::layout_width(w as f32, font_size);
        buffer.set_size(Some(avail_w), Some(h as f32));

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
        // L'alignement se pose PAR LIGNE, apres set_text (qui reconstruit les
        // lignes) et avant le shaping. Sans ca tout le texte sort ferre a
        // gauche alors que le defaut de l'editeur est « center ».
        let align = match spec.align.as_str() {
            "center" => Some(cosmic_text::Align::Center),
            "right" | "end" => Some(cosmic_text::Align::Right),
            "justify" => Some(cosmic_text::Align::Justified),
            // `None` laisse cosmic-text suivre la direction du script, ce qui
            // est le bon defaut pour "left"/"start" et pour une valeur inconnue.
            _ => None,
        };
        for line in &mut buffer.lines {
            line.set_align(align);
        }
        buffer.shape_until_scroll(&mut font_system, false);

        // CENTRAGE VERTICAL. L'overlay web pose `alignItems: center` sur le
        // conteneur de l'annotation, et Windows reproduit ca avec
        // `DWRITE_PARAGRAPH_ALIGNMENT_CENTER` (text_windows.rs:175-176). macOS
        // ne le fait pas, et le portage Linux avait copie macOS : le texte
        // collait en haut de sa boite. Les deux references natives divergent
        // reellement ici ; c'est le web qui porte l'intention produit.
        //
        // La hauteur du bloc est prise sur la DERNIERE ligne posee plutot que
        // sur un compte de lignes x line_height : cosmic-text peut replier une
        // ligne logique en plusieurs runs, donc compter les runs surestimerait
        // des que le texte deborde en largeur.
        let text_h = buffer
            .layout_runs()
            .map(|run| run.line_top + run.line_height)
            .fold(0.0f32, f32::max);
        // `max(0)` : un texte plus haut que sa boite reste ancre en haut plutot
        // que de sortir par le dessus, ou il serait entierement rogne.
        //
        // ANCRAGE. `center` est le comportement historique, et reste celui des
        // annotations. Les sous-titres epinglent une arete : c'est la seule facon
        // que l'arete ancree ne bouge pas quand le texte gagne une ligne, parce
        // qu'un bloc centre voit ses DEUX aretes se deplacer.
        //
        // `anchor_pad` reserve la marge de la plaque DU COTE ANCRE. Sans elle, coller
        // le bloc de texte au bord laisse la plaque poser toute sa marge du cote
        // oppose et zero du cote ancre : le fond epouse alors le bas des lettres au
        // pixel pres tout en respirant deux fois trop au-dessus. Ce qui doit toucher
        // le bord de la boite est la PLAQUE, pas les glyphes — c'est elle que le
        // viewer voit. Sans plaque, il n'y a rien a reserver.
        let has_plate = spec.background[3] > 0.0;
        let anchor_pad = if has_plate { pad_y } else { 0.0 };
        let slack_y = ((h as f32) - text_h).max(0.0);
        let y_offset = match spec.valign.as_str() {
            "top" | "start" => anchor_pad,
            "bottom" | "end" => slack_y - anchor_pad,
            _ => slack_y * 0.5,
        }
        .clamp(0.0, slack_y)
        .round() as i32;

        // LA PLAQUE EPOUSE LE BLOC, PAS LA BOITE. Miroir de
        // `text_macos::block_layout` (en coordonnees descendantes ici, CoreText
        // est ascendant). Le portage dessinait la plaque sur la boite entiere :
        // sur un sous-titre, cette boite est la bande de sous-titres — 22 % de la
        // hauteur de frame — donc l'aplat montait et descendait tres au-dela du
        // texte alors que Windows et macOS le serrent a `0.1em` pres.
        let text_w = buffer
            .layout_runs()
            .map(|run| run.line_w)
            .fold(0.0f32, f32::max)
            .min(avail_w);
        // Le bloc est centre dans la boite : cosmic-text aligne DANS `avail_w`,
        // et `frame_x` reporte ce cadre au centre de la boite.
        let frame_x = ((w as f32) - avail_w) * 0.5;
        let x_offset = frame_x.round() as i32;
        // « sans jamais deborder de la boite » : au-dela, la plaque serait coupee
        // net par le bord de la texture et perdrait ses coins arrondis.
        let plate_w = (text_w + pad_x * 2.0).min(w as f32);
        let plate_h = (text_h + pad_y * 2.0).min(h as f32);
        let slack_x = ((w as f32) - plate_w).max(0.0);
        let plate_x = match spec.align.as_str() {
            // A gauche les lignes commencent au bord gauche du cadre, a droite
            // elles y finissent : la plaque deborde de `pad_x` du cote concerne.
            "left" | "start" => frame_x - pad_x,
            "right" | "end" => frame_x + avail_w + pad_x - plate_w,
            _ => slack_x * 0.5,
        }
        .clamp(0.0, slack_x);
        let plate_y = ((y_offset as f32) - pad_y).clamp(0.0, ((h as f32) - plate_h).max(0.0));
        let plate = [plate_x, plate_y, plate_w, plate_h];

        // Atlas R8 : on n'ecrit que le canal alpha (couverture). Le tint par
        // `spec.color` se fait cote shader (mode 11).
        let mut atlas: Vec<u8> = vec![0u8; (w * h) as usize];
        for run in buffer.layout_runs() {
            for glyph in run.glyphs.iter() {
                // L'ORIGINE EST LA LIGNE DE BASE, PAS LE COIN. C'est la
                // convention de cosmic-text : `Buffer::draw` appelle
                // `glyph.physical((0., run.line_y), 1.0)` et son rasteriseur
                // pose ensuite le haut du bitmap a `y - placement.top`.
                //
                // Le portage passait `(0.0, 0.0)` — donc sans ligne de base —
                // et ajoutait `run.line_top`, une quantite VERTICALE, au X.
                // Resultat mesure sur « Agjo Hxy » en 40px : aucune ligne de
                // base commune, le 'A' 14 px SOUS le 'o', et sur du multi-ligne
                // la 2e ligne redessinee sur les memes rangees que la 1re mais
                // decalee de `line_top` px vers la droite.
                let physical = glyph.physical((0.0, run.line_y), 1.0);
                let img = swash_cache.get_image(&mut font_system, physical.cache_key);
                let glyph_x = physical.x;
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
                // `placement.top` est la hauteur de l'encre AU-DESSUS de la
                // ligne de base, donc la premiere rangee du bitmap est a
                // `baseline - top`. Le signe etait inverse.
                let ink_top = glyph_y - placement.top + y_offset;
                let ink_left = glyph_x + placement.left + x_offset;
                for row in 0..img_h as i32 {
                    let dest_y = ink_top + row;
                    if dest_y < 0 || dest_y >= h as i32 {
                        continue;
                    }
                    // `placement.left` est negatif sur les glyphes qui debordent
                    // a gauche de leur avance ('j' en DejaVu Sans : -3). Sans ce
                    // rattrapage, `dest_x as usize` enroule en release et l'encre
                    // se retrouve collee au bord droit de la rangee PRECEDENTE ;
                    // en debug c'est une panique d'overflow. On saute plutot les
                    // colonnes SOURCE hors cadre.
                    let (dest_x, skip_cols) = if ink_left < 0 {
                        (0i32, (-ink_left) as usize)
                    } else {
                        (ink_left, 0usize)
                    };
                    if dest_x >= w as i32 || skip_cols >= img_w as usize {
                        continue;
                    }
                    let copy_len = ((img_w as usize - skip_cols) as i32)
                        .min(w as i32 - dest_x)
                        .max(0) as usize;
                    if copy_len == 0 {
                        continue;
                    }
                    let src_row = &img.data[(row as usize) * stride..(row as usize + 1) * stride];
                    let atlas_row_start = (dest_y as usize) * w as usize;
                    for col in 0..copy_len {
                        let atlas_idx = atlas_row_start + (dest_x as usize + col);
                        let src_idx = (col + skip_cols) * bpp + alpha_offset;
                        if src_idx < src_row.len() {
                            // `max` et non affectation : deux glyphes peuvent se
                            // chevaucher (accents, ligatures, italiques) et
                            // ecraser ferait disparaitre l'encre du premier.
                            atlas[atlas_idx] = atlas[atlas_idx].max(src_row[src_idx]);
                        }
                    }
                }
            }
        }

        Ok(TextAtlas {
            pixels: atlas,
            plate,
        })
    }

    /// Televerse un atlas R8 deja construit et rend sa view.
    fn upload(
        gpu: &Gpu,
        atlas: &[u8],
        w: u32,
        h: u32,
        plate: [f32; 4],
    ) -> Result<RasterizedGlyphs> {
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
            plate,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(content: &str, align: &str) -> TextSpec {
        TextSpec {
            content: content.to_owned(),
            color: [1.0, 1.0, 1.0, 1.0],
            background: [0.0, 0.0, 0.0, 0.0],
            font_size_px: 40.0,
            // Vide = cosmic-text prend la police par defaut du systeme. Nommer
            // une famille precise rendrait le test dependant des polices
            // installees sur la machine qui l'execute.
            font_family: String::new(),
            bold: false,
            italic: false,
            underline: false,
            align: align.to_owned(),
            valign: "center".to_owned(),
            box_px: [400, 200],
        }
    }

    /// Rangees d'atlas contenant de l'encre, pour la tranche `x0..x1`.
    fn ink_rows(atlas: &[u8], w: usize, x0: usize, x1: usize) -> Vec<usize> {
        let h = atlas.len() / w;
        (0..h)
            .filter(|y| (x0..x1.min(w)).any(|x| atlas[y * w + x] > 16))
            .collect()
    }

    fn ink_cols(atlas: &[u8], w: usize) -> Vec<usize> {
        let h = atlas.len() / w;
        (0..w)
            .filter(|x| (0..h).any(|y| atlas[y * w + x] > 16))
            .collect()
    }

    #[test]
    fn the_plate_hugs_the_text_instead_of_filling_the_box() {
        // LE bug des sous-titres sous Linux. La plaque etait le quad de la boite
        // entiere ; la boite d'un sous-titre est la bande de sous-titres (22 % de
        // la hauteur de frame), donc l'aplat montait et descendait tres au-dela du
        // texte. Windows et macOS le serrent a `0.1em` (`text_plate`) — ici on
        // verifie la meme chose sur une boite volontairement trop haute.
        let raster = TextRasterizer::new().expect("rasterizer");
        let atlas = raster.build_atlas(&spec("Hx", "center")).expect("atlas");
        let (_, pad_y) = crate::text_plate::padding(40.0);
        let [_, py, _, ph] = atlas.plate;

        // Une ligne de 40px : bloc haut de 1.4em = 56px, plaque = 56 + 2*4 = 64px.
        // Tres loin des 200px de la boite.
        assert!(
            ph < 80.0,
            "la plaque fait {ph}px de haut dans une boite de 200 : elle remplit encore la boite"
        );
        // Et elle couvre bien l'encre, marge comprise.
        let rows = ink_rows(&atlas.pixels, 400, 0, 400);
        let (top, bottom) = (rows[0] as f32, *rows.last().unwrap() as f32);
        assert!(
            py <= top + pad_y && py + ph >= bottom - pad_y,
            "l'encre ({top}..{bottom}) sort de la plaque ({py}..{})",
            py + ph
        );
    }

    #[test]
    fn the_plate_follows_the_alignment_and_stays_in_the_box() {
        // Trois alignements, une plaque qui epouse le texte : elle doit se poser du
        // bon cote et ne jamais deborder — au-dela elle serait coupee net par le
        // bord de la texture et perdrait ses coins arrondis.
        let raster = TextRasterizer::new().expect("rasterizer");
        let (pad_x, _) = crate::text_plate::padding(40.0);
        let left = raster.build_atlas(&spec("hi", "left")).expect("atlas").plate;
        let centre = raster.build_atlas(&spec("hi", "center")).expect("atlas").plate;
        let right = raster.build_atlas(&spec("hi", "right")).expect("atlas").plate;

        for p in [left, centre, right] {
            assert!(p[0] >= 0.0 && p[0] + p[2] <= 400.0 + 0.01, "plaque hors boite : {p:?}");
            assert!(p[2] < 400.0, "plaque large comme la boite : {p:?}");
        }
        assert!(left[0] < pad_x + 0.01, "la plaque ferree a gauche devrait toucher le bord");
        assert!(
            centre[0] > left[0] + 20.0 && right[0] > centre[0] + 20.0,
            "les trois alignements posent la plaque au meme endroit : {left:?} {centre:?} {right:?}"
        );
    }

    #[test]
    fn glyphs_of_different_heights_share_one_baseline() {
        // LE test de ce fichier. Le portage posait chaque glyphe contre le HAUT
        // de sa propre boite d'encre au lieu de la ligne de base commune, avec
        // en prime le signe de `placement.top` inverse. Mesure d'alors sur
        // « Agjo Hxy » en 40px : le 'A' finissait 14 px SOUS le 'o'.
        //
        // On compare le bas de l'encre d'un 'H' (qui descend jusqu'a la ligne
        // de base) et celui d'un 'x' (idem). S'ils partagent une ligne de base,
        // leurs dernieres rangees d'encre coincident a l'antialiasing pres.
        let raster = TextRasterizer::new().expect("rasterizer");
        let atlas = raster.build_atlas(&spec("Hx", "left")).expect("atlas").pixels;
        let w = 400usize;

        let cols = ink_cols(&atlas, w);
        assert!(!cols.is_empty(), "aucune encre : le texte n'a pas ete rasterise");
        // Coupe entre les deux glyphes : le plus grand trou horizontal.
        let split = cols
            .windows(2)
            .max_by_key(|p| p[1] - p[0])
            .map(|p| (p[0] + p[1]) / 2)
            .expect("deux glyphes attendus");

        let left = ink_rows(&atlas, w, cols[0], split);
        let right = ink_rows(&atlas, w, split, *cols.last().unwrap() + 1);
        assert!(!left.is_empty() && !right.is_empty(), "un des deux glyphes est vide");

        let (h_bottom, x_bottom) = (*left.last().unwrap(), *right.last().unwrap());
        assert!(
            h_bottom.abs_diff(x_bottom) <= 2,
            "pas de ligne de base commune : bas du 'H' = {h_bottom}, bas du 'x' = {x_bottom}"
        );
    }

    #[test]
    fn a_second_line_sits_below_the_first() {
        // L'autre moitie du meme bug : `run.line_top` etait ajoute au X, donc la
        // 2e ligne se dessinait sur les MEMES rangees que la 1re, decalee vers
        // la droite. Ici elle doit etre strictement plus bas, et commencer a peu
        // pres a la meme abscisse.
        let raster = TextRasterizer::new().expect("rasterizer");
        let atlas = raster.build_atlas(&spec("ab\ncd", "left")).expect("atlas").pixels;
        let w = 400usize;

        let rows = ink_rows(&atlas, w, 0, w);
        assert!(rows.len() > 4, "trop peu d'encre pour deux lignes");
        // Un trou vertical separe les deux lignes.
        let gap = rows
            .windows(2)
            .max_by_key(|p| p[1] - p[0])
            .expect("deux lignes attendues");
        assert!(
            gap[1] - gap[0] > 2,
            "les deux lignes se chevauchent : aucune separation verticale trouvee"
        );
    }

    /// Chaque texte par defaut d'annotation produit-il de l'encre sur CETTE
    /// machine ?
    ///
    /// L'app propose un texte localise a la creation ("Hello", "你好",
    /// "مرحبا"...). Si la police systeme ne couvre pas le script, cosmic-text
    /// rend du tofu ou rien du tout, et l'utilisateur voit une annotation vide
    /// qu'il n'a pas ecrite. Le test ne PEUT pas garantir la couverture d'une
    /// machine inconnue — il documente ce qui manque sur celle qui l'execute,
    /// ce qui est exactement l'information utile quand quelqu'un rapporte
    /// « mon annotation est invisible ».
    #[test]
    fn the_localised_default_texts_render_on_this_machine() {
        let raster = TextRasterizer::new().expect("rasterizer");
        let samples = [
            ("en", "Hello"), ("fr", "Bonjour"), ("es", "Hola"), ("it", "Ciao"),
            ("pt-BR", "Olá"), ("ru", "Привет"), ("tr", "Merhaba"), ("vi", "Xin chào"),
            ("ar", "مرحبا"), ("ja-JP", "こんにちは"), ("ko-KR", "안녕하세요"),
            ("zh-CN", "你好"), ("zh-TW", "你好"),
        ];
        let mut blank = Vec::new();
        for (locale, text) in samples {
            let atlas = raster.build_atlas(&spec(text, "center")).expect("atlas").pixels;
            let ink = atlas.iter().filter(|byte| **byte > 16).count();
            println!("  {locale:6} {text:12} -> {ink} px d'encre");
            if ink == 0 {
                blank.push(locale);
            }
        }
        assert!(
            blank.is_empty(),
            "aucune police installee ne couvre: {blank:?} — l'annotation par defaut y serait invisible"
        );
    }

    #[test]
    fn one_short_line_is_centred_vertically_in_its_box() {
        // L'overlay web pose `alignItems: center` et Windows fait pareil
        // (DWRITE_PARAGRAPH_ALIGNMENT_CENTER) ; macOS non, et le portage avait
        // copie macOS. Une ligne de 40px dans une boite de 200px doit laisser a
        // peu pres autant de vide au-dessus qu'en dessous.
        let raster = TextRasterizer::new().expect("rasterizer");
        let atlas = raster.build_atlas(&spec("Hx", "center")).expect("atlas").pixels;
        let (w, h) = (400usize, 200usize);
        let rows = ink_rows(&atlas, w, 0, w);
        assert!(!rows.is_empty(), "aucune encre");

        let (top, bottom) = (rows[0], *rows.last().unwrap());
        let above = top as i32;
        let below = (h - 1 - bottom) as i32;
        assert!(
            (above - below).abs() <= 12,
            "texte non centre verticalement : {above}px au-dessus, {below}px en dessous"
        );
    }

    #[test]
    fn the_anchored_edge_holds_still_when_the_text_gains_a_line() {
        // L'INVARIANT de la refonte du placement des sous-titres, en une
        // assertion — et celle que l'ancienne architecture ne pouvait pas ecrire.
        //
        // Un bloc centre voit ses DEUX aretes bouger quand il grandit : c'est
        // exactement pourquoi elargir la bande deplacait verticalement le
        // sous-titre. Ancre en bas, l'arete basse ne doit pas bouger d'un pixel,
        // que le texte tienne sur une ligne ou en reclame trois.
        let raster = TextRasterizer::new().expect("rasterizer");
        let (w, h) = (400usize, 200usize);
        let long = "un texte assez long pour devoir se replier sur plusieurs lignes";

        // On mesure la PLAQUE, pas le dernier pixel d'encre. La plaque epouse la boite
        // de lignes posee par cosmic-text : c'est exactement ce que ce code epingle et
        // ce que le compositeur dessine. Le bas de l'ENCRE, lui, depend des jambages du
        // contenu — "Hx" n'en a aucun, "replier" en a — donc il descend plus bas a
        // ancrage identique. Ancrer la boite de lignes plutot que l'encre est le
        // comportement typographique attendu partout, et c'est la premiere version de
        // ce test qui avait tort : elle comparait 184 a 199 et appelait ca une derive.
        let plate_of = |valign: &str, content: &str| {
            let mut s = spec(content, "center");
            s.valign = valign.to_owned();
            let atlas = raster.build_atlas(&s).expect("atlas");
            let [_, py, _, ph] = atlas.plate;
            let rows = ink_rows(&atlas.pixels, w, 0, w);
            assert!(!rows.is_empty(), "aucune encre pour {valign:?}");
            (py, py + ph, rows[0], *rows.last().unwrap())
        };

        let (short_top_edge, short_bottom, _, _) = plate_of("bottom", "Hx");
        let (long_top_edge, long_bottom, _, _) = plate_of("bottom", long);
        assert!(
            (short_bottom - long_bottom).abs() < 1.0,
            "ancrage bas : l'arete basse a bouge de {short_bottom} a {long_bottom} \
             en passant d'une ligne a plusieurs"
        );

        // Et le miroir, pour que « haut » ne soit pas juste « pas bas ».
        let (short_top, _, _, _) = plate_of("top", "Hx");
        let (long_top, _, _, _) = plate_of("top", long);
        assert!(
            (short_top - long_top).abs() < 1.0,
            "ancrage haut : l'arete haute a bouge de {short_top} a {long_top}"
        );

        // Le texte long doit vraiment se replier, sinon les deux assertions ci-dessus
        // passeraient sur deux rendus identiques et ne prouveraient rien.
        assert!(
            (long_bottom - long_top_edge) > (short_bottom - short_top_edge) + 1.0,
            "le texte « long » ne s'est pas replie : le test ne prouve rien"
        );

        // Les trois ancrages doivent poser la plaque a trois endroits differents,
        // sinon `valign` n'est pas applique du tout.
        let (top_y, _, _, _) = plate_of("top", "Hx");
        let (ctr_y, _, _, _) = plate_of("center", "Hx");
        let (bot_y, _, _, _) = plate_of("bottom", "Hx");
        assert!(
            top_y < ctr_y && ctr_y < bot_y,
            "les trois ancrages ne se distinguent pas : haut={top_y} centre={ctr_y} bas={bot_y}"
        );

        // Enfin, l'encre reste dans la plaque qui la porte, et la plaque dans la boite :
        // c'est ce qui relie la boite mesuree ci-dessus a ce que le viewer voit.
        //
        // Tolerance `pad_y`, la meme que `the_plate_hugs_the_text_instead_of_filling_the_box`
        // plus haut : l'encre est bornee par la boite de LIGNES, et un glyphe peut deborder
        // legerement la sienne (jambages, accents) sans que rien ne soit casse. C'est
        // exactement l'hypothese que la premiere version de ce test avait fausse.
        for valign in ["top", "bottom"] {
            let (py, pb, ink_top, ink_bottom) = plate_of(valign, long);
            let (_, pad_y) = crate::text_plate::padding(40.0);
            assert!(
                (ink_top as f32) >= py - pad_y && (ink_bottom as f32) <= pb + pad_y,
                "{valign} : l'encre ({ink_top}..{ink_bottom}) sort de la plaque ({py}..{pb})"
            );
            assert!(pb <= (h as f32) + 0.01, "{valign} : la plaque sort de la boite");
        }
    }

    #[test]
    fn the_vertical_anchor_changes_the_cache_key() {
        // Le piege du cache : la cle est partagee entre plateformes, et deux specs
        // ne differant que par `valign` rendraient les pixels l'une de l'autre si
        // le champ n'y entrait pas.
        let mut bottom = spec("Hx", "center");
        bottom.valign = "bottom".to_owned();
        assert_ne!(bottom.cache_key(), spec("Hx", "center").cache_key());
    }

    #[test]
    fn centering_moves_the_ink_off_the_left_edge() {
        // `spec.align` n'etait jamais applique : tout sortait ferre a gauche
        // alors que le defaut de l'editeur est « center ».
        let raster = TextRasterizer::new().expect("rasterizer");
        let w = 400usize;
        let left = ink_cols(&raster.build_atlas(&spec("hi", "left")).expect("atlas").pixels, w);
        let centered = ink_cols(&raster.build_atlas(&spec("hi", "center")).expect("atlas").pixels, w);

        assert!(!left.is_empty() && !centered.is_empty());
        assert!(
            centered[0] > left[0] + 20,
            "le centrage n'a pas bouge le texte : gauche debute a {}, centre a {}",
            left[0],
            centered[0]
        );
    }

    #[test]
    fn a_glyph_overhanging_to_the_left_does_not_wrap_around() {
        // 'j' a un `placement.left` negatif en DejaVu Sans. Avant, `dest_x as
        // usize` enroulait : l'encre atterrissait au bord DROIT de la rangee
        // precedente en release, et paniquait en debug. Ce test tourne en debug
        // sous `cargo test`, donc il attrape la panique directement.
        let raster = TextRasterizer::new().expect("rasterizer");
        let atlas = raster.build_atlas(&spec("jazz", "left")).expect("pas de panique").pixels;
        let w = 400usize;
        // Rien ne doit avoir atterri contre le bord droit d'une rangee.
        let h = atlas.len() / w;
        let right_edge_ink = (0..h).filter(|y| atlas[y * w + (w - 1)] > 16).count();
        assert_eq!(right_edge_ink, 0, "de l'encre a enroule jusqu'au bord droit");
    }
}
