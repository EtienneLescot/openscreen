#pragma once

#include <Windows.h>
#include <d3d11.h>
#include <windows.graphics.capture.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <wrl/client.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>

// Frame delivery defaults to pull-based, not the WGC FrameArrived event: the
// caller's own thread polls tryGetNextFrame() on its own schedule and does
// the GPU copy itself. The reason is this codebase's threading model, not
// another project's precedent: a FrameArrived handler runs on a WGC-owned
// thread, so any lock a caller takes to synchronize that handler with its
// own pipeline ends up held by a thread the caller does not control. If the
// copy wedges inside the display driver -- which happens on real hardware,
// not hypothetically (see #252 and #460) -- that lock is gone until the
// process exits, and every other thread that ever needs it hangs too,
// however briefly it would otherwise have held it. Pulling on the caller's
// own thread means a wedged copy only ever blocks the one thread already
// responsible for deciding when to give up on it; nothing else can be
// dragged in.
//
// Chromium's WGC capturer also pulls rather than handling FrameArrived, but
// not for this reason -- its comment there is about avoiding a
// DispatcherQueue, and it runs a 1-buffer pool because a dropped frame costs
// a screen-sharing viewer nothing. We record, where a dropped frame is a
// defect in a file someone keeps, so none of its sizing carries over here.
//
// The old FrameArrived-callback path (setFrameCallback/onFrameArrived) is
// kept alongside it, selected by OPENSCREEN_WGC_LEGACY_FRAME_CALLBACK (see
// main.cpp), as a rollback lever: if the pull-based path regresses on some
// hardware/driver combination this was not tested against, a user or
// maintainer can force the previously-shipped behavior back on without
// waiting for a new release. It carries its own known failure mode (#252)
// and is not a recommended default -- remove it once the pull-based path has
// enough field time to retire the flag.
class WgcSession {
public:
    using FrameCallback = std::function<void(ID3D11Texture2D*, int64_t)>;

    WgcSession() = default;
    ~WgcSession();

    WgcSession(const WgcSession&) = delete;
    WgcSession& operator=(const WgcSession&) = delete;

    bool initialize(HMONITOR monitor, int fps, bool captureCursor);
    bool initialize(HWND window, int fps, bool captureCursor);
    bool start();
    // Returns the most recently arrived frame's texture and timestamp, or
    // false if none is available since the last call. The returned pointer
    // is only valid until the next tryGetNextFrame() call or stop() -- copy
    // out of it (e.g. via CopyResource) before either. Do not mix with
    // setFrameCallback() on the same session.
    bool tryGetNextFrame(ID3D11Texture2D** outTexture, int64_t* outTimestampHns);

    // Legacy push-based path (OPENSCREEN_WGC_LEGACY_FRAME_CALLBACK=1 only).
    // callback runs on a WGC-owned thread inside FrameArrived and may be
    // invoked concurrently with stop()/quiesceLegacyCallback() from the
    // caller's thread -- see onFrameArrived's locking. Do not mix with
    // tryGetNextFrame() on the same session.
    void setFrameCallback(FrameCallback callback);
    // Stops frame delivery and waits out any callback already running,
    // without touching the D3D device. Only meaningful after
    // setFrameCallback(); a no-op on the pull-based path. Returns false if a
    // callback was still running when drainTimeoutMs expired -- releasing
    // the device after that is unsafe, so stop() skips it in that case.
    bool quiesceLegacyCallback(int drainTimeoutMs = 5000);
    void stop();

    int captureWidth() const;
    int captureHeight() const;
    ID3D11Device* device() const;
    ID3D11DeviceContext* context() const;

private:
    bool createD3DDevice();
    bool createCaptureItem(HMONITOR monitor);
    bool createCaptureItem(HWND window);
    bool applySessionOptions(bool captureCursor);
    void onFrameArrived(
        winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool const& sender,
        winrt::Windows::Foundation::IInspectable const&);

    Microsoft::WRL::ComPtr<ID3D11Device> d3dDevice_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> d3dContext_;
    winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice winrtDevice_{nullptr};
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem item_{nullptr};
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool framePool_{nullptr};
    winrt::Windows::Graphics::Capture::GraphicsCaptureSession session_{nullptr};
    // Keeps the most recent frame's WinRT wrapper (and therefore its
    // pool-owned texture) alive between tryGetNextFrame() calls: the pool is
    // created with 2 buffers, so holding this reference is what keeps the
    // texture valid for the caller to read from until the next call reclaims
    // it.
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame currentFrame_{nullptr};
    // Legacy push-based path state; unused unless setFrameCallback() is called.
    winrt::event_token frameArrivedToken_{};
    FrameCallback frameCallback_;
    std::mutex callbackMutex_;
    std::atomic<int> callbacksInFlight_ = 0;
    bool legacyCallbackRegistered_ = false;
    bool quiesced_ = false;
    int width_ = 0;
    int height_ = 0;
    int fps_ = 60;
    bool captureCursor_ = false;
    bool started_ = false;
};
