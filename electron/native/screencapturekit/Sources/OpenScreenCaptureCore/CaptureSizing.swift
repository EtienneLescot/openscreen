import CoreGraphics
import Foundation

/// How big the ScreenCaptureKit output buffer has to be, given the content the stream will
/// actually rasterise.
///
/// # Why this is not "the size of the display"
///
/// `SCStreamConfiguration.width`/`height` are **pixels**, and ScreenCaptureKit will not
/// enlarge a smaller source to fill them. `scalesToFit` defaults to `false`, and the SDK
/// header is explicit about what that means: *"When true, the output scales up and down. When
/// false, the output only scales down."* Configure a buffer bigger than the source and the
/// frame is drawn at its native size in one corner of it, with the background — black —
/// everywhere else. The recording is then a small picture inside a large black rectangle, at
/// full file resolution, for its entire duration (issue #418).
///
/// The size the stream rasterises is a property of the `SCContentFilter`: its `contentRect`
/// (points) times its `pointPixelScale`. That product is the only correct value for
/// `width`/`height`. A display size read from CoreGraphics is not: `CGDisplayPixelsWide` is
/// documented in "pixel units" but tracks the display *mode*, so on a Retina Mac it can report
/// a number that is neither what the filter measures nor what the stream draws — and nothing
/// downstream reconciles the two. On a 1× display the two agree, which is exactly why this
/// only ever showed up on HiDPI machines.
///
/// # Why the cap is proportional
///
/// The caller carries a ceiling (the app asks for at most 4K). Clamping each axis on its own
/// changes the *shape* of the buffer, and a buffer whose aspect ratio differs from the source
/// hits the same wall from the other side: `scalesToFit == false` still scales down, but it
/// preserves aspect, so the surplus becomes black bars. A 5120×1440 ultrawide capped to
/// 3840×1440 per axis is drawn as 3840×1080 with 180 black rows above and below it. Scaling
/// both axes by one factor keeps the buffer the same shape as the source, so the downscale
/// fills it.
///
/// - Parameters:
///   - contentSize: `SCContentFilter.contentRect.size` — the captured region, in points.
///   - pointPixelScale: `SCContentFilter.pointPixelScale` — points-to-pixels for that region.
///   - maxWidth: Ceiling for the returned width, in pixels.
///   - maxHeight: Ceiling for the returned height, in pixels.
/// - Returns: Even, positive pixel dimensions with the source's aspect ratio.
public func captureOutputSize(
	contentSize: CGSize,
	pointPixelScale: CGFloat,
	maxWidth: Int,
	maxHeight: Int
) -> (width: Int, height: Int) {
	// The ceiling is the one value we can never exceed, so it is also the only sane answer for
	// a filter that reports nothing usable — better a correctly-shaped guess than a buffer the
	// stream will corner its frame into.
	let ceilingWidth = evenFloor(max(2, maxWidth))
	let ceilingHeight = evenFloor(max(2, maxHeight))

	let scale = pointPixelScale.isFinite && pointPixelScale > 0 ? pointPixelScale : 1
	let pixelWidth = contentSize.width.isFinite ? contentSize.width * scale : 0
	let pixelHeight = contentSize.height.isFinite ? contentSize.height * scale : 0
	guard pixelWidth >= 1, pixelHeight >= 1 else {
		return (ceilingWidth, ceilingHeight)
	}

	// One factor for both axes: see the note above on why a per-axis clamp reintroduces the
	// very padding this function exists to remove.
	let fit = min(1, min(CGFloat(ceilingWidth) / pixelWidth, CGFloat(ceilingHeight) / pixelHeight))
	return (
		evenFloor(Int((pixelWidth * fit).rounded())),
		evenFloor(Int((pixelHeight * fit).rounded()))
	)
}

/// Nearest even value at or below `value`, floored at 2 — H.264 chroma subsampling needs both
/// dimensions even, and the encoder rejects zero.
private func evenFloor(_ value: Int) -> Int {
	let clamped = max(2, value)
	return clamped - (clamped % 2)
}
