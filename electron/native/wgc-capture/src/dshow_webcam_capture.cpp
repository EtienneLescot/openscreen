#include "dshow_webcam_capture.h"

#include <initguid.h>
#include <dshow.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cwctype>
#include <iostream>

namespace {

const CLSID CLSID_SampleGrabberLocal = {0xC1F400A0, 0x3F08, 0x11D3, {0x9F, 0x0B, 0x00, 0x60, 0x08, 0x03, 0x9E, 0x37}};
const CLSID CLSID_NullRendererLocal = {0xC1F400A4, 0x3F08, 0x11D3, {0x9F, 0x0B, 0x00, 0x60, 0x08, 0x03, 0x9E, 0x37}};

MIDL_INTERFACE("0579154A-2B53-4994-B0D0-E773148EFF85")
ISampleGrabberCB : public IUnknown {
public:
    virtual HRESULT STDMETHODCALLTYPE SampleCB(double sampleTime, IMediaSample* sample) = 0;
    virtual HRESULT STDMETHODCALLTYPE BufferCB(double sampleTime, BYTE* buffer, long bufferLength) = 0;
};

MIDL_INTERFACE("6B652FFF-11FE-4FCE-92AD-0266B5D7C78F")
ISampleGrabber : public IUnknown {
public:
    virtual HRESULT STDMETHODCALLTYPE SetOneShot(BOOL oneShot) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetMediaType(const AM_MEDIA_TYPE* type) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetConnectedMediaType(AM_MEDIA_TYPE* type) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetBufferSamples(BOOL bufferThem) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetCurrentBuffer(long* bufferSize, long* buffer) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetCurrentSample(IMediaSample** sample) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetCallback(ISampleGrabberCB* callback, long whichMethodToCallback) = 0;
};

bool succeeded(HRESULT hr, const char* label) {
    if (SUCCEEDED(hr)) {
        return true;
    }

    std::cerr << "ERROR: " << label << " failed (hr=0x" << std::hex << hr << std::dec << ")"
              << std::endl;
    return false;
}

std::wstring readPropertyString(IPropertyBag* bag, LPCOLESTR key) {
    VARIANT value;
    VariantInit(&value);
    if (FAILED(bag->Read(key, &value, nullptr)) || value.vt != VT_BSTR || !value.bstrVal) {
        VariantClear(&value);
        return {};
    }

    std::wstring result(value.bstrVal);
    VariantClear(&value);
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

std::vector<std::wstring> splitWords(const std::wstring& value) {
    std::vector<std::wstring> words;
    size_t start = 0;
    while (start < value.size()) {
        const size_t end = value.find(L' ', start);
        const auto word = value.substr(start, end == std::wstring::npos ? std::wstring::npos : end - start);
        if (word.size() > 1 && word != L"camera" && word != L"webcam" && word != L"video" && word != L"input") {
            words.push_back(word);
        }
        if (end == std::wstring::npos) {
            break;
        }
        start = end + 1;
    }
    return words;
}

int deviceMatchScore(
    const std::wstring& candidateName,
    const std::wstring& candidatePath,
    const std::wstring& requestedName,
    const std::wstring& requestedId) {
    int score = 0;
    const auto normalizedName = normalizeDeviceName(candidateName);
    const auto normalizedPath = normalizeDeviceName(candidatePath);
    const auto normalizedRequestedName = normalizeDeviceName(requestedName);
    const auto normalizedRequestedId = normalizeDeviceName(requestedId);

    if (!normalizedRequestedName.empty()) {
        if (normalizedName == normalizedRequestedName) {
            score = std::max(score, 1000);
        }
        if (containsInsensitive(normalizedName, normalizedRequestedName)) {
            score = std::max(score, 900);
        }
        if (containsInsensitive(normalizedPath, normalizedRequestedName)) {
            score = std::max(score, 800);
        }

        int wordScore = 0;
        for (const auto& word : splitWords(normalizedRequestedName)) {
            if (normalizedName.find(word) != std::wstring::npos) {
                wordScore += 100;
            } else if (normalizedPath.find(word) != std::wstring::npos) {
                wordScore += 50;
            }
        }
        score = std::max(score, wordScore);
    }

    if (!normalizedRequestedId.empty()) {
        if (containsInsensitive(normalizedPath, normalizedRequestedId)) {
            score = std::max(score, 700);
        }
        if (containsInsensitive(normalizedName, normalizedRequestedId)) {
            score = std::max(score, 600);
        }
    }

    return score;
}

void freeMediaType(AM_MEDIA_TYPE& type) {
    if (type.cbFormat != 0) {
        CoTaskMemFree(type.pbFormat);
        type.cbFormat = 0;
        type.pbFormat = nullptr;
    }
    if (type.pUnk) {
        type.pUnk->Release();
        type.pUnk = nullptr;
    }
}

bool readRegistryString(HKEY key, const wchar_t* valueName, std::wstring& value) {
    DWORD type = 0;
    DWORD size = 0;
    if (RegGetValueW(key, nullptr, valueName, RRF_RT_REG_SZ, &type, nullptr, &size) != ERROR_SUCCESS || size == 0) {
        return false;
    }

    std::wstring buffer(size / sizeof(wchar_t), L'\0');
    if (RegGetValueW(key, nullptr, valueName, RRF_RT_REG_SZ, &type, buffer.data(), &size) != ERROR_SUCCESS) {
        return false;
    }
    while (!buffer.empty() && buffer.back() == L'\0') {
        buffer.pop_back();
    }
    value = buffer;
    return true;
}

bool findRegisteredVideoInput(
    const std::wstring& deviceId,
    const std::wstring& deviceName,
    CLSID& selectedClsid,
    std::wstring& selectedName,
    int& bestScore) {
    HKEY instanceKey = nullptr;
    if (RegOpenKeyExW(
            HKEY_CLASSES_ROOT,
            L"CLSID\\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\Instance",
            0,
            KEY_READ,
            &instanceKey) != ERROR_SUCCESS) {
        return false;
    }

    DWORD index = 0;
    wchar_t subkeyName[128];
    DWORD subkeyNameLength = ARRAYSIZE(subkeyName);
    bool found = false;
    while (RegEnumKeyExW(instanceKey, index, subkeyName, &subkeyNameLength, nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS) {
        HKEY filterKey = nullptr;
        if (RegOpenKeyExW(instanceKey, subkeyName, 0, KEY_READ, &filterKey) == ERROR_SUCCESS) {
            std::wstring friendlyName;
            std::wstring clsidText;
            readRegistryString(filterKey, L"FriendlyName", friendlyName);
            readRegistryString(filterKey, L"CLSID", clsidText);
            const int score = deviceMatchScore(friendlyName, clsidText, deviceName, deviceId);
            std::wcerr << L"INFO: Registered DirectShow webcam candidate name=\"" << friendlyName << L"\" score=" << score << std::endl;
            CLSID clsid{};
            if (!clsidText.empty() && SUCCEEDED(CLSIDFromString(clsidText.c_str(), &clsid)) && (!found || score > bestScore)) {
                selectedClsid = clsid;
                selectedName = friendlyName;
                bestScore = score;
                found = true;
            }
            RegCloseKey(filterKey);
        }
        index += 1;
        subkeyNameLength = ARRAYSIZE(subkeyName);
    }

    RegCloseKey(instanceKey);
    return found;
}

} // namespace

struct DirectShowWebcamCapture::Impl {
    Microsoft::WRL::ComPtr<IGraphBuilder> graph;
    Microsoft::WRL::ComPtr<ICaptureGraphBuilder2> captureGraph;
    Microsoft::WRL::ComPtr<IBaseFilter> captureFilter;
    Microsoft::WRL::ComPtr<IBaseFilter> sampleGrabberFilter;
    Microsoft::WRL::ComPtr<ISampleGrabber> sampleGrabber;
    Microsoft::WRL::ComPtr<IBaseFilter> nullRenderer;
    Microsoft::WRL::ComPtr<IMediaControl> mediaControl;
    bool comInitialized = false;
    bool running = false;
};

DirectShowWebcamCapture::~DirectShowWebcamCapture() {
    stop();
    delete impl_;
}

bool DirectShowWebcamCapture::initialize(
    const std::wstring& deviceId,
    const std::wstring& deviceName,
    const std::wstring& directShowClsid,
    int requestedWidth,
    int requestedHeight,
    int requestedFps) {
    stop();
    delete impl_;
    impl_ = nullptr;
    impl_ = new Impl();
    fps_ = std::clamp(requestedFps > 0 ? requestedFps : 30, 1, 60);

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (SUCCEEDED(hr)) {
        impl_->comInitialized = true;
    } else if (hr != RPC_E_CHANGED_MODE) {
        return succeeded(hr, "CoInitializeEx(DirectShow webcam)");
    }

    if (directShowClsid.empty()) {
        std::cerr << "ERROR: DirectShow webcam fallback requires a resolved filter CLSID" << std::endl;
        return false;
    }

    CLSID selectedClsid{};
    if (FAILED(CLSIDFromString(directShowClsid.c_str(), &selectedClsid))) {
        std::cerr << "ERROR: DirectShow webcam fallback received an invalid filter CLSID" << std::endl;
        return false;
    }
    selectedDeviceName_ = deviceName.empty() ? directShowClsid : deviceName;

    if (!succeeded(CoCreateInstance(selectedClsid, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&impl_->captureFilter)),
                   "CoCreateInstance(DirectShow webcam filter)")) {
        return false;
    }
    if (!succeeded(CoCreateInstance(CLSID_FilterGraph, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&impl_->graph)),
                   "CoCreateInstance(FilterGraph)")) {
        return false;
    }
    if (!succeeded(CoCreateInstance(CLSID_CaptureGraphBuilder2, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&impl_->captureGraph)),
                   "CoCreateInstance(CaptureGraphBuilder2)")) {
        return false;
    }
    if (!succeeded(impl_->captureGraph->SetFiltergraph(impl_->graph.Get()), "SetFiltergraph(DirectShow webcam)")) {
        return false;
    }
    if (!succeeded(impl_->graph->AddFilter(impl_->captureFilter.Get(), L"OpenScreen Webcam Source"),
                   "AddFilter(DirectShow webcam source)")) {
        return false;
    }

    if (!succeeded(CoCreateInstance(CLSID_SampleGrabberLocal, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&impl_->sampleGrabberFilter)),
                   "CoCreateInstance(SampleGrabber)")) {
        return false;
    }
    if (!succeeded(impl_->sampleGrabberFilter.As(&impl_->sampleGrabber), "QueryInterface(ISampleGrabber)")) {
        return false;
    }

    AM_MEDIA_TYPE requestedType{};
    requestedType.majortype = MEDIATYPE_Video;
    requestedType.subtype = MEDIASUBTYPE_RGB32;
    requestedType.formattype = FORMAT_VideoInfo;
    if (!succeeded(impl_->sampleGrabber->SetMediaType(&requestedType), "SetMediaType(DirectShow RGB32)")) {
        return false;
    }

    if (!succeeded(impl_->graph->AddFilter(impl_->sampleGrabberFilter.Get(), L"OpenScreen Webcam Sample Grabber"),
                   "AddFilter(SampleGrabber)")) {
        return false;
    }
    if (!succeeded(CoCreateInstance(CLSID_NullRendererLocal, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&impl_->nullRenderer)),
                   "CoCreateInstance(NullRenderer)")) {
        return false;
    }
    if (!succeeded(impl_->graph->AddFilter(impl_->nullRenderer.Get(), L"OpenScreen Webcam Null Renderer"),
                   "AddFilter(NullRenderer)")) {
        return false;
    }

    if (!succeeded(impl_->captureGraph->RenderStream(
            &PIN_CATEGORY_CAPTURE,
            &MEDIATYPE_Video,
            impl_->captureFilter.Get(),
            impl_->sampleGrabberFilter.Get(),
            impl_->nullRenderer.Get()),
            "RenderStream(DirectShow webcam)")) {
        return false;
    }

    AM_MEDIA_TYPE connectedType{};
    if (!succeeded(impl_->sampleGrabber->GetConnectedMediaType(&connectedType), "GetConnectedMediaType(DirectShow webcam)")) {
        return false;
    }
    if (connectedType.formattype == FORMAT_VideoInfo && connectedType.pbFormat) {
        const auto* videoInfo = reinterpret_cast<VIDEOINFOHEADER*>(connectedType.pbFormat);
        width_ = std::abs(videoInfo->bmiHeader.biWidth);
        height_ = std::abs(videoInfo->bmiHeader.biHeight);
        sourceTopDown_ = videoInfo->bmiHeader.biHeight < 0;
    }
    freeMediaType(connectedType);
    if (width_ <= 0 || height_ <= 0) {
        width_ = requestedWidth > 0 ? requestedWidth : 1280;
        height_ = requestedHeight > 0 ? requestedHeight : 720;
    }

    impl_->sampleGrabber->SetBufferSamples(TRUE);
    impl_->sampleGrabber->SetOneShot(FALSE);
    if (!succeeded(impl_->graph.As(&impl_->mediaControl), "QueryInterface(IMediaControl)")) {
        return false;
    }

    return true;
}

bool DirectShowWebcamCapture::start() {
    if (!impl_ || !impl_->mediaControl || impl_->running) {
        return false;
    }
    HRESULT hr = impl_->mediaControl->Run();
    if (!succeeded(hr, "Run(DirectShow webcam)")) {
        return false;
    }
    impl_->running = true;
    stopRequested_ = false;
    thread_ = std::thread(&DirectShowWebcamCapture::captureLoop, this);
    return true;
}

void DirectShowWebcamCapture::stop() {
    stopRequested_ = true;
    if (thread_.joinable()) {
        thread_.join();
    }
    if (!impl_) {
        return;
    }
    if (impl_->mediaControl && impl_->running) {
        impl_->mediaControl->Stop();
    }
    impl_->running = false;
    impl_->mediaControl.Reset();
    impl_->nullRenderer.Reset();
    impl_->sampleGrabber.Reset();
    impl_->sampleGrabberFilter.Reset();
    impl_->captureFilter.Reset();
    impl_->captureGraph.Reset();
    impl_->graph.Reset();
    if (impl_->comInitialized) {
        CoUninitialize();
        impl_->comInitialized = false;
    }
}

void DirectShowWebcamCapture::captureLoop() {
    const HRESULT coinitHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    while (!stopRequested_ && impl_ && impl_->sampleGrabber) {
        long bufferSize = 0;
        HRESULT hr = impl_->sampleGrabber->GetCurrentBuffer(&bufferSize, nullptr);
        if (SUCCEEDED(hr) && bufferSize > 0) {
            std::vector<BYTE> buffer(static_cast<size_t>(bufferSize));
            hr = impl_->sampleGrabber->GetCurrentBuffer(&bufferSize, reinterpret_cast<long*>(buffer.data()));
            if (SUCCEEDED(hr)) {
                storeFrame(buffer.data(), bufferSize);
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1000 / std::max(1, fps_)));
    }
    if (SUCCEEDED(coinitHr)) {
        CoUninitialize();
    }
}

void DirectShowWebcamCapture::storeFrame(const BYTE* buffer, long length) {
    const int stride = width_ * 4;
    const int expectedLength = stride * height_;
    if (!buffer || length < expectedLength || width_ <= 0 || height_ <= 0) {
        return;
    }

    std::vector<BYTE> frame(static_cast<size_t>(expectedLength));
    for (int y = 0; y < height_; y += 1) {
        const int sourceY = sourceTopDown_ ? y : height_ - 1 - y;
        const BYTE* source = buffer + sourceY * stride;
        BYTE* destination = frame.data() + y * stride;
        std::copy(source, source + stride, destination);
        for (int x = 0; x < width_; x += 1) {
            destination[x * 4 + 3] = 255;
        }
    }

    std::scoped_lock lock(frameMutex_);
    latestFrame_ = std::move(frame);
}

bool DirectShowWebcamCapture::copyLatestFrame(std::vector<BYTE>& destination, int& width, int& height) {
    std::scoped_lock lock(frameMutex_);
    if (latestFrame_.empty() || width_ <= 0 || height_ <= 0) {
        return false;
    }

    destination = latestFrame_;
    width = width_;
    height = height_;
    return true;
}

int DirectShowWebcamCapture::width() const {
    return width_;
}

int DirectShowWebcamCapture::height() const {
    return height_;
}

int DirectShowWebcamCapture::fps() const {
    return fps_;
}

const std::wstring& DirectShowWebcamCapture::selectedDeviceName() const {
    return selectedDeviceName_;
}
