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
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <ratio>
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
    std::string webcamOutputPath;
    int fps = 60;
    int width = 0;
    int height = 0;
    MonitorBounds bounds{};
    bool hasDisplayBounds = false;
    bool captureSystemAudio = false;
    bool captureMic = false;
    bool captureCursor = false;
    bool webcamEnabled = false;
    bool preferSoftwareEncoder = false;
    std::string microphoneDeviceId;
    std::string microphoneDeviceName;
    double microphoneGain = 1.0;
    std::string webcamDeviceId;
    std::string webcamDeviceName;
    std::string webcamDirectShowClsid;
    int webcamWidth = 0;
    int webcamHeight = 0;
    int webcamFps = 0;
};

struct CaptureControl {
    std::atomic<bool> stopRequested = false;
    std::atomic<bool> paused = false;
    std::mutex mutex;
    std::condition_variable cv;
    // Stop is signalled on its own mutex/CV pair, deliberately not on `mutex`
    // (the frame-state lock in main) and not on this struct's `mutex` either.
    //
    // The frame lock is held across GPU work that cannot be interrupted: the
    // WGC frame callback's CopyResource, and the video writer's staging-texture
    // Map/readback. Waiting for a stop behind it made shutdown depend on the
    // capture pipeline still being healthy -- and a `condition_variable` has to
    // re-acquire its mutex before `wait` can return, so one wedged driver call
    // left the main thread parked forever without emitting a single
    // [stop-timing] line (issue #252). Nothing on this pair touches either
    // frame lock, so a stop is always observed no matter what the GPU is doing.
    //
    // Threads that already hold the frame lock do call requestStop(), so the
    // lock order is frame mutex -> stopMutex. Nothing ever takes them the other
    // way round.
    std::mutex stopMutex;
    std::condition_variable stopCv;
    std::chrono::steady_clock::time_point pauseStartedAt;
    std::chrono::steady_clock::duration totalPausedDuration{};
    // Shared T0 for every stream's timeline (screen video, audio, webcam).
    // Set once, right before the video writer thread starts, so all streams
    // measure elapsed time from the same real-world instant.
    std::chrono::steady_clock::time_point recordingStartedAt;

    int64_t pausedDurationHns() {
        std::scoped_lock lock(mutex);
        auto total = totalPausedDuration;
        if (paused.load()) {
            total += std::chrono::steady_clock::now() - pauseStartedAt;
        }
        return std::chrono::duration_cast<std::chrono::nanoseconds>(total).count() / 100;
    }

    void setPaused(bool nextPaused) {
        std::scoped_lock lock(mutex);
        if (nextPaused == paused.load()) {
            return;
        }
        if (nextPaused) {
            pauseStartedAt = std::chrono::steady_clock::now();
        } else {
            totalPausedDuration += std::chrono::steady_clock::now() - pauseStartedAt;
        }
        paused = nextPaused;
    }

    // The single way to ask for a stop. Every caller goes through here so that
    // a future one cannot forget half of the handshake.
    void requestStop() {
        {
            std::scoped_lock lock(stopMutex);
            stopRequested = true;
        }
        // Publishing the flag under `stopMutex` before notifying is what makes
        // waitForStop() immune to a wakeup landing between its predicate check
        // and its enqueue on the CV.
        stopCv.notify_all();
        // The frame pipeline parks on `cv`; wake it too so the video writer
        // notices on this pass instead of after its next 100 ms timeout.
        cv.notify_all();
    }

    void waitForStop() {
        std::unique_lock lock(stopMutex);
        // Bounded even though requestStop() publishes under `stopMutex`. This
        // is the one wait in the helper that must never be able to hang, and
        // re-reading an atomic every 200 ms costs nothing to guarantee it.
        while (!stopRequested.load()) {
            stopCv.wait_for(lock, std::chrono::milliseconds(200));
        }
    }
};

int readEnvInt(const char* name, int fallback) {
    char raw[32]{};
    const DWORD length = GetEnvironmentVariableA(name, raw, static_cast<DWORD>(sizeof(raw)));
    if (length == 0 || length >= sizeof(raw)) {
        return fallback;
    }

    try {
        return std::stoi(raw);
    } catch (...) {
        return fallback;
    }
}

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
    config.captureCursor = findBool(json, "captureCursor", false);
    config.webcamEnabled = findBool(json, "webcamEnabled", false);
    config.preferSoftwareEncoder = findBool(json, "preferSoftwareEncoder", false);
    config.microphoneDeviceId = findString(json, "microphoneDeviceId");
    config.microphoneDeviceName = findString(json, "microphoneDeviceName");
    config.microphoneGain = findDouble(json, "microphoneGain", 1.0);
    config.webcamDeviceId = findString(json, "webcamDeviceId");
    config.webcamDeviceName = findString(json, "webcamDeviceName");
    config.webcamDirectShowClsid = findString(json, "webcamDirectShowClsid");
    config.webcamOutputPath = findString(json, "webcamPath");
    config.webcamWidth = findInt(json, "webcamWidth", 0);
    config.webcamHeight = findInt(json, "webcamHeight", 0);
    config.webcamFps = findInt(json, "webcamFps", 0);
    return true;
}

void readCaptureCommands(CaptureControl& control, const std::function<void(bool)>& onPauseChanged) {
    std::string line;
    while (std::getline(std::cin, line)) {
        // The comparisons below are exact, so a stray carriage return would
        // drop the command in total silence -- the one command this helper
        // must never fail to act on.
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) {
            line.pop_back();
        }
        if (line == "stop" || line == "q" || line == "quit") {
            // Acknowledged before anything else runs. Issue #252 was reported
            // with no way to tell "the helper never saw the stop" apart from
            // "the helper saw it and then wedged"; this line settles that in
            // every future report.
            std::cerr << "[stop-timing] step=command-received elapsed_ms=0" << std::endl;
            control.requestStop();
            return;
        }
        if (line == "pause") {
            control.setPaused(true);
            onPauseChanged(true);
            std::cout << "{\"event\":\"recording-paused\",\"schemaVersion\":2}" << std::endl;
            control.cv.notify_all();
            continue;
        }
        if (line == "resume") {
            control.setPaused(false);
            onPauseChanged(false);
            std::cout << "{\"event\":\"recording-resumed\",\"schemaVersion\":2}" << std::endl;
            control.cv.notify_all();
            continue;
        }
    }
    // stdin closed: the parent is gone or ended the channel, which is also a
    // stop. Electron relies on this as a backstop for a dropped `stop` write.
    std::cerr << "[stop-timing] step=stdin-eof elapsed_ms=0" << std::endl;
    control.requestStop();
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

    char injectDefaultSinkWriterFailure[2]{};
    const DWORD injectDefaultSinkWriterFailureLength = GetEnvironmentVariableA(
        "OPENSCREEN_WGC_TEST_INJECT_DEFAULT_SINK_WRITER_FAILURE_ONCE",
        injectDefaultSinkWriterFailure,
        static_cast<DWORD>(sizeof(injectDefaultSinkWriterFailure)));
    const bool injectDefaultSinkWriterFailureOnce =
        injectDefaultSinkWriterFailureLength == 1 &&
        injectDefaultSinkWriterFailure[0] == '1';

    // Test-only: stall the video writer inside the frame lock the way a wedged
    // GPU readback does. Issue #252 only reproduced on one multi-adapter machine
    // with virtual display drivers; this makes the same failure reachable on
    // ordinary hardware, so the stop path can be regression-tested at all.
    const int testStallReadbackMs =
        std::max(0, readEnvInt("OPENSCREEN_WGC_TEST_STALL_READBACK_MS", 0));

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
        if (!session.initialize(monitor, config.fps, config.captureCursor)) {
            std::cerr << "ERROR: Failed to initialize WGC display session" << std::endl;
            return 1;
        }
    } else if (config.sourceType == "window") {
        HWND window = parseWindowHandle(config.windowHandle);
        if (!window || !IsWindow(window)) {
            std::cerr << "ERROR: Native window capture requires a valid HWND" << std::endl;
            return 1;
        }
        if (!session.initialize(window, config.fps, config.captureCursor)) {
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
    bool writeSeparateWebcam = false;
    if (config.webcamEnabled) {
        if (!webcamCapture.initialize(
                utf8ToWide(config.webcamDeviceId),
                utf8ToWide(config.webcamDeviceName),
                utf8ToWide(config.webcamDirectShowClsid),
                config.webcamWidth,
                config.webcamHeight,
                config.webcamFps > 0 ? config.webcamFps : config.fps)) {
            // Non-fatal: a screen+audio recording the user can still use is far
            // better than losing the whole recording because one camera device
            // didn't match. Report it so the renderer can inform the user (and,
            // historically, fall back to a browser-recorded webcam sidecar), but
            // let capture continue without a native webcam track.
            std::cerr << "WARNING: Failed to initialize native webcam capture; continuing without webcam"
                      << std::endl;
            std::cout << "{\"event\":\"warning\",\"code\":\"webcam-unavailable\",\"message\":"
                         "\"Failed to initialize native webcam capture\"}"
                      << std::endl;
            config.webcamEnabled = false;
        } else {
            std::cout << "{\"event\":\"webcam-format\",\"schemaVersion\":2,\"width\":" << webcamCapture.width()
                      << ",\"height\":" << webcamCapture.height()
                      << ",\"fps\":" << webcamCapture.fps()
                      << ",\"deviceName\":\"" << jsonEscape(wideToUtf8(webcamCapture.selectedDeviceName()))
                      << "\"}" << std::endl;
            writeSeparateWebcam = !config.webcamOutputPath.empty();
        }
    }

    WasapiLoopbackCapture loopbackCapture;
    WasapiLoopbackCapture microphoneCapture;
    const AudioInputFormat* audioFormat = nullptr;
    AudioInputFormat encoderAudioFormat{};
    AudioInputFormat systemAudioFormat{};
    AudioInputFormat microphoneAudioFormat{};
    if (config.captureSystemAudio) {
        if (!loopbackCapture.initializeSystemLoopback()) {
            std::cerr << "ERROR: Failed to initialize WASAPI loopback capture" << std::endl;
            return 1;
        }
        systemAudioFormat = loopbackCapture.inputFormat();
        audioFormat = &loopbackCapture.inputFormat();
    }
    if (config.captureMic) {
        if (!microphoneCapture.initializeMicrophone(
                utf8ToWide(config.microphoneDeviceId),
                utf8ToWide(config.microphoneDeviceName))) {
            std::cerr << "ERROR: Failed to initialize WASAPI microphone capture" << std::endl;
            return 1;
        }
        microphoneAudioFormat = microphoneCapture.inputFormat();
        if (!audioFormat) {
            audioFormat = &microphoneCapture.inputFormat();
        }
    }
    if (audioFormat) {
        std::cout << "{\"event\":\"audio-format\",\"schemaVersion\":2,\"sampleRate\":" << audioFormat->sampleRate
                  << ",\"channels\":" << audioFormat->channels
                  << ",\"bitsPerSample\":" << audioFormat->bitsPerSample
                  << ",\"system\":" << (config.captureSystemAudio ? "true" : "false")
                  << ",\"microphone\":" << (config.captureMic ? "true" : "false");
        if (config.captureMic) {
            std::cout << ",\"microphoneDeviceName\":\""
                      << jsonEscape(wideToUtf8(microphoneCapture.selectedDeviceName())) << "\"";
        }
        std::cout << "}" << std::endl;
        encoderAudioFormat = makeAacCompatibleAudioFormat(*audioFormat);
        std::cout << "{\"event\":\"encoder-audio-format\",\"schemaVersion\":2,\"sampleRate\":"
                  << encoderAudioFormat.sampleRate
                  << ",\"channels\":" << encoderAudioFormat.channels
                  << ",\"bitsPerSample\":" << encoderAudioFormat.bitsPerSample
                  << "}" << std::endl;
    }

    MFEncoderOptions encoderOptions{};
    encoderOptions.preferSoftwareEncoder = config.preferSoftwareEncoder;
    encoderOptions.injectDefaultSinkWriterFailureOnce = injectDefaultSinkWriterFailureOnce;
    // Keep the CPU path for software encoding and inline webcam PiP. The DXGI
    // path is safe when the screen has no CPU-composited webcam frame.
    encoderOptions.useDxgiInput =
        !config.preferSoftwareEncoder && (!webcamActive || writeSeparateWebcam);

    MFEncoder encoder;
    if (!encoder.initialize(
            utf8ToWide(config.outputPath),
            width,
            height,
            config.fps,
            bitrate,
            session.device(),
            session.context(),
            audioFormat ? &encoderAudioFormat : nullptr,
            encoderOptions)) {
        std::cerr << "ERROR: Failed to initialize Media Foundation encoder" << std::endl;
        return 1;
    }
    std::cout << "{\"event\":\"encoder-selection\",\"schemaVersion\":2,\"video\":\""
              << encoder.videoEncoderSelection()
              << "\",\"preferSoftwareEncoder\":"
              << (config.preferSoftwareEncoder ? "true" : "false")
              << "}" << std::endl;
    MFEncoder webcamEncoder;
    if (writeSeparateWebcam) {
        MFEncoderOptions webcamEncoderOptions = encoderOptions;
        webcamEncoderOptions.injectDefaultSinkWriterFailureOnce = false;
        webcamEncoderOptions.useDxgiInput = false;
        const int webcamPixels = std::max(1, webcamCapture.width()) * std::max(1, webcamCapture.height());
        const int webcamBitrate = webcamPixels >= 1280 * 720 ? 8'000'000 : 4'000'000;
        if (!webcamEncoder.initialize(
                utf8ToWide(config.webcamOutputPath),
                webcamCapture.width(),
                webcamCapture.height(),
                webcamCapture.fps(),
                webcamBitrate,
                session.device(),
                session.context(),
                nullptr,
                webcamEncoderOptions)) {
            std::cerr << "ERROR: Failed to initialize native webcam encoder" << std::endl;
            return 1;
        }
    }

    std::mutex mutex;
    CaptureControl control;
    std::atomic<bool> firstFrameWritten = false;
    std::atomic<bool> encodeFailed = false;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> latestFrameTexture;
    int64_t latestFrameTimestampHns = 0;
    int64_t firstFrameTimestampHns = -1;
    std::vector<BYTE> latestWebcamFrame;
    int latestWebcamWidth = 0;
    int latestWebcamHeight = 0;
    uint64_t latestWebcamSequence = 0;
    bool hasVisibleWebcamFrame = false;

    session.setFrameCallback([&](ID3D11Texture2D* texture, int64_t timestampHns) {
        if (control.stopRequested || control.paused) {
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
                control.requestStop();
                return;
            }
        }

        session.context()->CopyResource(latestFrameTexture.Get(), texture);
        latestFrameTimestampHns = timestampHns;
        if (!firstFrameWritten.exchange(true)) {
            control.cv.notify_all();
        }
    });

    auto writeVideoFrames = [&]() {
        const auto frameDuration = std::chrono::duration_cast<std::chrono::steady_clock::duration>(
            std::chrono::duration<double>(1.0 / config.fps));
        uint64_t frameIndex = 0;
        int64_t lastEncodedVideoTimestampHns = -1;
        int64_t lastWebcamTimestampHns = -1;
        // Media Foundation's H.264 encoder MFT does not honor irregular input
        // sample times for a VFR source: it numbers output samples
        // sequentially at its configured nominal frame rate regardless of the
        // SampleTime we attach (confirmed empirically -- varying, correctly
        // increasing input timestamps still produced perfectly even output
        // spacing). Since we cannot make the encoder respect real capture
        // time, we instead make the encoder's assumption true: feed the
        // webcam encoder on a real-time-paced cadence (duplicating the
        // latest available camera frame when the camera hasn't produced a
        // newer one yet), so "sample N is at N/fps" is actually correct.
        int64_t nextWebcamWriteDueHns = 0;
        const int64_t nominalWebcamIntervalHns =
            static_cast<int64_t>(10'000'000ULL / std::max(1, webcamCapture.fps()));

        while (!control.stopRequested && !encodeFailed) {
            Microsoft::WRL::ComPtr<IMFSample> videoSample;
            Microsoft::WRL::ComPtr<IMFSample> webcamSample;
            bool hasVideoSample = false;
            bool hasWebcamSample = false;

            {
                std::unique_lock lock(mutex);
                control.cv.wait_for(lock, std::chrono::milliseconds(100), [&] {
                    return control.stopRequested.load() ||
                        encodeFailed.load() ||
                        (!control.paused.load() && latestFrameTexture);
                });
                if (control.stopRequested || encodeFailed) {
                    break;
                }
                if (webcamActive) {
                    WebcamFrameSnapshot candidateWebcamFrame;
                    if (webcamCapture.copyLatestFrame(candidateWebcamFrame) &&
                        candidateWebcamFrame.sequence != latestWebcamSequence &&
                        hasVisibleBgraContent(candidateWebcamFrame.data)) {
                        latestWebcamFrame = std::move(candidateWebcamFrame.data);
                        latestWebcamWidth = candidateWebcamFrame.width;
                        latestWebcamHeight = candidateWebcamFrame.height;
                        latestWebcamSequence = candidateWebcamFrame.sequence;
                        hasVisibleWebcamFrame = true;
                    }
                }
                const BgraFrameView webcamFrame{
                    hasVisibleWebcamFrame && !latestWebcamFrame.empty() ? latestWebcamFrame.data() : nullptr,
                    latestWebcamWidth,
                    latestWebcamHeight,
                };
                const int64_t syntheticTimestampHns =
                    static_cast<int64_t>((frameIndex * 10'000'000ULL) / config.fps);
                const int64_t sourceTimestampHns =
                    latestFrameTimestampHns > 0 ? latestFrameTimestampHns : syntheticTimestampHns;
                if (firstFrameTimestampHns < 0) {
                    firstFrameTimestampHns = sourceTimestampHns;
                }
                int64_t frameTimestampHns =
                    std::max<int64_t>(
                        0,
                        sourceTimestampHns - firstFrameTimestampHns - control.pausedDurationHns());
                if (lastEncodedVideoTimestampHns >= 0 &&
                    frameTimestampHns <= lastEncodedVideoTimestampHns) {
                    frameTimestampHns =
                        lastEncodedVideoTimestampHns + static_cast<int64_t>(10'000'000ULL / config.fps);
                }
                if (writeSeparateWebcam && webcamFrame.data) {
                    // Anchor to the same recording-start origin as screen video/audio,
                    // using real elapsed host-clock time (not a synthetic frame-index
                    // clock) so a long recording can't accumulate clock-origin drift.
                    const auto elapsedSinceStart = std::chrono::steady_clock::now() - control.recordingStartedAt;
                    const int64_t elapsedHns = std::chrono::duration_cast<
                        std::chrono::duration<int64_t, std::ratio<1, 10'000'000>>>(elapsedSinceStart)
                                                    .count();
                    const int64_t targetElapsedHns =
                        std::max<int64_t>(0, elapsedHns - control.pausedDurationHns());
                    // The H.264 encoder MFT does not honor irregular per-sample
                    // timestamps for a VFR source -- it numbers output samples
                    // sequentially at its configured nominal rate regardless of the
                    // SampleTime attached to each input sample. So the only way to
                    // keep the encoded webcam file in sync with real elapsed time is
                    // to feed the encoder *at* that nominal cadence, duplicating
                    // the latest available camera frame when the camera hasn't
                    // produced a newer one yet (VFR capture -> CFR encode resampling).
                    if (targetElapsedHns >= nextWebcamWriteDueHns) {
                        int64_t webcamTimestampHns = targetElapsedHns;
                        if (lastWebcamTimestampHns >= 0 && webcamTimestampHns <= lastWebcamTimestampHns) {
                            webcamTimestampHns = lastWebcamTimestampHns + nominalWebcamIntervalHns;
                        }
                        // Capture the sample under `mutex` (the frame copy), but
                        // submit it to the sink writer OUTSIDE the mutex below
                        // (issue #115) so a slow WriteSample can't starve the main
                        // thread's stop-wait.
                        hasWebcamSample = webcamEncoder.captureBgraSample(webcamFrame, webcamTimestampHns, webcamSample);
                        if (!hasWebcamSample) {
                            encodeFailed = true;
                            control.requestStop();
                            break;
                        }
                        lastWebcamTimestampHns = webcamTimestampHns;
                        nextWebcamWriteDueHns += nominalWebcamIntervalHns;
                        if (nextWebcamWriteDueHns <= targetElapsedHns) {
                            // Fell behind (e.g. coming out of a pause, or a stall) --
                            // resync to now instead of trying to catch up frame-by-frame.
                            nextWebcamWriteDueHns = targetElapsedHns + nominalWebcamIntervalHns;
                        }
                    }
                }
                if (testStallReadbackMs > 0) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(testStallReadbackMs));
                }
                if (latestFrameTexture) {
                    if (encoderOptions.useDxgiInput) {
                        hasVideoSample = encoder.captureDxgiSample(
                            latestFrameTexture.Get(),
                            frameTimestampHns,
                            videoSample);
                    } else {
                        hasVideoSample = encoder.captureVideoSample(
                            latestFrameTexture.Get(),
                            frameTimestampHns,
                            !writeSeparateWebcam && webcamFrame.data ? &webcamFrame : nullptr,
                            videoSample);
                    }
                    if (!hasVideoSample) {
                        encodeFailed = true;
                        control.requestStop();
                        break;
                    }
                    lastEncodedVideoTimestampHns = frameTimestampHns;
                }
            }

            // Submit the captured samples to their sink writers OUTSIDE
            // `mutex`. IMFSinkWriter::WriteSample runs the H.264 encode
            // synchronously and can be slow (especially the software encoder
            // fallback used when preferSoftwareEncoder is set), and every
            // millisecond it holds `mutex` is a millisecond the WGC frame
            // callback spends queued behind it dropping frames (issue #115).
            //
            // This no longer has anything to do with noticing a stop -- that
            // moved off `mutex` entirely (see CaptureControl::stopMutex) after
            // issue #252 showed the readback below can wedge inside the lock
            // regardless of how briefly WriteSample is held.
            if (hasWebcamSample && !webcamEncoder.submitVideoSample(webcamSample.Get())) {
                encodeFailed = true;
                control.requestStop();
                break;
            }
            if (hasVideoSample && !encoder.submitVideoSample(videoSample.Get())) {
                encodeFailed = true;
                control.requestStop();
                break;
            }

            frameIndex += 1;
            std::this_thread::sleep_for(frameDuration);
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
            encoderAudioFormat,
            config.captureSystemAudio ? systemAudioFormat : encoderAudioFormat,
            config.captureMic ? microphoneAudioFormat : encoderAudioFormat,
            config.captureSystemAudio,
            config.captureMic,
            config.microphoneGain,
            [&](const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns) {
                if (!encoder.writeAudio(data, byteCount, timestampHns, durationHns)) {
                    encodeFailed = true;
                    control.requestStop();
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
                    if (control.stopRequested || !audioMixer) {
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
                    if (control.stopRequested || !audioMixer) {
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
            WebcamFrameSnapshot candidateWebcamFrame;
            if (webcamCapture.copyLatestFrame(candidateWebcamFrame) &&
                hasVisibleBgraContent(candidateWebcamFrame.data)) {
                latestWebcamFrame = std::move(candidateWebcamFrame.data);
                latestWebcamWidth = candidateWebcamFrame.width;
                latestWebcamHeight = candidateWebcamFrame.height;
                latestWebcamSequence = candidateWebcamFrame.sequence;
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

    std::thread stdinThread(readCaptureCommands, std::ref(control), [&](bool isPaused) {
        if (audioMixer) {
            audioMixer->setPaused(isPaused);
        }
    });

    // The lock covers the wait and the decision, and nothing else. Every
    // teardown call below runs outside it, because session.stop() waits for any
    // in-flight WGC callback to finish -- and those callbacks block on this very
    // mutex. Tearing down while holding it deadlocks the two against each other,
    // on the one path the shutdown watchdog does not cover.
    bool firstFrameArrived = false;
    {
        std::unique_lock lock(mutex);
        const bool started = control.cv.wait_for(lock, std::chrono::seconds(10), [&] {
            return firstFrameWritten.load() || control.stopRequested.load();
        });
        firstFrameArrived = started && firstFrameWritten.load();
    }
    if (!firstFrameArrived) {
        control.requestStop();
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

    if (audioMixer) {
        audioMixer->beginTimeline();
    }
    control.recordingStartedAt = std::chrono::steady_clock::now();
    startVideoWriter();

    std::cout << "{\"event\":\"recording-started\",\"schemaVersion\":2}" << std::endl;
    std::cout << "Recording started" << std::endl;

    control.waitForStop();

    const auto stopStart = std::chrono::steady_clock::now();
    auto stopElapsedMs = [&] {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - stopStart).count();
    };
    // Which step we are inside right now, as opposed to which ones finished.
    // Issue #252 was reported with an empty [stop-timing] log precisely because
    // the old instrumentation only spoke after a step returned, which is the
    // one thing a hung step never does.
    std::atomic<const char*> currentStopStep{"stop-wait"};
    std::atomic<bool> shutdownComplete = false;

    // A ceiling on the whole shutdown, and a tighter one per step.
    //
    // The ceiling exists because the app is waiting on the other end of the
    // pipe: NATIVE_WINDOWS_CAPTURE_STOP_TIMEOUT_MS in
    // electron/recording/nativeWindowsCaptureStop.ts must stay comfortably
    // above this, so the helper always ends itself rather than being killed
    // mid-finalize by a parent that ran out of patience. Change one and change
    // the other.
    //
    // The per-step budget is tighter because most steps fail differently:
    // stopping threads and closing WGC either completes in milliseconds or is
    // wedged inside a driver, and there is no slow-but-working case worth
    // waiting for -- waiting is exactly what cost issue #252 a minute of the
    // user's time. Finalizing is the opposite. IMFSinkWriter::Finalize drains
    // the encoder and writes the MP4 index, which on a long recording through
    // the software encoder legitimately takes seconds (issue #34 raised the
    // app-side timeout for precisely this), so it gets whatever is left of the
    // ceiling rather than a step budget of its own.
    const int shutdownBudgetMs = std::max(2000, readEnvInt("OPENSCREEN_WGC_STOP_BUDGET_MS", 50000));
    const int stepBudgetMs =
        std::min(shutdownBudgetMs, std::max(1000, readEnvInt("OPENSCREEN_WGC_STEP_BUDGET_MS", 8000)));
    std::atomic<int64_t> currentStepDeadlineMs{stepBudgetMs};

    auto beginStopStep = [&](const char* step, int budgetMs) {
        currentStopStep = step;
        // Clamped to the ceiling: no sequence of individually-patient steps can
        // add up to a shutdown the app has already given up on.
        currentStepDeadlineMs =
            std::min<int64_t>(stopElapsedMs() + budgetMs, shutdownBudgetMs);
        std::cerr << "[stop-timing] step=" << step << " elapsed_ms=" << stopElapsedMs()
                  << " phase=begin" << std::endl;
    };
    // `step=<name> elapsed_ms=<n>` has to stay the leading shape of every line:
    // scripts/diagnostic-tool/diagnostic.mjs matches on it, so a trailing
    // `phase=` is additive but a leading one would hide the line from the tool.
    auto logStopStep = [&](const char* step) {
        std::cerr << "[stop-timing] step=" << step << " elapsed_ms=" << stopElapsedMs() << std::endl;
    };

    // None of the steps below can be interrupted: a wedged GPU readback, a
    // camera that stops delivering samples, or a WinRT Close() that never
    // returns would each leave the helper alive forever, which the app sees as a
    // freeze ending in a lost recording (issue #252). Give each step a deadline
    // and end the process if one blows through it, naming the step so the next
    // bug report starts where this one had to guess. Joinable rather than
    // detached: it references main's locals, and its poll interval makes the
    // join at the end cost at most one tick.
    std::thread shutdownWatchdog([&] {
        while (!shutdownComplete.load()) {
            // Re-read the flag as part of the same decision as the deadline.
            // Checking them separately let a shutdown that completed during the
            // sleep still be killed.
            if (stopElapsedMs() >= currentStepDeadlineMs.load() && !shutdownComplete.load()) {
                const char* step = currentStopStep.load();
                std::cerr << "[stop-timing] step=" << step << " elapsed_ms=" << stopElapsedMs()
                          << " phase=abandoned" << std::endl;
                std::cout << "{\"event\":\"stop-timeout\",\"schemaVersion\":2,\"step\":\"" << step
                          << "\"}" << std::endl;
                std::cout.flush();
                std::cerr.flush();
                // TerminateProcess rather than exit(): exit() runs static
                // destructors on this thread, and ~MFEncoder finalizes the sink
                // writer behind the very lock a wedged encoder would be holding.
                // This thread exists to end the process, not to queue behind the
                // hang it is reporting.
                TerminateProcess(GetCurrentProcess(), 3);
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
    });

    // Quiesce the frame producer first. Until WGC is closed, callbacks keep
    // arriving and keep taking the frame lock, racing the writer's last pass on
    // the shared D3D context at exactly the moment we can least afford a stall.
    beginStopStep("wgc-quiesce", stepBudgetMs);
    // The drain outcome decides the shape of the whole rest of the shutdown:
    // a callback that never came back makes wgc-session-close skip the device
    // release, so a report that does not say which happened cannot be read.
    const bool wgcDrained = session.quiesceCapture();
    std::cerr << "[stop-timing] step=wgc-quiesce elapsed_ms=" << stopElapsedMs()
              << " drained=" << (wgcDrained ? "true" : "false") << std::endl;
    beginStopStep("microphone", stepBudgetMs);
    microphoneCapture.stop();
    logStopStep("microphone");
    beginStopStep("loopback", stepBudgetMs);
    loopbackCapture.stop();
    logStopStep("loopback");
    beginStopStep("webcam", stepBudgetMs);
    webcamCapture.stop();
    logStopStep("webcam");
    beginStopStep("audio-mixer", stepBudgetMs);
    if (audioMixer) {
        audioMixer->stop();
    }
    logStopStep("audio-mixer");
    beginStopStep("video-writer-join", stepBudgetMs);
    stopVideoWriter();
    logStopStep("video-writer-join");
    // No frame lock here, and the ordering above is what makes that safe rather
    // than incidental: stopVideoWriter() joined the only thread that calls into
    // the encoder's GPU readback, and audioMixer->stop() joined the only other
    // thread that writes to it. MFEncoder's own writerMutex_ deliberately does
    // NOT cover copyFrameToBuffer, so finalizing before those joins would race
    // the staging texture -- do not reorder these.
    beginStopStep("encoder-finalize", shutdownBudgetMs);
    const bool screenFinalized = encoder.finalize();
    logStopStep("encoder-finalize");
    if (!screenFinalized) {
        std::cerr << "ERROR: Failed to finalize the recording" << std::endl;
    }

    // Report success the moment the screen file is durable, not at the end of
    // the process's life. Finalize is what writes the MP4 index; everything
    // after it is housekeeping that cannot improve that file but can still
    // wedge on a bad driver. Announcing here means a watchdog kill during
    // teardown costs the user nothing -- the app reads this line and keeps the
    // recording.
    //
    // Gated on the SCREEN finalize alone, and printed before the webcam's.
    // The app treats this line as proof the screen file is playable, so a
    // failed screen Finalize must not reach it. The webcam is a second,
    // optional file and must not be able to veto the first: letting it decide
    // meant one bad camera clip discarded a complete capture, and because both
    // finalizes share the same ceiling, a slow screen finalize could leave the
    // webcam step no budget at all and get the process killed before this line
    // ever ran. A webcam that fails below is an error on stderr and a non-zero
    // exit -- not a lost recording.
    if (!encodeFailed && screenFinalized) {
        std::cout << "{\"event\":\"recording-stopped\",\"schemaVersion\":2,\"screenPath\":\""
                  << jsonEscape(config.outputPath) << "\"";
        if (writeSeparateWebcam) {
            std::cout << ",\"webcamPath\":\"" << jsonEscape(config.webcamOutputPath) << "\"";
        }
        std::cout << "}" << std::endl;
        std::cout << "Recording stopped. Output path: " << config.outputPath << std::endl;
    }

    bool webcamFinalized = true;
    if (writeSeparateWebcam) {
        beginStopStep("webcam-encoder-finalize", shutdownBudgetMs);
        webcamFinalized = webcamEncoder.finalize();
        logStopStep("webcam-encoder-finalize");
        if (!webcamFinalized) {
            std::cerr << "ERROR: Failed to finalize the webcam recording" << std::endl;
        }
    }

    // Releasing the device goes last: by now no thread can still be holding the
    // D3D context.
    beginStopStep("wgc-session-close", stepBudgetMs);
    session.stop();
    logStopStep("wgc-session-close");

    shutdownComplete = true;
    shutdownWatchdog.join();

    if (stdinThread.joinable()) {
        stdinThread.detach();
    }

    if (encodeFailed) {
        std::cerr << "ERROR: Failed to encode WGC frame" << std::endl;
        return 1;
    }
    if (!screenFinalized || !webcamFinalized) {
        return 1;
    }

    return 0;
}
