/*
 * Flat C ABI between the Rust helper and libpipewire.
 *
 * Every declaration here is mirrored by hand in `src/shim.rs`. The two files
 * are a matched pair: changing a struct on one side without the other is an ABI
 * break the compiler cannot catch, so keep the field order and the integer
 * widths identical.
 *
 * Only plain scalars and pointers cross this boundary — no SPA or PipeWire type
 * appears in a signature — so Rust never has to restate a PipeWire struct
 * layout. That is deliberate: the layouts live in the vendored headers and are
 * consumed by the C compiler that also compiled libpipewire's own users.
 */

#ifndef OPENSCREEN_PW_SHIM_H
#define OPENSCREEN_PW_SHIM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* One SPA_META_Cursor observation, already bounds-checked by the shim. */
struct osc_pw_cursor {
    /* Cursor position in stream pixels, top-left origin of the captured region. */
    int32_t x;
    int32_t y;
    /* Hotspot inside the bitmap. Meaningless when `has_bitmap` is 0. */
    int32_t hotspot_x;
    int32_t hotspot_y;
    /* Compositor-assigned shape id. 0 means "no cursor data in this frame". */
    uint32_t id;
    uint32_t flags;
    /* 1 when this frame carried a new shape bitmap. Compositors only send one
     * when the shape changes, so most frames have has_bitmap == 0. */
    int32_t has_bitmap;
    uint32_t bitmap_format; /* enum spa_video_format */
    int32_t bitmap_width;
    int32_t bitmap_height;
    int32_t bitmap_stride;
    /* Borrowed for the duration of the callback only. Copy before returning. */
    const uint8_t *bitmap_data;
    size_t bitmap_len;
};

/*
 * One video frame, already bounds-checked and mapped.
 *
 * Only produced when `osc_pw_start` was asked for video; a cursor-only session
 * never maps a pixel. Buffers that carry no frame (chunk size 0 — how some
 * compositors ship a cursor update on its own) are skipped rather than reported
 * as a zero-sized frame.
 */
struct osc_pw_frame {
    /* Borrowed for the duration of the callback only. Copy before returning:
     * the buffer is re-queued to the compositor as soon as it returns. */
    const uint8_t *data;
    size_t size;
    int32_t stride;
    int32_t width;
    int32_t height;
    uint32_t video_format; /* enum spa_video_format */
    /* SPA_META_Header pts in nanoseconds on the compositor's monotonic clock,
     * or -1 when the buffer carried no header. Far better than the callback's
     * arrival time: it is stamped when the frame was composited, not when this
     * process got round to looking at it. */
    int64_t pts_ns;
    /*
     * The sub-rectangle of `data` that actually holds content, from
     * SPA_META_VideoCrop. Always populated: it defaults to the whole frame.
     *
     * WHY A WINDOW STREAM NEEDS THIS. A PipeWire stream cannot change size once
     * negotiated, but a window can be resized at any moment, so mutter sizes a
     * window stream to the whole MONITOR and reports the window's live rectangle
     * here instead — "We cannot set the stream size to the exact size of the
     * window, because windows can be resized, whereas streams cannot"
     * (meta-screen-cast-window-stream.c). Encoding the buffer without applying
     * this crop is what produced window recordings padded out to screen size
     * with black. Both OBS and WebRTC's PipeWire capturers apply it.
     */
    int32_t crop_x;
    int32_t crop_y;
    int32_t crop_width;
    int32_t crop_height;
    /*
     * The crop is real AND narrower than the frame in at least one dimension.
     *
     * Zero means "there is nothing to crop to", covering three distinct cases
     * that must not be told apart by guessing: the compositor sent no meta, it
     * sent an invalid or out-of-bounds one, or it sent one covering the whole
     * frame. OBS (`has_effective_crop`) and WebRTC (`videocrop_metadata_use`)
     * both draw the line in exactly this place.
     */
    int has_crop;

    /*
     * Zero-copy dmabuf hand-off (issue #507). When `is_dmabuf` is 1, `data` is
     * NULL and the frame is not CPU-readable — a tiled compositor buffer that
     * lives on the GPU. The consumer imports it as a VAAPI surface from the
     * descriptor below instead of reading `data`. When 0, the CPU path above
     * applies unchanged (shm, or a linear/implicit dmabuf we could mmap).
     *
     * When the on_frame callback TAKES a dmabuf frame (returns non-zero), the
     * PipeWire buffer is NOT re-queued here — `buffer_handle` is retained by the
     * consumer, which keeps the fds and their CONTENT valid until it has imported
     * and copied the surface, then calls osc_pw_requeue_buffer. Duplicating the
     * fds alone would preserve the dmabuf object but not a snapshot of its pixels,
     * so a re-queued buffer the compositor overwrote could be encoded torn.
     * `modifier`/`drm_fourcc` describe the tiling and pixel layout.
     */
    int is_dmabuf;
    uint64_t modifier;   /* DRM format modifier of the buffer */
    uint32_t drm_fourcc; /* DRM fourcc matching `video_format` */
    int32_t n_planes;    /* number of populated plane_* entries (1..4) */
    int plane_fd[4];
    int32_t plane_offset[4];
    int32_t plane_stride[4];
    /* The `struct pw_buffer *` this frame came from, opaque to the consumer.
     * Passed back to osc_pw_requeue_buffer once the import is done. Only set (and
     * only meaningful) for a dmabuf frame the consumer intends to take. */
    void *buffer_handle;
    /* The registration generation of `buffer_handle`. Passed back alongside it so
     * a re-queue can tell this buffer from a later one PipeWire put in the same
     * slot after a renegotiation. */
    uint64_t buffer_generation;
};

/* The negotiated video format. Reported once, from param_changed. */
struct osc_pw_format {
    int32_t width;
    int32_t height;
    uint32_t video_format; /* enum spa_video_format */
    int32_t framerate_num;
    int32_t framerate_denom;
};

/*
 * Callbacks fire on the PipeWire thread, never on the caller's thread. They
 * must not block: the Rust side only pushes onto an unbounded channel.
 */
struct osc_pw_callbacks {
    void *user;
    void (*on_format)(void *user, const struct osc_pw_format *format);
    void (*on_cursor)(void *user, const struct osc_pw_cursor *cursor);
    /* Only ever called when osc_pw_start was given want_video != 0. Returns
     * non-zero to TAKE OWNERSHIP of the PipeWire buffer (`frame->buffer_handle`):
     * the shim then does NOT re-queue it, and the consumer must later call
     * osc_pw_requeue_buffer. Zero (the shm/CPU path, and any dmabuf frame the
     * consumer declines) re-queues immediately as before. */
    int (*on_frame)(void *user, const struct osc_pw_frame *frame);
    /* Emitted once per negotiated buffer set. `data_type` is the SPA_DATA_* of
     * datas[0]; `metas` is a borrowed "Header:12,Cursor:589872" listing of every
     * metadata block that survived negotiation, which is what distinguishes a
     * ParamMeta that was never sent from one that lost the size intersection. */
    void (*on_buffer_info)(void *user, uint32_t data_type, uint32_t n_datas,
                           int32_t has_cursor_meta, uint32_t cursor_meta_size,
                           const char *metas);
    void (*on_state)(void *user, const char *state, const char *error);
};

/*
 * SPA enum values, read out of the vendored headers rather than restated in
 * Rust. Hardcoding `SPA_VIDEO_FORMAT_BGRA == 12` on the Rust side would work
 * today and rot silently the day upstream inserts a value; this cannot.
 */
struct osc_pw_constants {
    uint32_t video_format_rgbx;
    uint32_t video_format_bgrx;
    uint32_t video_format_xrgb;
    uint32_t video_format_xbgr;
    uint32_t video_format_rgba;
    uint32_t video_format_bgra;
    uint32_t video_format_argb;
    uint32_t video_format_abgr;
    uint32_t data_mem_ptr;
    uint32_t data_mem_fd;
    uint32_t data_dma_buf;
};

void osc_pw_constants(struct osc_pw_constants *out);

/*
 * Would our SPA_META_Cursor declaration survive negotiation against a producer
 * that declares a FIXED size of `width` x `height` pixels? 1 yes, 0 no, -1 if
 * the PODs could not be built.
 *
 * Compositors declare that size as a constant (mutter 46.2: 384x384), so our
 * accepted range has to contain it or the metadata is silently dropped from the
 * buffers. Exposed so a unit test can assert the bound without a portal, a
 * compositor, or a screen.
 */
int osc_pw_cursor_meta_accepts_producer_size(uint32_t width, uint32_t height);

/*
 * Would our EnumFormat survive negotiation against a DMA-BUF-only producer that
 * declares `producer_modifier` as MANDATORY? 1 yes, 0 no, -1 if the PODs could
 * not be built.
 *
 * `with_modifier` picks which of our two EnumFormat objects to test: 0 for the
 * shared-memory one sent first, 1 for the DMA-BUF one sent as a fallback. Such a
 * producer must reject the former and accept the latter — that asymmetry is the
 * whole fix for issue #287, and this is how it is asserted without niri, a
 * portal or a screen.
 */
int osc_pw_enum_format_accepts_dmabuf_producer(int with_modifier, int64_t producer_modifier);

struct osc_pw_session;

/*
 * dlopen("libpipewire-0.3.so.0") and resolve every symbol used below. Returns 0
 * on success, -1 with a NUL-terminated message in `err` otherwise. Idempotent.
 */
int osc_pw_load(char *err, size_t err_len);

/* Runtime library version string, or NULL before a successful osc_pw_load. */
const char *osc_pw_library_version(void);

/*
 * Connect to the PipeWire remote behind `fd` (from the portal's
 * OpenPipeWireRemote) and start consuming `node_id`.
 *
 * Takes ownership of `fd`: once handed to pw_context_connect_fd, libpipewire's
 * loop owns and closes it. Failures before that point close it here. In the one
 * narrow case where pw_context_connect_fd itself fails, upstream may or may not
 * have taken it, so it is deliberately leaked rather than risking a double
 * close — the caller is on its way to reporting a fatal error either way.
 *
 * `want_video` decides whether pixels are mapped at all. With it set the stream
 * asks for PW_STREAM_FLAG_MAP_BUFFERS and restricts itself to shared-memory
 * buffer types; without it neither happens, and a cursor-only session never pays
 * to map a full-screen framebuffer per frame.
 *
 * `prefer_dmabuf` offers dmabuf before shm so a tiled monitor buffer is imported
 * on the GPU rather than copied through throttled shm (issue #507); set it only
 * when the VAAPI import pipeline is available. shm remains the fallback.
 *
 * Returns NULL on failure, with a message in `err`.
 */
struct osc_pw_session *osc_pw_start(int fd, uint32_t node_id, int want_video,
                                    int prefer_dmabuf,
                                    const struct osc_pw_callbacks *callbacks, char *err,
                                    size_t err_len);

/*
 * Re-queues a PipeWire buffer the on_frame callback took ownership of (returned
 * non-zero for), identified by the `buffer_handle` it was given. Call it once the
 * frame's pixels have been imported and copied.
 *
 * SAFE TO CALL FROM ANY THREAD: it takes the PipeWire thread-loop lock around the
 * queue, so unlike the shim's own callbacks it must NOT be called from the
 * PipeWire thread itself (that would deadlock). The consumer requeues from its
 * own loop, which is a different thread. NULL session or handle is a no-op.
 */
void osc_pw_requeue_buffer(struct osc_pw_session *session, void *buffer_handle,
                           uint64_t buffer_generation);

/* Stops the thread loop, joins it, and frees everything. Safe with NULL. */
void osc_pw_stop(struct osc_pw_session *session);

/* ---------------------------------------------------------------------------
 * Audio (csrc/pw_audio.c)
 *
 * A second, independent PipeWire connection — to the session's own daemon, not
 * to the portal's restricted remote, which carries no audio. See the header of
 * pw_audio.c for why that is the only option.
 * ------------------------------------------------------------------------- */

struct osc_pw_audio;

struct osc_pw_audio_callbacks {
    void *user;
    /* `interleaved` holds `n_samples` floats — that is n_samples/channels frames
     * — and is borrowed for the duration of the call. */
    void (*on_samples)(void *user, const float *interleaved, uint32_t n_samples);
    void (*on_state)(void *user, const char *state, const char *error);
};

/*
 * Opens one capture stream.
 *
 * `capture_sink` non-zero links to a SINK's monitor ports (what is being played)
 * rather than to a source; that is the difference between recording the system
 * mix and recording the microphone. `target_object` names a specific node, or is
 * NULL/"" for the session default.
 *
 * Returns NULL on failure with a message in `err`.
 */
struct osc_pw_audio *osc_pw_audio_start(const char *target_object, int capture_sink,
                                        uint32_t rate, uint32_t channels,
                                        const struct osc_pw_audio_callbacks *callbacks, char *err,
                                        size_t err_len);

/* Stops the thread loop, joins it, and frees everything. Safe with NULL. */
void osc_pw_audio_stop(struct osc_pw_audio *audio);

/*
 * Lists the graph's audio CAPTURE nodes into `out` as records
 * "node.name\037node.description\036", NUL-terminated.
 *
 * Synchronous: it runs a main loop until the registry has replayed every
 * existing global, then returns. Needed because the app's microphone picker
 * carries Chromium device labels, and PW_KEY_TARGET_OBJECT only accepts a
 * PipeWire node name — without this the stream falls back to the session
 * default source, which is rarely the microphone the user picked.
 *
 * Returns 0 on success, -1 with a message in `err`.
 */
int osc_pw_list_audio_sources(char *out, size_t out_len, char *err, size_t err_len);

#ifdef __cplusplus
}
#endif

#endif /* OPENSCREEN_PW_SHIM_H */
