#include "wasapi_loopback_capture.h"

#include <Functiondiscoverykeys_devpkey.h>
#include <ksmedia.h>
#include <propvarutil.h>

#include <algorithm>
#include <chrono>
#include <cwctype>
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

std::wstring normalizeDeviceName(const std::wstring& value) {
    std::wstring result;
    result.reserve(value.size());
    bool lastWasSpace = true;

    for (const wchar_t c : value) {
        if (std::iswalnum(c)) {
            result.push_back(static_cast<wchar_t>(std::towlower(c)));
            lastWasSpace = false;
        } else if (!lastWasSpace) {
            result.push_back(L' ');
            lastWasSpace = true;
        }
    }

    if (!result.empty() && result.back() == L' ') {
        result.pop_back();
    }
    return result;
}

int scoreDeviceName(const std::wstring& candidateName, const std::wstring& candidateId, const std::wstring& requestedName) {
    const std::wstring candidate = normalizeDeviceName(candidateName);
    const std::wstring id = normalizeDeviceName(candidateId);
    const std::wstring requested = normalizeDeviceName(requestedName);
    if (requested.empty()) {
        return 0;
    }
    if (candidate == requested) {
        return 1000;
    }
    if (!candidate.empty() && (candidate.find(requested) != std::wstring::npos || requested.find(candidate) != std::wstring::npos)) {
        return 900;
    }
    if (!id.empty() && (id.find(requested) != std::wstring::npos || requested.find(id) != std::wstring::npos)) {
        return 800;
    }

    int score = 0;
    size_t pos = 0;
    while (pos < requested.size()) {
        const size_t end = requested.find(L' ', pos);
        const std::wstring word = requested.substr(pos, end == std::wstring::npos ? std::wstring::npos : end - pos);
        if (word.size() > 1 && word != L"microphone" && word != L"mic" && word != L"audio" && word != L"input") {
            if (candidate.find(word) != std::wstring::npos) {
                score += 100;
            } else if (id.find(word) != std::wstring::npos) {
                score += 50;
            }
        }
        if (end == std::wstring::npos) {
            break;
        }
        pos = end + 1;
    }
    return score;
}

std::wstring getDeviceFriendlyName(IMMDevice* device) {
    if (!device) {
        return {};
    }

    Microsoft::WRL::ComPtr<IPropertyStore> properties;
    HRESULT hr = device->OpenPropertyStore(STGM_READ, &properties);
    if (FAILED(hr) || !properties) {
        return {};
    }

    PROPVARIANT value;
    PropVariantInit(&value);
    hr = properties->GetValue(PKEY_Device_FriendlyName, &value);
    std::wstring name;
    if (SUCCEEDED(hr) && value.vt == VT_LPWSTR && value.pwszVal) {
        name = value.pwszVal;
    }
    PropVariantClear(&value);
    return name;
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
    return initialize(WasapiCaptureEndpoint::SystemLoopback, {}, {});
}

bool WasapiLoopbackCapture::initializeMicrophone(const std::wstring& deviceId, const std::wstring& deviceName) {
    return initialize(WasapiCaptureEndpoint::Microphone, deviceId, deviceName);
}

bool WasapiLoopbackCapture::initialize(WasapiCaptureEndpoint endpoint, const std::wstring& deviceId, const std::wstring& deviceName) {
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
            std::wcerr << L"WARNING: Could not resolve microphone device id directly"
                       << std::endl;
            device_.Reset();
        }
    }

    if (endpoint == WasapiCaptureEndpoint::Microphone && !device_ && !deviceName.empty()) {
        if (!resolveMicrophoneByName(deviceName)) {
            std::wcerr << L"WARNING: Could not resolve microphone by name; using default capture endpoint"
                       << std::endl;
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

    selectedDeviceName_ = getDeviceFriendlyName(device_.Get());

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

bool WasapiLoopbackCapture::resolveMicrophoneByName(const std::wstring& deviceName) {
    if (!deviceEnumerator_ || deviceName.empty()) {
        return false;
    }

    Microsoft::WRL::ComPtr<IMMDeviceCollection> devices;
    HRESULT hr = deviceEnumerator_->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &devices);
    if (!succeeded(hr, "IMMDeviceEnumerator::EnumAudioEndpoints(eCapture)")) {
        return false;
    }

    UINT count = 0;
    hr = devices->GetCount(&count);
    if (!succeeded(hr, "IMMDeviceCollection::GetCount")) {
        return false;
    }

    Microsoft::WRL::ComPtr<IMMDevice> bestDevice;
    std::wstring bestId;
    std::wstring bestName;
    int bestScore = 0;
    for (UINT i = 0; i < count; ++i) {
        Microsoft::WRL::ComPtr<IMMDevice> candidate;
        hr = devices->Item(i, &candidate);
        if (FAILED(hr) || !candidate) {
            continue;
        }

        LPWSTR rawId = nullptr;
        std::wstring candidateId;
        if (SUCCEEDED(candidate->GetId(&rawId)) && rawId) {
            candidateId = rawId;
            CoTaskMemFree(rawId);
        }

        const std::wstring candidateName = getDeviceFriendlyName(candidate.Get());
        const int score = scoreDeviceName(candidateName, candidateId, deviceName);
        std::wcerr << L"Native microphone candidate: " << candidateName << L" score=" << score << std::endl;
        if (score > bestScore) {
            bestScore = score;
            bestDevice = candidate;
            bestId = candidateId;
            bestName = candidateName;
        }
    }

    if (!bestDevice || bestScore <= 0) {
        return false;
    }

    device_ = bestDevice;
    std::wcerr << L"Selected native microphone endpoint: " << bestName << L" id=" << bestId << std::endl;
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

const std::wstring& WasapiLoopbackCapture::selectedDeviceName() const {
    return selectedDeviceName_;
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
