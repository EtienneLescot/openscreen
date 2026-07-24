// The compositor: one WGSL program, one draw call, every pixel of the frame.
//
// WGSL and not GLSL/Pixi on purpose (rendering-architecture.md §12): this text
// runs unmodified in the browser (WebGPU) and natively (wgpu), so the shader and
// the evaluator — the product's actual substance — stay portable, and the host
// question stays a bindings swap rather than an architectural bet.
//
// Everything here is a pure function of the uniforms. There is no cache, and that
// is the point: a shader recomputes 2 Mpx per frame at a cost the Canvas2D path
// paid to AVOID recomputing. The 2D cache existed because a CSS filter cost 14 ms;
// the paradigm does not carry over.
//
// The shadow is the exception worth reading (see shadowCascade.wgsl.ts): it needs
// a real blur, so it is prepared in its own passes and sampled here.

export const COMPOSITE_WGSL = /* wgsl */ `

/**
 * Every member is a vec4f, and that is deliberate.
 *
 * WGSL aligns a vec4f to 16 bytes and a vec2f to 8, so a struct of mixed scalars
 * and vectors has padding holes the CPU side must reproduce EXACTLY — get one
 * offset wrong and the shader reads a radius where a rectangle should be, draws
 * nothing, and reports no error. (It happened: the first version of this file
 * packed 24 sequential floats against a struct whose real layout was 128 bytes
 * with holes at 8, 36 and 92.) All-vec4 has no holes to get wrong: field n is at
 * byte 16n, always. Flags travel as floats for the same reason — no u32/f32
 * interleaving to mis-pack.
 */
struct Uniforms {
  // stage.xy | videoRadius | shadowIntensity
  a : vec4f,
  // The recording's box AFTER the camera: x, y, w, h
  videoRect : vec4f,
  // Source crop, normalised: x, y, w, h
  crop : vec4f,
  // Webcam destination: x, y, w, h
  webcamRect : vec4f,
  // webcamRadius | motionBlur.x | motionBlur.y | unused
  b : vec4f,
  // webcamShape | webcamMirrored | hasWebcam | hasShadow   (0/1 as floats)
  flags : vec4f,
  // Webcam source sub-rect — the cover crop, normalised: x, y, w, h
  webcamSrc : vec4f,
};

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var videoTex : texture_external;
@group(0) @binding(3) var webcamTex : texture_external;
@group(0) @binding(4) var bgTex : texture_2d<f32>;
@group(0) @binding(5) var shadowTex : texture_2d<f32>;

struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

// Full-screen triangle. No vertex buffer: three points, clipped to the viewport.
@vertex
fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  var out : VsOut;
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  out.uv = vec2f(x, y);
  out.pos = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  return out;
}

/**
 * Signed distance to a rounded box, negative inside.
 *
 * This is geometry, not a shadow approximation: it decides which pixels the
 * recording covers, exactly as the Canvas2D mask's rounded rect did. §13's ban is
 * on approximating the shadow's FALLOFF with an SDF, and this never touches it.
 */
fn sdRoundBox(p : vec2f, halfSize : vec2f, r : f32) -> f32 {
  let rr = min(r, min(halfSize.x, halfSize.y));
  let q = abs(p) - halfSize + vec2f(rr);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rr;
}

/** Coverage of a shape at a pixel, antialiased over one pixel of distance. */
fn coverage(dist : f32) -> f32 {
  return clamp(0.5 - dist, 0.0, 1.0);
}

fn shapeDistance(px : vec2f, rect : vec4f, radius : f32, shape : f32) -> f32 {
  let centre = rect.xy + rect.zw * 0.5;
  let half = rect.zw * 0.5;
  let p = px - centre;
  if (shape > 1.5 && shape < 2.5) {
    // Circle: an ellipse inscribed in the rect, so a non-square webcam still
    // masks to the shape the layout asked for.
    let n = p / max(half, vec2f(1.0));
    return (length(n) - 1.0) * min(half.x, half.y);
  }
  if (shape > 2.5) {
    let s = min(half.x, half.y);
    return sdRoundBox(p, vec2f(s), 0.0);
  }
  if (shape > 0.5) {
    return sdRoundBox(p, half, radius);
  }
  return sdRoundBox(p, half, 0.0);
}

/** Map a stage pixel to the recording's source UV, through the crop. */
fn videoUv(px : vec2f) -> vec2f {
  let local = (px - u.videoRect.xy) / max(u.videoRect.zw, vec2f(1.0));
  return u.crop.xy + local * u.crop.zw;
}

fn sampleVideo(px : vec2f) -> vec4f {
  return textureSampleBaseClampToEdge(videoTex, samp, videoUv(px));
}

/**
 * The recording, with directional motion blur when the camera is moving.
 *
 * Taps are skipped entirely at rest — the common case must not pay for the rare
 * one, and a branch is free next to nine texture fetches.
 */
fn sampleVideoBlurred(px : vec2f) -> vec4f {
  let motion = u.b.yz;
  if (length(motion) < 0.5) {
    return sampleVideo(px);
  }
  var acc = vec4f(0.0);
  let taps = 9;
  for (var i = 0; i < taps; i = i + 1) {
    let t = (f32(i) / f32(taps - 1)) - 0.5;
    acc = acc + sampleVideo(px + motion * t);
  }
  return acc / f32(taps);
}

fn overComposite(dst : vec4f, src : vec4f) -> vec4f {
  let a = src.a + dst.a * (1.0 - src.a);
  let rgb = src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a);
  return vec4f(select(rgb / a, vec3f(0.0), a <= 0.0), a);
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4f {
  let px = in.uv * u.a.xy;

  // 1. Background. Pre-blurred at init if the document asks for blur: it is a
  //    still image, so blurring it per frame would be work with no output.
  var colour = textureSample(bgTex, samp, in.uv);
  colour = vec4f(colour.rgb, 1.0);

  // 2. Shadow, prepared by the cascade passes. Under everything, cut to nothing
  //    where the recording will cover it anyway.
  if (u.flags.w > 0.5) {
    let s = textureSample(shadowTex, samp, in.uv).a;
    colour = overComposite(colour, vec4f(0.0, 0.0, 0.0, s));
  }

  // 3. The recording: rounded, masked, motion-blurred.
  let vd = sdRoundBox(
    px - (u.videoRect.xy + u.videoRect.zw * 0.5),
    u.videoRect.zw * 0.5,
    u.a.z
  );
  let vc = coverage(vd);
  if (vc > 0.0) {
    let video = sampleVideoBlurred(px);
    colour = overComposite(colour, vec4f(video.rgb, vc));
  }

  // 4. The webcam, on top, in its own shape.
  if (u.flags.z > 0.5) {
    let wd = shapeDistance(px, u.webcamRect, u.b.x, u.flags.x);
    let wc = coverage(wd);
    if (wc > 0.0) {
      var wuv = (px - u.webcamRect.xy) / max(u.webcamRect.zw, vec2f(1.0));
      if (u.flags.y > 0.5) {
        wuv.x = 1.0 - wuv.x;
      }
      // Through the cover crop: the box's aspect ratio is not the camera's (a block
      // layout hands it a column slot, Full Camera walks it out to the whole frame),
      // so the box selects a sub-rect of the source rather than stretching all of it.
      let wsrc = u.webcamSrc.xy + clamp(wuv, vec2f(0.0), vec2f(1.0)) * u.webcamSrc.zw;
      let cam = textureSampleBaseClampToEdge(webcamTex, samp, wsrc);
      colour = overComposite(colour, vec4f(cam.rgb, wc));
    }
  }

  return vec4f(colour.rgb, 1.0);
}
`;
