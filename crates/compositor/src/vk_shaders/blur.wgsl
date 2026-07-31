// Tranche verticale WP4 — Kawase blur (mode 9+10 du HLSL) porté en WGSL.
//
// Le Kawase blur est une approximation gaussienne en 6 passes : down 3x
// (RT→½→¼→⅛) puis up 3x (⅛→¼→½→RT). Chaque passe est un 5-tap linéaire
// à offset 2.2 px (cf. HLSL `ps_kawase_down` / `ps_kawase_up`). Le résultat
// est visuellement équivalent à un flou gaussien ~30-50 px (selon la
// taille de la pyramide) à un coût constant 6×5 = 30 taps — vs 49 taps
// pour une passe gaussienne équivalente. Cf. HLSL `Compositor::blur_bg`.
//
// Bindings : la passe de down lit d'une texture RGBA8 et écrit dans
// une texture RGBA8 plus petite ; la passe d'up fait l'inverse. Toutes
// les passes partagent le même bind group layout, seule la constante
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
    // Fullscreen triangle — un seul triangle couvre tout l'écran, plus
    // efficace qu'un quad en termes de pixels shaders émis.
    let pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    var o: VsOut;
    // `pos[vid]` UNE SEULE FOIS, puis on réutilise `p`. Ce n'est pas du style :
    // indexer deux fois le même tableau local avec un indice dynamique fait
    // émettre à naga 24 du SPIR-V INVALIDE. Son `spilled_composites` est indexé
    // par le handle de l'expression de base, donc le second accès écrase l'entrée
    // du premier : un seul `OpVariable` est émis, et les `OpStore`/`OpAccessChain`
    // du premier accès référencent un id sans définition. Le module viole alors
    // VUID-VkShaderModuleCreateInfo-pCode-08737, donc le comportement du pilote
    // est indéfini — RADV déréférence l'id fantôme et segfault à la création du
    // pipeline, lavapipe survit par chance. Cf. gfx-rs/wgpu#7048, corrigé par
    // #7239 (wgpu 25) ; il n'existe pas de patch 24.0.x, donc tant qu'on est sur
    // wgpu 24 c'est au shader de ne pas déclencher le bug.
    let p = pos[vid];
    o.pos = vec4<f32>(p, 0.0, 1.0);
    o.uv = p * 0.5 + vec2<f32>(0.5, 0.5);
    // Note : on inverse Y parce que wgpu NDC y-up mais l'image source est
    // y-down (cf. le Y-flip dans le VS du layer.wgsl principal).
    o.uv.y = 1.0 - o.uv.y;
    return o;
}

// Triangle plein écran pour une COPIE 1:1, séparé de `vs_main` à dessein.
//
// Les deux mappings sont aujourd'hui identiques, et c'est précisément le piège :
// `vs_main` appartient à la chaîne Kawase, qui enchaîne SIX passes. Une
// inversion en Y y serait invisible (six inversions se compensent), donc rien
// dans cette chaîne ne défend l'orientation. Une copie unique, elle, la porte
// entière. Dupliquer les quatre lignes coûte moins qu'une traînée de curseur
// retournée le jour où quelqu'un ajuste la convention du Kawase.
//
// Orientation : en NDC wgpu (calqué sur D3D/Metal) y=+1 est le HAUT de la cible
// et v=0 la PREMIÈRE ligne de la texture, donc v doit croître quand y décroît.
// Vérifié par `compose_linux_trainee_de_curseur`, qui échoue en trouvant la
// traînée dans la bande miroir si on écrit `0.5 + p.y * 0.5`.
@vertex
fn vs_fullscreen(@builtin(vertex_index) vid: u32) -> VsOut {
    let pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    // Un seul accès indexé, cf. la note naga 24 / RADV dans `vs_main`.
    let p = pos[vid];
    var o: VsOut;
    o.pos = vec4<f32>(p, 0.0, 1.0);
    o.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
    return o;
}

// Copie telle quelle. La source est en alpha PRÉMULTIPLIÉ (tout le compositeur
// l'est), donc le blend « over » de la pipeline la composite sans reconversion.
@fragment
fn fs_copy(i: VsOut) -> @location(0) vec4<f32> {
    return textureSample(tex, samp, i.uv);
}

// Kawase down : 5-tap linéaire à offset `texel_offset` en coords source.
// `texel_offset` est 2.2 typiquement (le spread mesuré du filtre).
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

// Kawase up : interpolation linéaire entre la texture de destination
// (`tex`) et l'échantillon à offset `texel_offset` dans la même texture.
// C'est l'algorithme Kawase « up » original — moins connu que le down
// mais c'est ce qui donne le look "soft glow" mesuré sur le banc.
//
// On interpole entre la valeur au centre et les 4 voisins à offset `o`.
@fragment
fn fs_kawase_up(i: VsOut) -> @location(0) vec4<f32> {
    let o = layer.fx.x;
    let c = textureSample(tex, samp, i.uv).rgb;
    let s1 = textureSample(tex, samp, i.uv + vec2<f32>( o,  o) / vec2<f32>(layer.quad_px.x, layer.quad_px.y)).rgb;
    let s2 = textureSample(tex, samp, i.uv + vec2<f32>(-o,  o) / vec2<f32>(layer.quad_px.x, layer.quad_px.y)).rgb;
    let s3 = textureSample(tex, samp, i.uv + vec2<f32>( o, -o) / vec2<f32>(layer.quad_px.x, layer.quad_px.y)).rgb;
    let s4 = textureSample(tex, samp, i.uv + vec2<f32>(-o, -o) / vec2<f32>(layer.quad_px.x, layer.quad_px.y)).rgb;
    // Pondération (1.0 centre, 0.5 chaque voisin) — 1+4×0.5 = 3.0, /3 = 1/3 par
    // échantillon. Le rendu Kawase up est plus doux que le down.
    return vec4<f32>((c + (s1 + s2 + s3 + s4) * 0.5) / 3.0, layer.color.a);
}
