import CoreGraphics
import Foundation
import XCTest

import OpenScreenCaptureCore

/// Does the stream get a buffer the shape and size of what it is about to draw?
///
/// Every case here is the same question asked from a different display, because the answer is
/// only ever wrong on hardware the author did not have: on a 1× display a point size and a
/// pixel size are the same number, so the defect in issue #418 was invisible in every test,
/// every CI run and every dev machine without a Retina panel. What ScreenCaptureKit does with
/// a buffer that does not match — draw the frame in a corner, background the rest black — is
/// quoted in `captureOutputSize`.
final class CaptureSizingTests: XCTestCase {
	/// The app's ceiling, from `useScreenRecorder.ts` (TARGET_WIDTH / TARGET_HEIGHT).
	private let maxWidth = 3840
	private let maxHeight = 2160

	private func size(_ w: CGFloat, _ h: CGFloat, scale: CGFloat) -> (width: Int, height: Int) {
		captureOutputSize(
			contentSize: CGSize(width: w, height: h),
			pointPixelScale: scale,
			maxWidth: maxWidth,
			maxHeight: maxHeight
		)
	}

	// MARK: - The reported bug

	/// Issue #418, on the reporter's hardware: a 14" MacBook Pro built-in panel, whose capture
	/// region is 1512×949 points at 2×. The buffer has to be the full 3024×1898 — but it has to
	/// be that because the *filter* says so, not because a display API happened to agree.
	///
	/// The regression this pins is the other direction: a buffer of 3024×1898 around content
	/// ScreenCaptureKit rasterises at 1512×949 puts the whole desktop in one corner of a black
	/// frame, which is what the reporter saw in the editor — and, being baked into the file, on
	/// export too.
	func testRetinaDisplayGetsTheFullPixelBuffer() {
		let result = size(1512, 949, scale: 2)
		XCTAssertEqual(result.width, 3024)
		XCTAssertEqual(result.height, 1898)
	}

	/// The same panel described in points but reported at 1× — the shape must survive, because
	/// a buffer of the right shape is what keeps the frame from being letterboxed into it.
	func testNonRetinaDisplayIsUnchanged() {
		let result = size(1920, 1080, scale: 1)
		XCTAssertEqual(result.width, 1920)
		XCTAssertEqual(result.height, 1080)
	}

	/// Aspect ratio is the property that decides whether a downscale fills the buffer or leaves
	/// bars, so it is asserted directly rather than inferred from the two dimensions.
	func testAspectRatioSurvivesEveryScale() {
		for scale in [CGFloat(1), 2, 3] {
			let result = size(1512, 949, scale: scale)
			XCTAssertEqual(
				Double(result.width) / Double(result.height),
				1512.0 / 949.0,
				accuracy: 0.002,
				"scale \(scale) changed the shape of the buffer"
			)
		}
	}

	// MARK: - The ceiling

	/// A 5K panel at 2× wants 10240×5416, far over the app's 4K ceiling. Capping is fine; capping
	/// each axis on its own is not, because it hands the stream a buffer of a different shape
	/// than the frame and the surplus comes back as black bars.
	func testOversizedContentIsScaledDownProportionally() {
		let result = size(2560, 1354, scale: 2)
		XCTAssertLessThanOrEqual(result.width, maxWidth)
		XCTAssertLessThanOrEqual(result.height, maxHeight)
		XCTAssertEqual(result.width, 3840)
		XCTAssertEqual(
			Double(result.width) / Double(result.height),
			2560.0 / 1354.0,
			accuracy: 0.002
		)
	}

	/// The reporter's second monitor: 5120×1440 at 1×. Only the WIDTH is over the ceiling, and
	/// this is exactly the case a per-axis clamp gets wrong — it would answer 3840×1440, a 2.67
	/// buffer for a 3.56 frame, and ScreenCaptureKit would draw 3840×1080 with 180 black rows
	/// above and below.
	func testUltrawideIsNotSquashedByTheWidthCap() {
		let result = size(5120, 1440, scale: 1)
		XCTAssertEqual(result.width, 3840)
		XCTAssertEqual(result.height, 1080)
	}

	/// Under the ceiling on both axes, nothing is touched.
	func testContentBelowTheCeilingIsNotScaled() {
		let result = size(1280, 800, scale: 2)
		XCTAssertEqual(result.width, 2560)
		XCTAssertEqual(result.height, 1600)
	}

	// MARK: - Encoder constraints and degenerate input

	/// H.264 chroma subsampling needs both dimensions even; the encoder rejects the frame
	/// otherwise. An odd point size at 1× is the way to get there.
	func testDimensionsAreAlwaysEven() {
		let result = size(1023, 767, scale: 1)
		XCTAssertEqual(result.width % 2, 0)
		XCTAssertEqual(result.height % 2, 0)
		XCTAssertEqual(result.width, 1022)
		XCTAssertEqual(result.height, 766)
	}

	/// A filter that reports nothing usable must still yield an encodable buffer rather than a
	/// zero-sized one — the ceiling is the only value left that is known good.
	func testDegenerateContentFallsBackToTheCeiling() {
		for bad in [CGSize.zero, CGSize(width: CGFloat.nan, height: 1080), CGSize(width: -100, height: -100)] {
			let result = captureOutputSize(
				contentSize: bad,
				pointPixelScale: 2,
				maxWidth: maxWidth,
				maxHeight: maxHeight
			)
			XCTAssertEqual(result.width, maxWidth, "\(bad)")
			XCTAssertEqual(result.height, maxHeight, "\(bad)")
		}
	}

	/// A scale of 0 or NaN means "the filter could not tell us", and 1× is the only reading that
	/// cannot make the buffer bigger than the frame.
	func testUnusableScaleFallsBackToOne() {
		for scale in [CGFloat(0), -2, .nan] {
			let result = size(1920, 1080, scale: scale)
			XCTAssertEqual(result.width, 1920, "scale \(scale)")
			XCTAssertEqual(result.height, 1080, "scale \(scale)")
		}
	}
}
