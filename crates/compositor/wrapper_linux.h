/* Linux ffmpeg wrapper for bindgen (PR #183).
 *
 * Software/VAAPI decode+encode only: no D3D11VA (Windows) nor VideoToolbox
 * (macOS) hwcontext headers, which pull platform-specific system headers
 * (d3d11.h / CoreVideo) that don't exist on Linux. The generic hwcontext.h is
 * kept for AVHWDeviceContext should the VAAPI path need it later. */
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
