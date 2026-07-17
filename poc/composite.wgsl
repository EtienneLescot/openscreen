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
  // webcamRadius | motionBlurPx | webcamCoverScale | optimised(0/1)
  b : vec4f,
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

/** The shadow's quad: the rect, grown by the spread — its exact reach. */
@vertex fn vsScreenShadow(@builtin(vertex_index) i : u32) -> VsOut {
  let s = u.fx.w + 1.0;
  return quad(i, vec4f(u.screen.xy - vec2f(s), u.screen.zw + vec2f(s * 2.0)) + vec4f(0.0, u.fx.z, 0.0, 0.0));
}

@vertex fn vsWebcam(@builtin(vertex_index) i : u32) -> VsOut {
  return quad(i, u.webcam);
}

@vertex fn vsWebcamShadow(@builtin(vertex_index) i : u32) -> VsOut {
  let s = u.fx.w + 1.0;
  return quad(i, vec4f(u.webcam.xy - vec2f(s), u.webcam.zw + vec2f(s * 2.0)) + vec4f(0.0, u.fx.z, 0.0, 0.0));
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
// The shape is known analytically — a rounded rect — so the shadow needs no blur
// pass: the coverage of that box, sampled at a few offsets, IS the shadow. No
// silhouette texture, no ping-pong, no 18 passes.
//
// The quad already bounds it to the rect + spread, so the "outside" case never
// reaches a fragment. What is left is the inside: every tap lands within `spread`
// of the pixel, so within the box SHRUNK by spread they all hit, and the answer
// is `intensity` with no taps at all. That is the box's Minkowski difference with
// the tap disc — the same number by arithmetic, not an approximation. Only the
// band around the edge pays the twelve samples.

fn shadowAt(px : vec2f, rect : vec4f, radius : f32, intensity : f32) -> f32 {
  if (intensity <= 0.0) {
    return 0.0;
  }
  let centre = rect.xy + rect.zw * 0.5 + vec2f(0.0, u.fx.z);
  let half = rect.zw * 0.5;
  let spread = u.fx.w;
  let p = px - centre;

  if (u.b.w > 0.5) {
    if (sdRoundBox(p, max(half - vec2f(spread), vec2f(0.0)), max(radius - spread, 0.0)) < -0.5) {
      return intensity;
    }
  }

  var acc = 0.0;
  let taps = 12;
  let golden = 2.39996;
  for (var i = 0; i < taps; i = i + 1) {
    let fi = f32(i);
    let r = sqrt((fi + 0.5) / f32(taps)) * spread;
    let a = fi * golden;
    let o = vec2f(cos(a), sin(a)) * r;
    acc = acc + cover(sdRoundBox(p + o, half, radius));
  }
  return (acc / f32(taps)) * intensity;
}

@fragment fn fsScreenShadow(in : VsOut) -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, shadowAt(in.uv * u.a.xy, u.screen, u.a.w, u.fx.x));
}

@fragment fn fsWebcamShadow(in : VsOut) -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, shadowAt(in.uv * u.a.xy, u.webcam, u.b.x, u.fx.x * 0.8));
}

// ---- effect 3: the masks + the sources --------------------------------------

/**
 * Directional motion blur while the camera moves. Skipped at rest: a branch is
 * free next to seven texture fetches, and it is uniform across the frame.
 */
fn sampleScreen(px : vec2f, blurPx : f32) -> vec3f {
  let uv0 = (px - u.screen.xy) / max(u.screen.zw, vec2f(1.0));
  if (blurPx < 0.5) {
    return textureSampleBaseClampToEdge(screenTex, samp, clamp(uv0, vec2f(0.0), vec2f(1.0))).rgb;
  }
  var acc = vec3f(0.0);
  let taps = 7;
  for (var i = 0; i < taps; i = i + 1) {
    let t = (f32(i) / f32(taps - 1)) - 0.5;
    let uv = ((px + vec2f(blurPx * t, 0.0)) - u.screen.xy) / max(u.screen.zw, vec2f(1.0));
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
  return vec4f(sampleScreen(px, u.b.y), c);
}

/**
 * The webcam's mask, morphing with the layout animation: radius drives the shape,
 * circle when docked and rounded rect when grown. The SDF interpolates the SHAPE
 * for free — a tessellated 2D mask would rebuild geometry every frame for this.
 */
@fragment fn fsWebcam(in : VsOut) -> @location(0) vec4f {
  let px = in.uv * u.a.xy;
  let centre = u.webcam.xy + u.webcam.zw * 0.5;
  let c = cover(sdRoundBox(px - centre, u.webcam.zw * 0.5, u.b.x));
  if (c <= 0.0) {
    discard;
  }
  // Cover-fit: a 4:3 source in a square hole would squash without this. Sample
  // the middle and let the mask crop, which is what the eye expects.
  var uv = (px - centre) / max(u.webcam.zw, vec2f(1.0));
  uv = uv * vec2f(u.b.z, 1.0) + vec2f(0.5);
  let cam = textureSampleBaseClampToEdge(webcamTex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)));
  return vec4f(cam.rgb, c);
}
