#pragma once

#include <Windows.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct WebcamFrameSnapshot {
    std::vector<BYTE> data;
    int width = 0;
    int height = 0;
    uint64_t sequence = 0;
};

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
    bool copyLatestFrame(WebcamFrameSnapshot& destination);

    int width() const;
    int height() const;
    int fps() const;
    const std::wstring& selectedDeviceName() const;
    void storeFrame(const BYTE* buffer, long length);

private:
    enum class PixelFormat {
        Bgra,
        Nv12,
        Yuy2,
    };

    struct Impl;
    void captureLoop();
    /**
     * Builds source -> sample grabber -> null renderer and connects it.
     *
     * `preferredSubtype` is what the grabber will accept: pass a concrete one
     * (RGB32) to make DirectShow's intelligent connect insert a colour converter,
     * or nullptr to accept whatever the camera offers natively. Returns false
     * without leaving the graph half-built, so the caller can retry with a
     * different constraint.
     */
    bool buildGraph(const CLSID& sourceClsid, const GUID* preferredSubtype);
    /**
     * Reads back what the graph actually negotiated and records how to unpack it.
     *
     * Returns false for a subtype this class cannot decode, which is a retryable
     * outcome rather than a failure — `reportUnsupported` is what tells it apart
     * from the last attempt, whose rejection is worth logging.
     */
    bool resolveConnectedFormat(int requestedWidth, int requestedHeight, bool reportUnsupported);

    Impl* impl_ = nullptr;
    std::thread thread_;
    std::atomic<bool> stopRequested_ = false;
    std::mutex frameMutex_;
    std::vector<BYTE> latestFrame_;
    uint64_t latestFrameSequence_ = 0;
    int width_ = 0;
    int height_ = 0;
    int fps_ = 30;
    int sourceStride_ = 0;
    bool sourceTopDown_ = false;
    PixelFormat pixelFormat_ = PixelFormat::Bgra;
    std::wstring selectedDeviceName_;
};
