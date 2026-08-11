import AVFoundation
import CoreMedia
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

@available(macOS 13.0, *)
final class AudioStartAlignmentTests: XCTestCase {
	func testMixerWaitsForLateEnabledSourceBeforeAdvancingFrameZero() throws {
		var output = [CMSampleBuffer]()
		let mixer = AudioTrackMixer(
			includesSystemAudio: true,
			includesMicrophone: true,
			microphoneGain: 1,
			isOutputReady: { true },
			appendOutput: { output.append($0) }
		)
		let sessionStart = CMTime(seconds: 100, preferredTimescale: 48_000)
		mixer.beginTimeline(at: sessionStart)

		mixer.ingest(
			try makeFloatStereoBuffer(value: 0.1, frames: 480, at: 100.16),
			from: .system
		)
		XCTAssertTrue(output.isEmpty, "system audio must wait for the enabled microphone")

		mixer.ingest(
			try makeFloatStereoBuffer(value: 0.2, frames: 480, at: 100.21),
			from: .microphone
		)

		let firstChunk = try XCTUnwrap(output.first)
		XCTAssertEqual(CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(firstChunk), sessionStart), 0)
		XCTAssertEqual(try firstInt16Sample(in: firstChunk), 9_830, accuracy: 2)
	}

	func testMixerFallsBackWhenEnabledSourceNeverDelivers() throws {
		var output = [CMSampleBuffer]()
		let mixer = AudioTrackMixer(
			includesSystemAudio: true,
			includesMicrophone: true,
			microphoneGain: 1,
			isOutputReady: { true },
			appendOutput: { output.append($0) }
		)
		mixer.beginTimeline(at: CMTime(seconds: 100, preferredTimescale: 48_000))

		mixer.ingest(
			try makeFloatStereoBuffer(value: 0.1, frames: 12_480, at: 100.16),
			from: .system
		)

		XCTAssertFalse(output.isEmpty, "an absent microphone must not stall recording forever")
		XCTAssertEqual(try firstInt16Sample(in: XCTUnwrap(output.first)), 3_277, accuracy: 2)
	}

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

	private func makeFloatStereoBuffer(
		value: Float,
		frames: Int,
		at seconds: Double
	) throws -> CMSampleBuffer {
		var format = AudioStreamBasicDescription(
			mSampleRate: 48_000,
			mFormatID: kAudioFormatLinearPCM,
			mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
			mBytesPerPacket: 8,
			mFramesPerPacket: 1,
			mBytesPerFrame: 8,
			mChannelsPerFrame: 2,
			mBitsPerChannel: 32,
			mReserved: 0
		)
		var description: CMAudioFormatDescription?
		XCTAssertEqual(
			CMAudioFormatDescriptionCreate(
				allocator: kCFAllocatorDefault,
				asbd: &format,
				layoutSize: 0,
				layout: nil,
				magicCookieSize: 0,
				magicCookie: nil,
				extensions: nil,
				formatDescriptionOut: &description
			),
			noErr
		)

		let samples = [Float](repeating: value, count: frames * 2)
		let byteCount = samples.count * MemoryLayout<Float>.size
		var blockBuffer: CMBlockBuffer?
		XCTAssertEqual(
			CMBlockBufferCreateWithMemoryBlock(
				allocator: kCFAllocatorDefault,
				memoryBlock: nil,
				blockLength: byteCount,
				blockAllocator: kCFAllocatorDefault,
				customBlockSource: nil,
				offsetToData: 0,
				dataLength: byteCount,
				flags: kCMBlockBufferAssureMemoryNowFlag,
				blockBufferOut: &blockBuffer
			),
			kCMBlockBufferNoErr
		)
		let resolvedBlockBuffer = try XCTUnwrap(blockBuffer)
		XCTAssertEqual(
			samples.withUnsafeBytes { bytes in
				CMBlockBufferReplaceDataBytes(
					with: bytes.baseAddress!,
					blockBuffer: resolvedBlockBuffer,
					offsetIntoDestination: 0,
					dataLength: byteCount
				)
			},
			kCMBlockBufferNoErr
		)

		var timing = CMSampleTimingInfo(
			duration: CMTime(value: 1, timescale: 48_000),
			presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 48_000),
			decodeTimeStamp: .invalid
		)
		var sampleSize = 8
		var sampleBuffer: CMSampleBuffer?
		XCTAssertEqual(
			CMSampleBufferCreateReady(
				allocator: kCFAllocatorDefault,
				dataBuffer: resolvedBlockBuffer,
				formatDescription: try XCTUnwrap(description),
				sampleCount: frames,
				sampleTimingEntryCount: 1,
				sampleTimingArray: &timing,
				sampleSizeEntryCount: 1,
				sampleSizeArray: &sampleSize,
				sampleBufferOut: &sampleBuffer
			),
			noErr
		)
		return try XCTUnwrap(sampleBuffer)
	}

	private func firstInt16Sample(in sampleBuffer: CMSampleBuffer) throws -> Int16 {
		let blockBuffer = try XCTUnwrap(CMSampleBufferGetDataBuffer(sampleBuffer))
		var value: Int16 = 0
		XCTAssertEqual(
			CMBlockBufferCopyDataBytes(
				blockBuffer,
				atOffset: 0,
				dataLength: MemoryLayout<Int16>.size,
				destination: &value
			),
			kCMBlockBufferNoErr
		)
		return value
	}
}
