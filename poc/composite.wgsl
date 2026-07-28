// The compositor. Two sources, one layout, three effects — written from zero.
//
// Drawn the way a game draws: one quad per element, sized to the element. The
// rasterizer then runs the fragment shader ONLY on the pixels that element
// covers, and clips whatever falls outside the frame — for free, in fixed
// function, with no branch. A zoomed recording is 2.7x the stage: two thirds of
// it is off-screen and costs nothing.
//
// The alternative — one fullscreen triangle with `if`s — pays for every pixel of
// every effect and then throws most of it away. That is what the first version of
// this file did.
//
// Everything is a pure function of the uniforms. No cache: a shader recomputes
// every pixel every frame, which is the point of the paradigm.

struct U {
  // stage.xy | unused | screenRadius
  a : vec4f,
  // screenRect: x, y, w, h — already carries the zoom (scale + pan)
  screen : vec4f,
  // webcamRect: x, y, w, h — already carries the layout animation
  webcam : vec4f,
  // shadowIntensity | bgBlurPx | shadowOffsetY | shadowSpread
  fx : vec4f,
  // webcamRadius | unused | webcamCoverScale | optimised(0/1)
  b : vec4f,
  // Directional motion blur, in pixels: screenBlur.xy | webcamBlur.xy. A vector,
  // not a scalar — the recording smears along the camera's real travel, which
  // during a pan or a layout move is not horizontal.
  mb : vec4f,
  // The cursor, drawn synthetically from the recorded trace: x | y | size |
  // opacity. Position is in stage pixels, already carried through the zoom.
  cursor : vec4f,
  // cursorBlur.xy | clickScale | unused. clickScale pulses on a real click.
  cursorFx : vec4f,
};

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var screenTex : texture_external;
@group(0) @binding(3) var webcamTex : texture_external;
@group(0) @binding(4) var bgTex : texture_2d<f32>;

struct VsOut {
  @builtin(position) pos : vec4f,
  // Stage-space uv (0..1 across the OUTPUT), not the quad's own uv: the fragment
  // shaders all reason in stage pixels, and the quad is only there to bound them.
  @location(0) uv : vec2f,
};

// ---- vertex: one quad per element ------------------------------------------

/**
 * Emit `rect` as two triangles in stage space.
 *
 * Clipping is the rasterizer's job: a rect that runs off the stage — every zoomed
 * recording — is cut by fixed-function hardware before a single fragment is
 * dispatched.
 */
fn quad(vi : u32, rect : vec4f) -> VsOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let c = corners[vi];
  let px = rect.xy + c * rect.zw;
  var out : VsOut;
  out.pos = vec4f(px.x / u.a.x * 2.0 - 1.0, 1.0 - px.y / u.a.y * 2.0, 0.0, 1.0);
  out.uv = px / u.a.xy;
  return out;
}

@vertex fn vsFull(@builtin(vertex_index) i : u32) -> VsOut {
  return quad(i, vec4f(0.0, 0.0, u.a.x, u.a.y));
}

@vertex fn vsScreen(@builtin(vertex_index) i : u32) -> VsOut {
  return quad(i, u.screen);
}

/** The shadow's quad: the rect grown by 3σ, the Gaussian's reach. */
@vertex fn vsScreenShadow(@builtin(vertex_index) i : u32) -> VsOut {
  let s = u.fx.w * 3.0 + 1.0;
  return quad(i, vec4f(u.screen.xy - vec2f(s), u.screen.zw + vec2f(s * 2.0)) + vec4f(0.0, u.fx.z, 0.0, 0.0));
}

@vertex fn vsWebcam(@builtin(vertex_index) i : u32) -> VsOut {
  return quad(i, u.webcam);
}

@vertex fn vsWebcamShadow(@builtin(vertex_index) i : u32) -> VsOut {
  let s = u.fx.w * 3.0 + 1.0;
  return quad(i, vec4f(u.webcam.xy - vec2f(s), u.webcam.zw + vec2f(s * 2.0)) + vec4f(0.0, u.fx.z, 0.0, 0.0));
}

/** The cursor's quad: its box, grown for the shadow, the click bounce and the smear. */
@vertex fn vsCursor(@builtin(vertex_index) i : u32) -> VsOut {
  let size = u.cursor.z;
  let pad = 6.0 + length(u.cursorFx.xy);
  let rect = vec4f(u.cursor.xy - vec2f(pad), vec2f(size * 1.5 + pad * 2.0));
  return quad(i, rect);
}

// ---- geometry ---------------------------------------------------------------

/** Signed distance to a rounded box. Negative inside. */
fn sdRoundBox(p : vec2f, half : vec2f, r : f32) -> f32 {
  let rr = min(r, min(half.x, half.y));
  let q = abs(p) - half + vec2f(rr);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rr;
}

/** Antialiased coverage from a signed distance: one pixel of ramp. */
fn cover(d : f32) -> f32 {
  return clamp(0.5 - d, 0.0, 1.0);
}

// ---- effect 1: the background ----------------------------------------------
//
// A blurred gradient, baked into a texture ONCE by fsBake. The frame reads one
// texel — and only where the recording does not already cover it.
//
// It was 16 gradient evaluations per pixel per frame, every one recomputing a
// CONSTANT. This is not the shadow cache in disguise, and the difference is the
// whole argument: a cache guesses that its input has not changed and needs a key
// to find out. This has no key because it has no input — the background IS a
// constant. The shadow follows the camera, so it gets no such luxury.

fn gradient(uv : vec2f) -> vec3f {
  let a = vec3f(0.06, 0.11, 0.24);
  let b = vec3f(0.35, 0.12, 0.42);
  let c = vec3f(0.02, 0.35, 0.38);
  let w = 0.5 + 0.5 * sin(uv.x * 2.0);
  return mix(mix(a, b, uv.y), c, w * 0.45);
}

fn blurredGradient(uv : vec2f) -> vec3f {
  let radiusPx = u.fx.y;
  if (radiusPx < 0.5) {
    return gradient(uv);
  }
  let px = radiusPx / u.a.xy;
  var acc = vec3f(0.0);
  let taps = 16;
  let golden = 2.39996;
  for (var i = 0; i < taps; i = i + 1) {
    let fi = f32(i);
    let r = sqrt((fi + 0.5) / f32(taps));
    let a = fi * golden;
    acc = acc + gradient(uv + vec2f(cos(a), sin(a)) * r * px);
  }
  return acc / f32(taps);
}

/** Init only. */
@fragment fn fsBake(in : VsOut) -> @location(0) vec4f {
  return vec4f(blurredGradient(in.uv), 1.0);
}

/** Per frame: one texel — or the naive 16 taps, for the A/B. */
@fragment fn fsBackground(in : VsOut) -> @location(0) vec4f {
  if (u.b.w > 0.5) {
    return vec4f(textureSampleLevel(bgTex, samp, in.uv, 0.0).rgb, 1.0);
  }
  return vec4f(blurredGradient(in.uv), 1.0);
}

// ---- effect 2: the drop shadow ----------------------------------------------
//
// A REAL Gaussian, computed analytically — not sampled.
//
// The wrong way (what this replaced): sample the rounded-box SDF at a ring of
// offsets and average. Few taps band into visible rings, many taps are slow, and
// neither is a Gaussian — it is a box blur of a hard mask. It looked like stacked
// translucent rectangles because that is exactly what it was.
//
// The right way (Evan Wallace, "Fast Rounded Rectangle Shadows"): the convolution
// of a 2D Gaussian with a box is separable and each axis is an integral of the
// Gaussian — which is the error function, erf. So a plain box shadow is a closed
// form, no samples at all: `(erf(right) - erf(left)) * (erf(top) - erf(bottom))`.
// Rounded corners break separability only near the corner, so the x extent is
// integrated against the Gaussian in y over a handful of steps — the exact
// profile, smoothly weighted, no banding. O(1) per pixel and beautiful.

const SQRT_2PI = 2.5066282746310002;
const INV_SQRT_2 = 0.7071067811865476;

fn gauss1(x : f32, sigma : f32) -> f32 {
  return exp(-(x * x) / (2.0 * sigma * sigma)) / (SQRT_2PI * sigma);
}

/** erf, componentwise (Abramowitz & Stegun 7.1.27). Max error ~5e-4. */
fn erf2(x : vec2f) -> vec2f {
  let s = sign(x);
  let a = abs(x);
  var r = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  r = r * r;
  return s - s / (r * r);
}

/** Fraction of a Gaussian-blurred box covering x, at height y, with rounded corners. */
fn shadowRowX(x : f32, y : f32, sigma : f32, corner : f32, half : vec2f) -> f32 {
  // How far the rounded corner pulls the edge in at this height.
  let d = min(half.y - corner - abs(y), 0.0);
  let curved = half.x - corner + sqrt(max(0.0, corner * corner - d * d));
  let integral = 0.5 + 0.5 * erf2((x + vec2f(-curved, curved)) * (INV_SQRT_2 / sigma));
  return integral.y - integral.x;
}

fn shadowAt(px : vec2f, rect : vec4f, radius : f32, intensity : f32) -> f32 {
  if (intensity <= 0.0) {
    return 0.0;
  }
  let sigma = max(u.fx.w, 0.5);
  let half = rect.zw * 0.5;
  let corner = min(radius, min(half.x, half.y));
  // Offset the shadow down by u.fx.z, like a light from above.
  let p = px - (rect.xy + half + vec2f(0.0, u.fx.z));

  // Integrate the x-profile against the Gaussian in y, over ±3σ clamped to the
  // box — four steps is plenty because each is analytic in x.
  let low = p.y - half.y;
  let high = p.y + half.y;
  let start = clamp(-3.0 * sigma, low, high);
  let end = clamp(3.0 * sigma, low, high);
  let step = (end - start) / 4.0;
  var y = start + step * 0.5;
  var value = 0.0;
  for (var i = 0; i < 4; i = i + 1) {
    value = value + shadowRowX(p.x, p.y - y, sigma, corner, half) * gauss1(y, sigma) * step;
    y = y + step;
  }
  return clamp(value, 0.0, 1.0) * intensity;
}

@fragment fn fsScreenShadow(in : VsOut) -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, shadowAt(in.uv * u.a.xy, u.screen, u.a.w, u.fx.x));
}

@fragment fn fsWebcamShadow(in : VsOut) -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, shadowAt(in.uv * u.a.xy, u.webcam, u.b.x, u.fx.x * 0.8));
}

// ---- effect 3: the masks + the sources --------------------------------------

/**
 * The recording, smeared along the camera's travel while it moves.
 *
 * The blur is a VECTOR now (u.mb.xy): a pan or a layout move sends the camera
 * diagonally, and a horizontal-only smear would be wrong for exactly the motion a
 * screen demo has most of. Skipped at rest — a branch is free next to seven
 * fetches, and it is uniform across the frame.
 */
fn sampleScreen(px : vec2f, blur : vec2f) -> vec3f {
  let uv0 = (px - u.screen.xy) / max(u.screen.zw, vec2f(1.0));
  if (length(blur) < 0.5) {
    return textureSampleBaseClampToEdge(screenTex, samp, clamp(uv0, vec2f(0.0), vec2f(1.0))).rgb;
  }
  var acc = vec3f(0.0);
  let taps = 7;
  for (var i = 0; i < taps; i = i + 1) {
    let t = (f32(i) / f32(taps - 1)) - 0.5;
    let uv = ((px + blur * t) - u.screen.xy) / max(u.screen.zw, vec2f(1.0));
    acc = acc + textureSampleBaseClampToEdge(screenTex, samp, clamp(uv, vec2f(0.0), vec2f(1.0))).rgb;
  }
  return acc / f32(taps);
}

@fragment fn fsScreen(in : VsOut) -> @location(0) vec4f {
  let px = in.uv * u.a.xy;
  let c = cover(sdRoundBox(px - (u.screen.xy + u.screen.zw * 0.5), u.screen.zw * 0.5, u.a.w));
  if (c <= 0.0) {
    discard;
  }
  return vec4f(sampleScreen(px, u.mb.xy), c);
}

// ---- the cursor -------------------------------------------------------------
//
// Drawn from the recorded trace, per frame — never baked into the video. A
// polygon SDF, so it is a shape the shader computes, not a sprite it samples; the
// real app swaps theme PNGs in here, which is a texture read in the same quad,
// not a different pipeline. The hard parts a POC has to prove are all here: it
// follows the zoom (its position rides the screen rect), it bounces on a real
// click (clickScale), it casts a shadow, and it smears when it moves fast.

/** Signed distance to the classic arrow pointer, tip at local (0,0). Neg inside. */
fn sdCursor(p : vec2f) -> f32 {
  var v = array<vec2f, 7>(
    vec2f(0.00, 0.00), vec2f(0.00, 1.00), vec2f(0.24, 0.76),
    vec2f(0.40, 1.14), vec2f(0.56, 1.07), vec2f(0.39, 0.69), vec2f(0.70, 0.69),
  );
  var d = dot(p - v[0], p - v[0]);
  var s = 1.0;
  for (var i = 0; i < 7; i = i + 1) {
    let j = (i + 6) % 7;
    let e = v[j] - v[i];
    let w = p - v[i];
    let b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    // Winding test. The three conditions are kept as scalars, not packed into a
    // vec3<bool>: the `>` inside that constructor is parsed as a template close.
    let c0 = p.y >= v[i].y;
    let c1 = p.y < v[j].y;
    let c2 = e.x * w.y > e.y * w.x;
    if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) { s = -s; }
  }
  return s * sqrt(d);
}

/** Signed distance to the arrow at a stage pixel, in px, with the click bounce. */
fn cursorSD(px : vec2f) -> f32 {
  // Scale about the tip (local origin) so a click bounce pulls toward the
  // hotspot, not the centre. 1.2 fits the 0..1.14 arrow inside the quad.
  let s = u.cursor.z / 1.2;
  let local = (px - u.cursor.xy) / max(s, 1.0) / u.cursorFx.z;
  return sdCursor(local) * s * u.cursorFx.z;
}

@fragment fn fsCursor(in : VsOut) -> @location(0) vec4f {
  let px = in.uv * u.a.xy;
  let blur = u.cursorFx.xy;
  let outline = max(u.cursor.z * 0.05, 1.5); // the arrow's own black rim, in px

  // Fill (white interior) and outline (interior + rim) coverage, both smeared
  // along the travel when the cursor moves fast. No drop shadow — the contrast on
  // a light page is the rim, which is part of the pointer, not a cast shadow.
  var fill = 0.0;
  var edge = 0.0;
  let moving = length(blur) >= 0.5;
  let taps = select(1, 5, moving);
  for (var i = 0; i < taps; i = i + 1) {
    let t = select(0.0, (f32(i) / f32(taps - 1)) - 0.5, moving);
    let d = cursorSD(px + blur * t);
    fill = fill + cover(d);
    edge = edge + cover(d - outline);
  }
  fill = fill / f32(taps);
  edge = edge / f32(taps);

  // White inside, fading to a black rim; `edge` carries the opacity so the rim is
  // solid. The click bounce is already baked into cursorSD.
  let rgb = vec3f(fill / max(edge, 1e-4));
  return vec4f(rgb, edge * u.cursor.w);
}

/**
 * The webcam's mask, morphing with the layout animation: radius drives the shape,
 * circle when docked and rounded rect when grown. The SDF interpolates the SHAPE
 * for free — a tessellated 2D mask would rebuild geometry every frame for this.
 */
fn sampleWebcam(px : vec2f, centre : vec2f) -> vec3f {
  var uv = (px - centre) / max(u.webcam.zw, vec2f(1.0));
  // Cover-fit: a 4:3 source in a square hole would squash without this.
  uv = uv * vec2f(u.b.z, 1.0) + vec2f(0.5);
  return textureSampleBaseClampToEdge(webcamTex, samp, clamp(uv, vec2f(0.0), vec2f(1.0))).rgb;
}

@fragment fn fsWebcam(in : VsOut) -> @location(0) vec4f {
  let px = in.uv * u.a.xy;
  let centre = u.webcam.xy + u.webcam.zw * 0.5;
  let c = cover(sdRoundBox(px - centre, u.webcam.zw * 0.5, u.b.x));
  if (c <= 0.0) {
    discard;
  }
  // Smear along its travel during a layout move, exactly like the recording.
  let blur = u.mb.zw;
  if (length(blur) < 0.5) {
    return vec4f(sampleWebcam(px, centre), c);
  }
  var acc = vec3f(0.0);
  let taps = 5;
  for (var i = 0; i < taps; i = i + 1) {
    let t = (f32(i) / f32(taps - 1)) - 0.5;
    acc = acc + sampleWebcam(px + blur * t, centre);
  }
  return vec4f(acc / f32(taps), c);
}
