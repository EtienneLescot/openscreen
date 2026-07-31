/*
 * Shared between pw_shim.c and pw_audio.c. NOT part of the Rust-facing ABI.
 *
 * pw_shim.h is deliberately free of PipeWire and SPA types — that is what lets
 * src/shim.rs mirror it by hand without restating a single upstream struct
 * layout. This header is the opposite: it is full of them, and no Rust ever
 * sees it.
 */

#ifndef OPENSCREEN_PW_INTERNAL_H
#define OPENSCREEN_PW_INTERNAL_H

#include <stdarg.h>
#include <stddef.h>

#include <pipewire/pipewire.h>

/*
 * The subset of libpipewire that pw_audio.c calls, resolved once by
 * osc_pw_load alongside the video half's table. One dlopen and one symbol
 * table for the whole helper means a missing symbol is reported at load, not
 * at the first audio stream — by which time the user is already recording.
 */
struct osc_pw_audio_api {
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
    struct pw_core *(*context_connect)(struct pw_context *context, struct pw_properties *props,
                                       size_t user_data_size);
    int (*core_disconnect)(struct pw_core *core);
    struct pw_properties *(*properties_new)(const char *key, ...);
    int (*properties_set)(struct pw_properties *props, const char *key, const char *value);
    struct pw_stream *(*stream_new)(struct pw_core *core, const char *name,
                                    struct pw_properties *props);
    void (*stream_destroy)(struct pw_stream *stream);
    void (*stream_add_listener)(struct pw_stream *stream, struct spa_hook *listener,
                                const struct pw_stream_events *events, void *data);
    int (*stream_connect)(struct pw_stream *stream, enum pw_direction direction,
                          uint32_t target_id, enum pw_stream_flags flags,
                          const struct spa_pod **params, uint32_t n_params);
    struct pw_buffer *(*stream_dequeue_buffer)(struct pw_stream *stream);
    int (*stream_queue_buffer)(struct pw_stream *stream, struct pw_buffer *buffer);
    const char *(*stream_state_as_string)(enum pw_stream_state state);
    /* Enumeration only (osc_pw_list_audio_sources): a synchronous main loop
     * rather than the thread loop the streams use. */
    struct pw_main_loop *(*main_loop_new)(const struct spa_dict *props);
    void (*main_loop_destroy)(struct pw_main_loop *loop);
    struct pw_loop *(*main_loop_get_loop)(struct pw_main_loop *loop);
    int (*main_loop_run)(struct pw_main_loop *loop);
    int (*main_loop_quit)(struct pw_main_loop *loop);
    void (*proxy_destroy)(struct pw_proxy *proxy);
};

extern struct osc_pw_audio_api osc_audio_api;

/* Shared so both files report failures in the same shape. */
void osc_pw_set_error(char *err, size_t err_len, const char *format, ...);

#endif /* OPENSCREEN_PW_INTERNAL_H */
