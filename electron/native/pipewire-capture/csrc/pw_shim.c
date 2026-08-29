/*
 * PipeWire glue for the OpenScreen Linux capture helper.
 *
 * WHY THIS FILE IS C AND NOT RUST.
 *
 * Two thirds of the PipeWire/SPA API a consumer needs is not in the shared
 * object at all: `spa_pod_builder_*`, the `SPA_POD_CHOICE_*` macros,
 * `spa_format_video_raw_parse` and `spa_buffer_find_meta` are `static inline`
 * in the headers. Rust cannot call them, and re-implementing the POD builder in
 * Rust would mean restating a binary serialisation format by hand — exactly the
 * kind of thing AGENTS.md flags as security-sensitive. Compiling the real
 * headers keeps every struct layout and every POD byte in the hands of the
 * upstream code that defines them.
 *
 * WHY dlopen AND NOT -lpipewire-0.3.
 *
 * Ubuntu ships `libpipewire-0.3.so.0` in the base system but the `.so` link and
 * the headers only come with `libpipewire-0.3-dev`. Linking normally would put
 * a dev package in every contributor's and CI runner's critical path, and would
 * bake a hard DT_NEEDED into the helper so that it could not even start to
 * print a clean "PipeWire is not available" error. dlopen at runtime gives us
 * the vendored headers' ABI at compile time and a recoverable failure at run
 * time — the same trade the compositor addon makes with ffmpeg.
 *
 * The headers under ../vendor/ are PipeWire 1.0.5, MIT, unmodified. The ABI has
 * been stable across 0.3.x/1.x for everything used here (pw_stream, pw_context,
 * spa_meta_cursor), so a runtime with a different minor version is fine.
 */

#include <dlfcn.h>
#include <errno.h>
#include <linux/dma-buf.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#include <pipewire/pipewire.h>
#include <spa/buffer/meta.h>
#include <spa/param/video/format-utils.h>
#include <spa/pod/filter.h>
#include <spa/utils/result.h>

#include "pw_shim.h"

/* Defined next to osc_map_dmabuf; used earlier, at format negotiation. */
static int osc_debug_enabled(void);

#include "pw_internal.h"

#define OSC_PW_SONAME "libpipewire-0.3.so.0"

/*
 * DRM format modifiers, spelled out rather than pulled from <drm/drm_fourcc.h>.
 *
 * They are ABI constants — LINEAR has been 0 and INVALID has been
 * ((1ULL << 56) - 1) since the modifier API was introduced — and taking the
 * header would put libdrm-dev in the build path of every contributor and CI
 * runner for two integers. That is the same trade the dlopen above makes.
 *
 * These two are the ONLY modifiers this helper advertises, and the reason is
 * osc_map_dmabuf(): a linear or implicit buffer can be read through a plain
 * mmap of the dmabuf fd, while a tiled or compression-enabled one cannot — its
 * bytes are not in raster order, so handing them to the encoder would produce a
 * scrambled recording rather than an error. Anything else needs a real GPU
 * import (EGL/gbm), which this helper deliberately does not link.
 */
#define OSC_DRM_FORMAT_MOD_LINEAR 0ULL
#define OSC_DRM_FORMAT_MOD_INVALID 0x00ffffffffffffffULL

/*
 * Mapped dmabuf planes, keyed by (fd, mapoffset).
 *
 * PipeWire reuses a small, fixed buffer set for the life of a negotiation, so
 * the mapping is established once per buffer in add_buffer and torn down in
 * remove_buffer. Doing it per frame instead would mean an mmap and an munmap of
 * a full framebuffer 60 times a second.
 *
 * The bound matches the ceiling we ask for in SPA_PARAM_BUFFERS_buffers
 * (CHOICE_RANGE_Int(4, 2, 16)), with headroom; a compositor handing back more
 * than it was offered is a protocol violation, but the table refuses to overflow
 * rather than trusting that.
 */
#define OSC_MAX_DMABUF_MAPS 32
#define OSC_FRAME_DROP_REPORTS 5
#define OSC_VIDEO_BYTES_PER_PIXEL 4

struct osc_dmabuf_map {
    int fd;
    uint32_t mapoffset;
    void *ptr;
    size_t len;
    size_t refs;
};

/*
 * Cursor metadata budget: `struct spa_meta_cursor` + `struct spa_meta_bitmap` +
 * w*h*4 bytes of pixels.
 *
 * THE UPPER BOUND IS LOAD-BEARING, AND GETTING IT WRONG FAILS SILENTLY.
 *
 * PipeWire negotiates SPA_PARAM_Meta by intersecting the two ports' PODs
 * (spa_pod_filter). Producers declare SPA_PARAM_META_size as a FIXED
 * SPA_POD_Int, not a range — mutter 46.2 declares exactly
 * SPA_POD_Int(CURSOR_META_SIZE(384, 384)) = 589872 bytes
 * (src/backends/meta-screen-cast-stream-src.c). A consumer range that does not
 * CONTAIN that constant intersects to nothing, the whole ParamMeta object is
 * dropped, and the buffers simply arrive with no cursor metadata at all. There
 * is no error, no warning, and no clue: the stream negotiates and runs happily.
 *
 * This bit us. The original 256x256 ceiling (copied from PipeWire's own
 * video-play.c example, which targets cameras and never meets mutter) caps at
 * 262192 bytes — below mutter's 589872 — so every buffer came back with
 * hasCursorMeta=false. 1024x1024 = 4194352 bytes covers mutter's 384x384 and
 * leaves headroom for compositors with larger cursor planes; the range is only
 * an upper bound on what we accept, not an allocation we pay for.
 *
 * osc_pw_cursor_meta_accepts_producer_size() below turns this into something a
 * unit test can assert instead of something a maintainer rediscovers.
 */
#define OSC_CURSOR_META_SIZE(w, h) \
    (sizeof(struct spa_meta_cursor) + sizeof(struct spa_meta_bitmap) + \
     (size_t)(w) * (h) * OSC_VIDEO_BYTES_PER_PIXEL)

/*
 * How many buffers to describe before going quiet.
 *
 * One is not enough to answer the question this instrumentation exists for.
 * Metadata layout is fixed per buffer SET, so in theory one sample suffices —
 * but a single line cannot distinguish "the stream delivered one buffer and
 * died" from "the stream ran for a minute", and that ambiguity cost a debugging
 * round trip. A handful of lines makes stream liveness visible without turning
 * stdout into a firehose.
 */
#define OSC_BUFFER_INFO_REPORTS 5

/* Every libpipewire entry point the helper touches, resolved once by dlsym. */
struct osc_pw_api {
    void (*init)(int *argc, char ***argv);
    const char *(*get_library_version)(void);
    struct pw_thread_loop *(*thread_loop_new)(const char *name, const struct spa_dict *props);
    void (*thread_loop_destroy)(struct pw_thread_loop *loop);
    struct pw_loop *(*thread_loop_get_loop)(struct pw_thread_loop *loop);
    int (*thread_loop_start)(struct pw_thread_loop *loop);
    void (*thread_loop_stop)(struct pw_thread_loop *loop);
    void (*thread_loop_lock)(struct pw_thread_loop *loop);
    void (*thread_loop_unlock)(struct pw_thread_loop *loop);
    struct pw_context *(*context_new)(struct pw_loop *loop, struct pw_properties *props,
                                      size_t user_data_size);
    void (*context_destroy)(struct pw_context *context);
    struct pw_core *(*context_connect_fd)(struct pw_context *context, int fd,
                                          struct pw_properties *props, size_t user_data_size);
    int (*core_disconnect)(struct pw_core *core);
    struct pw_properties *(*properties_new)(const char *key, ...);
    struct pw_stream *(*stream_new)(struct pw_core *core, const char *name,
                                    struct pw_properties *props);
    void (*stream_destroy)(struct pw_stream *stream);
    void (*stream_add_listener)(struct pw_stream *stream, struct spa_hook *listener,
                                const struct pw_stream_events *events, void *data);
    int (*stream_connect)(struct pw_stream *stream, enum pw_direction direction,
                          uint32_t target_id, enum pw_stream_flags flags,
                          const struct spa_pod **params, uint32_t n_params);
    int (*stream_disconnect)(struct pw_stream *stream);
    struct pw_buffer *(*stream_dequeue_buffer)(struct pw_stream *stream);
    int (*stream_queue_buffer)(struct pw_stream *stream, struct pw_buffer *buffer);
    int (*stream_update_params)(struct pw_stream *stream, const struct spa_pod **params,
                                uint32_t n_params);
    const char *(*stream_state_as_string)(enum pw_stream_state state);
};

static struct osc_pw_api api;
static void *api_handle;

struct osc_pw_session {
    struct pw_thread_loop *loop;
    struct pw_context *context;
    struct pw_core *core;
    struct pw_stream *stream;
    struct spa_hook stream_listener;
    struct osc_pw_callbacks callbacks;
    struct spa_video_info_raw format;
    int buffer_info_reports;
    int want_video;
    /* Set from the negotiated format's SPA_VIDEO_FLAG_MODIFIER, which is what
     * decides whether buffers arrive as dmabuf fds or shared memory. */
    int uses_dmabuf;
    struct osc_dmabuf_map dmabuf_maps[OSC_MAX_DMABUF_MAPS];
    int frame_drop_reports;
    int capture_issue_reports;
    /* fd whose DMA_BUF_SYNC_START has not been closed by its END yet, or -1.
     * The bracket has to span the on_frame callback, not just osc_read_frame,
     * because the callback is where the pixels are actually read. */
    int dmabuf_sync_fd;
};

struct osc_pw_audio_api osc_audio_api;

/* The shared spelling pw_audio.c uses; `osc_set_error` below is the local
 * alias this file has always called. */
void osc_pw_set_error(char *err, size_t err_len, const char *format, ...)
{
    va_list args;

    if (err == NULL || err_len == 0) {
        return;
    }
    va_start(args, format);
    vsnprintf(err, err_len, format, args);
    va_end(args);
    err[err_len - 1] = '\0';
}

static void osc_set_error(char *err, size_t err_len, const char *format, ...)
{
    va_list args;

    if (err == NULL || err_len == 0) {
        return;
    }
    va_start(args, format);
    vsnprintf(err, err_len, format, args);
    va_end(args);
}

int osc_pw_load(char *err, size_t err_len)
{
    if (api_handle != NULL) {
        return 0;
    }

    api_handle = dlopen(OSC_PW_SONAME, RTLD_NOW | RTLD_LOCAL);
    if (api_handle == NULL) {
        osc_set_error(err, err_len, "%s could not be loaded: %s", OSC_PW_SONAME, dlerror());
        return -1;
    }

/* The `*(void **)&field` dance is the POSIX-blessed way to assign a dlsym
 * result to a function pointer without tripping -Wpedantic. */
#define OSC_LOAD(field, symbol)                                                       \
    do {                                                                              \
        *(void **)(&api.field) = dlsym(api_handle, symbol);                           \
        if (api.field == NULL) {                                                      \
            osc_set_error(err, err_len, "%s is missing symbol %s", OSC_PW_SONAME,     \
                          symbol);                                                    \
            dlclose(api_handle);                                                      \
            api_handle = NULL;                                                        \
            return -1;                                                                \
        }                                                                             \
    } while (0)

    OSC_LOAD(init, "pw_init");
    OSC_LOAD(get_library_version, "pw_get_library_version");
    OSC_LOAD(thread_loop_new, "pw_thread_loop_new");
    OSC_LOAD(thread_loop_destroy, "pw_thread_loop_destroy");
    OSC_LOAD(thread_loop_get_loop, "pw_thread_loop_get_loop");
    OSC_LOAD(thread_loop_start, "pw_thread_loop_start");
    OSC_LOAD(thread_loop_stop, "pw_thread_loop_stop");
    OSC_LOAD(thread_loop_lock, "pw_thread_loop_lock");
    OSC_LOAD(thread_loop_unlock, "pw_thread_loop_unlock");
    OSC_LOAD(context_new, "pw_context_new");
    OSC_LOAD(context_destroy, "pw_context_destroy");
    OSC_LOAD(context_connect_fd, "pw_context_connect_fd");
    OSC_LOAD(core_disconnect, "pw_core_disconnect");
    OSC_LOAD(properties_new, "pw_properties_new");
    OSC_LOAD(stream_new, "pw_stream_new");
    OSC_LOAD(stream_destroy, "pw_stream_destroy");
    OSC_LOAD(stream_add_listener, "pw_stream_add_listener");
    OSC_LOAD(stream_connect, "pw_stream_connect");
    OSC_LOAD(stream_disconnect, "pw_stream_disconnect");
    OSC_LOAD(stream_dequeue_buffer, "pw_stream_dequeue_buffer");
    OSC_LOAD(stream_queue_buffer, "pw_stream_queue_buffer");
    OSC_LOAD(stream_update_params, "pw_stream_update_params");
    OSC_LOAD(stream_state_as_string, "pw_stream_state_as_string");

/* The audio half's table. Same dlopen, same failure path: a libpipewire too old
 * to have one of these should be reported here, at load, and not halfway into a
 * recording. */
#define OSC_LOAD_AUDIO(field, symbol)                                                 \
    do {                                                                              \
        *(void **)(&osc_audio_api.field) = dlsym(api_handle, symbol);                 \
        if (osc_audio_api.field == NULL) {                                            \
            osc_set_error(err, err_len, "%s is missing symbol %s", OSC_PW_SONAME,     \
                          symbol);                                                    \
            dlclose(api_handle);                                                      \
            api_handle = NULL;                                                        \
            return -1;                                                                \
        }                                                                             \
    } while (0)

    OSC_LOAD_AUDIO(thread_loop_new, "pw_thread_loop_new");
    OSC_LOAD_AUDIO(thread_loop_destroy, "pw_thread_loop_destroy");
    OSC_LOAD_AUDIO(thread_loop_get_loop, "pw_thread_loop_get_loop");
    OSC_LOAD_AUDIO(thread_loop_start, "pw_thread_loop_start");
    OSC_LOAD_AUDIO(thread_loop_stop, "pw_thread_loop_stop");
    OSC_LOAD_AUDIO(thread_loop_lock, "pw_thread_loop_lock");
    OSC_LOAD_AUDIO(thread_loop_unlock, "pw_thread_loop_unlock");
    OSC_LOAD_AUDIO(context_new, "pw_context_new");
    OSC_LOAD_AUDIO(context_destroy, "pw_context_destroy");
    OSC_LOAD_AUDIO(context_connect, "pw_context_connect");
    OSC_LOAD_AUDIO(core_disconnect, "pw_core_disconnect");
    OSC_LOAD_AUDIO(properties_new, "pw_properties_new");
    OSC_LOAD_AUDIO(properties_set, "pw_properties_set");
    OSC_LOAD_AUDIO(stream_new, "pw_stream_new");
    OSC_LOAD_AUDIO(stream_destroy, "pw_stream_destroy");
    OSC_LOAD_AUDIO(stream_add_listener, "pw_stream_add_listener");
    OSC_LOAD_AUDIO(stream_connect, "pw_stream_connect");
    OSC_LOAD_AUDIO(stream_dequeue_buffer, "pw_stream_dequeue_buffer");
    OSC_LOAD_AUDIO(stream_queue_buffer, "pw_stream_queue_buffer");
    OSC_LOAD_AUDIO(stream_state_as_string, "pw_stream_state_as_string");
    OSC_LOAD_AUDIO(main_loop_new, "pw_main_loop_new");
    OSC_LOAD_AUDIO(main_loop_destroy, "pw_main_loop_destroy");
    OSC_LOAD_AUDIO(main_loop_get_loop, "pw_main_loop_get_loop");
    OSC_LOAD_AUDIO(main_loop_run, "pw_main_loop_run");
    OSC_LOAD_AUDIO(main_loop_quit, "pw_main_loop_quit");
    OSC_LOAD_AUDIO(proxy_destroy, "pw_proxy_destroy");

#undef OSC_LOAD_AUDIO
#undef OSC_LOAD

    api.init(NULL, NULL);
    return 0;
}

const char *osc_pw_library_version(void)
{
    return api_handle != NULL ? api.get_library_version() : NULL;
}

void osc_pw_constants(struct osc_pw_constants *out)
{
    out->video_format_rgbx = SPA_VIDEO_FORMAT_RGBx;
    out->video_format_bgrx = SPA_VIDEO_FORMAT_BGRx;
    out->video_format_xrgb = SPA_VIDEO_FORMAT_xRGB;
    out->video_format_xbgr = SPA_VIDEO_FORMAT_xBGR;
    out->video_format_rgba = SPA_VIDEO_FORMAT_RGBA;
    out->video_format_bgra = SPA_VIDEO_FORMAT_BGRA;
    out->video_format_argb = SPA_VIDEO_FORMAT_ARGB;
    out->video_format_abgr = SPA_VIDEO_FORMAT_ABGR;
    out->data_mem_ptr = SPA_DATA_MemPtr;
    out->data_mem_fd = SPA_DATA_MemFd;
    out->data_dma_buf = SPA_DATA_DmaBuf;
}

/*
 * Publish what we accept. The pixel format list is broad on purpose: Stage 1
 * never reads a pixel, and narrowing it would only make the compositor refuse
 * formats that Stage 2 may well want. What matters here is that the stream
 * negotiates at all, because SPA_META_Cursor rides on the video buffers.
 */
static const struct spa_pod *osc_build_enum_format(struct spa_pod_builder *builder)
{
    return spa_pod_builder_add_object(
        builder, SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat, SPA_FORMAT_mediaType,
        SPA_POD_Id(SPA_MEDIA_TYPE_video), SPA_FORMAT_mediaSubtype,
        SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw), SPA_FORMAT_VIDEO_format,
        /* SPA_POD_CHOICE_ENUM counts the DEFAULT plus the alternatives, and the
         * default is repeated as the first alternative. BGRx appearing twice is
         * the idiom, not a typo: 5 values = default BGRx + {BGRx,RGBx,BGRA,RGBA}. */
        SPA_POD_CHOICE_ENUM_Id(5, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRx,
                               SPA_VIDEO_FORMAT_RGBx, SPA_VIDEO_FORMAT_BGRA,
                               SPA_VIDEO_FORMAT_RGBA),
        SPA_FORMAT_VIDEO_size,
        SPA_POD_CHOICE_RANGE_Rectangle(&SPA_RECTANGLE(1920, 1080), &SPA_RECTANGLE(1, 1),
                                       &SPA_RECTANGLE(16384, 16384)),
        SPA_FORMAT_VIDEO_framerate,
        SPA_POD_CHOICE_RANGE_Fraction(&SPA_FRACTION(30, 1), &SPA_FRACTION(0, 1),
                                      &SPA_FRACTION(240, 1)));
}

/*
 * The same format, plus SPA_FORMAT_VIDEO_modifier — and the modifier property is
 * the entire reason this second object exists.
 *
 * WHAT BREAKS WITHOUT IT. A compositor that can only produce DMA-BUF publishes
 * its EnumFormat with `VideoModifier` carrying SPA_POD_PROP_FLAG_MANDATORY.
 * spa_pod_filter treats a mandatory producer property that the consumer does not
 * mention as fatal for the WHOLE object:
 *
 *     else if ((p1->flags & SPA_POD_PROP_FLAG_MANDATORY) != 0)
 *             res = -EINVAL;                     (spa/pod/filter.h:352)
 *
 * so every one of its formats is filtered out and the link dies reporting
 * "no more input formats" — issue #287, niri on Arch, reproduced against the
 * vendored headers by osc_pw_enum_format_accepts_dmabuf_producer() below.
 * mutter is not affected because it publishes shm pods too, several of them
 * without any modifier at all.
 *
 * ORDER IS THE SAFETY PROPERTY. osc_pw_start sends the shm object FIRST and this
 * one second, and pw_stream keeps that as a preference order. A compositor that
 * can do shared memory therefore still negotiates shared memory, exactly as
 * before this object existed — GNOME and KDE are bit-for-bit unchanged. Only a
 * producer with nothing to offer but DMA-BUF reaches this fallback.
 *
 * NO SPA_POD_PROP_FLAG_DONT_FIXATE. That flag asks the producer to leave the
 * modifier unresolved so the consumer can pick one after querying its GPU, and
 * it obliges us to renegotiate with a fixated format. We advertise exactly two
 * modifiers, both of which are readable through a plain mmap and neither of
 * which needs a GPU query, so letting the producer fixate is both simpler and
 * one fewer round trip that can go wrong.
 */
static const struct spa_pod *osc_build_enum_format_dmabuf(struct spa_pod_builder *builder)
{
    struct spa_pod_frame object_frame;
    struct spa_pod_frame choice_frame;

    spa_pod_builder_push_object(builder, &object_frame, SPA_TYPE_OBJECT_Format,
                                SPA_PARAM_EnumFormat);
    spa_pod_builder_add(builder, SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video),
                        SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
                        SPA_FORMAT_VIDEO_format,
                        SPA_POD_CHOICE_ENUM_Id(5, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRx,
                                               SPA_VIDEO_FORMAT_RGBx, SPA_VIDEO_FORMAT_BGRA,
                                               SPA_VIDEO_FORMAT_RGBA),
                        0);

    /* Built with the explicit prop/choice calls rather than the varargs macro
     * because the macro has no way to set a property flag, and MANDATORY here is
     * what tells the producer we genuinely handle modifiers rather than merely
     * tolerating the key. */
    spa_pod_builder_prop(builder, SPA_FORMAT_VIDEO_modifier, SPA_POD_PROP_FLAG_MANDATORY);
    spa_pod_builder_push_choice(builder, &choice_frame, SPA_CHOICE_Enum, 0);
    /* Default first, then every alternative — the default is repeated, same
     * idiom as SPA_POD_CHOICE_ENUM_Id above. */
    spa_pod_builder_long(builder, (int64_t)OSC_DRM_FORMAT_MOD_LINEAR);
    spa_pod_builder_long(builder, (int64_t)OSC_DRM_FORMAT_MOD_LINEAR);
    spa_pod_builder_long(builder, (int64_t)OSC_DRM_FORMAT_MOD_INVALID);
    spa_pod_builder_pop(builder, &choice_frame);

    spa_pod_builder_add(
        builder, SPA_FORMAT_VIDEO_size,
        SPA_POD_CHOICE_RANGE_Rectangle(&SPA_RECTANGLE(1920, 1080), &SPA_RECTANGLE(1, 1),
                                       &SPA_RECTANGLE(16384, 16384)),
        SPA_FORMAT_VIDEO_framerate,
        SPA_POD_CHOICE_RANGE_Fraction(&SPA_FRACTION(30, 1), &SPA_FRACTION(0, 1),
                                      &SPA_FRACTION(240, 1)),
        0);

    return spa_pod_builder_pop(builder, &object_frame);
}

/*
 * The consumer side of the SPA_META_Cursor negotiation, in one place so the
 * bytes a unit test checks are literally the bytes sent on the wire.
 */
static const struct spa_pod *osc_build_cursor_meta(struct spa_pod_builder *builder)
{
    return spa_pod_builder_add_object(
        builder, SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta, SPA_PARAM_META_type,
        SPA_POD_Id(SPA_META_Cursor), SPA_PARAM_META_size,
        SPA_POD_CHOICE_RANGE_Int((int32_t)OSC_CURSOR_META_SIZE(64, 64),
                                 (int32_t)OSC_CURSOR_META_SIZE(1, 1),
                                 (int32_t)OSC_CURSOR_META_SIZE(1024, 1024)));
}

/*
 * The consumer side of the SPA_META_VideoCrop negotiation.
 *
 * THIS DECLARATION IS THE WHOLE POINT. `pw_buffers_negotiate` intersects the two
 * sides' ParamMeta lists, and mutter writes the rectangle only inside
 * `if (spa_meta_video_crop)` — so a consumer that never asks is simply never
 * given one, with no error and nothing in any log. Omitting this object is what
 * made a window arrive as a monitor-sized buffer with the window in one corner.
 *
 * A FIXED Int, never a CHOICE_RANGE: that is what OBS, WebRTC and mutter's own
 * producer declaration all emit, so a range here could only fail to intersect.
 */
static const struct spa_pod *osc_build_video_crop_meta(struct spa_pod_builder *builder)
{
    return spa_pod_builder_add_object(builder, SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta,
                                      SPA_PARAM_META_type, SPA_POD_Id(SPA_META_VideoCrop),
                                      SPA_PARAM_META_size,
                                      SPA_POD_Int(sizeof(struct spa_meta_region)));
}

int osc_pw_cursor_meta_accepts_producer_size(uint32_t width, uint32_t height)
{
    uint8_t ours_storage[512];
    uint8_t theirs_storage[512];
    uint8_t result_storage[512];
    struct spa_pod_builder ours = SPA_POD_BUILDER_INIT(ours_storage, sizeof(ours_storage));
    struct spa_pod_builder theirs = SPA_POD_BUILDER_INIT(theirs_storage, sizeof(theirs_storage));
    struct spa_pod_builder result = SPA_POD_BUILDER_INIT(result_storage, sizeof(result_storage));
    struct spa_pod *filtered = NULL;
    const struct spa_pod *consumer;
    const struct spa_pod *producer;

    consumer = osc_build_cursor_meta(&ours);
    /* Exactly how a compositor declares it: a FIXED size, not a range. */
    producer = spa_pod_builder_add_object(
        &theirs, SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta, SPA_PARAM_META_type,
        SPA_POD_Id(SPA_META_Cursor), SPA_PARAM_META_size,
        SPA_POD_Int((int32_t)OSC_CURSOR_META_SIZE(width, height)));
    if (consumer == NULL || producer == NULL) {
        return -1;
    }

    /* The same call pw_impl_link uses to intersect the two ports' params. A
     * negative result means the objects do not intersect, which is precisely the
     * failure mode that leaves buffers with no cursor metadata. */
    return spa_pod_filter(&result, &filtered, producer, consumer) < 0 ? 0 : 1;
}

/*
 * Reproduces issue #287 offline: run spa_pod_filter against a producer object
 * shaped the way a DMA-BUF-only compositor publishes one, and report whether our
 * EnumFormat survives it.
 *
 * `with_modifier` selects which of our two objects to test, so the test can
 * assert both halves of the contract — the shm object must still be rejected by
 * such a producer (otherwise the second object would be pointless and the
 * ordering argument in osc_build_enum_format_dmabuf would be untested), and the
 * dmabuf object must be accepted.
 *
 * The producer's modifier property carries SPA_POD_PROP_FLAG_MANDATORY, which is
 * what niri emits (src/screencasting/pw_utils.rs) and what turns a missing
 * consumer property into -EINVAL for the entire object rather than a merely
 * narrower intersection.
 */
int osc_pw_enum_format_accepts_dmabuf_producer(int with_modifier, int64_t producer_modifier)
{
    uint8_t ours_storage[1024];
    uint8_t theirs_storage[1024];
    uint8_t result_storage[2048];
    struct spa_pod_builder ours = SPA_POD_BUILDER_INIT(ours_storage, sizeof(ours_storage));
    struct spa_pod_builder theirs = SPA_POD_BUILDER_INIT(theirs_storage, sizeof(theirs_storage));
    struct spa_pod_builder result = SPA_POD_BUILDER_INIT(result_storage, sizeof(result_storage));
    struct spa_pod_frame object_frame;
    struct spa_pod_frame choice_frame;
    struct spa_pod *filtered = NULL;
    const struct spa_pod *consumer;
    const struct spa_pod *producer;

    consumer = with_modifier ? osc_build_enum_format_dmabuf(&ours) : osc_build_enum_format(&ours);
    if (consumer == NULL) {
        return -1;
    }

    spa_pod_builder_push_object(&theirs, &object_frame, SPA_TYPE_OBJECT_Format,
                                SPA_PARAM_EnumFormat);
    spa_pod_builder_add(&theirs, SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video),
                        SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
                        SPA_FORMAT_VIDEO_format, SPA_POD_Id(SPA_VIDEO_FORMAT_BGRx), 0);
    spa_pod_builder_prop(&theirs, SPA_FORMAT_VIDEO_modifier, SPA_POD_PROP_FLAG_MANDATORY);
    spa_pod_builder_push_choice(&theirs, &choice_frame, SPA_CHOICE_Enum, 0);
    spa_pod_builder_long(&theirs, producer_modifier);
    spa_pod_builder_long(&theirs, producer_modifier);
    spa_pod_builder_pop(&theirs, &choice_frame);
    spa_pod_builder_add(&theirs, SPA_FORMAT_VIDEO_size, SPA_POD_Rectangle(&SPA_RECTANGLE(2560, 1080)),
                        SPA_FORMAT_VIDEO_framerate, SPA_POD_Fraction(&SPA_FRACTION(59978, 1000)),
                        0);
    producer = spa_pod_builder_pop(&theirs, &object_frame);
    if (producer == NULL) {
        return -1;
    }

    return spa_pod_filter(&result, &filtered, producer, consumer) < 0 ? 0 : 1;
}

static void osc_on_param_changed(void *userdata, uint32_t id, const struct spa_pod *param)
{
    struct osc_pw_session *session = userdata;
    uint8_t buffer[1024];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    const struct spa_pod *params[4];
    struct osc_pw_format reported;
    uint32_t media_type;
    uint32_t media_subtype;

    if (param == NULL || id != SPA_PARAM_Format) {
        return;
    }
    if (spa_format_parse(param, &media_type, &media_subtype) < 0) {
        return;
    }
    if (media_type != SPA_MEDIA_TYPE_video || media_subtype != SPA_MEDIA_SUBTYPE_raw) {
        return;
    }
    if (spa_format_video_raw_parse(param, &session->format) < 0) {
        return;
    }
    reported.width = (int32_t)session->format.size.width;
    reported.height = (int32_t)session->format.size.height;
    reported.video_format = session->format.format;
    reported.framerate_num = (int32_t)session->format.framerate.num;
    reported.framerate_denom = (int32_t)session->format.framerate.denom;
    if (session->callbacks.on_format != NULL) {
        session->callbacks.on_format(session->callbacks.user, &reported);
    }

    /*
     * The negotiated format tells us which kind of buffer to ask for. A format
     * carrying SPA_VIDEO_FLAG_MODIFIER came from the DMA-BUF EnumFormat object,
     * so the producer is going to hand out dmabuf fds and asking for shared
     * memory would intersect to nothing.
     */
    session->uses_dmabuf = (session->format.flags & SPA_VIDEO_FLAG_MODIFIER) != 0;

    if (osc_debug_enabled()) {
        fprintf(stderr, "[osc-dmabuf] negotiated %ux%u uses_dmabuf=%d modifier=0x%llx\n",
                session->format.size.width, session->format.size.height, session->uses_dmabuf,
                (unsigned long long)session->format.modifier);
    }

    /*
     * No `size`/`stride` constraint is published: the compositor's own choice is
     * fine, and osc_read_frame validates whatever comes back.
     *
     * The dataType set differs by mode, and the difference is load-bearing.
     * Cursor-only advertises everything, so that on_buffer_info reports what the
     * compositor would PREFER rather than what we forced it into.
     *
     * Video mode follows the format that was just negotiated. It used to
     * advertise shared memory unconditionally, on the reasoning that "not
     * offering DmaBuf is what makes the compositor fall back to memfd" — true of
     * mutter and KWin, false of a compositor with no memfd path at all, which is
     * the case of issue #287. Against those, this is the second wall behind the
     * EnumFormat modifier: fixing only the format would move the failure from
     * "no more input formats" to an empty buffer intersection.
     *
     * Not "every Smithay/wlroots compositor", as this comment used to claim:
     * sway 1.9 through xdg-desktop-portal-wlr negotiates WL_SHM here and takes
     * the memfd path like GNOME does (measured 2026-08-09). Reproducing the
     * DMA-BUF path locally needs OPENSCREEN_PIPEWIRE_FORCE_DMABUF below.
     *
     * pw_stream still does not map dmabuf itself even with
     * PW_STREAM_FLAG_MAP_BUFFERS, so `datas[0].data` stays NULL and the mapping
     * is ours to do — see osc_map_dmabuf and osc_on_add_buffer.
     */
    params[0] = spa_pod_builder_add_object(
        &builder, SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers, SPA_PARAM_BUFFERS_buffers,
        SPA_POD_CHOICE_RANGE_Int(4, 2, 16), SPA_PARAM_BUFFERS_blocks, SPA_POD_Int(1),
        SPA_PARAM_BUFFERS_dataType,
        SPA_POD_CHOICE_FLAGS_Int(
            session->want_video
                ? (session->uses_dmabuf ? (1 << SPA_DATA_DmaBuf)
                                        : ((1 << SPA_DATA_MemPtr) | (1 << SPA_DATA_MemFd)))
                : ((1 << SPA_DATA_MemPtr) | (1 << SPA_DATA_MemFd) | (1 << SPA_DATA_DmaBuf))));

    params[1] = spa_pod_builder_add_object(
        &builder, SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta, SPA_PARAM_META_type,
        SPA_POD_Id(SPA_META_Header), SPA_PARAM_META_size,
        SPA_POD_Int(sizeof(struct spa_meta_header)));

    params[2] = osc_build_cursor_meta(&builder);
    params[3] = osc_build_video_crop_meta(&builder);

    /* The builder returns NULL if its fixed buffer overflowed. 1 KiB is far more
     * than these four objects need, but handing NULLs to update_params would be
     * a null deref inside libpipewire, so it is checked rather than assumed. */
    if (params[0] == NULL || params[1] == NULL || params[2] == NULL || params[3] == NULL) {
        return;
    }

    /* Buffers are reallocated on renegotiation, and the metadata layout comes
     * with them. Re-arm the reports so the instrumentation describes the buffer
     * set actually in use rather than a set that no longer exists. */
    session->buffer_info_reports = 0;
    session->frame_drop_reports = 0;
    session->capture_issue_reports = 0;

    api.stream_update_params(session->stream, params, SPA_N_ELEMENTS(params));
}

/*
 * Map a dmabuf fd for CPU reads.
 *
 * This is the cheap import, and it is only correct because of what
 * osc_build_enum_format_dmabuf advertises. A dmabuf whose modifier is LINEAR or
 * INVALID is in raster order, so the bytes behind a plain mmap are the bytes the
 * encoder wants. A tiled or DCC-compressed buffer is not, and reading one this
 * way yields a scrambled image rather than a failure — which is exactly why
 * those modifiers are never offered. The real alternative is an EGL/gbm import,
 * a GPU context and two more link-time dependencies in a helper that
 * deliberately dlopens everything.
 *
 * mmap on a dmabuf fd is optional for the exporter (it requires a .mmap in the
 * dma_buf_ops), so this can legitimately fail on some drivers. It returns NULL
 * and the caller turns that into a visible error rather than a black recording.
 */
/*
 * Opt-in tracing for the DMA-BUF path, off unless OPENSCREEN_PIPEWIRE_DEBUG is
 * set. This path never runs under mutter, which hands out memfd, so on a GNOME
 * machine there is otherwise no way to tell whether a capture exercised it at
 * all — the helper reports the same success either way.
 */
static int osc_debug_enabled(void)
{
    static int cached = -1;

    if (cached < 0) {
        const char *value = getenv("OPENSCREEN_PIPEWIRE_DEBUG");
        cached = (value != NULL && value[0] != '\0') ? 1 : 0;
    }
    return cached;
}

int osc_pw_dmabuf_mapped_len(size_t allocation_len, uint32_t mapoffset, size_t *mapped_len)
{
    if (mapped_len == NULL || (size_t)mapoffset >= allocation_len) {
        return 0;
    }
    *mapped_len = allocation_len - (size_t)mapoffset;
    return 1;
}

static void *osc_map_dmabuf(int fd, uint32_t data_flags, uint32_t mapoffset, size_t *len,
                            const char **why)
{
    void *ptr;
    off_t probed;

    if (fd < 0) {
        *why = "the compositor handed us a DMA-BUF plane with no file descriptor";
        return NULL;
    }
    /*
     * A DmaBuf plane can carry an advisory maxsize rather than its allocation
     * length. The allocation size is a property of the exporting fd — dma_buf's
     * llseek returns exactly dmabuf->size — so when the fd answers, it is the
     * authority and maxsize is not.
     *
     * It has to win in BOTH directions. Preferring it only when it is LARGER
     * leaves an over-declared maxsize as the mmap length, and the kernel refuses
     * a dmabuf mapping longer than the object (-EINVAL), so the import dies
     * reporting a driver that will not map — which is precisely the misdiagnosis
     * this code exists to stop, with the right answer already in hand.
     */
    probed = lseek(fd, 0, SEEK_END);
    if (probed > 0 && (uintmax_t)probed <= SIZE_MAX) {
        size_t advertised = *len;

        if (!osc_pw_dmabuf_mapped_len((size_t)probed, mapoffset, len)) {
            *why = "the DMA-BUF plane's mapoffset is outside the fd allocation";
            return NULL;
        }
        if (advertised != *len && osc_debug_enabled()) {
            fprintf(stderr,
                    "[osc-dmabuf] maxsize=%zu, fd reports %jd bytes, mapoffset=%u, "
                    "mapped_len=%zu\n",
                    advertised, (intmax_t)probed, mapoffset, *len);
        }
    }
    if (*len == 0) {
        if (osc_debug_enabled()) {
            fprintf(stderr, "[osc-dmabuf] refused before mmap: fd=%d, size unknown\n", fd);
        }
        *why = "the DMA-BUF plane reports no size and its fd is not seekable";
        return NULL;
    }
    ptr = mmap(NULL, *len, PROT_READ, MAP_SHARED, fd, (off_t)mapoffset);
    if (osc_debug_enabled()) {
        if (ptr == MAP_FAILED) {
            fprintf(stderr,
                    "[osc-dmabuf] mmap fd=%d mapoffset=%u len=%zu FAILED errno=%d (%s)\n", fd,
                    mapoffset, *len, errno, strerror(errno));
        } else {
            fprintf(stderr, "[osc-dmabuf] mmap fd=%d mapoffset=%u len=%zu ok\n", fd, mapoffset,
                    *len);
        }
    }
    if (ptr == MAP_FAILED) {
        /* The producer already answered this question. SPA_DATA_FLAG_MAPPABLE
         * exists because "some memory types are not simply mappable (DmaBuf)
         * unless explicitly specified with this flag" — so when it is unset,
         * blaming the GPU driver sends the reader somewhere else entirely. */
        *why = SPA_FLAG_IS_SET(data_flags, SPA_DATA_FLAG_MAPPABLE)
                   ? "this driver does not allow CPU mapping of the capture buffer"
                   : "the compositor did not mark this DMA-BUF plane mappable "
                     "(SPA_DATA_FLAG_MAPPABLE unset)";
    }
    return ptr == MAP_FAILED ? NULL : ptr;
}

static struct osc_dmabuf_map *osc_find_dmabuf_map(struct osc_pw_session *session, int fd,
                                                   uint32_t mapoffset)
{
    size_t i;

    for (i = 0; i < OSC_MAX_DMABUF_MAPS; i++) {
        if (session->dmabuf_maps[i].ptr != NULL && session->dmabuf_maps[i].fd == fd &&
            session->dmabuf_maps[i].mapoffset == mapoffset) {
            return &session->dmabuf_maps[i];
        }
    }
    return NULL;
}

static void osc_retain_dmabuf_map(struct osc_dmabuf_map *map)
{
    map->refs++;
}

static int osc_release_dmabuf_map(struct osc_dmabuf_map *map)
{
    if (map->refs > 1) {
        map->refs--;
        return 0;
    }
    return 1;
}

int osc_pw_dmabuf_map_lifecycle_valid(void)
{
    struct osc_pw_session session;
    struct osc_dmabuf_map *map;

    memset(&session, 0, sizeof(session));
    map = &session.dmabuf_maps[0];
    map->fd = 7;
    map->mapoffset = 4096;
    map->ptr = (void *)(uintptr_t)1;
    map->len = 8192;
    map->refs = 1;

    if (osc_find_dmabuf_map(&session, 7, 4096) != map ||
        osc_find_dmabuf_map(&session, 7, 0) != NULL) {
        return 0;
    }
    osc_retain_dmabuf_map(map);
    if (map->refs != 2 || osc_release_dmabuf_map(map) != 0 || map->refs != 1) {
        return 0;
    }
    return osc_release_dmabuf_map(map) == 1;
}

enum osc_frame_bounds_error {
    OSC_FRAME_BOUNDS_OK,
    /* Not a failure: a buffer carrying metadata and no pixel rows. */
    OSC_FRAME_BOUNDS_METADATA_ONLY,
    OSC_FRAME_BOUNDS_NO_CAPACITY,
    OSC_FRAME_BOUNDS_OFFSET,
    OSC_FRAME_BOUNDS_CORRUPTED,
    OSC_FRAME_BOUNDS_GEOMETRY,
    OSC_FRAME_BOUNDS_ROW_TOO_SHORT,
    OSC_FRAME_BOUNDS_FRAME_TOO_LARGE,
};

static enum osc_frame_bounds_error osc_resolve_frame_bounds(
    uint32_t data_type, uint32_t maxsize, size_t mapped_len, uint32_t chunk_offset,
    uint32_t chunk_size, int32_t chunk_flags, int32_t stride, int32_t width, int32_t height,
    size_t *available_out, size_t *offset_out, size_t *size_out)
{
    size_t available;
    size_t offset;
    size_t size;
    uint64_t row_bytes;
    uint64_t frame_bytes;

    available = data_type == SPA_DATA_DmaBuf ? mapped_len : (size_t)maxsize;
    *available_out = available;
    /* Unlike advisory chunk_size, stride distinguishes metadata-only buffers. */
    if (stride == 0) {
        return OSC_FRAME_BOUNDS_METADATA_ONLY;
    }
    if (available == 0) {
        return OSC_FRAME_BOUNDS_NO_CAPACITY;
    }
    offset = chunk_offset;
    if (offset > available) {
        return OSC_FRAME_BOUNDS_OFFSET;
    }
    if (SPA_FLAG_IS_SET(chunk_flags, SPA_CHUNK_FLAG_CORRUPTED)) {
        return OSC_FRAME_BOUNDS_CORRUPTED;
    }
    if (stride < 0 || width <= 0 || height <= 0) {
        return OSC_FRAME_BOUNDS_GEOMETRY;
    }
    row_bytes = (uint64_t)width * OSC_VIDEO_BYTES_PER_PIXEL;
    if ((uint64_t)stride < row_bytes) {
        return OSC_FRAME_BOUNDS_ROW_TOO_SHORT;
    }
    /* Widen before multiplying: both operands originate outside this process. */
    frame_bytes = (uint64_t)stride * (uint64_t)height;
    /* DMA-BUF chunk_size is advisory; shared-memory chunk_size is a bound. */
    if (data_type == SPA_DATA_DmaBuf) {
        size = available - offset;
    } else {
        /* Offset was validated above, so this subtraction cannot underflow. */
        size = SPA_MIN((size_t)chunk_size, available - offset);
    }
    if (frame_bytes > (uint64_t)size) {
        return OSC_FRAME_BOUNDS_FRAME_TOO_LARGE;
    }
    *offset_out = offset;
    *size_out = size;
    return OSC_FRAME_BOUNDS_OK;
}

static const char *osc_frame_bounds_error_name(enum osc_frame_bounds_error error)
{
    switch (error) {
    case OSC_FRAME_BOUNDS_METADATA_ONLY:
        return "metadata-only";
    case OSC_FRAME_BOUNDS_NO_CAPACITY:
        return "buffer-length-zero";
    case OSC_FRAME_BOUNDS_OFFSET:
        return "chunk-offset-out-of-bounds";
    case OSC_FRAME_BOUNDS_CORRUPTED:
        return "producer-marked-frame-corrupted";
    case OSC_FRAME_BOUNDS_GEOMETRY:
        return "invalid-frame-geometry";
    case OSC_FRAME_BOUNDS_ROW_TOO_SHORT:
        return "stride-shorter-than-row";
    case OSC_FRAME_BOUNDS_FRAME_TOO_LARGE:
        return "frame-bytes-exceed-available-chunk";
    case OSC_FRAME_BOUNDS_OK:
        return "none";
    }
    return "unknown";
}

const char *osc_pw_frame_bounds_reason(uint32_t data_type, uint32_t maxsize, size_t mapped_len,
                                       uint32_t chunk_offset, uint32_t chunk_size,
                                       int32_t chunk_flags, int32_t stride, int32_t width,
                                       int32_t height)
{
    size_t available = 0;
    size_t offset = 0;
    size_t size = 0;

    return osc_frame_bounds_error_name(osc_resolve_frame_bounds(
        data_type, maxsize, mapped_len, chunk_offset, chunk_size, chunk_flags, stride, width,
        height, &available, &offset, &size));
}

static const char *osc_data_type_name(uint32_t data_type)
{
    switch (data_type) {
    case SPA_DATA_MemPtr:
        return "MemPtr";
    case SPA_DATA_MemFd:
        return "MemFd";
    case SPA_DATA_DmaBuf:
        return "DmaBuf";
    default:
        return "Unknown";
    }
}

/*
 * The chunk fields arrive as values, not as a `chunk` pointer to re-read. This
 * only ever runs when the producer has already misbehaved, which is exactly the
 * moment it may be rewriting that struct; reading it a second time here would
 * let the line describe a frame other than the one that was refused.
 */
static void osc_report_frame_drop(struct osc_pw_session *session, const struct spa_data *data,
                                  size_t mapped_len, size_t available, uint32_t chunk_offset,
                                  uint32_t chunk_size, int32_t chunk_flags, int32_t stride,
                                  enum osc_frame_bounds_error error)
{
    const char *reason = osc_frame_bounds_error_name(error);

    if (session->frame_drop_reports >= OSC_FRAME_DROP_REPORTS) {
        return;
    }
    session->frame_drop_reports++;

    /*
     * On the event stream, not only in a debug log. Every reason this reports is
     * decided by stride, geometry and the mapped length, all of which are fixed
     * for a whole negotiation — so a buffer that fails once fails every time and
     * the user gets a recording with no frames in it. Nothing downstream can
     * name the cause: a refused frame never reaches the mailbox, so the
     * frames-dropped counter stays at zero and the session still stops
     * "successfully". Requiring OPENSCREEN_PIPEWIRE_DEBUG and a reproduction to
     * learn why is the diagnosis gap this whole change set exists to close.
     */
    if (session->callbacks.on_capture_issue != NULL) {
        char detail[320];

        snprintf(detail, sizeof(detail),
                 "the compositor's buffer failed validation (%s), so this frame was dropped: "
                 "dataType=%s stride=%d width=%u height=%u chunkOffset=%u chunkSize=%u "
                 "available=%zu",
                 reason, osc_data_type_name(data->type), stride, session->format.size.width,
                 session->format.size.height, chunk_offset, chunk_size, available);
        session->callbacks.on_capture_issue(session->callbacks.user, "frame-dropped", detail);
    }
    if (osc_debug_enabled()) {
        fprintf(stderr,
                "[osc-frame-drop] reason=%s data_type=%s data_type_id=%u fd=%lld maxsize=%u "
                "mapped_len=%zu available_len=%zu chunk_offset=%u chunk_size=%u "
                "chunk_flags=%d stride=%d width=%u height=%u format=%u\n",
                reason, osc_data_type_name(data->type), data->type, (long long)data->fd,
                data->maxsize, mapped_len, available, chunk_offset, chunk_size, chunk_flags, stride,
                session->format.size.width, session->format.size.height, session->format.format);
    }
}

/*
 * CPU access to a dmabuf has to be bracketed by DMA_BUF_IOCTL_SYNC, or the
 * driver is under no obligation to have flushed the GPU's writes into the
 * mapping. Skipping it does not fail — it tears, intermittently, which is the
 * worst way for this to be wrong.
 *
 * Best-effort by design: a driver that does not implement the ioctl returns
 * ENOTTY, and refusing the frame over that would be worse than reading it.
 */
static void osc_dmabuf_sync(int fd, int start)
{
    struct dma_buf_sync sync;

    if (fd < 0) {
        return;
    }
    memset(&sync, 0, sizeof(sync));
    sync.flags = (start ? DMA_BUF_SYNC_START : DMA_BUF_SYNC_END) | DMA_BUF_SYNC_READ;
    while (ioctl(fd, DMA_BUF_IOCTL_SYNC, &sync) == -1 && errno == EINTR) {
        /* retry */
    }
}

static void osc_report_capture_issue(struct osc_pw_session *session, const char *code,
                                     const char *detail)
{
    if (session->callbacks.on_capture_issue == NULL ||
        session->capture_issue_reports >= OSC_BUFFER_INFO_REPORTS) {
        return;
    }
    session->capture_issue_reports++;
    session->callbacks.on_capture_issue(session->callbacks.user, code, detail);
}

static void osc_on_add_buffer(void *userdata, struct pw_buffer *pw_buf)
{
    struct osc_pw_session *session = userdata;
    const char *why = "unknown reason";
    struct osc_dmabuf_map *existing;
    struct spa_data *data;
    size_t maplen;
    size_t i;

    if (pw_buf == NULL || pw_buf->buffer == NULL || pw_buf->buffer->n_datas < 1) {
        return;
    }
    data = &pw_buf->buffer->datas[0];
    if (data->type != SPA_DATA_DmaBuf) {
        return;
    }
    /* References keep a shared plane mapped until its last buffer is removed. */
    existing = osc_find_dmabuf_map(session, (int)data->fd, data->mapoffset);
    if (existing != NULL) {
        osc_retain_dmabuf_map(existing);
        return;
    }

    for (i = 0; i < OSC_MAX_DMABUF_MAPS; i++) {
        if (session->dmabuf_maps[i].ptr != NULL) {
            continue;
        }
        /* `maxsize` is a starting point, not the answer: osc_map_dmabuf prefers
         * the length the fd itself reports, because a DmaBuf plane can carry an
         * advisory maxsize — wlroots leaves it at 0 — rather than its allocation
         * length. It reports back the length actually mapped, and THAT is what
         * every later bounds check measures against. */
        maplen = data->maxsize;
        session->dmabuf_maps[i].ptr =
            osc_map_dmabuf((int)data->fd, data->flags, data->mapoffset, &maplen, &why);
        if (session->dmabuf_maps[i].ptr == NULL) {
            /* Reported once, on the event stream: a mapping failure here means
             * no frames at all, and silence would read as a hang.
             *
             * The reason is carried up rather than assumed. This used to say the
             * driver refused CPU mapping no matter what actually went wrong, and
             * that message sent the one real investigation of this path looking
             * at the GPU for a size the compositor had simply left at 0. */
            char detail[256];

            snprintf(detail, sizeof(detail), "dmabuf import failed: %s; capture cannot proceed",
                     why);
            osc_report_capture_issue(session, "dmabuf-import-failed", detail);
            return;
        }
        session->dmabuf_maps[i].fd = (int)data->fd;
        session->dmabuf_maps[i].mapoffset = data->mapoffset;
        session->dmabuf_maps[i].len = maplen;
        session->dmabuf_maps[i].refs = 1;
        return;
    }
    /*
     * Out of slots. Falling out of this loop used to be the one failure here
     * that said nothing on any channel: osc_read_frame's lookup then misses for
     * every frame of the session and returns before it can report anything, so
     * the recording freezes with no explanation anywhere.
     */
    osc_report_capture_issue(session, "dmabuf-map-table-full",
                             "the compositor allocated more DMA-BUF buffers than this helper can "
                             "map; capture cannot proceed");
}

static void osc_on_remove_buffer(void *userdata, struct pw_buffer *pw_buf)
{
    struct osc_pw_session *session = userdata;
    struct spa_data *data;
    size_t i;

    if (pw_buf == NULL || pw_buf->buffer == NULL || pw_buf->buffer->n_datas < 1) {
        return;
    }
    data = &pw_buf->buffer->datas[0];
    if (data->type != SPA_DATA_DmaBuf) {
        return;
    }
    for (i = 0; i < OSC_MAX_DMABUF_MAPS; i++) {
        if (session->dmabuf_maps[i].ptr == NULL ||
            session->dmabuf_maps[i].fd != (int)data->fd ||
            session->dmabuf_maps[i].mapoffset != data->mapoffset) {
            continue;
        }
        if (!osc_release_dmabuf_map(&session->dmabuf_maps[i])) {
            return;
        }
        munmap(session->dmabuf_maps[i].ptr, session->dmabuf_maps[i].len);
        session->dmabuf_maps[i].ptr = NULL;
        session->dmabuf_maps[i].fd = -1;
        session->dmabuf_maps[i].mapoffset = 0;
        session->dmabuf_maps[i].len = 0;
        session->dmabuf_maps[i].refs = 0;
        return;
    }
}

static void osc_unmap_all_dmabufs(struct osc_pw_session *session)
{
    size_t i;

    for (i = 0; i < OSC_MAX_DMABUF_MAPS; i++) {
        if (session->dmabuf_maps[i].ptr == NULL) {
            continue;
        }
        munmap(session->dmabuf_maps[i].ptr, session->dmabuf_maps[i].len);
        session->dmabuf_maps[i].ptr = NULL;
        session->dmabuf_maps[i].fd = -1;
        session->dmabuf_maps[i].mapoffset = 0;
        session->dmabuf_maps[i].len = 0;
        session->dmabuf_maps[i].refs = 0;
    }
}

static void osc_on_state_changed(void *userdata, enum pw_stream_state old,
                                 enum pw_stream_state state, const char *error)
{
    struct osc_pw_session *session = userdata;

    (void)old;
    if (session->callbacks.on_state != NULL) {
        session->callbacks.on_state(session->callbacks.user, api.stream_state_as_string(state),
                                    error);
    }
}

/*
 * Extract the cursor metadata, or return 0 if this buffer has none.
 *
 * This uses spa_buffer_find_meta rather than the more usual
 * spa_buffer_find_meta_data because the latter returns only the pointer and
 * throws away `spa_meta::size`. That size is the sole bound available for
 * validating the bitmap offsets below, so it has to be kept. The size check
 * find_meta_data would have performed is done explicitly instead.
 *
 * Every offset in `spa_meta_cursor` is attacker-controlled from this process's
 * point of view (it comes from another process's shared memory), so each one is
 * validated against the metadata block's declared size before it is followed.
 * The arithmetic is done in uint64_t so that a hostile 32-bit offset cannot
 * wrap past the bound.
 */
static int osc_read_cursor(const struct spa_buffer *buffer, struct osc_pw_cursor *out,
                           uint32_t *meta_size_out)
{
    struct spa_meta *meta;
    struct spa_meta_cursor *cursor;
    struct spa_meta_bitmap *bitmap;
    uint64_t meta_size;
    uint64_t bitmap_offset;
    uint64_t pixels_offset;
    uint64_t pixels_len;

    memset(out, 0, sizeof(*out));

    meta = spa_buffer_find_meta(buffer, SPA_META_Cursor);
    if (meta == NULL) {
        return 0;
    }
    *meta_size_out = meta->size;
    meta_size = meta->size;
    if (meta_size < sizeof(struct spa_meta_cursor) || meta->data == NULL) {
        return 0;
    }

    cursor = meta->data;
    if (!spa_meta_cursor_is_valid(cursor)) {
        /* id == 0 means "nothing new"; the previous position still stands. */
        return 0;
    }

    out->id = cursor->id;
    out->flags = cursor->flags;
    out->x = cursor->position.x;
    out->y = cursor->position.y;
    out->hotspot_x = cursor->hotspot.x;
    out->hotspot_y = cursor->hotspot.y;

    bitmap_offset = cursor->bitmap_offset;
    if (bitmap_offset < sizeof(struct spa_meta_cursor) ||
        bitmap_offset + sizeof(struct spa_meta_bitmap) > meta_size) {
        return 1;
    }

    bitmap = SPA_PTROFF(cursor, (size_t)bitmap_offset, struct spa_meta_bitmap);
    if (!spa_meta_bitmap_is_valid(bitmap)) {
        return 1;
    }
    if (bitmap->stride <= 0 || bitmap->size.width == 0 || bitmap->size.height == 0) {
        return 1;
    }

    pixels_offset = bitmap_offset + bitmap->offset;
    if (bitmap->offset < sizeof(struct spa_meta_bitmap) || pixels_offset >= meta_size) {
        return 1;
    }
    pixels_len = (uint64_t)bitmap->stride * (uint64_t)bitmap->size.height;
    if (pixels_len == 0 || pixels_len > meta_size - pixels_offset) {
        return 1;
    }

    out->has_bitmap = 1;
    out->bitmap_format = bitmap->format;
    out->bitmap_width = (int32_t)bitmap->size.width;
    out->bitmap_height = (int32_t)bitmap->size.height;
    out->bitmap_stride = bitmap->stride;
    out->bitmap_data = SPA_PTROFF(cursor, (size_t)pixels_offset, const uint8_t);
    out->bitmap_len = (size_t)pixels_len;
    return 1;
}

/*
 * Extracts the pixels of one buffer. Returns 1 when `out` describes a frame, 0
 * when this buffer carries none.
 *
 * Every bound comes out of osc_resolve_frame_bounds, and none of it is
 * paranoia: `chunk` lives in memory the PRODUCER writes, so its fields are
 * untrusted input from another process. A compositor bug — or a malicious one —
 * that reports a size past the end of the mapping would otherwise be a read
 * straight off the end of the shared memory.
 *
 * The readable length is the MAPPING's length. For MemPtr/MemFd pw_stream maps
 * the region and `maxsize` is that length; for DMA-BUF we map it ourselves and
 * dmabuf_maps[] records what was actually mapped, because SPA's maxsize is
 * advisory there and some producers leave a placeholder in it.
 */
static int osc_read_frame(struct osc_pw_session *session, const struct spa_buffer *buffer,
                          struct osc_pw_frame *out)
{
    struct spa_data *data;
    struct osc_dmabuf_map *dmabuf_map = NULL;
    struct spa_meta_header *header;
    struct spa_meta_region *region;
    enum osc_frame_bounds_error bounds_error;
    size_t available = 0;
    size_t mapped_len;
    /* Written by osc_resolve_frame_bounds only when it returns OK. Initialised
     * so that reading them on any other path is a zero, never stack junk that
     * would reach SPA_PTROFF as a pointer offset. */
    size_t offset = 0;
    size_t size = 0;
    uint32_t chunk_offset;
    uint32_t chunk_size;
    int32_t chunk_flags;
    int32_t stride;
    int32_t width;
    int32_t height;

    const uint8_t *base;

    memset(out, 0, sizeof(*out));
    out->pts_ns = -1;

    if (buffer->n_datas < 1) {
        return 0;
    }
    data = &buffer->datas[0];
    if (data->chunk == NULL) {
        return 0;
    }

    if (data->type == SPA_DATA_DmaBuf) {
        /*
         * pw_stream never populates `datas[0].data` for a dmabuf, so the base
         * pointer comes from our own mapping, established once per buffer in
         * osc_on_add_buffer. A miss means the mmap failed there — reported at
         * that point — and there is nothing readable here.
         */
        dmabuf_map = osc_find_dmabuf_map(session, (int)data->fd, data->mapoffset);
        if (dmabuf_map == NULL) {
            return 0;
        }
        base = dmabuf_map->ptr;
        mapped_len = dmabuf_map->len;
    } else if (data->data == NULL) {
        /*
         * NULL on a shared-memory buffer means it was never mapped, which is the
         * cursor-only case: those sessions do not set PW_STREAM_FLAG_MAP_BUFFERS.
         */
        return 0;
    } else {
        base = data->data;
        mapped_len = data->maxsize;
    }
    width = (int32_t)session->format.size.width;
    height = (int32_t)session->format.size.height;
    /* Read each producer-written field ONCE, and decide and report from that
     * same snapshot. Re-reading them for the diagnostic would let a misbehaving
     * producer rewrite the numbers in between, so the report would describe a
     * frame other than the one that was refused. */
    chunk_offset = data->chunk->offset;
    chunk_size = data->chunk->size;
    chunk_flags = data->chunk->flags;
    stride = data->chunk->stride;
    bounds_error =
        osc_resolve_frame_bounds(data->type, data->maxsize, mapped_len, chunk_offset, chunk_size,
                                 chunk_flags, stride, width, height, &available, &offset, &size);
    if (bounds_error == OSC_FRAME_BOUNDS_METADATA_ONLY) {
        return 0;
    }
    if (bounds_error != OSC_FRAME_BOUNDS_OK) {
        osc_report_frame_drop(session, data, mapped_len, available, chunk_offset, chunk_size,
                              chunk_flags, stride, bounds_error);
        return 0;
    }

    /*
     * Open the CPU-access window on a dmabuf and leave it open: the pixels are
     * read by the on_frame callback, not here, so the matching SYNC_END lives in
     * osc_inspect_buffer once that callback has returned.
     */
    if (data->type == SPA_DATA_DmaBuf) {
        session->dmabuf_sync_fd = (int)data->fd;
        osc_dmabuf_sync(session->dmabuf_sync_fd, 1);
    }

    out->data = SPA_PTROFF(base, offset, const uint8_t);
    out->size = size;
    out->stride = stride;
    out->width = width;
    out->height = height;
    out->video_format = session->format.format;

    header = spa_buffer_find_meta_data(buffer, SPA_META_Header, sizeof(*header));
    if (header != NULL) {
        out->pts_ns = header->pts;
    }

    /* Default to the whole frame, so every consumer of `out` can read the crop
     * fields unconditionally and a missing meta degrades to today's behaviour. */
    out->crop_x = 0;
    out->crop_y = 0;
    out->crop_width = out->width;
    out->crop_height = out->height;
    out->has_crop = 0;

    region = spa_buffer_find_meta_data(buffer, SPA_META_VideoCrop, sizeof(*region));
    if (region != NULL && spa_meta_region_is_valid(region)) {
        /* Widened before comparing: `position` is signed int32 and `size` is
         * uint32, so a hostile or buggy rect can overflow int32 arithmetic. The
         * region is written by another process into shared memory and a bad one
         * becomes an out-of-bounds read inside swscale, so it is rejected rather
         * than trusted — WebRTC's posture, and the right one here because this
         * pointer is handed straight to the encoder. */
        int64_t x = region->region.position.x;
        int64_t y = region->region.position.y;
        int64_t w = region->region.size.width;
        int64_t h = region->region.size.height;

        if (x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= (int64_t)out->width &&
            y + h <= (int64_t)out->height) {
            out->crop_x = (int32_t)x;
            out->crop_y = (int32_t)y;
            out->crop_width = (int32_t)w;
            out->crop_height = (int32_t)h;
            /* A crop covering the whole frame is not a crop. Distinguishing it
             * from a genuine one is what lets the caller tell a monitor stream
             * apart from a window stream whose rectangle never arrived. */
            out->has_crop = (x != 0 || y != 0 || w < (int64_t)out->width ||
                             h < (int64_t)out->height);
        }
    }
    return 1;
}

static const char *osc_meta_type_name(uint32_t type)
{
    switch (type) {
    case SPA_META_Header:
        return "Header";
    case SPA_META_VideoCrop:
        return "VideoCrop";
    case SPA_META_VideoDamage:
        return "VideoDamage";
    case SPA_META_Bitmap:
        return "Bitmap";
    case SPA_META_Cursor:
        return "Cursor";
    case SPA_META_Control:
        return "Control";
    case SPA_META_Busy:
        return "Busy";
    case SPA_META_VideoTransform:
        return "VideoTransform";
    default:
        return "?";
    }
}

/*
 * "Header:12,Cursor:589872" — every metadata block the negotiation actually
 * produced, with its size.
 *
 * This exists because a missing SPA_META_Cursor used to be reported as a bare
 * `hasCursorMeta: false`, which cannot distinguish "our ParamMeta never reached
 * the negotiation" from "it reached it and was filtered out on size". Listing
 * the survivors answers that in one line: if Header is present and Cursor is
 * not, the params were sent and the cursor object lost the intersection.
 */
static void osc_describe_metas(const struct spa_buffer *buffer, char *out, size_t out_len)
{
    size_t used = 0;
    uint32_t i;

    if (out_len == 0) {
        return;
    }
    out[0] = '\0';
    for (i = 0; i < buffer->n_metas; i++) {
        int written = snprintf(out + used, out_len - used, "%s%s:%u", used > 0 ? "," : "",
                               osc_meta_type_name(buffer->metas[i].type), buffer->metas[i].size);
        if (written < 0 || (size_t)written >= out_len - used) {
            /* Truncated: leave what fits, NUL-terminated by snprintf. */
            return;
        }
        used += (size_t)written;
    }
}

static void osc_inspect_buffer(struct osc_pw_session *session, const struct spa_buffer *buffer)
{
    struct osc_pw_cursor cursor;
    uint32_t meta_size = 0;

    if (session->buffer_info_reports < OSC_BUFFER_INFO_REPORTS &&
        session->callbacks.on_buffer_info != NULL) {
        uint32_t data_type = buffer->n_datas > 0 ? buffer->datas[0].type : 0;
        struct spa_meta *cursor_meta = spa_buffer_find_meta(buffer, SPA_META_Cursor);
        char metas[256];

        osc_describe_metas(buffer, metas, sizeof(metas));
        session->buffer_info_reports++;
        session->callbacks.on_buffer_info(session->callbacks.user, data_type, buffer->n_datas,
                                          cursor_meta != NULL,
                                          cursor_meta != NULL ? cursor_meta->size : 0, metas);
    }

    if (osc_read_cursor(buffer, &cursor, &meta_size) && session->callbacks.on_cursor != NULL) {
        session->callbacks.on_cursor(session->callbacks.user, &cursor);
    }

    /*
     * Cursor first, then pixels. The order matters for the frame the cursor
     * shape changes on: the consumer stamps its cursor track from the latest
     * sample, and reading the cursor after the frame would attribute the new
     * position to the NEXT frame instead of this one.
     */
    if (session->want_video && session->callbacks.on_frame != NULL) {
        struct osc_pw_frame frame;

        session->dmabuf_sync_fd = -1;
        if (osc_read_frame(session, buffer, &frame)) {
            session->callbacks.on_frame(session->callbacks.user, &frame);
        }
        /* Closes the DMA_BUF_SYNC_START osc_read_frame opened, if any. Placed
         * here rather than inside it because the callback above is what actually
         * touches the pixels, and the window has to cover the read. */
        if (session->dmabuf_sync_fd >= 0) {
            osc_dmabuf_sync(session->dmabuf_sync_fd, 0);
            session->dmabuf_sync_fd = -1;
        }
    }
}

static void osc_on_process(void *userdata)
{
    struct osc_pw_session *session = userdata;
    struct pw_buffer *b;

    /*
     * EVERY dequeued buffer is inspected, in arrival order.
     *
     * The obvious optimisation — drain to the newest buffer and drop the rest —
     * is wrong here, and was the code this replaced. Cursor updates are not
     * guaranteed to be attached to buffers that also carry a video frame: a
     * compositor may deliver a buffer whose chunk size is 0 purely to ship a new
     * SPA_META_Cursor (KWin is documented as doing this). Dropping "stale"
     * buffers would silently throw those away, which is indistinguishable from
     * the cursor never moving.
     *
     * Reading metadata is a handful of struct field loads, so doing it per
     * buffer costs nothing.
     *
     * Since Stage 2 this loop DOES touch pixels, and the same reasoning still
     * holds — but for a different reason. The frame callback copies into a
     * single-slot mailbox on the Rust side where a newer frame overwrites an
     * unconsumed older one, so a backlog is dropped there, at the point that
     * knows whether the encoder is keeping up. Dropping here instead would also
     * throw away the cursor metadata riding on the same buffers.
     */
    while ((b = api.stream_dequeue_buffer(session->stream)) != NULL) {
        osc_inspect_buffer(session, b->buffer);
        api.stream_queue_buffer(session->stream, b);
    }
}

static const struct pw_stream_events osc_stream_events = {
    PW_VERSION_STREAM_EVENTS,
    .state_changed = osc_on_state_changed,
    .param_changed = osc_on_param_changed,
    .add_buffer = osc_on_add_buffer,
    .remove_buffer = osc_on_remove_buffer,
    .process = osc_on_process,
};

struct osc_pw_session *osc_pw_start(int fd, uint32_t node_id, int want_video,
                                    const struct osc_pw_callbacks *callbacks, char *err,
                                    size_t err_len)
{
    struct osc_pw_session *session;
    /* Two EnumFormat objects now, and the DMA-BUF one carries an extra choice —
     * sized so a builder overflow stays impossible rather than merely unlikely. */
    uint8_t buffer[2048];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    const struct spa_pod *params[2];
    int result;

    if (api_handle == NULL) {
        osc_set_error(err, err_len, "osc_pw_start called before osc_pw_load");
        close(fd);
        return NULL;
    }

    session = calloc(1, sizeof(*session));
    if (session == NULL) {
        osc_set_error(err, err_len, "out of memory");
        close(fd);
        return NULL;
    }
    session->callbacks = *callbacks;
    session->want_video = want_video;
    /* calloc zeroes these, and 0 is a legitimate fd — so the "nothing pending"
     * sentinel has to be set explicitly. dmabuf_maps is keyed on ptr != NULL,
     * which calloc does get right. */
    session->dmabuf_sync_fd = -1;

    session->loop = api.thread_loop_new("openscreen-pipewire", NULL);
    if (session->loop == NULL) {
        osc_set_error(err, err_len, "pw_thread_loop_new failed");
        close(fd);
        free(session);
        return NULL;
    }

    /*
     * Everything below runs with the loop lock held. The loop is not started
     * yet, so nothing can race us, but taking the lock keeps the teardown path
     * (which does run concurrently) symmetric with the setup path.
     */
    api.thread_loop_lock(session->loop);

    session->context = api.context_new(api.thread_loop_get_loop(session->loop), NULL, 0);
    if (session->context == NULL) {
        osc_set_error(err, err_len, "pw_context_new failed");
        close(fd);
        goto fail;
    }

    /* Takes ownership of fd, on success and on failure alike. */
    session->core = api.context_connect_fd(session->context, fd, NULL, 0);
    if (session->core == NULL) {
        osc_set_error(err, err_len, "pw_context_connect_fd failed: %s", strerror(errno));
        goto fail;
    }

    session->stream = api.stream_new(session->core, "openscreen-cursor",
                                     api.properties_new(PW_KEY_MEDIA_TYPE, "Video",
                                                        PW_KEY_MEDIA_CATEGORY, "Capture",
                                                        PW_KEY_MEDIA_ROLE, "Screen", NULL));
    if (session->stream == NULL) {
        osc_set_error(err, err_len, "pw_stream_new failed");
        goto fail;
    }

    api.stream_add_listener(session->stream, &session->stream_listener, &osc_stream_events,
                            session);

    /*
     * Shared memory FIRST, DMA-BUF second, and the order is the compatibility
     * guarantee: pw_stream keeps this as a preference list, so a compositor able
     * to produce shm still picks shm and nothing changes on GNOME or KDE. The
     * second object only ever wins against a producer that has no shm path —
     * niri and the other Smithay/wlroots compositors of issue #287, which
     * previously failed the whole negotiation with "no more input formats".
     */
    params[0] = osc_build_enum_format(&builder);
    params[1] = osc_build_enum_format_dmabuf(&builder);

    /*
     * Test affordance. Every compositor available for local testing — mutter,
     * sway via xdg-desktop-portal-wlr — offers shm, so params[0] always wins and
     * the DMA-BUF branch below (osc_map_dmabuf, the DMA_BUF_IOCTL_SYNC bracket,
     * the dmabuf arm of osc_read_frame) never executes outside niri. Dropping
     * the shm object leaves the producer no choice, which is the only way to
     * exercise that code without the compositor from issue #287.
     *
     * Never set in production: it would break exactly the compatibility the
     * ordering above exists to preserve.
     */
    if (getenv("OPENSCREEN_PIPEWIRE_FORCE_DMABUF") != NULL) {
        params[0] = params[1];
    }

    if (params[0] == NULL || params[1] == NULL) {
        osc_set_error(err, err_len, "the EnumFormat PODs did not fit their builder");
        goto fail;
    }

    /*
     * Flags. PW_STREAM_FLAG_MAP_BUFFERS only when the caller wants pixels:
     * mapping a full-screen framebuffer on every buffer is pure waste for a
     * cursor-only session. Metadata is unaffected either way — pw_stream maps the
     * buffer skeleton (and therefore every spa_meta) regardless of this flag;
     * MAP_BUFFERS only governs whether `datas[i].data` is populated.
     *
     * And one flag that is absent on purpose:
     *
     * No PW_STREAM_FLAG_DONT_RECONNECT, which this code used to set. That flag
     * killed the first real GNOME run, and the chain is worth writing down
     * because the symptom names nothing that appears in our source:
     *
     *   1. pw_stream turns the flag into the node property `node.dont-reconnect`
     *      (pipewire 1.0.5 src/pipewire/stream.c:2020).
     *   2. WirePlumber reads it as `reconnect = not node.dont-reconnect`
     *      (/usr/share/wireplumber/scripts/policy-node.lua:653).
     *   3. When the session manager cannot resolve a target, the `not reconnect`
     *      branch reports the error string "target not found" — the exact text we
     *      saw — where the reconnecting branch would merely say "no target node
     *      available" and wait (policy-node.lua:807).
     *   4. That same branch then DESTROYS the node (policy-node.lua:812), so the
     *      stream is gone for good rather than re-linking.
     *
     * In other words the flag converts a transient link failure into a silent,
     * permanent end of capture. OBS's linux-pipewire plugin — the reference
     * implementation that works on GNOME — does not set it either.
     *
     * `node_id` is passed as the connect target rather than through
     * PW_KEY_TARGET_OBJECT. That is the older of the two spellings, but it is what
     * OBS does and it is verified working here (see the ignored integration test,
     * which connects by numeric id and reaches `streaming`).
     */
    result = api.stream_connect(session->stream, PW_DIRECTION_INPUT, node_id,
                                want_video ? (PW_STREAM_FLAG_AUTOCONNECT |
                                              PW_STREAM_FLAG_MAP_BUFFERS)
                                           : PW_STREAM_FLAG_AUTOCONNECT,
                                params, SPA_N_ELEMENTS(params));
    if (result < 0) {
        osc_set_error(err, err_len, "pw_stream_connect failed: %s", spa_strerror(result));
        goto fail;
    }

    api.thread_loop_unlock(session->loop);

    if (api.thread_loop_start(session->loop) < 0) {
        osc_set_error(err, err_len, "pw_thread_loop_start failed");
        api.thread_loop_lock(session->loop);
        goto fail;
    }

    return session;

fail:
    api.thread_loop_unlock(session->loop);
    if (session->stream != NULL) {
        api.stream_destroy(session->stream);
    }
    if (session->core != NULL) {
        api.core_disconnect(session->core);
    }
    if (session->context != NULL) {
        api.context_destroy(session->context);
    }
    api.thread_loop_destroy(session->loop);
    free(session);
    return NULL;
}

void osc_pw_stop(struct osc_pw_session *session)
{
    if (session == NULL) {
        return;
    }

    /* pw_thread_loop_stop must be called WITHOUT the lock: it joins the thread. */
    api.thread_loop_stop(session->loop);

    if (session->stream != NULL) {
        api.stream_disconnect(session->stream);
        api.stream_destroy(session->stream);
    }
    /* After stream_destroy: remove_buffer fires during teardown and unmaps most
     * of these itself. This is the backstop for anything it did not reach, and
     * it runs once the loop is joined so nothing can be mapping concurrently. */
    osc_unmap_all_dmabufs(session);
    if (session->core != NULL) {
        api.core_disconnect(session->core);
    }
    if (session->context != NULL) {
        api.context_destroy(session->context);
    }
    api.thread_loop_destroy(session->loop);
    free(session);
}
