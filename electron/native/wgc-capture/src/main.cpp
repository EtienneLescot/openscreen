#include "mf_encoder.h"
#include "monitor_utils.h"
#include "wasapi_loopback_capture.h"
#include "wgc_session.h"

#include <winrt/Windows.Foundation.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cctype>
#include <cstdint>
#include <iostream>
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

    if (config.sourceType != "display") {
        std::cerr << "ERROR: Native window capture is not implemented yet" << std::endl;
        return 1;
    }

    if (config.captureMic) {
        std::cerr << "ERROR: Microphone capture is not implemented in this helper yet" << std::endl;
        return 1;
    }

    if (config.webcamEnabled) {
        std::cerr << "ERROR: Native webcam capture is not implemented in this helper yet" << std::endl;
        return 1;
    }

    HMONITOR monitor = findMonitorForCapture(
        config.displayId,
        config.hasDisplayBounds ? &config.bounds : nullptr);
    if (!monitor) {
        std::cerr << "ERROR: Could not resolve monitor" << std::endl;
        return 1;
    }

    WgcSession session;
    if (!session.initialize(monitor, config.fps)) {
        std::cerr << "ERROR: Failed to initialize WGC session" << std::endl;
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

    WasapiLoopbackCapture loopbackCapture;
    const AudioInputFormat* audioFormat = nullptr;
    if (config.captureSystemAudio) {
        if (!loopbackCapture.initialize()) {
            std::cerr << "ERROR: Failed to initialize WASAPI loopback capture" << std::endl;
            return 1;
        }
        audioFormat = &loopbackCapture.inputFormat();
        std::cout << "{\"event\":\"audio-format\",\"schemaVersion\":2,\"sampleRate\":"
                  << audioFormat->sampleRate << ",\"channels\":" << audioFormat->channels
                  << ",\"bitsPerSample\":" << audioFormat->bitsPerSample << "}" << std::endl;
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

    session.setFrameCallback([&](ID3D11Texture2D* texture, int64_t timestampHns) {
        if (stopRequested) {
            return;
        }

        std::scoped_lock lock(mutex);
        if (!encoder.writeFrame(texture, timestampHns)) {
            encodeFailed = true;
            stopRequested = true;
            cv.notify_all();
            return;
        }
        if (!firstFrameWritten.exchange(true)) {
            cv.notify_all();
        }
    });

    if (config.captureSystemAudio) {
        if (!loopbackCapture.start([&](const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns) {
                if (stopRequested) {
                    return;
                }

                if (!encoder.writeAudio(data, byteCount, timestampHns, durationHns)) {
                    encodeFailed = true;
                    stopRequested = true;
                    cv.notify_all();
                }
            })) {
            std::cerr << "ERROR: Failed to start WASAPI loopback capture" << std::endl;
            return 1;
        }
    }

    if (!session.start()) {
        loopbackCapture.stop();
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
            loopbackCapture.stop();
            std::cerr << "ERROR: Timed out waiting for first WGC frame" << std::endl;
            return 1;
        }
    }

    std::cout << "{\"event\":\"recording-started\",\"schemaVersion\":2}" << std::endl;
    std::cout << "Recording started" << std::endl;

    {
        std::unique_lock lock(mutex);
        cv.wait(lock, [&] {
            return stopRequested.load();
        });
    }

    loopbackCapture.stop();
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
