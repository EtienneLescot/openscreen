import AVFoundation
import CoreMedia
import Foundation

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
/// of sync. A chunk goes out as soon as every live source covers it — or, once some other
/// source has run `stallToleranceFrames` past it, without it, so a microphone that goes quiet
/// or disappears mid-recording can never stall the track.
///
/// Not thread-safe by design: every entry point runs on the recorder's serial sample queue,
/// which is also the queue ScreenCaptureKit delivers both audio outputs on.
@available(macOS 13.0, *)
final class AudioTrackMixer {
	enum Source: Int, CaseIterable {
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
		/// How far ahead one source may run before the ones lagging behind it are written off
		/// as stalled and the chunk goes out without them. Two orders of magnitude above the
		/// delivery skew between two outputs of the same SCStream, so ordinary jitter never
		/// trips it; the file is written offline, so the latency it buys back costs nothing.
		static let stallToleranceFrames = sampleRate / 4
		/// Longest hole a source may silence-pad across. Past this the source has been dead
		/// long enough that padding would materialize however long the outage lasted.
		static let maxSilencePadFrames = sampleRate * 2
		/// Writer backpressure allowance, in chunks (5 s). `expectsMediaDataInRealTime` keeps
		/// this at zero or one in practice; the cap only bounds a pathological writer stall.
		static let maxPendingChunks = 500
		/// How long the final flush waits for the input to accept the tail before giving up.
		static let finalFlushTimeout = 5.0
	}

	private let input: AVAssetWriterInput
	private let includesSystemAudio: Bool
	private let includesMicrophone: Bool
	private let microphoneGain: Float
	private let outputFormatDescription: CMAudioFormatDescription?

	private var sources = [SourceTimeline](repeating: SourceTimeline(), count: Source.allCases.count)
	private var sessionStart: CMTime?
	/// Timeline origin: frame 0 of the mixed track, in the writer's time domain.
	private var anchor: CMTime?
	/// Absolute frame index of the next chunk to emit.
	private var cursor: Int64 = 0
	private var pending: [CMSampleBuffer] = []
	private var didWarnAboutBacklog = false
	private var didWarnAboutDecode: Set<Int> = []

	init(
		input: AVAssetWriterInput,
		includesSystemAudio: Bool,
		includesMicrophone: Bool,
		microphoneGain: Double
	) {
		self.input = input
		self.includesSystemAudio = includesSystemAudio
		self.includesMicrophone = includesMicrophone
		// The request carries MIC_GAIN_BOOST (1.4); Windows applies it unconditionally and so
		// does this. A non-finite or negative value would poison every mixed sample.
		let sanitized = microphoneGain.isFinite ? max(0, microphoneGain) : 1
		self.microphoneGain = Float(sanitized)
		self.outputFormatDescription = Self.makeOutputFormatDescription()
	}

	/// Anchors the mixer to the writer session. Audio delivered before this is dropped — the
	/// writer would reject anything ahead of its session start anyway.
	func beginTimeline(at sessionStart: CMTime) {
		guard self.sessionStart == nil, sessionStart.isValid else {
			return
		}

		self.sessionStart = sessionStart
	}

	func ingest(_ sampleBuffer: CMSampleBuffer, from source: Source) {
		guard includes(source), let sessionStart else {
			return
		}
		let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
		guard presentationTime.isValid else {
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

		if anchor == nil {
			anchor = CMTimeConvertScale(
				CMTimeMaximum(presentationTime, sessionStart),
				timescale: CMTimeScale(MixFormat.sampleRate),
				method: .roundHalfAwayFromZero
			)
		}
		guard let anchor else {
			return
		}

		let offset = CMTimeConvertScale(
			CMTimeSubtract(presentationTime, anchor),
			timescale: CMTimeScale(MixFormat.sampleRate),
			method: .roundHalfAwayFromZero
		)
		sources[source.rawValue].ingest(frames, atFrame: offset.value)
		drain(flushing: false)
	}

	/// Writes out everything still buffered. Call once, on the sample queue, before the
	/// writer input is marked as finished.
	func finish() {
		drain(flushing: true)
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

	/// Emits every chunk that is ready. A chunk is ready once all live sources cover it; when
	/// one source has run far enough ahead of another, the laggard is marked stalled and the
	/// chunk goes out with silence in its place. That is what keeps a dead microphone — or a
	/// system-audio device that stops delivering — from blocking the whole track.
	private func drain(flushing: Bool) {
		while true {
			let delivered = sources.indices.filter { sources[$0].hasDelivered }
			guard let furthest = delivered.map({ sources[$0].endFrame }).max(), furthest > cursor else {
				break
			}

			let chunkEnd = cursor + Int64(MixFormat.chunkFrames)
			let live = delivered.filter { !sources[$0].isStalled }
			let complete = live.allSatisfy { sources[$0].endFrame >= chunkEnd }
			if !complete && !flushing {
				if furthest < chunkEnd + Int64(MixFormat.stallToleranceFrames) {
					break
				}
				for index in live where sources[index].endFrame < chunkEnd {
					sources[index].isStalled = true
				}
			}

			// emitChunk always advances the cursor when it can; bailing out on the one case
			// where it cannot is what stops this loop from spinning forever.
			guard emitChunk() else {
				break
			}
		}
	}

	@discardableResult
	private func emitChunk() -> Bool {
		guard let anchor else {
			return false
		}

		var mix = [Float](repeating: 0, count: MixFormat.chunkFrames * MixFormat.channelCount)
		for index in sources.indices {
			sources[index].drain(into: &mix, from: cursor, frameCount: MixFormat.chunkFrames)
		}

		let presentationTime = CMTimeAdd(
			anchor,
			CMTime(value: cursor, timescale: CMTimeScale(MixFormat.sampleRate))
		)
		cursor += Int64(MixFormat.chunkFrames)

		guard let sampleBuffer = makeSampleBuffer(from: mix, at: presentationTime) else {
			return true
		}
		pending.append(sampleBuffer)
		flushPending(force: false)
		return true
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
	/// absolute frame index of the first frame in `samples`.
	private struct SourceTimeline {
		private(set) var samples: [Float] = []
		private(set) var startFrame: Int64 = 0
		/// A source only counts towards "is this chunk complete" once it has produced audio…
		private(set) var hasDelivered = false
		/// …and stops counting the moment it misses a chunk the others already covered.
		var isStalled = false

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
					// catch-up carry the track across; the stale pending samples go with it.
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

		/// Adds this source's contribution to one chunk and consumes it. Frames the source
		/// doesn't cover are simply left alone — `mix` already holds silence there.
		mutating func drain(into mix: inout [Float], from cursor: Int64, frameCount: Int) {
			dropFrames(before: cursor)
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
			samples.removeFirst(usableFrames * MixFormat.channelCount)
			startFrame += Int64(usableFrames)
		}

		/// Discards samples the mixer has already emitted past — a buffer that arrived after
		/// its chunk went out cannot be placed any more.
		private mutating func dropFrames(before cursor: Int64) {
			guard startFrame < cursor else {
				return
			}

			let available = Int64(samples.count / MixFormat.channelCount)
			let dropFrames = Int(min(cursor - startFrame, available))
			if dropFrames > 0 {
				samples.removeFirst(dropFrames * MixFormat.channelCount)
				startFrame += Int64(dropFrames)
			}
			if samples.isEmpty {
				startFrame = cursor
			}
		}
	}
}
