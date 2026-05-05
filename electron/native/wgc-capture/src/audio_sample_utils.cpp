#include "audio_sample_utils.h"

#include <mfapi.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

namespace {

bool isFloatFormat(const AudioInputFormat& format) {
    return format.subtype == MFAudioFormat_Float && format.bitsPerSample == 32;
}

bool isPcmFormat(const AudioInputFormat& format, UINT32 bitsPerSample) {
    return format.subtype == MFAudioFormat_PCM && format.bitsPerSample == bitsPerSample;
}

template <typename T>
T clampTo(double value) {
    const double minValue = static_cast<double>(std::numeric_limits<T>::min());
    const double maxValue = static_cast<double>(std::numeric_limits<T>::max());
    return static_cast<T>(std::clamp(std::round(value), minValue, maxValue));
}

} // namespace

bool sameAudioFormatForMixing(const AudioInputFormat& left, const AudioInputFormat& right) {
    return left.subtype == right.subtype &&
           left.sampleRate == right.sampleRate &&
           left.channels == right.channels &&
           left.bitsPerSample == right.bitsPerSample &&
           left.blockAlign == right.blockAlign &&
           left.avgBytesPerSec == right.avgBytesPerSec;
}

void copyAudioWithGain(
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& format,
    double gain,
    std::vector<BYTE>& destination) {
    destination.resize(byteCount);
    if (!source || byteCount == 0) {
        return;
    }

    if (std::abs(gain - 1.0) < 0.0001) {
        std::memcpy(destination.data(), source, byteCount);
        return;
    }

    if (isFloatFormat(format)) {
        const auto* input = reinterpret_cast<const float*>(source);
        auto* output = reinterpret_cast<float*>(destination.data());
        const size_t sampleCount = byteCount / sizeof(float);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = static_cast<float>(std::clamp(input[index] * gain, -1.0, 1.0));
        }
        return;
    }

    if (isPcmFormat(format, 16)) {
        const auto* input = reinterpret_cast<const int16_t*>(source);
        auto* output = reinterpret_cast<int16_t*>(destination.data());
        const size_t sampleCount = byteCount / sizeof(int16_t);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = clampTo<int16_t>(static_cast<double>(input[index]) * gain);
        }
        return;
    }

    if (isPcmFormat(format, 32)) {
        const auto* input = reinterpret_cast<const int32_t*>(source);
        auto* output = reinterpret_cast<int32_t*>(destination.data());
        const size_t sampleCount = byteCount / sizeof(int32_t);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = clampTo<int32_t>(static_cast<double>(input[index]) * gain);
        }
        return;
    }

    std::memcpy(destination.data(), source, byteCount);
}

void mixAudioInPlace(
    std::vector<BYTE>& destination,
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& format) {
    if (!source || byteCount == 0 || destination.empty()) {
        return;
    }

    const size_t mixByteCount = std::min(destination.size(), static_cast<size_t>(byteCount));

    if (isFloatFormat(format)) {
        auto* output = reinterpret_cast<float*>(destination.data());
        const auto* input = reinterpret_cast<const float*>(source);
        const size_t sampleCount = mixByteCount / sizeof(float);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = static_cast<float>(std::clamp(output[index] + input[index], -1.0f, 1.0f));
        }
        return;
    }

    if (isPcmFormat(format, 16)) {
        auto* output = reinterpret_cast<int16_t*>(destination.data());
        const auto* input = reinterpret_cast<const int16_t*>(source);
        const size_t sampleCount = mixByteCount / sizeof(int16_t);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = clampTo<int16_t>(
                static_cast<double>(output[index]) + static_cast<double>(input[index]));
        }
        return;
    }

    if (isPcmFormat(format, 32)) {
        auto* output = reinterpret_cast<int32_t*>(destination.data());
        const auto* input = reinterpret_cast<const int32_t*>(source);
        const size_t sampleCount = mixByteCount / sizeof(int32_t);
        for (size_t index = 0; index < sampleCount; index += 1) {
            output[index] = clampTo<int32_t>(
                static_cast<double>(output[index]) + static_cast<double>(input[index]));
        }
    }
}
