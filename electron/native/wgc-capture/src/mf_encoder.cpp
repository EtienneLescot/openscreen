#include "mf_encoder.h"

#include "audio_sample_utils.h"

#include <codecapi.h>
#include <d3d10.h>
#include <dxgi1_2.h>
#include <icodecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <propvarutil.h>

#include <algorithm>
#include <cstring>
#include <iostream>

namespace {

bool succeeded(HRESULT hr, const char* label) {
    if (SUCCEEDED(hr)) {
        return true;
    }

    std::cerr << "ERROR: " << label << " failed (hr=0x" << std::hex << hr << std::dec << ")"
              << std::endl;
    return false;
}

// Count how many Media Foundation Transforms are registered for a given
// (category, output subtype) pair. Caller does not need the activations
// themselves; we just want to know whether at least one is registered so we
// can diagnose "no encoder registered" vs "encoder registered but sink can't
// wire it".
//
// `mediaType` is the encoder's major media type (e.g. video for video
// encoders, audio for audio encoders). It is used as both the input and
// output major type because an encoder's input and output streams share the
// same major type by definition. `outputSubtype` is the encoder's output
// media subtype (e.g. H264 for video encoders, AAC for audio encoders). We do
// not constrain the input subtype because encoders typically accept many
// input subtypes and constraining here would under-count.
UINT32 countRegisteredMfts(
    const GUID& category,
    const GUID& mediaType,
    const GUID& outputSubtype) {
    MFT_REGISTER_TYPE_INFO inputType{};
    inputType.guidMajorType = mediaType;
    inputType.guidSubtype = GUID_NULL;

    MFT_REGISTER_TYPE_INFO outputType{};
    outputType.guidMajorType = mediaType;
    outputType.guidSubtype = outputSubtype;

    // MFT_ENUM_FLAG_ALL is the documented flag set for "synchronous, async,
    // hardware, software" — there is no separate SOFTWARE flag. Using a
    // narrower flag set can omit legitimate encoders (e.g. the AMD AMF H.264
    // encoder is async hardware).
    IMFActivate** activates = nullptr;
    UINT32 count = 0;
    HRESULT hr = MFTEnumEx(
        category,
        MFT_ENUM_FLAG_ALL,
        &inputType,
        &outputType,
        &activates,
        &count);
    if (FAILED(hr)) {
        // MFTEnumEx failed outright (e.g. COM not initialized, invalid
        // category). Surface the HRESULT so future bug reports can
        // distinguish this from "zero encoders registered" (which returns
        // SUCCEEDED(hr) with count == 0).
        std::cerr << "ERROR: MFTEnumEx failed (hr=0x" << std::hex << hr
                  << std::dec << ")" << std::endl;
        return 0;
    }
    if (activates != nullptr) {
        for (UINT32 i = 0; i < count; i += 1) {
            if (activates[i] != nullptr) {
                activates[i]->Release();
            }
        }
        CoTaskMemFree(activates);
    }
    return count;
}

UINT32 countRegisteredH264VideoEncoders() {
    return countRegisteredMfts(
        MFT_CATEGORY_VIDEO_ENCODER, MFMediaType_Video, MFVideoFormat_H264);
}

UINT32 countRegisteredAacAudioEncoders() {
    return countRegisteredMfts(
        MFT_CATEGORY_AUDIO_ENCODER, MFMediaType_Audio, MFAudioFormat_AAC);
}

void logMissingH264EncoderError() {
    std::cerr
        << "ERROR: No H.264 video encoder MFT is registered on this system."
        << std::endl;
    std::cerr
        << "  Windows could not find any Media Foundation Transform that "
        << "outputs MFVideoFormat_H264." << std::endl;
    std::cerr
        << "  MP4 recording requires an H.264 encoder. Without one, "
        << "MFCreateSinkWriterFromURL fails (hr=0x80070003)."
        << std::endl;
    std::cerr
        << "  Try the following fixes in order:" << std::endl;
    std::cerr
        << "    1. Install the Media Feature Pack via Optional Features "
        << "(Settings > Apps > Optional features > Add > Media Feature Pack), "
        << "or run: Dism /online /add-capability /capabilityname:Media.MediaFeaturePack~~~~0.0.1.0"
        << std::endl;
    std::cerr
        << "    2. Update your GPU drivers so the hardware H.264 encoder MFT "
        << "(AMD AMF, NVIDIA NVENC, Intel Quick Sync) re-registers itself."
        << std::endl;
    std::cerr
        << "    3. Inspect the registered transforms under"
        << " HKLM:\\SOFTWARE\\Microsoft\\Windows Media Foundation\\Transforms"
        << " and HKLM:\\SOFTWARE\\Classes\\MediaFoundation\\Transforms."
        << std::endl;
    std::cerr
        << "    4. Reboot after driver or Media Feature Pack changes; "
        << "MFT registration is cached at boot."
        << std::endl;
}

// Which step of createSinkWriter produced a failing HRESULT. Only a
// CreateSinkWriter failure means the sink-writer creation itself failed and
// warrants the encoder-enumeration diagnostics in logSinkWriterCreateFailure.
// The earlier setup steps each log their own specific error, so routing them
// through the sink-writer diagnostics would misattribute the failure (e.g.
// reporting a local MFT registration failure as a sink-writer failure on the
// VM / headless / broken-driver systems this path targets). CreateFile and
// CreateFragmentedMediaSink are container problems rather than encoder ones and
// are excluded for the same reason.
enum class SinkWriterCreateStage {
    SoftwareEncoderRegistration,
    CreateAttributes,
    DisableHardwareTransforms,
    EnableHardwareTransforms,
    CreateFile,
    CreateFragmentedMediaSink,
    CreateSinkWriter,
};

// How often the fragmented MP4 sink is allowed to close a moof+mdat pair. It is
// a floor, not a period: the sink still waits for the encoder's next key frame.
// One second is the trade the whole change rests on -- a killed helper loses at
// most the fragment in flight, while the per-fragment box overhead stays
// negligible against a multi-megabit H.264 payload.
constexpr UINT64 kFragmentDurationHns = 10'000'000ULL;

HRESULT ensureSoftwareH264EncoderRegisteredForProcess() {
    static std::mutex registrationMutex;
    static bool attempted = false;
    static HRESULT result = E_FAIL;

    std::scoped_lock lock(registrationMutex);
    if (attempted) {
        return result;
    }
    attempted = true;

    MFT_REGISTER_TYPE_INFO inputType{};
    inputType.guidMajorType = MFMediaType_Video;
    inputType.guidSubtype = GUID_NULL;

    MFT_REGISTER_TYPE_INFO outputType{};
    outputType.guidMajorType = MFMediaType_Video;
    outputType.guidSubtype = MFVideoFormat_H264;

    result = MFTRegisterLocalByCLSID(
        CLSID_MSH264EncoderMFT,
        MFT_CATEGORY_VIDEO_ENCODER,
        L"Microsoft H.264 Encoder MFT (software)",
        MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT,
        1,
        &inputType,
        1,
        &outputType);
    if (FAILED(result)) {
        std::cerr << "ERROR: MFTRegisterLocalByCLSID(CLSID_MSH264EncoderMFT) failed (hr=0x"
                  << std::hex << result << std::dec << ")" << std::endl;
    } else {
        std::cerr
            << "INFO: Registered the Microsoft software H.264 MFT locally for this helper process."
            << std::endl;
    }
    return result;
}

// `fragmented` picks between the two ways to reach a sink writer, and it is the
// only reason this function grew output types. MFCreateSinkWriterFromURL builds
// the MP4 sink itself and lets AddStream describe the streams afterwards;
// MFCreateFMPEG4MediaSink demands both output types up front because the
// fragmented sink writes its stream table before the first sample. Everything
// before that last step -- the local software MFT registration, the
// hardware-transform flag, the D3D manager -- is identical either way and stays
// on one path rather than being duplicated per container.
HRESULT createSinkWriter(
    const std::wstring& outputPath,
    bool fragmented,
    IMFMediaType* videoOutputType,
    IMFMediaType* audioOutputType,
    bool forceSoftwareEncoder,
    IMFDXGIDeviceManager* dxgiDeviceManager,
    bool injectDefaultSinkWriterFailureOnce,
    bool& injectedDefaultSinkWriterFailure,
    Microsoft::WRL::ComPtr<IMFByteStream>& byteStream,
    Microsoft::WRL::ComPtr<IMFMediaSink>& mediaSink,
    Microsoft::WRL::ComPtr<IMFSinkWriter>& sinkWriter,
    SinkWriterCreateStage& failedStage) {
    // Default to the sink-writer creation step; the software-path steps below
    // overwrite this only when one of them returns early with a failure.
    failedStage = SinkWriterCreateStage::CreateSinkWriter;

    Microsoft::WRL::ComPtr<IMFAttributes> attributes;
    if (forceSoftwareEncoder) {
        // The software fallback works by registering the Microsoft software
        // H.264 encoder MFT *in this helper process* via MFTRegisterLocalByCLSID
        // (see ensureSoftwareH264EncoderRegisteredForProcess). That in-process
        // registration is the key mechanism: it makes a software H.264 encoder
        // available even when the machine's registered hardware encoders are
        // missing or broken. Clearing MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS is
        // only a secondary guard so the sink writer prefers the locally
        // registered software encoder over a hardware transform; it is not
        // itself the fallback mechanism.
        const HRESULT registerHr = ensureSoftwareH264EncoderRegisteredForProcess();
        if (FAILED(registerHr)) {
            failedStage = SinkWriterCreateStage::SoftwareEncoderRegistration;
            return registerHr;
        }

        HRESULT hr = MFCreateAttributes(&attributes, 1);
        if (FAILED(hr)) {
            std::cerr << "ERROR: MFCreateAttributes(sink writer) failed (hr=0x"
                      << std::hex << hr << std::dec << ")" << std::endl;
            failedStage = SinkWriterCreateStage::CreateAttributes;
            return hr;
        }
        hr = attributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, FALSE);
        if (FAILED(hr)) {
            std::cerr << "ERROR: Set MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS failed (hr=0x"
                      << std::hex << hr << std::dec << ")" << std::endl;
            failedStage = SinkWriterCreateStage::DisableHardwareTransforms;
            return hr;
        }
    } else {
        // Ask for hardware transforms whenever software is not forced --
        // whether or not a DXGI device manager came with the request.
        // MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS defaults to FALSE, and
        // leaving it unset (the old behaviour on the plain CPU-readback path)
        // meant the sink writer never considered a hardware H.264 MFT even
        // when one was registered and working: every "default" recording
        // landed on the same software encoder forceSoftwareEncoder asks for
        // explicitly, on any machine that had not separately opted into
        // OPENSCREEN_WGC_ENABLE_DXGI_INPUT (getopenscreen/openscreen#460,
        // confirmed by videoEncoderRuntime on real hardware: "default" read
        // back "software" until the DXGI path was turned on, on a machine
        // whose encoder is hardware-capable either way).
        //
        // A hardware MFT does not require the D3D manager to accept samples:
        // without one it manages its own device and takes system-memory
        // samples the same way the software encoder does, which is exactly
        // the CPU-readback path this branch also serves. So the attribute is
        // set unconditionally here; only the manager itself stays behind the
        // null check, since supplying a manager the caller does not have would
        // be undefined rather than merely declined.
        HRESULT hr = MFCreateAttributes(&attributes, dxgiDeviceManager != nullptr ? 3 : 1);
        if (FAILED(hr)) {
            std::cerr << "ERROR: MFCreateAttributes(sink writer) failed (hr=0x"
                      << std::hex << hr << std::dec << ")" << std::endl;
            failedStage = SinkWriterCreateStage::CreateAttributes;
            return hr;
        }
        hr = attributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
        if (FAILED(hr)) {
            std::cerr << "ERROR: Set MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS(TRUE) failed (hr=0x"
                      << std::hex << hr << std::dec << ")" << std::endl;
            failedStage = SinkWriterCreateStage::EnableHardwareTransforms;
            return hr;
        }
        if (dxgiDeviceManager != nullptr) {
            hr = attributes->SetUnknown(MF_SINK_WRITER_D3D_MANAGER, dxgiDeviceManager);
            if (FAILED(hr)) {
                std::cerr << "ERROR: Set MF_SINK_WRITER_D3D_MANAGER failed (hr=0x"
                          << std::hex << hr << std::dec << ")" << std::endl;
                failedStage = SinkWriterCreateStage::EnableHardwareTransforms;
                return hr;
            }
        }
    }

    failedStage = SinkWriterCreateStage::CreateSinkWriter;
    // Ahead of the byte stream on purpose: an injection that fired after
    // MFCreateFile would leave the output file open on the very path whose job
    // is to prove the next attempt can still create it.
    if (
        !forceSoftwareEncoder &&
        injectDefaultSinkWriterFailureOnce &&
        !injectedDefaultSinkWriterFailure) {
        injectedDefaultSinkWriterFailure = true;
        std::cerr
            << "TEST-ONLY: Injected default sink-writer creation failure "
            << "(hr=0x80070003); injection consumed exactly once."
            << std::endl;
        return HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND);
    }

    if (!fragmented) {
        const HRESULT sinkWriterHr = MFCreateSinkWriterFromURL(
            outputPath.c_str(), nullptr, attributes.Get(), &sinkWriter);
        if (SUCCEEDED(sinkWriterHr) && forceSoftwareEncoder) {
            std::cerr << "INFO: Created the real software H.264 sink writer successfully."
                      << std::endl;
        }
        return sinkWriterHr;
    }

    failedStage = SinkWriterCreateStage::CreateFile;
    HRESULT hr = MFCreateFile(
        MF_ACCESSMODE_WRITE,
        MF_OPENMODE_DELETE_IF_EXIST,
        MF_FILEFLAGS_NONE,
        outputPath.c_str(),
        &byteStream);
    if (FAILED(hr)) {
        std::cerr << "ERROR: MFCreateFile(recording output) failed (hr=0x"
                  << std::hex << hr << std::dec << ")" << std::endl;
        return hr;
    }

    failedStage = SinkWriterCreateStage::CreateFragmentedMediaSink;
    hr = MFCreateFMPEG4MediaSink(byteStream.Get(), videoOutputType, audioOutputType, &mediaSink);
    if (FAILED(hr)) {
        std::cerr << "ERROR: MFCreateFMPEG4MediaSink failed (hr=0x"
                  << std::hex << hr << std::dec << "); the recording falls back to a "
                  << "plain MP4, which is unreadable if the helper is killed." << std::endl;
        return hr;
    }

    // Best effort. A sink that will not take the attribute still fragments, on
    // whatever interval it picked for itself, and that is already the whole
    // benefit; refusing the recording over the interval would trade the bug for
    // a worse one.
    Microsoft::WRL::ComPtr<IMFAttributes> sinkAttributes;
    if (
        FAILED(mediaSink.As(&sinkAttributes)) ||
        FAILED(sinkAttributes->SetUINT64(MF_MPEG4SINK_MIN_FRAGMENT_DURATION, kFragmentDurationHns))) {
        std::cerr << "WARNING: Could not set the fragmented MP4 fragment duration; "
                  << "the sink's own interval applies." << std::endl;
    }

    failedStage = SinkWriterCreateStage::CreateSinkWriter;
    const HRESULT sinkWriterHr = MFCreateSinkWriterFromMediaSink(
        mediaSink.Get(), attributes.Get(), &sinkWriter);
    if (SUCCEEDED(sinkWriterHr) && forceSoftwareEncoder) {
        std::cerr << "INFO: Created the real software H.264 sink writer successfully."
                  << std::endl;
    }
    return sinkWriterHr;
}

// The sink writer addresses a media sink's streams by their position in the
// sink. Nothing promises video is position 0 -- MFCreateFMPEG4MediaSink is
// handed two media types and decides for itself -- and getting it wrong would
// aim the audio writes at the video track. So the position is read back from
// the sink by major type instead of assumed, and logged with the stream
// identifier beside it, which is a different number and the one an MP4 dump
// shows.
bool resolveStreamSinkIndex(IMFMediaSink* mediaSink, const GUID& majorType, DWORD& streamIndex) {
    const char* const label = (majorType == MFMediaType_Video) ? "video" : "audio";
    DWORD streamSinkCount = 0;
    if (!succeeded(mediaSink->GetStreamSinkCount(&streamSinkCount), "GetStreamSinkCount")) {
        return false;
    }

    for (DWORD index = 0; index < streamSinkCount; index += 1) {
        Microsoft::WRL::ComPtr<IMFStreamSink> streamSink;
        if (FAILED(mediaSink->GetStreamSinkByIndex(index, &streamSink))) {
            continue;
        }
        Microsoft::WRL::ComPtr<IMFMediaTypeHandler> typeHandler;
        if (FAILED(streamSink->GetMediaTypeHandler(&typeHandler))) {
            continue;
        }
        GUID streamMajorType{};
        if (FAILED(typeHandler->GetMajorType(&streamMajorType)) || streamMajorType != majorType) {
            continue;
        }
        DWORD identifier = 0;
        streamSink->GetIdentifier(&identifier);
        std::cerr << "INFO: Fragmented MP4 sink carries " << label << " on stream index "
                  << index << " (identifier " << identifier << ")." << std::endl;
        streamIndex = index;
        return true;
    }

    std::cerr << "ERROR: The fragmented MP4 sink exposes no " << label << " stream sink ("
              << streamSinkCount << " stream sinks)." << std::endl;
    return false;
}

// Did the video stream's encoder MFT actually land on hardware?
//
// BeginWriting() succeeding says nothing about this: even on the "default"
// path (see kVideoEncoderRuntime* in mf_encoder.h), which does now ask for
// MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, that is a request and not a
// guarantee -- Media Foundation is still free to hand the sink writer a
// software MFT when no hardware one is registered or the driver refuses it.
// The only way to know which one it actually picked is to ask the pipeline it
// built, after the fact -- IMFSinkWriterEx::GetTransformForStream walks the
// MFTs the sink writer inserted for a stream, and a hardware MFT instance is
// required to expose MFT_ENUM_HARDWARE_URL_Attribute on its own attribute
// store (not just on the IMFActivate MFTEnumEx returns), which is what
// distinguishes it from a software one at this point.
//
// Every failure path here returns "unknown" rather than guessing: this runs
// after the sink writer is already committed to, so it must never be able to
// fail configureSinkWriterAttempt, and a wrong hardware/software guess in a
// bug report would be worse than an admitted "could not tell."
const char* detectVideoEncoderRuntime(IMFSinkWriter* sinkWriter, DWORD videoStreamIndex) {
    Microsoft::WRL::ComPtr<IMFSinkWriterEx> sinkWriterEx;
    if (FAILED(sinkWriter->QueryInterface(IID_PPV_ARGS(&sinkWriterEx)))) {
        return kVideoEncoderRuntimeUnknown;
    }

    for (DWORD mftIndex = 0;; mftIndex += 1) {
        GUID category{};
        Microsoft::WRL::ComPtr<IMFTransform> transform;
        const HRESULT hr =
            sinkWriterEx->GetTransformForStream(videoStreamIndex, mftIndex, &category, &transform);
        if (hr == MF_E_INVALIDINDEX) {
            // Walked the whole pipeline (converters, the encoder, anything
            // else the topology loader inserted) without finding an encoder
            // node. Should not happen -- an H.264 stream has to have one --
            // but this is diagnostics code, not the recording path, so an
            // unexpected shape is "unknown", not a crash.
            return kVideoEncoderRuntimeUnknown;
        }
        if (FAILED(hr)) {
            return kVideoEncoderRuntimeUnknown;
        }
        if (category != MFT_CATEGORY_VIDEO_ENCODER) {
            // A colour converter or similar the sink writer inserted ahead of
            // the encoder. Keep walking; the encoder is further down.
            continue;
        }

        Microsoft::WRL::ComPtr<IMFAttributes> transformAttributes;
        if (FAILED(transform->GetAttributes(&transformAttributes))) {
            return kVideoEncoderRuntimeUnknown;
        }
        UINT32 hardwareUrlLength = 0;
        const HRESULT hardwareUrlHr =
            transformAttributes->GetStringLength(MFT_ENUM_HARDWARE_URL_Attribute, &hardwareUrlLength);
        if (SUCCEEDED(hardwareUrlHr)) {
            return kVideoEncoderRuntimeHardware;
        }
        if (hardwareUrlHr == MF_E_ATTRIBUTENOTFOUND) {
            return kVideoEncoderRuntimeSoftware;
        }
        return kVideoEncoderRuntimeUnknown;
    }
}

void logSinkWriterCreateFailure(
    HRESULT sinkWriterHr,
    const char* createCall,
    const AudioInputFormat* audioFormat) {
    const UINT32 h264EncoderCount = countRegisteredH264VideoEncoders();
    const UINT32 aacEncoderCount = (audioFormat != nullptr)
        ? countRegisteredAacAudioEncoders()
        : 0;
    std::cerr << "ERROR: " << createCall << " failed (hr=0x"
              << std::hex << sinkWriterHr << std::dec << ")" << std::endl;
    std::cerr << "  Registered H.264 video encoder MFTs: " << h264EncoderCount
              << std::endl;
    if (audioFormat != nullptr) {
        std::cerr << "  Registered AAC audio encoder MFTs: " << aacEncoderCount
                  << std::endl;
    }
    if (h264EncoderCount == 0) {
        logMissingH264EncoderError();
    } else {
        std::cerr
            << "  An H.264 encoder MFT is registered but the sink writer "
            << "still failed. Possible causes: invalid output path or "
            << "permissions, no MP4 mux configured, or GPU driver "
            << "incompatibility with this Media Foundation build."
            << std::endl;
    }
}

void setFrameSize(IMFMediaType* type, UINT32 width, UINT32 height) {
    MFSetAttributeSize(type, MF_MT_FRAME_SIZE, width, height);
}

void setFrameRate(IMFMediaType* type, UINT32 fps) {
    MFSetAttributeRatio(type, MF_MT_FRAME_RATE, fps, 1);
}

void setPixelAspectRatio(IMFMediaType* type) {
    MFSetAttributeRatio(type, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
}

void setAudioFormat(IMFMediaType* type, UINT32 channels, UINT32 sampleRate, UINT32 bitsPerSample) {
    type->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, channels);
    type->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sampleRate);
    type->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, bitsPerSample);
}

// Lifted out of configureAudioStream unchanged, including the format guard,
// because the fragmented sink needs this type before a sink writer exists at
// all. The guard has to come with it: an invalid format must be refused before
// anything is built from it, not after.
bool buildAacOutputType(
    const AudioInputFormat& audioFormat,
    Microsoft::WRL::ComPtr<IMFMediaType>& outputType) {
    if (audioFormat.sampleRate == 0 || audioFormat.channels == 0 || audioFormat.blockAlign == 0) {
        std::cerr << "ERROR: Invalid audio input format" << std::endl;
        return false;
    }

    const AudioInputFormat encoderFormat = makeAacCompatibleAudioFormat(audioFormat);
    const UINT32 aacBytesPerSecond = 24'000;

    if (!succeeded(MFCreateMediaType(&outputType), "MFCreateMediaType(audio output)")) {
        return false;
    }
    outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    outputType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
    setAudioFormat(outputType.Get(), encoderFormat.channels, encoderFormat.sampleRate, 16);
    outputType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, aacBytesPerSecond);
    outputType->SetUINT32(MF_MT_AAC_PAYLOAD_TYPE, 0);
    return true;
}

void compositeWebcam(BYTE* destination, int width, int height, const BgraFrameView& webcamFrame) {
    if (!webcamFrame.data || webcamFrame.width <= 0 || webcamFrame.height <= 0 || width <= 0 || height <= 0) {
        return;
    }

    const int margin = std::max(16, std::min(width, height) / 60);
    const int maxOverlayWidth = std::max(2, width / 4);
    int overlayWidth = maxOverlayWidth;
    int overlayHeight = static_cast<int>(
        (static_cast<int64_t>(overlayWidth) * webcamFrame.height) / std::max(1, webcamFrame.width));
    const int maxOverlayHeight = std::max(2, height / 3);
    if (overlayHeight > maxOverlayHeight) {
        overlayHeight = maxOverlayHeight;
        overlayWidth = static_cast<int>(
            (static_cast<int64_t>(overlayHeight) * webcamFrame.width) / std::max(1, webcamFrame.height));
    }

    overlayWidth = std::max(2, std::min(overlayWidth, width - margin * 2));
    overlayHeight = std::max(2, std::min(overlayHeight, height - margin * 2));
    const int originX = std::max(0, width - overlayWidth - margin);
    const int originY = std::max(0, height - overlayHeight - margin);

    for (int y = 0; y < overlayHeight; y += 1) {
        const int sourceY = static_cast<int>((static_cast<int64_t>(y) * webcamFrame.height) / overlayHeight);
        BYTE* destinationRow = destination + ((originY + y) * width + originX) * 4;
        for (int x = 0; x < overlayWidth; x += 1) {
            const int sourceX = static_cast<int>((static_cast<int64_t>(x) * webcamFrame.width) / overlayWidth);
            const BYTE* source = webcamFrame.data + (sourceY * webcamFrame.width + sourceX) * 4;
            BYTE* target = destinationRow + x * 4;
            target[0] = source[0];
            target[1] = source[1];
            target[2] = source[2];
            target[3] = 255;
        }
    }
}

// Clears a breadcrumb on every exit from the scope it guards, which the manual
// resets could not: each of these functions has a dozen failure returns, and
// every one that forgot to clear left the watchdog naming a call the writer had
// already left. Naming the wrong call is worse than naming none -- the whole
// point of the breadcrumb is that the next #252 report does not have to guess.
struct StageGuard {
    std::atomic<const char*>& stage;
    ~StageGuard() {
        stage = "idle";
    }
};

} // namespace

MFEncoder::~MFEncoder() {
    finalize();
}

const char* MFEncoder::videoEncoderSelection() const {
    return videoEncoderSelection_;
}

const char* MFEncoder::videoEncoderRuntime() const {
    return videoEncoderRuntime_;
}

const char* MFEncoder::containerFormat() const {
    return containerFormat_;
}

// Releasing the sink writer is enough only when the sink writer built the sink
// itself. MFCreateSinkWriterFromMediaSink does not take ownership: dropping the
// writer leaves the fragmented sink live and the output file open underneath
// it. Between two attempts that meant the next MFCreateFile(DELETE_IF_EXIST)
// racing the previous attempt's own handle -- a broken fallback chain, which is
// the one thing this change is not allowed to produce. At finalize() it also
// closes the byte stream, so nothing is left sitting in a buffer.
void MFEncoder::releaseSinkWriter() {
    sinkWriter_.Reset();
    if (mediaSink_) {
        mediaSink_->Shutdown();
        mediaSink_.Reset();
    }
    if (byteStream_) {
        byteStream_->Close();
        byteStream_.Reset();
    }
}

bool MFEncoder::usesDxgiInput() const {
    return useDxgiInput_;
}

const char* MFEncoder::encodeStage() const {
    return encodeStage_.load();
}

const char* MFEncoder::audioStage() const {
    return audioStage_.load();
}

int64_t MFEncoder::nextSampleTime(int64_t timestampHns, int64_t sampleDuration) {
    // On `timestampMutex_` and not `writerMutex_`, deliberately. Every caller
    // of this runs under main.cpp's frame lock, and `writerMutex_` is held
    // across IMFSinkWriter::WriteSample by both submitVideoSample and
    // writeAudio. Taking it here put a synchronous encode inside the frame
    // lock: an audio WriteSample would stall the video writer, the video
    // writer would stall every WGC callback waiting on that lock, and stop
    // would find wgc-quiesce undrained and the writer unjoinable. That is the
    // system-audio reproduction in the issue #252 follow-up. Nothing else
    // touches these two fields, so they get a lock of their own that no
    // blocking call is ever held across.
    //
    // No sinkWriter_/finalized_ check any more either: that check was the only
    // other reason to be on writerMutex_, and submitVideoSample already makes
    // it before writing. A sample built for a writer that has since gone away
    // is discarded there, which costs one wasted buffer on a path that is
    // shutting down anyway.
    std::scoped_lock lock(timestampMutex_);
    if (firstTimestampHns_ < 0) {
        firstTimestampHns_ = timestampHns;
    }
    int64_t sampleTime = timestampHns - firstTimestampHns_;
    if (sampleTime <= lastTimestampHns_) {
        sampleTime = lastTimestampHns_ + sampleDuration;
    }
    lastTimestampHns_ = sampleTime;
    return sampleTime;
}

bool MFEncoder::initialize(
    const std::wstring& outputPath,
    int width,
    int height,
    int fps,
    int bitrate,
    ID3D11Device* device,
    ID3D11DeviceContext* context,
    const AudioInputFormat* audioFormat,
    MFEncoderOptions options) {
    width_ = (std::max(2, width) / 2) * 2;
    height_ = (std::max(2, height) / 2) * 2;
    fps_ = std::max(1, fps);
    device_ = device;
    context_ = context;
    captureDevice_ = device;
    captureContext_ = context;
    // The injected failure exists to prove the software fallback still works.
    // Leaving the GPU path on would make it prove something else: the DXGI
    // attempt would eat the injection and the run would land on the plain CPU
    // encoder, never reaching the software encoder the knob is aimed at.
    useDxgiInput_ = options.useDxgiInput && !options.injectDefaultSinkWriterFailureOnce;
    videoEncoderSelection_ = kVideoEncoderSelectionDefault;
    videoEncoderRuntime_ = kVideoEncoderRuntimeUnknown;

    if (!succeeded(MFStartup(MF_VERSION), "MFStartup")) {
        return false;
    }

    if (useDxgiInput_ && !initializeDxgiPipeline()) {
        std::cerr << "WARNING: The GPU DXGI encode path is unavailable on this machine; "
                  << "using the CPU readback path." << std::endl;
        releaseDxgiPipeline();
        useDxgiInput_ = false;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> outputType;
    if (!succeeded(MFCreateMediaType(&outputType), "MFCreateMediaType(output)")) {
        return false;
    }
    outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    outputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    outputType->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(std::max(1, bitrate)));
    outputType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    setFrameSize(outputType.Get(), static_cast<UINT32>(width_), static_cast<UINT32>(height_));
    setFrameRate(outputType.Get(), static_cast<UINT32>(fps_));
    setPixelAspectRatio(outputType.Get());

    Microsoft::WRL::ComPtr<IMFMediaType> inputType;
    if (!succeeded(MFCreateMediaType(&inputType), "MFCreateMediaType(input)")) {
        return false;
    }
    // Rebuilt rather than built once, because falling back to the CPU path
    // after the sink writer has already refused the NV12 type has to leave a
    // type the RGB32 path would have produced from scratch. Every attribute
    // one mode sets is deleted by the other; nothing carries over.
    auto configureVideoInputType = [&](bool dxgi) {
        inputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        inputType->SetGUID(MF_MT_SUBTYPE, dxgi ? MFVideoFormat_NV12 : MFVideoFormat_RGB32);
        inputType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        if (dxgi) {
            inputType->DeleteItem(MF_MT_DEFAULT_STRIDE);
            // The video processor below converts full-range BGRA into
            // studio-range BT.709, so say so. Left untagged, the encoder and
            // the player each pick their own default (BT.601 is the common
            // one) and the recording comes back with shifted colours the CPU
            // path does not have.
            inputType->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
            inputType->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
        } else {
            inputType->SetUINT32(MF_MT_DEFAULT_STRIDE, static_cast<UINT32>(width_ * 4));
            inputType->DeleteItem(MF_MT_VIDEO_NOMINAL_RANGE);
            inputType->DeleteItem(MF_MT_YUV_MATRIX);
        }
        setFrameSize(inputType.Get(), static_cast<UINT32>(width_), static_cast<UINT32>(height_));
        setFrameRate(inputType.Get(), static_cast<UINT32>(fps_));
        setPixelAspectRatio(inputType.Get());
    };

    // Carried on the H.264 type as well so the MP4 sink writes the matching
    // colour tags instead of leaving players to guess from the frame size.
    auto configureOutputColorTags = [&](bool dxgi) {
        if (dxgi) {
            outputType->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
            outputType->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
        } else {
            outputType->DeleteItem(MF_MT_VIDEO_NOMINAL_RANGE);
            outputType->DeleteItem(MF_MT_YUV_MATRIX);
        }
    };

    // The allocator is the last thing that can refuse the GPU path, and it can
    // only be built once the NV12 type exists. Falling back here costs nothing
    // but the type rewrite, because no sink writer has been created yet.
    configureVideoInputType(useDxgiInput_);
    configureOutputColorTags(useDxgiInput_);
    if (useDxgiInput_ && !initializeSampleAllocator(inputType.Get())) {
        std::cerr << "WARNING: The DXGI sample allocator is unavailable on this machine; "
                  << "using the CPU readback path." << std::endl;
        releaseDxgiPipeline();
        useDxgiInput_ = false;
        configureVideoInputType(false);
        configureOutputColorTags(false);
    }

    bool injectedDefaultSinkWriterFailure = false;

    auto resetSinkWriterAttempt = [&]() {
        releaseSinkWriter();
        videoStreamIndex_ = 0;
        audioStreamIndex_ = 0;
        hasAudioStream_ = false;
        videoEncoderSelection_ = kVideoEncoderSelectionDefault;
        videoEncoderRuntime_ = kVideoEncoderRuntimeUnknown;
        containerFormat_ = kContainerFormatMp4;
    };

    auto configureSinkWriterAttempt = [&, audioFormat](
        bool forceSoftwareEncoder,
        const char* selection,
        bool logCreateFailure,
        bool fragmented) {
        resetSinkWriterAttempt();

        // Before the sink writer, not inside configureAudioStream where this
        // used to live: MFCreateFMPEG4MediaSink takes the audio output type as
        // a construction argument. Null when the recording has no audio, which
        // is both the common case and a documented one for that call.
        Microsoft::WRL::ComPtr<IMFMediaType> audioOutputType;
        if (audioFormat && !buildAacOutputType(*audioFormat, audioOutputType)) {
            return false;
        }

        SinkWriterCreateStage failedStage = SinkWriterCreateStage::CreateSinkWriter;
        const HRESULT sinkWriterHr = createSinkWriter(
            outputPath,
            fragmented,
            outputType.Get(),
            audioOutputType.Get(),
            forceSoftwareEncoder,
            forceSoftwareEncoder ? nullptr : dxgiDeviceManager_.Get(),
            options.injectDefaultSinkWriterFailureOnce,
            injectedDefaultSinkWriterFailure,
            byteStream_,
            mediaSink_,
            sinkWriter_,
            failedStage);
        if (FAILED(sinkWriterHr)) {
            // Only a genuine sink-writer creation failure gets the sink-writer /
            // encoder-enumeration diagnostics. The earlier steps (local MFT
            // registration, attribute creation, hardware-transform flag, and on
            // the fragmented path the byte stream and the media sink) already
            // logged their own specific error inside createSinkWriter, so
            // logging here as well would misattribute those failures to the
            // sink writer.
            if (failedStage == SinkWriterCreateStage::CreateSinkWriter) {
                if (logCreateFailure) {
                    logSinkWriterCreateFailure(
                        sinkWriterHr,
                        fragmented ? "MFCreateSinkWriterFromMediaSink" : "MFCreateSinkWriterFromURL",
                        audioFormat);
                } else {
                    std::cerr << "WARNING: Sink-writer creation failed (hr=0x"
                              << std::hex << sinkWriterHr << std::dec << ")" << std::endl;
                }
            }
            return false;
        }

        if (fragmented) {
            // The streams already exist -- the sink was built from the output
            // types -- so there is nothing to add, only positions to find.
            if (!resolveStreamSinkIndex(mediaSink_.Get(), MFMediaType_Video, videoStreamIndex_)) {
                return false;
            }
            if (audioOutputType &&
                !resolveStreamSinkIndex(mediaSink_.Get(), MFMediaType_Audio, audioStreamIndex_)) {
                return false;
            }
        } else {
            if (!succeeded(
                    sinkWriter_->AddStream(outputType.Get(), &videoStreamIndex_),
                    "AddStream")) {
                return false;
            }
            if (audioOutputType &&
                !succeeded(
                    sinkWriter_->AddStream(audioOutputType.Get(), &audioStreamIndex_),
                    "AddStream(audio)")) {
                return false;
            }
        }

        if (audioFormat && !configureAudioStream(*audioFormat)) {
            return false;
        }

        // Also the check that catches a stream index resolved onto the wrong
        // track: an H.264 input type against an AAC stream sink has no encoder
        // that can bridge it, so a bad mapping fails loudly here instead of
        // quietly writing video samples into the audio track.
        if (!succeeded(sinkWriter_->SetInputMediaType(videoStreamIndex_, inputType.Get(), nullptr),
                       "SetInputMediaType")) {
            return false;
        }
        if (!forceSoftwareEncoder) {
            applyHardwareRateControl(std::max(1, bitrate));
        }
        if (!succeeded(sinkWriter_->BeginWriting(), "BeginWriting")) {
            return false;
        }

        videoEncoderSelection_ = selection;
        videoEncoderRuntime_ = detectVideoEncoderRuntime(sinkWriter_.Get(), videoStreamIndex_);
        containerFormat_ = fragmented ? kContainerFormatFragmentedMp4 : kContainerFormatMp4;
        return true;
    };

    // The last resort, tried only once every fragmented attempt has failed. A
    // machine where anything about MFCreateFMPEG4MediaSink does not work --
    // an output type the fragmented sink refuses, a stream layout that does not
    // resolve, a platform build without it -- records exactly as it did before
    // this change instead of not recording at all. The container is the point
    // of the change, and it is still not worth a recording.
    auto configureUnfragmentedFallback = [&](bool forceSoftwareEncoder, const char* selection) {
        std::cerr
            << "WARNING: Fragmented MP4 setup failed; retrying with the plain MP4 container. "
            << "The recording will be unreadable if the helper has to be killed."
            << std::endl;
        return configureSinkWriterAttempt(forceSoftwareEncoder, selection, true, false);
    };

    if (options.preferSoftwareEncoder) {
        if (configureSinkWriterAttempt(
                true,
                kVideoEncoderSelectionSoftwarePreferred,
                false,
                true)) {
            return true;
        }
        return configureUnfragmentedFallback(true, kVideoEncoderSelectionSoftwarePreferred);
    }

    if (configureSinkWriterAttempt(false, kVideoEncoderSelectionDefault, false, true)) {
        return true;
    }

    if (useDxgiInput_) {
        // The GPU path exists to dodge a CPU readback, not to be a requirement.
        // Drop it and retry the exact chain a machine without it would have
        // taken -- the software encoder cannot accept DXGI samples, so without
        // this the fallback below would be unreachable for every recording that
        // asked for the GPU path, which is all of them by default.
        std::cerr
            << "WARNING: Hardware DXGI H.264 encoder setup failed; "
            << "retrying on the CPU readback path."
            << std::endl;
        releaseDxgiPipeline();
        useDxgiInput_ = false;
        configureVideoInputType(false);
        configureOutputColorTags(false);
        if (configureSinkWriterAttempt(false, kVideoEncoderSelectionDefault, false, true)) {
            return true;
        }
    }

    std::cerr
        << "WARNING: Default Media Foundation H.264 encoder setup failed; "
        << "retrying with the Microsoft software H.264 encoder."
        << std::endl;
    if (configureSinkWriterAttempt(true, kVideoEncoderSelectionSoftwareFallback, false, true)) {
        return true;
    }
    return configureUnfragmentedFallback(true, kVideoEncoderSelectionSoftwareFallback);
}

// The output half -- the AAC type and, on the plain container, the AddStream
// that used to sit between the two -- now happens before the sink writer
// exists. What is left is the input type, which is the same on both containers
// and is set on a stream index the caller has already resolved.
bool MFEncoder::configureAudioStream(const AudioInputFormat& audioFormat) {
    if (!sinkWriter_) {
        return false;
    }

    const AudioInputFormat encoderFormat = makeAacCompatibleAudioFormat(audioFormat);

    Microsoft::WRL::ComPtr<IMFMediaType> inputType;
    if (!succeeded(MFCreateMediaType(&inputType), "MFCreateMediaType(audio input)")) {
        return false;
    }
    inputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    inputType->SetGUID(MF_MT_SUBTYPE, encoderFormat.subtype);
    setAudioFormat(inputType.Get(), encoderFormat.channels, encoderFormat.sampleRate, encoderFormat.bitsPerSample);
    inputType->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, encoderFormat.blockAlign);
    inputType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, encoderFormat.avgBytesPerSec);
    inputType->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);

    if (!succeeded(sinkWriter_->SetInputMediaType(audioStreamIndex_, inputType.Get(), nullptr),
                   "SetInputMediaType(audio)")) {
        return false;
    }

    hasAudioStream_ = true;
    return true;
}

bool MFEncoder::ensureStagingTexture(ID3D11Texture2D* texture) {
    if (stagingTexture_) {
        return true;
    }

    D3D11_TEXTURE2D_DESC desc{};
    texture->GetDesc(&desc);
    desc.Width = static_cast<UINT>(width_);
    desc.Height = static_cast<UINT>(height_);
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.SampleDesc.Quality = 0;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.MiscFlags = 0;

    return succeeded(device_->CreateTexture2D(&desc, nullptr, &stagingTexture_),
                     "CreateTexture2D(staging)");
}

bool MFEncoder::copyFrameToBuffer(
    ID3D11Texture2D* texture,
    BYTE* destination,
    DWORD destinationSize,
    const BgraFrameView* webcamFrame) {
    if (!ensureStagingTexture(texture)) {
        return false;
    }

    context_->CopyResource(stagingTexture_.Get(), texture);

    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (!succeeded(context_->Map(stagingTexture_.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Map")) {
        return false;
    }

    const DWORD rowBytes = static_cast<DWORD>(width_ * 4);
    const DWORD requiredBytes = rowBytes * static_cast<DWORD>(height_);
    if (destinationSize < requiredBytes) {
        context_->Unmap(stagingTexture_.Get(), 0);
        std::cerr << "ERROR: Media Foundation buffer is too small" << std::endl;
        return false;
    }

    auto* source = static_cast<const BYTE*>(mapped.pData);
    for (int y = 0; y < height_; y += 1) {
        std::memcpy(destination + rowBytes * y, source + mapped.RowPitch * y, rowBytes);
    }
    if (webcamFrame) {
        compositeWebcam(destination, width_, height_, *webcamFrame);
    }

    context_->Unmap(stagingTexture_.Get(), 0);
    return true;
}

bool MFEncoder::copyBgraFrameToBuffer(const BgraFrameView& frame, BYTE* destination, DWORD destinationSize) {
    if (!frame.data || frame.width <= 0 || frame.height <= 0) {
        return false;
    }

    const DWORD rowBytes = static_cast<DWORD>(width_ * 4);
    const DWORD requiredBytes = rowBytes * static_cast<DWORD>(height_);
    if (destinationSize < requiredBytes) {
        std::cerr << "ERROR: Media Foundation webcam buffer is too small" << std::endl;
        return false;
    }

    if (frame.width == width_ && frame.height == height_) {
        for (DWORD i = 0; i < requiredBytes; i += 4) {
            destination[i] = frame.data[i];
            destination[i + 1] = frame.data[i + 1];
            destination[i + 2] = frame.data[i + 2];
            destination[i + 3] = 255;
        }
        return true;
    }

    for (int y = 0; y < height_; y += 1) {
        const int sourceY = static_cast<int>((static_cast<int64_t>(y) * frame.height) / height_);
        BYTE* destinationRow = destination + rowBytes * y;
        for (int x = 0; x < width_; x += 1) {
            const int sourceX = static_cast<int>((static_cast<int64_t>(x) * frame.width) / width_);
            const BYTE* source = frame.data + (sourceY * frame.width + sourceX) * 4;
            BYTE* target = destinationRow + x * 4;
            target[0] = source[0];
            target[1] = source[1];
            target[2] = source[2];
            target[3] = 255;
        }
    }

    return true;
}

bool MFEncoder::initializeDxgiPipeline() {
    return initializeDxgiEncodingDevice() &&
        succeeded(
            MFCreateDXGIDeviceManager(&dxgiResetToken_, &dxgiDeviceManager_),
            "MFCreateDXGIDeviceManager") &&
        succeeded(
            dxgiDeviceManager_->ResetDevice(device_.Get(), dxgiResetToken_),
            "IMFDXGIDeviceManager::ResetDevice") &&
        initializeVideoProcessor() &&
        initializeBridgeTexture();
}

// Built here rather than on the first frame, which is the whole point: this
// runs inside initialize(), where returning false drops the GPU pipeline and
// retries the exact chain a machine without one would have taken. A driver
// that refuses D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX -- and they exist, which
// is the entire premise of this path being optional -- therefore records on
// the CPU path instead of failing the recording on frame one, long after the
// sink writer has been configured for NV12 and no fallback is possible.
//
// The descriptor comes from width_/height_ rather than from a captured frame,
// which is exactly equivalent: captureDxgiSample rejects any texture whose
// dimensions or format do not match those same values before it ever reaches
// convertBgraTextureToNv12, so no frame that could disagree with this
// descriptor can reach the bridge.
bool MFEncoder::initializeBridgeTexture() {
    D3D11_TEXTURE2D_DESC bridgeDesc{};
    bridgeDesc.Width = static_cast<UINT>(width_);
    bridgeDesc.Height = static_cast<UINT>(height_);
    bridgeDesc.MipLevels = 1;
    bridgeDesc.ArraySize = 1;
    bridgeDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    bridgeDesc.SampleDesc.Count = 1;
    bridgeDesc.SampleDesc.Quality = 0;
    bridgeDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    bridgeDesc.CPUAccessFlags = 0;
    bridgeDesc.Usage = D3D11_USAGE_DEFAULT;
    bridgeDesc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
    if (!succeeded(
            captureDevice_->CreateTexture2D(&bridgeDesc, nullptr, &captureBridgeTexture_),
            "CreateTexture2D(capture bridge)")) {
        return false;
    }
    if (!succeeded(captureBridgeTexture_.As(&captureBridgeMutex_), "Query capture bridge mutex")) {
        return false;
    }

    Microsoft::WRL::ComPtr<IDXGIResource> bridgeResource;
    if (!succeeded(captureBridgeTexture_.As(&bridgeResource), "Query capture bridge resource")) {
        return false;
    }
    HANDLE sharedHandle = nullptr;
    if (!succeeded(bridgeResource->GetSharedHandle(&sharedHandle), "Get capture bridge handle")) {
        return false;
    }
    if (!succeeded(
            device_->OpenSharedResource(
                sharedHandle,
                __uuidof(ID3D11Texture2D),
                reinterpret_cast<void**>(encoderBridgeTexture_.GetAddressOf())),
            "Open encoder bridge texture")) {
        return false;
    }
    if (!succeeded(encoderBridgeTexture_.As(&encoderBridgeMutex_), "Query encoder bridge mutex")) {
        return false;
    }

    // The bridge is the only input this processor ever reads, so its view is
    // built once here rather than per frame. Views describe a resource, they do
    // not read it, so this needs no keyed-mutex ownership.
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC inputViewDesc{};
    inputViewDesc.FourCC = 0;
    inputViewDesc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    inputViewDesc.Texture2D.MipSlice = 0;
    inputViewDesc.Texture2D.ArraySlice = 0;
    return succeeded(
        videoDevice_->CreateVideoProcessorInputView(
            encoderBridgeTexture_.Get(),
            videoProcessorEnumerator_.Get(),
            &inputViewDesc,
            &bridgeInputView_),
        "CreateVideoProcessorInputView");
}

void MFEncoder::releaseDxgiPipeline() {
    bridgeInputView_.Reset();
    encoderBridgeMutex_.Reset();
    encoderBridgeTexture_.Reset();
    captureBridgeMutex_.Reset();
    captureBridgeTexture_.Reset();
    videoProcessor_.Reset();
    videoProcessorEnumerator_.Reset();
    videoContext_.Reset();
    videoDevice_.Reset();
    videoSampleAllocator_.Reset();
    dxgiDeviceManager_.Reset();
    dxgiResetToken_ = 0;
    // Put the encoder back on the capture device. initializeDxgiEncodingDevice
    // overwrites device_/context_ with the second device it creates, and the
    // CPU path's staging texture has to live on the same device the WGC frames
    // do or its CopyResource silently does nothing.
    device_ = captureDevice_;
    context_ = captureContext_;
}

bool MFEncoder::initializeDxgiEncodingDevice() {
    Microsoft::WRL::ComPtr<IDXGIDevice> captureDxgiDevice;
    if (!succeeded(captureDevice_.As(&captureDxgiDevice), "Query capture IDXGIDevice")) {
        return false;
    }
    Microsoft::WRL::ComPtr<IDXGIAdapter> adapter;
    if (!succeeded(captureDxgiDevice->GetAdapter(&adapter), "Get capture DXGI adapter")) {
        return false;
    }

    const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
    D3D_FEATURE_LEVEL featureLevels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    };
    D3D_FEATURE_LEVEL featureLevel{};
    if (!succeeded(
            D3D11CreateDevice(
                adapter.Get(),
                D3D_DRIVER_TYPE_UNKNOWN,
                nullptr,
                flags,
                featureLevels,
                ARRAYSIZE(featureLevels),
                D3D11_SDK_VERSION,
                &device_,
                &featureLevel,
                &context_),
            "D3D11CreateDevice(encoder)")) {
        return false;
    }

    Microsoft::WRL::ComPtr<ID3D10Multithread> multithread;
    if (!succeeded(context_.As(&multithread), "Query encoder ID3D10Multithread")) {
        return false;
    }
    multithread->SetMultithreadProtected(TRUE);
    return true;
}

bool MFEncoder::initializeVideoProcessor() {
    if (!succeeded(device_.As(&videoDevice_), "Query ID3D11VideoDevice")) {
        return false;
    }
    if (!succeeded(context_.As(&videoContext_), "Query ID3D11VideoContext")) {
        return false;
    }

    D3D11_VIDEO_PROCESSOR_CONTENT_DESC contentDesc{};
    contentDesc.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    contentDesc.InputFrameRate = {static_cast<UINT>(fps_), 1};
    contentDesc.InputWidth = static_cast<UINT>(width_);
    contentDesc.InputHeight = static_cast<UINT>(height_);
    contentDesc.OutputFrameRate = {static_cast<UINT>(fps_), 1};
    contentDesc.OutputWidth = static_cast<UINT>(width_);
    contentDesc.OutputHeight = static_cast<UINT>(height_);
    contentDesc.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;

    if (!succeeded(
            videoDevice_->CreateVideoProcessorEnumerator(
                &contentDesc,
                &videoProcessorEnumerator_),
            "CreateVideoProcessorEnumerator")) {
        return false;
    }

    UINT nv12Support = 0;
    if (!succeeded(
            videoProcessorEnumerator_->CheckVideoProcessorFormat(
                DXGI_FORMAT_NV12,
                &nv12Support),
            "CheckVideoProcessorFormat(NV12)")) {
        return false;
    }
    if ((nv12Support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT) == 0) {
        std::cerr << "ERROR: D3D11 video processor does not support NV12 output" << std::endl;
        return false;
    }

    if (!succeeded(
            videoDevice_->CreateVideoProcessor(
                videoProcessorEnumerator_.Get(),
                0,
                &videoProcessor_),
            "CreateVideoProcessor")) {
        return false;
    }

    // Processor state, not per-blt arguments. Nothing below changes for the
    // life of the recording -- the capture size is fixed at initialize() --
    // so setting it once keeps four driver round trips out of every frame.
    const RECT frameRect{0, 0, width_, height_};
    videoContext_->VideoProcessorSetOutputTargetRect(videoProcessor_.Get(), TRUE, &frameRect);
    videoContext_->VideoProcessorSetStreamFrameFormat(
        videoProcessor_.Get(),
        0,
        D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
    videoContext_->VideoProcessorSetStreamSourceRect(videoProcessor_.Get(), 0, TRUE, &frameRect);
    videoContext_->VideoProcessorSetStreamDestRect(videoProcessor_.Get(), 0, TRUE, &frameRect);

    // Screen pixels are full-range sRGB and H.264 in an MP4 is conventionally
    // studio-range BT.709. Say both out loud: the driver's default is BT.601
    // limited, which a player then decodes as BT.709 at 1080p and above, and
    // the recording comes back with visibly shifted colours. The matching tags
    // go on the media types in initialize().
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE inputColorSpace{};
    inputColorSpace.RGB_Range = 0;  // full range, 0-255
    inputColorSpace.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255;
    videoContext_->VideoProcessorSetStreamColorSpace(videoProcessor_.Get(), 0, &inputColorSpace);

    D3D11_VIDEO_PROCESSOR_COLOR_SPACE outputColorSpace{};
    outputColorSpace.YCbCr_Matrix = 1;  // BT.709
    outputColorSpace.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
    videoContext_->VideoProcessorSetOutputColorSpace(videoProcessor_.Get(), &outputColorSpace);
    return true;
}

void MFEncoder::applyHardwareRateControl(int bitrate) {
    // Enabling MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS can hand the sink
    // writer a hardware MFT, and those default to constant bitrate: a static
    // desktop then spends the full configured budget doing nothing, 16.9 Mbps
    // measured against the 1.95 the software encoder produced for the same
    // screen. Same budget, opposite reading of it. Ask for VBR so a hardware
    // encoder spends what the picture costs, which is what the software
    // encoder was already doing. Called whenever hardware transforms were
    // requested, DXGI device manager or not (getopenscreen/openscreen#460) --
    // whether the sink writer actually landed on hardware is not knowable
    // until after BeginWriting() (see MFEncoder::videoEncoderRuntime()), and
    // this call is a no-op on a software MFT that ignores or lacks the knob.
    //
    // Best effort on purpose. An encoder that exposes neither knob still
    // produces a valid recording, and a bitrate we could not pin down is not
    // worth failing a capture over.
    Microsoft::WRL::ComPtr<ICodecAPI> codecApi;
    if (FAILED(sinkWriter_->GetServiceForStream(
            videoStreamIndex_,
            GUID_NULL,
            IID_PPV_ARGS(&codecApi)))) {
        std::cerr << "WARNING: The hardware H.264 encoder exposes no ICodecAPI; "
                  << "its default bitrate applies." << std::endl;
        return;
    }

    VARIANT value{};
    value.vt = VT_UI4;
    value.ulVal = eAVEncCommonRateControlMode_UnconstrainedVBR;
    if (FAILED(codecApi->SetValue(&CODECAPI_AVEncCommonRateControlMode, &value))) {
        std::cerr << "WARNING: Could not select VBR on the hardware H.264 encoder" << std::endl;
    }
    // Kept as the mean rather than lowered: the configured value is the budget
    // for a busy screen, and under VBR a quiet one no longer has to spend it.
    value.ulVal = static_cast<ULONG>(bitrate);
    if (FAILED(codecApi->SetValue(&CODECAPI_AVEncCommonMeanBitRate, &value))) {
        std::cerr << "WARNING: Could not set the hardware H.264 encoder bitrate" << std::endl;
    }
}

bool MFEncoder::initializeSampleAllocator(IMFMediaType* inputType) {
    if (!succeeded(
            MFCreateVideoSampleAllocatorEx(
                __uuidof(IMFVideoSampleAllocatorEx),
                reinterpret_cast<void**>(videoSampleAllocator_.GetAddressOf())),
            "MFCreateVideoSampleAllocatorEx")) {
        return false;
    }
    if (!succeeded(
            videoSampleAllocator_->SetDirectXManager(dxgiDeviceManager_.Get()),
            "IMFVideoSampleAllocator::SetDirectXManager")) {
        return false;
    }
    Microsoft::WRL::ComPtr<IMFAttributes> allocatorAttributes;
    if (!succeeded(MFCreateAttributes(&allocatorAttributes, 2), "MFCreateAttributes(allocator)")) {
        return false;
    }
    allocatorAttributes->SetUINT32(MF_SA_D3D11_USAGE, D3D11_USAGE_DEFAULT);
    allocatorAttributes->SetUINT32(
        MF_SA_D3D11_BINDFLAGS,
        D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE);
    return succeeded(
        videoSampleAllocator_->InitializeSampleAllocatorEx(4, 30, allocatorAttributes.Get(), inputType),
        "IMFVideoSampleAllocatorEx::InitializeSampleAllocatorEx");
}

MFEncoder::Nv12ConvertResult MFEncoder::convertBgraTextureToNv12(
    ID3D11Texture2D* texture,
    ID3D11Texture2D* outputTexture) {
    // Short on purpose. This runs on the video-writer thread while it holds
    // main.cpp's frame lock, and that lock is what issue #252 was about: any
    // multi-second wait taken under it is a multi-second wait the shutdown
    // watchdog counts against its 8s step budget. A few frame intervals is
    // long enough for a busy GPU and short enough that a stuck bridge costs a
    // dropped frame instead of the recording.
    const DWORD acquireTimeoutMs = static_cast<DWORD>(std::max(50, 4000 / fps_));
    const StageGuard stageGuard{encodeStage_};

    // Key 0 is the capture side's, key 1 the encoder's. Timing out here leaves
    // key 0 exactly where it was, so the next frame simply tries again; that
    // is the whole reason this one is recoverable and the one below is not.
    //
    // Tested by value, not with FAILED(): AcquireSync reports a timeout as
    // WAIT_TIMEOUT (0x102), which is a *positive* HRESULT and therefore passes
    // both SUCCEEDED() and !FAILED(). Testing FAILED() alone got this backwards
    // in both directions -- a timeout fell through to the CopyResource below
    // without ever holding the key, and a hard error (DXGI_ERROR_DEVICE_REMOVED,
    // E_FAIL, WAIT_ABANDONED) was reported as ordinary contention, which skips
    // the frame and retries forever on a bridge that can never work again. The
    // recording then ends successfully with almost no frames in it.
    encodeStage_ = "bridge-acquire-capture";
    const HRESULT captureAcquireHr = captureBridgeMutex_->AcquireSync(0, acquireTimeoutMs);
    if (captureAcquireHr == static_cast<HRESULT>(WAIT_TIMEOUT)) {
        return Nv12ConvertResult::Contended;
    }
    if (!succeeded(captureAcquireHr, "Acquire capture bridge")) {
        return Nv12ConvertResult::Failed;
    }
    encodeStage_ = "bridge-copy";
    captureContext_->CopyResource(captureBridgeTexture_.Get(), texture);
    encodeStage_ = "bridge-release-capture";
    if (!succeeded(captureBridgeMutex_->ReleaseSync(1), "Release capture bridge")) {
        return Nv12ConvertResult::Failed;
    }
    encodeStage_ = "bridge-acquire-encoder";
    // Key 1 was just handed over by this same thread and nothing else in the
    // process can hold it, so a failure here means the bridge is broken rather
    // than busy, and no later frame could recover it. A timeout counts as broken
    // for that same reason, and needs the same by-value test as above, since
    // WAIT_TIMEOUT passes SUCCEEDED() and would otherwise be read as acquired.
    const HRESULT encoderAcquireHr = encoderBridgeMutex_->AcquireSync(1, acquireTimeoutMs);
    if (encoderAcquireHr == static_cast<HRESULT>(WAIT_TIMEOUT)) {
        std::cerr << "ERROR: Acquire encoder bridge timed out" << std::endl;
        return Nv12ConvertResult::Failed;
    }
    if (!succeeded(encoderAcquireHr, "Acquire encoder bridge")) {
        return Nv12ConvertResult::Failed;
    }
    const auto releaseEncoderBridge = [&]() {
        return succeeded(encoderBridgeMutex_->ReleaseSync(0), "Release encoder bridge");
    };

    // Recreated per frame because the allocator hands out a different texture
    // from its pool each time. The input view and every processor setting are
    // hoisted out; this one call is what is genuinely per-frame.
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC outputViewDesc{};
    outputViewDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    outputViewDesc.Texture2D.MipSlice = 0;

    Microsoft::WRL::ComPtr<ID3D11VideoProcessorOutputView> outputView;
    encodeStage_ = "output-view";
    if (!succeeded(
            videoDevice_->CreateVideoProcessorOutputView(
                outputTexture,
                videoProcessorEnumerator_.Get(),
                &outputViewDesc,
                &outputView),
            "CreateVideoProcessorOutputView")) {
        releaseEncoderBridge();
        return Nv12ConvertResult::Failed;
    }

    D3D11_VIDEO_PROCESSOR_STREAM stream{};
    stream.Enable = TRUE;
    stream.OutputIndex = 0;
    stream.InputFrameOrField = 0;
    stream.PastFrames = 0;
    stream.FutureFrames = 0;
    stream.pInputSurface = bridgeInputView_.Get();

    encodeStage_ = "video-processor-blt";
    const bool converted = succeeded(
        videoContext_->VideoProcessorBlt(
            videoProcessor_.Get(),
            outputView.Get(),
            0,
            1,
            &stream),
        "VideoProcessorBlt");
    encodeStage_ = "bridge-release-encoder";
    const bool released = releaseEncoderBridge();
    return converted && released ? Nv12ConvertResult::Ok : Nv12ConvertResult::Failed;
}

bool MFEncoder::captureDxgiSample(
    ID3D11Texture2D* texture,
    int64_t timestampHns,
    Microsoft::WRL::ComPtr<IMFSample>& outSample) {
    outSample.Reset();
    if (!texture) {
        return false;
    }

    D3D11_TEXTURE2D_DESC desc{};
    texture->GetDesc(&desc);
    if (desc.Width != static_cast<UINT>(width_) ||
        desc.Height != static_cast<UINT>(height_) ||
        desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
        std::cerr << "ERROR: Unexpected WGC DXGI texture format or dimensions" << std::endl;
        return false;
    }
    // Declared after the two early returns above, which run before any stage is
    // set and so have nothing to clear.
    const StageGuard stageGuard{encodeStage_};

    Microsoft::WRL::ComPtr<IMFSample> sample;
    encodeStage_ = "allocate-sample";
    if (!succeeded(videoSampleAllocator_->AllocateSample(&sample), "Allocate DXGI video sample")) {
        return false;
    }

    Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
    if (!succeeded(sample->GetBufferByIndex(0, &buffer), "Get DXGI video buffer")) {
        return false;
    }

    Microsoft::WRL::ComPtr<IMFDXGIBuffer> dxgiBuffer;
    if (!succeeded(buffer.As(&dxgiBuffer), "Query IMFDXGIBuffer")) {
        return false;
    }
    Microsoft::WRL::ComPtr<ID3D11Texture2D> nv12Texture;
    if (!succeeded(
            dxgiBuffer->GetResource(
                __uuidof(ID3D11Texture2D),
                reinterpret_cast<void**>(nv12Texture.GetAddressOf())),
            "IMFDXGIBuffer::GetResource")) {
        return false;
    }
    switch (convertBgraTextureToNv12(texture, nv12Texture.Get())) {
        case Nv12ConvertResult::Ok:
            break;
        case Nv12ConvertResult::Contended:
            // No sample, no failure. Leaving outSample empty tells the caller
            // to skip this pass.
            return true;
        case Nv12ConvertResult::Failed:
            return false;
    }

    // Stamped only once the frame exists. Doing this first, as the CPU path
    // does, would let every dropped frame still advance lastTimestampHns_ and
    // stretch the timeline by the frames that were never written.
    const int64_t sampleDuration = 10'000'000LL / fps_;
    const int64_t sampleTime = nextSampleTime(timestampHns, sampleDuration);

    DWORD maximumLength = 0;
    if (!succeeded(buffer->GetMaxLength(&maximumLength), "IMFMediaBuffer::GetMaxLength(DXGI)")) {
        return false;
    }
    if (!succeeded(
            buffer->SetCurrentLength(maximumLength),
            "IMFMediaBuffer::SetCurrentLength(DXGI)")) {
        return false;
    }

    sample->SetSampleTime(sampleTime);
    sample->SetSampleDuration(sampleDuration);
    outSample = sample;
    return true;
}

bool MFEncoder::captureVideoSample(
    ID3D11Texture2D* texture,
    int64_t timestampHns,
    const BgraFrameView* webcamFrame,
    Microsoft::WRL::ComPtr<IMFSample>& outSample) {
    outSample.Reset();

    const int64_t sampleDuration = 10'000'000LL / fps_;
    const int64_t sampleTime = nextSampleTime(timestampHns, sampleDuration);

    // The GPU readback below (copyFrameToBuffer -> CopyResource/Map on
    // `texture`) is not internally synchronized here. Callers must hold their
    // own lock around this call that also serializes against whatever thread
    // writes new frame data into `texture` (see main.cpp's writeVideoFrames,
    // which holds the shared frame-state mutex across this call but not
    // across submitVideoSample).
    Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
    const DWORD frameBytes = static_cast<DWORD>(width_ * height_ * 4);
    if (!succeeded(MFCreateMemoryBuffer(frameBytes, &buffer), "MFCreateMemoryBuffer")) {
        return false;
    }

    BYTE* data = nullptr;
    DWORD maxLength = 0;
    DWORD currentLength = 0;
    if (!succeeded(buffer->Lock(&data, &maxLength, &currentLength), "IMFMediaBuffer::Lock")) {
        return false;
    }

    const bool copied = copyFrameToBuffer(texture, data, maxLength, webcamFrame);
    buffer->Unlock();
    if (!copied) {
        return false;
    }
    buffer->SetCurrentLength(frameBytes);

    Microsoft::WRL::ComPtr<IMFSample> sample;
    if (!succeeded(MFCreateSample(&sample), "MFCreateSample")) {
        return false;
    }
    sample->AddBuffer(buffer.Get());
    sample->SetSampleTime(sampleTime);
    sample->SetSampleDuration(sampleDuration);

    outSample = sample;
    return true;
}

bool MFEncoder::captureBgraSample(
    const BgraFrameView& frame,
    int64_t timestampHns,
    Microsoft::WRL::ComPtr<IMFSample>& outSample) {
    outSample.Reset();

    const int64_t sampleDuration = 10'000'000LL / fps_;
    const int64_t sampleTime = nextSampleTime(timestampHns, sampleDuration);

    Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
    const DWORD frameBytes = static_cast<DWORD>(width_ * height_ * 4);
    if (!succeeded(MFCreateMemoryBuffer(frameBytes, &buffer), "MFCreateMemoryBuffer(webcam)")) {
        return false;
    }

    BYTE* data = nullptr;
    DWORD maxLength = 0;
    DWORD currentLength = 0;
    if (!succeeded(buffer->Lock(&data, &maxLength, &currentLength), "IMFMediaBuffer::Lock(webcam)")) {
        return false;
    }

    const bool copied = copyBgraFrameToBuffer(frame, data, maxLength);
    buffer->Unlock();
    if (!copied) {
        return false;
    }
    buffer->SetCurrentLength(frameBytes);

    Microsoft::WRL::ComPtr<IMFSample> sample;
    if (!succeeded(MFCreateSample(&sample), "MFCreateSample(webcam)")) {
        return false;
    }
    sample->AddBuffer(buffer.Get());
    sample->SetSampleTime(sampleTime);
    sample->SetSampleDuration(sampleDuration);

    outSample = sample;
    return true;
}

bool MFEncoder::submitVideoSample(IMFSample* sample) {
    if (!sample) {
        return false;
    }

    // This is the potentially slow, blocking step (especially with the
    // software H.264 encoder fallback): IMFSinkWriter::WriteSample runs the
    // encode synchronously on the calling thread. Callers must NOT hold any
    // lock shared with a thread that needs to make timely progress (e.g. a
    // stop-request check) across this call.
    // Stamped after the lock, not before it. The breadcrumb is meant to name the
    // call the writer is *inside*; setting it first made "write-sample" also mean
    // "queued behind writeAudio, which is inside WriteSample" -- the one case the
    // watchdog most needs to tell apart, since an audio write is the only other
    // thing that takes this mutex.
    std::scoped_lock writerLock(writerMutex_);
    if (!sinkWriter_ || finalized_) {
        return false;
    }
    encodeStage_ = "write-sample";
    const bool written = succeeded(sinkWriter_->WriteSample(videoStreamIndex_, sample), "WriteSample");
    encodeStage_ = "idle";
    return written;
}

bool MFEncoder::writeAudio(const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns) {
    std::scoped_lock writerLock(writerMutex_);
    if (!sinkWriter_ || finalized_ || !hasAudioStream_) {
        return false;
    }
    if (!data || byteCount == 0 || durationHns <= 0) {
        return true;
    }

    Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
    if (!succeeded(MFCreateMemoryBuffer(byteCount, &buffer), "MFCreateMemoryBuffer(audio)")) {
        return false;
    }

    BYTE* destination = nullptr;
    DWORD maxLength = 0;
    DWORD currentLength = 0;
    if (!succeeded(buffer->Lock(&destination, &maxLength, &currentLength),
                   "IMFMediaBuffer::Lock(audio)")) {
        return false;
    }
    if (maxLength < byteCount) {
        buffer->Unlock();
        std::cerr << "ERROR: Media Foundation audio buffer is too small" << std::endl;
        return false;
    }
    std::memcpy(destination, data, byteCount);
    buffer->Unlock();
    buffer->SetCurrentLength(byteCount);

    Microsoft::WRL::ComPtr<IMFSample> sample;
    if (!succeeded(MFCreateSample(&sample), "MFCreateSample(audio)")) {
        return false;
    }
    sample->AddBuffer(buffer.Get());
    sample->SetSampleTime(std::max<int64_t>(0, timestampHns));
    sample->SetSampleDuration(durationHns);

    // Named too, for the same reason the video write is: this is a synchronous
    // encode holding writerMutex_, so it is a place the process can be stuck,
    // and a watchdog report that only ever names video writes cannot say so.
    //
    // Its own slot, not encodeStage_. This runs on the audio-mixer thread,
    // which emits roughly every 10 ms, while most of the video thread's stages
    // (the whole DXGI bridge sequence) are set outside writerMutex_. Sharing
    // one slot meant a video thread wedged in bridge-copy had its breadcrumb
    // overwritten with "idle" within milliseconds, so the watchdog reported the
    // absence of a stage instead of the call that hung -- the exact opposite of
    // what the breadcrumb is for, on the exact configuration (#252 with system
    // audio) it was added to diagnose.
    audioStage_ = "write-audio";
    const bool written =
        succeeded(sinkWriter_->WriteSample(audioStreamIndex_, sample.Get()), "WriteSample(audio)");
    audioStage_ = "idle";
    return written;
}

bool MFEncoder::finalize() {
    std::scoped_lock writerLock(writerMutex_);
    if (finalized_) {
        return true;
    }

    finalized_ = true;
    bool ok = true;
    if (sinkWriter_) {
        ok = succeeded(sinkWriter_->Finalize(), "SinkWriter::Finalize");
    }
    releaseSinkWriter();
    stagingTexture_.Reset();
    // Before MFShutdown(), not left to the destructor. Two of the objects
    // releaseDxgiPipeline() drops -- videoSampleAllocator_ and
    // dxgiDeviceManager_ -- are Media Foundation objects, and releasing those
    // after MFShutdown() has run is not something the platform promises
    // anything about. The rest matters to the caller rather than to MF:
    // captureDevice_/captureContext_ hold the WGC D3D11 device, so leaving them
    // set means session.stop() in main.cpp is no longer dropping the last
    // reference to the device it thinks it owns.
    releaseDxgiPipeline();
    captureContext_.Reset();
    captureDevice_.Reset();
    context_.Reset();
    device_.Reset();
    MFShutdown();
    return ok;
}
