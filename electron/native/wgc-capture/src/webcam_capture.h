#pragma once

#include <Windows.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

class WebcamCapture {
public:
    WebcamCapture() = default;
    ~WebcamCapture();

    WebcamCapture(const WebcamCapture&) = delete;
    WebcamCapture& operator=(const WebcamCapture&) = delete;

    bool initialize(const std::wstring& deviceId, int requestedWidth, int requestedHeight, int requestedFps);
    bool start();
    void stop();
    bool copyLatestFrame(std::vector<BYTE>& destination, int& width, int& height);

    int width() const;
    int height() const;
    int fps() const;
    const std::wstring& selectedDeviceName() const;

private:
    bool selectDevice(const std::wstring& deviceId);
    bool configureReader(int requestedWidth, int requestedHeight, int requestedFps);
    void captureLoop();

    Microsoft::WRL::ComPtr<IMFMediaSource> mediaSource_;
    Microsoft::WRL::ComPtr<IMFSourceReader> sourceReader_;
    std::thread thread_;
    std::atomic<bool> stopRequested_ = false;
    std::mutex frameMutex_;
    std::vector<BYTE> latestFrame_;
    int width_ = 0;
    int height_ = 0;
    int fps_ = 30;
    bool mfStarted_ = false;
    std::wstring selectedDeviceName_;
};
