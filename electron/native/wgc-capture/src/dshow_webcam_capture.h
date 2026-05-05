#pragma once

#include <Windows.h>

#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

class DirectShowWebcamCapture {
public:
    DirectShowWebcamCapture() = default;
    ~DirectShowWebcamCapture();

    DirectShowWebcamCapture(const DirectShowWebcamCapture&) = delete;
    DirectShowWebcamCapture& operator=(const DirectShowWebcamCapture&) = delete;

    bool initialize(
        const std::wstring& deviceId,
        const std::wstring& deviceName,
        const std::wstring& directShowClsid,
        int requestedWidth,
        int requestedHeight,
        int requestedFps);
    bool start();
    void stop();
    bool copyLatestFrame(std::vector<BYTE>& destination, int& width, int& height);

    int width() const;
    int height() const;
    int fps() const;
    const std::wstring& selectedDeviceName() const;
    void storeFrame(const BYTE* buffer, long length);

private:
    struct Impl;
    void captureLoop();

    Impl* impl_ = nullptr;
    std::thread thread_;
    std::atomic<bool> stopRequested_ = false;
    std::mutex frameMutex_;
    std::vector<BYTE> latestFrame_;
    int width_ = 0;
    int height_ = 0;
    int fps_ = 30;
    bool sourceTopDown_ = false;
    std::wstring selectedDeviceName_;
};
