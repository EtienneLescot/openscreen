#include "audio_sample_utils.h"

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <cstdint>
#include <iostream>
#include <string>
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
    const std::wstring path = tempMp4Path();
    DeleteFileW(path.c_str());

    Microsoft::WRL::ComPtr<IMFSinkWriter> writer;
    HRESULT hr = MFCreateSinkWriterFromURL(path.c_str(), nullptr, attributes, &writer);
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
        DeleteFileW(path.c_str());
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> inputType;
    hr = MFCreateMediaType(&inputType);
    if (FAILED(hr)) {
        DeleteFileW(path.c_str());
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
    DeleteFileW(path.c_str());
    return hr;
}

// Same rates as trySetAacPcmRate, but with an H.264 stream first — the helper's
// topology. Distinguishes "96 kHz AAC is illegal" from "audio-only MP4 sink
// writer refuses this type".
HRESULT trySetAacPcmRateWithVideo(UINT32 sampleRate) {
    const std::wstring path = tempMp4Path();
    DeleteFileW(path.c_str());

    Microsoft::WRL::ComPtr<IMFSinkWriter> writer;
    HRESULT hr = MFCreateSinkWriterFromURL(path.c_str(), nullptr, nullptr, &writer);
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
        DeleteFileW(path.c_str());
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> audioOut;
    hr = MFCreateMediaType(&audioOut);
    if (FAILED(hr)) {
        DeleteFileW(path.c_str());
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
        DeleteFileW(path.c_str());
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> videoIn;
    hr = MFCreateMediaType(&videoIn);
    if (FAILED(hr)) {
        DeleteFileW(path.c_str());
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
        DeleteFileW(path.c_str());
        return hr;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> audioIn;
    hr = MFCreateMediaType(&audioIn);
    if (FAILED(hr)) {
        DeleteFileW(path.c_str());
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
    DeleteFileW(path.c_str());
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

    HRESULT mfHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(mfHr) && mfHr != RPC_E_CHANGED_MODE) {
        expect("mf-startup", false, "CoInitializeEx failed");
    } else {
        mfHr = MFStartup(MF_VERSION);
        expect("mf-startup", SUCCEEDED(mfHr), "MFStartup hr=" + std::to_string(static_cast<long>(mfHr)));
        if (SUCCEEDED(mfHr)) {
            const HRESULT rejectHr = trySetAacPcmRate(96000);
            char rejectHex[16]{};
            sprintf_s(rejectHex, "0x%08lx", static_cast<unsigned long>(rejectHr));
            std::cout << "MF_RAW mf-reject-96000 hr=" << rejectHex << "\n";
            expect(
                "mf-reject-96000",
                FAILED(rejectHr) && static_cast<unsigned long>(rejectHr) == 0xc00d36b4ul,
                std::string("want 0xc00d36b4 got ") + rejectHex);
            const HRESULT acceptHr = trySetAacPcmRate(48000);
            char acceptHex[16]{};
            sprintf_s(acceptHex, "0x%08lx", static_cast<unsigned long>(acceptHr));
            std::cout << "MF_RAW mf-accept-48000 hr=" << acceptHex << "\n";
            expect("mf-accept-48000", SUCCEEDED(acceptHr), std::string("hr=") + acceptHex);

            const HRESULT rejectAvHr = trySetAacPcmRateWithVideo(96000);
            char rejectAvHex[16]{};
            sprintf_s(rejectAvHex, "0x%08lx", static_cast<unsigned long>(rejectAvHr));
            std::cout << "MF_RAW mf-reject-96000-with-video hr=" << rejectAvHex << "\n";
            expect(
                "mf-reject-96000-with-video",
                FAILED(rejectAvHr),
                std::string("want fail got ") + rejectAvHex);
            const HRESULT acceptAvHr = trySetAacPcmRateWithVideo(48000);
            char acceptAvHex[16]{};
            sprintf_s(acceptAvHex, "0x%08lx", static_cast<unsigned long>(acceptAvHr));
            std::cout << "MF_RAW mf-accept-48000-with-video hr=" << acceptAvHex << "\n";
            expect(
                "mf-accept-48000-with-video",
                SUCCEEDED(acceptAvHr),
                std::string("hr=") + acceptAvHex);

            Microsoft::WRL::ComPtr<IMFAttributes> swAttr;
            const HRESULT attrHr = MFCreateAttributes(&swAttr, 1);
            if (FAILED(attrHr)) {
                expect("mf-reject-96000-sw-attr", false, "MFCreateAttributes failed");
            } else {
                swAttr->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, FALSE);
                const HRESULT rejectSwHr = trySetAacPcmRate(96000, swAttr.Get());
                char rejectSwHex[16]{};
                sprintf_s(rejectSwHex, "0x%08lx", static_cast<unsigned long>(rejectSwHr));
                std::cout << "MF_RAW mf-reject-96000-sw-attr hr=" << rejectSwHex << "\n";
                expect(
                    "mf-reject-96000-sw-attr",
                    FAILED(rejectSwHr),
                    std::string("want fail got ") + rejectSwHex);
                const HRESULT acceptSwHr = trySetAacPcmRate(48000, swAttr.Get());
                char acceptSwHex[16]{};
                sprintf_s(acceptSwHex, "0x%08lx", static_cast<unsigned long>(acceptSwHr));
                std::cout << "MF_RAW mf-accept-48000-sw-attr hr=" << acceptSwHex << "\n";
                expect(
                    "mf-accept-48000-sw-attr",
                    SUCCEEDED(acceptSwHr),
                    std::string("hr=") + acceptSwHex);
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
