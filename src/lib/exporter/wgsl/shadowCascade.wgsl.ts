// The drop shadow, computed — not cached.
//
// The Canvas2D path chains three CSS drop-shadows over the video, at 14.2 ms per
// moving frame (Annex B.1), and caches the result by geometry to avoid paying it.
// That cache is a 2D artefact: it exists because the filter is expensive, and a
// moving camera — which the product says is the norm — misses it by construction.
// On the GPU there is nothing to cache: the shadow is redrawn every frame.
//
// EXACTNESS is the constraint (§13). The ban is on approximating the falloff with
// an SDF/smoothstep — a DIFFERENT shape. It is not a ban on another implementation
// of the same shape. CSS `drop-shadow(0 dy blur rgba)` is feGaussianBlur on
// SourceAlpha with stdDeviation = blur/2, and the SVG filter spec defines that,
// for our radii, as three successive BOX blurs of a stated width:
//
//   d = floor(s * 3 * sqrt(2*PI) / 4 + 0.5)
//   d odd  : three box-blurs of width d, centred.
//   d even : two box-blurs of width d (centred left, then right), then one of d+1.
//
// That is what runs below — the spec's own algorithm, on the device that suits it.
// Box blurs are separable and cheap here; nothing is approximated.
//
// Whether Chromium's Skia follows the spec's letter is NOT assumed: the pixel-diff
// against the Canvas2D output is the gate, and it is what makes this file
// falsifiable rather than merely plausible.

/** One CSS drop-shadow stage: blur radius (px), y offset (px), alpha. */
export interface ShadowStage {
	blur: number;
	offsetY: number;
	alpha: number;
}

/**
 * The three stages, matching shadowFilterChain() in frameRenderer.ts exactly.
 *
 * Duplicated deliberately rather than imported: the Canvas2D chain is the thing
 * under test, and a shared constant would make the two agree by construction and
 * prove nothing. If they drift, the pixel-diff must fail.
 */
export function shadowStages(intensity: number): ShadowStage[] {
	const offset = 12 * intensity;
	return [
		{ blur: 48 * intensity, offsetY: offset, alpha: 0.7 * intensity },
		{ blur: 16 * intensity, offsetY: offset / 3, alpha: 0.5 * intensity },
		{ blur: 8 * intensity, offsetY: offset / 6, alpha: 0.3 * intensity },
	];
}

/**
 * The SVG filter spec's box widths for a gaussian of stdDeviation `s`.
 *
 * Returns the three box widths and their centring offsets. The even case is the
 * subtle one: the spec compensates a box of even width by centring it left, then
 * right, then widening the third — which is why this is a table and not a loop.
 */
export function boxesForStdDeviation(s: number): { width: number; offset: number }[] {
	if (s <= 0) return [];
	const d = Math.floor((s * 3 * Math.sqrt(2 * Math.PI)) / 4 + 0.5);
	if (d < 1) return [];
	if (d % 2 === 1) {
		const half = (d - 1) / 2;
		return [
			{ width: d, offset: -half },
			{ width: d, offset: -half },
			{ width: d, offset: -half },
		];
	}
	return [
		{ width: d, offset: -d / 2 },
		{ width: d, offset: -d / 2 + 1 },
		{ width: d + 1, offset: -d / 2 },
	];
}

/** stdDeviation of a CSS drop-shadow's blur radius. */
export const stdDeviationForBlur = (blur: number) => blur / 2;

export const SHADOW_WGSL = /* wgsl */ `

// All-vec4, for the same reason as composite.wgsl.ts: no alignment holes for the
// CPU packing to get wrong. The first version declared (vec2f, vec4f, f32, f32)
// and WGSL laid it out at 48 bytes with a hole at 8 — against a 32-byte buffer.
// That is a validation error, a black frame, and no exception anywhere.
struct SilhouetteU {
  // stage.xy | radius | unused
  a : vec4f,
  // rect: x, y, w, h
  rect : vec4f,
};

struct BlurU {
  // Texel step: (1/width, 0) horizontal, (0, 1/height) vertical.
  step : vec2f,
  // Box width in texels, and where the box starts relative to the pixel.
  width : i32,
  offset : i32,
};

struct StageU {
  // offsetY (in texels, along v) | alpha | unused | unused
  a : vec4f,
};

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

// ---- pass 1: the silhouette -------------------------------------------------
// The alpha the CSS chain actually blurs. The video is opaque and masked by a
// rounded rect, so its alpha IS that rounded rect — no video pixel takes part.

@group(0) @binding(0) var<uniform> su : SilhouetteU;

fn sdRoundBox(p : vec2f, halfSize : vec2f, r : f32) -> f32 {
  let rr = min(r, min(halfSize.x, halfSize.y));
  let q = abs(p) - halfSize + vec2f(rr);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rr;
}

@fragment
fn fsSilhouette(in : VsOut) -> @location(0) vec4f {
  let px = in.uv * su.a.xy;
  let d = sdRoundBox(px - (su.rect.xy + su.rect.zw * 0.5), su.rect.zw * 0.5, su.a.z);
  let a = clamp(0.5 - d, 0.0, 1.0);
  return vec4f(0.0, 0.0, 0.0, a);
}

// ---- pass 2: one box blur, one axis ----------------------------------------
// Separable, so a d x d box costs 2d taps rather than d*d. Three of these per
// gaussian, per the SVG spec.

@group(0) @binding(0) var<uniform> bu : BlurU;
@group(0) @binding(1) var blurSamp : sampler;
@group(0) @binding(2) var blurSrc : texture_2d<f32>;

@fragment
fn fsBox(in : VsOut) -> @location(0) vec4f {
  var acc = vec4f(0.0);
  for (var i = 0; i < bu.width; i = i + 1) {
    let o = f32(bu.offset + i);
    acc = acc + textureSample(blurSrc, blurSamp, in.uv + bu.step * o);
  }
  return acc / f32(bu.width);
}

// ---- pass 3: one cascade stage ---------------------------------------------
// stage_out = source OVER shadow(source), where shadow is the blurred alpha,
// offset down and tinted. Each stage shadows the PREVIOUS stage's output — its
// own shadow included. That cascade is what gives the falloff, and it is why
// this cannot collapse into a single blur.

@group(0) @binding(0) var<uniform> stu : StageU;
@group(0) @binding(1) var stageSamp : sampler;
@group(0) @binding(2) var stageSrc : texture_2d<f32>;   // the un-blurred source
@group(0) @binding(3) var stageBlur : texture_2d<f32>;  // its blurred alpha

@fragment
fn fsStage(in : VsOut) -> @location(0) vec4f {
  let src = textureSample(stageSrc, stageSamp, in.uv);
  let shadowAlpha = textureSample(stageBlur, stageSamp, in.uv - vec2f(0.0, stu.a.x)).a * stu.a.y;
  // src is black-tinted throughout, so only alpha needs compositing.
  let a = src.a + shadowAlpha * (1.0 - src.a);
  return vec4f(0.0, 0.0, 0.0, a);
}

// ---- pass 4: strip the silhouette ------------------------------------------
// The cascade's output is "silhouette OVER shadows". The compositor draws the
// recording on top, which covers the silhouette exactly — but only where the
// recording is opaque. Subtracting it here keeps the shadow honest under the
// antialiased corners instead of double-darkening them.

@group(0) @binding(0) var<uniform> fu : SilhouetteU;
@group(0) @binding(1) var finalSamp : sampler;
@group(0) @binding(2) var finalSrc : texture_2d<f32>;

@fragment
fn fsStrip(in : VsOut) -> @location(0) vec4f {
  let px = in.uv * fu.a.xy;
  let d = sdRoundBox(px - (fu.rect.xy + fu.rect.zw * 0.5), fu.rect.zw * 0.5, fu.a.z);
  let sil = clamp(0.5 - d, 0.0, 1.0);
  let a = textureSample(finalSrc, finalSamp, in.uv).a;
  return vec4f(0.0, 0.0, 0.0, max(a - sil, 0.0));
}
`;
