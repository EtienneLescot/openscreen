// Wrapper C pour bindgen — variante macOS.
// Sur macOS le codec d'accélération matérielle est VideoToolbox (ffmpeg
// `AV_HWDEVICE_TYPE_VIDEOTOOLBOX`), pas D3D11VA. Le shape du contexte est
// très proche (un device opaque + des flags), mais les noms des types et
// les champs diffèrent — d'où un wrapper dédié.
//
// L'ordre des includes suit wrapper_windows.h pour stabiliser les allowlists
// communes (AVFormatContext, AVPacket, AVFrame, sws/swr, etc.).
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_videotoolbox.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
/* Software decode path : swscale était déjà LIÉ (build.rs) sans être bindé.
   Conservé identique côté macOS pour que la symétrie avec cpu_frames_windows.rs
   soit claire ; le code effectif vit dans mac_frames.rs. */
#include <libswscale/swscale.h>