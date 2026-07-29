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

constexpr sampler samp(filter::linear, address::clamp_to_edge);
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

    // mode 11 : texte D2D en alpha prémultiplié — ne PAS re-multiplier.
    if (layer.mode > 10.5 && layer.mode < 11.5)
    {
        float4 s = texImg.sample(samp, i.uv);
        float a = s.a * layer.color.a;
        return float4(s.rgb * a, a);
    }

    // mode 12 : ombre du quad projeté. Pénombre douce autour du quad tilté.
    if (layer.mode > 11.5)
    {
        float spread = layer.fx.x;
        float2 halfsz = layer.quad_px * 0.5 - spread;
        float2 p = i.local - layer.quad_px * 0.5;
        float d = sd_convex_quad(p,
                                  layer.fx.xy,
                                  layer.fx.zw,
                                  layer.src_prev.xy,
                                  layer.src_prev.zw) + spread;
        float a = layer.color.a * (1.0 - clamp((d - spread) / max(spread, 1.0), 0.0, 1.0));
        return float4(layer.color.rgb * a, a);
    }

    // mode 8 : écran tilté (zoom regions "rotation"). Warp bilinéaire inverse.
    if (layer.mode > 7.5 && layer.mode < 8.5)
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
        float3 rgb = sample_yuv(clamp(float2(r.x, r.y), 0.0, 1.0), texY, texUV);
        return float4(rgb * layer.color.a, layer.color.a);
    }

    // mode 7 : sprite de curseur en alpha DROIT (multiplication finale).
    if (layer.mode > 6.5 && layer.mode < 7.5)
    {
        float4 s = texImg.sample(samp, i.uv);
        float a = s.a * layer.color.a;
        return float4(s.rgb * a, a);
    }

    // mode 6 : wallpaper image (fond non NV12).
    if (layer.mode > 5.5 && layer.mode < 6.5)
    {
        float4 s = texImg.sample(samp, i.uv);
        float a = layer.color.a;
        return float4(s.rgb * a, a);
    }

    // mode 5 : gradient (texImg porte le gradient en mode 6 ; en mode 5 c'est `color`).
    if (layer.mode > 4.5 && layer.mode < 5.5)
    {
        return float4(layer.color.rgb * layer.color.a, layer.color.a);
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

    // mode 9 : flèche d'annotation (3 segments round-cap, SDF du quad = SDF triangle?).
    if (layer.mode > 8.5 && layer.mode < 9.5)
    {
        float2 p = i.local - layer.quad_px * 0.5;
        float w = clamp(layer.radius_px, 0.0, layer.quad_px.y * 0.5);
        float2 a0 = float2(0.0, -layer.quad_px.y * 0.5 + w);
        float2 a1 = float2(layer.quad_px.x * 0.5 - w, layer.quad_px.y * 0.5 - w);
        float d = sd_segment(p, a0, a1) - w;
        float a = layer.color.a * (1.0 - clamp(d * 1.5, 0.0, 1.0));
        return float4(layer.color.rgb * a, a);
    }

    // mode 10 : annotation blur / pixelate (on rend dans `ann_copy` qui porte la
    // pyramide de mi-blur, puis on ré-échantillonne ici).
    if (layer.mode > 9.5 && layer.mode < 10.5)
    {
        float4 s = texImg.sample(samp, i.uv);
        return float4(s.rgb, 1.0) * layer.color.a;
    }

    // mode 2 : ombre portée (§7 E4). Pénombre douce dérivée de la SDF du quad source,
    // qui est inséré à l'intérieur du quad d'ombre (élargi de `spread` de chaque côté).
    if (layer.mode > 1.5 && layer.mode < 2.5)
    {
        float spread = layer.fx.x;
        float2 halfsz = layer.quad_px * 0.5 - spread;
        float2 p = i.local - layer.quad_px * 0.5;
        float d = sd_round_rect(p, halfsz, layer.radius_px);
        float a = layer.color.a * (1.0 - clamp(d / max(spread, 1.0), 0.0, 1.0));
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
        alpha *= 1.0 - clamp(d * 1.5, 0.0, 1.0);
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

fragment float4 ps_kawase_up(FSOut i [[stage_in]],
                             constant Layer &layer [[buffer(0)]],
                             texture2d<float, access::sample> rgbTex [[texture(0)]])
{
    float2 hp = layer.fx.xy * 0.5 * layer.fx.z;
    float2 uv = i.uv;
    float4 s = rgbTex.sample(sampNV, uv + float2(-hp.x * 2.0, 0.0));
    s += rgbTex.sample(sampNV, uv + float2(-hp.x, hp.y)) * 2.0;
    s += rgbTex.sample(sampNV, uv + float2(0.0, hp.y * 2.0)) * 2.0;
    s += rgbTex.sample(sampNV, uv + float2(hp.x, hp.y)) * 2.0;
    s += rgbTex.sample(sampNV, uv + float2(hp.x * 2.0, 0.0));
    s += rgbTex.sample(sampNV, uv + float2(hp.x, -hp.y)) * 2.0;
    s += rgbTex.sample(sampNV, uv + float2(0.0, -hp.y * 2.0)) * 2.0;
    s += rgbTex.sample(sampNV, uv + float2(-hp.x, -hp.y)) * 2.0;
    return s / 12.0;
}