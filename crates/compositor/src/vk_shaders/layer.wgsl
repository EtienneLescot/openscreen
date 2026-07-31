// Tranche verticale WP3 — port 1:1 des modes 0 (vidéo NV12) et 1 (couleur pleine)
// du `ps_main` HLSL (`crates/compositor/src/shaders.hlsl`). Le mode 2 (ombre
// portée) partage la même SDF et le même feather que les autres modes, donc on
// l'inclut aussi pour parité.
//
// Les constantes YUV (BT.709 limited) sont reprises à l'identique du HLSL :
//   Yf  = (Y  * 255 − 16) / 219
//   Cb  = (UV.x * 255 − 128) / 224
//   Cr  = (UV.y * 255 − 128) / 224
//   R   = Yf + 1.5748 · Cr
//   G   = Yf − 0.1873 · Cb − 0.4681 · Cr
//   B   = Yf + 1.8556 · Cb
// Mesuré en S1 (cf. doc §7 E1). Une déviation > 0/255 entre HLSL et WGSL ici
// indiquerait une différence de précision fp32 ; IEEE-754 round-to-nearest est
// identique sur les deux backends.
//
// Le rendu est en alpha PRÉMULTIPLIÉ (cf. commentaire HLSL), convention qu'on
// retrouve dans tous les autres modes du compositeur (texte, curseur, ombre).

struct Layer {
    dst: vec4<f32>,       // x,y,w,h sortie 0..1 (origine haut-gauche)
    src: vec4<f32>,       // u0,v0,u1,v1 source 0..1
    quad_px: vec2<f32>,   // taille du quad en px de sortie (pour la SDF isotrope)
    radius_px: f32,
    mode: f32,            // 0 = vidéo NV12, 1 = couleur pleine, 2 = ombre, 8 = écran tilté, 9 = flèche, 10 = flou/mosaïque, 12 = ombre du quad tilté, 13 = curseur tilté
    color: vec4<f32>,
    fx: vec4<f32>,        // mode 2 : spread ombre en px ; modes 8/12/13 : coins TL,TR du quad projeté ; mode 9 : hampe de la flèche ; mode 10 : (flou?, rayon/bloc px, ovale?, teinté?)
    src_prev: vec4<f32>,  // modes 8/12/13 : coins BR,BL du quad projeté ; mode 9 : barbe 1
    dst_prev: vec4<f32>,  // mode 8 : taille du plan en px AVANT projection (le rayon y vit) ; mode 13 : rect de clip ; mode 9 : barbe 2
    mb: vec4<f32>,        // mode 12 : mb.y = spread de la pénombre en px ; mode 9 : mb.y = demi-épaisseur du trait en px
}

@group(0) @binding(0) var<uniform> layer: Layer;
@group(0) @binding(1) var texY:  texture_2d<f32>;   // R8Unorm, sample .r
@group(0) @binding(2) var texUV: texture_2d<f32>;   // Rg8Unorm, sample .rg
@group(0) @binding(3) var samp:  sampler;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,     // UV d'échantillonnage source
    @location(1) local: vec2<f32>,  // pixel local dans le quad (SDF)
    @location(2) pout: vec2<f32>,   // position 0..1 sortie
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    // strip 4 vertices : (0,0)(1,0)(0,1)(1,1)
    let c = vec2<f32>(f32(vid & 1u), f32((vid >> 1u) & 1u));
    let p = layer.dst.xy + c * layer.dst.zw;
    let ndc = vec2<f32>(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0);
    var o: VsOut;
    o.pos = vec4<f32>(ndc, 0.0, 1.0);
    o.uv = layer.src.xy + c * (layer.src.zw - layer.src.xy);
    o.local = c * layer.quad_px;
    o.pout = p;
    return o;
}

fn yuv709_limited(y: f32, cbcr: vec2<f32>) -> vec3<f32> {
    let Yf = (y * 255.0 - 16.0) / 219.0;
    let Cb = (cbcr.x * 255.0 - 128.0) / 224.0;
    let Cr = (cbcr.y * 255.0 - 128.0) / 224.0;
    return clamp(vec3<f32>(
        Yf + 1.5748 * Cr,
        Yf - 0.1873 * Cb - 0.4681 * Cr,
        Yf + 1.8556 * Cb,
    ), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn sample_yuv(uv: vec2<f32>) -> vec3<f32> {
    let y = textureSample(texY, samp, uv).r;
    let cbcr = textureSample(texUV, samp, uv).rg;
    return yuv709_limited(y, cbcr);
}

// SDF rectangle à coins arrondis (< 0 dedans). Identique au HLSL.
fn sd_round_rect(p: vec2<f32>, halfsz: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - halfsz + vec2<f32>(r);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// ---- Primitives du tilt 3D (modes 8 et 12), portees de `shaders.metal` ----

// SDF segment a bouts ronds.
fn sd_segment(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
    let pa = p - a;
    let ba = b - a;
    let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
}

// Intersection de deux droites donnees par (normale, offset) : n.x = d. Cramer.
fn line_cross(n1: vec2<f32>, d1: f32, n2: vec2<f32>, d2: f32) -> vec2<f32> {
    let det = n1.x * n2.y - n1.y * n2.x;
    if abs(det) < 1e-6 {
        return vec2<f32>(0.0, 0.0);
    }
    return vec2<f32>(d1 * n2.y - d2 * n1.y, d2 * n1.x - d1 * n2.x) / det;
}

// Contribution d'une arete a la SDF du quad : .x = distance signee au demi-plan
// porte par l'arete (>0 dehors), .y = distance au SEGMENT.
fn quad_edge(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    let e = b - a;
    // Division par la longueur plutot que `normalize` : une arete degeneree
    // donnerait un NaN qui effacerait le calque entier.
    let n = vec2<f32>(e.y, -e.x) / max(length(e), 1e-6);
    return vec2<f32>(dot(p - a, n), sd_segment(p, a, b));
}

// Distance signee EXACTE a un quadrilatere convexe (<0 dedans). La boucle `k`
// du MSL est deroulee : elle indexait un tableau local avec un indice runtime,
// ce que naga 24 traduit en SPIR-V invalide (cf. `blur.wgsl`).
fn sd_convex_quad(p: vec2<f32>, v0: vec2<f32>, v1: vec2<f32>, v2: vec2<f32>, v3: vec2<f32>) -> f32 {
    let e0 = quad_edge(p, v0, v1);
    let e1 = quad_edge(p, v1, v2);
    let e2 = quad_edge(p, v2, v3);
    let e3 = quad_edge(p, v3, v0);
    let inside = max(max(e0.x, e1.x), max(e2.x, e3.x));
    let border = min(min(e0.y, e1.y), min(e2.y, e3.y));
    if inside < 0.0 {
        return -border;
    }
    return border;
}

// Coin d'un quad rentre de `r` : intersection des deux aretes adjacentes,
// chacune decalee de `r` vers l'interieur. Meme deroulement que ci-dessus.
fn inset_corner(prev: vec2<f32>, cur: vec2<f32>, next: vec2<f32>, r: f32) -> vec2<f32> {
    let ep = cur - prev;
    let ec = next - cur;
    // TL->TR->BR->BL tourne dans le sens horaire en y-bas, donc (e.y, -e.x) sort du quad.
    let np = vec2<f32>(ep.y, -ep.x) / max(length(ep), 1e-6);
    let nc = vec2<f32>(ec.y, -ec.x) / max(length(ec), 1e-6);
    return line_cross(np, dot(prev, np) - r, nc, dot(cur, nc) - r);
}

// (s, t, ok) du warp inverse du mode 8 pour une racine `t` donnee.
fn quad_st_for_root(t: f32, e: vec2<f32>, f: vec2<f32>, g: vec2<f32>, h: vec2<f32>) -> vec3<f32> {
    let denom_x = e.x + g.x * t;
    let denom_y = e.y + g.y * t;
    var s: f32;
    if abs(denom_x) > abs(denom_y) {
        s = (h.x - f.x * t) / denom_x;
    } else {
        s = (h.y - f.y * t) / denom_y;
    }
    // Tolerance de 2 % reprise telle quelle du MSL : sans elle une rangee de
    // pixels du bord tombe hors du quad par arrondi et l'ecran se liseree.
    var ok = 0.0;
    if s >= -0.02 && s <= 1.02 && t >= -0.02 && t <= 1.02 {
        ok = 1.0;
    }
    return vec3<f32>(s, t, ok);
}

// (s, t, ok) du point `P` dans le quad c00->c10->c11->c01 : le warp bilineaire INVERSE.
fn quad_inverse_bilinear(P: vec2<f32>, c00: vec2<f32>, c10: vec2<f32>, c11: vec2<f32>, c01: vec2<f32>) -> vec3<f32> {
    let e = c10 - c00;
    let f = c01 - c00;
    let g = c00 - c10 - c01 + c11;
    let h = P - c00;
    let k2 = g.x * f.y - g.y * f.x;
    let k1 = e.x * f.y - e.y * f.x + h.x * g.y - h.y * g.x;
    let k0 = h.x * e.y - h.y * e.x;
    // Quad quasi affine (rotation Y pure, p.ex.) : le terme quadratique s'evanouit
    // et resoudre la quadratique diviserait par ~0.
    if abs(k2) < 1e-5 * abs(k1) {
        var t = 0.0;
        if abs(k1) >= 1e-6 {
            t = -k0 / k1;
        }
        return quad_st_for_root(t, e, f, g, h);
    }
    let disc = k1 * k1 - 4.0 * k2 * k0;
    if disc < 0.0 {
        return vec3<f32>(0.0, 0.0, 0.0);
    }
    // Forme stable de la quadratique : additionner deux termes de meme signe evite
    // l'annulation catastrophique que `(-k1 +- sqrt(disc)) / (2 k2)` produit quand
    // `disc` approche `k1^2`. `sign()` de WGSL rend 0 en 0, la ou le ternaire MSL
    // rend +1 : d'ou le signe explicite.
    var sgn = 1.0;
    if k1 < 0.0 {
        sgn = -1.0;
    }
    let q = -0.5 * (k1 + sgn * sqrt(disc));
    let r0 = quad_st_for_root(q / k2, e, f, g, h);
    var t1 = q / k2;
    if abs(q) > 0.0 {
        t1 = k0 / q;
    }
    let r1 = quad_st_for_root(t1, e, f, g, h);
    if r0.z > 0.5 {
        return r0;
    }
    return r1;
}

@fragment
fn fs_main(i: VsOut) -> @location(0) vec4<f32> {
    var rgb: vec3<f32>;
    var alpha: f32;

    if layer.mode < 0.5 {
        // Mode 0 — vidéo NV12 + flou de mouvement par vélocité (§8), port 1:1 du
        // HLSL/MSL. Pour CE pixel de sortie, l'UV qu'il occupait à la frame
        // précédente se retrouve en le remappant par (dst_prev, src_prev) : on
        // floute le long de ce segment, ce qui capture la translation ET le zoom
        // du calque sans avoir à transporter un champ de vitesse.
        let taps = i32(layer.mb.x);
        // `taps` d'abord : un draw qui a oublié `dst_prev` le laisse à zéro, et
        // la division par `dst_prev.zw` produirait des UV infinis. Dégrader vers
        // le chemin net est le seul échec acceptable pour un effet cosmétique.
        if taps <= 1 || layer.dst_prev.z <= 0.0 || layer.dst_prev.w <= 0.0 {
            rgb = sample_yuv(i.uv);
        } else {
            let localp = (i.pout - layer.dst_prev.xy) / layer.dst_prev.zw;
            let uv_prev = layer.src_prev.xy + localp * (layer.src_prev.zw - layer.src_prev.xy);
            let duv = i.uv - uv_prev;
            if dot(duv, duv) < 1e-9 {
                rgb = sample_yuv(i.uv);
            } else {
                // Borne 16 en dur, identique au HLSL et au MSL : `taps` vient d'un
                // uniform et une boucle sans borne statique ne se déroule pas.
                // L'échelle de l'inspector s'arrête pile à 16 (1 + 15·blur), donc
                // c'est `taps` qui coupe, jamais la borne.
                var acc = vec3<f32>(0.0);
                let step = 1.0 / f32(taps - 1);
                for (var k: i32 = 0; k < 16; k = k + 1) {
                    if k >= taps { break; }
                    acc = acc + sample_yuv(uv_prev + duv * (f32(k) * step));
                }
                rgb = acc / f32(taps);
            }
        }
    } else if layer.mode < 1.5 {
        // Mode 1 — couleur pleine.
        rgb = layer.color.rgb;
    } else if layer.mode > 4.5 && layer.mode < 5.5 {
        // Mode 5 -- gradient lineaire : color (c0) -> src.rgb (c1) le long de
        // la direction fx.xy (sin, -cos de l'angle). Parite avec le HLSL/MSL.
        let t = clamp(dot(i.pout - vec2<f32>(0.5), layer.fx.xy) + 0.5, 0.0, 1.0);
        rgb = mix(layer.color.rgb, layer.src.rgb, t);
    } else if layer.mode > 10.5 && layer.mode < 11.5 {
        // Mode 11 : texte. texY est l'atlas R8 (couverture alpha au canal .r,
        // produit par text_cosmic::TextRasterizer), teinte par layer.color.
        // Sortie en alpha premultiplie, comme les autres modes.
        let cov = textureSample(texY, samp, i.uv).r;
        let a = layer.color.a * cov;
        return vec4<f32>(layer.color.rgb * a, a);
    } else if layer.mode > 8.5 && layer.mode < 9.5 {
        // Mode 9 -- annotation « figure » : une fleche. Parite EXACTE avec
        // `ArrowSvgs.tsx`, dont chaque direction est un trace de trois segments a
        // bouts ronds dans un viewBox 0..100 : une hampe et deux barbes. Trois
        // `sd_segment` et un `min` reproduisent la forme telle quelle, pas une
        // approximation. Les extremites arrivent deja converties en px locaux du
        // quad par `regions::arrow_local_geometry` (echelle uniforme centree,
        // comme le `preserveAspectRatio` par defaut du SVG), donc ce shader n'a
        // aucune geometrie a deviner.
        //
        // fx = hampe (a.xy, b.xy), src_prev = barbe 1, dst_prev = barbe 2 ;
        // mb.y = demi-epaisseur en px.
        var d = sd_segment(i.local, layer.fx.xy, layer.fx.zw);
        d = min(d, sd_segment(i.local, layer.src_prev.xy, layer.src_prev.zw));
        d = min(d, sd_segment(i.local, layer.dst_prev.xy, layer.dst_prev.zw));
        // Couverture sur ~1 px : le trait reste net sans crenelage, et une fleche
        // fine ne disparait pas quand la demi-epaisseur descend sous le pixel.
        let a = clamp(layer.mb.y - d + 0.5, 0.0, 1.0) * layer.color.a;
        return vec4<f32>(layer.color.rgb * a, a);
    } else if layer.mode > 9.5 && layer.mode < 10.5 {
        // Mode 10 -- annotation « flou » : masque la zone en reutilisant l'image
        // DEJA composee, qui arrive sur texY (recopie mipmappee du render target
        // -- on ne peut pas echantillonner la cible sur laquelle on dessine).
        // `i.pout` donne directement l'UV de sortie, donc aucun mapping a refaire.
        //
        // fx.x = 0 mosaique / 1 flou ; fx.y = taille de bloc px (mosaique) ou
        // rayon px (flou) ; fx.z = 0 rectangle / 1 ovale ; fx.w = 1 si teinte.
        let n = i.local / max(layer.quad_px, vec2<f32>(1e-6));
        var cov = 1.0;
        if layer.fx.z > 0.5 {
            // Ovale inscrit : distance au centre en unites de demi-axes, adoucie
            // sur ~1px.
            let dc = (n - vec2<f32>(0.5)) * 2.0;
            let r = length(dc);
            let aa = 2.0 / max(min(layer.quad_px.x, layer.quad_px.y), 1.0);
            cov = 1.0 - smoothstep(1.0 - aa, 1.0, r);
        }
        if cov <= 0.0 {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        var masked: vec3<f32>;
        if layer.fx.x > 0.5 {
            // Flou : on echantillonne un niveau de mip de l'image composee.
            // `log2(rayon)` donne le niveau dont un texel couvre a peu pres le
            // rayon demande, et le filtrage trilineaire lisse la transition entre
            // deux niveaux quand le rayon varie.
            //
            // Un noyau de quelques taps espaces du rayon ne floute PAS : il
            // superpose autant de copies decalees, ce qui se voit comme du texte
            // fantome. Atteindre un vrai lissage par taps demanderait un tap par
            // pixel de rayon ; la pyramide de mips donne le meme resultat a cout
            // constant, et c'est le GPU qui l'a construite.
            let lod = log2(max(layer.fx.y, 1.0));
            masked = textureSampleLevel(texY, samp, i.pout, lod).rgb;
        } else {
            // Mosaique : on quantifie l'UV sur une grille de `fx.y` px, alignee
            // sur le quad pour que les blocs ne rampent pas quand l'annotation
            // bouge.
            let px_uv = layer.dst.zw / max(layer.quad_px, vec2<f32>(1e-6));
            let block = max(layer.fx.y, 1.0) * px_uv;
            let origin = layer.dst.xy;
            let q = origin + (floor((i.pout - origin) / block) + vec2<f32>(0.5)) * block;
            // Niveau 0 explicite : l'UV quantifie est une marche d'escalier, donc
            // ses derivees explosent en bord de bloc et le choix automatique de
            // mip ramollirait justement les aretes qui font la mosaique.
            masked = textureSampleLevel(texY, samp, q, 0.0).rgb;
        }
        if layer.fx.w > 0.5 {
            // Teinte blanc/noir : la couleur choisie, melee a moitie, garde la
            // forme lisible sans effacer completement ce qu'il y a dessous.
            masked = mix(masked, layer.color.rgb, 0.5);
        }
        let a = cov * layer.color.a;
        return vec4<f32>(masked * a, a);
    } else if layer.mode > 6.5 && layer.mode < 7.5 {
        // Mode 7 -- sprite curseur (PNG RGBA, alpha droite) echantillonne sur
        // texY (comme le mode 11 y lie son atlas). `fx` = rect de clip "Clip to
        // canvas" [x,y,w,h] en sortie 0..1 (= s_dst si actif, sinon un rect
        // englobant : sans effet). Sortie en alpha premultiplie.
        if i.pout.x < layer.fx.x || i.pout.x > layer.fx.x + layer.fx.z
            || i.pout.y < layer.fx.y || i.pout.y > layer.fx.y + layer.fx.w {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        let s = textureSample(texY, samp, i.uv);
        let ca = s.a * layer.color.a;
        return vec4<f32>(s.rgb * ca, ca);
    } else if layer.mode > 5.5 && layer.mode < 6.5 {
        // Mode 6 -- fond image (wallpaper RGBA) cover-fit, echantillonne sur
        // texY. `src` porte le rect UV cover-fit (calcule cote Rust). Opaque :
        // le fond couvre tout le cadre.
        return vec4<f32>(textureSample(texY, samp, i.uv).rgb, 1.0);
    } else if layer.mode > 7.5 && layer.mode < 8.5 {
        // Mode 8 -- ecran tilte (rotation 3D des zoom regions). Le quad projete est
        // dessine dans sa BBOX (le VS ne sait tracer qu'un rect) et chaque fragment
        // remonte au (s,t) du plan par warp bilineaire inverse.
        //
        // PAS de test de clip sur `dst_prev` : en mode 8 `dst_prev.xy` porte
        // `plane_px`, la taille du plan en PIXELS (~1600), la ou `i.pout` vit dans
        // [0,1]. Un clip la-dessus serait vrai partout et n'afficherait rien.
        let r = quad_inverse_bilinear(
            i.local, layer.fx.xy, layer.fx.zw, layer.src_prev.xy, layer.src_prev.zw,
        );
        if r.z < 0.5 {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0); // hors du quad projete
        }
        // La coupe source s'applique ICI : `r` est une position DANS le plan (0..1),
        // pas une coordonnee de texture. Echantillonner `r` directement ignorerait le
        // crop utilisateur et le zoom.
        let uv = vec2<f32>(
            mix(layer.src.x, layer.src.z, clamp(r.x, 0.0, 1.0)),
            mix(layer.src.y, layer.src.w, clamp(r.y, 0.0, 1.0)),
        );
        // Coins arrondis DANS LE REPERE DU PLAN : le rayon reste constant le long du
        // bord, la ou un arrondi calcule dans la bbox s'etirerait avec la perspective.
        // Inconditionnel, rayon 0 compris -- `sd_round_rect` degenere en SDF de
        // rectangle et le feather de 1,5 px subsiste, ce qui fait lire une arete
        // inclinee COMME une arete plutot que comme un escalier.
        let plane_px = layer.dst_prev.xy;
        let p = vec2<f32>(r.x, r.y) * plane_px - plane_px * 0.5;
        let d = sd_round_rect(p, plane_px * 0.5, max(layer.radius_px, 0.0));
        let tilt_a = 1.0 - smoothstep(0.0, 1.5, d);
        // L'alpha est cette couverture, pas `color.a` : les draws du mode 8 laissent
        // `color` a zero, donc s'en servir rendrait un plan totalement transparent.
        return vec4<f32>(sample_yuv(uv) * tilt_a, tilt_a);
    } else if layer.mode > 11.5 && layer.mode < 12.5 {
        // Mode 12 -- ombre du quad projete. La penombre suit le QUADRILATERE, pas son
        // rect englobant : un rect droit derriere un ecran incline se lit comme une
        // seconde surface, pas comme son ombre.
        //
        // `fx`/`src_prev` portent les COINS (en px locaux a la bbox, comme `i.local`),
        // et le spread vit dans `mb.y` -- pas dans `fx.x` comme au mode 2.
        let tl = layer.fx.xy;
        let tr = layer.fx.zw;
        let br = layer.src_prev.xy;
        let bl = layer.src_prev.zw;
        // Coins arrondis du meme rayon que le plan : une ombre a coins vifs derriere un
        // ecran arrondi depasse en pointe a chaque coin, d'autant plus que le rayon monte.
        let r = max(layer.radius_px, 0.0);
        let v0 = inset_corner(bl, tl, tr, r);
        let v1 = inset_corner(tl, tr, br, r);
        let v2 = inset_corner(tr, br, bl, r);
        let v3 = inset_corner(br, bl, tl, r);
        let d = sd_convex_quad(i.local, v0, v1, v2, v3) - r;
        let spread = max(layer.mb.y, 1e-3);
        let a = layer.color.a * (1.0 - smoothstep(0.0, spread, d));
        return vec4<f32>(layer.color.rgb * a, a);
    } else if layer.mode > 12.5 && layer.mode < 13.5 {
        // Mode 13 -- sprite de curseur POSE sur l'ecran incline : ses quatre coins
        // ont traverse la meme projection que la video, et le fragment remonte a sa
        // position dans le sprite par le meme warp inverse que le mode 8.
        //
        // Le rect de clip « Clip to canvas » est ici dans `dst_prev` (en sortie
        // 0..1, [x,y,w,h]) et NON dans `fx` comme au mode 7 : `fx` porte les coins.
        if i.pout.x < layer.dst_prev.x || i.pout.x > layer.dst_prev.x + layer.dst_prev.z
            || i.pout.y < layer.dst_prev.y || i.pout.y > layer.dst_prev.y + layer.dst_prev.w {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        let r = quad_inverse_bilinear(
            i.local, layer.fx.xy, layer.fx.zw, layer.src_prev.xy, layer.src_prev.zw,
        );
        if r.z < 0.5 {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        // Sprite RGBA a alpha DROITE sur texY (comme le mode 7 y lie le sien) :
        // on premultiplie ici.
        let s = textureSample(texY, samp, clamp(vec2<f32>(r.x, r.y), vec2<f32>(0.0), vec2<f32>(1.0)));
        let ca = s.a * layer.color.a;
        return vec4<f32>(s.rgb * ca, ca);
    } else {
        // Mode 2 — ombre portée (SDF d'un quad arrondi élargi de `fx.x`).
        let spread = layer.fx.x;
        let halfsz = layer.quad_px * 0.5 - vec2<f32>(spread);
        let p = i.local - layer.quad_px * 0.5;
        let d = sd_round_rect(p, halfsz, layer.radius_px);
        let a = layer.color.a * (1.0 - smoothstep(0.0, spread, d));
        return vec4<f32>(layer.color.rgb * a, a);
    }

    alpha = layer.color.a;

    if layer.radius_px > 0.0 {
        // Feather ~1.5 px sur le bord du quad — parité exacte avec le HLSL
        // (`smoothstep(0.0, 1.5, d)`). Le shader HLSL inclut `quad_px` en px de
        // SORTIE ; on reproduit la même chose ici.
        let halfsz = layer.quad_px * 0.5;
        let p = i.local - layer.quad_px * 0.5;
        let d = sd_round_rect(p, halfsz, layer.radius_px);
        alpha *= 1.0 - smoothstep(0.0, 1.5, d);
    }

    return vec4<f32>(rgb * alpha, alpha); // alpha prémultiplié
}
