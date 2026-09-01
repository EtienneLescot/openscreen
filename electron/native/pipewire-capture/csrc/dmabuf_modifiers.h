#ifndef OSC_DMABUF_MODIFIERS_H
#define OSC_DMABUF_MODIFIERS_H

#include <stdint.h>

/*
 * Query the DRM format modifiers the local GPU's EGL stack can import for a
 * given DRM fourcc (e.g. XRGB8888). These are the modifiers we can legitimately
 * advertise to the compositor in the dmabuf EnumFormat: a compositor buffer
 * whose modifier is in this set is one we can hand to VAAPI. Fills `out` with up
 * to `max_out` modifiers and returns the count, or 0 when enumeration is
 * unavailable (no libEGL, no surfaceless platform, driver refuses) — in which
 * case the caller falls back to LINEAR/INVALID only.
 *
 * libEGL is loaded with dlopen, matching how this crate treats libpipewire: the
 * helper stays buildable and runnable on a box without EGL dev packages.
 */
int osc_query_dmabuf_modifiers(uint32_t fourcc, uint64_t *out, int max_out);

#endif
