#include "wasapi_loopback_capture.h"

#include <ksmedia.h>

#include <algorithm>
#include <chrono>
#include <iostream>

namespace {

constexpr REFERENCE_TIME BufferDurationHns = 10'000'000;
constexpr int64_t HnsPerSecond = 10'000'000;

bool succeeded(HRESULT hr, const char* label) {
    if (SUCCEEDED(hr)) {
        return true;
    }

    std::cerr << "ERROR: " << label << " failed (hr=0x" << std::hex << hr << std::dec << ")"
              << std::endl;
    return false;
}

GUID audioSubtypeFromFormat(WAVEFORMATEX* format) {
    if (format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
        return MFAudioFormat_Float;
    }
    if (format->wFormatTag == WAVE_FORMAT_PCM) {
        return MFAudioFormat_PCM;
    }
    if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
        format->cbSize >= sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) {
        auto* extensible = reinterpret_cast<WAVEFORMATEXTENSIBLE*>(format);
        if (extensible->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) {
            return MFAudioFormat_Float;
        }
        if (extensible->SubFormat == KSDATAFORMAT_SUBTYPE_PCM) {
            return MFAudioFormat_PCM;
        }
    }
    return GUID_NULL;
}

} // namespace

WasapiLoopbackCapture::~WasapiLoopbackCapture() {
    stop();
    if (mixFormat_) {
        CoTaskMemFree(mixFormat_);
        mixFormat_ = nullptr;
    }
}

bool WasapiLoopbackCapture::initializeSystemLoopback() {
    return initialize(WasapiCaptureEndpoint::SystemLoopback, {});
}

bool WasapiLoopbackCapture::initializeMicrophone(const std::wstring& deviceId) {
    return initialize(WasapiCaptureEndpoint::Microphone, deviceId);
}

bool WasapiLoopbackCapture::initialize(WasapiCaptureEndpoint endpoint, const std::wstring& deviceId) {
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator),
        nullptr,
        CLSCTX_ALL,
        IID_PPV_ARGS(&deviceEnumerator_));
    if (!succeeded(hr, "CoCreateInstance(MMDeviceEnumerator)")) {
        return false;
    }

    if (endpoint == WasapiCaptureEndpoint::Microphone && !deviceId.empty() && deviceId != L"default") {
        hr = deviceEnumerator_->GetDevice(deviceId.c_str(), &device_);
        if (FAILED(hr)) {
            std::wcerr << L"WARNING: Could not resolve microphone device id; using default capture endpoint"
                       << std::endl;
            device_.Reset();
        }
    }

    if (!device_) {
        const EDataFlow flow =
            endpoint == WasapiCaptureEndpoint::SystemLoopback ? eRender : eCapture;
        hr = deviceEnumerator_->GetDefaultAudioEndpoint(flow, eConsole, &device_);
        if (!succeeded(hr, "GetDefaultAudioEndpoint")) {
            return false;
        }
    }

    hr = device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &audioClient_);
    if (!succeeded(hr, "IMMDevice::Activate(IAudioClient)")) {
        return false;
    }

    hr = audioClient_->GetMixFormat(&mixFormat_);
    if (!succeeded(hr, "IAudioClient::GetMixFormat") || !mixFormat_) {
        return false;
    }

    if (!resolveInputFormat(mixFormat_)) {
        std::cerr << "ERROR: Unsupported WASAPI loopback mix format" << std::endl;
        return false;
    }

    const DWORD streamFlags =
        endpoint == WasapiCaptureEndpoint::SystemLoopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
    hr = audioClient_->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        streamFlags,
        BufferDurationHns,
        0,
        mixFormat_,
        nullptr);
    if (!succeeded(hr, "IAudioClient::Initialize(loopback)")) {
        return false;
    }

    hr = audioClient_->GetService(IID_PPV_ARGS(&captureClient_));
    if (!succeeded(hr, "IAudioClient::GetService(IAudioCaptureClient)")) {
        return false;
    }

    return true;
}

bool WasapiLoopbackCapture::resolveInputFormat(WAVEFORMATEX* mixFormat) {
    const GUID subtype = audioSubtypeFromFormat(mixFormat);
    if (subtype == GUID_NULL) {
        return false;
    }

    inputFormat_.subtype = subtype;
    inputFormat_.sampleRate = mixFormat->nSamplesPerSec;
    inputFormat_.channels = mixFormat->nChannels;
    inputFormat_.bitsPerSample = mixFormat->wBitsPerSample;
    inputFormat_.blockAlign = mixFormat->nBlockAlign;
    inputFormat_.avgBytesPerSec = mixFormat->nAvgBytesPerSec;
    return inputFormat_.sampleRate > 0 && inputFormat_.channels > 0 && inputFormat_.blockAlign > 0;
}

bool WasapiLoopbackCapture::start(AudioCallback callback) {
    if (!audioClient_ || !captureClient_ || !callback) {
        return false;
    }

    callback_ = std::move(callback);
    stopRequested_ = false;
    writtenFrames_ = 0;

    HRESULT hr = audioClient_->Start();
    if (!succeeded(hr, "IAudioClient::Start")) {
        return false;
    }

    thread_ = std::thread([this] {
        captureLoop();
    });
    return true;
}

void WasapiLoopbackCapture::stop() {
    stopRequested_ = true;
    if (thread_.joinable()) {
        thread_.join();
    }
    if (audioClient_) {
        audioClient_->Stop();
    }
}

const AudioInputFormat& WasapiLoopbackCapture::inputFormat() const {
    return inputFormat_;
}

void WasapiLoopbackCapture::captureLoop() {
    while (!stopRequested_) {
        UINT32 packetFrames = 0;
        HRESULT hr = captureClient_->GetNextPacketSize(&packetFrames);
        if (FAILED(hr)) {
            std::cerr << "ERROR: IAudioCaptureClient::GetNextPacketSize failed (hr=0x" << std::hex
                      << hr << std::dec << ")" << std::endl;
            break;
        }

        while (packetFrames > 0 && !stopRequested_) {
            BYTE* data = nullptr;
            UINT32 framesAvailable = 0;
            DWORD flags = 0;

            hr = captureClient_->GetBuffer(&data, &framesAvailable, &flags, nullptr, nullptr);
            if (FAILED(hr)) {
                std::cerr << "ERROR: IAudioCaptureClient::GetBuffer failed (hr=0x" << std::hex
                          << hr << std::dec << ")" << std::endl;
                break;
            }

            const DWORD byteCount = framesAvailable * inputFormat_.blockAlign;
            const int64_t timestampHns =
                static_cast<int64_t>((writtenFrames_ * HnsPerSecond) / inputFormat_.sampleRate);
            const int64_t durationHns =
                static_cast<int64_t>((static_cast<uint64_t>(framesAvailable) * HnsPerSecond) /
                                     inputFormat_.sampleRate);

            if (byteCount > 0) {
                if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || !data) {
                    silenceBuffer_.assign(byteCount, 0);
                    callback_(silenceBuffer_.data(), byteCount, timestampHns, durationHns);
                } else {
                    callback_(data, byteCount, timestampHns, durationHns);
                }
            }

            writtenFrames_ += framesAvailable;
            captureClient_->ReleaseBuffer(framesAvailable);

            hr = captureClient_->GetNextPacketSize(&packetFrames);
            if (FAILED(hr)) {
                std::cerr << "ERROR: IAudioCaptureClient::GetNextPacketSize failed (hr=0x"
                          << std::hex << hr << std::dec << ")" << std::endl;
                packetFrames = 0;
                break;
            }
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

}
