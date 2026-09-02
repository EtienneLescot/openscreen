/* Linux ffmpeg wrapper for bindgen (PR #183).
 *
 * Software/VAAPI decode+encode only: no D3D11VA (Windows) nor VideoToolbox
 * (macOS) hwcontext headers, which pull platform-specific system headers
 * (d3d11.h / CoreVideo) that don't exist on Linux.
 *
 * hwcontext_drm.h IS included: the export path needs AVDRMFrameDescriptor to
 * describe an exported dmabuf to av_hwframe_map, and that header pulls nothing
 * beyond what the vendored ffmpeg already ships.
 *
 * hwcontext_vaapi.h is deliberately NOT included, though the export encodes with
 * VAAPI. It #includes <va/va.h>, which is not in the vendored tree -- adding it
 * would make libva's DEVELOPMENT headers a build dependency of this crate on
 * every Linux builder, to gain nothing: reaching VAAPI needs only
 * AV_HWDEVICE_TYPE_VAAPI, an enumerator of the generic hwcontext.h, and
 * av_hwdevice_ctx_create_derived. AVVAAPIDeviceContext itself is never touched. */
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_drm.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersrc.h>
#include <libavfilter/buffersink.h>
