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

/**
 * Does `needle` appear in `haystack` as whole words?
 *
 * Plain containment is what let a requested "Micro" answer for
 * "Microphone (Logitech StreamCam)" -- the request is inside the name, just not
 * as a word -- and a requested "Logi" for "Logitech". Either resolved an
 * endpoint nobody asked for, and silenced the fallback warning by doing so.
 *
 * Both sides are normalized, so a boundary is the start of the string, the end,
 * or a space.
 */
bool containsAsWords(const std::wstring& haystack, const std::wstring& needle) {
    if (haystack.empty() || needle.empty()) {
        return false;
    }
    size_t pos = haystack.find(needle);
    while (pos != std::wstring::npos) {
        const bool startsOnBoundary = pos == 0 || haystack[pos - 1] == L' ';
        const size_t after = pos + needle.size();
        const bool endsOnBoundary = after == haystack.size() || haystack[after] == L' ';
        if (startsOnBoundary && endsOnBoundary) {
            return true;
        }
        pos = haystack.find(needle, pos + 1);
    }
    return false;
}

/**
 * How well a candidate endpoint answers a requested name, or 0 for "not this
 * one" -- which the caller must treat as a real answer.
 *
 * Only decisive matches count: equal once normalized, or one containing the
 * other, which is the ordinary case since Chromium appends USB ids to what the
 * driver reports.
 *
 * A further tier used to score shared WORDS, to bridge names differing more than
 * that. It bridged endpoints that were not the same device -- a requested
 * "micro" matched the "microphone" that opens nearly every Windows endpoint
 * name, so asking for a microphone that does not exist quietly recorded
 * whichever one sorted first, and the fallback warning could not fire because a
 * device HAD been resolved (getopenscreen/openscreen#404). Returning 0 is what
 * makes that warning reachable.
 */
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
    if (containsAsWords(candidate, requested) || containsAsWords(requested, candidate)) {
        return 900;
    }
    if (containsAsWords(id, requested) || containsAsWords(requested, id)) {
        return 800;
    }

    return 0;
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
        // A particular microphone was asked for and nothing here could find it,
        // so the recording is about to capture whatever Windows calls the default
        // input. Worth saying out loud, and keyed on the OUTCOME rather than on
        // which lookup failed: the caller sends an empty name when it could not
        // resolve one in time, but a name that simply matches no endpoint lands
        // in exactly the same place. Either way the take sounds like the wrong
        // microphone with nothing explaining why (getopenscreen/openscreen#404).
        const bool wantedAParticularMicrophone =
            endpoint == WasapiCaptureEndpoint::Microphone &&
            ((!deviceId.empty() && deviceId != L"default") || !deviceName.empty());
        if (wantedAParticularMicrophone) {
            std::cerr << "{\"event\":\"warning\",\"code\":\"microphone-defaulted\","
                         "\"message\":\"The requested microphone could not be resolved; "
                         "capturing the default input\"}"
                      << std::endl;
        }

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
    lastDevicePositionEnd_ = 0;
    hasLastDevicePosition_ = false;

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
    auto emitSilenceFrames = [&](uint64_t frames, int64_t timestampHns) {
        constexpr uint64_t MaxSilenceChunkFrames = 4800;
        uint64_t remainingFrames = frames;
        int64_t currentTimestampHns = timestampHns;
        while (remainingFrames > 0 && !stopRequested_) {
            const uint64_t chunkFrames = std::min<uint64_t>(remainingFrames, MaxSilenceChunkFrames);
            const DWORD chunkBytes = static_cast<DWORD>(chunkFrames * inputFormat_.blockAlign);
            const int64_t chunkDurationHns =
                static_cast<int64_t>((chunkFrames * HnsPerSecond) / inputFormat_.sampleRate);
            silenceBuffer_.assign(chunkBytes, 0);
            callback_(silenceBuffer_.data(), chunkBytes, currentTimestampHns, chunkDurationHns);
            remainingFrames -= chunkFrames;
            currentTimestampHns += chunkDurationHns;
        }
    };

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
            UINT64 devicePosition = 0;
            UINT64 qpcPosition = 0;

            hr = captureClient_->GetBuffer(&data, &framesAvailable, &flags, &devicePosition, &qpcPosition);
            if (FAILED(hr)) {
                std::cerr << "ERROR: IAudioCaptureClient::GetBuffer failed (hr=0x" << std::hex
                          << hr << std::dec << ")" << std::endl;
                break;
            }

            (void)qpcPosition;
            if (hasLastDevicePosition_ && devicePosition > lastDevicePositionEnd_) {
                const uint64_t gapFrames = devicePosition - lastDevicePositionEnd_;
                if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0 || gapFrames > framesAvailable) {
                    const int64_t gapTimestampHns =
                        static_cast<int64_t>((lastDevicePositionEnd_ * HnsPerSecond) / inputFormat_.sampleRate);
                    emitSilenceFrames(gapFrames, gapTimestampHns);
                }
            }

            const DWORD byteCount = framesAvailable * inputFormat_.blockAlign;
            const int64_t timestampHns =
                static_cast<int64_t>((devicePosition * HnsPerSecond) / inputFormat_.sampleRate);
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
            lastDevicePositionEnd_ = devicePosition + framesAvailable;
            hasLastDevicePosition_ = true;
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
