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
# GGML_NATIVE compiles for this dev machine's CPU arch (Zen 2 on AMD Ryzen
# 5 7520U). This is what llama.cpp ships by default and it produces one
# `ggml-cpu` library statically linked into `ggml.dll`. The `+avx2 +fma
# +f16c` baseline is broad enough to cover every x86 CPU OpenScreen
# supports (the OpenScreen installer currently does not run on
# pre-Haswell/AMD-Bulldozer hardware).
set(GGML_NATIVE             ON  CACHE BOOL "" FORCE)
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
