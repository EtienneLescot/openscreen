#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_d3d11va.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
/* Software decode path (CPU backend) : les décodeurs logiciels sortent du YUV420P,
   la chaîne D3D échantillonne du NV12. swscale était déjà LIÉ (build.rs) sans être
   bindé — c'est la conversion la mieux optimisée qu'on ait déjà sous la main, et
   elle couvre les formats exotiques (10 bits, 4:2:2) qu'un interleave écrit à la
   main casserait silencieusement. */
#include <libswscale/swscale.h>
