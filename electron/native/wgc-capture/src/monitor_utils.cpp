#include "monitor_utils.h"

#include <algorithm>
#include <cmath>
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

bool rectMatchesBounds(const RECT& rect, const MonitorBounds& bounds) {
    return rect.left == bounds.x &&
           rect.top == bounds.y &&
           (rect.right - rect.left) == bounds.width &&
           (rect.bottom - rect.top) == bounds.height;
}

int64_t overlapArea(const RECT& rect, const MonitorBounds& bounds) {
    const LONG left = std::max<LONG>(rect.left, bounds.x);
    const LONG top = std::max<LONG>(rect.top, bounds.y);
    const LONG right = std::min<LONG>(rect.right, bounds.x + bounds.width);
    const LONG bottom = std::min<LONG>(rect.bottom, bounds.y + bounds.height);
    if (right <= left || bottom <= top) {
        return 0;
    }
    return static_cast<int64_t>(right - left) * static_cast<int64_t>(bottom - top);
}

} // namespace

HMONITOR findMonitorForCapture(int64_t displayId, const MonitorBounds* bounds) {
    const auto monitors = enumerateMonitors();
    if (monitors.empty()) {
        return MonitorFromPoint({0, 0}, MONITOR_DEFAULTTOPRIMARY);
    }

    // Electron's display_id is not stable across all Windows capture backends.
    // Bounds are the most reliable contract because they come from Electron's
    // selected display and match the WGC monitor coordinate space.
    if (bounds && bounds->width > 0 && bounds->height > 0) {
        for (const auto& candidate : monitors) {
            if (rectMatchesBounds(candidate.rect, *bounds)) {
                return candidate.monitor;
            }
        }

        HMONITOR bestMonitor = nullptr;
        int64_t bestArea = 0;
        for (const auto& candidate : monitors) {
            const int64_t area = overlapArea(candidate.rect, *bounds);
            if (area > bestArea) {
                bestArea = area;
                bestMonitor = candidate.monitor;
            }
        }
        if (bestMonitor) {
            return bestMonitor;
        }
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
