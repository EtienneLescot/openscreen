#pragma once

#include <Windows.h>

#include <cstdint>

struct MonitorBounds {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
};

HMONITOR findMonitorForCapture(int64_t displayId, const MonitorBounds* bounds);
