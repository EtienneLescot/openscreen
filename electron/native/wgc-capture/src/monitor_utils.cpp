#include "monitor_utils.h"

#include <iostream>
#include <vector>

namespace {

struct MonitorCandidate {
    HMONITOR monitor = nullptr;
    RECT rect{};
};

std::vector<MonitorCandidate> enumerateMonitors() {
    std::vector<MonitorCandidate> monitors;
    EnumDisplayMonitors(
        nullptr,
        nullptr,
        [](HMONITOR monitor, HDC, LPRECT rect, LPARAM userData) -> BOOL {
            auto* result = reinterpret_cast<std::vector<MonitorCandidate>*>(userData);
            result->push_back({monitor, *rect});
            return TRUE;
        },
        reinterpret_cast<LPARAM>(&monitors));
    return monitors;
}

// The bounds arrive as physical pixels recovered from Electron's DIP rect, and
// that round trip is lossy: Chromium scales with *enclosing* rectangles in both
// directions, so it rounds outward twice. Measured on a 1920x1080 panel at 175%
// (scaleFactor 2.1875): DIP 878x494 comes back as 1921x1081, one pixel proud in
// each dimension. An exact compare would reject the right monitor on an entirely
// ordinary setup.
//
// So match with a tolerance. Scanning every integer origin against the common
// panel sizes puts the worst round-trip error at 4 px up to 300% scaling and
// 8 px at 450%, so 8 covers the range Windows actually offers rather than
// leaving margin on top of it. It stays far below any real coordinate-space
// divergence: the smallest this code guards against is a 1920x1080 display at
// 150%, where the two spaces are 256 px apart, and #346's multi-monitor case is
// off by a full screen width. A tolerance large enough to absorb *that* would
// put the bug back, so this number is a ceiling, not a dial to turn up.
constexpr int64_t kBoundsTolerancePx = 8;

bool rectMatchesBounds(const RECT& rect, const MonitorBounds& bounds) {
    // int64_t, not LONG: `bounds` is parsed straight out of the JSON config with
    // no range check, and a subtraction of two hostile ints would overflow.
    const auto close = [](int64_t a, int64_t b) { return (a > b ? a - b : b - a) <= kBoundsTolerancePx; };
    return close(rect.left, bounds.x) &&
           close(rect.top, bounds.y) &&
           close(rect.right - rect.left, bounds.width) &&
           close(rect.bottom - rect.top, bounds.height);
}

} // namespace

HMONITOR findMonitorForCapture(int64_t displayId, const MonitorBounds* bounds) {
    const auto monitors = enumerateMonitors();
    if (monitors.empty()) {
        return MonitorFromPoint({0, 0}, MONITOR_DEFAULTTOPRIMARY);
    }

    // Electron's display_id is not stable across all Windows capture backends.
    // Bounds are the most reliable contract because they come from Electron's
    // selected display.
    //
    // They only match these rects because the caller converts them out of DIPs
    // first and this process is per-monitor-v2 aware (see dpi_awareness.h). Both
    // halves are load-bearing: drop either and no monitor matches at all
    // (getopenscreen/openscreen#346).
    if (bounds && bounds->width > 0 && bounds->height > 0) {
        for (const auto& candidate : monitors) {
            if (rectMatchesBounds(candidate.rect, *bounds)) {
                return candidate.monitor;
            }
        }

        // No guessing from here. This used to fall back to "whichever monitor
        // overlaps the requested rect most", which sounds harmless and is how
        // #346 stayed hidden for so long: on the primary, the two spaces share
        // the origin and differ only by a scale, so one rect always contains the
        // other and the heuristic always answered. It kept answering, correctly,
        // right up to the arrangement where a non-primary display's two origins
        // drift apart by more than a screen width -- and then it silently
        // answered "the primary". A guess that is usually right is worse than a
        // refusal, because nobody ever finds out.
        std::cerr << "ERROR: No monitor matches the requested bounds "
                  << bounds->x << "," << bounds->y << " " << bounds->width << "x" << bounds->height
                  << "; enumerated:";
        for (const auto& candidate : monitors) {
            std::cerr << " " << candidate.rect.left << "," << candidate.rect.top << " "
                      << (candidate.rect.right - candidate.rect.left) << "x"
                      << (candidate.rect.bottom - candidate.rect.top);
        }
        std::cerr << std::endl;
        return nullptr;
    }

    // Best-effort fallback for helpers invoked without bounds. Some callers pass
    // zero-based ids while Win32 monitor handles are pointer values, so only use
    // this when it exactly matches the HMONITOR value.
    for (const auto& candidate : monitors) {
        if (reinterpret_cast<int64_t>(candidate.monitor) == displayId) {
            return candidate.monitor;
        }
    }

    return MonitorFromPoint({0, 0}, MONITOR_DEFAULTTOPRIMARY);
}
