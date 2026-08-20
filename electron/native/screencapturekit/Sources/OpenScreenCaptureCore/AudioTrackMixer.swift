import AVFoundation
import CoreMedia
import Foundation

/// Where the mixed track goes. `AVAssetWriterInput` satisfies this as it stands, with no
/// adapter — the protocol exists so `swift test` can drive the mixer without a writer, a file,
/// or an AAC encoder in the way, and read back the exact frames and presentation timestamps it
/// produced. Measuring the timeline through an encoder would fold AAC's priming delay into
/// every assertion; measuring it here is exact.
public protocol MixedAudioSink: AnyObject {
	var isReadyForMoreMediaData: Bool { get }
	@discardableResult
	func append(_ sampleBuffer: CMSampleBuffer) -> Bool
}

extension AVAssetWriterInput: MixedAudioSink {}

/// The instant the writer's timeline has reached, in the writer's own time domain — the domain
/// the session start and every sample's presentation timestamp already live in.
///
/// Frozen while the recording is paused, so that a pause stops the audio clock rather than
/// resetting it: what follows keeps the position it would have had.
public typealias TimelineClock = () -> CMTime

/// Sums system audio and the microphone into the single AAC track the helper muxes.
///
/// The helper used to give AVAssetWriter one input per source, so a recording with both
/// enabled carried two audio tracks. Export never noticed — `crates/compositor/src/audio.rs`
/// decodes and sums every audio stream it finds — but the editor preview is a plain HTML5
/// `<video>`, which plays audio track 0 and offers no way to reach the others: Chromium
/// implements no `audioTracks` API. Filming a silent screen while talking therefore produced
/// a preview with no sound at all, even though the microphone was in the file. Windows has
/// muxed a single mixed track all along (`AudioMixer`, wgc-capture/src/audio_sample_utils.h);
/// this is that model in Swift.
///
/// The two sources run off independent clocks, so samples are placed on a shared timeline by
/// presentation timestamp rather than by arrival order: a source that starts late, drifts, or
/// drops buffers lands at the offset it belongs at instead of shoving everything after it out
/// of sync.
///
/// **The cursor advances on the clock, not on the data.** Chunks go out for as long as the take
/// runs, filled from whichever source covers them and with silence where none does. Inferring
/// the position from arrivals instead is the bug this mirrors from Windows (`7e6cde3f`,
/// getopenscreen/openscreen#406): there the emit counter only moved while a queue held samples,
/// so a take beginning in silence emitted nothing and the first sound landed at timestamp zero.
/// Here the same inference lived in the anchor — it was set lazily on the first decoded buffer
/// to `max(firstPresentationTime, sessionStart)`, so audio that first arrived four seconds in
/// made frame zero of the mixed track *be* four seconds in, and the leading silence was simply
/// absent from the file. Anchoring to the session start and letting the clock carry the cursor
/// covers the leading silence, the trailing silence and mid-take gaps with one mechanism, and
/// shifts no source relative to any other.
///
/// Not thread-safe by design: every entry point runs on the recorder's serial sample queue,
/// which is also the queue ScreenCaptureKit delivers both audio outputs on and the queue the
/// recorder's tick timer fires on.
public final class AudioTrackMixer {
	public enum Source: Int, CaseIterable {
		case system = 0
		case microphone = 1
	}

	/// The AAC-friendly mix format, mirroring `makeAacCompatibleAudioFormat` on Windows.
	/// Mixing happens in Float and quantizes to Int16 once, at the very end.
	private enum MixFormat {
		static let sampleRate = 48_000
		static let channelCount = 2
		static let bytesPerFrame = channelCount * MemoryLayout<Int16>.size
		/// 10 ms — the chunk size the Windows mixer emits too.
		static let chunkFrames = sampleRate / 100
		/// How long a source may deliver nothing at all before it is written off and chunks go
		/// out without it.
		///
		/// Measured from that source's own last delivery, and deliberately not from how far
		/// behind the clock its coverage is. Those differ for a source that is alive but
		/// arriving late, and the difference is the whole take: a capture path whose buffers
		/// reach us a fixed delay after the audio they describe would be permanently "behind",
		/// so writing it off for that would emit silence, drop the real samples as
		/// already-passed, and do it again for every chunk. Asking "has it stopped delivering"
		/// instead is immune to any constant latency, and it is the actual question — a dead
		/// microphone stops, a slow one does not.
		///
		/// Nothing is shifted by this number and no sample moves because of it; it only decides
		/// when to stop waiting. That is what separates it from the bounded start-up rebase in
		/// PR #343, where the same 250 ms moved real audio. The value is two orders of magnitude
		/// above the ~2.5 ms delivery skew between two outputs of the same SCStream, so ordinary
		/// jitter never trips it, and the file is written offline, so the latency it costs at a
		/// transition into silence costs the recording nothing.
		static let emissionGraceFrames = sampleRate / 4
		/// Longest hole a source may silence-pad across. Past this the source has been dead long
		/// enough that padding would materialize however long the outage lasted — the cursor
		/// carries the track across the gap instead.
		static let maxSilencePadFrames = sampleRate * 2
		/// Writer backpressure allowance, in chunks (5 s). `expectsMediaDataInRealTime` keeps
		/// this at zero or one in practice; the cap only bounds a pathological writer stall.
		static let maxPendingChunks = 500
		/// How long the final flush waits for the input to accept the tail before giving up.
		static let finalFlushTimeout = 5.0
	}

	private let input: MixedAudioSink
	private let clock: TimelineClock
	private let includesSystemAudio: Bool
	private let includesMicrophone: Bool
	private let microphoneGain: Float
	private let outputFormatDescription: CMAudioFormatDescription?

	private var sources = [SourceTimeline](repeating: SourceTimeline(), count: Source.allCases.count)
	/// Timeline origin: frame 0 of the mixed track, in the writer's time domain. Set once,
	/// eagerly, to the writer's session start — never inferred from a buffer.
	private var anchor: CMTime?
	/// Absolute frame index of the next chunk to emit.
	private var cursor: Int64 = 0
	/// Per source, the absolute frame its most recent delivery reached — nil until it delivers
	/// anything — and the holes measured between deliveries.
	///
	/// Measured on what each source handed over, never on what came out of the mixer. Reading a
	/// hole off the mixed output cannot answer the question the numbers exist for, because
	/// `SourceTimeline.ingest` zero-fills holes up to `maxSilencePadFrames` into the source's own
	/// buffer: a tap that stops for anything under two seconds would come back fully covered,
	/// which is precisely the case that would tell us it is gapped.
	private var deliveredThroughFrame = [Int64?](repeating: nil, count: Source.allCases.count)
	private var undeliveredFrames = [Int64](repeating: 0, count: Source.allCases.count)
	private var longestHoleFrames = [Int64](repeating: 0, count: Source.allCases.count)
	private var pending: [CMSampleBuffer] = []
	private var didWarnAboutBacklog = false
	private var didWarnAboutDecode: Set<Int> = []

	public init(
		input: MixedAudioSink,
		includesSystemAudio: Bool,
		includesMicrophone: Bool,
		microphoneGain: Double,
		clock: @escaping TimelineClock
	) {
		self.input = input
		self.clock = clock
		self.includesSystemAudio = includesSystemAudio
		self.includesMicrophone = includesMicrophone
		// The request carries MIC_GAIN_BOOST (1.4); Windows applies it unconditionally and so
		// does this. A non-finite or negative value would poison every mixed sample.
		let sanitized = microphoneGain.isFinite ? max(0, microphoneGain) : 1
		self.microphoneGain = Float(sanitized)
		self.outputFormatDescription = Self.makeOutputFormatDescription()
	}

	/// Anchors frame 0 of the mixed track to the writer session start.
	///
	/// Eagerly, and to the session start itself: audio that arrives before it is trimmed at
	/// frame zero rather than moving the origin, and audio that arrives long after it lands at
	/// the offset it belongs at with real silence in front of it.
	public func beginTimeline(at sessionStart: CMTime) {
		guard anchor == nil, sessionStart.isValid, sessionStart.isNumeric else {
			return
		}

		anchor = CMTimeConvertScale(
			sessionStart,
			timescale: CMTimeScale(MixFormat.sampleRate),
			method: .roundHalfAwayFromZero
		)
	}

	public func ingest(_ sampleBuffer: CMSampleBuffer, from source: Source) {
		guard includes(source), let anchor else {
			return
		}
		let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
		guard presentationTime.isValid, presentationTime.isNumeric else {
			return
		}
		guard let frames = decodeInterleavedStereo(sampleBuffer, gain: gain(for: source)),
			!frames.isEmpty
		else {
			// A source whose buffers never decode contributes silence for the whole recording
			// and looks exactly like a muted device, so say so once rather than fail quietly.
			warnAboutDecodeFailure(source, sampleBuffer)
			return
		}

		let now = clock()
		let startFrame = frameIndex(of: presentationTime, from: anchor)
		noteDelivery(source, from: startFrame, frameCount: Int64(frames.count / MixFormat.channelCount))
		sources[source.rawValue].ingest(frames, atFrame: startFrame)
		// Where the clock stood when this source last said anything — not where its samples
		// sit. See `emissionGraceFrames`.
		sources[source.rawValue].lastDeliveryFrame = frameIndex(of: now, from: anchor)
		drain(upTo: now, grace: Int64(MixFormat.emissionGraceFrames))
	}

	/// Advances the cursor to wherever the clock now stands, emitting silence for anything no
	/// source covered. Called on a timer, because a take that nothing is delivering audio for is
	/// exactly the take whose timeline has to keep moving.
	public func tick() {
		guard anchor != nil else {
			return
		}
		drain(upTo: clock(), grace: Int64(MixFormat.emissionGraceFrames))
	}

	/// Carries the track out to the end of the take and writes out everything still buffered.
	/// Call once, on the sample queue, before the writer input is marked as finished — and pass
	/// the same source time the writer's `endSession` is given, so the audio track and the
	/// container agree on where the recording ended.
	public func finish(atSourceTime end: CMTime) {
		if anchor != nil {
			// No grace: capture has stopped, so a source that has not covered a chunk by now
			// never will, and waiting on it would only truncate the tail.
			drain(upTo: end, grace: 0)
			closeDeliveryHoles()
			emitTimelineSummary()
		}
		flushPending(force: true)
	}

	private func warnAboutDecodeFailure(_ source: Source, _ sampleBuffer: CMSampleBuffer) {
		guard !didWarnAboutDecode.contains(source.rawValue) else {
			return
		}
		didWarnAboutDecode.insert(source.rawValue)

		var description = "unknown format"
		if let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
			let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)?.pointee
		{
			let interleaving = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
				? "non-interleaved" : "interleaved"
			description =
				"\(asbd.mSampleRate) Hz, \(asbd.mChannelsPerFrame) ch, \(asbd.mBitsPerChannel)-bit, \(interleaving)"
		}
		emit([
			"event": "warning",
			"code": "audio-source-undecodable",
			"message": "Could not decode \(source == .system ? "system" : "microphone") audio (\(description)); it will be missing from the recording.",
		])
	}

	/// Records the hole, if any, between this source's previous delivery and this one.
	private func noteDelivery(_ source: Source, from startFrame: Int64, frameCount: Int64) {
		let index = source.rawValue
		// Audio captured before the session start is trimmed at frame zero, not missing.
		let start = max(0, startFrame)
		let previousEnd = deliveredThroughFrame[index] ?? 0
		if start > previousEnd {
			let hole = start - previousEnd
			undeliveredFrames[index] += hole
			longestHoleFrames[index] = max(longestHoleFrames[index], hole)
		}
		deliveredThroughFrame[index] = max(previousEnd, startFrame + frameCount)
	}

	/// Counts the stretch from each source's last delivery to the end of the take. A source that
	/// never delivered at all lands here with the whole track, which is the answer that matters.
	private func closeDeliveryHoles() {
		for source in Source.allCases where includes(source) {
			let index = source.rawValue
			let tail = cursor - (deliveredThroughFrame[index] ?? 0)
			if tail > 0 {
				undeliveredFrames[index] += tail
				longestHoleFrames[index] = max(longestHoleFrames[index], tail)
			}
		}
	}

	/// Reports what each source actually delivered against the finished track.
	///
	/// Not diagnostics for their own sake: how much of the timeline the clock carries on its own
	/// depends on whether ScreenCaptureKit's system-audio output goes silent-but-delivering or
	/// stops delivering altogether while nothing is playing, and nothing in the tree recorded
	/// which until a take was run against the real API.
	///
	/// It has been now, and the tap **streams silence**. It does not gap it the way the WASAPI
	/// loopback tap does. A 12.05 s take on an M1 Mac mini (macOS 26.5) with system audio
	/// enabled and nothing playing at all reported `undeliveredSeconds` of 0.07 — 0.6 % of the
	/// track — as a single hole at the head while the tap came up, `longestHoleSeconds` being
	/// equal to it. A gapped tap would have reported close to the whole track instead. So on
	/// macOS the clock only has to carry the take's edges, where under Windows it carries the
	/// whole quiet stretch as well.
	///
	/// `npm run test:sck-audio-timeline:mac` prints these numbers whether it passes or fails,
	/// so the measurement can be repeated. `longestHoleSeconds` is what would tell the two
	/// shapes of a gapped tap apart — one long outage, or a steady stutter — should this ever
	/// change.
	///
	/// `droppedSeconds` is the cost side of the same ledger, and it should be zero. It counts
	/// audio a source delivered describing a span the cursor had already emitted, which cannot
	/// be placed any more. That happens only when a source went quiet for longer than
	/// `emissionGraceFrames` and then handed over the period it was quiet for, so anything above
	/// zero here says the grace is too short for that capture path.
	///
	/// `trimmedSeconds` is deliberately not part of that number, though it is discarded by the
	/// same code. It counts what was cut while a source was still catching up to a cursor that
	/// had already started moving — the origin staying anchored to the video rather than
	/// anything going wrong. Every real take carries some: against a live ScreenCaptureKit the
	/// track starts before the system-audio tap has said anything, and about 40 ms of what it
	/// first hands over describes time the cursor has already crossed. Counting the two
	/// together, as this did until the split, made "dropped is zero" unsatisfiable on real
	/// hardware and cost the check the only thing it was for.
	private func emitTimelineSummary() {
		var fields: [String: Any] = [
			"event": "audio-timeline",
			"code": "audio-timeline-summary",
			"trackSeconds": seconds(cursor),
		]
		for source in Source.allCases where includes(source) {
			let report = deliveryReport(for: source)
			fields[source == .system ? "system" : "microphone"] = [
				"undeliveredSeconds": report.undeliveredSeconds,
				"longestHoleSeconds": report.longestHoleSeconds,
				"droppedSeconds": report.droppedSeconds,
				"trimmedSeconds": report.trimmedSeconds,
			]
		}
		emit(fields)
	}

	/// What one source handed over across the finished take. The same numbers
	/// `emitTimelineSummary` reports, reachable without parsing a log line.
	public struct DeliveryReport {
		public let trackSeconds: Double
		public let undeliveredSeconds: Double
		public let longestHoleSeconds: Double
		public let droppedSeconds: Double
		public let trimmedSeconds: Double
	}

	public func deliveryReport(for source: Source) -> DeliveryReport {
		DeliveryReport(
			trackSeconds: seconds(cursor),
			undeliveredSeconds: seconds(undeliveredFrames[source.rawValue]),
			longestHoleSeconds: seconds(longestHoleFrames[source.rawValue]),
			droppedSeconds: seconds(sources[source.rawValue].droppedFrames),
			trimmedSeconds: seconds(sources[source.rawValue].trimmedFrames)
		)
	}

	private func seconds(_ frames: Int64) -> Double {
		Double(frames) / Double(MixFormat.sampleRate)
	}

	private func frameIndex(of time: CMTime, from anchor: CMTime) -> Int64 {
		CMTimeConvertScale(
			CMTimeSubtract(time, anchor),
			timescale: CMTimeScale(MixFormat.sampleRate),
			method: .roundHalfAwayFromZero
		).value
	}

	private func includes(_ source: Source) -> Bool {
		switch source {
		case .system:
			return includesSystemAudio
		case .microphone:
			return includesMicrophone
		}
	}

	private func gain(for source: Source) -> Float {
		switch source {
		case .system:
			return 1
		case .microphone:
			return microphoneGain
		}
	}

	/// Emits every chunk the clock has passed.
	///
	/// Two ways a chunk goes out. Normally it goes out as soon as every live source covers it,
	/// which costs no latency at all. Otherwise it goes out once every source still missing
	/// from it has gone `grace` without delivering anything — the case a purely data-driven
	/// mixer has no answer for, because when no source is delivering there is nothing to
	/// measure against. The clock supplies that reference whether one source has gone quiet,
	/// both have, or neither has ever delivered a single buffer.
	///
	/// `chunkEnd <= limitFrame` bounds the loop: a chunk covering time that has not happened yet
	/// is never emitted, so the cursor can never outrun the take.
	private func drain(upTo limit: CMTime, grace: Int64) {
		guard let anchor, limit.isValid, limit.isNumeric else {
			return
		}
		let limitFrame = frameIndex(of: limit, from: anchor)

		while true {
			let chunkEnd = cursor + Int64(MixFormat.chunkFrames)
			guard chunkEnd <= limitFrame else {
				break
			}

			let live = sources.indices.filter { sources[$0].hasDelivered && !sources[$0].isStalled }
			let laggards = live.filter { sources[$0].endFrame < chunkEnd }
			if !laggards.isEmpty {
				guard laggards.allSatisfy({ limitFrame >= sources[$0].lastDeliveryFrame + grace })
				else {
					break
				}
				// …and each stays stalled until its next buffer arrives, so one source going
				// quiet can never hold the track back chunk after chunk.
				for index in laggards {
					sources[index].isStalled = true
				}
			}

			emitChunk()
		}
	}

	private func emitChunk() {
		var mix = [Float](repeating: 0, count: MixFormat.chunkFrames * MixFormat.channelCount)
		for index in sources.indices {
			sources[index].drain(into: &mix, from: cursor, frameCount: MixFormat.chunkFrames)
		}

		let presentationTime = CMTimeAdd(
			anchor ?? .zero,
			CMTime(value: cursor, timescale: CMTimeScale(MixFormat.sampleRate))
		)
		cursor += Int64(MixFormat.chunkFrames)

		guard let sampleBuffer = makeSampleBuffer(from: mix, at: presentationTime) else {
			return
		}
		pending.append(sampleBuffer)
		flushPending(force: false)
	}

	/// `append` is not advisory backpressure — it raises an NSException when the input is not
	/// ready — so every path here waits for readiness rather than pushing through it.
	private func flushPending(force: Bool) {
		while !pending.isEmpty && input.isReadyForMoreMediaData {
			input.append(pending.removeFirst())
		}
		if force {
			// Teardown: this is the tail's last chance, and the writer is still draining, so
			// give it a bounded moment instead of dropping audio the recording just captured.
			let deadline = Date().addingTimeInterval(MixFormat.finalFlushTimeout)
			while !pending.isEmpty {
				if input.isReadyForMoreMediaData {
					input.append(pending.removeFirst())
					continue
				}
				if Date() >= deadline {
					emit([
						"event": "warning",
						"code": "audio-mixer-tail-dropped",
						"message": "The AAC input never drained; \(pending.count) mixed chunk(s) were dropped.",
					])
					pending.removeAll()
					break
				}
				Thread.sleep(forTimeInterval: 0.002)
			}
			return
		}
		guard pending.count > MixFormat.maxPendingChunks else {
			return
		}

		pending.removeFirst(pending.count - MixFormat.maxPendingChunks)
		if !didWarnAboutBacklog {
			didWarnAboutBacklog = true
			emit([
				"event": "warning",
				"code": "audio-mixer-backlog",
				"message": "The AAC input stalled for seconds; the oldest mixed audio was dropped.",
			])
		}
	}

	// MARK: - Sample conversion

	/// Decodes one capture buffer into gain-applied 48 kHz interleaved-stereo Float.
	///
	/// Both SCStream audio outputs are configured for 48 kHz stereo, so in practice this is a
	/// straight Float32 de-interleave. The format-adaptive paths (Int16/Int32, interleaved or
	/// not, off-rate sources) exist because the format is the stream's to choose, not ours —
	/// and because a resampled source's rounding drift is absorbed by timeline placement
	/// rather than accumulating, unlike in a FIFO mixer.
	private func decodeInterleavedStereo(_ sampleBuffer: CMSampleBuffer, gain: Float) -> [Float]? {
		guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
			let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
		else {
			return nil
		}

		let asbd = streamDescription.pointee
		let sourceFrames = CMSampleBufferGetNumSamples(sampleBuffer)
		let sourceChannels = Int(asbd.mChannelsPerFrame)
		let bitsPerChannel = Int(asbd.mBitsPerChannel)
		let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
		guard asbd.mFormatID == kAudioFormatLinearPCM,
			sourceChannels > 0,
			asbd.mSampleRate > 0,
			sourceFrames > 0,
			isFloat ? bitsPerChannel == 32 : (bitsPerChannel == 16 || bitsPerChannel == 32)
		else {
			return nil
		}

		// One AudioBuffer per channel when the source is non-interleaved, exactly one when it is
		// not. CoreMedia matches `bufferListSize` against the count it is about to write and
		// rejects anything else with kCMSampleBufferError_ArrayTooSmall — a list that is too
		// LARGE fails just as hard as one that is too small. The two ScreenCaptureKit audio
		// outputs disagree here: system audio arrives non-interleaved, the microphone
		// interleaved, so sizing this off the channel count alone silently drops every
		// microphone buffer.
		let isNonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
		let bufferCount = isNonInterleaved ? sourceChannels : 1
		let bufferList = AudioBufferList.allocate(maximumBuffers: bufferCount)
		defer { free(bufferList.unsafeMutablePointer) }

		var blockBuffer: CMBlockBuffer?
		let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
			sampleBuffer,
			bufferListSizeNeededOut: nil,
			bufferListOut: bufferList.unsafeMutablePointer,
			bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: bufferCount),
			blockBufferAllocator: kCFAllocatorDefault,
			blockBufferMemoryAllocator: kCFAllocatorDefault,
			flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
			blockBufferOut: &blockBuffer
		)
		guard status == noErr, blockBuffer != nil else {
			return nil
		}

		return withExtendedLifetime(blockBuffer) { () -> [Float]? in
			let bytesPerChannelSample = bitsPerChannel / 8
			// `bufferList` is subscripted against its own count, not the format's channel
			// count: indexing past `count` would trap rather than degrade.
			guard bufferList.count > 0 else {
				return nil
			}

			// Stereo out: mono sources feed both sides, anything wider than stereo keeps its
			// first two channels — the same mapping `readMappedChannel` applies on Windows.
			var readers = [ChannelReader]()
			for channel in 0..<MixFormat.channelCount {
				let sourceChannel = min(channel, sourceChannels - 1)
				let buffer = isNonInterleaved
					? bufferList[min(sourceChannel, bufferList.count - 1)]
					: bufferList[0]
				guard let data = buffer.mData else {
					return nil
				}
				readers.append(
					ChannelReader(
						base: UnsafeRawPointer(data),
						sampleCount: Int(buffer.mDataByteSize) / bytesPerChannelSample,
						stride: isNonInterleaved ? 1 : sourceChannels,
						start: isNonInterleaved ? 0 : sourceChannel,
						bytesPerSample: bytesPerChannelSample,
						isFloat: isFloat
					)
				)
			}

			let targetFrames = asbd.mSampleRate == Double(MixFormat.sampleRate)
				? sourceFrames
				: max(
					1,
					Int(
						(Double(sourceFrames) * Double(MixFormat.sampleRate) / asbd.mSampleRate)
							.rounded()
					)
				)
			let ratio = Double(sourceFrames) / Double(targetFrames)

			var output = [Float](repeating: 0, count: targetFrames * MixFormat.channelCount)
			for targetFrame in 0..<targetFrames {
				let sourceFrame = targetFrames == sourceFrames
					? targetFrame
					: min(sourceFrames - 1, Int((Double(targetFrame) * ratio).rounded()))
				for channel in 0..<MixFormat.channelCount {
					output[targetFrame * MixFormat.channelCount + channel] =
						readers[channel].value(at: sourceFrame) * gain
				}
			}
			return output
		}
	}

	private func makeSampleBuffer(from mix: [Float], at presentationTime: CMTime) -> CMSampleBuffer? {
		guard let outputFormatDescription else {
			return nil
		}
		let frameCount = mix.count / MixFormat.channelCount
		guard frameCount > 0 else {
			return nil
		}

		// The one and only quantization: sum in Float, clip once, then land on Int16.
		var pcm = [Int16](repeating: 0, count: mix.count)
		for index in mix.indices {
			pcm[index] = Int16((min(max(mix[index], -1), 1) * 32_767).rounded())
		}

		let byteCount = pcm.count * MemoryLayout<Int16>.size
		var blockBuffer: CMBlockBuffer?
		var status = CMBlockBufferCreateWithMemoryBlock(
			allocator: kCFAllocatorDefault,
			memoryBlock: nil,
			blockLength: byteCount,
			blockAllocator: kCFAllocatorDefault,
			customBlockSource: nil,
			offsetToData: 0,
			dataLength: byteCount,
			flags: kCMBlockBufferAssureMemoryNowFlag,
			blockBufferOut: &blockBuffer
		)
		guard status == kCMBlockBufferNoErr, let blockBuffer else {
			return nil
		}

		status = pcm.withUnsafeBytes { raw in
			guard let base = raw.baseAddress else {
				return kCMBlockBufferBadPointerParameterErr
			}
			return CMBlockBufferReplaceDataBytes(
				with: base,
				blockBuffer: blockBuffer,
				offsetIntoDestination: 0,
				dataLength: byteCount
			)
		}
		guard status == kCMBlockBufferNoErr else {
			return nil
		}

		var timing = CMSampleTimingInfo(
			duration: CMTime(value: 1, timescale: CMTimeScale(MixFormat.sampleRate)),
			presentationTimeStamp: presentationTime,
			decodeTimeStamp: .invalid
		)
		var sampleSize = MixFormat.bytesPerFrame
		var sampleBuffer: CMSampleBuffer?
		guard CMSampleBufferCreateReady(
			allocator: kCFAllocatorDefault,
			dataBuffer: blockBuffer,
			formatDescription: outputFormatDescription,
			sampleCount: frameCount,
			sampleTimingEntryCount: 1,
			sampleTimingArray: &timing,
			sampleSizeEntryCount: 1,
			sampleSizeArray: &sampleSize,
			sampleBufferOut: &sampleBuffer
		) == noErr else {
			return nil
		}

		return sampleBuffer
	}

	private static func makeOutputFormatDescription() -> CMAudioFormatDescription? {
		var asbd = AudioStreamBasicDescription(
			mSampleRate: Float64(MixFormat.sampleRate),
			mFormatID: kAudioFormatLinearPCM,
			mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked
				| kAudioFormatFlagsNativeEndian,
			mBytesPerPacket: UInt32(MixFormat.bytesPerFrame),
			mFramesPerPacket: 1,
			mBytesPerFrame: UInt32(MixFormat.bytesPerFrame),
			mChannelsPerFrame: UInt32(MixFormat.channelCount),
			mBitsPerChannel: 16,
			mReserved: 0
		)

		var formatDescription: CMAudioFormatDescription?
		guard CMAudioFormatDescriptionCreate(
			allocator: kCFAllocatorDefault,
			asbd: &asbd,
			layoutSize: 0,
			layout: nil,
			magicCookieSize: 0,
			magicCookie: nil,
			extensions: nil,
			formatDescriptionOut: &formatDescription
		) == noErr else {
			return nil
		}

		return formatDescription
	}

	// MARK: - Per-source timeline

	/// Reads one channel out of a capture buffer, whatever layout and sample type it uses.
	private struct ChannelReader {
		let base: UnsafeRawPointer
		let sampleCount: Int
		let stride: Int
		let start: Int
		let bytesPerSample: Int
		let isFloat: Bool

		func value(at frame: Int) -> Float {
			let index = start + frame * stride
			guard index >= 0, index < sampleCount else {
				return 0
			}

			let offset = index * bytesPerSample
			if isFloat {
				return base.loadUnaligned(fromByteOffset: offset, as: Float.self)
			}
			if bytesPerSample == 2 {
				return Float(base.loadUnaligned(fromByteOffset: offset, as: Int16.self)) / 32_768
			}
			return Float(base.loadUnaligned(fromByteOffset: offset, as: Int32.self)) / 2_147_483_648
		}
	}

	/// One source's pending samples, positioned on the shared timeline: `startFrame` is the
	/// absolute frame index of the first frame in `samples`. A negative index is ordinary — that
	/// is audio captured before the writer session started, and `dropFrames` trims it at frame
	/// zero rather than letting it move the origin.
	private struct SourceTimeline {
		private(set) var samples: [Float] = []
		private(set) var startFrame: Int64 = 0
		/// A source only counts towards "is this chunk complete" once it has produced audio…
		private(set) var hasDelivered = false
		/// …and stops counting once it has gone `emissionGraceFrames` without producing any.
		var isStalled = false
		/// Where the clock stood at this source's most recent delivery, in absolute frames.
		/// The mixer sets it, because only the mixer holds the clock.
		var lastDeliveryFrame: Int64 = 0
		/// Whether any of this source's audio has actually reached the mix. Until it has, the
		/// source is not yet established on the timeline and cannot be "late" — see
		/// `discardFrames(before:)`.
		private(set) var hasPlaced = false
		/// Captured audio that arrived too late to be placed. See `discardFrames(before:)`.
		private(set) var droppedFrames: Int64 = 0
		/// Captured audio discarded while this source was still catching up to the cursor. Also
		/// `discardFrames(before:)`, but the benign half of it — see there for why they differ.
		private(set) var trimmedFrames: Int64 = 0

		var endFrame: Int64 { startFrame + Int64(samples.count / MixFormat.channelCount) }

		mutating func ingest(_ frames: [Float], atFrame frameIndex: Int64) {
			hasDelivered = true
			isStalled = false

			if samples.isEmpty {
				startFrame = frameIndex
				samples = frames
				return
			}

			if frameIndex >= endFrame {
				let gapFrames = Int(frameIndex - endFrame)
				if gapFrames > MixFormat.maxSilencePadFrames {
					// Nothing arrived for seconds. Zero-filling the hole would allocate however
					// long the outage lasted, so restart here instead and let the mixer's own
					// clock carry the track across; the stale pending samples go with it.
					startFrame = frameIndex
					samples = frames
					return
				}
				samples.append(
					contentsOf: repeatElement(0, count: gapFrames * MixFormat.channelCount)
				)
				samples.append(contentsOf: frames)
				return
			}

			// Overlap: the source restated a span we already hold. Keep what we have and take
			// only the tail, so a retimed or duplicated buffer can't double up.
			let overlap = Int(endFrame - frameIndex) * MixFormat.channelCount
			guard overlap < frames.count else {
				return
			}
			samples.append(contentsOf: frames[overlap...])
		}

		/// Adds this source's contribution to one chunk and consumes it. Frames it doesn't cover
		/// are simply left alone — `mix` already holds silence there.
		mutating func drain(into mix: inout [Float], from cursor: Int64, frameCount: Int) {
			discardFrames(before: cursor)
			guard !samples.isEmpty else {
				return
			}

			let lead = Int(startFrame - cursor)
			guard lead < frameCount else {
				return
			}
			let usableFrames = min(frameCount - lead, samples.count / MixFormat.channelCount)
			guard usableFrames > 0 else {
				return
			}

			let base = lead * MixFormat.channelCount
			for index in 0..<(usableFrames * MixFormat.channelCount) {
				mix[base + index] += samples[index]
			}
			hasPlaced = true
			samples.removeFirst(usableFrames * MixFormat.channelCount)
			startFrame += Int64(usableFrames)
		}

		/// Discards samples the mixer has already emitted past, counting them by cause.
		///
		/// Two different things land here and only one of them is a fault. What separates them
		/// is whether this source had established itself on the timeline yet, which is what
		/// `hasPlaced` records — not where the frames sit, which was the tempting answer and the
		/// wrong one.
		///
		/// Before a source has placed anything, it is still catching up and cannot be late.
		/// `beginTimeline` opens the writer session on the first video frame, and a source only
		/// joins the quorum that can hold the cursor back once it `hasDelivered`, so the track
		/// starts moving before the audio tap has said anything at all. Whatever the tap then
		/// hands over first describes a span the cursor has already crossed — a few tens of
		/// milliseconds of it against a live ScreenCaptureKit, and all of a take's audio if the
		/// tap opened before the session did. Cutting that is how the origin stays anchored to
		/// the video instead of drifting back to meet the first sample. It is `trimmedFrames`,
		/// and it is the design working.
		///
		/// Once a source has placed audio, a discard means it went quiet for longer than
		/// `emissionGraceFrames`, had silence emitted in its place, and then handed over the
		/// period it was quiet for. That is captured audio genuinely lost: `droppedFrames`, and
		/// it should be zero.
		private mutating func discardFrames(before cursor: Int64) {
			guard startFrame < cursor else {
				return
			}

			let available = Int64(samples.count / MixFormat.channelCount)
			let discarded = min(cursor - startFrame, available)
			if discarded > 0 {
				if hasPlaced {
					droppedFrames += discarded
				} else {
					trimmedFrames += discarded
				}
				samples.removeFirst(Int(discarded) * MixFormat.channelCount)
				startFrame += discarded
			}
			if samples.isEmpty {
				startFrame = cursor
			}
		}
	}
}
