// GPU-resident native pipeline, milestone 1: hardware Vulkan Video decode straight
// into a wgpu::Texture — no CPU upload, no swscale — via gpu-video. This is the
// piece the CPU path could never have: decoded frames that never touch RAM.
//
// gpu-video owns the wgpu device (it creates the Vulkan device with the video
// extensions), so the composite pipeline will later be built on ITS device and
// sample these textures directly. Step 1 just proves the zero-copy decode works
// on this AMD iGPU (ffmpeg confirmed Vulkan DECODE works here; encode did not).

use ffmpeg_next as ff;
use gpu_video::parameters as gp;

// mp4 stores H.264 as length-prefixed AVCC NALs; the Vulkan decoder wants Annex-B
// (start codes) with in-band SPS/PPS. Convert by hand — a bitstream filter in ~40
// lines, no BSF-API guesswork.
fn avcc_sps_pps(extradata: &[u8]) -> Vec<u8> {
    // avcC: [0]=1 [1..4]=profile/compat/level [4]=0xFC|lenSizeMinus1
    // [5]=0xE0|numSPS, then numSPS x (u16 len + SPS), then numPPS, then PPS...
    let mut out = Vec::new();
    if extradata.len() < 6 { return out; }
    let mut i = 5usize;
    let num_sps = extradata[i] & 0x1F; i += 1;
    for _ in 0..num_sps {
        if i + 2 > extradata.len() { return out; }
        let n = ((extradata[i] as usize) << 8) | extradata[i + 1] as usize; i += 2;
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&extradata[i..i + n]); i += n;
    }
    if i >= extradata.len() { return out; }
    let num_pps = extradata[i]; i += 1;
    for _ in 0..num_pps {
        if i + 2 > extradata.len() { return out; }
        let n = ((extradata[i] as usize) << 8) | extradata[i + 1] as usize; i += 2;
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&extradata[i..i + n]); i += n;
    }
    out
}

fn avcc_to_annexb(packet: &[u8], out: &mut Vec<u8>) {
    // 4-byte length-prefixed NALs → start-code-prefixed.
    let mut i = 0usize;
    while i + 4 <= packet.len() {
        let n = ((packet[i] as usize) << 24) | ((packet[i + 1] as usize) << 16) | ((packet[i + 2] as usize) << 8) | packet[i + 3] as usize;
        i += 4;
        if i + n > packet.len() { break; }
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&packet[i..i + n]);
        i += n;
    }
}

fn main() {
    ff::init().unwrap();
    tracing_subscriber::fmt().with_env_filter("gpu_video=debug,warn").with_writer(std::io::stderr).init();

    // gpu-video creates the Vulkan device (with video decode extensions) and the
    // wgpu device on top.
    let instance = gpu_video::VulkanInstance::new().expect("vulkan instance");
    // decode only: this AMD iGPU exposes Vulkan Video DECODE but not encode (ffmpeg
    // h264_vulkan failed with "Function not implemented"). The default descriptor
    // demands both and returns NoDevice; ask for decode alone.
    let adapter = instance.create_adapter(&gp::VulkanAdapterDescriptor {
        supports_decoding: true,
        supports_encoding: false,
        compatible_surface: None,
    }).expect("adapter");
    let device = adapter.create_device(&gp::VulkanDeviceDescriptor::default()).expect("device");
    let wdev = device.wgpu_device();
    println!("gpu-video device up. wgpu adapter: {}", wdev.limits().max_texture_dimension_2d);

    let mut decoder = device
        .create_wgpu_textures_decoder_h264(gp::DecoderParameters::default())
        .expect("h264 decoder");

    // Demux screen.mp4 → Annex-B H.264, feed to the Vulkan decoder.
    let mut ictx = ff::format::input(&"../poc/media/screen.mp4").unwrap();
    let stream = ictx.streams().best(ff::media::Type::Video).unwrap();
    let idx = stream.index();
    let params = stream.parameters();
    let extradata = unsafe {
        let p = params.as_ptr();
        let (ed, n) = ((*p).extradata, (*p).extradata_size as usize);
        if ed.is_null() || n == 0 { Vec::new() } else { std::slice::from_raw_parts(ed, n).to_vec() }
    };

    let header = avcc_sps_pps(&extradata);
    let mut decoded = 0usize;
    let mut first_reported = false;
    let mut annexb = Vec::new();

    'outer: for (s, p) in ictx.packets() {
        if s.index() != idx { continue; }
        annexb.clear();
        if !first_reported && !header.is_empty() { annexb.extend_from_slice(&header); }
        avcc_to_annexb(p.data().unwrap_or(&[]), &mut annexb);

        let frames = match decoder.decode(gpu_video::EncodedInputChunk { data: &annexb, pts: None }) {
            Ok(f) => f,
            Err(e) => { eprintln!("decode error: {e:?}"); break; }
        };
        for frame in frames {
            let tex: &wgpu::Texture = &frame.data;
            if !first_reported {
                println!("ZERO-COPY DECODE OK: wgpu::Texture {}x{} format {:?}", tex.width(), tex.height(), tex.format());
                first_reported = true;
            }
            decoded += 1;
            if decoded >= 30 { break 'outer; }
        }
    }
    println!("decoded {decoded} frames into wgpu textures, no CPU roundtrip");
}
