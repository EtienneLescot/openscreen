// Tranche verticale WP3 ÔÇö port 1:1 des modes 0 (vid├®o NV12) et 1 (couleur pleine)
// du `ps_main` HLSL (`crates/compositor/src/shaders.hlsl`). Le mode 2 (ombre
// port├®e) partage la m├¬me SDF et le m├¬me feather que les autres modes, donc on
// l'inclut aussi pour parit├®.
//
// Les constantes YUV (BT.709 limited) sont reprises ├á l'identique du HLSL :
//   Yf  = (Y  * 255 ÔêÆ 16) / 219
//   Cb  = (UV.x * 255 ÔêÆ 128) / 224
//   Cr  = (UV.y * 255 ÔêÆ 128) / 224
//   R   = Yf + 1.5748 ┬À Cr
//   G   = Yf ÔêÆ 0.1873 ┬À Cb ÔêÆ 0.4681 ┬À Cr
//   B   = Yf + 1.8556 ┬À Cb
// Mesur├® en S1 (cf. doc ┬º7 E1). Une d├®viation > 0/255 entre HLSL et WGSL ici
// indiquerait une diff├®rence de pr├®cision fp32 ; IEEE-754 round-to-nearest est
// identique sur les deux backends.
//
// Le rendu est en alpha PR├ëMULTIPLI├ë (cf. commentaire HLSL), convention qu'on
// retrouve dans tous les autres modes du compositeur (texte, curseur, ombre).

struct Layer {
    dst: vec4<f32>,       // x,y,w,h sortie 0..1 (origine haut-gauche)
    src: vec4<f32>,       // u0,v0,u1,v1 source 0..1
    quad_px: vec2<f32>,   // taille du quad en px de sortie (pour la SDF isotrope)
    radius_px: f32,
    mode: f32,            // 0 = vid├®o NV12, 1 = couleur pleine, 2 = ombre
    color: vec4<f32>,
    fx: vec4<f32>,        // mode 2 : spread ombre en px
    src_prev: vec4<f32>,
    dst_prev: vec4<f32>,
    mb: vec4<f32>,
}

@group(0) @binding(0) var<uniform> layer: Layer;
@group(0) @binding(1) var texY:  texture_2d<f32>;   // R8Unorm, sample .r
@group(0) @binding(2) var texUV: texture_2d<f32>;   // Rg8Unorm, sample .rg
@group(0) @binding(3) var samp:  sampler;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,     // UV d'├®chantillonnage source
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

// SDF rectangle ├á coins arrondis (< 0 dedans). Identique au HLSL.
fn sd_round_rect(p: vec2<f32>, halfsz: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - halfsz + vec2<f32>(r);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fs_main(i: VsOut) -> @location(0) vec4<f32> {
    var rgb: vec3<f32>;
    var alpha: f32;

    if layer.mode < 0.5 {
        // Mode 0 ÔÇö vid├®o NV12. Le motion blur (taps) et le flou de mouvement par
        // v├®locit├® sont d├®lib├®r├®ment omis de la tranche verticale (ils vivent en
        // WP4, apr├¿s la validation du chemin iso). Couleur ├®chantillonn├®e une fois
        // ├á l'UV interpol├®e.
        rgb = sample_yuv(i.uv);
    } else if layer.mode < 1.5 {
        // Mode 1 ÔÇö couleur pleine.
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
    } else {
        // Mode 2 ÔÇö ombre port├®e (SDF d'un quad arrondi ├®largi de `fx.x`).
        let spread = layer.fx.x;
        let halfsz = layer.quad_px * 0.5 - vec2<f32>(spread);
        let p = i.local - layer.quad_px * 0.5;
        let d = sd_round_rect(p, halfsz, layer.radius_px);
        let a = layer.color.a * (1.0 - smoothstep(0.0, spread, d));
        return vec4<f32>(layer.color.rgb * a, a);
    }

    alpha = layer.color.a;

    if layer.radius_px > 0.0 {
        // Feather ~1.5 px sur le bord du quad ÔÇö parit├® exacte avec le HLSL
        // (`smoothstep(0.0, 1.5, d)`). Le shader HLSL inclut `quad_px` en px de
        // SORTIE ; on reproduit la m├¬me chose ici.
        let halfsz = layer.quad_px * 0.5;
        let p = i.local - layer.quad_px * 0.5;
        let d = sd_round_rect(p, halfsz, layer.radius_px);
        alpha *= 1.0 - smoothstep(0.0, 1.5, d);
    }

    return vec4<f32>(rgb * alpha, alpha); // alpha pr├®multipli├®
}
