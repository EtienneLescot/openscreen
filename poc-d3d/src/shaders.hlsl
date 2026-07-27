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
Texture2D<float4> texImg : register(t2); // wallpaper image RGBA (fond, mode 6)
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

// SDF segment à bouts ronds — la primitive des flèches d'annotation, dont les tracés SVG sont
// trois segments `stroke-linecap="round"` (cf. ArrowSvgs.tsx).
float sd_segment(float2 p, float2 a, float2 b)
{
    float2 pa = p - a;
    float2 ba = b - a;
    float h = saturate(dot(pa, ba) / max(dot(ba, ba), 1e-6));
    return length(pa - ba * h);
}

// SDF rectangle à coins arrondis (§7 E2) : <0 dedans.
float sd_round_rect(float2 p, float2 halfsz, float r)
{
    float2 q = abs(p) - halfsz + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Intersection de deux droites données par (normale, offset) : n·x = d. Cramer.
float2 line_cross(float2 n1, float d1, float2 n2, float d2)
{
    float det = n1.x * n2.y - n1.y * n2.x;
    if (abs(det) < 1e-6) return float2(0.0, 0.0); // arêtes parallèles : quad dégénéré
    return float2(d1 * n2.y - d2 * n1.y, d2 * n1.x - d1 * n2.x) / det;
}

// Distance signée EXACTE à un quadrilatère convexe (<0 dedans). Le max des demi-plans suffit près
// des arêtes mais donne un coin en pointe ; ici on veut aussi la distance juste au coin, puisque
// c'est elle qui devient l'arrondi une fois le rayon retranché.
float sd_convex_quad(float2 p, float2 v0, float2 v1, float2 v2, float2 v3)
{
    float2 v[5] = { v0, v1, v2, v3, v0 };
    float inside = -1e9;
    float border = 1e9;
    [unroll] for (int k = 0; k < 4; k++)
    {
        float2 a = v[k];
        float2 e = v[k + 1] - a;
        float2 n = float2(e.y, -e.x) / max(length(e), 1e-6);
        inside = max(inside, dot(p - a, n));
        border = min(border, sd_segment(p, a, v[k + 1]));
    }
    return (inside < 0.0) ? -border : border;
}

// (s, t, ok) du warp inverse du mode 8 pour une racine `t` donnée : `ok` = 1 quand le couple
// tombe dans le quad projeté (même marge 0.02 qu'ailleurs). Les deux racines doivent être
// essayées — trancher sur `t` seul retient parfois celle dont le `s` sort du quad, et le pixel
// est alors déclaré dehors alors que l'autre racine le plaçait dedans.
float3 quad_st_for_root(float t, float2 e, float2 f, float2 g, float2 h)
{
    float denomX = e.x + g.x * t;
    float denomY = e.y + g.y * t;
    float s = (abs(denomX) > abs(denomY)) ? (h.x - f.x * t) / denomX : (h.y - f.y * t) / denomY;
    float ok = (s >= -0.02 && s <= 1.02 && t >= -0.02 && t <= 1.02) ? 1.0 : 0.0;
    return float3(s, t, ok);
}

// (s, t, ok) du point `P` dans le quad c00->c10->c11->c01 : le warp bilinéaire INVERSE, partagé
// par le mode 8 (écran incliné) et le mode 13 (curseur posé sur ce même écran). Les deux doivent
// résoudre exactement la même équation, sinon le curseur glisse par rapport au contenu — d'où
// une seule implémentation plutôt que deux copies.
float3 quad_inverse_bilinear(float2 P, float2 c00, float2 c10, float2 c11, float2 c01)
{
    float2 e = c10 - c00;
    float2 f = c01 - c00;
    float2 g = c00 - c10 - c01 + c11;
    float2 h = P - c00;
    float k2 = g.x * f.y - g.y * f.x;
    float k1 = e.x * f.y - e.y * f.x + h.x * g.y - h.y * g.x;
    float k0 = h.x * e.y - h.y * e.x;
    // Seuil RELATIF. Les présets « left »/« right » sont une rotation Y pure : le quad
    // projeté est un trapèze symétrique dont `f` et `g` sont tous deux verticaux, donc
    // k2 = 0 EXACTEMENT — au bruit d'arrondi près, et ce bruit vaut quelques centièmes sur
    // des produits en 10^6. Un seuil absolu de 0.001 le manquait : l'équation passait dans la
    // branche quadratique avec k2 ≈ 0, où `(-k1 + sqrt(k1²)) / 2k2` ne renvoie que du bruit —
    // soustraire deux nombres presque égaux, puis diviser par presque rien. La quasi-totalité
    // du quad était rejetée, ce qui se voyait comme un écran incliné tranché net.
    if (abs(k2) < 1e-5 * abs(k1))
    {
        float t = (abs(k1) < 1e-6) ? 0.0 : -k0 / k1;
        return quad_st_for_root(t, e, f, g, h);
    }
    float disc = k1 * k1 - 4.0 * k2 * k0;
    if (disc < 0.0) return float3(0.0, 0.0, 0.0);
    // Forme stable : `q` n'oppose jamais deux quantités voisines, et les deux racines
    // s'en déduisent exactement. `sign()` est évité parce qu'il vaut 0 en 0, ce qui
    // annulerait `q` là où la formule reste parfaitement définie.
    float q = -0.5 * (k1 + (k1 >= 0.0 ? 1.0 : -1.0) * sqrt(disc));
    float3 r0 = quad_st_for_root(q / k2, e, f, g, h);
    float3 r1 = quad_st_for_root(abs(q) > 0.0 ? k0 / q : q / k2, e, f, g, h);
    return (r0.z > 0.5) ? r0 : r1;
}

float4 ps_main(VSOut i) : SV_Target
{
    // mode 13 : SPRITE DE CURSEUR posé sur l'écran incliné. Même warp que le mode 8, mais
    // échantillonnant la texture du curseur en alpha DROIT (comme le mode 7) au lieu de la
    // vidéo NV12. Le curseur remplace un pointeur qui faisait partie de l'image capturée : il
    // doit donc subir la même inclinaison qu'elle, sinon il se lit comme un autocollant plat
    // collé par-dessus la scène. Corriger sa seule position ne suffisait pas.
    // fx.xy/fx.zw = coins TL/TR (px locaux) ; src_prev.xy/.zw = BR/BL ; dst_prev = rect de clip
    // « Clip to canvas » en espace sortie.
    if (mode > 12.5)
    {
        if (i.pout.x < dst_prev.x || i.pout.x > dst_prev.x + dst_prev.z ||
            i.pout.y < dst_prev.y || i.pout.y > dst_prev.y + dst_prev.w)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        float3 r = quad_inverse_bilinear(i.local, fx.xy, fx.zw, src_prev.xy, src_prev.zw);
        if (r.z < 0.5)
        {
            return float4(0.0, 0.0, 0.0, 0.0); // hors du sprite projeté
        }
        float4 s = texImg.Sample(samp, saturate(float2(r.x, r.y)));
        float a = s.a * color.a;
        return float4(s.rgb * a, a);
    }

    // mode 8 : écran tilté en 3D (zoom regions "rotation" : iso/left/right). `dst`/`quad_px`
    // couvrent la BOUNDING BOX des 4 coins projetés (calculée côté CPU, `regions.rs`) ; ce
    // shader retrouve où tombe chaque pixel DANS le quad tilté (warp bilinéaire inverse — pas
    // de perspective-correct exact, mais indiscernable à l'œil pour un tilt de 10-22°) et
    // échantillonne la vidéo à l'UV correspondant, sinon transparent (hors du quad projeté).
    // fx.xy/fx.zw = coins TL/TR (px locaux, 0..quad_px) ; src_prev.xy/.zw = coins BR/BL.
    // mode 11 : texte d'annotation, rastérisé par Direct2D (voir text.rs). D2D écrit sur une
    // surface DXGI en alpha PRÉMULTIPLIÉ, donc contrairement au mode 7 (sprite curseur, alpha
    // droit) il ne faut SURTOUT pas re-multiplier ici : les bords adoucis des glyphes
    // deviendraient deux fois trop transparents et le texte paraîtrait délavé.
    // `color.a` reste l'opacité globale (fondu d'animation).
    //
    // mode 12 : ombre du quad PROJETÉ. Même pénombre que le mode 2, mais portée par le
    // quadrilatère incliné au lieu d'un rect droit — une ombre droite derrière un écran penché ne
    // se lit pas comme son ombre, mais comme une seconde surface posée derrière. Les coins
    // arrivent dans la même convention que le mode 8 (fx = TL/TR, src_prev = BR/BL, px locaux) ;
    // mb.y = étalement de la pénombre en px.
    if (mode > 11.5)
    {
        float2 quad[5] = { fx.xy, fx.zw, src_prev.xy, src_prev.zw, fx.xy };
        // Coins arrondis du même rayon que le plan (`radius_px`). Une ombre à coins vifs derrière
        // un écran aux coins arrondis dépasse en pointe à chaque coin — visible, et d'autant plus
        // que le rayon monte. On rentre donc chaque arête de `r`, et retrancher `r` à la distance
        // du quadrilatère ainsi obtenu redonne un arrondi exactement tangent aux deux arêtes.
        float r = max(radius_px, 0.0);
        float2 v[4];
        [unroll] for (int k = 0; k < 4; k++)
        {
            // TL→TR→BR→BL tourne dans le sens horaire en y-bas, donc (e.y, -e.x) sort du quad.
            // Division par la longueur plutôt que `normalize` : une arête dégénérée donnerait un
            // NaN qui effacerait l'ombre entière.
            float2 ep = quad[k] - quad[(k + 3) & 3];       // arête précédente
            float2 ec = quad[k + 1] - quad[k];             // arête courante
            float2 np = float2(ep.y, -ep.x) / max(length(ep), 1e-6);
            float2 nc = float2(ec.y, -ec.x) / max(length(ec), 1e-6);
            // Chaque arête rentrée de r : n·x = n·a - r. Leur intersection est le coin rentré.
            v[k] = line_cross(np, dot(quad[(k + 3) & 3], np) - r, nc, dot(quad[k], nc) - r);
        }
        float d = sd_convex_quad(i.local, v[0], v[1], v[2], v[3]) - r;
        float spread = max(mb.y, 1e-3);
        float a = color.a * (1.0 - smoothstep(0.0, spread, d));
        return float4(color.rgb * a, a);
    }

    if (mode > 10.5)
    {
        float4 s = texImg.Sample(samp, i.uv);
        return s * color.a;
    }

    // mode 10 : annotation « flou » — masque la zone en réutilisant l'image DÉJÀ composée, qui
    // arrive dans `texImg` (recopie du render target : on ne peut pas échantillonner la cible sur
    // laquelle on dessine). `i.pout` donne directement l'UV de sortie, donc aucun mapping à
    // refaire. fx.x = 0 mosaïque / 1 flou ; fx.y = taille de bloc px (mosaïque) ou rayon px
    // (flou) ; fx.z = 0 rectangle / 1 ovale ; fx.w = 1 si le masque doit être teinté.
    if (mode > 9.5)
    {
        // Masque de forme, en coords locales normalisées du quad.
        float2 n = i.local / max(quad_px, 1e-6);
        float cov = 1.0;
        if (fx.z > 0.5)
        {
            // Ovale inscrit : distance au centre en unités de demi-axes, adoucie sur ~1px.
            float2 d = (n - 0.5) * 2.0;
            float r = length(d);
            float aa = 2.0 / max(min(quad_px.x, quad_px.y), 1.0);
            cov = 1.0 - smoothstep(1.0 - aa, 1.0, r);
        }
        if (cov <= 0.0) return float4(0.0, 0.0, 0.0, 0.0);

        float3 rgb;
        if (fx.x > 0.5)
        {
            // Flou : on échantillonne un niveau de mip de l'image composée. `log2(rayon)` donne
            // le niveau dont un texel couvre à peu près le rayon demandé, et le filtrage
            // trilinéaire lisse la transition entre deux niveaux quand le rayon varie.
            //
            // Un noyau de quelques taps espacés du rayon ne floute PAS : il superpose autant de
            // copies décalées, ce qui se voit comme du texte fantôme. Atteindre un vrai lissage
            // par taps demanderait un tap par pixel de rayon ; la pyramide de mips donne le même
            // résultat à coût constant, et c'est le GPU qui l'a construite.
            float lod = log2(max(fx.y, 1.0));
            rgb = texImg.SampleLevel(samp, i.pout, lod).rgb;
        }
        else
        {
            // Mosaïque : on quantifie l'UV sur une grille de `fx.y` px, alignée sur le quad pour
            // que les blocs ne rampent pas quand l'annotation bouge.
            float2 px_uv = dst.zw / max(quad_px, 1e-6);
            float2 block = max(fx.y, 1.0) * px_uv;
            float2 origin = dst.xy;
            float2 q = origin + (floor((i.pout - origin) / block) + 0.5) * block;
            // `SampleLevel(..., 0)` et non `Sample` : l'UV quantifié est une marche d'escalier,
            // donc ses dérivées explosent en bord de bloc et le choix automatique de mip
            // ramollirait justement les arêtes qui font la mosaïque.
            rgb = texImg.SampleLevel(samp, q, 0.0).rgb;
        }

        if (fx.w > 0.5)
        {
            // Teinte blanc/noir : la couleur choisie, mêlée à moitié, garde la forme lisible sans
            // effacer complètement ce qu'il y a dessous.
            rgb = lerp(rgb, color.rgb, 0.5);
        }
        float a = cov * color.a;
        return float4(rgb * a, a); // prémultiplié
    }

    // mode 9 : annotation « figure » — une flèche. Parité EXACTE avec `ArrowSvgs.tsx`, dont
    // chaque direction est un tracé de trois segments à bouts ronds dans un viewBox 0..100 :
    // une hampe et deux barbes. Trois `sd_segment` et un `min` reproduisent donc la forme telle
    // quelle, pas une approximation. Les extrémités arrivent déjà converties en px locaux du
    // quad (échelle uniforme centrée, comme le `preserveAspectRatio` par défaut du SVG).
    // fx = hampe (a.xy, b.xy), src_prev = barbe 1, dst_prev = barbe 2 ; mb.y = demi-épaisseur px.
    if (mode > 8.5)
    {
        float d = sd_segment(i.local, fx.xy, fx.zw);
        d = min(d, sd_segment(i.local, src_prev.xy, src_prev.zw));
        d = min(d, sd_segment(i.local, dst_prev.xy, dst_prev.zw));
        // Couverture sur ~1 px : le trait reste net sans crénelage, et une flèche fine ne
        // disparaît pas quand la demi-épaisseur descend sous le pixel.
        float a = saturate(mb.y - d + 0.5) * color.a;
        return float4(color.rgb * a, a); // prémultiplié, comme tous les autres modes
    }

    if (mode > 7.5)
    {
        float3 r = quad_inverse_bilinear(i.local, fx.xy, fx.zw, src_prev.xy, src_prev.zw);
        if (r.z < 0.5)
        {
            return float4(0.0, 0.0, 0.0, 0.0); // hors du quad projeté
        }
        float2 uv = float2(lerp(src.x, src.z, saturate(r.x)), lerp(src.y, src.w, saturate(r.y)));
        // Coins arrondis DANS LE REPÈRE DU PLAN (`dst_prev.xy` = sa taille avant projection) :
        // le rayon reste constant le long du bord, alors qu'un arrondi calculé dans la bbox
        // s'étirerait avec la perspective. Sans cet arrondi, un écran penché a des arêtes de
        // couteau qui coupent le contenu en pleine phrase, et ça se lit comme une troncature
        // plutôt que comme une inclinaison.
        //
        // Inconditionnel, rayon 0 COMPRIS : `sd_round_rect` dégénère alors en SDF de rectangle et
        // le feather de 1.5 px subsiste, ce qui est précisément ce qui fait lire une arête inclinée
        // comme une arête. Sous l'ancienne garde `radius_px > 0`, un slider Roundness à 0 laissait
        // la couverture du plan au seul test binaire `r.z < 0.5` ci-dessus : des marches d'escalier
        // en escalier franc, soit la troncature même que cette branche existe pour éviter (d'où le
        // symptôme « le tilt 3D est tronqué, mais pas au-dessus d'un certain arrondi »). L'ombre du
        // mode 12 applique déjà son `max(radius_px, 0.0)` sans garde, pour la même raison.
        float2 plane_px = dst_prev.xy;
        float2 p = float2(r.x, r.y) * plane_px - plane_px * 0.5;
        float d = sd_round_rect(p, plane_px * 0.5, max(radius_px, 0.0));
        float tilt_a = 1.0 - smoothstep(0.0, 1.5, d);
        return float4(sample_yuv(uv) * tilt_a, tilt_a); // prémultiplié, comme les autres modes
    }

    // mode 7 : sprite curseur thème (PNG alpha droite, arrow.png etc.). Prémultiplie ici
    // (le blend state attend du prémultiplié partout ailleurs). fx = rect de clip "Clip to
    // canvas" en espace sortie 0..1 [x,y,w,h] (= s_dst quand actif, sinon un rect englobant
    // tout -> aucun effet).
    if (mode > 6.5)
    {
        if (i.pout.x < fx.x || i.pout.x > fx.x + fx.z || i.pout.y < fx.y || i.pout.y > fx.y + fx.w)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
        float4 s = texImg.Sample(samp, i.uv);
        float a = s.a * color.a; // color.a = opacité globale (fade éventuel)
        return float4(s.rgb * a, a);
    }

    // mode 6 : wallpaper image RGBA (cover-fit). src = rect uv déjà calculé (crop de
    // recouvrement), i.uv l'interpole. Opaque.
    if (mode > 5.5)
    {
        return float4(texImg.Sample(samp, i.uv).rgb, 1.0);
    }

    // mode 5 : gradient linéaire 2 stops (parité web wallpaper dégradé). color = stop0,
    // src.xyz = stop1, fx.xy = direction unitaire (espace sortie, y vers le bas). t est
    // normalisé coin-à-coin (dénominateur = |dx|+|dy|) pour couvrir toute la diagonale.
    if (mode > 4.5)
    {
        float2 dir = fx.xy;
        float denom = max(abs(dir.x) + abs(dir.y), 1e-4);
        float t = saturate(0.5 + dot(i.pout - 0.5, dir) / denom);
        float3 g = lerp(color.rgb, src.xyz, t);
        return float4(g, 1.0); // opaque, prémultiplié (a=1)
    }

    // mode 4 : curseur custom (dot + ring, dessiné depuis les maths). color = teinte.
    // fx = rect de clip "Clip to canvas" (mêmes conventions que le mode 7 ci-dessus).
    if (mode > 3.5)
    {
        if (i.pout.x < fx.x || i.pout.x > fx.x + fx.z || i.pout.y < fx.y || i.pout.y > fx.y + fx.w)
        {
            return float4(0.0, 0.0, 0.0, 0.0);
        }
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
        // `quad_px`/`spread` sont en px de SORTIE : le render target porte la géométrie de
        // sortie, donc aucune pré-déformation n'est nécessaire. (Historiquement le canvas
        // était figé en 16:9 et étiré en fin de pipeline, d'où un facteur anisotrope transporté
        // dans `mb.yz` que ce shader devait annuler — le halo ressortait elliptique sans lui.)
        float spread = fx.x;
        float2 halfsz = quad_px * 0.5 - spread;
        float2 p = i.local - quad_px * 0.5;
        float d = sd_round_rect(p, halfsz, radius_px);
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
        // `quad_px` est en px de SORTIE (le render target porte la géométrie de sortie) et
        // `radius_px` est un rayon réel en px de sortie : la SDF isotrope les compare dans le
        // même espace, le coin est donc rond par construction. (Avant, le canvas figé en 16:9
        // était étiré en fin de pipeline et il fallait pré-déformer par `mb.yz` pour que le
        // cercle ne ressorte pas elliptique.)
        float2 halfsz = quad_px * 0.5;
        float2 p = i.local - quad_px * 0.5;
        float d = sd_round_rect(p, halfsz, radius_px);
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
