#include "audio_sample_utils.h"

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

namespace {

int g_ran = 0;
int g_failed = 0;

AudioInputFormat makeFormat(
    GUID subtype,
    UINT32 sampleRate,
    UINT32 channels,
    UINT32 bitsPerSample) {
    AudioInputFormat format{};
    format.subtype = subtype;
    format.sampleRate = sampleRate;
    format.channels = channels;
    format.bitsPerSample = bitsPerSample;
    format.blockAlign = channels * (bitsPerSample / 8);
    format.avgBytesPerSec = sampleRate * format.blockAlign;
    return format;
}

void expect(const char* name, bool ok, const std::string& detail) {
    g_ran += 1;
    if (ok) {
        std::cout << "PASS " << name << "\n";
        return;
    }
    g_failed += 1;
    std::cout << "FAIL " << name << " " << detail << "\n";
}

void skip(const char* name, const std::string& reason) {
    std::cout << "SKIP " << name << " " << reason << "\n";
}

struct TempMp4 {
    std::wstring path;
    explicit TempMp4(std::wstring p) : path(std::move(p)) {
        DeleteFileW(path.c_str());
    }
    ~TempMp4() {
        DeleteFileW(path.c_str());
    }
    TempMp4(const TempMp4&) = delete;
    TempMp4& operator=(const TempMp4&) = delete;
};

std::string describe(const AudioInputFormat& format) {
    return "sampleRate=" + std::to_string(format.sampleRate) +
        " channels=" + std::to_string(format.channels) +
        " bits=" + std::to_string(format.bitsPerSample);
}

std::wstring tempMp4Path() {
    wchar_t dir[MAX_PATH]{};
    GetTempPathW(MAX_PATH, dir);
    return std::wstring(dir) + L"openscreen-mf-aac-probe-" +
        std::to_wstring(GetCurrentProcessId()) + L".mp4";
}

HRESULT trySetAacPcmRate(UINT32 sampleRate, IMFAttributes* attributes = nullptr) {
    TempMp4 tmp(tempMp4Path());

    Microsoft::WRL::ComPtr<IMFSinkWriter> writer;
    HRESULT hr = MFCreateSinkWriterFromURL(tmp.path.c_str(), nullptr, attributes, &writer);
    if (FAILED(hr)) {
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> outputType;
    hr = MFCreateMediaType(&outputType);
    if (FAILED(hr)) {
        return hr;
    }
    outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    outputType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
    outputType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
    outputType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sampleRate);
    outputType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    outputType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24000);
    outputType->SetUINT32(MF_MT_AAC_PAYLOAD_TYPE, 0);

    DWORD streamIndex = 0;
    hr = writer->AddStream(outputType.Get(), &streamIndex);
    if (FAILED(hr)) {
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> inputType;
    hr = MFCreateMediaType(&inputType);
    if (FAILED(hr)) {
        return hr;
    }
    inputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    inputType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
    inputType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
    inputType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sampleRate);
    inputType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    inputType->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, 4);
    inputType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, sampleRate * 4);
    inputType->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);

    hr = writer->SetInputMediaType(streamIndex, inputType.Get(), nullptr);
    writer.Reset();
    return hr;
}

// Same rates as trySetAacPcmRate, but with an H.264 stream first — the helper's
// topology. Distinguishes "96 kHz AAC is illegal" from "audio-only MP4 sink
// writer refuses this type".
HRESULT trySetAacPcmRateWithVideo(UINT32 sampleRate) {
    TempMp4 tmp(tempMp4Path());

    Microsoft::WRL::ComPtr<IMFSinkWriter> writer;
    HRESULT hr = MFCreateSinkWriterFromURL(tmp.path.c_str(), nullptr, nullptr, &writer);
    if (FAILED(hr)) {
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> videoOut;
    hr = MFCreateMediaType(&videoOut);
    if (FAILED(hr)) {
        return hr;
    }
    videoOut->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    videoOut->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    videoOut->SetUINT32(MF_MT_AVG_BITRATE, 1'000'000);
    videoOut->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    MFSetAttributeSize(videoOut.Get(), MF_MT_FRAME_SIZE, 320, 240);
    MFSetAttributeRatio(videoOut.Get(), MF_MT_FRAME_RATE, 30, 1);
    MFSetAttributeRatio(videoOut.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);

    DWORD videoIndex = 0;
    hr = writer->AddStream(videoOut.Get(), &videoIndex);
    if (FAILED(hr)) {
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> audioOut;
    hr = MFCreateMediaType(&audioOut);
    if (FAILED(hr)) {
        return hr;
    }
    audioOut->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    audioOut->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
    audioOut->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
    audioOut->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sampleRate);
    audioOut->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    audioOut->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24000);
    audioOut->SetUINT32(MF_MT_AAC_PAYLOAD_TYPE, 0);

    DWORD audioIndex = 0;
    hr = writer->AddStream(audioOut.Get(), &audioIndex);
    if (FAILED(hr)) {
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> videoIn;
    hr = MFCreateMediaType(&videoIn);
    if (FAILED(hr)) {
        return hr;
    }
    videoIn->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    videoIn->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    videoIn->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    videoIn->SetUINT32(MF_MT_DEFAULT_STRIDE, 320 * 4);
    MFSetAttributeSize(videoIn.Get(), MF_MT_FRAME_SIZE, 320, 240);
    MFSetAttributeRatio(videoIn.Get(), MF_MT_FRAME_RATE, 30, 1);
    MFSetAttributeRatio(videoIn.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    hr = writer->SetInputMediaType(videoIndex, videoIn.Get(), nullptr);
    if (FAILED(hr)) {
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> audioIn;
    hr = MFCreateMediaType(&audioIn);
    if (FAILED(hr)) {
        return hr;
    }
    audioIn->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    audioIn->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
    audioIn->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
    audioIn->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sampleRate);
    audioIn->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    audioIn->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, 4);
    audioIn->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, sampleRate * 4);
    audioIn->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
    hr = writer->SetInputMediaType(audioIndex, audioIn.Get(), nullptr);
    writer.Reset();
    return hr;
}

} // namespace

int main() {
    const AudioInputFormat diagnostic = makeFormat(MFAudioFormat_Float, 96000, 8, 32);
    const AudioInputFormat snapped = makeAacCompatibleAudioFormat(diagnostic);
    expect(
        "diag-96000-8ch",
        snapped.sampleRate == 48000 && snapped.channels == 2 && snapped.bitsPerSample == 16 &&
            snapped.subtype == MFAudioFormat_PCM,
        describe(snapped));

    const AudioInputFormat keep48000 =
        makeAacCompatibleAudioFormat(makeFormat(MFAudioFormat_PCM, 48000, 2, 16));
    expect("keep-48000", keep48000.sampleRate == 48000, describe(keep48000));

    const AudioInputFormat keep44100 =
        makeAacCompatibleAudioFormat(makeFormat(MFAudioFormat_PCM, 44100, 2, 16));
    expect("keep-44100", keep44100.sampleRate == 44100, describe(keep44100));

    const AudioInputFormat zeroRate =
        makeAacCompatibleAudioFormat(makeFormat(MFAudioFormat_PCM, 0, 2, 16));
    expect("zero-rate", zeroRate.sampleRate == 48000, describe(zeroRate));

    const AudioInputFormat keep32000 =
        makeAacCompatibleAudioFormat(makeFormat(MFAudioFormat_PCM, 32000, 2, 16));
    expect("keep-32000", keep32000.sampleRate == 32000, describe(keep32000));

    const AudioInputFormat source96k = makeFormat(MFAudioFormat_PCM, 96000, 2, 16);
    const AudioInputFormat target48k = makeAacCompatibleAudioFormat(source96k);
    const UINT32 sourceFrames = 96000;
    std::vector<BYTE> source(static_cast<size_t>(sourceFrames) * source96k.blockAlign, 0);
    auto* samples = reinterpret_cast<int16_t*>(source.data());
    for (UINT32 frame = 0; frame < sourceFrames; frame += 1) {
        samples[frame * 2] = static_cast<int16_t>(frame % 32767);
        samples[frame * 2 + 1] = static_cast<int16_t>((frame * 3) % 32767);
    }
    std::vector<BYTE> converted;
    convertAudioWithGain(
        source.data(),
        static_cast<DWORD>(source.size()),
        source96k,
        target48k,
        1.0,
        converted);
    const size_t convertedFrames =
        target48k.blockAlign == 0 ? 0 : converted.size() / target48k.blockAlign;
    const bool frameCountOk =
        convertedFrames == 48000 || convertedFrames == 47999 || convertedFrames == 48001;
    expect(
        "resample-frame-count",
        target48k.sampleRate == 48000 && frameCountOk,
        "frames=" + std::to_string(convertedFrames) + " " + describe(target48k));

    // 96 kHz Nyquist square (+/- full scale) must not survive 2:1 as a tone.
    std::vector<BYTE> nyquist(8 * source96k.blockAlign, 0);
    auto* nyquistSamples = reinterpret_cast<int16_t*>(nyquist.data());
    for (size_t frame = 0; frame < 8; frame += 1) {
        const int16_t v = (frame % 2 == 0) ? 32767 : -32767;
        nyquistSamples[frame * 2] = v;
        nyquistSamples[frame * 2 + 1] = v;
    }
    std::vector<BYTE> nyquistOut;
    convertAudioWithGain(nyquist.data(), static_cast<DWORD>(nyquist.size()), source96k, target48k, 1.0, nyquistOut);
    const auto* down = reinterpret_cast<const int16_t*>(nyquistOut.data());
    const size_t downFrames = nyquistOut.size() / target48k.blockAlign;
    bool folded = downFrames == 4;
    for (size_t i = 0; folded && i < downFrames * 2; i += 1) {
        folded = std::abs(static_cast<int>(down[i])) <= 1;
    }
    expect("resample-96k-nyquist-box", folded, "frames=" + std::to_string(downFrames));

    HRESULT mfHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(mfHr) && mfHr != RPC_E_CHANGED_MODE) {
        skip("mf-startup", "CoInitializeEx failed — no Media Foundation on this host");
    } else {
        mfHr = MFStartup(MF_VERSION);
        if (FAILED(mfHr)) {
            skip("mf-startup", "MFStartup hr=" + std::to_string(static_cast<long>(mfHr)));
        } else {
            expect("mf-startup", true, "");
            const auto runReject = [](const char* name, HRESULT hr) {
                char hex[16]{};
                sprintf_s(hex, "0x%08lx", static_cast<unsigned long>(hr));
                std::cout << "MF_RAW " << name << " hr=" << hex << "\n";
                if (FAILED(hr) && static_cast<unsigned long>(hr) == 0xc00d36b4ul) {
                    expect(name, true, "");
                } else if (SUCCEEDED(hr)) {
                    skip(name, "host AAC accepts 96 kHz");
                } else {
                    skip(name, std::string("host cannot probe this rate hr=") + hex);
                }
            };
            const auto runAccept = [](const char* name, HRESULT hr) {
                char hex[16]{};
                sprintf_s(hex, "0x%08lx", static_cast<unsigned long>(hr));
                std::cout << "MF_RAW " << name << " hr=" << hex << "\n";
                if (SUCCEEDED(hr)) {
                    expect(name, true, "");
                    return true;
                }
                skip(name, std::string("host has no AAC encoder hr=") + hex);
                return false;
            };
            runReject("mf-reject-96000", trySetAacPcmRate(96000));
            if (runAccept("mf-accept-48000", trySetAacPcmRate(48000))) {
                runReject("mf-reject-96000-with-video", trySetAacPcmRateWithVideo(96000));
                runAccept("mf-accept-48000-with-video", trySetAacPcmRateWithVideo(48000));
                Microsoft::WRL::ComPtr<IMFAttributes> swAttr;
                if (FAILED(MFCreateAttributes(&swAttr, 1))) {
                    skip("mf-reject-96000-sw-attr", "MFCreateAttributes failed");
                } else {
                    swAttr->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, FALSE);
                    runReject("mf-reject-96000-sw-attr", trySetAacPcmRate(96000, swAttr.Get()));
                    runAccept("mf-accept-48000-sw-attr", trySetAacPcmRate(48000, swAttr.Get()));
                }
            }
            MFShutdown();
        }
    }

    std::cout << "ran " << g_ran << " tests\n";
    if (g_failed != 0) {
        std::cout << g_failed << " failed\n";
        return 1;
    }
    return 0;
}
