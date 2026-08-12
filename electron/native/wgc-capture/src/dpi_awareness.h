#pragma once

#include <Windows.h>

// Every OpenScreen native helper runs per-monitor-v2 DPI aware, and this is the
// one place that says so.
//
// A DPI-unaware process does not get real coordinates from Win32: every rect and
// point it reads back is *virtualized*, divided by the PRIMARY display's scale
// factor whatever monitor it actually describes. The helper and its TypeScript
// caller then live in two different coordinate spaces that happen to coincide at
// 100% scaling -- which is exactly why both bugs of this class shipped unnoticed
// (getopenscreen/openscreen#272, cursor offset; #346, wrong monitor recorded).
//
// The TypeScript side converts Electron's DIP rects before handing them over, in
// electron/native-bridge/helperCoordinates.ts. The contract both sides implement
// is: helpers speak physical screen pixels, always.
//
// Returns false when the process could not be put in that state. In practice
// that only happens when something outside our control -- an app-compat
// "override high DPI scaling behaviour" setting on the .exe -- already pinned a
// different context. Callers decide what that means for them; nothing here can
// safely *guess* which space the numbers are in.
inline bool enablePerMonitorV2DpiAwareness() {
    if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
        return true;
    }

    // ERROR_ACCESS_DENIED means an awareness context was already selected for
    // this process. That is fine when it is the one we wanted, and fatal when it
    // is not, so check rather than assuming either way.
    return GetLastError() == ERROR_ACCESS_DENIED &&
           AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),
                                        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
}
