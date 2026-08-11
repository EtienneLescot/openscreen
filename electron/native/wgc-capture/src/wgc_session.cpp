#include "wgc_session.h"

#include <Windows.Graphics.Capture.Interop.h>
#include <d3d10.h>
#include <dxgi1_2.h>
#include <inspectable.h>
#include <winrt/base.h>

#include <chrono>
#include <exception>
#include <iostream>
#include <thread>

namespace wf = winrt::Windows::Foundation;
namespace wgcap = winrt::Windows::Graphics::Capture;
namespace wgdx = winrt::Windows::Graphics::DirectX;
namespace wgd3d = winrt::Windows::Graphics::DirectX::Direct3D11;

extern "C" HRESULT __stdcall CreateDirect3D11DeviceFromDXGIDevice(
    ::IDXGIDevice* dxgiDevice,
    ::IInspectable** graphicsDevice);

namespace {

bool succeeded(HRESULT hr, const char* label) {
    if (SUCCEEDED(hr)) {
        return true;
    }

    std::cerr << "ERROR: " << label << " failed (hr=0x" << std::hex << hr << std::dec << ")"
              << std::endl;
    return false;
}

// Turns a C++/WinRT throw into a logged `false`.
//
// The projected calls on the setup path -- get_activation_factory, .as<>,
// item_.Size(), CreateFreeThreaded, CreateCaptureSession, FrameArrived,
// StartCapture -- report failure by throwing, and none of them was caught.
// initialize() therefore could not return false: an exception from any of them
// unwound past it into std::terminate and the process ended with no message at
// all, leaving Electron to report "the helper exited before recording started"
// and nothing else. The HRESULT was in the exception the whole time.
//
// No such failure has actually been observed. This is written from reading the
// calls, not from a reproduction -- see the PR for the crash that prompted it
// and turned out to be an unrelated stack-buffer overrun, which is a fastfail
// rather than an exception and is not catchable here or anywhere.
//
// The label is the diagnostic, so a region never spans two calls a reader would
// want told apart: the frame pool and the capture session get one each. Where a
// region does cover several calls it is because they are one step under one
// name -- "GraphicsCaptureItem for a monitor" is the activation factory, the
// interop cast and Size(), and knowing which of those three threw would not
// change what you do next. `succeeded()` above stays as it is for the calls
// that return an HRESULT rather than throwing; this is its counterpart, not its
// replacement.
template <typename Body>
bool guardWinrt(const char* what, Body&& body) {
    try {
        return body();
    } catch (winrt::hresult_error const& error) {
        std::cerr << "ERROR: " << what << " threw (hr=0x" << std::hex
                  << static_cast<uint32_t>(error.code()) << std::dec << "): "
                  << winrt::to_string(error.message()) << std::endl;
        return false;
    } catch (std::exception const& error) {
        std::cerr << "ERROR: " << what << " threw (" << error.what() << ")" << std::endl;
        return false;
    } catch (...) {
        std::cerr << "ERROR: " << what << " threw a non-standard exception" << std::endl;
        return false;
    }
}

// Deliberately no GraphicsCaptureSession::IsSupported() pre-flight here, though
// it would give a nicer message than an HRESULT on some later call. It is the
// one thing that could *refuse* a recording that works today: a machine where
// IsSupported() answers false but capture would have succeeded records fine now
// and would stop doing so, and there is no evidence either way about whether
// such a machine exists. That is the exact shape of the #336 regression -- a new
// gate in front of a path that was working -- and a better error message is not
// worth carrying it. Everything below only adds a branch that did not exist, so
// at worst it never runs.

int64_t timeSpanToHns(wf::TimeSpan const& value) {
    return value.count();
}

// H.264 encoding (and the RGB32->NV12 conversion feeding it) requires even
// frame dimensions. Monitor resolutions are always even in practice, so
// CreateForMonitor items never hit this. Windows, however, frequently have
// odd client-area dimensions (arbitrary drag-resize, DPI rounding), and
// GraphicsCaptureItem::Size() reports the window's *actual* size verbatim.
// If we requested a Direct3D11CaptureFramePool sized to that odd value while
// the rest of the pipeline (main.cpp's bitrate calc, MFEncoder) rounds down
// to even, the frame pool's real DXGI textures end up one pixel wider/taller
// than the staging texture the encoder allocates. ID3D11DeviceContext::
// CopyResource silently no-ops on a size mismatch (it only emits a debug-
// layer warning), so the staging texture never receives pixel data and the
// output is solid black for the entire recording -- or, if the mismatch
// trips up the video MFT's input negotiation, SetInputMediaType fails
// outright. Rounding up to the nearest even size here, and using that
// rounded size (not the raw item size) for both the frame pool and
// `captureWidth()`/`captureHeight()`, keeps every consumer of this session
// looking at the exact same dimensions as the real captured texture.
int roundUpToEven(int value) {
    const int clamped = std::max(2, value);
    return (clamped % 2 == 0) ? clamped : clamped + 1;
}

} // namespace

WgcSession::~WgcSession() {
    stop();
}

bool WgcSession::createD3DDevice() {
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
#if defined(_DEBUG)
    flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif

    D3D_FEATURE_LEVEL featureLevels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    };
    D3D_FEATURE_LEVEL featureLevel{};

    HRESULT hr = D3D11CreateDevice(
        nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
        flags,
        featureLevels,
        ARRAYSIZE(featureLevels),
        D3D11_SDK_VERSION,
        &d3dDevice_,
        &featureLevel,
        &d3dContext_);

#if defined(_DEBUG)
    if (FAILED(hr)) {
        flags &= ~D3D11_CREATE_DEVICE_DEBUG;
        hr = D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            flags,
            featureLevels,
            ARRAYSIZE(featureLevels),
            D3D11_SDK_VERSION,
            &d3dDevice_,
            &featureLevel,
            &d3dContext_);
    }
#endif

    if (!succeeded(hr, "D3D11CreateDevice")) {
        return false;
    }

    Microsoft::WRL::ComPtr<ID3D10Multithread> multithread;
    if (!succeeded(d3dContext_.As(&multithread), "Query ID3D10Multithread")) {
        return false;
    }
    multithread->SetMultithreadProtected(TRUE);

    Microsoft::WRL::ComPtr<IDXGIDevice> dxgiDevice;
    if (!succeeded(d3dDevice_.As(&dxgiDevice), "Query IDXGIDevice")) {
        return false;
    }

    winrt::com_ptr<::IInspectable> inspectableDevice;
    if (!succeeded(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), inspectableDevice.put()),
                   "CreateDirect3D11DeviceFromDXGIDevice")) {
        return false;
    }

    winrtDevice_ = inspectableDevice.as<wgd3d::IDirect3DDevice>();
    return true;
}

bool WgcSession::createCaptureItem(HMONITOR monitor) {
    return guardWinrt("GraphicsCaptureItem for a monitor", [&] {
        auto factory = winrt::get_activation_factory<wgcap::GraphicsCaptureItem>();
        auto interop = factory.as<IGraphicsCaptureItemInterop>();

        wgcap::GraphicsCaptureItem item{nullptr};
        HRESULT hr = interop->CreateForMonitor(
            monitor,
            winrt::guid_of<wgcap::GraphicsCaptureItem>(),
            reinterpret_cast<void**>(winrt::put_abi(item)));
        if (!succeeded(hr, "CreateForMonitor")) {
            return false;
        }

        item_ = item;
        const auto size = item_.Size();
        width_ = static_cast<int>(size.Width);
        height_ = static_cast<int>(size.Height);
        return width_ > 0 && height_ > 0;
    });
}

bool WgcSession::createCaptureItem(HWND window) {
    return guardWinrt("GraphicsCaptureItem for a window", [&] {
        auto factory = winrt::get_activation_factory<wgcap::GraphicsCaptureItem>();
        auto interop = factory.as<IGraphicsCaptureItemInterop>();

        wgcap::GraphicsCaptureItem item{nullptr};
        HRESULT hr = interop->CreateForWindow(
            window,
            winrt::guid_of<wgcap::GraphicsCaptureItem>(),
            reinterpret_cast<void**>(winrt::put_abi(item)));
        if (!succeeded(hr, "CreateForWindow")) {
            return false;
        }

        item_ = item;
        const auto size = item_.Size();
        width_ = roundUpToEven(static_cast<int>(size.Width));
        height_ = roundUpToEven(static_cast<int>(size.Height));
        return width_ > 0 && height_ > 0;
    });
}

// Two guards, not one around both: they are separate projected calls, and a
// single region would have reported a CreateCaptureSession throw under the
// CreateFreeThreaded label -- naming the wrong call, which is worse than naming
// none.
bool WgcSession::createFramePoolAndSession() {
    const bool pooled = guardWinrt("Direct3D11CaptureFramePool::CreateFreeThreaded", [&] {
        framePool_ = wgcap::Direct3D11CaptureFramePool::CreateFreeThreaded(
            winrtDevice_,
            wgdx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            winrt::Windows::Graphics::SizeInt32{width_, height_});
        return true;
    });
    if (!pooled) {
        return false;
    }

    return guardWinrt("Direct3D11CaptureFramePool::CreateCaptureSession", [&] {
        session_ = framePool_.CreateCaptureSession(item_);
        return true;
    });
}

bool WgcSession::registerFrameArrived() {
    return guardWinrt("Direct3D11CaptureFramePool::FrameArrived", [&] {
        frameArrivedToken_ = framePool_.FrameArrived({this, &WgcSession::onFrameArrived});
        return true;
    });
}

bool WgcSession::applySessionOptions(bool captureCursor) {
    captureCursor_ = captureCursor;

    try {
        auto session2 = session_.try_as<wgcap::IGraphicsCaptureSession2>();
        if (!session2) {
            if (!captureCursor) {
                std::cerr << "ERROR: WGC cursor suppression is not supported by this Windows runtime"
                          << std::endl;
                return false;
            }
        } else {
            session2.IsCursorCaptureEnabled(captureCursor);
            const bool appliedCursorCapture = session2.IsCursorCaptureEnabled();
            std::cout << "{\"event\":\"cursor-capture\",\"schemaVersion\":2,\"requested\":"
                      << (captureCursor ? "true" : "false")
                      << ",\"applied\":" << (appliedCursorCapture ? "true" : "false") << "}"
                      << std::endl;

            if (appliedCursorCapture != captureCursor) {
                std::cerr << "ERROR: WGC cursor capture setting did not apply" << std::endl;
                return false;
            }
        }
    } catch (winrt::hresult_error const& error) {
        std::cerr << "ERROR: Failed to configure WGC cursor capture (hr=0x" << std::hex
                  << static_cast<uint32_t>(error.code()) << std::dec << ")" << std::endl;
        if (!captureCursor) {
            return false;
        }
    } catch (...) {
        std::cerr << "ERROR: Failed to configure WGC cursor capture" << std::endl;
        if (!captureCursor) {
            return false;
        }
    }

    try {
        session_.IsBorderRequired(false);
    } catch (...) {
        // IsBorderRequired is Windows 11-only. Ignore it on older builds.
    }

    return true;
}

// Every step reports its own failure, so the two overloads are the step list and
// nothing else. Each returns false rather than throwing past its caller, which
// is what main.cpp's "Failed to initialize WGC display session" has always
// assumed and, until now, was not true of any of them.
bool WgcSession::initialize(HMONITOR monitor, int fps, bool captureCursor) {
    fps_ = fps > 0 ? fps : 60;
    return createD3DDevice() &&
        createCaptureItem(monitor) &&
        createFramePoolAndSession() &&
        applySessionOptions(captureCursor) &&
        registerFrameArrived();
}

bool WgcSession::initialize(HWND window, int fps, bool captureCursor) {
    fps_ = fps > 0 ? fps : 60;
    return createD3DDevice() &&
        createCaptureItem(window) &&
        createFramePoolAndSession() &&
        applySessionOptions(captureCursor) &&
        registerFrameArrived();
}

void WgcSession::setFrameCallback(FrameCallback callback) {
    std::scoped_lock lock(callbackMutex_);
    frameCallback_ = std::move(callback);
}

bool WgcSession::start() {
    if (!session_) {
        return false;
    }
    if (!applySessionOptions(captureCursor_)) {
        return false;
    }
    if (!guardWinrt("GraphicsCaptureSession::StartCapture", [&] {
            session_.StartCapture();
            return true;
        })) {
        return false;
    }
    started_ = true;
    return true;
}

bool WgcSession::quiesceCapture(int drainTimeoutMs) {
    if (quiesced_) {
        return callbacksInFlight_.load() == 0;
    }
    quiesced_ = true;

    try {
        if (framePool_) {
            framePool_.FrameArrived(frameArrivedToken_);
        }
    } catch (...) {
        // Revoking a handler the runtime has already torn down is not a reason
        // to abandon the rest of the shutdown.
    }
    {
        // Drop the callback under the same lock onFrameArrived copies it under,
        // so any handler that has not read it yet becomes a no-op...
        std::scoped_lock lock(callbackMutex_);
        frameCallback_ = nullptr;
    }
    // ...then wait out the handlers that already read it. Without this, stop()
    // could Reset() the D3D context while a callback was still issuing
    // CopyResource on it.
    //
    // Bounded, because a callback wedged inside the display driver never
    // finishes and this runs on paths that have no watchdog above them (the
    // first-frame timeout in main.cpp). Giving up is reported rather than
    // papered over: the caller keeps the device alive instead, which leaks it
    // until the process exits and is the lesser of the two failures.
    const auto drainDeadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(drainTimeoutMs);
    while (callbacksInFlight_.load() > 0) {
        if (std::chrono::steady_clock::now() >= drainDeadline) {
            std::cerr << "WARNING: A WGC frame callback did not finish; leaving the device alive"
                      << std::endl;
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    // Close() is a C++/WinRT projection and throws hresult_error on failure.
    // Letting that escape would take the process down through std::terminate
    // mid-shutdown, discarding a recording that is already finalized by the time
    // this runs. There is nothing to do about a capture session that refuses to
    // close except stop caring about it.
    try {
        if (session_) {
            session_.Close();
        }
        if (framePool_) {
            framePool_.Close();
        }
    } catch (winrt::hresult_error const& error) {
        std::cerr << "WARNING: Failed to close the WGC session (hr=0x" << std::hex
                  << static_cast<uint32_t>(error.code()) << std::dec << ")" << std::endl;
    } catch (...) {
        std::cerr << "WARNING: Failed to close the WGC session" << std::endl;
    }
    session_ = nullptr;
    framePool_ = nullptr;
    started_ = false;
    return true;
}

void WgcSession::stop() {
    if (!quiesceCapture()) {
        // A callback is still inside the driver holding this context. Releasing
        // it now would pull the device out from under a live CopyResource, so
        // leak it and let process exit reclaim it.
        return;
    }
    item_ = nullptr;
    winrtDevice_ = nullptr;
    d3dContext_.Reset();
    d3dDevice_.Reset();
}

// The same defect as the setup path, on the hot path. TryGetNextFrame,
// Surface(), the interop cast and SystemRelativeTime() are all projections that
// throw, and a throw leaving a WinRT delegate goes straight to std::terminate --
// a recording that ends with the process disappearing mid-capture, no stderr,
// and the partial file as the only evidence.
//
// Dropping the frame is the only useful response: one bad frame is not a reason
// to end a recording, and a surface that has gone bad usually stays bad. So it
// is logged once and not at frame rate, which at 60 fps is the difference
// between a diagnostic and a denial of service on the log.
void WgcSession::onFrameArrived(
    wgcap::Direct3D11CaptureFramePool const& sender,
    wf::IInspectable const&) {
    try {
        deliverFrame(sender);
    } catch (winrt::hresult_error const& error) {
        if (!frameErrorLogged_.exchange(true)) {
            std::cerr << "WARNING: Dropped a WGC frame (hr=0x" << std::hex
                      << static_cast<uint32_t>(error.code()) << std::dec
                      << "). Further frame errors are not repeated." << std::endl;
        }
    } catch (...) {
        if (!frameErrorLogged_.exchange(true)) {
            std::cerr << "WARNING: Dropped a WGC frame. "
                      << "Further frame errors are not repeated." << std::endl;
        }
    }
}

void WgcSession::deliverFrame(wgcap::Direct3D11CaptureFramePool const& sender) {
    auto frame = sender.TryGetNextFrame();
    if (!frame) {
        return;
    }

    auto surface = frame.Surface();
    auto access = surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
    HRESULT hr = access->GetInterface(__uuidof(ID3D11Texture2D), reinterpret_cast<void**>(texture.GetAddressOf()));
    if (FAILED(hr) || !texture) {
        return;
    }

    FrameCallback callback;
    {
        std::scoped_lock lock(callbackMutex_);
        callback = frameCallback_;
        if (callback) {
            // Counted under the same lock quiesceCapture() clears the callback
            // under, so once it has cleared it no new callback can start and
            // the counter it then drains cannot go back up.
            callbacksInFlight_ += 1;
        }
    }

    if (callback) {
        // Scoped rather than a bare decrement after the call, for two reasons:
        // a callback that left by exception would otherwise strand
        // quiesceCapture()'s drain forever, and the guard has to outlive
        // frame.Close() -- dropping the count first would let quiesce return and
        // close the frame pool while this handler is still closing a frame that
        // pool owns.
        struct InFlightGuard {
            std::atomic<int>& counter;
            ~InFlightGuard() {
                counter -= 1;
            }
        } guard{callbacksInFlight_};
        callback(texture.Get(), timeSpanToHns(frame.SystemRelativeTime()));
        frame.Close();
        return;
    }
    frame.Close();
}

int WgcSession::captureWidth() const {
    return width_;
}

int WgcSession::captureHeight() const {
    return height_;
}

ID3D11Device* WgcSession::device() const {
    return d3dDevice_.Get();
}

ID3D11DeviceContext* WgcSession::context() const {
    return d3dContext_.Get();
}
