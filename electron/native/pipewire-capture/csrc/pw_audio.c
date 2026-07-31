/*
 * PipeWire audio capture: the system mix and the microphone.
 *
 * WHY THIS IS A SEPARATE CONNECTION FROM THE VIDEO.
 *
 * The screen arrives over the fd the portal handed us from OpenPipeWireRemote.
 * That remote is deliberately restricted: it exposes the one screencast node the
 * user approved and nothing else. There is no audio on it, and there is no
 * portal that grants audio the way ScreenCast grants pixels — the ScreenCast
 * interface has no audio option at all.
 *
 * So audio comes from the session's own PipeWire daemon, over the ordinary
 * socket, with pw_context_connect rather than pw_context_connect_fd. That works
 * for a .deb/AppImage build, which runs unsandboxed. Inside a Flatpak it would
 * need the `--socket=pipewire` permission; there is no way to ask for it at
 * runtime, so a sandboxed build simply gets no audio and says so rather than
 * recording silence.
 *
 * SYSTEM AUDIO IS A SINK MONITOR. `PW_KEY_STREAM_CAPTURE_SINK=true` turns a
 * capture stream into one that links to a SINK's monitor ports instead of a
 * source — that is, to what is being played rather than to a microphone. It is
 * the same mechanism `pw-record --target` uses and what OBS's audio capture
 * does; without it the stream links to the default source and records the
 * microphone twice.
 */

#include "pw_shim.h"

#include "pw_internal.h"

#include <stdlib.h>
#include <string.h>

#include <spa/param/audio/format-utils.h>
#include <spa/pod/builder.h>
#include <spa/utils/result.h>

struct osc_pw_audio {
    struct pw_thread_loop *loop;
    struct pw_context *context;
    struct pw_core *core;
    struct pw_stream *stream;
    struct spa_hook stream_listener;
    struct osc_pw_audio_callbacks callbacks;
    uint32_t channels;
};

static void osc_audio_on_state_changed(void *userdata, enum pw_stream_state old,
                                       enum pw_stream_state state, const char *error)
{
    struct osc_pw_audio *audio = userdata;

    (void)old;
    if (audio->callbacks.on_state != NULL) {
        audio->callbacks.on_state(audio->callbacks.user,
                                  osc_audio_api.stream_state_as_string(state), error);
    }
}

static void osc_audio_on_param_changed(void *userdata, uint32_t id, const struct spa_pod *param)
{
    struct osc_pw_audio *audio = userdata;
    struct spa_audio_info_raw info;

    if (param == NULL || id != SPA_PARAM_Format) {
        return;
    }
    memset(&info, 0, sizeof(info));
    if (spa_format_audio_raw_parse(param, &info) < 0) {
        return;
    }
    /*
     * Recorded so osc_audio_on_process knows how many floats make one frame.
     * The stream adapter honours what we asked for, but reading back what was
     * actually negotiated is what keeps a mono device from being interpreted as
     * interleaved stereo and played back at double speed.
     */
    audio->channels = info.channels;
}

static void osc_audio_on_process(void *userdata)
{
    struct osc_pw_audio *audio = userdata;
    struct pw_buffer *b;

    while ((b = osc_audio_api.stream_dequeue_buffer(audio->stream)) != NULL) {
        struct spa_data *data = &b->buffer->datas[0];

        if (b->buffer->n_datas > 0 && data->data != NULL && data->chunk != NULL &&
            audio->callbacks.on_samples != NULL) {
            uint32_t offset;
            uint32_t size;

            /* Same untrusted-producer clamping as the video path: `chunk` lives
             * in memory another process writes. */
            offset = SPA_MIN(data->chunk->offset, data->maxsize);
            size = SPA_MIN(data->chunk->size, data->maxsize - offset);
            if (size >= sizeof(float)) {
                const float *samples = SPA_PTROFF(data->data, offset, const float);

                audio->callbacks.on_samples(audio->callbacks.user, samples,
                                            size / (uint32_t)sizeof(float));
            }
        }
        osc_audio_api.stream_queue_buffer(audio->stream, b);
    }
}

static const struct pw_stream_events osc_audio_stream_events = {
    PW_VERSION_STREAM_EVENTS,
    .state_changed = osc_audio_on_state_changed,
    .param_changed = osc_audio_on_param_changed,
    .process = osc_audio_on_process,
};

struct osc_pw_audio *osc_pw_audio_start(const char *target_object, int capture_sink,
                                        uint32_t rate, uint32_t channels,
                                        const struct osc_pw_audio_callbacks *callbacks, char *err,
                                        size_t err_len)
{
    struct osc_pw_audio *audio;
    struct pw_properties *props;
    uint8_t storage[1024];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(storage, sizeof(storage));
    const struct spa_pod *params[1];
    struct spa_audio_info_raw info;
    int result;

    if (osc_audio_api.stream_new == NULL) {
        osc_pw_set_error(err, err_len, "osc_pw_audio_start called before osc_pw_load");
        return NULL;
    }

    audio = calloc(1, sizeof(*audio));
    if (audio == NULL) {
        osc_pw_set_error(err, err_len, "out of memory");
        return NULL;
    }
    audio->callbacks = *callbacks;
    audio->channels = channels;

    audio->loop = osc_audio_api.thread_loop_new("openscreen-audio", NULL);
    if (audio->loop == NULL) {
        osc_pw_set_error(err, err_len, "pw_thread_loop_new failed");
        free(audio);
        return NULL;
    }

    osc_audio_api.thread_loop_lock(audio->loop);

    audio->context =
        osc_audio_api.context_new(osc_audio_api.thread_loop_get_loop(audio->loop), NULL, 0);
    if (audio->context == NULL) {
        osc_pw_set_error(err, err_len, "pw_context_new failed");
        goto fail;
    }

    /* The session's own daemon, not the portal's restricted remote. */
    audio->core = osc_audio_api.context_connect(audio->context, NULL, 0);
    if (audio->core == NULL) {
        osc_pw_set_error(err, err_len,
                         "pw_context_connect failed: no PipeWire session is reachable "
                         "(in a sandbox this needs the pipewire socket permission)");
        goto fail;
    }

    props = osc_audio_api.properties_new(PW_KEY_MEDIA_TYPE, "Audio", PW_KEY_MEDIA_CATEGORY,
                                         "Capture", PW_KEY_MEDIA_ROLE, "Production", NULL);
    if (props == NULL) {
        osc_pw_set_error(err, err_len, "pw_properties_new failed");
        goto fail;
    }
    if (capture_sink) {
        /* Link to a SINK's monitor ports — what is being played — rather than
         * to a source. Without this the stream records the microphone. */
        osc_audio_api.properties_set(props, PW_KEY_STREAM_CAPTURE_SINK, "true");
    }
    if (target_object != NULL && target_object[0] != '\0') {
        osc_audio_api.properties_set(props, PW_KEY_TARGET_OBJECT, target_object);
    }

    audio->stream = osc_audio_api.stream_new(audio->core, "openscreen-audio", props);
    if (audio->stream == NULL) {
        osc_pw_set_error(err, err_len, "pw_stream_new failed");
        goto fail;
    }

    osc_audio_api.stream_add_listener(audio->stream, &audio->stream_listener,
                                      &osc_audio_stream_events, audio);

    /*
     * A single fixed format, not a choice. pw_stream inserts an adapter node
     * that resamples and remixes whatever the device runs at, so asking for
     * exactly what the AAC encoder wants costs nothing and removes every
     * conversion from this process.
     */
    memset(&info, 0, sizeof(info));
    info.format = SPA_AUDIO_FORMAT_F32;
    info.rate = rate;
    info.channels = channels;
    params[0] = spa_format_audio_raw_build(&builder, SPA_PARAM_EnumFormat, &info);
    if (params[0] == NULL) {
        osc_pw_set_error(err, err_len, "the audio EnumFormat POD did not fit its builder");
        goto fail;
    }

    /* No PW_STREAM_FLAG_RT_PROCESS: osc_audio_on_process takes a mutex on the
     * Rust side, which is not allowed on PipeWire's realtime thread. */
    result = osc_audio_api.stream_connect(audio->stream, PW_DIRECTION_INPUT, PW_ID_ANY,
                                          PW_STREAM_FLAG_AUTOCONNECT |
                                              PW_STREAM_FLAG_MAP_BUFFERS,
                                          params, 1);
    if (result < 0) {
        osc_pw_set_error(err, err_len, "pw_stream_connect failed: %s", spa_strerror(result));
        goto fail;
    }

    osc_audio_api.thread_loop_unlock(audio->loop);

    if (osc_audio_api.thread_loop_start(audio->loop) < 0) {
        osc_pw_set_error(err, err_len, "pw_thread_loop_start failed");
        osc_audio_api.thread_loop_lock(audio->loop);
        goto fail;
    }

    return audio;

fail:
    osc_audio_api.thread_loop_unlock(audio->loop);
    if (audio->stream != NULL) {
        osc_audio_api.stream_destroy(audio->stream);
    }
    if (audio->core != NULL) {
        osc_audio_api.core_disconnect(audio->core);
    }
    if (audio->context != NULL) {
        osc_audio_api.context_destroy(audio->context);
    }
    osc_audio_api.thread_loop_destroy(audio->loop);
    free(audio);
    return NULL;
}

void osc_pw_audio_stop(struct osc_pw_audio *audio)
{
    if (audio == NULL) {
        return;
    }
    /* Stop the loop BEFORE destroying anything it might still be running a
     * callback against; this joins the thread. */
    osc_audio_api.thread_loop_stop(audio->loop);
    if (audio->stream != NULL) {
        osc_audio_api.stream_destroy(audio->stream);
    }
    if (audio->core != NULL) {
        osc_audio_api.core_disconnect(audio->core);
    }
    if (audio->context != NULL) {
        osc_audio_api.context_destroy(audio->context);
    }
    osc_audio_api.thread_loop_destroy(audio->loop);
    free(audio);
}

/* ---------------------------------------------------------------------------
 * Enumeration of audio sources
 *
 * WHY THIS IS NEEDED AT ALL. The app's microphone picker lists Chromium's
 * `MediaDeviceInfo`, whose `deviceId` is an opaque hash and whose `label` is a
 * human string. Neither is a PipeWire `node.name`, and `PW_KEY_TARGET_OBJECT`
 * accepts only a node name (or a serial). With no target, pw_stream connects to
 * the session DEFAULT source — which is why a user who picked their built-in
 * microphone in the HUD got the empty headphone jack recorded instead.
 *
 * So the helper enumerates the graph itself and resolves the label against
 * `node.description`, which is exactly the string Chromium surfaces as the
 * device label on a PipeWire system.
 * ------------------------------------------------------------------------- */

struct osc_pw_enum {
    struct pw_main_loop *loop;
    struct pw_context *context;
    struct pw_core *core;
    struct pw_registry *registry;
    struct spa_hook registry_listener;
    struct spa_hook core_listener;
    int sync_seq;
    /* Caller's buffer, filled as "name\037description\036" records. */
    char *out;
    size_t out_len;
    size_t out_used;
};

static void osc_enum_append(struct osc_pw_enum *e, const char *name, const char *desc)
{
    size_t need;

    if (name == NULL || name[0] == '\0') {
        return;
    }
    if (desc == NULL) {
        desc = "";
    }
    /* +2 for the two separators, +1 for the trailing NUL the Rust side reads. */
    need = strlen(name) + strlen(desc) + 3;
    if (e->out_used + need > e->out_len) {
        return; /* Buffer full: report what fits rather than truncating a record. */
    }
    e->out_used += (size_t)snprintf(e->out + e->out_used, e->out_len - e->out_used,
                                    "%s\037%s\036", name, desc);
}

static void osc_enum_on_global(void *data, uint32_t id, uint32_t permissions, const char *type,
                               uint32_t version, const struct spa_dict *props)
{
    struct osc_pw_enum *e = data;
    const char *media_class;

    (void)id;
    (void)permissions;
    (void)version;
    if (props == NULL || type == NULL || strcmp(type, PW_TYPE_INTERFACE_Node) != 0) {
        return;
    }
    media_class = spa_dict_lookup(props, PW_KEY_MEDIA_CLASS);
    /* Only real capture devices. "Audio/Source" covers microphones and line-in;
     * a sink's monitor is "Audio/Sink" and is reached via capture_sink instead,
     * so listing it here would offer the user a duplicate of system audio. */
    if (media_class == NULL || strcmp(media_class, "Audio/Source") != 0) {
        return;
    }
    osc_enum_append(e, spa_dict_lookup(props, PW_KEY_NODE_NAME),
                    spa_dict_lookup(props, PW_KEY_NODE_DESCRIPTION));
}

static const struct pw_registry_events osc_enum_registry_events = {
    PW_VERSION_REGISTRY_EVENTS,
    .global = osc_enum_on_global,
};

static void osc_enum_on_core_done(void *data, uint32_t id, int seq)
{
    struct osc_pw_enum *e = data;

    /* The registry replays every existing global BEFORE answering our sync, so
     * a matching `done` means the initial dump is complete. Without this we
     * would have to guess at a timeout and would race a busy graph. */
    if (id == PW_ID_CORE && seq == e->sync_seq) {
        osc_audio_api.main_loop_quit(e->loop);
    }
}

static const struct pw_core_events osc_enum_core_events = {
    PW_VERSION_CORE_EVENTS,
    .done = osc_enum_on_core_done,
};

int osc_pw_list_audio_sources(char *out, size_t out_len, char *err, size_t err_len)
{
    struct osc_pw_enum e;
    int result = -1;

    if (osc_audio_api.main_loop_new == NULL) {
        osc_pw_set_error(err, err_len, "osc_pw_list_audio_sources called before osc_pw_load");
        return -1;
    }
    memset(&e, 0, sizeof(e));
    e.out = out;
    e.out_len = out_len;
    if (out_len > 0) {
        out[0] = '\0';
    }

    /* A plain main loop, not the thread loop the streams use: this call is
     * synchronous by design — it runs the loop until the registry dump is done
     * and then returns, so there is no thread to hand off to. */
    e.loop = osc_audio_api.main_loop_new(NULL);
    if (e.loop == NULL) {
        osc_pw_set_error(err, err_len, "pw_main_loop_new failed");
        return -1;
    }
    e.context = osc_audio_api.context_new(osc_audio_api.main_loop_get_loop(e.loop), NULL, 0);
    if (e.context == NULL) {
        osc_pw_set_error(err, err_len, "pw_context_new failed");
        goto out;
    }
    e.core = osc_audio_api.context_connect(e.context, NULL, 0);
    if (e.core == NULL) {
        osc_pw_set_error(err, err_len, "pw_context_connect failed: no PipeWire session reachable");
        goto out;
    }
    e.registry = pw_core_get_registry(e.core, PW_VERSION_REGISTRY, 0);
    if (e.registry == NULL) {
        osc_pw_set_error(err, err_len, "pw_core_get_registry failed");
        goto out;
    }

    pw_registry_add_listener(e.registry, &e.registry_listener, &osc_enum_registry_events, &e);
    pw_core_add_listener(e.core, &e.core_listener, &osc_enum_core_events, &e);
    e.sync_seq = pw_core_sync(e.core, PW_ID_CORE, 0);

    osc_audio_api.main_loop_run(e.loop);
    result = 0;

out:
    if (e.registry != NULL) {
        osc_audio_api.proxy_destroy((struct pw_proxy *)e.registry);
    }
    if (e.core != NULL) {
        osc_audio_api.core_disconnect(e.core);
    }
    if (e.context != NULL) {
        osc_audio_api.context_destroy(e.context);
    }
    osc_audio_api.main_loop_destroy(e.loop);
    return result;
}
