// Native compositor — the same WGSL as the web POC, adapted for native wgpu.
//
// Two changes only, both because `texture_external` is a WebGPU-only feature that
// native wgpu does not have:
//   texture_external            -> texture_2d<f32>
//   textureSampleBaseClampToEdge -> textureSampleLevel(..., 0.0)
// Everything else — the geometry, the erf Gaussian shadow, the cursor SDF — is
// byte-for-byte the browser shader. That is the portability the whole bet rests
// on: the product's substance moves to native unchanged.
//
// Single pass here (not the web POC's 6 culled quads): natively the compositor is
// nowhere near the bottleneck, so the quad-culling buys nothing and the one
// fragment shader is simpler.

struct U {
  // stage.xy | time | screenRadius
  a : vec4f,
  // screenRect x,y,w,h (carries zoom)
  screen : vec4f,
  // webcamRect x,y,w,h (carries layout animation)
  webcam : vec4f,
  // shadowIntensity | bgBlurPx(unused native) | shadowOffsetY | shadowSigma
  fx : vec4f,
  // webcamRadius | motionBlur baked elsewhere | webcamCoverScale | unused
  b : vec4f,
  // screenBlur.xy | webcamBlur.xy
  mb : vec4f,
  // cursor x | y | size | opacity
  cursor : vec4f,
  // cursorBlur.xy | clickScale | unused
  cursorFx : vec4f,
};

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var screenTex : texture_2d<f32>;
@group(0) @binding(3) var webcamTex : texture_2d<f32>;

struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  var out : VsOut;
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  out.uv = vec2f(x, y);
  out.pos = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  return out;
}

fn sdRoundBox(p : vec2f, half : vec2f, r : f32) -> f32 {
  let rr = min(r, min(half.x, half.y));
  let q = abs(p) - half + vec2f(rr);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rr;
}
fn cover(d : f32) -> f32 { return clamp(0.5 - d, 0.0, 1.0); }
fn over(dst : vec3f, src : vec3f, a : f32) -> vec3f { return mix(dst, src, clamp(a, 0.0, 1.0)); }

// ---- background: computed gradient ----
fn gradient(uv : vec2f) -> vec3f {
  let a = vec3f(0.06, 0.11, 0.24);
  let b = vec3f(0.35, 0.12, 0.42);
  let c = vec3f(0.02, 0.35, 0.38);
  let w = 0.5 + 0.5 * sin(uv.x * 2.0);
  return mix(mix(a, b, uv.y), c, w * 0.45);
}

// ---- shadow: analytic Gaussian (erf), same as web ----
const SQRT_2PI = 2.5066282746310002;
const INV_SQRT_2 = 0.7071067811865476;
fn gauss1(x : f32, sigma : f32) -> f32 { return exp(-(x * x) / (2.0 * sigma * sigma)) / (SQRT_2PI * sigma); }
fn erf2(x : vec2f) -> vec2f {
  let s = sign(x); let a = abs(x);
  var r = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  r = r * r; return s - s / (r * r);
}
fn shadowRowX(x : f32, y : f32, sigma : f32, corner : f32, half : vec2f) -> f32 {
  let d = min(half.y - corner - abs(y), 0.0);
  let curved = half.x - corner + sqrt(max(0.0, corner * corner - d * d));
  let integral = 0.5 + 0.5 * erf2((x + vec2f(-curved, curved)) * (INV_SQRT_2 / sigma));
  return integral.y - integral.x;
}
fn shadowAt(px : vec2f, rect : vec4f, radius : f32, intensity : f32) -> f32 {
  if (intensity <= 0.0) { return 0.0; }
  let sigma = max(u.fx.w, 0.5);
  let half = rect.zw * 0.5;
  let corner = min(radius, min(half.x, half.y));
  let p = px - (rect.xy + half + vec2f(0.0, u.fx.z));
  let low = p.y - half.y; let high = p.y + half.y;
  let start = clamp(-3.0 * sigma, low, high);
  let end = clamp(3.0 * sigma, low, high);
  let step = (end - start) / 4.0;
  var y = start + step * 0.5; var value = 0.0;
  for (var i = 0; i < 4; i = i + 1) {
    value = value + shadowRowX(p.x, p.y - y, sigma, corner, half) * gauss1(y, sigma) * step;
    y = y + step;
  }
  return clamp(value, 0.0, 1.0) * intensity;
}

// ---- sources ----
fn sampleScreen(px : vec2f, blur : vec2f) -> vec3f {
  let uv0 = (px - u.screen.xy) / max(u.screen.zw, vec2f(1.0));
  if (length(blur) < 0.5) {
    return textureSampleLevel(screenTex, samp, clamp(uv0, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  }
  var acc = vec3f(0.0); let taps = 7;
  for (var i = 0; i < taps; i = i + 1) {
    let t = (f32(i) / f32(taps - 1)) - 0.5;
    let uv = ((px + blur * t) - u.screen.xy) / max(u.screen.zw, vec2f(1.0));
    acc = acc + textureSampleLevel(screenTex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  }
  return acc / f32(taps);
}
fn sampleWebcam(px : vec2f, centre : vec2f) -> vec3f {
  var uv = (px - centre) / max(u.webcam.zw, vec2f(1.0));
  uv = uv * vec2f(u.b.z, 1.0) + vec2f(0.5);
  return textureSampleLevel(webcamTex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
}

// ---- cursor: arrow polygon SDF ----
fn sdCursor(p : vec2f) -> f32 {
  var v = array<vec2f, 7>(
    vec2f(0.00, 0.00), vec2f(0.00, 1.00), vec2f(0.24, 0.76),
    vec2f(0.40, 1.14), vec2f(0.56, 1.07), vec2f(0.39, 0.69), vec2f(0.70, 0.69),
  );
  var d = dot(p - v[0], p - v[0]); var s = 1.0;
  for (var i = 0; i < 7; i = i + 1) {
    let j = (i + 6) % 7;
    let e = v[j] - v[i]; let w = p - v[i];
    let b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    let c0 = p.y >= v[i].y; let c1 = p.y < v[j].y; let c2 = e.x * w.y > e.y * w.x;
    if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) { s = -s; }
  }
  return s * sqrt(d);
}
fn cursorFill(px : vec2f, shrink : f32) -> f32 {
  let s = u.cursor.z / 1.2;
  let local = (px - u.cursor.xy) / max(s, 1.0) / u.cursorFx.z;
  return cover((sdCursor(local) * s * u.cursorFx.z) - shrink);
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4f {
  let px = in.uv * u.a.xy;

  // 1. background
  var colour = gradient(in.uv);

  // 2. screen shadow (analytic Gaussian)
  colour = over(colour, vec3f(0.0), shadowAt(px, u.screen, u.a.w, u.fx.x));

  // 3. screen (zoom + motion blur + rounded mask)
  let sc = cover(sdRoundBox(px - (u.screen.xy + u.screen.zw * 0.5), u.screen.zw * 0.5, u.a.w));
  if (sc > 0.0) { colour = over(colour, sampleScreen(px, u.mb.xy), sc); }

  // 4. webcam shadow + webcam (shape morphs via radius)
  colour = over(colour, vec3f(0.0), shadowAt(px, u.webcam, u.b.x, u.fx.x * 0.8));
  let centre = u.webcam.xy + u.webcam.zw * 0.5;
  let wc = cover(sdRoundBox(px - centre, u.webcam.zw * 0.5, u.b.x));
  if (wc > 0.0) { colour = over(colour, sampleWebcam(px, centre), wc); }

  // 5. cursor: white fill + black rim, motion-blurred, click-bounced
  let outline = max(u.cursor.z * 0.05, 1.5);
  let fill = cursorFill(px, 0.0);
  let edge = cursorFill(px, outline);
  if (edge > 0.001) {
    let rgb = vec3f(fill / max(edge, 1e-4));
    colour = over(colour, rgb, edge * u.cursor.w);
  }

  return vec4f(colour, 1.0);
}
