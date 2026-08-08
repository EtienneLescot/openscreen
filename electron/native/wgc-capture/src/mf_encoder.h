#pragma once

#include <Windows.h>
#include <d3d11.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <cstdint>
#include <mutex>
#include <string>

struct BgraFrameView {
    const BYTE* data = nullptr;
    int width = 0;
    int height = 0;
};

struct AudioInputFormat {
    GUID subtype = MFAudioFormat_PCM;
    UINT32 sampleRate = 0;
    UINT32 channels = 0;
    UINT32 bitsPerSample = 0;
    UINT32 blockAlign = 0;
    UINT32 avgBytesPerSec = 0;
};

struct MFEncoderOptions {
    bool preferSoftwareEncoder = false;
    bool injectDefaultSinkWriterFailureOnce = false;
    // A request, never a requirement. Every step of the GPU path degrades to
    // the CPU readback rather than failing the recording, so a machine without
    // a hardware H.264 encoder, without NV12 video-processor output, or with a
    // driver that refuses shared keyed-mutex textures records exactly as it did
    // before the path existed. Ask usesDxgiInput() for what actually happened.
    bool useDxgiInput = false;
};

constexpr const char* kVideoEncoderSelectionDefault = "default";
constexpr const char* kVideoEncoderSelectionSoftwarePreferred = "software-preferred";
constexpr const char* kVideoEncoderSelectionSoftwareFallback = "software-fallback";

class MFEncoder {
public:
    MFEncoder() = default;
    ~MFEncoder();

    MFEncoder(const MFEncoder&) = delete;
    MFEncoder& operator=(const MFEncoder&) = delete;

    bool initialize(
        const std::wstring& outputPath,
        int width,
        int height,
        int fps,
        int bitrate,
        ID3D11Device* device,
        ID3D11DeviceContext* context,
        const AudioInputFormat* audioFormat = nullptr,
        MFEncoderOptions options = {});
    // Capturing a video/webcam sample (GPU readback + IMFSample creation) is
    // split from submitting it to the sink writer (IMFSinkWriter::WriteSample)
    // so callers that hold an external lock across the GPU-touching capture
    // step (to serialize against a producer thread writing into the same
    // texture) are not forced to also hold that lock across the potentially
    // slow, blocking WriteSample call. See main.cpp's writeVideoFrames for why
    // this split exists: holding the shared frame-state mutex across
    // WriteSample let the software H.264 encoder path starve the main
    // thread's stop-request check indefinitely (issue #115).
    bool captureVideoSample(
        ID3D11Texture2D* texture,
        int64_t timestampHns,
        const BgraFrameView* webcamFrame,
        Microsoft::WRL::ComPtr<IMFSample>& outSample);
    bool captureDxgiSample(
        ID3D11Texture2D* texture,
        int64_t timestampHns,
        Microsoft::WRL::ComPtr<IMFSample>& outSample);
    bool captureBgraSample(
        const BgraFrameView& frame,
        int64_t timestampHns,
        Microsoft::WRL::ComPtr<IMFSample>& outSample);
    bool submitVideoSample(IMFSample* sample);
    bool writeAudio(const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns);
    bool finalize();
    const char* videoEncoderSelection() const;
    // Which video input path initialize() actually settled on, which is not
    // necessarily the one that was asked for. Callers must read this rather
    // than their own MFEncoderOptions to decide which capture entry point to
    // call, or a machine that fell back would be fed DXGI samples the sink
    // writer was never configured for.
    bool usesDxgiInput() const;

private:
    // Contended is not Failed: the bridge is a two-key handshake and a missed
    // acquire costs one frame, which is a better outcome than ending a
    // recording that is otherwise healthy.
    enum class Nv12ConvertResult {
        Ok,
        Contended,
        Failed,
    };

    bool initializeDxgiPipeline();
    void releaseDxgiPipeline();
    bool initializeDxgiEncodingDevice();
    bool initializeVideoProcessor();
    bool initializeSampleAllocator(IMFMediaType* inputType);
    void applyHardwareRateControl(int bitrate);
    Nv12ConvertResult convertBgraTextureToNv12(
        ID3D11Texture2D* texture,
        ID3D11Texture2D* outputTexture);
    bool ensureStagingTexture(ID3D11Texture2D* texture);
    bool copyFrameToBuffer(
        ID3D11Texture2D* texture,
        BYTE* destination,
        DWORD destinationSize,
        const BgraFrameView* webcamFrame);
    bool copyBgraFrameToBuffer(const BgraFrameView& frame, BYTE* destination, DWORD destinationSize);
    bool configureAudioStream(const AudioInputFormat& audioFormat);

    Microsoft::WRL::ComPtr<IMFSinkWriter> sinkWriter_;
    Microsoft::WRL::ComPtr<ID3D11Device> device_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
    Microsoft::WRL::ComPtr<ID3D11Device> captureDevice_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> captureContext_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> captureBridgeTexture_;
    Microsoft::WRL::ComPtr<IDXGIKeyedMutex> captureBridgeMutex_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> encoderBridgeTexture_;
    Microsoft::WRL::ComPtr<IDXGIKeyedMutex> encoderBridgeMutex_;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessorInputView> bridgeInputView_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> stagingTexture_;
    Microsoft::WRL::ComPtr<IMFDXGIDeviceManager> dxgiDeviceManager_;
    Microsoft::WRL::ComPtr<IMFVideoSampleAllocatorEx> videoSampleAllocator_;
    Microsoft::WRL::ComPtr<ID3D11VideoDevice> videoDevice_;
    Microsoft::WRL::ComPtr<ID3D11VideoContext> videoContext_;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessorEnumerator> videoProcessorEnumerator_;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessor> videoProcessor_;
    UINT dxgiResetToken_ = 0;
    std::mutex writerMutex_;
    DWORD videoStreamIndex_ = 0;
    DWORD audioStreamIndex_ = 0;
    bool hasAudioStream_ = false;
    int width_ = 0;
    int height_ = 0;
    int fps_ = 60;
    int64_t firstTimestampHns_ = -1;
    int64_t lastTimestampHns_ = -1;
    bool finalized_ = false;
    bool useDxgiInput_ = false;
    const char* videoEncoderSelection_ = kVideoEncoderSelectionDefault;
};
