#include <windows.h>
#include <gdiplus.h>
#include <objbase.h>

#include "dpi_awareness.h"

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cinttypes>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// ─────────────────────────────────────────────────────────────────────────────
// Global mouse-hook state
// ─────────────────────────────────────────────────────────────────────────────
static HHOOK              g_mouseHook    = nullptr;
static DWORD              g_mainThreadId = 0;
static std::atomic<int>   g_leftDownCount{0};
static std::atomic<int>   g_leftUpCount{0};
static std::atomic<bool>  g_stop{false};
static std::mutex         g_stdoutMtx;

static LRESULT CALLBACK LowLevelMouseProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode >= 0) {
        if      (wParam == WM_LBUTTONDOWN) g_leftDownCount.fetch_add(1, std::memory_order_relaxed);
        else if (wParam == WM_LBUTTONUP)   g_leftUpCount.fetch_add(1,   std::memory_order_relaxed);
    }
    return CallNextHookEx(g_mouseHook, nCode, wParam, lParam);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
static int64_t nowMs() {
    return static_cast<int64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
        .count());
}

static void writeJsonLine(const std::string& json) {
    std::lock_guard<std::mutex> lock(g_stdoutMtx);
    std::cout << json << '\n';
    std::cout.flush();
}

static std::string jsonEscape(const std::string& s) {
    std::string r;
    r.reserve(s.size());
    for (unsigned char c : s) {
        switch (c) {
            case '"':  r += "\\\""; break;
            case '\\': r += "\\\\"; break;
            case '\n': r += "\\n";  break;
            case '\r': r += "\\r";  break;
            case '\t': r += "\\t";  break;
            default:   r.push_back(static_cast<char>(c)); break;
        }
    }
    return r;
}

static const char kBase64Chars[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static std::string base64Encode(const uint8_t* data, size_t len) {
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        const uint32_t b =
            (static_cast<uint32_t>(data[i])              << 16) |
            (i + 1 < len ? static_cast<uint32_t>(data[i + 1]) << 8 : 0u) |
            (i + 2 < len ? static_cast<uint32_t>(data[i + 2])      : 0u);
        out.push_back(kBase64Chars[(b >> 18) & 0x3F]);
        out.push_back(kBase64Chars[(b >> 12) & 0x3F]);
        out.push_back(i + 1 < len ? kBase64Chars[(b >>  6) & 0x3F] : '=');
        out.push_back(i + 2 < len ? kBase64Chars[(b      ) & 0x3F] : '=');
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// GDI+ PNG encoder CLSID
// ─────────────────────────────────────────────────────────────────────────────
static bool getPngClsid(CLSID& out) {
    UINT num = 0, sz = 0;
    if (Gdiplus::GetImageEncodersSize(&num, &sz) != Gdiplus::Ok || sz == 0) return false;
    std::vector<uint8_t> buf(sz);
    auto* enc = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.data());
    if (Gdiplus::GetImageEncoders(num, sz, enc) != Gdiplus::Ok) return false;
    for (UINT i = 0; i < num; ++i) {
        if (std::wstring(enc[i].MimeType) == L"image/png") {
            out = enc[i].Clsid;
            return true;
        }
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Standard cursor-type lookup
// ─────────────────────────────────────────────────────────────────────────────
static const char* standardCursorType(HCURSOR hc) {
    if (!hc) return nullptr;
    static const struct { WORD id; const char* name; } kMap[] = {
        {32512, "arrow"},
        {32513, "text"},
        {32514, "wait"},
        {32515, "crosshair"},
        {32516, "up-arrow"},
        {32642, "resize-nwse"},
        {32643, "resize-nesw"},
        {32644, "resize-ew"},
        {32645, "resize-ns"},
        {32646, "move"},
        {32648, "not-allowed"},
        {32649, "pointer"},
        {32650, "app-starting"},
        {32651, "help"},
    };
    static constexpr int N = static_cast<int>(sizeof(kMap) / sizeof(kMap[0]));
    static HCURSOR g_handles[N] = {};
    static bool    g_init       = false;
    if (!g_init) {
        for (int i = 0; i < N; ++i)
            g_handles[i] = LoadCursor(nullptr, MAKEINTRESOURCE(kMap[i].id));
        g_init = true;
    }
    for (int i = 0; i < N; ++i)
        if (g_handles[i] && g_handles[i] == hc) return kMap[i].name;
    return nullptr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom cursor-type detection (replicates the PowerShell heuristic)
// ─────────────────────────────────────────────────────────────────────────────
static const char* detectCustomCursorType(
    const uint32_t* pixels, int w, int h, int hotX, int hotY)
{
    if (w < 24 || h < 24 || w > 64 || h > 64) return nullptr;
    if (hotX < w * 0.25 || hotX > w * 0.75)   return nullptr;
    if (hotY < h * 0.15 || hotY > h * 0.55)   return nullptr;

    int opaque = 0, topHalf = 0;
    int left = w, top = h, right = -1, bottom = -1;

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const uint8_t a = static_cast<uint8_t>(pixels[y * w + x] >> 24);
            if (a <= 32) continue;
            ++opaque;
            if (y < h / 2) ++topHalf;
            if (x < left)   left   = x;
            if (x > right)  right  = x;
            if (y < top)    top    = y;
            if (y > bottom) bottom = y;
        }
    }

    if (opaque < 90 || right < left || bottom < top) return nullptr;

    const int ow = right - left + 1;
    const int oh = bottom - top + 1;
    if (ow < w * 0.35 || ow > w * 0.9)                   return nullptr;
    if (oh < h * 0.45 || oh > static_cast<double>(h))    return nullptr;
    if (top > h * 0.45 || bottom < h * 0.65)             return nullptr;

    return topHalf > opaque * 0.55 ? "closed-hand" : "open-hand";
}

// ─────────────────────────────────────────────────────────────────────────────
// Build asset JSON for the given cursor (returns empty string on failure)
//
// Renders the cursor via GDI DrawIconEx onto a 32-bpp transparent DIB section
// and then encodes to PNG — matching the PowerShell approach of
// Graphics.Clear(Transparent) + Graphics.DrawIcon().  This correctly preserves
// per-pixel alpha for 32-bit cursors, unlike Gdiplus::Bitmap::FromHICON which
// can produce incorrect alpha for cursor handles.
// ─────────────────────────────────────────────────────────────────────────────
static std::string buildAssetJson(
    HCURSOR            hCursor,
    const std::string& handleStr,
    const CLSID&       pngClsid,
    const char**       outCustomType)
{
    *outCustomType = nullptr;

    // Get hotspot and cursor dimensions from the icon info.
    // For color cursors hbmColor gives the size; for monochrome cursors the
    // mask bitmap is twice the cursor height (AND mask stacked on XOR mask).
    ICONINFO ii{};
    if (!GetIconInfo(hCursor, &ii)) return {};
    const int hotX = static_cast<int>(ii.xHotspot);
    const int hotY = static_cast<int>(ii.yHotspot);

    int w = 0, h = 0;
    if (ii.hbmColor) {
        BITMAP bm{};
        if (GetObject(ii.hbmColor, sizeof(bm), &bm)) { w = bm.bmWidth; h = bm.bmHeight; }
    }
    if (ii.hbmMask && (w == 0 || h == 0)) {
        BITMAP bm{};
        if (GetObject(ii.hbmMask, sizeof(bm), &bm)) {
            w = bm.bmWidth;
            h = ii.hbmColor ? bm.bmHeight : bm.bmHeight / 2;
        }
    }
    if (ii.hbmMask)  DeleteObject(ii.hbmMask);
    if (ii.hbmColor) DeleteObject(ii.hbmColor);
    if (w <= 0 || h <= 0) return {};

    // Copy the cursor handle so DrawIconEx cannot affect the live system cursor.
    const HICON hCopy = CopyIcon(hCursor);
    if (!hCopy) return {};

    // Allocate a 32-bpp top-down DIB section and clear it to transparent black,
    // then draw the cursor with DI_NORMAL.  For 32-bit alpha cursors Windows
    // writes correct per-pixel alpha into the high byte of each BGRA pixel.
    const int stride = w * 4;
    BITMAPINFOHEADER bih{};
    bih.biSize        = sizeof(bih);
    bih.biWidth       = w;
    bih.biHeight      = -h;   // negative = top-down scanline order
    bih.biPlanes      = 1;
    bih.biBitCount    = 32;
    bih.biCompression = BI_RGB;

    void*   pBits = nullptr;
    HDC     hDC   = CreateCompatibleDC(nullptr);
    HBITMAP hBmp  = hDC ? CreateDIBSection(hDC,
                              reinterpret_cast<const BITMAPINFO*>(&bih),
                              DIB_RGB_COLORS, &pBits, nullptr, 0)
                        : nullptr;

    if (!hBmp || !pBits) {
        if (hBmp) DeleteObject(hBmp);
        if (hDC)  DeleteDC(hDC);
        DestroyIcon(hCopy);
        return {};
    }

    HGDIOBJ hOld = SelectObject(hDC, hBmp);
    std::memset(pBits, 0, static_cast<size_t>(stride * h)); // transparent black
    DrawIconEx(hDC, 0, 0, hCopy, w, h, 0, nullptr, DI_NORMAL);
    GdiFlush();
    SelectObject(hDC, hOld);
    DeleteDC(hDC);
    DestroyIcon(hCopy);

    // GDI's 32-bit DIB stores pixels as BGRA in memory.  GDI+'s
    // PixelFormat32bppARGB interprets each 32-bit word as 0xAARRGGBB which is
    // identical to BGRA on little-endian, so the alpha byte is always >> 24.
    {
        const auto* px = static_cast<const uint32_t*>(pBits);
        *outCustomType = detectCustomCursorType(px, w, h, hotX, hotY);
    }

    // Wrap the DIB pixels in a GDI+ Bitmap (zero-copy) and save to PNG.
    // Keep hBmp alive until after gBmp is destroyed so pBits remains valid.
    std::vector<uint8_t> pngData;
    {
        Gdiplus::Bitmap gBmp(w, h, stride, PixelFormat32bppARGB,
                             static_cast<BYTE*>(pBits));
        if (gBmp.GetLastStatus() == Gdiplus::Ok) {
            IStream* pStream = nullptr;
            if (SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &pStream))) {
                if (gBmp.Save(pStream, &pngClsid) == Gdiplus::Ok) {
                    ULARGE_INTEGER sz{};
                    LARGE_INTEGER  zero{};
                    pStream->Seek(zero, STREAM_SEEK_END, &sz);
                    pStream->Seek(zero, STREAM_SEEK_SET, nullptr);
                    pngData.resize(static_cast<size_t>(sz.QuadPart));
                    ULONG n = 0;
                    pStream->Read(pngData.data(), static_cast<ULONG>(pngData.size()), &n);
                    pngData.resize(n);
                }
                pStream->Release();
            }
        }
    } // gBmp destroyed here; pBits (owned by hBmp) still valid
    DeleteObject(hBmp);

    if (pngData.empty()) return {};

    const std::string dataUrl =
        "data:image/png;base64," + base64Encode(pngData.data(), pngData.size());

    std::string json;
    json.reserve(dataUrl.size() + 128);
    json  = "{\"id\":\"" + handleStr + "\"";
    json += ",\"imageDataUrl\":\"" + jsonEscape(dataUrl) + "\"";
    json += ",\"width\":"    + std::to_string(w);
    json += ",\"height\":"   + std::to_string(h);
    json += ",\"hotspotX\":" + std::to_string(hotX);
    json += ",\"hotspotY\":" + std::to_string(hotY);
    if (*outCustomType) {
        json += ",\"cursorType\":\"";
        json += *outCustomType;
        json += "\"";
    } else {
        json += ",\"cursorType\":null";
    }
    json += "}";
    return json;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sampling loop (background thread)
// ─────────────────────────────────────────────────────────────────────────────
static void runSamplingLoop(int intervalMs, HWND targetWindow, const CLSID& pngClsid) {
    HCURSOR lastCursor = nullptr;

    while (!g_stop.load(std::memory_order_relaxed)) {
        const int downCount = g_leftDownCount.exchange(0, std::memory_order_relaxed);
        const int upCount   = g_leftUpCount.exchange(0,   std::memory_order_relaxed);

        CURSORINFO ci{};
        ci.cbSize = sizeof(ci);
        if (!GetCursorInfo(&ci)) {
            char buf[160];
            std::snprintf(buf, sizeof(buf),
                "{\"type\":\"error\",\"timestampMs\":%" PRId64 ",\"message\":\"GetCursorInfo failed\"}",
                nowMs());
            writeJsonLine(buf);
            std::this_thread::sleep_for(std::chrono::milliseconds(intervalMs));
            continue;
        }

        const bool    visible   = (ci.flags & CURSOR_SHOWING) != 0;
        const HCURSOR hc        = ci.hCursor;

        // Handle string ("0xHEX" or empty for null cursor)
        char handleBuf[32] = {};
        if (hc)
            std::snprintf(handleBuf, sizeof(handleBuf),
                "0x%" PRIX64, static_cast<uint64_t>(reinterpret_cast<uintptr_t>(hc)));
        const std::string handleStr = hc ? handleBuf : "";

        // Standard cursor type
        const char* cursorType = standardCursorType(hc);

        // Mouse button state
        const SHORT ks          = GetAsyncKeyState(VK_LBUTTON);
        const bool  leftDown    = (ks & 0x8000) != 0;
        const bool  leftPressed = downCount > 0 || (ks & 0x0001) != 0;
        const bool  leftReleased = upCount > 0;

        // Asset — only when the cursor handle changes
        std::string assetJson;
        if (visible && hc && hc != lastCursor) {
            const char* customType = nullptr;
            assetJson = buildAssetJson(hc, handleStr, pngClsid, &customType);
            if (!assetJson.empty() && !cursorType && customType)
                cursorType = customType;
            lastCursor = hc;
        }

        // Window bounds
        std::string boundsJson = "null";
        if (targetWindow && IsWindow(targetWindow)) {
            RECT r{};
            if (GetWindowRect(targetWindow, &r)) {
                const int bw = r.right  - r.left;
                const int bh = r.bottom - r.top;
                if (bw > 0 && bh > 0) {
                    char buf[128];
                    std::snprintf(buf, sizeof(buf),
                        "{\"x\":%ld,\"y\":%ld,\"width\":%d,\"height\":%d}",
                        r.left, r.top, bw, bh);
                    boundsJson = buf;
                }
            }
        }

        // Emit sample JSON
        std::string out;
        out.reserve(256);
        out += "{\"type\":\"sample\"";
        out += ",\"timestampMs\":";        out += std::to_string(nowMs());
        out += ",\"x\":";                  out += std::to_string(ci.ptScreenPos.x);
        out += ",\"y\":";                  out += std::to_string(ci.ptScreenPos.y);
        out += ",\"visible\":";            out += visible      ? "true" : "false";
        out += ",\"handle\":";             out += hc ? ("\"" + handleStr + "\"") : "null";
        out += ",\"cursorType\":";         out += cursorType   ? ("\"" + std::string(cursorType) + "\"") : "null";
        out += ",\"leftButtonDown\":";     out += leftDown     ? "true" : "false";
        out += ",\"leftButtonPressed\":";  out += leftPressed  ? "true" : "false";
        out += ",\"leftButtonReleased\":"; out += leftReleased ? "true" : "false";
        out += ",\"bounds\":";             out += boundsJson;
        out += ",\"asset\":";              out += assetJson.empty() ? "null" : assetJson;
        out += "}";

        writeJsonLine(out);

        // Exit if stdout pipe is broken (parent process died)
        if (std::cout.fail()) {
            PostThreadMessage(g_mainThreadId, WM_QUIT, 0, 0);
            break;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(intervalMs));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────
int main(int argc, char* argv[]) {
    // Without this the process is DPI-unaware and Win32 virtualises every
    // coordinate it hands back — GetCursorInfo().ptScreenPos and GetWindowRect
    // come out divided by the primary display's scale factor — while the WGC
    // capture and the consumer both work in physical pixels.  On any scaled
    // display the cursor then lands short of its real position, by more the
    // further it is from the origin (getopenscreen/openscreen#272).
    //
    // Bail out rather than sample, and bail out before `ready`: for a display
    // capture the caller normalizes these coordinates against a *physical* rect,
    // so an unaware sampler puts every point at 1/scale of its real offset. The
    // caller turns an exit-before-ready into "record without cursor data"
    // (handlers.ts catches the failed start and drops the session), which is the
    // outcome we want -- no overlay beats an overlay in the wrong place.
    if (!enablePerMonitorV2DpiAwareness()) {
        std::cerr << "ERROR: Could not enable per-monitor-v2 DPI awareness" << std::endl;
        return 1;
    }

    if (argc < 2) {
        std::cerr << "Usage: cursor-sampler <intervalMs> [windowHandle]" << std::endl;
        return 1;
    }

    const int intervalMs = std::max(1, std::atoi(argv[1]));

    HWND targetWindow = nullptr;
    if (argc >= 3) {
        const std::string arg = argv[2];
        if (!arg.empty() && arg != "null") {
            try {
                const int      base = (arg.rfind("0x", 0) == 0 || arg.rfind("0X", 0) == 0) ? 16 : 10;
                const uint64_t v    = std::stoull(arg, nullptr, base);
                if (v) targetWindow = reinterpret_cast<HWND>(static_cast<uintptr_t>(v));
            } catch (...) {}
        }
    }

    // Initialize GDI+
    Gdiplus::GdiplusStartupInput gdipInput{};
    ULONG_PTR gdipToken = 0;
    if (Gdiplus::GdiplusStartup(&gdipToken, &gdipInput, nullptr) != Gdiplus::Ok) {
        std::cerr << "GDI+ init failed" << std::endl;
        return 1;
    }

    CLSID pngClsid{};
    if (!getPngClsid(pngClsid)) {
        std::cerr << "PNG encoder not found" << std::endl;
        Gdiplus::GdiplusShutdown(gdipToken);
        return 1;
    }

    // Install global low-level mouse hook on this thread
    g_mouseHook = SetWindowsHookEx(WH_MOUSE_LL, LowLevelMouseProc, GetModuleHandle(nullptr), 0);
    if (!g_mouseHook) {
        std::cerr << "SetWindowsHookEx failed" << std::endl;
        Gdiplus::GdiplusShutdown(gdipToken);
        return 1;
    }

    // Prime GetAsyncKeyState so the first poll doesn't return stale "since-last-call" bits
    GetAsyncKeyState(VK_LBUTTON);

    // Signal readiness
    g_mainThreadId = GetCurrentThreadId();
    {
        char buf[80];
        std::snprintf(buf, sizeof(buf),
            "{\"type\":\"ready\",\"timestampMs\":%" PRId64 "}", nowMs());
        writeJsonLine(buf);
    }

    // Start sampling on a background thread
    std::thread sampler(runSamplingLoop, intervalMs, targetWindow, std::cref(pngClsid));

    // Run the message pump on the main thread — required for WH_MOUSE_LL callbacks
    MSG msg;
    while (GetMessage(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    g_stop.store(true, std::memory_order_relaxed);
    if (sampler.joinable()) sampler.join();
    UnhookWindowsHookEx(g_mouseHook);
    Gdiplus::GdiplusShutdown(gdipToken);
    return 0;
}
