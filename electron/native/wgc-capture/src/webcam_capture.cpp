#include "webcam_capture.h"

#include <mfapi.h>
#include <mferror.h>
#include <propvarutil.h>

#include <algorithm>
#include <chrono>
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

bool containsInsensitive(const std::wstring& haystack, const std::wstring& needle) {
    if (haystack.empty() || needle.empty()) {
        return false;
    }

    std::wstring lowerHaystack = haystack;
    std::wstring lowerNeedle = needle;
    std::transform(lowerHaystack.begin(), lowerHaystack.end(), lowerHaystack.begin(), ::towlower);
    std::transform(lowerNeedle.begin(), lowerNeedle.end(), lowerNeedle.begin(), ::towlower);
    return lowerHaystack.find(lowerNeedle) != std::wstring::npos ||
        lowerNeedle.find(lowerHaystack) != std::wstring::npos;
}

} // namespace

WebcamCapture::~WebcamCapture() {
    stop();
}

bool WebcamCapture::initialize(const std::wstring& deviceId, int requestedWidth, int requestedHeight, int requestedFps) {
    fps_ = std::clamp(requestedFps > 0 ? requestedFps : 30, 1, 60);
    if (!succeeded(MFStartup(MF_VERSION), "MFStartup(webcam)")) {
        return false;
    }
    mfStarted_ = true;
    if (!selectDevice(deviceId)) {
        return false;
    }

    return configureReader(requestedWidth, requestedHeight, fps_);
}

bool WebcamCapture::selectDevice(const std::wstring& deviceId) {
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
    for (UINT32 index = 0; index < deviceCount; index += 1) {
        const std::wstring name = readAllocatedString(devices[index], MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME);
        const std::wstring symbolicLink = readAllocatedString(devices[index], MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK);
        if (!deviceId.empty() && (containsInsensitive(symbolicLink, deviceId) || containsInsensitive(name, deviceId))) {
            selectedIndex = index;
            break;
        }
    }

    if (!deviceId.empty() && selectedIndex == 0) {
        const std::wstring firstName = readAllocatedString(devices[0], MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME);
        const std::wstring firstLink = readAllocatedString(devices[0], MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK);
        if (!containsInsensitive(firstLink, deviceId) && !containsInsensitive(firstName, deviceId)) {
            std::cerr << "WARNING: Requested webcam device was not found by Media Foundation; using default webcam"
                      << std::endl;
        }
    }

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
    if (!succeeded(MFCreateAttributes(&attributes, 2), "MFCreateAttributes(webcam reader)")) {
        return false;
    }
    attributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
    attributes->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, FALSE);

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
    if (!sourceReader_ || thread_.joinable()) {
        return false;
    }

    stopRequested_ = false;
    thread_ = std::thread(&WebcamCapture::captureLoop, this);
    return true;
}

void WebcamCapture::stop() {
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
        }

        buffer->Unlock();
    }

    CoUninitialize();
}

bool WebcamCapture::copyLatestFrame(std::vector<BYTE>& destination, int& width, int& height) {
    std::scoped_lock lock(frameMutex_);
    if (latestFrame_.empty() || width_ <= 0 || height_ <= 0) {
        return false;
    }

    destination = latestFrame_;
    width = width_;
    height = height_;
    return true;
}

int WebcamCapture::width() const {
    return width_;
}

int WebcamCapture::height() const {
    return height_;
}

int WebcamCapture::fps() const {
    return fps_;
}

const std::wstring& WebcamCapture::selectedDeviceName() const {
    return selectedDeviceName_;
}
