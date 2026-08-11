import CoreMedia
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

@available(macOS 13.0, *)
final class AudioStartAlignmentTests: XCTestCase {
	func testRemovesOneTimeCaptureStartupDelay() throws {
		var alignment = AudioStartAlignment(sourceCount: 2)
		let sessionStart = CMTime(seconds: 100, preferredTimescale: 48_000)
		let firstAudio = CMTime(seconds: 100.16, preferredTimescale: 48_000)
		let secondAudio = CMTime(seconds: 100.17, preferredTimescale: 48_000)

		let alignedFirst = try XCTUnwrap(
			alignment.align(firstAudio, forSourceAt: 0, to: sessionStart)
		)
		let alignedSecond = try XCTUnwrap(
			alignment.align(secondAudio, forSourceAt: 0, to: sessionStart)
		)

		XCTAssertEqual(CMTimeCompare(alignedFirst, sessionStart), 0)
		XCTAssertEqual(
			CMTimeGetSeconds(CMTimeSubtract(alignedSecond, alignedFirst)),
			0.01,
			accuracy: 0.000_001
		)
	}

	func testAlignsIndependentAudioOutputsWithoutDiscardingTheirDeltas() throws {
		var alignment = AudioStartAlignment(sourceCount: 2)
		let sessionStart = CMTime(seconds: 50, preferredTimescale: 48_000)
		let systemFirst = CMTime(seconds: 50.12, preferredTimescale: 48_000)
		let microphoneFirst = CMTime(seconds: 50.21, preferredTimescale: 48_000)
		let microphoneLater = CMTime(seconds: 50.71, preferredTimescale: 48_000)

		let alignedSystem = try XCTUnwrap(
			alignment.align(systemFirst, forSourceAt: 0, to: sessionStart)
		)
		let alignedMicrophone = try XCTUnwrap(
			alignment.align(microphoneFirst, forSourceAt: 1, to: sessionStart)
		)
		let alignedMicrophoneLater = try XCTUnwrap(
			alignment.align(microphoneLater, forSourceAt: 1, to: sessionStart)
		)

		XCTAssertEqual(CMTimeCompare(alignedSystem, sessionStart), 0)
		XCTAssertEqual(CMTimeCompare(alignedMicrophone, sessionStart), 0)
		XCTAssertEqual(
			CMTimeGetSeconds(CMTimeSubtract(alignedMicrophoneLater, alignedMicrophone)),
			0.5,
			accuracy: 0.000_001
		)
	}

	func testRejectsInvalidSourceIndex() {
		var alignment = AudioStartAlignment(sourceCount: 1)
		let time = CMTime(seconds: 1, preferredTimescale: 48_000)

		XCTAssertNil(alignment.align(time, forSourceAt: 1, to: time))
	}

	func testPreservesDelayOutsideTheCaptureWarmupWindow() throws {
		var alignment = AudioStartAlignment(sourceCount: 1)
		let sessionStart = CMTime(seconds: 10, preferredTimescale: 48_000)
		let firstAudio = CMTime(seconds: 10.5, preferredTimescale: 48_000)
		let secondAudio = CMTime(seconds: 10.6, preferredTimescale: 48_000)

		let alignedFirst = try XCTUnwrap(
			alignment.align(firstAudio, forSourceAt: 0, to: sessionStart)
		)
		let alignedSecond = try XCTUnwrap(
			alignment.align(secondAudio, forSourceAt: 0, to: sessionStart)
		)

		XCTAssertEqual(CMTimeCompare(alignedFirst, firstAudio), 0)
		XCTAssertEqual(CMTimeCompare(alignedSecond, secondAudio), 0)
	}
}
