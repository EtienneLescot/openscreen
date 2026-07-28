# harness/CMakeLists.txt — build wcpp_dtw_bench_<backend> against the
# pre-built whisper.cpp variant. One binary per backend; same source file.
#
# Use:
#   cmake -B harness/build -S harness \
#     -DCMAKE_BUILD_TYPE=Release \
#     -DWHISPER_CPU_DIR=tools/stt-eval/whispercpp-dtw-poc/build-cpu \
#     [-DWHISPER_VULKAN_DIR=... ] \
#     [-DWHISPER_CUDA_DIR=...   ]
#   cmake --build harness/build --config Release
#
# Only builds a backend if its directory is supplied AND the
# corresponding `whisper.dll`/`whisper.lib` pair is present. CUDA is
# skipped when nvidia-smi is not available (plan §3).

cmake_minimum_required(VERSION 3.20)
project(wcpp_dtw_bench CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Default each backend to its POC layout, in-repo. Override with -DWHISPER_<X>_DIR.
if (NOT DEFINED WHISPER_CPU_DIR)
  set(WHISPER_CPU_DIR "${CMAKE_CURRENT_LIST_DIR}/../build-cpu" CACHE PATH "")
endif()
if (NOT DEFINED WHISPER_VULKAN_DIR)
  set(WHISPER_VULKAN_DIR "${CMAKE_CURRENT_LIST_DIR}/../build-vulkan" CACHE PATH "")
endif()
if (NOT DEFINED WHISPER_CUDA_DIR)
  set(WHISPER_CUDA_DIR "${CMAKE_CURRENT_LIST_DIR}/../build-cuda" CACHE PATH "")
endif()

add_executable(wcpp_dtw_bench_cpu
  wcpp_dtw_bench.cpp)
target_compile_definitions(wcpp_dtw_bench_cpu
  PRIVATE WCPP_BACKEND="cpu")
target_include_directories(wcpp_dtw_bench_cpu PRIVATE
  ${CMAKE_CURRENT_LIST_DIR}/../whisper.cpp/include
  ${CMAKE_CURRENT_LIST_DIR}/../whisper.cpp/ggml/include
  ${CMAKE_CURRENT_LIST_DIR}/../whisper.cpp/ggml/src)

# whisper.cpp produces a DLL named whisper.dll + import lib whisper.lib.
# The import lib is sufficient for static linkage; runtime needs whisper.dll.
# We do NOT use add_subdirectory() on whisper.cpp here — those builds
# already exist (see Phase 1 build scripts invoked from REPORT.md).
# The harness just links against the produced whisper.dll import lib.

# Concrete: find_library against <DIR>/src/whisper.lib (Windows layout
# produced by our cmake -G Ninja builds).
find_library(WHISPER_CPU_LIB
  NAMES whisper.lib
  PATHS "${WHISPER_CPU_DIR}/src" "${WHISPER_CPU_DIR}" "${WHISPER_CPU_DIR}/bin")
if (WHISPER_CPU_LIB)
  target_link_libraries(wcpp_dtw_bench_cpu PRIVATE ${WHISPER_CPU_LIB})
  message(STATUS "wcpp_dtw_bench_cpu -> ${WHISPER_CPU_LIB}")
else()
  message(WARNING "whisper.lib (CPU) not found under ${WHISPER_CPU_DIR}; build-cpu first.")
endif()

# Optional Vulkan variant — built only if the lib is present in the dir.
find_library(WHISPER_VULKAN_LIB
  NAMES whisper.lib
  PATHS "${WHISPER_VULKAN_DIR}/src" "${WHISPER_VULKAN_DIR}" "${WHISPER_VULKAN_DIR}/bin")
if (WHISPER_VULKAN_LIB)
  add_executable(wcpp_dtw_bench_vulkan wcpp_dtw_bench.cpp)
  target_compile_definitions(wcpp_dtw_bench_vulkan PRIVATE WCPP_BACKEND="vulkan")
  target_include_directories(wcpp_dtw_bench_vulkan PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}/../whisper.cpp/include
    ${CMAKE_CURRENT_LIST_DIR}/../whisper.cpp/ggml/include
    ${CMAKE_CURRENT_LIST_DIR}/../whisper.cpp/ggml/src)
  target_link_libraries(wcpp_dtw_bench_vulkan PRIVATE ${WHISPER_VULKAN_LIB})
  message(STATUS "wcpp_dtw_bench_vulkan -> ${WHISPER_VULKAN_LIB}")
endif()

# Optional CUDA variant — built only if the lib is present in the dir.
find_library(WHISPER_CUDA_LIB
  NAMES whisper.lib
  PATHS "${WHISPER_CUDA_DIR}/src" "${WHISPER_CUDA_DIR}" "${WHISPER_CUDA_DIR}/bin")
if (WHISPER_CUDA_LIB)
  add_executable(wcpp_dtw_bench_cuda wcpp_dtw_bench.cpp)
  target_compile_definitions(wcpp_dtw_bench_cuda PRIVATE WCPP_BACKEND="cuda")
  target_include_directories(wcpp_dtw_bench_cuda PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}/../whisper.cpp/include
    ${CMAKE_CURRENT_LIST_DIR}/../whisper.cpp/ggml/include
    ${CMAKE_CURRENT_LIST_DIR}/../whisper.cpp/ggml/src)
  target_link_libraries(wcpp_dtw_bench_cuda PRIVATE ${WHISPER_CUDA_LIB})
  message(STATUS "wcpp_dtw_bench_cuda -> ${WHISPER_CUDA_LIB}")
endif()

# All whisper.cpp DLLs (one per backend) must be on PATH at run time.
# We emit a tiny script that copies them next to the harness binary after build.
