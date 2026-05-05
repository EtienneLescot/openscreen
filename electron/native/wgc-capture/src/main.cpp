#include "audio_sample_utils.h"
#include "mf_encoder.h"
#include "monitor_utils.h"
#include "wasapi_loopback_capture.h"
#include "webcam_capture.h"
#include "wgc_session.h"

#include <winrt/Windows.Foundation.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cctype>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace {

struct CaptureConfig {
    int schemaVersion = 1;
    int64_t displayId = 0;
    int64_t recordingId = 0;
    std::string sourceType = "display";
    std::string sourceId;
    std::string windowHandle;
    std::string outputPath;
    int fps = 60;
    int width = 0;
    int height = 0;
    MonitorBounds bounds{};
    bool hasDisplayBounds = false;
    bool captureSystemAudio = false;
    bool captureMic = false;
    bool webcamEnabled = false;
    std::string microphoneDeviceId;
    double microphoneGain = 1.0;
    std::string webcamDeviceId;
    std::string webcamDeviceName;
    std::string webcamDirectShowClsid;
    int webcamWidth = 0;
    int webcamHeight = 0;
    int webcamFps = 0;
};

std::wstring utf8ToWide(const std::string& value) {
    if (value.empty()) {
        return {};
    }

    const int size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
    std::wstring result(static_cast<size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size);
    return result;
}

std::string wideToUtf8(const std::wstring& value) {
    if (value.empty()) {
        return {};
    }

    const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}

std::string jsonEscape(const std::string& value) {
    std::string result;
    result.reserve(value.size());
    for (const char c : value) {
        switch (c) {
            case '\\':
                result += "\\\\";
                break;
            case '"':
                result += "\\\"";
                break;
            case '\n':
                result += "\\n";
                break;
            case '\r':
                result += "\\r";
                break;
            case '\t':
                result += "\\t";
                break;
            default:
                result.push_back(c);
                break;
        }
    }
    return result;
}

bool hasVisibleBgraContent(const std::vector<BYTE>& frame) {
    if (frame.size() < 4) {
        return false;
    }

    uint64_t lumaTotal = 0;
    BYTE maxLuma = 0;
    const size_t pixelCount = frame.size() / 4;
    const size_t step = std::max<size_t>(1, pixelCount / 4096);
    size_t sampledPixels = 0;
    for (size_t pixel = 0; pixel < pixelCount; pixel += step) {
        const size_t offset = pixel * 4;
        const BYTE b = frame[offset + 0];
        const BYTE g = frame[offset + 1];
        const BYTE r = frame[offset + 2];
        const BYTE luma = static_cast<BYTE>((static_cast<uint16_t>(r) * 54 + static_cast<uint16_t>(g) * 183 + static_cast<uint16_t>(b) * 19) >> 8);
        lumaTotal += luma;
        maxLuma = std::max(maxLuma, luma);
        sampledPixels += 1;
    }

    const uint64_t averageLuma = sampledPixels > 0 ? lumaTotal / sampledPixels : 0;
    return maxLuma > 24 || averageLuma > 4;
}

bool findBool(const std::string& json, const std::string& key, bool fallback) {
    auto pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) {
        return fallback;
    }
    pos = json.find(':', pos);
    if (pos == std::string::npos) {
        return fallback;
    }
    pos += 1;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos += 1;
    }
    if (json.compare(pos, 4, "true") == 0) {
        return true;
    }
    if (json.compare(pos, 5, "false") == 0) {
        return false;
    }
    return fallback;
}

int64_t findInt64(const std::string& json, const std::string& key, int64_t fallback) {
    auto pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) {
        return fallback;
    }
    pos = json.find(':', pos);
    if (pos == std::string::npos) {
        return fallback;
    }
    pos += 1;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos += 1;
    }
    try {
        return std::stoll(json.substr(pos));
    } catch (...) {
        return fallback;
    }
}

int findInt(const std::string& json, const std::string& key, int fallback) {
    return static_cast<int>(findInt64(json, key, fallback));
}

double findDouble(const std::string& json, const std::string& key, double fallback) {
    auto pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) {
        return fallback;
    }
    pos = json.find(':', pos);
    if (pos == std::string::npos) {
        return fallback;
    }
    pos += 1;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos += 1;
    }
    try {
        return std::stod(json.substr(pos));
    } catch (...) {
        return fallback;
    }
}

std::string findString(const std::string& json, const std::string& key) {
    auto pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) {
        return {};
    }
    pos = json.find(':', pos);
    if (pos == std::string::npos) {
        return {};
    }
    pos += 1;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos += 1;
    }
    if (pos >= json.size() || json[pos] != '"') {
        return {};
    }
    pos += 1;

    std::string result;
    while (pos < json.size()) {
        const char c = json[pos++];
        if (c == '"') {
            break;
        }
        if (c == '\\' && pos < json.size()) {
            const char escaped = json[pos++];
            switch (escaped) {
                case '\\':
                case '"':
                case '/':
                    result.push_back(escaped);
                    break;
                case 'n':
                    result.push_back('\n');
                    break;
                case 'r':
                    result.push_back('\r');
                    break;
                case 't':
                    result.push_back('\t');
                    break;
                default:
                    result.push_back(escaped);
                    break;
            }
            continue;
        }
        result.push_back(c);
    }
    return result;
}

std::string parseWindowHandleFromSourceId(const std::string& sourceId) {
    constexpr char prefix[] = "window:";
    if (sourceId.rfind(prefix, 0) != 0) {
        return {};
    }

    const size_t start = sizeof(prefix) - 1;
    const size_t end = sourceId.find(':', start);
    const std::string handle = sourceId.substr(start, end == std::string::npos ? std::string::npos : end - start);
    return handle.empty() ? std::string{} : handle;
}

HWND parseWindowHandle(const std::string& value) {
    if (value.empty()) {
        return nullptr;
    }

    try {
        size_t parsed = 0;
        const int base = value.rfind("0x", 0) == 0 || value.rfind("0X", 0) == 0 ? 16 : 10;
        const uint64_t handleValue = std::stoull(value, &parsed, base);
        if (parsed != value.size() || handleValue == 0) {
            return nullptr;
        }
        return reinterpret_cast<HWND>(static_cast<uintptr_t>(handleValue));
    } catch (...) {
        return nullptr;
    }
}

bool parseConfig(const std::string& json, CaptureConfig& config) {
    config.schemaVersion = findInt(json, "schemaVersion", 1);
    config.outputPath = findString(json, "screenPath");
    if (config.outputPath.empty()) {
        config.outputPath = findString(json, "outputPath");
    }
    if (config.outputPath.empty()) {
        return false;
    }

    config.recordingId = findInt64(json, "recordingId", 0);
    config.sourceType = findString(json, "sourceType");
    if (config.sourceType.empty()) {
        config.sourceType = "display";
    }
    config.sourceId = findString(json, "sourceId");
    config.windowHandle = findString(json, "windowHandle");
    if (config.windowHandle.empty()) {
        config.windowHandle = parseWindowHandleFromSourceId(config.sourceId);
    }
    config.displayId = findInt64(json, "displayId", 0);
    config.fps = std::clamp(findInt(json, "fps", 60), 1, 120);
    config.width = findInt(json, "videoWidth", findInt(json, "width", 0));
    config.height = findInt(json, "videoHeight", findInt(json, "height", 0));
    config.bounds.x = findInt(json, "displayX", 0);
    config.bounds.y = findInt(json, "displayY", 0);
    config.bounds.width = findInt(json, "displayW", 0);
    config.bounds.height = findInt(json, "displayH", 0);
    config.hasDisplayBounds = findBool(json, "hasDisplayBounds", false);
    config.captureSystemAudio = findBool(json, "captureSystemAudio", false);
    config.captureMic = findBool(json, "captureMic", false);
    config.webcamEnabled = findBool(json, "webcamEnabled", false);
    config.microphoneDeviceId = findString(json, "microphoneDeviceId");
    config.microphoneGain = findDouble(json, "microphoneGain", 1.0);
    config.webcamDeviceId = findString(json, "webcamDeviceId");
    config.webcamDeviceName = findString(json, "webcamDeviceName");
    config.webcamDirectShowClsid = findString(json, "webcamDirectShowClsid");
    config.webcamWidth = findInt(json, "webcamWidth", 0);
    config.webcamHeight = findInt(json, "webcamHeight", 0);
    config.webcamFps = findInt(json, "webcamFps", 0);
    return true;
}

void readStopCommands(std::atomic<bool>& stopRequested, std::condition_variable& cv) {
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line == "stop" || line == "q" || line == "quit") {
            stopRequested = true;
            cv.notify_all();
            return;
        }
    }
    stopRequested = true;
    cv.notify_all();
}

} // namespace

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "ERROR: Missing JSON config argument" << std::endl;
        return 1;
    }

    winrt::init_apartment(winrt::apartment_type::multi_threaded);

    CaptureConfig config;
    if (!parseConfig(argv[1], config)) {
        std::cerr << "ERROR: Failed to parse config JSON" << std::endl;
        return 1;
    }

    std::cout << "{\"event\":\"ready\",\"schemaVersion\":2}" << std::endl;

    WgcSession session;
    if (config.sourceType == "display") {
        HMONITOR monitor = findMonitorForCapture(
            config.displayId,
            config.hasDisplayBounds ? &config.bounds : nullptr);
        if (!monitor) {
            std::cerr << "ERROR: Could not resolve monitor" << std::endl;
            return 1;
        }
        if (!session.initialize(monitor, config.fps)) {
            std::cerr << "ERROR: Failed to initialize WGC display session" << std::endl;
            return 1;
        }
    } else if (config.sourceType == "window") {
        HWND window = parseWindowHandle(config.windowHandle);
        if (!window || !IsWindow(window)) {
            std::cerr << "ERROR: Native window capture requires a valid HWND" << std::endl;
            return 1;
        }
        if (!session.initialize(window, config.fps)) {
            std::cerr << "ERROR: Failed to initialize WGC window session" << std::endl;
            return 1;
        }
    } else {
        std::cerr << "ERROR: Unsupported native capture source type: " << config.sourceType << std::endl;
        return 1;
    }

    // WGC owns the captured texture size. Encoding must use that exact size
    // until a dedicated GPU scaling pass is introduced; CopyResource requires
    // matching resource dimensions.
    int width = session.captureWidth();
    int height = session.captureHeight();
    width = (std::max(2, width) / 2) * 2;
    height = (std::max(2, height) / 2) * 2;

    const int pixels = width * height;
    const int bitrate = pixels >= 3840 * 2160 ? 45'000'000 : pixels >= 2560 * 1440 ? 28'000'000 : 18'000'000;

    WebcamCapture webcamCapture;
    bool webcamActive = false;
    if (config.webcamEnabled) {
        if (!webcamCapture.initialize(
                utf8ToWide(config.webcamDeviceId),
                utf8ToWide(config.webcamDeviceName),
                utf8ToWide(config.webcamDirectShowClsid),
                config.webcamWidth,
                config.webcamHeight,
                config.webcamFps > 0 ? config.webcamFps : config.fps)) {
            std::cerr << "ERROR: Failed to initialize native webcam capture" << std::endl;
            return 1;
        }
        std::cout << "{\"event\":\"webcam-format\",\"schemaVersion\":2,\"width\":" << webcamCapture.width()
                  << ",\"height\":" << webcamCapture.height()
                  << ",\"fps\":" << webcamCapture.fps()
                  << ",\"deviceName\":\"" << jsonEscape(wideToUtf8(webcamCapture.selectedDeviceName()))
                  << "\"}" << std::endl;
    }

    WasapiLoopbackCapture loopbackCapture;
    WasapiLoopbackCapture microphoneCapture;
    const AudioInputFormat* audioFormat = nullptr;
    if (config.captureSystemAudio) {
        if (!loopbackCapture.initializeSystemLoopback()) {
            std::cerr << "ERROR: Failed to initialize WASAPI loopback capture" << std::endl;
            return 1;
        }
        audioFormat = &loopbackCapture.inputFormat();
    }
    if (config.captureMic) {
        if (!microphoneCapture.initializeMicrophone(utf8ToWide(config.microphoneDeviceId))) {
            std::cerr << "ERROR: Failed to initialize WASAPI microphone capture" << std::endl;
            return 1;
        }
        if (!audioFormat) {
            audioFormat = &microphoneCapture.inputFormat();
        } else if (!sameAudioFormatForMixing(*audioFormat, microphoneCapture.inputFormat())) {
            std::cerr << "ERROR: System audio and microphone formats differ; native mixing is not supported yet"
                      << std::endl;
            return 1;
        }
    }
    if (audioFormat) {
        std::cout << "{\"event\":\"audio-format\",\"schemaVersion\":2,\"sampleRate\":" << audioFormat->sampleRate
                  << ",\"channels\":" << audioFormat->channels
                  << ",\"bitsPerSample\":" << audioFormat->bitsPerSample
                  << ",\"system\":" << (config.captureSystemAudio ? "true" : "false")
                  << ",\"microphone\":" << (config.captureMic ? "true" : "false") << "}" << std::endl;
    }

    MFEncoder encoder;
    if (!encoder.initialize(
            utf8ToWide(config.outputPath),
            width,
            height,
            config.fps,
            bitrate,
            session.device(),
            session.context(),
            audioFormat)) {
        std::cerr << "ERROR: Failed to initialize Media Foundation encoder" << std::endl;
        return 1;
    }

    std::mutex mutex;
    std::condition_variable cv;
    std::atomic<bool> stopRequested = false;
    std::atomic<bool> firstFrameWritten = false;
    std::atomic<bool> encodeFailed = false;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> latestFrameTexture;
    std::vector<BYTE> latestWebcamFrame;
    int latestWebcamWidth = 0;
    int latestWebcamHeight = 0;
    bool hasVisibleWebcamFrame = false;

    session.setFrameCallback([&](ID3D11Texture2D* texture, int64_t timestampHns) {
        (void)timestampHns;
        if (stopRequested) {
            return;
        }

        std::scoped_lock lock(mutex);
        if (!latestFrameTexture) {
            D3D11_TEXTURE2D_DESC desc{};
            texture->GetDesc(&desc);
            desc.BindFlags = 0;
            desc.CPUAccessFlags = 0;
            desc.MiscFlags = 0;
            if (FAILED(session.device()->CreateTexture2D(&desc, nullptr, &latestFrameTexture))) {
                encodeFailed = true;
                stopRequested = true;
                cv.notify_all();
                return;
            }
        }

        session.context()->CopyResource(latestFrameTexture.Get(), texture);
        if (!firstFrameWritten.exchange(true)) {
            cv.notify_all();
        }
    });

    auto writeVideoFrames = [&]() {
        const auto startedAt = std::chrono::steady_clock::now();
        uint64_t frameIndex = 0;

        while (!stopRequested && !encodeFailed) {
            {
                std::scoped_lock lock(mutex);
                if (webcamActive) {
                    std::vector<BYTE> candidateWebcamFrame;
                    int candidateWebcamWidth = 0;
                    int candidateWebcamHeight = 0;
                    if (webcamCapture.copyLatestFrame(candidateWebcamFrame, candidateWebcamWidth, candidateWebcamHeight) &&
                        hasVisibleBgraContent(candidateWebcamFrame)) {
                        latestWebcamFrame = std::move(candidateWebcamFrame);
                        latestWebcamWidth = candidateWebcamWidth;
                        latestWebcamHeight = candidateWebcamHeight;
                        hasVisibleWebcamFrame = true;
                    }
                }
                const BgraFrameView webcamFrame{
                    hasVisibleWebcamFrame && !latestWebcamFrame.empty() ? latestWebcamFrame.data() : nullptr,
                    latestWebcamWidth,
                    latestWebcamHeight,
                };
                if (latestFrameTexture && !encoder.writeFrame(
                        latestFrameTexture.Get(),
                        static_cast<int64_t>((frameIndex * 10'000'000ULL) / config.fps),
                        webcamFrame.data ? &webcamFrame : nullptr)) {
                    encodeFailed = true;
                    stopRequested = true;
                    cv.notify_all();
                    return;
                }
            }

            frameIndex += 1;
            const auto nextDeadline = startedAt +
                std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                    std::chrono::duration<double>(static_cast<double>(frameIndex) / config.fps));
            std::this_thread::sleep_until(nextDeadline);
        }
    };

    std::thread videoWriterThread;

    auto stopVideoWriter = [&]() {
        if (videoWriterThread.joinable()) {
            videoWriterThread.join();
        }
    };

    auto startVideoWriter = [&]() {
        videoWriterThread = std::thread(writeVideoFrames);
    };

    std::unique_ptr<AudioMixer> audioMixer;
    auto startAudioCaptures = [&]() -> bool {
        if (!audioFormat) {
            return true;
        }

        audioMixer = std::make_unique<AudioMixer>(
            *audioFormat,
            config.captureSystemAudio,
            config.captureMic,
            config.microphoneGain,
            [&](const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns) {
                if (!encoder.writeAudio(data, byteCount, timestampHns, durationHns)) {
                    encodeFailed = true;
                    stopRequested = true;
                    cv.notify_all();
                    return false;
                }
                return true;
            });

        if (!audioMixer->start()) {
            std::cerr << "ERROR: Failed to start native audio mixer" << std::endl;
            return false;
        }

        if (config.captureMic) {
            if (!microphoneCapture.start([&](const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns) {
                    (void)timestampHns;
                    (void)durationHns;
                    if (stopRequested || !audioMixer) {
                        return;
                    }

                    audioMixer->pushMicrophone(data, byteCount);
                })) {
                std::cerr << "ERROR: Failed to start WASAPI microphone capture" << std::endl;
                audioMixer->stop();
                return false;
            }
        }

        if (config.captureSystemAudio) {
            if (!loopbackCapture.start([&](const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns) {
                    (void)timestampHns;
                    (void)durationHns;
                    if (stopRequested || !audioMixer) {
                        return;
                    }

                    audioMixer->pushSystem(data, byteCount);
                })) {
                std::cerr << "ERROR: Failed to start WASAPI loopback capture" << std::endl;
                microphoneCapture.stop();
                audioMixer->stop();
                return false;
            }
        }

        return true;
    };

    if (!startAudioCaptures()) {
        return 1;
    }
    if (config.webcamEnabled) {
        if (!webcamCapture.start()) {
            microphoneCapture.stop();
            loopbackCapture.stop();
            if (audioMixer) {
                audioMixer->stop();
            }
            std::cerr << "ERROR: Failed to start native webcam capture" << std::endl;
            return 1;
        }
        webcamActive = true;
        const auto webcamDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
        while (std::chrono::steady_clock::now() < webcamDeadline && !hasVisibleWebcamFrame) {
            std::vector<BYTE> candidateWebcamFrame;
            int candidateWebcamWidth = 0;
            int candidateWebcamHeight = 0;
            if (webcamCapture.copyLatestFrame(candidateWebcamFrame, candidateWebcamWidth, candidateWebcamHeight) &&
                hasVisibleBgraContent(candidateWebcamFrame)) {
                latestWebcamFrame = std::move(candidateWebcamFrame);
                latestWebcamWidth = candidateWebcamWidth;
                latestWebcamHeight = candidateWebcamHeight;
                hasVisibleWebcamFrame = true;
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        if (!hasVisibleWebcamFrame) {
            std::cerr << "WARNING: Native webcam started but no visible frame was available before screen capture"
                      << std::endl;
        }
    }

    if (!session.start()) {
        webcamCapture.stop();
        microphoneCapture.stop();
        loopbackCapture.stop();
        if (audioMixer) {
            audioMixer->stop();
        }
        std::cerr << "ERROR: Failed to start WGC session" << std::endl;
        return 1;
    }

    std::thread stdinThread(readStopCommands, std::ref(stopRequested), std::ref(cv));

    {
        std::unique_lock lock(mutex);
        const bool started = cv.wait_for(lock, std::chrono::seconds(10), [&] {
            return firstFrameWritten.load() || stopRequested.load();
        });
        if (!started || !firstFrameWritten) {
            stopRequested = true;
            cv.notify_all();
            if (stdinThread.joinable()) {
                stdinThread.detach();
            }
            microphoneCapture.stop();
            loopbackCapture.stop();
            webcamCapture.stop();
            if (audioMixer) {
                audioMixer->stop();
            }
            session.stop();
            std::cerr << "ERROR: Timed out waiting for first WGC frame" << std::endl;
            return 1;
        }
    }

    if (audioMixer) {
        audioMixer->beginTimeline();
    }
    startVideoWriter();

    std::cout << "{\"event\":\"recording-started\",\"schemaVersion\":2}" << std::endl;
    std::cout << "Recording started" << std::endl;

    {
        std::unique_lock lock(mutex);
        cv.wait(lock, [&] {
            return stopRequested.load();
        });
    }

    microphoneCapture.stop();
    loopbackCapture.stop();
    webcamCapture.stop();
    if (audioMixer) {
        audioMixer->stop();
    }
    stopVideoWriter();
    session.stop();
    {
        std::scoped_lock lock(mutex);
        encoder.finalize();
    }

    if (stdinThread.joinable()) {
        stdinThread.join();
    }

    if (encodeFailed) {
        std::cerr << "ERROR: Failed to encode WGC frame" << std::endl;
        return 1;
    }

    std::cout << "{\"event\":\"recording-stopped\",\"schemaVersion\":2,\"screenPath\":\""
              << jsonEscape(config.outputPath) << "\"}" << std::endl;
    std::cout << "Recording stopped. Output path: " << config.outputPath << std::endl;
    return 0;
}
