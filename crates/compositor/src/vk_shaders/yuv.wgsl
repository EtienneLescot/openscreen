// RGBA composee -> plans Y / U / V, sur le GPU.
//
// POURQUOI. Le chemin Linux relisait le RT en RGBA (8,3 Mo par frame en 1080p)
// puis convertissait en YUV420P sur le CPU avec `sws_scale`, mono-thread.
// Mesure sur un export S4 de 3600 frames : relecture 22,4 s, sws_scale 12,2 s.
// Convertir avant la relecture divise le volume relu par 2,67 (8,3 Mo -> 3,1 Mo)
// et fait disparaitre sws_scale.
//
// COEFFICIENTS. BT.601, plage limitee (Y 16-235, C 16-240) : c'est EXACTEMENT ce
// que `sws_getContext(..., SWS_POINT, ...)` produit par defaut pour une sortie
// YUV420P, et le but ici est d'accelerer la conversion, pas d'en changer le
// resultat. Toute autre matrice deplacerait les couleurs du fichier exporte.

@group(0) @binding(0) var tex:  texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// Meme triangle plein ecran que `blur.wgsl::vs_fullscreen`, meme orientation :
// une passe unique ne pardonne pas une erreur de sens (cf. la note la-bas).
@vertex
fn vs_fullscreen(@builtin(vertex_index) vid: u32) -> VsOut {
    let pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    let p = pos[vid];
    var o: VsOut;
    o.pos = vec4<f32>(p, 0.0, 1.0);
    o.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
    return o;
}

fn luma601(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

// Y pleine resolution. 16 + 219*Y', normalise sur 255 pour un R8Unorm.
@fragment
fn fs_y(i: VsOut) -> @location(0) vec4<f32> {
    let c = textureSample(tex, samp, i.uv).rgb;
    let y = (16.0 + 219.0 * luma601(c)) / 255.0;
    return vec4<f32>(y, 0.0, 0.0, 1.0);
}

// U et V en demi-resolution. Le sampler est LINEAIRE et la cible fait la moitie
// de la source, donc echantillonner au centre du texel de sortie moyenne
// exactement le bloc 2x2 correspondant — le meme sous-echantillonnage que fait
// sws pour du 4:2:0, sans boucle de taps.
@fragment
fn fs_u(i: VsOut) -> @location(0) vec4<f32> {
    let c = textureSample(tex, samp, i.uv).rgb;
    let u = (128.0 + 224.0 * (-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b)) / 255.0;
    return vec4<f32>(u, 0.0, 0.0, 1.0);
}

@fragment
fn fs_v(i: VsOut) -> @location(0) vec4<f32> {
    let c = textureSample(tex, samp, i.uv).rgb;
    let v = (128.0 + 224.0 * (0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b)) / 255.0;
    return vec4<f32>(v, 0.0, 0.0, 1.0);
}
