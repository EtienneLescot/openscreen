cmake_minimum_required(VERSION 3.20)

project(openscreen-ctranslate2-server LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# -----------------------------------------------------------------------
# Backend matrix (one per target platform)
# -----------------------------------------------------------------------
# ponytail: cross-platform OpenScreen distribution requires picking ONE
# serious GEMM backend per OS. Rationale below — flipping this matrix is
# the "Plan C" knob for performance. Anything OFF here means: do NOT pick
# it (Ruy is the textbook example of the failure mode we are escaping).
#
#   Windows  → oneDNN (Apache-2, MSVC-friendly, ~5–10× Ruy/fp32)
#   Linux    → oneDNN (same, no bias Intel; OpenBLAS rejected because
#              its Makefile build is awkward in our FetchContent flow and
#              oneDNN does the same job with CMake + better INT8 coverage)
#   macOS    → Accelerate (system framework, free, fast on Apple silicon)
#
# CUDA (NVIDIA) is opt-in separately via -DENABLE_CUDA=ON for users who
# happen to have one. We never default to it because the OpenScreen
# install base includes AMD/Radeon/Intel-only machines.
#
# Anything we set with `CACHE BOOL "" FORCE` here wins over whatever
# CTranslate2's CMakeLists later tries to default — so they truly are
# the single source of truth for what gets built in.
# -----------------------------------------------------------------------

set(CTRANS2_REPO "https://github.com/OpenNMT/CTranslate2.git" CACHE STRING "CTranslate2 git URL")
set(CTRANS2_REF  "v4.4.0" CACHE STRING "CTranslate2 ref/tag/branch")
set(ENABLE_CUDA  OFF CACHE BOOL "Build CTranslate2 + server with CUDA")

# ---- Force static link everywhere so the shipped binary has no .dll sidecar
# (Electron-builder pulls these from electron/native/bin/<os>-<arch>/; a
# single self-contained .exe per platform is the simplest distribution).
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_CLI OFF CACHE BOOL "" FORCE)

# ---- Default everything OFF, then enable the platform-specific backend.
set(WITH_RUY OFF CACHE BOOL "" FORCE)
set(WITH_MKL OFF CACHE BOOL "" FORCE)
set(WITH_BLAS OFF CACHE BOOL "" FORCE)
set(WITH_OPENBLAS OFF CACHE BOOL "" FORCE)

include(FetchContent)
set(FETCHCONTENT_QUIET OFF)

if(APPLE)
  # ponytail: Accelerate ships with macOS — no fetch, no extern dep.
  # CTranslate2 detects it via `find_package(BLAS REQUIRED)` with
  # `BLA_VENDOR Apple`. Performance on Apple silicon rivals MKL on
  # Intel without dragging in any extra binary. oneDNN also works on
  # macOS but Accelerate is always present and free.
  set(WITH_ACCELERATE ON CACHE BOOL "" FORCE)
else()
  # Windows + Linux + other unixes: oneDNN via FetchContent.
  # ponytail: oneDNN's `find_library(DNNL_LIBRARY NAMES dnnl)` resolves
  # to `dnnl.lib` (Windows, oneDNN 3.x default STATIC output) or
  # `libdnnl.a` (Linux). We hand CTranslate2 the exact paths its
  # upstream CMakeLists tries to find via `INTEL_ROOT/<path>`, otherwise
  # the v4.4.0 probe blows up. Setting the cache vars BEFORE
  # CTranslate2's `add_subdirectory` makes the find_* calls short-circuit.
  FetchContent_Declare(
    onednn
    GIT_REPOSITORY https://github.com/oneapi-src/oneDNN.git
    GIT_TAG        v3.6
    GIT_SHALLOW    TRUE
  )
  FetchContent_MakeAvailable(onednn)
  set(WITH_DNNL ON CACHE BOOL "" FORCE)
  if(WIN32)
    set(DNNL_INCLUDE_DIR "${onednn_SOURCE_DIR}/include" CACHE PATH "" FORCE)
    set(DNNL_LIBRARY    "${onednn_BINARY_DIR}/src/dnnl.lib" CACHE FILEPATH "" FORCE)
  else()
    set(DNNL_INCLUDE_DIR "${onednn_SOURCE_DIR}/include" CACHE PATH "" FORCE)
    set(DNNL_LIBRARY    "${onednn_BINARY_DIR}/src/libdnnl.a" CACHE FILEPATH "" FORCE)
  endif()
endif()

# Ponytail: vendor the small deps up front so the rest of the script
# can reference them by target name (ctranslate2, httplib::httplib,
# nlohmann_json::nlohmann_json).
FetchContent_Declare(
  ctranslate2
  GIT_REPOSITORY ${CTRANS2_REPO}
  GIT_TAG        ${CTRANS2_REF}
  GIT_SHALLOW    TRUE
  GIT_SUBMODULES_RECURSE TRUE
)
FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG        v0.18.1
  GIT_SHALLOW    TRUE
)
FetchContent_Declare(
  json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG        v3.11.3
  GIT_SHALLOW    TRUE
)

# ---- CTranslate2 build switches. Note: NO `CTRANS2_` prefix; v4.4.0
# reads unprefixed names. `OPENMP_RUNTIME=COMP` picks the compiler's
# native OMP (vcomp on MSVC, libgomp on GCC, libomp on clang) so we don't
# need Intel's libiomp5 — important for portability. CUDA stays off by
# default; flip explicitly via -DENABLE_CUDA=ON at the CLI for a GPU
# build.
set(WITH_OPENBLAS OFF CACHE BOOL "" FORCE)
set(OPENMP_RUNTIME "COMP" CACHE STRING "" FORCE)
set(WITH_CUDA OFF CACHE BOOL "" FORCE)
set(WITH_TENSOR_PARALLEL OFF CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(ctranslate2 httplib json)

add_executable(ctranslate2-server
  src/main.cpp
  src/mel.cpp
)
target_include_directories(ctranslate2-server PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_SOURCE_DIR}
)
target_link_libraries(ctranslate2-server PRIVATE
  ctranslate2
  httplib::httplib
  nlohmann_json::nlohmann_json
)
target_sources(ctranslate2-server PRIVATE
  third_party/kissfft/kiss_fft.c
)

if(WIN32)
  target_compile_definitions(ctranslate2-server PRIVATE
    NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00
  )
  set_target_properties(ctranslate2-server PROPERTIES WIN32_EXECUTABLE OFF)
endif()
