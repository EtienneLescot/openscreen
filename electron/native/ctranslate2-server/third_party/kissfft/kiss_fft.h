/*
  kiss_fft.h — vendored from mborgerding/kissfft v1.5.x (BSD-3-Clause).
  Local copy so we don't drag in another FetchContent for ~12 KB of code.

  See electron/native/ctranslate2-server/third_party/kissfft/LICENSE for the
  upstream license; our modifications, if any, are tracked in
  docs/engineering/stt-ctranslate2-migration.md.
*/
#ifndef KISS_FFT_H
#define KISS_FFT_H

#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include <string.h>

// Define KISS_FFT_SHARED macro to properly export symbols
#ifdef KISS_FFT_SHARED
# ifdef _WIN32
#  ifdef KISS_FFT_BUILD
#   define KISS_FFT_API __declspec(dllexport)
#  else
#   define KISS_FFT_API __declspec(dllimport)
#  endif
# else
#  define KISS_FFT_API __attribute__ ((visibility ("default")))
# endif
#else
# define KISS_FFT_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

# define KISS_FFT_ALIGN_CHECK(ptr)
# define KISS_FFT_ALIGN_SIZE_UP(size) (size)
# ifndef KISS_FFT_MALLOC
#  define KISS_FFT_MALLOC malloc
# endif
# ifndef KISS_FFT_FREE
#  define KISS_FFT_FREE free
# endif

# ifndef kiss_fft_scalar
#   define kiss_fft_scalar float
# endif

typedef struct {
    kiss_fft_scalar r;
    kiss_fft_scalar i;
}kiss_fft_cpx;

typedef struct kiss_fft_state* kiss_fft_cfg;

kiss_fft_cfg KISS_FFT_API kiss_fft_alloc(int nfft,int inverse_fft,void * mem,size_t * lenmem);

void KISS_FFT_API kiss_fft(kiss_fft_cfg cfg,const kiss_fft_cpx *fin,kiss_fft_cpx *fout);

void KISS_FFT_API kiss_fft_stride(kiss_fft_cfg cfg,const kiss_fft_cpx *fin,kiss_fft_cpx *fout,int in_stride);

#define kiss_fft_free KISS_FFT_FREE

void KISS_FFT_API kiss_fft_cleanup(void);

int KISS_FFT_API kiss_fft_next_fast_size(int n);

#define kiss_fftr_next_fast_size_real(n) \
        (kiss_fft_next_fast_size( ((n)+1)>>1)<<1)

#ifdef __cplusplus
}
#endif

#endif
