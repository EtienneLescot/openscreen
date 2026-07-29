// Accesseurs pour les champs d'AVFormatContext que bindgen rend opaque
// (struct atteinte seulement par pointeur -> blob opaque). Compilé contre les
// VRAIS headers ffmpeg 8.x par le compilateur natif de la cible : offsets
// corrects, immunisé contre la version ET contre la plateforme.
#include <errno.h>
#include <libavformat/avformat.h>
#include <libavutil/error.h>

AVStream* sn_fmt_stream(AVFormatContext* s, int i) { return s->streams[i]; }
unsigned  sn_fmt_nb_streams(AVFormatContext* s)    { return s->nb_streams; }
AVIOContext* sn_fmt_get_pb(AVFormatContext* s)     { return s->pb; }
void      sn_fmt_set_pb(AVFormatContext* s, AVIOContext* p) { s->pb = p; }

// AVERROR(EAGAIN) n'est PAS une constante portable : il vaut -11 sur Windows et
// Linux (EAGAIN=11) mais -35 sur macOS et les BSD (EAGAIN=35). Les trois copies
// Rust de cette valeur étaient écrites en dur à -11, donc sur macOS la boucle
// avcodec_receive_frame ne reconnaissait jamais « redonne-moi un paquet » : elle
// traitait -35 comme une erreur fatale et AUCUNE frame n'était jamais décodée.
// La faire calculer ici la rend juste par construction sur chaque cible.
int sn_averror_eagain(void) { return AVERROR(EAGAIN); }
int sn_averror_eof(void)    { return AVERROR_EOF; }
