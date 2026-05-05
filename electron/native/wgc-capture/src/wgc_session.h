#pragma once

#include <Windows.h>
#include <d3d11.h>
#include <windows.graphics.capture.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <wrl/client.h>

#include <functional>
#include <mutex>

class WgcSession {
public:
    using FrameCallback = std::function<void(ID3D11Texture2D*, int64_t)>;

    WgcSession() = default;
    ~WgcSession();

    WgcSession(const WgcSession&) = delete;
    WgcSession& operator=(const WgcSession&) = delete;

    bool initialize(HMONITOR monitor, int fps);
    void setFrameCallback(FrameCallback callback);
    bool start();
    void stop();

    int captureWidth() const;
    int captureHeight() const;
    ID3D11Device* device() const;
    ID3D11DeviceContext* context() const;

private:
    bool createD3DDevice();
    bool createCaptureItem(HMONITOR monitor);
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
    int width_ = 0;
    int height_ = 0;
    int fps_ = 60;
    bool started_ = false;
};
