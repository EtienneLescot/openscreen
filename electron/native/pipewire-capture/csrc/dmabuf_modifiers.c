#include "dmabuf_modifiers.h"

#include <dlfcn.h>
#include <stddef.h>

/*
 * Minimal EGL surface, spelled out rather than pulled from <EGL/egl.h> so the
 * build needs no EGL dev package (same reasoning as the DRM modifier constants
 * in pw_shim.c). libEGL itself is dlopen'd at runtime; if it is absent the
 * caller degrades to the LINEAR/INVALID offer.
 */
typedef void *EGLDisplay;
typedef unsigned int EGLBoolean;
typedef int EGLint;
typedef intptr_t EGLAttrib;
typedef uint64_t EGLuint64KHR;

#define OSC_EGL_TRUE 1
#define OSC_EGL_NO_DISPLAY ((EGLDisplay)0)
#define OSC_EGL_DEFAULT_DISPLAY ((void *)0)
/* EGL_MESA_platform_surfaceless — a display with no window system, exactly what
 * a one-shot capability query wants. */
#define OSC_EGL_PLATFORM_SURFACELESS_MESA 0x31DD

typedef void *(*osc_eglGetProcAddress)(const char *);
typedef EGLDisplay (*osc_eglGetPlatformDisplay)(EGLint platform, void *native,
                                                const EGLAttrib *attrib_list);
typedef EGLBoolean (*osc_eglInitialize)(EGLDisplay, EGLint *major, EGLint *minor);
typedef EGLBoolean (*osc_eglTerminate)(EGLDisplay);
typedef EGLBoolean (*osc_eglQueryDmaBufModifiersEXT)(EGLDisplay, EGLint format,
                                                     EGLint max_modifiers,
                                                     EGLuint64KHR *modifiers,
                                                     EGLBoolean *external_only,
                                                     EGLint *num_modifiers);

int osc_query_dmabuf_modifiers(uint32_t fourcc, uint64_t *out, int max_out)
{
    if (out == NULL || max_out <= 0) {
        return 0;
    }

    /* RTLD_NODELETE: EGL keeps process-global state, so never let dlclose run
     * its destructors — we deliberately do not dlclose at all. */
    void *egl = dlopen("libEGL.so.1", RTLD_NOW | RTLD_LOCAL | RTLD_NODELETE);
    if (egl == NULL) {
        return 0;
    }

    osc_eglGetProcAddress get_proc =
        (osc_eglGetProcAddress)dlsym(egl, "eglGetProcAddress");
    osc_eglInitialize egl_init = (osc_eglInitialize)dlsym(egl, "eglInitialize");
    osc_eglTerminate egl_terminate = (osc_eglTerminate)dlsym(egl, "eglTerminate");
    if (get_proc == NULL || egl_init == NULL || egl_terminate == NULL) {
        return 0;
    }

    osc_eglGetPlatformDisplay get_display =
        (osc_eglGetPlatformDisplay)get_proc("eglGetPlatformDisplayEXT");
    osc_eglQueryDmaBufModifiersEXT query_mods =
        (osc_eglQueryDmaBufModifiersEXT)get_proc("eglQueryDmaBufModifiersEXT");
    if (get_display == NULL || query_mods == NULL) {
        return 0;
    }

    EGLDisplay dpy = get_display(OSC_EGL_PLATFORM_SURFACELESS_MESA,
                                 OSC_EGL_DEFAULT_DISPLAY, NULL);
    if (dpy == OSC_EGL_NO_DISPLAY) {
        return 0;
    }
    if (egl_init(dpy, NULL, NULL) != OSC_EGL_TRUE) {
        return 0;
    }

    int written = 0;
    EGLint count = 0;
    if (query_mods(dpy, (EGLint)fourcc, 0, NULL, NULL, &count) == OSC_EGL_TRUE &&
        count > 0) {
        EGLuint64KHR mods[128];
        EGLBoolean external[128];
        EGLint cap = (EGLint)(sizeof(mods) / sizeof(mods[0]));
        if (count > cap) {
            count = cap;
        }
        if (query_mods(dpy, (EGLint)fourcc, count, mods, external, &count) ==
            OSC_EGL_TRUE) {
            for (EGLint i = 0; i < count && written < max_out; i++) {
                out[written++] = (uint64_t)mods[i];
            }
        }
    }

    egl_terminate(dpy);
    return written;
}
