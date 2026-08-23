#pragma once

#include <Windows.h>
#include <d3d11.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <atomic>
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

// Whether BeginWriting() actually landed on a hardware-accelerated H.264 MFT.
//
// videoEncoderSelection() above says which *path* initialize() took --
// whether the DXGI GPU pipeline was asked for, or software was forced -- but
// none of those labels says what Media Foundation itself picked, and that
// matters even now that createSinkWriter asks for hardware transforms on
// every path but the forced-software one: MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS
// asks, it does not guarantee -- a machine with no hardware H.264 MFT
// registered, or one whose driver refuses it, still lands on software. That
// gap is exactly what this exists to close for a bug report: "default" alone
// cannot tell a real hardware encode apart from software Media Foundation
// picked anyway, which was the whole ambiguity behind a slow-CPU stop timeout
// (getopenscreen/openscreen#460) before this field existed.
constexpr const char* kVideoEncoderRuntimeHardware = "hardware";
constexpr const char* kVideoEncoderRuntimeSoftware = "software";
// Introspection itself failed (no IMFSinkWriterEx, no encoder node found in
// the resolved topology, GetAttributes refused). Reported as its own value
// rather than guessed into hardware or software, because a bug report that
// cannot tell "we checked and it's software" from "we couldn't check" would
// draw the wrong conclusion either way.
constexpr const char* kVideoEncoderRuntimeUnknown = "unknown";

// Which MP4 flavour the recording was actually written in. The fragmented sink
// writes a self-describing moof+mdat pair roughly every second, so a helper the
// shutdown watchdog force-exits leaves a file that plays up to the last
// complete fragment. The plain sink writes its only index in Finalize(), which
// is the very call a TerminateProcess pre-empts -- that is how issues #252 /
// #292 / #327 turned a frozen recording into a total loss. Recording falls back
// to the plain container if anything about the fragmented one is unavailable,
// so this is reported rather than assumed.
constexpr const char* kContainerFormatFragmentedMp4 = "fragmented-mp4";
constexpr const char* kContainerFormatMp4 = "mp4";

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
    // Best-effort, read only after initialize() returns true. See the
    // kVideoEncoderRuntime* constants above for what each value means.
    const char* videoEncoderRuntime() const;
    // Which container initialize() settled on, which is not necessarily the one
    // it asked for: the fragmented sink degrades to the plain one rather than
    // failing a recording. A bug report that cannot tell the two apart cannot
    // say whether a truncated file was supposed to survive its kill.
    const char* containerFormat() const;
    // Which video input path initialize() actually settled on, which is not
    // necessarily the one that was asked for. Callers must read this rather
    // than their own MFEncoderOptions to decide which capture entry point to
    // call, or a machine that fell back would be fed DXGI samples the sink
    // writer was never configured for.
    bool usesDxgiInput() const;
    // A breadcrumb, not state: safe to read from another thread at any time.
    // One slot per writing thread, deliberately. encodeStage() names what the
    // video-writer thread is inside; audioStage() names what the audio-mixer
    // thread is inside. A single shared slot cannot do both: most of the video
    // stages are set outside writerMutex_, so an audio write landing every few
    // milliseconds would overwrite a wedged video stage with "idle" and the
    // watchdog would report the absence of the very call it is trying to name.
    const char* encodeStage() const;
    const char* audioStage() const;

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
    bool initializeBridgeTexture();
    bool initializeSampleAllocator(IMFMediaType* inputType);
    void applyHardwareRateControl(int bitrate);
    int64_t nextSampleTime(int64_t timestampHns, int64_t sampleDuration);
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
    // Only the audio *input* type and SetInputMediaType. The AAC output type is
    // built before the sink writer exists (buildAacOutputType in the .cpp),
    // because MFCreateFMPEG4MediaSink takes both output types at construction:
    // a fragmented sink has all its streams before anything can be added to it.
    bool configureAudioStream(const AudioInputFormat& audioFormat);
    void releaseSinkWriter();

    Microsoft::WRL::ComPtr<IMFSinkWriter> sinkWriter_;
    // Held only on the fragmented path, and held because a sink writer built on
    // a media sink does not own either of them: releasing the writer leaves the
    // sink live and the output file open. releaseSinkWriter() is what closes
    // them, both between failed attempts and at finalize().
    Microsoft::WRL::ComPtr<IMFMediaSink> mediaSink_;
    Microsoft::WRL::ComPtr<IMFByteStream> byteStream_;
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
    // Guards the sink writer, and is held across IMFSinkWriter::WriteSample --
    // a synchronous encode. Only threads that can afford to wait out an encode
    // may take it, which rules out anything holding a caller's frame lock.
    std::mutex writerMutex_;
    // Guards the sample clock alone, so the capture* entry points (which do run
    // under a caller's frame lock) never queue behind an encode. Splitting this
    // out is what stops an audio WriteSample from wedging the video writer, and
    // through it the WGC callbacks, at stop (issue #252 follow-up).
    std::mutex timestampMutex_;
    // Where the encoder is right now, for the shutdown watchdog to name when a
    // step overruns. `video-writer-join phase=abandoned` says which thread is
    // stuck; this says which call it is stuck in.
    std::atomic<const char*> encodeStage_{"idle"};
    std::atomic<const char*> audioStage_{"idle"};
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
    const char* videoEncoderRuntime_ = kVideoEncoderRuntimeUnknown;
    const char* containerFormat_ = kContainerFormatMp4;
};
