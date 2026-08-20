#include "webcam_capture.h"

#include <mfapi.h>
#include <mferror.h>
#include <propvarutil.h>

#include <algorithm>
#include <chrono>
#include <cwctype>
#include <iostream>

namespace {

bool succeeded(HRESULT hr, const char* label) {
    if (SUCCEEDED(hr)) {
        return true;
    }

    std::cerr << "ERROR: " << label << " failed (hr=0x" << std::hex << hr << std::dec << ")"
              << std::endl;
    return false;
}

std::wstring readAllocatedString(IMFActivate* activate, REFGUID key) {
    WCHAR* value = nullptr;
    UINT32 length = 0;
    if (FAILED(activate->GetAllocatedString(key, &value, &length)) || !value) {
        return {};
    }

    std::wstring result(value, value + length);
    CoTaskMemFree(value);
    return result;
}

/**
 * Does one of these appear inside the other as WHOLE WORDS?
 *
 * Plain containment answered for devices that merely share a spelling: a
 * requested "Logi" is inside "Logitech", and "Micro" inside "Microphone",
 * neither of them as a word. Matching on that resolved a camera nobody asked
 * for -- and resolving one is exactly what stops the request reaching the
 * DirectShow fallback, where the cameras Media Foundation cannot enumerate live.
 *
 * Both sides arrive normalized, so a boundary is the start of the string, its
 * end, or a space.
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

bool containsInsensitive(const std::wstring& haystack, const std::wstring& needle) {
    return containsAsWords(haystack, needle) || containsAsWords(needle, haystack);
}

std::wstring normalizeDeviceName(const std::wstring& value) {
    std::wstring normalized;
    normalized.reserve(value.size());
    bool lastWasSpace = true;
    for (const wchar_t ch : value) {
        if (std::iswalnum(ch)) {
            normalized.push_back(static_cast<wchar_t>(std::towlower(ch)));
            lastWasSpace = false;
            continue;
        }
        if (!lastWasSpace) {
            normalized.push_back(L' ');
            lastWasSpace = true;
        }
    }
    while (!normalized.empty() && normalized.back() == L' ') {
        normalized.pop_back();
    }
    return normalized;
}

/**
 * How well a candidate answers a requested name, or 0 for "not this one".
 *
 * Only decisive matches count: the names being equal once normalized, or one
 * containing the other -- which is the ordinary case, since Chromium appends USB
 * ids to what the driver reports.
 *
 * A further tier used to score shared WORDS, to bridge names differing more than
 * that. It bridged names that were not the same device. "Logi Capture" and
 * "Logitech StreamCam" share no word, yet "logi" sits inside "logitech" and that
 * scored high enough to win -- so asking for a camera Media Foundation cannot
 * enumerate opened a DIFFERENT camera, instead of returning nothing and letting
 * the DirectShow fallback find the real one (getopenscreen/openscreen#405).
 *
 * Returning 0 is what makes that fallback reachable, so it is a real answer
 * rather than a weak match. Keep this in step with
 * `electron/recording/deviceNameMatching.ts`, which states the same rules for
 * the Electron side and carries their unit tests.
 */
int deviceMatchScore(
    const std::wstring& candidateName,
    const std::wstring& candidateLink,
    const std::wstring& requestedName,
    const std::wstring& requestedId) {
    int score = 0;
    const auto normalizedName = normalizeDeviceName(candidateName);
    const auto normalizedLink = normalizeDeviceName(candidateLink);
    const auto normalizedRequestedName = normalizeDeviceName(requestedName);
    const auto normalizedRequestedId = normalizeDeviceName(requestedId);

    if (!normalizedRequestedName.empty()) {
        if (normalizedName == normalizedRequestedName) {
            score = std::max(score, 1000);
        }
        if (containsInsensitive(normalizedName, normalizedRequestedName)) {
            score = std::max(score, 900);
        }
        if (containsInsensitive(normalizedLink, normalizedRequestedName)) {
            score = std::max(score, 800);
        }
    }

    if (!normalizedRequestedId.empty()) {
        if (containsInsensitive(normalizedLink, normalizedRequestedId)) {
            score = std::max(score, 700);
        }
        if (containsInsensitive(normalizedName, normalizedRequestedId)) {
            score = std::max(score, 600);
        }
    }

    return score;
}

} // namespace

WebcamCapture::~WebcamCapture() {
    stop();
}

bool WebcamCapture::initialize(
    const std::wstring& deviceId,
    const std::wstring& deviceName,
    const std::wstring& directShowClsid,
    int requestedWidth,
    int requestedHeight,
    int requestedFps) {
    fps_ = std::clamp(requestedFps > 0 ? requestedFps : 30, 1, 60);
    usingDirectShow_ = false;
    selectedMatchScore_ = 0;
    if (!succeeded(MFStartup(MF_VERSION), "MFStartup(webcam)")) {
        if (directShowCapture_.initialize(deviceId, deviceName, directShowClsid, requestedWidth, requestedHeight, fps_)) {
            usingDirectShow_ = true;
            return true;
        }
        return false;
    }
    mfStarted_ = true;
    if (!selectDevice(deviceId, deviceName)) {
        if (mfStarted_) {
            MFShutdown();
            mfStarted_ = false;
        }
        if (directShowCapture_.initialize(deviceId, deviceName, directShowClsid, requestedWidth, requestedHeight, fps_)) {
            usingDirectShow_ = true;
            return true;
        }
        return false;
    }

    if ((!deviceId.empty() || !deviceName.empty()) && selectedMatchScore_ <= 0) {
        if (mediaSource_) {
            mediaSource_->Shutdown();
        }
        sourceReader_.Reset();
        mediaSource_.Reset();
        if (mfStarted_) {
            MFShutdown();
            mfStarted_ = false;
        }
        if (directShowCapture_.initialize(deviceId, deviceName, directShowClsid, requestedWidth, requestedHeight, fps_)) {
            usingDirectShow_ = true;
            return true;
        }
        std::cerr << "ERROR: Requested webcam device was not found by native Windows webcam providers"
                  << std::endl;
        return false;
    }

    return configureReader(requestedWidth, requestedHeight, fps_);
}

bool WebcamCapture::selectDevice(const std::wstring& deviceId, const std::wstring& deviceName) {
    Microsoft::WRL::ComPtr<IMFAttributes> attributes;
    if (!succeeded(MFCreateAttributes(&attributes, 1), "MFCreateAttributes(webcam enumeration)")) {
        return false;
    }
    if (!succeeded(attributes->SetGUID(
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
            MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID),
            "SetGUID(webcam source type)")) {
        return false;
    }

    IMFActivate** devices = nullptr;
    UINT32 deviceCount = 0;
    HRESULT hr = MFEnumDeviceSources(attributes.Get(), &devices, &deviceCount);
    if (!succeeded(hr, "MFEnumDeviceSources") || deviceCount == 0) {
        if (devices) {
            CoTaskMemFree(devices);
        }
        std::cerr << "ERROR: No native Windows webcam devices were found" << std::endl;
        return false;
    }

    UINT32 selectedIndex = 0;
    int bestScore = 0;
    for (UINT32 index = 0; index < deviceCount; index += 1) {
        const std::wstring name = readAllocatedString(devices[index], MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME);
        const std::wstring symbolicLink = readAllocatedString(devices[index], MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK);
        const int score = deviceMatchScore(name, symbolicLink, deviceName, deviceId);
        std::wcerr << L"INFO: Native webcam candidate [" << index << L"] name=\"" << name << L"\" score=" << score << std::endl;
        if (score > bestScore) {
            selectedIndex = index;
            bestScore = score;
        }
    }

    if ((!deviceId.empty() || !deviceName.empty()) && bestScore <= 0) {
        std::cerr << "WARNING: Requested webcam device was not found by Media Foundation; trying DirectShow"
                  << std::endl;
    }

    selectedMatchScore_ = bestScore;
    selectedDeviceName_ = readAllocatedString(devices[selectedIndex], MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME);
    hr = devices[selectedIndex]->ActivateObject(IID_PPV_ARGS(&mediaSource_));

    for (UINT32 index = 0; index < deviceCount; index += 1) {
        devices[index]->Release();
    }
    CoTaskMemFree(devices);

    return succeeded(hr, "ActivateObject(webcam)");
}

bool WebcamCapture::configureReader(int requestedWidth, int requestedHeight, int requestedFps) {
    Microsoft::WRL::ComPtr<IMFAttributes> attributes;
    if (!succeeded(MFCreateAttributes(&attributes, 3), "MFCreateAttributes(webcam reader)")) {
        return false;
    }
    attributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
    attributes->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, FALSE);
    // Ask the pipeline to minimize internal buffering/lookahead so a frame
    // reaches ReadSample() as soon as possible after the driver delivers it,
    // rather than sitting queued behind MF's default lookahead buffering.
    attributes->SetUINT32(MF_LOW_LATENCY, TRUE);

    if (!succeeded(MFCreateSourceReaderFromMediaSource(mediaSource_.Get(), attributes.Get(), &sourceReader_),
                   "MFCreateSourceReaderFromMediaSource(webcam)")) {
        return false;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> mediaType;
    if (!succeeded(MFCreateMediaType(&mediaType), "MFCreateMediaType(webcam output)")) {
        return false;
    }
    mediaType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    mediaType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    if (requestedWidth > 0 && requestedHeight > 0) {
        MFSetAttributeSize(mediaType.Get(), MF_MT_FRAME_SIZE, static_cast<UINT32>(requestedWidth), static_cast<UINT32>(requestedHeight));
    }
    MFSetAttributeRatio(mediaType.Get(), MF_MT_FRAME_RATE, static_cast<UINT32>(std::max(1, requestedFps)), 1);

    if (!succeeded(sourceReader_->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, mediaType.Get()),
                   "SetCurrentMediaType(webcam RGB32)")) {
        return false;
    }
    sourceReader_->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE);
    sourceReader_->SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM, TRUE);

    Microsoft::WRL::ComPtr<IMFMediaType> currentType;
    if (!succeeded(sourceReader_->GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, &currentType),
                   "GetCurrentMediaType(webcam)")) {
        return false;
    }

    UINT32 width = 0;
    UINT32 height = 0;
    if (FAILED(MFGetAttributeSize(currentType.Get(), MF_MT_FRAME_SIZE, &width, &height)) || width == 0 || height == 0) {
        width = static_cast<UINT32>(requestedWidth > 0 ? requestedWidth : 1280);
        height = static_cast<UINT32>(requestedHeight > 0 ? requestedHeight : 720);
    }
    width_ = static_cast<int>(width);
    height_ = static_cast<int>(height);
    return true;
}

bool WebcamCapture::start() {
    if (usingDirectShow_) {
        return directShowCapture_.start();
    }
    if (!sourceReader_ || thread_.joinable()) {
        return false;
    }

    stopRequested_ = false;
    thread_ = std::thread(&WebcamCapture::captureLoop, this);
    return true;
}

void WebcamCapture::stop() {
    directShowCapture_.stop();
    stopRequested_ = true;
    if (thread_.joinable()) {
        thread_.join();
    }
    if (mediaSource_) {
        mediaSource_->Shutdown();
    }
    sourceReader_.Reset();
    mediaSource_.Reset();
    if (mfStarted_) {
        MFShutdown();
        mfStarted_ = false;
    }
}

void WebcamCapture::captureLoop() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    while (!stopRequested_) {
        DWORD streamIndex = 0;
        DWORD flags = 0;
        LONGLONG timestamp = 0;
        Microsoft::WRL::ComPtr<IMFSample> sample;
        HRESULT hr = sourceReader_->ReadSample(
            MF_SOURCE_READER_FIRST_VIDEO_STREAM,
            0,
            &streamIndex,
            &flags,
            &timestamp,
            &sample);
        (void)streamIndex;
        (void)timestamp;

        if (FAILED(hr)) {
            std::cerr << "WARNING: Failed to read webcam sample (hr=0x" << std::hex << hr << std::dec << ")"
                      << std::endl;
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
            continue;
        }
        if ((flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0) {
            break;
        }
        if (!sample) {
            continue;
        }

        Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
        if (FAILED(sample->ConvertToContiguousBuffer(&buffer)) || !buffer) {
            continue;
        }

        BYTE* data = nullptr;
        DWORD maxLength = 0;
        DWORD currentLength = 0;
        if (FAILED(buffer->Lock(&data, &maxLength, &currentLength)) || !data) {
            continue;
        }

        const DWORD expectedLength = static_cast<DWORD>(std::max(0, width_) * std::max(0, height_) * 4);
        if (currentLength >= expectedLength && expectedLength > 0) {
            std::scoped_lock lock(frameMutex_);
            latestFrame_.assign(data, data + expectedLength);
            latestFrameSequence_ += 1;
        }

        buffer->Unlock();
    }

    CoUninitialize();
}

bool WebcamCapture::copyLatestFrame(WebcamFrameSnapshot& destination) {
    if (usingDirectShow_) {
        return directShowCapture_.copyLatestFrame(destination);
    }
    std::scoped_lock lock(frameMutex_);
    if (latestFrame_.empty() || width_ <= 0 || height_ <= 0) {
        return false;
    }

    destination.data = latestFrame_;
    destination.width = width_;
    destination.height = height_;
    destination.sequence = latestFrameSequence_;
    return true;
}

int WebcamCapture::width() const {
    if (usingDirectShow_) {
        return directShowCapture_.width();
    }
    return width_;
}

int WebcamCapture::height() const {
    if (usingDirectShow_) {
        return directShowCapture_.height();
    }
    return height_;
}

int WebcamCapture::fps() const {
    if (usingDirectShow_) {
        return directShowCapture_.fps();
    }
    return fps_;
}

const std::wstring& WebcamCapture::selectedDeviceName() const {
    if (usingDirectShow_) {
        return directShowCapture_.selectedDeviceName();
    }
    return selectedDeviceName_;
}
