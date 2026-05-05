#include "dshow_webcam_capture.h"

#include <initguid.h>
#include <dshow.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <exception>
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
    (void)deviceId;
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
    stopRequested_ = false;
    try {
        thread_ = std::thread(&DirectShowWebcamCapture::captureLoop, this);
    } catch (const std::exception& error) {
        stopRequested_ = true;
        impl_->mediaControl->Stop();
        std::cerr << "ERROR: Failed to start DirectShow webcam capture thread: " << error.what() << std::endl;
        return false;
    } catch (...) {
        stopRequested_ = true;
        impl_->mediaControl->Stop();
        std::cerr << "ERROR: Failed to start DirectShow webcam capture thread" << std::endl;
        return false;
    }
    impl_->running = true;
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
