// Compositeur — un draw par calque (quad). NV12->RGB maison (E1), coins arrondis SDF (E2).
// Tout écrit depuis les maths (§7), rien repris de l'ancien paradigme.

cbuffer Layer : register(b0)
{
    float4 dst;       // x,y,w,h dans l'espace sortie 0..1 (origine haut-gauche)
    float4 src;       // u0,v0,u1,v1 dans l'espace source 0..1
    float2 quad_px;   // taille du quad en pixels (pour les SDF)
    float  radius_px; // rayon des coins arrondis en px (0 = aucun)
    float  mode;      // 0 = vidéo NV12, 1 = couleur pleine, 2 = ombre portée, 4 = curseur
    float4 color;     // couleur pleine / teinte (ombre : rgb + opacité dans a)
    float4 fx;        // fx.x = spread ombre (px), fx.y,fx.z libres
    float4 src_prev;  // src à la frame précédente (flou de mouvement par vélocité)
    float4 dst_prev;  // dst à la frame précédente
    float4 mb;        // mb.x = nombre de taps de motion blur (1 = désactivé)
};

struct VSOut
{
    float4 pos   : SV_Position;
    float2 uv    : TEXCOORD0; // coords d'échantillonnage source
    float2 local : TEXCOORD1; // coords pixel dans le quad (pour SDF)
    float2 pout  : TEXCOORD2; // position 0..1 sortie (pour la vélocité par pixel)
};

VSOut vs_main(uint vid : SV_VertexID)
{
    float2 c = float2(vid & 1, (vid >> 1) & 1); // strip: (0,0)(1,0)(0,1)(1,1)
    float2 p = dst.xy + c * dst.zw;             // 0..1 sortie
    float2 ndc = float2(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0);
    VSOut o;
    o.pos = float4(ndc, 0.0, 1.0);
    o.uv = src.xy + c * (src.zw - src.xy);
    o.local = c * quad_px;
    o.pout = p;
    return o;
}

Texture2D<float>  texY  : register(t0);
Texture2D<float2> texUV : register(t1);
SamplerState samp : register(s0);

// BT.709 limited -> RGB (§7 E1), matrice en dur, range mesuré en S1.
float3 yuv709_limited(float y, float2 cbcr)
{
    float Yf = (y * 255.0 - 16.0) / 219.0;
    float Cb = (cbcr.x * 255.0 - 128.0) / 224.0;
    float Cr = (cbcr.y * 255.0 - 128.0) / 224.0;
    float3 rgb;
    rgb.r = Yf + 1.5748 * Cr;
    rgb.g = Yf - 0.1873 * Cb - 0.4681 * Cr;
    rgb.b = Yf + 1.8556 * Cb;
    return saturate(rgb);
}

float3 sample_yuv(float2 uv)
{
    float y = texY.Sample(samp, uv);
    float2 cbcr = texUV.Sample(samp, uv);
    return yuv709_limited(y, cbcr);
}

// SDF rectangle à coins arrondis (§7 E2) : <0 dedans.
float sd_round_rect(float2 p, float2 halfsz, float r)
{
    float2 q = abs(p) - halfsz + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float4 ps_main(VSOut i) : SV_Target
{
    // mode 4 : curseur custom (dot + ring, dessiné depuis les maths). color = teinte.
    if (mode > 3.5)
    {
        float2 p = i.local - quad_px * 0.5;
        float r = length(p);
        float R = quad_px.x * 0.5;
        float aa = 1.5;
        float dot_r = R * 0.34;
        float ring_r = R * 0.72;
        float ring_w = R * 0.09;
        float dot = 1.0 - smoothstep(dot_r - aa, dot_r + aa, r);
        float ring = smoothstep(ring_r - ring_w - aa, ring_r - ring_w, r)
                   * (1.0 - smoothstep(ring_r + ring_w, ring_r + ring_w + aa, r));
        // liseré sombre fin sous le dot pour le contraste sur fond clair
        float halo = (1.0 - smoothstep(dot_r + aa, dot_r + aa + 2.5, r)) * (1.0 - dot);
        float a = saturate(dot + ring) * color.a;
        float3 rgb = color.rgb * (dot + ring) + float3(0, 0, 0) * halo;
        a = saturate(a + halo * 0.35 * color.a);
        return float4(rgb * a, a);
    }

    // mode 2 : ombre portée (§7 E4). Pénombre douce dérivée de la SDF du quad source,
    // qui est inséré à l'intérieur du quad d'ombre (élargi de `spread` de chaque côté).
    if (mode > 1.5)
    {
        float spread = fx.x;
        float2 halfsz = quad_px * 0.5 - spread;        // demi-taille du rect source
        float d = sd_round_rect(i.local - quad_px * 0.5, halfsz, radius_px);
        float a = color.a * (1.0 - smoothstep(0.0, spread, d));
        return float4(color.rgb * a, a);
    }

    float3 rgb;
    if (mode < 0.5)
    {
        // flou de mouvement par vélocité (§8) : pour CE pixel sortie, uv à la frame
        // précédente = même pixel remappé par (dst_prev, src_prev). On floute le long
        // de uv_prev->uv_now (capture translation ET zoom). Early-out si immobile.
        float2 uv_now = i.uv;
        float2 localp = (i.pout - dst_prev.xy) / dst_prev.zw;
        float2 uv_prev = src_prev.xy + localp * (src_prev.zw - src_prev.xy);
        float2 duv = uv_now - uv_prev;
        int taps = (int) mb.x;
        if (taps <= 1 || dot(duv, duv) < 1e-9)
        {
            rgb = sample_yuv(uv_now);
        }
        else
        {
            float3 acc = 0.0;
            [loop] for (int k = 0; k < 16; k++)
            {
                if (k >= taps) break;
                float t = (float) k / (float) (taps - 1);
                acc += sample_yuv(uv_prev + duv * t);
            }
            rgb = acc / (float) taps;
        }
    }
    else
    {
        rgb = color.rgb;
    }

    float alpha = color.a;
    if (radius_px > 0.0)
    {
        float2 halfsz = quad_px * 0.5;
        float d = sd_round_rect(i.local - halfsz, halfsz, radius_px);
        alpha *= 1.0 - smoothstep(0.0, 1.5, d); // ~1.5px feather (§7 fwidth-like)
    }
    return float4(rgb * alpha, alpha); // prémultiplié
}

// ============ RGB -> NV12 (§5) : deux passes vers les plans d'une texture NV12 ============
// VS plein écran (triangle unique) qui expose l'UV.
struct FSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
FSOut vs_fs(uint vid : SV_VertexID)
{
    FSOut o;
    o.uv = float2((vid << 1) & 2, vid & 2);
    o.pos = float4(o.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return o;
}

Texture2D<float4> rgbTex : register(t0);
SamplerState sampNV : register(s0);

// BT.709 limited, RGB(0..1) -> Y' et Cb,Cr (inverse de yuv709_limited).
float rgb2y(float3 c)  { return (16.0  + 219.0 * (0.2126*c.r + 0.7152*c.g + 0.0722*c.b)) / 255.0; }
float2 rgb2uv(float3 c)
{
    float yp = 0.2126*c.r + 0.7152*c.g + 0.0722*c.b;
    float cb = (c.b - yp) / 1.8556;
    float cr = (c.r - yp) / 1.5748;
    return (128.0 + 224.0 * float2(cb, cr)) / 255.0;
}

float ps_y(FSOut i) : SV_Target   // plan Y (R8), pleine résolution
{
    return rgb2y(rgbTex.Sample(sampNV, i.uv).rgb);
}
float2 ps_uv(FSOut i) : SV_Target // plan UV (R8G8), demi-résolution (bilinéaire moyenne)
{
    return rgb2uv(rgbTex.Sample(sampNV, i.uv).rgb);
}

// ============ Flou gaussien séparable (§7 E3) ============
// fx.x = sigma (px), fx.y = pas de texel (1/dim), fx.zw = direction (1,0)|(0,1).
#define BLUR_R 24
float4 ps_blur(FSOut i) : SV_Target
{
    float sigma = max(fx.x, 0.001);
    float2 step = fx.y * fx.zw;
    float4 acc = 0.0;
    float wsum = 0.0;
    [unroll]
    for (int k = -BLUR_R; k <= BLUR_R; k++)
    {
        float w = exp(-0.5 * (k * k) / (sigma * sigma));
        acc += rgbTex.Sample(sampNV, i.uv + k * step) * w;
        wsum += w;
    }
    return acc / wsum;
}
// simple copie/échantillonnage d'une texture RGBA (pour redessiner le fond flouté)
float4 ps_tex(FSOut i) : SV_Target { return rgbTex.Sample(sampNV, i.uv); }

// ============ Dual-Kawase (fond flouté rapide) ============
// fx.xy = texel de la texture SOURCE (1/w, 1/h), fx.z = offset. 5 taps (down) / 8 taps (up),
// bilinéaires, à résolution décroissante -> bien moins de samples qu'un gaussien large.
float4 ps_kawase_down(FSOut i) : SV_Target
{
    float2 hp = fx.xy * 0.5 * fx.z;
    float2 uv = i.uv;
    float4 s = rgbTex.Sample(sampNV, uv) * 4.0;
    s += rgbTex.Sample(sampNV, uv - hp);
    s += rgbTex.Sample(sampNV, uv + hp);
    s += rgbTex.Sample(sampNV, uv + float2(hp.x, -hp.y));
    s += rgbTex.Sample(sampNV, uv - float2(hp.x, -hp.y));
    return s / 8.0;
}
float4 ps_kawase_up(FSOut i) : SV_Target
{
    float2 hp = fx.xy * 0.5 * fx.z;
    float2 uv = i.uv;
    float4 s = rgbTex.Sample(sampNV, uv + float2(-hp.x * 2.0, 0.0));
    s += rgbTex.Sample(sampNV, uv + float2(-hp.x, hp.y)) * 2.0;
    s += rgbTex.Sample(sampNV, uv + float2(0.0, hp.y * 2.0));
    s += rgbTex.Sample(sampNV, uv + float2(hp.x, hp.y)) * 2.0;
    s += rgbTex.Sample(sampNV, uv + float2(hp.x * 2.0, 0.0));
    s += rgbTex.Sample(sampNV, uv + float2(hp.x, -hp.y)) * 2.0;
    s += rgbTex.Sample(sampNV, uv + float2(0.0, -hp.y * 2.0));
    s += rgbTex.Sample(sampNV, uv + float2(-hp.x, -hp.y)) * 2.0;
    return s / 12.0;
}
