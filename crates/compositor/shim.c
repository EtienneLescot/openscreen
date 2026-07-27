// Accesseurs pour les champs d'AVFormatContext que bindgen rend opaque
// (struct atteinte seulement par pointeur -> blob opaque). Compilé contre les
// VRAIS headers ffmpeg 8.x par MSVC : offsets corrects, immunisé contre la version.
#include <libavformat/avformat.h>

AVStream* sn_fmt_stream(AVFormatContext* s, int i) { return s->streams[i]; }
unsigned  sn_fmt_nb_streams(AVFormatContext* s)    { return s->nb_streams; }
AVIOContext* sn_fmt_get_pb(AVFormatContext* s)     { return s->pb; }
void      sn_fmt_set_pb(AVFormatContext* s, AVIOContext* p) { s->pb = p; }
