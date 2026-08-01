cmake_minimum_required(VERSION 3.20)
project(openscreen-whisper-stt LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ponytail: same static-CRT handling as the previous native STT helper —
# ggml sets CMAKE_MSVC_RUNTIME_LIBRARY internally; align the helper to it.
if(WIN32)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

# ---------------------------------------------------------------------------
# whisper.cpp source pin (mirrored in stt-whispercpp-migration-plan.md §1.1
# and the POC REPORT.md §1 — keep all three in lockstep).
# ---------------------------------------------------------------------------
set(WHISPER_REPO "https://github.com/ggml-org/whisper.cpp.git" CACHE STRING "")
set(WHISPER_REF  "v1.9.1"  CACHE STRING "")

# ---------------------------------------------------------------------------
# Adaptive GPU backend selection (plan §1.2). The build script flips these
# via -DOSC_ENABLE_<X>=ON; defaults are conservative CPU-only.
# ---------------------------------------------------------------------------
option(OSC_ENABLE_VULKAN "Build ggml Vulkan backend (Windows + Linux)" OFF)
option(OSC_ENABLE_METAL  "Build ggml Metal backend  (macOS arm64)"      OFF)
option(OSC_ENABLE_CUDA   "Build ggml CUDA backend   (opt-in, deferred)"  OFF)

# ---------------------------------------------------------------------------
# whisper.cpp + ggml + httplib + nlohmann/json — all vendored via FetchContent.
# GGML_BACKEND_DL + GGML_CPU_ALL_VARIANTS are the plan §1.2 mechanism that
# makes "one binary per platform, runtime GPU-or-CPU selection" work: ggml
# dlopens the right sidecar (`ggml-vulkan`, `ggml-cpu`, etc.) and falls back
# to a CPU variant if no GPU module is present.
# ---------------------------------------------------------------------------
include(FetchContent)
set(FETCHCONTENT_QUIET OFF)

# ponytail: do NOT enable GGML_BACKEND_DL on Windows. v1.9.1's dlopen-based
# backend registry does not reliably find ggml-cpu / ggml-vulkan sidecars
# (the dir search uses `get_executable_path()` which returns the wrong dir
# when whisper-stt-server.exe lives at the build root while DLLs land in
# `bin/`, and the per-microarch CPU sidecars target Intel feature bits so
# they return `score=0` on AMD). Static linking of all backends into
# whisper.dll + ggml-vulkan ifdef'd in works on every platform we ship to,
# at the cost of a larger single binary. Mirrors the working POC build.
set(GGML_BACKEND_DL         OFF CACHE BOOL "" FORCE)
set(GGML_CPU_ALL_VARIANTS   OFF CACHE BOOL "" FORCE)
# ponytail: this was ON, under a comment claiming it produced a "+avx2 +fma
# +f16c" baseline. It does not. GGML_NATIVE=ON makes ggml compile the CPU
# backend with `-march=native` (ggml/src/ggml-cpu/CMakeLists.txt), i.e. for
# whichever CPU happened to run the build. `.github/workflows/build-whisper-stt.yml`
# builds the shipped binaries on GitHub-hosted runners, and the x64 images are
# Xeons that carry AVX-512, so a published artifact could contain AVX-512 and
# die with SIGILL on every AMD before Zen 4 and every Intel consumer part since
# Alder Lake — while the baseline silently shifted with whatever hardware
# picked up the job. Same class of bug as the OpenSSL note below: an artifact
# whose contents are a function of the build machine.
#
# OFF is what actually yields the intended baseline. ggml then sets INS_ENB=ON,
# which defaults GGML_SSE42/AVX/AVX2/BMI2/FMA/F16C to ON and leaves every
# GGML_AVX512* OFF — Haswell/Zen 1 and newer, which is what the installer
# already requires. This backend is only the fallback for hosts with no usable
# GPU backend, so the cost is marginal and the artifact becomes reproducible.
#
# OSC_NATIVE_CPU is the escape hatch for local benchmarking. It must never be
# set for anything that gets shipped.
option(OSC_NATIVE_CPU "Tune the CPU backend for this machine (-march=native); local builds only" OFF)
if(OSC_NATIVE_CPU)
  set(GGML_NATIVE           ON  CACHE BOOL "" FORCE)
else()
  set(GGML_NATIVE           OFF CACHE BOOL "" FORCE)
  # Pin the baseline rather than inheriting ggml's INS_ENB defaults. `option()`
  # only seeds a value the first time a build tree is configured, so a cache
  # that was written while GGML_NATIVE was ON keeps GGML_AVX2=OFF forever and
  # quietly downgrades the result to plain x86-64 — no AVX2 at all, which is
  # slower than what this project shipped before. Being explicit also states
  # the contract in one place instead of leaving it to an upstream default.
  # AVX-512 stays off: that is the part that does not run everywhere.
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|AMD64|amd64)$")
    foreach(osc_isa SSE42 AVX AVX2 BMI2 FMA F16C)
      set(GGML_${osc_isa}   ON  CACHE BOOL "" FORCE)
    endforeach()
  endif()
endif()
set(WHISPER_BUILD_EXAMPLES  OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS     OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER    OFF CACHE BOOL "" FORCE)
if(OSC_ENABLE_VULKAN)
  set(GGML_VULKAN ON CACHE BOOL "" FORCE)
endif()
if(OSC_ENABLE_METAL)
  set(GGML_METAL ON CACHE BOOL "" FORCE)
  set(GGML_METAL_EMBED_LIBRARY ON CACHE BOOL "" FORCE)
endif()
if(OSC_ENABLE_CUDA)
  set(GGML_CUDA ON CACHE BOOL "" FORCE)
endif()

FetchContent_Declare(whisper
  GIT_REPOSITORY ${WHISPER_REPO}
  GIT_TAG        ${WHISPER_REF}
  GIT_SHALLOW    TRUE
)
FetchContent_Declare(httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG        v0.18.1
  GIT_SHALLOW    TRUE
)
FetchContent_Declare(json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG        v3.11.3
  GIT_SHALLOW    TRUE
)
# cpp-httplib auto-detects OpenSSL, zlib and Brotli and links whatever it finds:
# all three HTTPLIB_USE_*_IF_AVAILABLE options default to ON. That makes the
# import table a function of whatever happens to be installed on the build
# machine, which is how 1.8.0-rc.1..rc.3 shipped a whisper-stt-server.exe
# importing libssl-3-x64.dll and libcrypto-3-x64.dll that the installer does not
# carry. Windows then killed it in the loader with 0xC0000135 before main(), so
# it printed nothing and the app only ever saw "did not respond within 30000ms".
#
# This server binds 127.0.0.1 over plain HTTP and never speaks TLS (see the
# loopback-only guard in src/main.cpp), so OpenSSL buys nothing. Pin all three
# OFF to make the link deterministic rather than environment-dependent.
set(HTTPLIB_USE_OPENSSL_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
set(HTTPLIB_USE_ZLIB_IF_AVAILABLE    OFF CACHE BOOL "" FORCE)
set(HTTPLIB_USE_BROTLI_IF_AVAILABLE  OFF CACHE BOOL "" FORCE)

# ponytail: on Linux, ggml/whisper build as separate shared objects and CMake
# bakes the absolute build-tree `bin/` path into each RUNPATH. The build script
# then copies the binary and its libs side by side into
# `electron/native/bin/linux-x64/`, where that absolute path is meaningless the
# moment the build cache is wiped or the app is packaged on another machine.
# Resolve relative to the executable instead. `$ORIGIN/bin` keeps the binary in
# the build tree runnable too (it lands at the build root while the libs go to
# `bin/`). Set before MakeAvailable so the whisper/ggml targets inherit it.
# macOS is left alone: it needs @loader_path rather than $ORIGIN and is not
# testable from here.
if(UNIX AND NOT APPLE)
  set(CMAKE_BUILD_WITH_INSTALL_RPATH ON)
  set(CMAKE_INSTALL_RPATH "$ORIGIN:$ORIGIN/bin")
endif()

FetchContent_MakeAvailable(whisper httplib json)

add_executable(whisper-stt-server src/main.cpp)
target_link_libraries(whisper-stt-server PRIVATE
  whisper
  httplib::httplib
  nlohmann_json::nlohmann_json
)
target_include_directories(whisper-stt-server PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/src
)

if(WIN32)
  target_compile_definitions(whisper-stt-server PRIVATE
    NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00
  )
  set_target_properties(whisper-stt-server PROPERTIES WIN32_EXECUTABLE OFF)
endif()

# ponytail: whisper.cpp's `vulkan-shaders-gen` sub-project (only built when
# OSC_ENABLE_VULKAN=ON) can hit Windows MAX_PATH on deep build trees because
# its inner CMake invocation looks for `ninja` in the wrong place. The helper
# `ninja.exe` we drop in $env:LOCALAPPDATA/hermes/node/ (per the POC's
# `C:/wcppvbuild` short-path workaround) unblocks the inner configure. Nothing
# to do here at CMake level; document the prerequisite in scripts/build-whisper-stt.sh.
