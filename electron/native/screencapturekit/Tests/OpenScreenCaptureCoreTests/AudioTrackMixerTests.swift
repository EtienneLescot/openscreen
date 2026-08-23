import AVFoundation
import CoreMedia
import Foundation
import XCTest

import OpenScreenCaptureCore

/// Does a sound land where it happened, and does the track cover the whole take?
///
/// These drive `AudioTrackMixer` through a sink that keeps the mixed buffers instead of a
/// writer that encodes them, and through a clock the test moves by hand instead of the host
/// clock. Both substitutions are what make the assertions exact: an AAC encoder would fold its
/// priming delay into every timestamp, and a real clock would make "four seconds in" mean
/// "four seconds in, give or take the scheduler".
///
/// `scripts/test-macos-audio-timeline.mjs` asks the same questions of the real helper, with a
/// real tone through the real speakers. That one measures the machine; this one measures the
/// code, and is the half that can run on a pull request.
final class AudioTrackMixerTests: XCTestCase {
	private let sampleRate = 48_000
	private let channelCount = 2
	/// Well above the Int16 quantization floor, well below the 0.5 bursts these feed in.
	private let audibleThreshold: Int16 = 1_000

	// MARK: - Leading silence

	/// The regression that closed PR #343 and the one Windows fixed in `7e6cde3f`: a take that
	/// begins in silence used to anchor frame zero to the first buffer that showed up, so a
	/// sound played four seconds in was heard from the very start and the track came out four
	/// seconds short.
	func testLeadingSilenceIsInTheFileRatherThanSkipped() {
		let sink = RecordingSink()
		let clock = TestClock(CMTime(value: 50, timescale: 1))
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: false)
		mixer.beginTimeline(at: clock.now)

		// Four seconds of nothing at all — no buffer from any source.
		clock.advance(seconds: 4)
		mixer.tick()

		mixer.ingest(
			makeSourceBuffer(
				burst(seconds: 0.5, left: 0.5, right: 0.5),
				at: clock.now,
				nonInterleaved: true
			),
			from: .system
		)
		clock.advance(seconds: 0.5)
		mixer.tick()
		clock.advance(seconds: 1.5)
		mixer.finish(atSourceTime: clock.now)

		let frames = mixedFrames(sink)
		XCTAssertEqual(sink.buffers.first?.presentationTimeStamp, CMTime(value: 50, timescale: 1))
		assertContiguous(sink)
		XCTAssertEqual(seconds(ofFrames: frames), 6.0, accuracy: 0.011)
		XCTAssertEqual(firstAudibleSecond(frames) ?? -1, 4.0, accuracy: 0.001)
		XCTAssertEqual(peak(frames, from: 0, to: 4.0), 0, "the leading silence has to be silent")
	}

	/// The other half of the same anchor: audio captured *before* the writer session started is
	/// trimmed at frame zero. Moving the origin back to meet it would drag the whole take with
	/// it, and the writer would reject it anyway.
	func testAudioBeforeTheSessionStartIsTrimmedRatherThanMovingTheOrigin() {
		let sink = RecordingSink()
		let sessionStart = CMTime(value: 50, timescale: 1)
		let clock = TestClock(sessionStart)
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: false)
		mixer.beginTimeline(at: sessionStart)

		// 200 ms of audio, half of it captured before the session opened.
		mixer.ingest(
			makeSourceBuffer(
				burst(seconds: 0.2, left: 0.5, right: 0.5),
				at: CMTimeSubtract(sessionStart, CMTime(value: 100, timescale: 1_000)),
				nonInterleaved: true
			),
			from: .system
		)
		clock.advance(seconds: 0.1)
		mixer.finish(atSourceTime: clock.now)

		let frames = mixedFrames(sink)
		XCTAssertEqual(sink.buffers.first?.presentationTimeStamp, sessionStart)
		XCTAssertEqual(seconds(ofFrames: frames), 0.1, accuracy: 0.011)
		XCTAssertGreaterThan(peak(frames, from: 0, to: 0.1), audibleThreshold)

		// The 100 ms that predates the origin is accounted as trimmed, never as dropped. Both
		// are cut by the same code, and counting them together is what made `droppedSeconds`
		// non-zero on every real take and unusable as a fault signal.
		let report = mixer.deliveryReport(for: .system)
		XCTAssertEqual(report.trimmedSeconds, 0.1, accuracy: 0.011)
		XCTAssertEqual(report.droppedSeconds, 0, accuracy: 0.011)
	}

	// MARK: - Trailing silence

	/// `drain()` used to run only from `ingest` and `finish`, and nothing called
	/// `endSession(atSourceTime:)`, so the track ended at the last sample anything delivered.
	/// A ten-second take that went quiet at two seconds produced two seconds of audio.
	func testTrailingSilenceIsInTheFileRatherThanTruncated() {
		let sink = RecordingSink()
		let clock = TestClock(.zero)
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: false)
		mixer.beginTimeline(at: clock.now)

		mixer.ingest(
			makeSourceBuffer(burst(seconds: 2, left: 0.5, right: 0.5), at: clock.now, nonInterleaved: true),
			from: .system
		)
		clock.advance(seconds: 2)
		mixer.tick()

		// Eight more seconds of take, with the source delivering nothing at all.
		clock.advance(seconds: 8)
		mixer.finish(atSourceTime: clock.now)

		let frames = mixedFrames(sink)
		assertContiguous(sink)
		XCTAssertEqual(seconds(ofFrames: frames), 10.0, accuracy: 0.011)
		XCTAssertGreaterThan(peak(frames, from: 0, to: 2.0), audibleThreshold)
		XCTAssertEqual(peak(frames, from: 2.5, to: 10.0), 0, "the trailing silence has to be silent")
	}

	/// The worst case if ScreenCaptureKit's system-audio output turns out to be silence-gapped
	/// the way the WASAPI loopback tap is: nothing is ever delivered, and the take still has to
	/// come out as a full-length silent track rather than as no audio track at all.
	func testATakeThatDeliversNoAudioAtAllStillSpansTheWholeRecording() {
		let sink = RecordingSink()
		let clock = TestClock(.zero)
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: false)
		mixer.beginTimeline(at: clock.now)

		clock.advance(seconds: 3)
		mixer.finish(atSourceTime: clock.now)

		let frames = mixedFrames(sink)
		assertContiguous(sink)
		XCTAssertEqual(seconds(ofFrames: frames), 3.0, accuracy: 0.011)
		XCTAssertEqual(peak(frames, from: 0, to: 3.0), 0)
	}

	// MARK: - Mid-take gaps

	func testAudioAfterAMidTakeGapKeepsThePositionItHappenedAt() {
		let sink = RecordingSink()
		let clock = TestClock(.zero)
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: false)
		mixer.beginTimeline(at: clock.now)

		mixer.ingest(
			makeSourceBuffer(burst(seconds: 0.5, left: 0.5, right: 0.5), at: clock.now, nonInterleaved: true),
			from: .system
		)
		clock.advance(seconds: 0.5)
		mixer.tick()

		// Five seconds of nothing, then the source speaks up again.
		clock.advance(seconds: 5)
		mixer.tick()
		mixer.ingest(
			makeSourceBuffer(burst(seconds: 0.5, left: 0.5, right: 0.5), at: clock.now, nonInterleaved: true),
			from: .system
		)
		clock.advance(seconds: 0.5)
		mixer.finish(atSourceTime: clock.now)

		let frames = mixedFrames(sink)
		assertContiguous(sink)
		XCTAssertEqual(seconds(ofFrames: frames), 6.0, accuracy: 0.011)
		XCTAssertGreaterThan(peak(frames, from: 0, to: 0.5), audibleThreshold)
		XCTAssertEqual(peak(frames, from: 1.0, to: 5.4), 0, "the gap has to survive as silence")
		XCTAssertGreaterThan(peak(frames, from: 5.5, to: 6.0), audibleThreshold)
	}

	// MARK: - The two sources against each other

	/// PR #343 rebased each source's first buffer onto the session start independently, and its
	/// own test asserted the consequence as intended: system audio first heard at +120 ms and
	/// the microphone at +210 ms both moved to zero, deleting the 90 ms between them. One shared
	/// anchor and placement by presentation timestamp keeps that 90 ms, because no source is
	/// ever shifted by anything.
	func testTheTwoSourcesAreNeverShiftedRelativeToEachOther() {
		let sink = RecordingSink()
		let sessionStart = CMTime(value: 50, timescale: 1)
		let clock = TestClock(sessionStart)
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: true, microphoneGain: 1)
		mixer.beginTimeline(at: sessionStart)

		// Left channel carries system audio, right carries the microphone, so the two onsets
		// can be read back separately out of one mixed track.
		mixer.ingest(
			makeSourceBuffer(
				burst(seconds: 0.3, left: 0.5, right: 0),
				at: CMTimeAdd(sessionStart, CMTime(value: 120, timescale: 1_000)),
				nonInterleaved: true
			),
			from: .system
		)
		mixer.ingest(
			makeSourceBuffer(
				burst(seconds: 0.3, left: 0, right: 0.5),
				at: CMTimeAdd(sessionStart, CMTime(value: 210, timescale: 1_000)),
				nonInterleaved: false
			),
			from: .microphone
		)

		clock.advance(seconds: 1)
		mixer.finish(atSourceTime: clock.now)

		let frames = mixedFrames(sink)
		let systemOnset = firstAudibleSecond(frames, channel: 0)
		let microphoneOnset = firstAudibleSecond(frames, channel: 1)
		XCTAssertEqual(systemOnset ?? -1, 0.120, accuracy: 0.001)
		XCTAssertEqual(microphoneOnset ?? -1, 0.210, accuracy: 0.001)
		XCTAssertEqual((microphoneOnset ?? 0) - (systemOnset ?? 0), 0.090, accuracy: 0.002)
	}

	/// A dead microphone must not hold the track back — the whole reason the mixer marks a
	/// source stalled rather than waiting for it. Now that lateness is measured against the
	/// clock, this works even when the *other* source is silent too, which is the case the old
	/// source-against-source tolerance had no answer for.
	func testOneSourceGoingQuietDoesNotStallTheTrack() {
		let sink = RecordingSink()
		let clock = TestClock(.zero)
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: true, microphoneGain: 1)
		mixer.beginTimeline(at: clock.now)

		// Both sources deliver 200 ms, then the microphone stops for good.
		mixer.ingest(
			makeSourceBuffer(burst(seconds: 0.2, left: 0.5, right: 0), at: clock.now, nonInterleaved: true),
			from: .system
		)
		mixer.ingest(
			makeSourceBuffer(burst(seconds: 0.2, left: 0, right: 0.5), at: clock.now, nonInterleaved: false),
			from: .microphone
		)
		clock.advance(seconds: 0.2)
		mixer.tick()

		for _ in 0..<10 {
			// Each buffer covers the 200 ms about to elapse, the way a live source delivers.
			mixer.ingest(
				makeSourceBuffer(burst(seconds: 0.2, left: 0.5, right: 0), at: clock.now, nonInterleaved: true),
				from: .system
			)
			clock.advance(seconds: 0.2)
			mixer.tick()
		}
		clock.advance(seconds: 0.2)
		mixer.finish(atSourceTime: clock.now)

		let frames = mixedFrames(sink)
		XCTAssertEqual(seconds(ofFrames: frames), 2.4, accuracy: 0.011)
		// System audio kept flowing the whole way despite the microphone never coming back.
		XCTAssertGreaterThan(peak(frames, from: 2.0, to: 2.2, channel: 0), audibleThreshold)
	}

	/// A source that is alive but always arriving late must not be written off as stalled.
	///
	/// This is the trap in driving the cursor off a clock: measure a source's lateness as the
	/// gap between the clock and its coverage, and a capture path that delivers its buffers a
	/// fixed delay after the audio they describe is late by that delay forever. Every chunk
	/// would go out as silence and every real sample would then arrive too late to be placed,
	/// so the source would be silent for the whole recording rather than merely delayed. The
	/// grace is measured from the source's last delivery instead, which a constant latency
	/// never trips. 400 ms here, comfortably past the 250 ms grace.
	func testASourceThatIsAlwaysLateIsStillHeard() {
		let sink = RecordingSink()
		let clock = TestClock(.zero)
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: false)
		mixer.beginTimeline(at: clock.now)

		clock.advance(seconds: 0.4)
		for step in 0..<10 {
			// The buffer describes audio from 400 ms ago; the clock is already well past it.
			let capturedAt = CMTime(seconds: Double(step) * 0.2, preferredTimescale: 48_000)
			mixer.ingest(
				makeSourceBuffer(burst(seconds: 0.2, left: 0.5, right: 0.5), at: capturedAt, nonInterleaved: true),
				from: .system
			)
			clock.advance(seconds: 0.2)
			mixer.tick()
		}
		mixer.finish(atSourceTime: clock.now)

		let frames = mixedFrames(sink)
		XCTAssertEqual(seconds(ofFrames: frames), 2.4, accuracy: 0.011)
		XCTAssertEqual(firstAudibleSecond(frames) ?? -1, 0.0, accuracy: 0.001)
		// Every 100 ms of the two seconds the source actually described has to be audible.
		for step in 0..<20 {
			let from = Double(step) * 0.1
			XCTAssertGreaterThan(
				peak(frames, from: from, to: from + 0.1),
				audibleThreshold,
				"silence at \(from)s means the late source was written off"
			)
		}
	}

	// MARK: - What the take reports about its sources

	/// The numbers that answer the ScreenCaptureKit gapping question have to measure what the
	/// source *delivered*, not what came out of the mixer.
	///
	/// `SourceTimeline.ingest` zero-fills a hole up to `maxSilencePadFrames` into the source's
	/// own buffer, so a hole read off the mixed output comes back as covered — and that is the
	/// reading that would report "the tap streams silence" about a tap that had stopped for a
	/// second and a half, which is the one thing this measurement exists to tell apart. Both
	/// bursts are ingested before the clock moves, so the padding path is the one taken.
	func testASubTwoSecondDeliveryHoleIsReportedAsUndelivered() {
		let sink = RecordingSink()
		let clock = TestClock(.zero)
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: false)
		mixer.beginTimeline(at: clock.now)

		mixer.ingest(
			makeSourceBuffer(burst(seconds: 0.5, left: 0.5, right: 0.5), at: .zero, nonInterleaved: true),
			from: .system
		)
		mixer.ingest(
			makeSourceBuffer(
				burst(seconds: 0.5, left: 0.5, right: 0.5),
				at: CMTime(seconds: 1.5, preferredTimescale: 48_000),
				nonInterleaved: true
			),
			from: .system
		)

		clock.advance(seconds: 3)
		mixer.finish(atSourceTime: clock.now)

		let report = mixer.deliveryReport(for: .system)
		XCTAssertEqual(report.trackSeconds, 3.0, accuracy: 0.011)
		// The 1.0 s hole between the bursts plus the 1.0 s tail after the second one. Measured
		// off the mixed output instead, the padded hole would vanish and this would read 1.0.
		XCTAssertEqual(report.undeliveredSeconds, 2.0, accuracy: 0.011)
		XCTAssertEqual(report.longestHoleSeconds, 1.0, accuracy: 0.011)
		XCTAssertEqual(report.droppedSeconds, 0, accuracy: 0.011)
	}

	/// A source that never delivers anything reports the whole take as undelivered — the
	/// reading that would say ScreenCaptureKit gaps its silence outright.
	func testASourceThatNeverDeliversReportsTheWholeTakeUndelivered() {
		let sink = RecordingSink()
		let clock = TestClock(.zero)
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: false)
		mixer.beginTimeline(at: clock.now)

		clock.advance(seconds: 2)
		mixer.finish(atSourceTime: clock.now)

		let report = mixer.deliveryReport(for: .system)
		XCTAssertEqual(report.undeliveredSeconds, 2.0, accuracy: 0.011)
		XCTAssertEqual(report.longestHoleSeconds, 2.0, accuracy: 0.011)
	}

	/// Audio that arrives after the cursor has already emitted its span cannot be placed, and
	/// that is the one path here that loses captured sound. It is reported rather than silent,
	/// because anything above zero means the grace is too short for that capture path.
	func testAudioArrivingAfterItsChunkWentOutIsCountedAsDropped() {
		let sink = RecordingSink()
		let clock = TestClock(.zero)
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: false)
		mixer.beginTimeline(at: clock.now)

		mixer.ingest(
			makeSourceBuffer(burst(seconds: 0.5, left: 0.5, right: 0.5), at: .zero, nonInterleaved: true),
			from: .system
		)
		// Long enough past the grace that the source is written off and the cursor runs on.
		clock.advance(seconds: 2)
		mixer.tick()

		// …and only now does it hand over the span it went quiet for, which is already behind
		// the cursor and cannot be placed.
		mixer.ingest(
			makeSourceBuffer(
				burst(seconds: 0.5, left: 0.5, right: 0.5),
				at: CMTime(seconds: 0.6, preferredTimescale: 48_000),
				nonInterleaved: true
			),
			from: .system
		)
		clock.advance(seconds: 1)
		mixer.finish(atSourceTime: clock.now)

		let report = mixer.deliveryReport(for: .system)
		XCTAssertEqual(report.droppedSeconds, 0.5, accuracy: 0.011)
		// Nothing here predates the session, so the other half of the split stays clear.
		XCTAssertEqual(report.trimmedSeconds, 0, accuracy: 0.011)
	}

	// MARK: - Pause

	/// A pause stops the clock instead of resetting it. `ScreenCaptureRecorder.timelineNow()`
	/// freezes while paused and continues from the frozen value on resume, which is what this
	/// clock does here: the paused seconds are absent from the track, and everything recorded
	/// after the pause keeps the position it would have had.
	func testAFrozenClockPausesTheTrackWithoutShiftingWhatFollows() {
		let sink = RecordingSink()
		let clock = TestClock(.zero)
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: false)
		mixer.beginTimeline(at: clock.now)

		mixer.ingest(
			makeSourceBuffer(burst(seconds: 1, left: 0.5, right: 0.5), at: clock.now, nonInterleaved: true),
			from: .system
		)
		clock.advance(seconds: 1)
		mixer.tick()

		// Paused: real time passes, the timeline does not.
		for _ in 0..<20 {
			mixer.tick()
		}
		XCTAssertEqual(seconds(ofFrames: mixedFrames(sink)), 1.0, accuracy: 0.011)

		// Resumed, and the source picks up at the position the timeline froze at.
		mixer.ingest(
			makeSourceBuffer(burst(seconds: 1, left: 0.5, right: 0.5), at: clock.now, nonInterleaved: true),
			from: .system
		)
		clock.advance(seconds: 1)
		mixer.finish(atSourceTime: clock.now)

		let frames = mixedFrames(sink)
		assertContiguous(sink)
		XCTAssertEqual(seconds(ofFrames: frames), 2.0, accuracy: 0.011)
		XCTAssertGreaterThan(peak(frames, from: 1.2, to: 1.8), audibleThreshold)
	}

	// MARK: - Gain

	func testANonFiniteMicrophoneGainFallsBackToUnityRatherThanPoisoningTheMix() {
		let sink = RecordingSink()
		let clock = TestClock(.zero)
		let mixer = makeMixer(sink: sink, clock: clock, includesMicrophone: true, microphoneGain: .nan)
		mixer.beginTimeline(at: clock.now)

		mixer.ingest(
			makeSourceBuffer(burst(seconds: 0.5, left: 0.5, right: 0.5), at: clock.now, nonInterleaved: false),
			from: .microphone
		)
		clock.advance(seconds: 0.5)
		mixer.finish(atSourceTime: clock.now)

		let frames = mixedFrames(sink)
		// 0.5 at unity gain, quantized: 16 383 or 16 384 depending on rounding. NaN reaching
		// the multiply instead would leave the whole track at zero.
		let loudest = peak(frames, from: 0, to: 0.5)
		XCTAssertGreaterThan(loudest, 16_000)
		XCTAssertLessThan(loudest, 16_500)
	}

	// MARK: - Fixtures

	private func makeMixer(
		sink: MixedAudioSink,
		clock: TestClock,
		includesMicrophone: Bool,
		microphoneGain: Double = 1.4
	) -> AudioTrackMixer {
		AudioTrackMixer(
			input: sink,
			includesSystemAudio: true,
			includesMicrophone: includesMicrophone,
			microphoneGain: microphoneGain,
			clock: { clock.now }
		)
	}

	/// A burst whose every sample sits at exactly ±amplitude, so an onset can be located to the
	/// frame. A sine would put near-zero samples at each zero crossing and blunt that.
	private func burst(seconds: Double, left: Float, right: Float) -> [Float] {
		let frameCount = Int(seconds * Double(sampleRate))
		var samples = [Float](repeating: 0, count: frameCount * channelCount)
		for frame in 0..<frameCount {
			let sign: Float = frame % 2 == 0 ? 1 : -1
			samples[frame * channelCount] = left * sign
			samples[frame * channelCount + 1] = right * sign
		}
		return samples
	}

	/// One capture buffer in the shape ScreenCaptureKit actually delivers: 48 kHz stereo
	/// Float32, non-interleaved for the system-audio output and interleaved for the microphone.
	private func makeSourceBuffer(
		_ interleavedSamples: [Float],
		at presentationTime: CMTime,
		nonInterleaved: Bool
	) -> CMSampleBuffer {
		let frameCount = interleavedSamples.count / channelCount
		let bytesPerChannelSample = MemoryLayout<Float>.size
		var asbd = AudioStreamBasicDescription(
			mSampleRate: Float64(sampleRate),
			mFormatID: kAudioFormatLinearPCM,
			mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked
				| kAudioFormatFlagsNativeEndian
				| (nonInterleaved ? kAudioFormatFlagIsNonInterleaved : 0),
			mBytesPerPacket: UInt32(nonInterleaved ? bytesPerChannelSample : bytesPerChannelSample * channelCount),
			mFramesPerPacket: 1,
			mBytesPerFrame: UInt32(nonInterleaved ? bytesPerChannelSample : bytesPerChannelSample * channelCount),
			mChannelsPerFrame: UInt32(channelCount),
			mBitsPerChannel: 32,
			mReserved: 0
		)

		var formatDescription: CMAudioFormatDescription?
		XCTAssertEqual(
			CMAudioFormatDescriptionCreate(
				allocator: kCFAllocatorDefault,
				asbd: &asbd,
				layoutSize: 0,
				layout: nil,
				magicCookieSize: 0,
				magicCookie: nil,
				extensions: nil,
				formatDescriptionOut: &formatDescription
			),
			noErr
		)

		var sampleBuffer: CMSampleBuffer?
		XCTAssertEqual(
			CMAudioSampleBufferCreateWithPacketDescriptions(
				allocator: kCFAllocatorDefault,
				dataBuffer: nil,
				dataReady: false,
				makeDataReadyCallback: nil,
				refcon: nil,
				formatDescription: formatDescription!,
				sampleCount: frameCount,
				presentationTimeStamp: presentationTime,
				packetDescriptions: nil,
				sampleBufferOut: &sampleBuffer
			),
			noErr
		)

		let planeCount = nonInterleaved ? channelCount : 1
		let planeBytes = nonInterleaved
			? frameCount * bytesPerChannelSample
			: frameCount * bytesPerChannelSample * channelCount
		var planes = [UnsafeMutableRawPointer]()
		for plane in 0..<planeCount {
			let memory = UnsafeMutableRawPointer.allocate(byteCount: planeBytes, alignment: 16)
			let floats = memory.bindMemory(to: Float.self, capacity: planeBytes / bytesPerChannelSample)
			if nonInterleaved {
				for frame in 0..<frameCount {
					floats[frame] = interleavedSamples[frame * channelCount + plane]
				}
			} else {
				for index in interleavedSamples.indices {
					floats[index] = interleavedSamples[index]
				}
			}
			planes.append(memory)
		}
		defer { planes.forEach { $0.deallocate() } }

		let bufferList = AudioBufferList.allocate(maximumBuffers: planeCount)
		defer { free(bufferList.unsafeMutablePointer) }
		for plane in 0..<planeCount {
			bufferList[plane] = AudioBuffer(
				mNumberChannels: UInt32(nonInterleaved ? 1 : channelCount),
				mDataByteSize: UInt32(planeBytes),
				mData: planes[plane]
			)
		}

		// Copies into a block buffer of its own, so the planes above can go out of scope.
		XCTAssertEqual(
			CMSampleBufferSetDataBufferFromAudioBufferList(
				sampleBuffer!,
				blockBufferAllocator: kCFAllocatorDefault,
				blockBufferMemoryAllocator: kCFAllocatorDefault,
				flags: 0,
				bufferList: bufferList.unsafePointer
			),
			noErr
		)
		XCTAssertEqual(CMSampleBufferSetDataReady(sampleBuffer!), noErr)
		return sampleBuffer!
	}

	// MARK: - Readback

	private func mixedFrames(_ sink: RecordingSink) -> [Int16] {
		var samples = [Int16]()
		for buffer in sink.buffers {
			guard let block = CMSampleBufferGetDataBuffer(buffer) else {
				continue
			}
			let length = CMBlockBufferGetDataLength(block)
			var bytes = [UInt8](repeating: 0, count: length)
			let status = bytes.withUnsafeMutableBytes { raw -> OSStatus in
				guard let base = raw.baseAddress else {
					return -1
				}
				return CMBlockBufferCopyDataBytes(
					block,
					atOffset: 0,
					dataLength: length,
					destination: base
				)
			}
			XCTAssertEqual(status, kCMBlockBufferNoErr)
			samples.append(contentsOf: bytes.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) })
		}
		return samples
	}

	private func seconds(ofFrames samples: [Int16]) -> Double {
		Double(samples.count / channelCount) / Double(sampleRate)
	}

	/// Every chunk has to butt up against the one before it. A hole here would mean the mixer
	/// emitted a timestamp it never filled, which is the failure this whole file is about.
	private func assertContiguous(_ sink: RecordingSink, file: StaticString = #filePath, line: UInt = #line) {
		var expected: CMTime?
		for buffer in sink.buffers {
			let presentationTime = buffer.presentationTimeStamp
			if let expected {
				XCTAssertEqual(
					CMTimeGetSeconds(CMTimeSubtract(presentationTime, expected)),
					0,
					accuracy: 1e-9,
					"chunks must be contiguous",
					file: file,
					line: line
				)
			}
			expected = CMTimeAdd(
				presentationTime,
				CMTime(value: CMTimeValue(CMSampleBufferGetNumSamples(buffer)), timescale: CMTimeScale(sampleRate))
			)
		}
	}

	private func peak(_ samples: [Int16], from: Double, to: Double, channel: Int? = nil) -> Int16 {
		let firstFrame = Int(from * Double(sampleRate))
		let lastFrame = min(Int(to * Double(sampleRate)), samples.count / channelCount)
		var loudest: Int16 = 0
		var frame = firstFrame
		while frame < lastFrame {
			for lane in 0..<channelCount where channel == nil || channel == lane {
				let value = samples[frame * channelCount + lane]
				loudest = max(loudest, value == Int16.min ? Int16.max : abs(value))
			}
			frame += 1
		}
		return loudest
	}

	private func firstAudibleSecond(_ samples: [Int16], channel: Int? = nil) -> Double? {
		let frameCount = samples.count / channelCount
		for frame in 0..<frameCount {
			for lane in 0..<channelCount where channel == nil || channel == lane {
				let value = samples[frame * channelCount + lane]
				if (value == Int16.min ? Int16.max : abs(value)) > audibleThreshold {
					return Double(frame) / Double(sampleRate)
				}
			}
		}
		return nil
	}
}

/// Keeps what the mixer produced instead of encoding it, and is always ready, so nothing here
/// exercises the backpressure path.
private final class RecordingSink: MixedAudioSink {
	private(set) var buffers: [CMSampleBuffer] = []

	var isReadyForMoreMediaData: Bool { true }

	@discardableResult
	func append(_ sampleBuffer: CMSampleBuffer) -> Bool {
		buffers.append(sampleBuffer)
		return true
	}
}

/// The writer timeline, moved by hand. Stands in for `ScreenCaptureRecorder.timelineNow()`,
/// which is the host clock less the time spent paused — including the part where it stops
/// moving altogether while the recording is paused.
private final class TestClock {
	private(set) var now: CMTime

	init(_ start: CMTime) {
		self.now = start
	}

	func advance(seconds: Double) {
		now = CMTimeAdd(now, CMTime(seconds: seconds, preferredTimescale: 48_000))
	}
}
