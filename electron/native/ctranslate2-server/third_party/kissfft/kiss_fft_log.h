/*
  kiss_fft_log.h — vendored from mborgerding/kissfft v1.5.x (BSD-3-Clause).
  Local copy so we don't drag in another FetchContent for ~12 KB of code.

  See electron/native/ctranslate2-server/third_party/kissfft/LICENSE for the
  upstream license; our modifications, if any, are tracked in
  docs/engineering/stt-ctranslate2-migration.md.
*/
#ifndef KISS_FFT_LOG_H
#define KISS_FFT_LOG_H

#define ERROR 1
#define WARNING 2
#define INFO 3
#define DEBUG 4

#define STRINGIFY(x) #x
#define TOSTRING(x) STRINGIFY(x)

#if defined(NDEBUG)
# define KISS_FFT_LOG_MSG(severity, ...) ((void)0)
#else
# define KISS_FFT_LOG_MSG(severity, ...) \
    fprintf(stderr, "[" #severity "] " __FILE__ ":" TOSTRING(__LINE__) " "); \
    fprintf(stderr, __VA_ARGS__); \
    fprintf(stderr, "\n")
#endif

#define KISS_FFT_ERROR(...) KISS_FFT_LOG_MSG(ERROR, __VA_ARGS__)
#define KISS_FFT_WARNING(...) KISS_FFT_LOG_MSG(WARNING, __VA_ARGS__)
#define KISS_FFT_INFO(...) KISS_FFT_LOG_MSG(INFO, __VA_ARGS__)
#define KISS_FFT_DEBUG(...) KISS_FFT_LOG_MSG(DEBUG, __VA_ARGS__)

#endif /* kiss_fft_log_h */
