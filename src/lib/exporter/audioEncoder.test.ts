import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioProcessor } from "./audioEncoder";

describe("AudioProcessor.selectSupportedExportCodec", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("falls back to stereo when the source channel count cannot be encoded", async () => {
		const isConfigSupported = vi.fn(async (config: AudioEncoderConfig) => ({
			config,
			supported:
				config.codec === "mp4a.40.2" &&
				config.sampleRate === 44100 &&
				config.numberOfChannels === 2,
		}));
		vi.stubGlobal("AudioEncoder", { isConfigSupported });

		const codec = await AudioProcessor.selectSupportedExportCodec(44100, 8);

		expect(codec).toMatchObject({
			encoderCodec: "mp4a.40.2",
			muxerCodec: "aac",
			sampleRate: 44100,
			numberOfChannels: 2,
		});
		expect(isConfigSupported).toHaveBeenCalledWith({
			codec: "mp4a.40.2",
			sampleRate: 44100,
			numberOfChannels: 8,
			bitrate: 128000,
		});
		expect(isConfigSupported).toHaveBeenCalledWith({
			codec: "mp4a.40.2",
			sampleRate: 44100,
			numberOfChannels: 2,
			bitrate: 128000,
		});
	});
});
