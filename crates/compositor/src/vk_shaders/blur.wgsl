// Tranche verticale WP4 ÔÇö Kawase blur (mode 9+10 du HLSL) port├® en WGSL.
//
// Le Kawase blur est une approximation gaussienne en 6 passes : down 3x
// (RTÔåÆ┬¢ÔåÆ┬╝ÔåÆÔàø) puis up 3x (ÔàøÔåÆ┬╝ÔåÆ┬¢ÔåÆRT). Chaque passe est un 5-tap lin├®aire
// ├á offset 2.2 px (cf. HLSL `ps_kawase_down` / `ps_kawase_up`). Le r├®sultat
// est visuellement ├®quivalent ├á un flou gaussien ~30-50 px (selon la
// taille de la pyramide) ├á un co├╗t constant 6├ù5 = 30 taps ÔÇö vs 49 taps
// pour une passe gaussienne ├®quivalente. Cf. HLSL `Compositor::blur_bg`.
//
// Bindings : la passe de down lit d'une texture RGBA8 et ├®crit dans
// une texture RGBA8 plus petite ; la passe d'up fait l'inverse. Toutes
// les passes partagent le m├¬me bind group layout, seule la constante
// `texel_offset` (dans LayerCB `fx`) change entre les passes.

struct Layer {
    dst: vec4<f32>,
    src: vec4<f32>,
    quad_px: vec2<f32>,
    radius_px: f32,
    mode: f32,
    color: vec4<f32>,
    fx: vec4<f32>,        // .x = texel offset (2.2 pour Kawase)
    src_prev: vec4<f32>,
    dst_prev: vec4<f32>,
    mb: vec4<f32>,
}

@group(0) @binding(0) var<uniform> layer: Layer;
@group(0) @binding(1) var tex:   texture_2d<f32>;
@group(0) @binding(2) var samp:  sampler;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    // Fullscreen triangle ÔÇö un seul triangle couvre tout l'├®cran, plus
    // efficace qu'un quad en termes de pixels shaders ├®mis.
    let pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    var o: VsOut;
    o.pos = vec4<f32>(pos[vid], 0.0, 1.0);
    o.uv = pos[vid] * 0.5 + vec2<f32>(0.5, 0.5);
    // Note : on inverse Y parce que wgpu NDC y-up mais l'image source est
    // y-down (cf. le Y-flip dans le VS du layer.wgsl principal).
    o.uv.y = 1.0 - o.uv.y;
    return o;
}

// Kawase down : 5-tap lin├®aire ├á offset `texel_offset` en coords source.
// `texel_offset` est 2.2 typiquement (le spread mesur├® du filtre).
@fragment
fn fs_kawase_down(i: VsOut) -> @location(0) vec4<f32> {
    let o = layer.fx.x;
    let c = textureSample(tex, samp, i.uv).rgb;
    let s1 = textureSample(tex, samp, i.uv + vec2<f32>( o,  o) / vec2<f32>(layer.quad_px.x, layer.quad_px.y)).rgb;
    let s2 = textureSample(tex, samp, i.uv + vec2<f32>(-o,  o) / vec2<f32>(layer.quad_px.x, layer.quad_px.y)).rgb;
    let s3 = textureSample(tex, samp, i.uv + vec2<f32>( o, -o) / vec2<f32>(layer.quad_px.x, layer.quad_px.y)).rgb;
    let s4 = textureSample(tex, samp, i.uv + vec2<f32>(-o, -o) / vec2<f32>(layer.quad_px.x, layer.quad_px.y)).rgb;
    return vec4<f32>((c + s1 + s2 + s3 + s4) * 0.2, layer.color.a);
}

// Kawase up : interpolation lin├®aire entre la texture de destination
// (`tex`) et l'├®chantillon ├á offset `texel_offset` dans la m├¬me texture.
// C'est l'algorithme Kawase ┬½ up ┬╗ original ÔÇö moins connu que le down
// mais c'est ce qui donne le look "soft glow" mesur├® sur le banc.
//
// On interpole entre la valeur au centre et les 4 voisins ├á offset `o`.
@fragment
fn fs_kawase_up(i: VsOut) -> @location(0) vec4<f32> {
    let o = layer.fx.x;
    let c = textureSample(tex, samp, i.uv).rgb;
    let s1 = textureSample(tex, samp, i.uv + vec2<f32>( o,  o) / vec2<f32>(layer.quad_px.x, layer.quad_px.y)).rgb;
    let s2 = textureSample(tex, samp, i.uv + vec2<f32>(-o,  o) / vec2<f32>(layer.quad_px.x, layer.quad_px.y)).rgb;
    let s3 = textureSample(tex, samp, i.uv + vec2<f32>( o, -o) / vec2<f32>(layer.quad_px.x, layer.quad_px.y)).rgb;
    let s4 = textureSample(tex, samp, i.uv + vec2<f32>(-o, -o) / vec2<f32>(layer.quad_px.x, layer.quad_px.y)).rgb;
    // Pond├®ration (1.0 centre, 0.5 chaque voisin) ÔÇö 1+4├ù0.5 = 3.0, /3 = 1/3 par
    // ├®chantillon. Le rendu Kawase up est plus doux que le down.
    return vec4<f32>((c + (s1 + s2 + s3 + s4) * 0.5) / 3.0, layer.color.a);
}
