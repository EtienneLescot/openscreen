// Compositeur — un draw par calque (quad). NV12->RGB maison (E1), coins arrondis SDF (E2).
// Port MSL strict de `crates/compositor/src/shaders.hlsl`. Le shape du constant buffer,
// les noms d'entry points, et les contrats d'interface doivent rester identiques d'un
// backend à l'autre — c'est ce qui permet à `compositor.rs::new_inner` (Windows) et à
// `compositor_macos.rs::new_sized` (macOS) de partager le même ensemble d'effets.
//
// HLSL → MSL différences notables :
//   - `cbuffer X : register(b0)` → `constant X & [[buffer(0)]]`
//   - `Texture2D<float> T : register(tN)` → `texture2d<float, access::sample> T [[texture(N)]]`
//   - `SamplerState S : register(sN)` → `sampler S [[sampler(N)]]`
//   - `SV_VertexID` → `[[vertex_id]]`, `SV_Position` (sortie) → `[[position]]`
//   - `TEXCOORDn` → champ libre de struct (MSL n'a pas de qualificateur ; on les
//     regroupe dans des structs `VSOut`/`FSOut` comme en HLSL)
//   - `T.Sample(samp, uv)` → `T.sample(samp, uv)` (sampler sur l'instance, pas en arg)
//   - `SV_Target` (sortie) → `[[color(0)]]` (ou aucun qualificateur — Metal utilise
//     l'attachement 0 par défaut, qui est ce qu'on veut pour ces 9 entry points)
//   - `saturate(x)` → `clamp(x, 0.0, 1.0)` (Metal 2.0 ; `saturate` existe en 2.4+ mais
//     on reste portable)
//   - `[unroll]` → `[[unroll]]` (sur le `for`)
//
// DIFFÉRENCE STRUCTURELLE, et c'est la seule qui n'est pas cosmétique : HLSL déclare
// `cbuffer`, `Texture2D` et `SamplerState` en portée GLOBALE, MSL ne le permet pas.
// « 'texture' attribute only applies to parameters » et « program scope variable must
// reside in constant address space » : les ressources doivent être des PARAMÈTRES de
// chaque entry point, et les helpers qui les lisent doivent les recevoir en argument.
// Un port ligne-pour-ligne des globales HLSL ne compile donc pas du tout — d'où les
// signatures ci-dessous, qui sont la seule liberté prise avec le fichier d'origine.
// (Les `constexpr sampler` restent légaux en portée globale : ils sont immuables et
// résolus à la compilation.)
//
// IMPORTANT : ce fichier est inclus via `include_str!("shaders.metal")` côté Rust et
// compilé à l'exécution via `MTLDevice.makeLibrary(source:options:)`. Le test
// `compositor_macos::tests::every_shader_entry_point_compiles` le compile sur le device
// système au `cargo test`, pour qu'une faute de syntaxe MSL ne se découvre pas à
// l'ouverture de l'éditeur chez un utilisateur.

#include <metal_stdlib>
using namespace metal;

// =================================================================================
// Constant buffer — symétrique de `cbuffer Layer : register(b0)` côté HLSL.
// =================================================================================
//
// Le moteur côté CPU upload ce buffer via `setVertexBytes` (vertex stage) et
// `setFragmentBytes` (fragment stage) avant chaque draw — la copie est de 128 octets,
// ce qui est sous le seuil d'alignement 4K de Metal pour le mode « immediate ».

struct Layer
{
    float4 dst;       // x,y,w,h dans l'espace sortie 0..1 (origine haut-gauche)
    float4 src;       // u0,v0,u1,v1 dans l'espace source 0..1
    float2 quad_px;   // taille du quad en pixels (pour les SDF)
    float  radius_px; // rayon des coins arrondis en px (0 = aucun)
    float  mode;      // 0 = vidéo NV12, 1 = couleur pleine, 2 = ombre portée, ...
    float4 color;     // couleur pleine / teinte (ombre : rgb + opacité dans a)
    float4 fx;        // fx.x = spread ombre (px), fx.y,fx.z libres
    float4 src_prev;  // src à la frame précédente (flou de mouvement par vélocité)
    float4 dst_prev;  // dst à la frame précédente
    float4 mb;        // mb.x = nombre de taps de motion blur (1 = désactivé)
};

// `layer` est passé en `constant Layer& [[buffer(0)]]` à chaque entry point qui le lit
// (cf. la note « DIFFÉRENCE STRUCTURELLE » en tête de fichier). Côté Rust, il est lié par
// `set_vertex_bytes(0, …)` ET `set_fragment_bytes(0, …)` : `vs_main` le lit autant que
// `ps_main`.

// =================================================================================
// Vertex stage : quads à partir de `SV_VertexID`, fullscreen triangle pour fs pass.
// =================================================================================

struct VSOut
{
    float4 pos   [[position]];
    float2 uv    [[user(TEXCOORD0)]]; // coords d'échantillonnage source
    float2 local [[user(TEXCOORD1)]]; // coords pixel dans le quad (pour SDF)
    float2 pout  [[user(TEXCOORD2)]]; // position 0..1 sortie (pour la vélocité par pixel)
};

vertex VSOut vs_main(uint vid [[vertex_id]],
                     constant Layer &layer [[buffer(0)]])
{
    float2 c = float2(vid & 1, (vid >> 1) & 1); // strip: (0,0)(1,0)(0,1)(1,1)
    float2 p = layer.dst.xy + c * layer.dst.zw; // 0..1 sortie
    float2 ndc = float2(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0);
    VSOut o;
    o.pos = float4(ndc, 0.0, 1.0);
    o.uv = layer.src.xy + c * (layer.src.zw - layer.src.xy);
    o.local = c * layer.quad_px;
    o.pout = p;
    return o;
}

// =================================================================================
// Textures et samplers.
// =================================================================================

// `mip_filter::linear` n'est PAS décoratif : sans lui MSL retombe sur `mip_filter::none`,
// et `sample(..., level(lod))` rend le mip 0 quel que soit `lod`. Le masque « flou »
// d'annotation (mode 10) échantillonne la pyramide de mips de la copie du RT — sans ce
// filtre il ne floute rien, alors que la mosaïque, qui demande explicitement `level(0)`,
// marche par accident. Équivalent de `D3D11_FILTER_MIN_MAG_MIP_LINEAR` côté Windows.
constexpr sampler samp(filter::linear, mip_filter::linear, address::clamp_to_edge);
constexpr sampler sampNV(filter::linear, address::clamp_to_edge);

// Slots de texture, tenus par les paramètres des entry points :
//   ps_main      : 0 = texY (Y, R8), 1 = texUV (CbCr, RG8), 2 = texImg (RGBA)
//   ps_fs_*      : 0 = rgbTex (RGBA)

// =================================================================================
// Helpers : conversions couleur, primitives SDF.
// =================================================================================

// BT.709 limited -> RGB (§7 E1), matrice en dur, range mesuré en S1.
inline float3 yuv709_limited(float y, float2 cbcr)
{
    float Yf = (y * 255.0 - 16.0) / 219.0;
    float Cb = (cbcr.x * 255.0 - 128.0) / 224.0;
    float Cr = (cbcr.y * 255.0 - 128.0) / 224.0;
    float3 rgb;
    rgb.r = Yf + 1.5748 * Cr;
    rgb.g = Yf - 0.1873 * Cb - 0.4681 * Cr;
    rgb.b = Yf + 1.8556 * Cb;
    return clamp(rgb, 0.0, 1.0);
}

// `texture2d<float>::sample` rend TOUJOURS un `float4` en MSL, là où le HLSL
// `Texture2D<float>` rend un scalaire : d'où les `.r` / `.rg` que le port d'origine
// n'avait pas (et qui ne compilaient pas).
inline float3 sample_yuv(float2 uv,
                         texture2d<float, access::sample> texY,
                         texture2d<float, access::sample> texUV)
{
    float y = texY.sample(samp, uv).r;
    float2 cbcr = texUV.sample(samp, uv).rg;
    return yuv709_limited(y, cbcr);
}

// SDF segment à bouts ronds — la primitive des flèches d'annotation.
inline float sd_segment(float2 p, float2 a, float2 b)
{
    float2 pa = p - a;
    float2 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
}

// SDF rectangle à coins arrondis (§7 E2) : <0 dedans.
inline float sd_round_rect(float2 p, float2 halfsz, float r)
{
    float2 q = abs(p) - halfsz + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Intersection de deux droites données par (normale, offset) : n·x = d. Cramer.
inline float2 line_cross(float2 n1, float d1, float2 n2, float d2)
{
    float det = n1.x * n2.y - n1.y * n2.x;
    if (abs(det) < 1e-6) return float2(0.0, 0.0);
    return float2(d1 * n2.y - d2 * n1.y, d2 * n1.x - d1 * n2.x) / det;
}

// Distance signée EXACTE à un quadrilatère convexe (<0 dedans).
inline float sd_convex_quad(float2 p, float2 v0, float2 v1, float2 v2, float2 v3)
{
    float2 v0n = v0, v1n = v1, v2n = v2, v3n = v3, v4n = v0;
    float inside = -1e9;
    float border = 1e9;
    for (int k = 0; k < 4; k++)
    {
        float2 a;
        float2 e_next;
        if (k == 0) { a = v0n; e_next = v1n; }
        else if (k == 1) { a = v1n; e_next = v2n; }
        else if (k == 2) { a = v2n; e_next = v3n; }
        else { a = v3n; e_next = v4n; }
        float2 e = e_next - a;
        float2 n = float2(e.y, -e.x) / max(length(e), 1e-6);
        inside = max(inside, dot(p - a, n));
        border = min(border, sd_segment(p, a, e_next));
    }
    return (inside < 0.0) ? -border : border;
}

// (s, t, ok) du warp inverse du mode 8 pour une racine `t` donnée.
inline float3 quad_st_for_root(float t, float2 e, float2 f, float2 g, float2 h)
{
    float denomX = e.x + g.x * t;
    float denomY = e.y + g.y * t;
    float s = (abs(denomX) > abs(denomY)) ? (h.x - f.x * t) / denomX : (h.y - f.y * t) / denomY;
    float ok = (s >= -0.02 && s <= 1.02 && t >= -0.02 && t <= 1.02) ? 1.0 : 0.0;
    return float3(s, t, ok);
}

// (s, t, ok) du point `P` dans le quad c00->c10->c11->c01 : le warp bilinéaire INVERSE.
inline float3 quad_inverse_bilinear(float2 P, float2 c00, float2 c10, float2 c11, float2 c01)
{
    float2 e = c10 - c00;
    float2 f = c01 - c00;
    float2 g = c00 - c10 - c01 + c11;
    float2 h = P - c00;
    float k2 = g.x * f.y - g.y * f.x;
    float k1 = e.x * f.y - e.y * f.x + h.x * g.y - h.y * g.x;
    float k0 = h.x * e.y - h.y * e.x;
    if (abs(k2) < 1e-5 * abs(k1))
    {
        float t = (abs(k1) < 1e-6) ? 0.0 : -k0 / k1;
        return quad_st_for_root(t, e, f, g, h);
    }
    float disc = k1 * k1 - 4.0 * k2 * k0;
    if (disc < 0.0) return float3(0.0, 0.0, 0.0);
    float q = -0.5 * (k1 + (k1 >= 0.0 ? 1.0 : -1.0) * sqrt(disc));
    float3 r0 = quad_st_for_root(q / k2, e, f, g, h);
    float3 r1 = quad_st_for_root(abs(q) > 0.0 ? k0 / q : q / k2, e, f, g, h);
    return (r0.z > 0.5) ? r0 : r1;
}

// =================================================================================
// Pixel shader principal : un seul `ps_main` qui gère 14 modes via `layer.mode`.
// Identique à `ps_main` côté HLSL ligne pour ligne (à la syntaxe MSL près).
// =================================================================================

fragment float4 ps_main(VSOut i [[stage_in]],
                        constant Layer &layer [[buffer(0)]],
                        texture2d<float, access::sample> texY [[texture(0)]],
                        texture2d<float, access::sample> texUV [[texture(1)]],
                        texture2d<float, access::sample> texImg [[texture(2)]])
{
    // mode 13 : SPRITE DE CURSEUR posé sur l'écran incliné. Cf. commentaires HLSL.
    if (layer.mode > 12.5)
    {
        if (i.pout.x < layer.dst_prev.x || i.pout.x > layer.dst_prev.x + layer.dst_prev.z ||
            i.pout.y < layer.dst_prev.y || i.pout.y > layer.dst_prev.y + layer.dst_prev.w)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        float3 r = quad_inverse_bilinear(i.local, layer.fx.xy, layer.fx.zw,
                                          layer.src_prev.xy, layer.src_prev.zw);
        if (r.z < 0.5)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        float4 s = texImg.sample(samp, clamp(float2(r.x, r.y), 0.0, 1.0));
        float a = s.a * layer.color.a;
        return float4(s.rgb * a, a);
    }

    // mode 11 : texte en alpha DÉJÀ prémultiplié (CoreText/Direct2D rendent ainsi) — on
    // module juste l'opacité globale.
    //
    // Le commentaire du port disait « ne PAS re-multiplier » et le code faisait exactement
    // ça : `s.rgb * (s.a * color.a)`, soit un alpha appliqué deux fois. Le texte sortait
    // trop sombre sur ses bords adoucis et disparaissait sur les fines.
    if (layer.mode > 10.5 && layer.mode < 11.5)
    {
        return texImg.sample(samp, i.uv) * layer.color.a;
    }

    // mode 12 : ombre du quad projeté. Pénombre douce autour du quad tilté.
    if (layer.mode > 11.5)
    {
        // Le port lisait `spread` dans `fx.x`, recentrait `i.local` sur `quad_px * 0.5`, et
        // remplaçait l'inset de rayon par un simple `+ spread`. Trois écarts : `fx` porte les
        // COINS (pas le spread, qui vit dans `mb.y`), `i.local` est déjà dans le repère de la
        // bbox, et sans l'inset l'ombre n'a aucun coin arrondi. Signature du dernier :
        // `line_cross` était défini et jamais appelé nulle part dans le fichier.
        float2 quad[5] = { layer.fx.xy, layer.fx.zw, layer.src_prev.xy, layer.src_prev.zw, layer.fx.xy };
        // Coins arrondis du même rayon que le plan. Une ombre à coins vifs derrière un écran
        // arrondi dépasse en pointe à chaque coin, d'autant plus que le rayon monte.
        float r = max(layer.radius_px, 0.0);
        float2 v[4];
        for (int k = 0; k < 4; k++)
        {
            // TL→TR→BR→BL tourne dans le sens horaire en y-bas, donc (e.y, -e.x) sort du quad.
            // Division par la longueur plutôt que `normalize` : une arête dégénérée donnerait
            // un NaN qui effacerait l'ombre entière.
            float2 ep = quad[k] - quad[(k + 3) & 3];
            float2 ec = quad[k + 1] - quad[k];
            float2 np = float2(ep.y, -ep.x) / max(length(ep), 1e-6);
            float2 nc = float2(ec.y, -ec.x) / max(length(ec), 1e-6);
            v[k] = line_cross(np, dot(quad[(k + 3) & 3], np) - r, nc, dot(quad[k], nc) - r);
        }
        float d = sd_convex_quad(i.local, v[0], v[1], v[2], v[3]) - r;
        float spread = max(layer.mb.y, 1e-3);
        float a = layer.color.a * (1.0 - smoothstep(0.0, spread, d));
        return float4(layer.color.rgb * a, a);
    }

    // mode 8 : écran tilté (zoom regions "rotation"). Warp bilinéaire inverse.
    if (layer.mode > 7.5 && layer.mode < 8.5)
    {
        // PAS de test de clip sur `dst_prev` ici — le port en avait copié un depuis le
        // mode 13. En mode 8 `dst_prev.xy` porte `plane_px`, la taille du plan en PIXELS
        // (~1600), comparée à `i.pout` qui vit dans [0,1] : la condition était vraie pour
        // tout pixel et la branche rendait du transparent partout. Le tilt ne dessinait rien.
        float3 r = quad_inverse_bilinear(i.local, layer.fx.xy, layer.fx.zw,
                                          layer.src_prev.xy, layer.src_prev.zw);
        if (r.z < 0.5)
        {
            return float4(0.0, 0.0, 0.0, 0.0); // hors du quad projeté
        }
        // La coupe source s'applique ICI : `r` est une position DANS le plan (0..1), pas
        // une coordonnée de texture. Le port échantillonnait `r` directement, ignorant le
        // crop et le zoom.
        float2 uv = float2(mix(layer.src.x, layer.src.z, clamp(r.x, 0.0, 1.0)),
                           mix(layer.src.y, layer.src.w, clamp(r.y, 0.0, 1.0)));
        // Coins arrondis DANS LE REPÈRE DU PLAN : le rayon reste constant le long du bord,
        // là où un arrondi calculé dans la bbox s'étirerait avec la perspective.
        // Inconditionnel, rayon 0 compris — `sd_round_rect` dégénère en SDF de rectangle et
        // le feather de 1,5 px subsiste, ce qui fait lire une arête inclinée COMME une arête
        // plutôt que comme une troncature en marches d'escalier.
        float2 plane_px = layer.dst_prev.xy;
        float2 p = float2(r.x, r.y) * plane_px - plane_px * 0.5;
        float d = sd_round_rect(p, plane_px * 0.5, max(layer.radius_px, 0.0));
        float tilt_a = 1.0 - smoothstep(0.0, 1.5, d);
        // L'alpha est cette couverture, pas `color.a` : les draws du mode 8 laissent `color`
        // à zéro, donc le port rendait de toute façon un plan totalement transparent.
        return float4(sample_yuv(uv, texY, texUV) * tilt_a, tilt_a);
    }

    // mode 7 : sprite curseur thème (PNG alpha droite). Prémultiplie ici, comme partout
    // ailleurs. `fx` = rect de clip « Clip to canvas » en espace sortie 0..1 [x,y,w,h]
    // (= s_dst quand actif, sinon un rect englobant tout, donc sans effet).
    //
    // Le port avait omis ce test : `plan_cursor` calcule bien le rect et le draw le passe
    // dans `fx`, mais le shader l'ignorait — `cursor.clipToBounds` était inerte sur macOS.
    if (layer.mode > 6.5 && layer.mode < 7.5)
    {
        if (i.pout.x < layer.fx.x || i.pout.x > layer.fx.x + layer.fx.z ||
            i.pout.y < layer.fx.y || i.pout.y > layer.fx.y + layer.fx.w)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        float4 s = texImg.sample(samp, i.uv);
        float a = s.a * layer.color.a;
        return float4(s.rgb * a, a);
    }

    // mode 6 : wallpaper image RGBA (cover-fit). src = rect uv déjà calculé (crop de
    // recouvrement), i.uv l'interpole. OPAQUE — comme le HLSL.
    //
    // Le port lisait `layer.color.a` ici. `LayerCB::default()` met `color` à zéro, donc
    // l'alpha valait 0 et le fond image était rigoureusement invisible : un fond noir,
    // qu'on lit comme « le compositeur ne dessine pas le wallpaper » plutôt que comme
    // « le wallpaper est dessiné avec alpha 0 ».
    if (layer.mode > 5.5 && layer.mode < 6.5)
    {
        return float4(texImg.sample(samp, i.uv).rgb, 1.0);
    }

    // mode 5 : gradient linéaire 2 stops (parité web wallpaper dégradé). color = stop0,
    // src.xyz = stop1, fx.xy = direction unitaire (espace sortie, y vers le bas). t est
    // normalisé coin-à-coin (dénominateur = |dx|+|dy|) pour couvrir toute la diagonale.
    //
    // Le port avait remplacé tout ce calcul par une couleur plate : un dégradé s'affichait
    // comme son premier stop, uniformément.
    if (layer.mode > 4.5 && layer.mode < 5.5)
    {
        float2 dir = layer.fx.xy;
        float denom = max(abs(dir.x) + abs(dir.y), 1e-4);
        float t = clamp(0.5 + dot(i.pout - 0.5, dir) / denom, 0.0, 1.0);
        float3 g = mix(layer.color.rgb, layer.src.xyz, t);
        return float4(g, 1.0); // opaque, prémultiplié (a=1)
    }

    // mode 4 : curseur dessiné (dot + ring SDF).
    if (layer.mode > 3.5 && layer.mode < 4.5)
    {
        float2 p = i.local - layer.quad_px * 0.5;
        float R = min(layer.quad_px.x, layer.quad_px.y) * 0.5;
        float r = length(p);
        float aa = 1.5;
        float dot_r = R * 0.34;
        float ring_r = R * 0.72;
        float ring_w = R * 0.09;
        float ddot = 1.0 - clamp((r - (dot_r - aa)) / (2.0 * aa), 0.0, 1.0);
        float ring = clamp((r - (ring_r - ring_w - aa)) / aa, 0.0, 1.0)
                   * (1.0 - clamp((r - (ring_r + ring_w)) / aa, 0.0, 1.0));
        float halo = (1.0 - clamp((r - (dot_r + aa)) / 2.5, 0.0, 1.0)) * (1.0 - ddot);
        float a = clamp(ddot + ring, 0.0, 1.0) * layer.color.a;
        float3 rgb = layer.color.rgb * (ddot + ring);
        a = clamp(a + halo * 0.35 * layer.color.a, 0.0, 1.0);
        return float4(rgb * a, a);
    }

    // mode 9 : annotation « figure » — une flèche. Parité EXACTE avec `ArrowSvgs.tsx`, dont
    // chaque direction est un tracé de trois segments à bouts ronds : une hampe et deux
    // barbes. Trois `sd_segment` et un `min` reproduisent la forme telle quelle.
    // fx = hampe, src_prev = barbe 1, dst_prev = barbe 2 ; mb.y = demi-épaisseur px.
    //
    // Le port avait INVENTÉ une forme : un seul segment dérivé de `quad_px`, avec
    // `radius_px` en épaisseur. Ce n'était pas une approximation de la flèche, c'était une
    // autre figure — et elle ignorait la géométrie que `regions::arrow_local_geometry`
    // calcule et uploade.
    if (layer.mode > 8.5 && layer.mode < 9.5)
    {
        float d = sd_segment(i.local, layer.fx.xy, layer.fx.zw);
        d = min(d, sd_segment(i.local, layer.src_prev.xy, layer.src_prev.zw));
        d = min(d, sd_segment(i.local, layer.dst_prev.xy, layer.dst_prev.zw));
        // Couverture sur ~1 px : le trait reste net sans crénelage, et une flèche fine ne
        // disparaît pas quand la demi-épaisseur descend sous le pixel.
        float a = clamp(layer.mb.y - d + 0.5, 0.0, 1.0) * layer.color.a;
        return float4(layer.color.rgb * a, a);
    }

    // mode 10 : annotation « flou » — masque la zone en réutilisant l'image DÉJÀ composée,
    // qui arrive dans `texImg` (recopie mipmappée du render target : on ne peut pas
    // échantillonner la cible sur laquelle on dessine). `i.pout` donne directement l'UV de
    // sortie. fx.x = 0 mosaïque / 1 flou ; fx.y = taille de bloc px ou rayon px ;
    // fx.z = 0 rectangle / 1 ovale ; fx.w = 1 si le masque doit être teinté.
    //
    // Le port se contentait de recopier `texImg` : ni forme, ni flou, ni mosaïque, ni teinte.
    if (layer.mode > 9.5 && layer.mode < 10.5)
    {
        float2 n = i.local / max(layer.quad_px, float2(1e-6));
        float cov = 1.0;
        if (layer.fx.z > 0.5)
        {
            // Ovale inscrit : distance au centre en unités de demi-axes, adoucie sur ~1px.
            float2 dd = (n - 0.5) * 2.0;
            float r = length(dd);
            float aa = 2.0 / max(min(layer.quad_px.x, layer.quad_px.y), 1.0);
            cov = 1.0 - smoothstep(1.0 - aa, 1.0, r);
        }
        if (cov <= 0.0) return float4(0.0, 0.0, 0.0, 0.0);

        float3 rgb;
        if (layer.fx.x > 0.5)
        {
            // Flou : un niveau de mip de l'image composée. `log2(rayon)` donne le niveau dont
            // un texel couvre à peu près le rayon demandé. Un noyau de quelques taps espacés
            // du rayon ne floute PAS, il superpose des copies décalées — du texte fantôme.
            float lod = log2(max(layer.fx.y, 1.0));
            rgb = texImg.sample(samp, i.pout, level(lod)).rgb;
        }
        else
        {
            // Mosaïque : UV quantifié sur une grille de `fx.y` px, alignée sur le quad pour
            // que les blocs ne rampent pas quand l'annotation bouge.
            float2 px_uv = layer.dst.zw / max(layer.quad_px, float2(1e-6));
            float2 block = max(layer.fx.y, 1.0) * px_uv;
            float2 origin = layer.dst.xy;
            float2 q = origin + (floor((i.pout - origin) / block) + 0.5) * block;
            // Niveau 0 explicite : l'UV quantifié est une marche d'escalier, ses dérivées
            // explosent en bord de bloc et le choix automatique de mip ramollirait justement
            // les arêtes qui font la mosaïque.
            rgb = texImg.sample(samp, q, level(0.0)).rgb;
        }

        if (layer.fx.w > 0.5)
        {
            rgb = mix(rgb, layer.color.rgb, 0.5);
        }
        float a = cov * layer.color.a;
        return float4(rgb * a, a);
    }

    // mode 2 : ombre portée (§7 E4). Pénombre douce dérivée de la SDF du quad source,
    // qui est inséré à l'intérieur du quad d'ombre (élargi de `spread` de chaque côté).
    if (layer.mode > 1.5 && layer.mode < 2.5)
    {
        float spread = layer.fx.x;
        float2 halfsz = layer.quad_px * 0.5 - spread;
        float2 p = i.local - layer.quad_px * 0.5;
        float d = sd_round_rect(p, halfsz, layer.radius_px);
        float a = layer.color.a * (1.0 - smoothstep(0.0, spread, d));
        return float4(layer.color.rgb * a, a);
    }

    float3 rgb;
    if (layer.mode < 0.5)
    {
        // flou de mouvement par vélocité (§8)
        float2 uv_now = i.uv;
        float2 localp = (i.pout - layer.dst_prev.xy) / layer.dst_prev.zw;
        float2 uv_prev = layer.src_prev.xy + localp * (layer.src_prev.zw - layer.src_prev.xy);
        float2 duv = uv_now - uv_prev;
        int taps = int(layer.mb.x);
        if (taps <= 1 || dot(duv, duv) < 1e-9)
        {
            rgb = sample_yuv(uv_now, texY, texUV);
        }
        else
        {
            float3 acc = float3(0.0);
            for (int k = 0; k < 16; k++)
            {
                if (k >= taps) break;
                float t = float(k) / float(taps - 1);
                acc += sample_yuv(uv_prev + duv * t, texY, texUV);
            }
            rgb = acc / float(taps);
        }
    }
    else
    {
        rgb = layer.color.rgb;
    }

    float alpha = layer.color.a;
    if (layer.radius_px > 0.0)
    {
        float2 halfsz = layer.quad_px * 0.5;
        float2 p = i.local - layer.quad_px * 0.5;
        float d = sd_round_rect(p, halfsz, layer.radius_px);
        alpha *= 1.0 - smoothstep(0.0, 1.5, d);
    }
    return float4(rgb * alpha, alpha);
}

// =================================================================================
// Fullscreen pass : RGB -> NV12. Mêmes shaders que la passe équivalente HLSL.
// =================================================================================

struct FSOut
{
    float4 pos [[position]];
    float2 uv  [[user(TEXCOORD0)]];
};

vertex FSOut vs_fs(uint vid [[vertex_id]])
{
    FSOut o;
    o.uv = float2((vid << 1) & 2, vid & 2);
    o.pos = float4(o.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return o;
}

inline float rgb2y(float3 c)  { return (16.0 + 219.0 * (0.2126*c.r + 0.7152*c.g + 0.0722*c.b)) / 255.0; }
inline float2 rgb2uv(float3 c)
{
    float yp = 0.2126*c.r + 0.7152*c.g + 0.0722*c.b;
    float cb = (c.b - yp) / 1.8556;
    float cr = (c.r - yp) / 1.5748;
    return float2(128.0 + 224.0 * cb, 128.0 + 224.0 * cr) / 255.0;
}

fragment float ps_y(FSOut i [[stage_in]],
                    texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    return rgb2y(rgbTex.sample(sampNV, i.uv).rgb);
}

fragment float2 ps_uv(FSOut i [[stage_in]],
                      texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    return rgb2uv(rgbTex.sample(sampNV, i.uv).rgb);
}

// =================================================================================
// Flou gaussien séparable (§7 E3) — shader conservé pour référence, le port actif
// utilise `ps_kawase_down/up` (cf. commit « Kawase » plus loin si on revient).
// =================================================================================

// Une variable de portée programme doit vivre dans `constant` en MSL.
constant int BLUR_R = 24;

fragment float4 ps_blur(FSOut i [[stage_in]],
                        constant Layer &layer [[buffer(0)]],
                        texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    float sigma = max(layer.fx.x, 0.001);
    float2 step = layer.fx.y * layer.fx.zw;
    float4 acc = float4(0.0);
    float wsum = 0.0;
    for (int k = -BLUR_R; k <= BLUR_R; k++)
    {
        float w = exp(-0.5 * float(k * k) / (sigma * sigma));
        acc += rgbTex.sample(sampNV, i.uv + float(k) * step) * w;
        wsum += w;
    }
    return acc / wsum;
}

fragment float4 ps_tex(FSOut i [[stage_in]],
                       texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    return rgbTex.sample(sampNV, i.uv);
}

// =================================================================================
// Dual-Kawase (fond flouté rapide).
// =================================================================================

fragment float4 ps_kawase_down(FSOut i [[stage_in]],
                               constant Layer &layer [[buffer(0)]],
                               texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    float2 hp = layer.fx.xy * 0.5 * layer.fx.z;
    float2 uv = i.uv;
    float4 s = rgbTex.sample(sampNV, uv) * 4.0;
    s += rgbTex.sample(sampNV, uv - hp);
    s += rgbTex.sample(sampNV, uv + hp);
    s += rgbTex.sample(sampNV, uv + float2(hp.x, -hp.y));
    s += rgbTex.sample(sampNV, uv - float2(hp.x, -hp.y));
    return s / 8.0;
}

// Poids 1,2,1,2,1,2,1,2 — somme 12, d'où le `/ 12.0`. Le port avait doublé les deux taps
// purement verticaux : somme 14 divisée par 12, soit +16,7 % de luminosité PAR PASSE et un
// biais vertical. Trois passes UP → un fond flouté 1,59× trop clair et étiré.
fragment float4 ps_kawase_up(FSOut i [[stage_in]],
                             constant Layer &layer [[buffer(0)]],
                             texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    float2 hp = layer.fx.xy * 0.5 * layer.fx.z;
    float2 uv = i.uv;
    float4 s = rgbTex.sample(sampNV, uv + float2(-hp.x * 2.0, 0.0));
    s += rgbTex.sample(sampNV, uv + float2(-hp.x, hp.y)) * 2.0;
    s += rgbTex.sample(sampNV, uv + float2(0.0, hp.y * 2.0));
    s += rgbTex.sample(sampNV, uv + float2(hp.x, hp.y)) * 2.0;
    s += rgbTex.sample(sampNV, uv + float2(hp.x * 2.0, 0.0));
    s += rgbTex.sample(sampNV, uv + float2(hp.x, -hp.y)) * 2.0;
    s += rgbTex.sample(sampNV, uv + float2(0.0, -hp.y * 2.0));
    s += rgbTex.sample(sampNV, uv + float2(-hp.x, -hp.y)) * 2.0;
    return s / 12.0;
}