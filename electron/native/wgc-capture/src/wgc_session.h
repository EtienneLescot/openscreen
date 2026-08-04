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
#include <functional>
#include <mutex>

class WgcSession {
public:
    using FrameCallback = std::function<void(ID3D11Texture2D*, int64_t)>;

    WgcSession() = default;
    ~WgcSession();

    WgcSession(const WgcSession&) = delete;
    WgcSession& operator=(const WgcSession&) = delete;

    bool initialize(HMONITOR monitor, int fps, bool captureCursor);
    bool initialize(HWND window, int fps, bool captureCursor);
    void setFrameCallback(FrameCallback callback);
    bool start();
    // Stops frame delivery and waits out any callback already running, without
    // touching the D3D device. Split out of stop() so a caller can quiesce the
    // producer early in a shutdown and only release the device once nothing can
    // still be using it. Idempotent; stop() calls it.
    //
    // Returns false if a callback was still running when `drainTimeoutMs`
    // expired -- releasing the device after that is unsafe, so stop() skips it.
    bool quiesceCapture(int drainTimeoutMs = 5000);
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
    winrt::event_token frameArrivedToken_{};
    FrameCallback frameCallback_;
    std::mutex callbackMutex_;
    std::atomic<int> callbacksInFlight_ = 0;
    bool quiesced_ = false;
    int width_ = 0;
    int height_ = 0;
    int fps_ = 60;
    bool captureCursor_ = false;
    bool started_ = false;
};
