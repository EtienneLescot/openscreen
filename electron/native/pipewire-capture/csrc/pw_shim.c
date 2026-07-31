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
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <pipewire/pipewire.h>
#include <spa/buffer/meta.h>
#include <spa/param/video/format-utils.h>
#include <spa/pod/filter.h>
#include <spa/utils/result.h>

#include "pw_shim.h"

#include "pw_internal.h"

#define OSC_PW_SONAME "libpipewire-0.3.so.0"

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
    (sizeof(struct spa_meta_cursor) + sizeof(struct spa_meta_bitmap) + (size_t)(w) * (h) * 4)

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

static void osc_on_param_changed(void *userdata, uint32_t id, const struct spa_pod *param)
{
    struct osc_pw_session *session = userdata;
    uint8_t buffer[1024];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    const struct spa_pod *params[3];
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
     * No `size`/`stride` constraint is published: the compositor's own choice is
     * fine, and osc_read_frame validates whatever comes back.
     *
     * The dataType set differs by mode, and the difference is load-bearing.
     * Cursor-only advertises everything, so that on_buffer_info reports what the
     * compositor would PREFER rather than what we forced it into. Video mode
     * advertises shared memory only: pw_stream does not map DmaBuf even with
     * PW_STREAM_FLAG_MAP_BUFFERS, so accepting one would leave `datas[0].data`
     * NULL and produce a recording of nothing. Importing DmaBuf properly is its
     * own piece of work; until then, not offering it is what makes the
     * compositor fall back to memfd instead.
     */
    params[0] = spa_pod_builder_add_object(
        &builder, SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers, SPA_PARAM_BUFFERS_buffers,
        SPA_POD_CHOICE_RANGE_Int(4, 2, 16), SPA_PARAM_BUFFERS_blocks, SPA_POD_Int(1),
        SPA_PARAM_BUFFERS_dataType,
        SPA_POD_CHOICE_FLAGS_Int(session->want_video
                                     ? ((1 << SPA_DATA_MemPtr) | (1 << SPA_DATA_MemFd))
                                     : ((1 << SPA_DATA_MemPtr) | (1 << SPA_DATA_MemFd) |
                                        (1 << SPA_DATA_DmaBuf))));

    params[1] = spa_pod_builder_add_object(
        &builder, SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta, SPA_PARAM_META_type,
        SPA_POD_Id(SPA_META_Header), SPA_PARAM_META_size,
        SPA_POD_Int(sizeof(struct spa_meta_header)));

    params[2] = osc_build_cursor_meta(&builder);

    /* The builder returns NULL if its fixed buffer overflowed. 1 KiB is far more
     * than these three objects need, but handing NULLs to update_params would be
     * a null deref inside libpipewire, so it is checked rather than assumed. */
    if (params[0] == NULL || params[1] == NULL || params[2] == NULL) {
        return;
    }

    /* Buffers are reallocated on renegotiation, and the metadata layout comes
     * with them. Re-arm the reports so the instrumentation describes the buffer
     * set actually in use rather than a set that no longer exists. */
    session->buffer_info_reports = 0;

    api.stream_update_params(session->stream, params, 3);
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
 * The offset/size clamping against `maxsize` is the standard PipeWire consumer
 * idiom and is not paranoia: `chunk` lives in memory the PRODUCER writes, so its
 * fields are untrusted input from another process. A compositor bug — or a
 * malicious one — that reports a size past the end of the mapping would
 * otherwise be a read straight off the end of the shared memory.
 */
static int osc_read_frame(struct osc_pw_session *session, const struct spa_buffer *buffer,
                          struct osc_pw_frame *out)
{
    struct spa_data *data;
    struct spa_meta_header *header;
    uint32_t offset;
    uint32_t size;
    int32_t stride;
    int32_t height;

    memset(out, 0, sizeof(*out));
    out->pts_ns = -1;

    if (buffer->n_datas < 1) {
        return 0;
    }
    data = &buffer->datas[0];
    /*
     * NULL means the buffer was never mapped: either this is a cursor-only
     * session (no PW_STREAM_FLAG_MAP_BUFFERS) or the compositor handed us a
     * DmaBuf, which pw_stream does not map even with the flag. Neither is an
     * error here — the format negotiation excludes DmaBuf when want_video is
     * set, so in practice this is the cursor-only case.
     */
    if (data->data == NULL || data->chunk == NULL) {
        return 0;
    }
    /* A zero-sized chunk is how a compositor ships a cursor update with no new
     * frame attached. Not an error, just not a frame. */
    if (data->chunk->size == 0) {
        return 0;
    }

    offset = SPA_MIN(data->chunk->offset, data->maxsize);
    size = SPA_MIN(data->chunk->size, data->maxsize - offset);

    height = (int32_t)session->format.size.height;
    stride = data->chunk->stride;
    if (stride <= 0 || height <= 0) {
        return 0;
    }
    /* One short row is one row of garbage in the recording; refuse the whole
     * frame instead, and let the caller count it as dropped. */
    if ((uint64_t)stride * (uint64_t)height > (uint64_t)size) {
        return 0;
    }

    out->data = SPA_PTROFF(data->data, offset, const uint8_t);
    out->size = size;
    out->stride = stride;
    out->width = (int32_t)session->format.size.width;
    out->height = height;
    out->video_format = session->format.format;

    header = spa_buffer_find_meta_data(buffer, SPA_META_Header, sizeof(*header));
    if (header != NULL) {
        out->pts_ns = header->pts;
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

        if (osc_read_frame(session, buffer, &frame)) {
            session->callbacks.on_frame(session->callbacks.user, &frame);
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
    .process = osc_on_process,
};

struct osc_pw_session *osc_pw_start(int fd, uint32_t node_id, int want_video,
                                    const struct osc_pw_callbacks *callbacks, char *err,
                                    size_t err_len)
{
    struct osc_pw_session *session;
    uint8_t buffer[1024];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    const struct spa_pod *params[1];
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

    params[0] = osc_build_enum_format(&builder);
    if (params[0] == NULL) {
        osc_set_error(err, err_len, "the EnumFormat POD did not fit its builder");
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
                                params, 1);
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
    if (session->core != NULL) {
        api.core_disconnect(session->core);
    }
    if (session->context != NULL) {
        api.context_destroy(session->context);
    }
    api.thread_loop_destroy(session->loop);
    free(session);
}
