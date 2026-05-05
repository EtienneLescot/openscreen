#pragma once

#include "mf_encoder.h"

#include <Windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <thread>
#include <vector>

class WasapiLoopbackCapture {
public:
    using AudioCallback = std::function<void(const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns)>;

    WasapiLoopbackCapture() = default;
    ~WasapiLoopbackCapture();

    WasapiLoopbackCapture(const WasapiLoopbackCapture&) = delete;
    WasapiLoopbackCapture& operator=(const WasapiLoopbackCapture&) = delete;

    bool initialize();
    bool start(AudioCallback callback);
    void stop();

    const AudioInputFormat& inputFormat() const;

private:
    void captureLoop();
    bool resolveInputFormat(WAVEFORMATEX* mixFormat);

    Microsoft::WRL::ComPtr<IMMDeviceEnumerator> deviceEnumerator_;
    Microsoft::WRL::ComPtr<IMMDevice> device_;
    Microsoft::WRL::ComPtr<IAudioClient> audioClient_;
    Microsoft::WRL::ComPtr<IAudioCaptureClient> captureClient_;
    WAVEFORMATEX* mixFormat_ = nullptr;
    AudioInputFormat inputFormat_{};
    AudioCallback callback_;
    std::thread thread_;
    std::atomic<bool> stopRequested_ = false;
    std::vector<BYTE> silenceBuffer_;
    uint64_t writtenFrames_ = 0;
};
