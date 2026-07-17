// Native throughput, take 3: in-process decode ON THREADS, overlapped with the
// composite/encode loop — because take 2 proved the wall was synchronous
// single-threaded decode blocking the hot loop, not "in-process" itself. The
// subprocess version won its 31 fps by decoding in parallel processes; this does
// the same in one process, over channels, and keeps the frames in memory (no pipe).

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::mpsc::sync_channel;
use std::thread;
use std::time::Instant;

use ffmpeg_next as ff;
use ff::software::scaling::{Context as Scaler, Flags};
use ff::util::format::Pixel;

const OUT_W: u32 = 1920;
const OUT_H: u32 = 1080;
const FPS: u32 = 30;
const SCREEN_W: u32 = 1920;
const SCREEN_H: u32 = 1032;
const WEBCAM_W: u32 = 640;
const WEBCAM_H: u32 = 480;
const FRAMES: u32 = 180;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms { a: [f32; 4], screen: [f32; 4], webcam: [f32; 4], fx: [f32; 4], b: [f32; 4], mb: [f32; 4], cursor: [f32; 4], cursor_fx: [f32; 4] }

fn ease(x: f32) -> f32 { if x < 0.5 { 4.0 * x * x * x } else { 1.0 - (-2.0 * x + 2.0).powi(3) / 2.0 } }
fn rstr(t: f32, s: f32, e: f32, r: f32) -> f32 { if t <= s || t >= e { return 0.0; } ease(((t - s) / r).min(1.0).min((e - t) / r)) }
fn lerp(a: f32, b: f32, t: f32) -> f32 { a + (b - a) * t }

fn evaluate(t: f32, prev: Option<(f32, f32)>) -> (Uniforms, (f32, f32)) {
    let pad = 45.0; let s = 1.0 - (pad / 100.0) * 0.4;
    let (bw, bh) = (OUT_W as f32 * s, OUT_H as f32 * s);
    let bs = [ (OUT_W as f32 - bw) / 2.0, (OUT_H as f32 - bh) / 2.0, bw, bh ];
    let size = (OUT_H as f32 * 0.22).round(); let margin = (OUT_H as f32 * 0.04).round();
    let bwc = [ OUT_W as f32 - size - margin, OUT_H as f32 - size - margin, size, size ];
    let zooms = [(1.0, 3.2, 1.7, 0.62, 0.42, 0.55), (4.4, 6.5, 2.3, 0.3, 0.7, 0.5)];
    let (mut zoom, mut fxn, mut fyn, mut str_) = (1.0f32, 0.5f32, 0.5f32, 0.0f32);
    for (st, en, sc, cx, cy, rr) in zooms { let v = rstr(t, st, en, rr); if v > str_ { str_ = v; zoom = lerp(1.0, sc, v); fxn = cx; fyn = cy; } }
    let fxp = bs[0] + bs[2] * fxn; let fyp = bs[1] + bs[3] * fyn;
    let screen = [ fxp - (fxp - bs[0]) * zoom, fyp - (fyp - bs[1]) * zoom, bs[2] * zoom, bs[3] * zoom ];
    let mv = rstr(t, 2.4, 5.0, 0.6);
    let pw = (OUT_W as f32 * 0.34).round(); let ph = (pw * 0.75).round();
    let panel = [ OUT_W as f32 - pw - margin, OUT_H as f32 - ph - margin, pw, ph ];
    let webcam = [ lerp(bwc[0], panel[0], mv), lerp(bwc[1], panel[1], mv), lerp(bwc[2], panel[2], mv), lerp(bwc[3], panel[3], mv) ];
    let wrad = lerp(bwc[2].min(bwc[3]) / 2.0, 26.0, mv);
    let (cx, cy) = (screen[0] + screen[2] / 2.0, screen[1] + screen[3] / 2.0);
    let (mut sbx, mut sby) = (0.0f32, 0.0f32);
    if let Some((px, py)) = prev { sbx = ((cx - px) * 0.9).clamp(-22.0, 22.0); sby = ((cy - py) * 0.9).clamp(-22.0, 22.0); }
    let u = Uniforms { a: [OUT_W as f32, OUT_H as f32, t, 28.0], screen, webcam, fx: [0.7, 0.0, 16.0, 22.0], b: [wrad, 0.0, WEBCAM_W as f32 / WEBCAM_H as f32, 0.0], mb: [sbx, sby, 0.0, 0.0], cursor: [screen[0] + 0.52 * screen[2], screen[1] + 0.90 * screen[3], OUT_H as f32 * 0.05, 1.0], cursor_fx: [0.0, 0.0, 1.0, 0.0] };
    (u, (cx, cy))
}

// A decode thread: owns the ffmpeg decoder, sends tightly-packed RGBA frames over
// a bounded channel. Bounded so a fast decoder cannot run away with memory; the
// blocking send IS the backpressure. Every 2nd source frame is dropped for the
// 60->30 sources so content time roughly tracks the 30 fps output.
fn spawn_decode(path: &'static str, w: u32, h: u32, take_every: u32) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = sync_channel::<Vec<u8>>(4);
    thread::spawn(move || {
        let mut ictx = match ff::format::input(&path) { Ok(c) => c, Err(_) => return };
        let st = ictx.streams().best(ff::media::Type::Video).unwrap();
        let idx = st.index();
        let mut dec = ff::codec::context::Context::from_parameters(st.parameters()).unwrap().decoder().video().unwrap();
        let mut scaler = Scaler::get(dec.format(), dec.width(), dec.height(), Pixel::RGBA, w, h, Flags::BILINEAR).unwrap();
        let row = (w * 4) as usize;
        let mut n = 0u32;
        let mut emit = |frame: &ff::util::frame::Video, scaler: &mut Scaler| -> bool {
            let mut rgba = ff::util::frame::Video::empty();
            scaler.run(frame, &mut rgba).unwrap();
            let stride = rgba.stride(0); let data = rgba.data(0);
            let mut out = vec![0u8; (w * h * 4) as usize];
            for y in 0..h as usize { let o = y * stride; out[y * row..y * row + row].copy_from_slice(&data[o..o + row]); }
            tx.send(out).is_ok()
        };
        for (s, p) in ictx.packets() {
            if s.index() != idx { continue; }
            if dec.send_packet(&p).is_err() { continue; }
            let mut frame = ff::util::frame::Video::empty();
            while dec.receive_frame(&mut frame).is_ok() {
                n += 1;
                if n % take_every == 0 && !emit(&frame, &mut scaler) { return; }
            }
        }
    });
    rx
}

fn tex2d(d: &wgpu::Device, w: u32, h: u32) -> wgpu::Texture {
    d.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] })
}
fn upload(q: &wgpu::Queue, t: &wgpu::Texture, w: u32, h: u32, d: &[u8]) {
    q.write_texture(wgpu::ImageCopyTexture { texture: t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, d, wgpu::ImageDataLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(h) }, wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
}

fn main() {
    ff::init().expect("ffmpeg init");
    let no_encode = std::env::args().nth(1).as_deref() == Some("no-encode");
    let screen_rx = spawn_decode("../poc/media/screen.mp4", SCREEN_W, SCREEN_H, 2); // 60->30
    let webcam_rx = spawn_decode("../poc/media/webcam.mp4", WEBCAM_W, WEBCAM_H, 1);

    // Encoder on its own thread too: the 8 MB/frame pipe write to ffmpeg must not
    // block the composite loop. The main loop sends a composited frame over a
    // bounded channel; the thread does the blocking write. Bounded = backpressure.
    let mut enc_join = None;
    let enc_tx = (!no_encode).then(|| {
        let (tx, rx) = sync_channel::<Vec<u8>>(4);
        enc_join = Some(thread::spawn(move || {
            let mut enc = Command::new("ffmpeg")
                .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", &format!("{OUT_W}x{OUT_H}"), "-framerate", &FPS.to_string(), "-i", "-", "-c:v", "h264_amf", "-b:v", "8M", "-usage", "transcoding", "out3.mp4"])
                .stdin(Stdio::piped()).spawn().expect("encode spawn");
            let mut ein = enc.stdin.take().unwrap();
            for frame in rx.iter() { if ein.write_all(&frame).is_err() { break; } }
            drop(ein);
            let _ = enc.wait();
        }));
        tx
    });

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::default());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).unwrap();
    println!("native gpu: {} (backend {:?})", adapter.get_info().name, adapter.get_info().backend);
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: None, required_features: wgpu::Features::empty(), required_limits: wgpu::Limits::default(), memory_hints: wgpu::MemoryHints::Performance }, None)).unwrap();

    let st = tex2d(&device, SCREEN_W, SCREEN_H); let wt = tex2d(&device, WEBCAM_W, WEBCAM_H);
    let sv = st.create_view(&Default::default()); let wv = wt.create_view(&Default::default());
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
    let ubuf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: std::mem::size_of::<Uniforms>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(include_str!("../composite.wgsl").into()) });
    let fmt = wgpu::TextureFormat::Rgba8Unorm;
    let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor { label: None, layout: None, vertex: wgpu::VertexState { module: &shader, entry_point: "vs", buffers: &[], compilation_options: Default::default() }, fragment: Some(wgpu::FragmentState { module: &shader, entry_point: "fs", targets: &[Some(wgpu::ColorTargetState { format: fmt, blend: None, write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }), primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview: None, cache: None });
    let target = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: OUT_W, height: OUT_H, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: fmt, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
    let tv = target.create_view(&Default::default());
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0), entries: &[wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) }, wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&sv) }, wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&wv) }] });
    let bpr = ((OUT_W * 4 + 255) & !255) as u64;
    let rbuf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: bpr * OUT_H as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });

    let mut tight = vec![0u8; (OUT_W * OUT_H * 4) as usize];
    let mut last_webcam: Option<Vec<u8>> = None;
    let mut prev = None; let warm = FRAMES / 4; let mut warm_t = Instant::now(); let mut done = 0u32;

    for i in 0..FRAMES {
        if i == warm { warm_t = Instant::now(); }
        let srgba = match screen_rx.recv() { Ok(f) => f, Err(_) => break };
        let wrgba = match webcam_rx.try_recv() { Ok(f) => { last_webcam = Some(f.clone()); f }, Err(_) => last_webcam.clone().unwrap_or_else(|| vec![0u8; (WEBCAM_W * WEBCAM_H * 4) as usize]) };

        let t = i as f32 / FPS as f32;
        let (u, memo) = evaluate(t, prev); prev = Some(memo);
        upload(&queue, &st, SCREEN_W, SCREEN_H, &srgba);
        upload(&queue, &wt, WEBCAM_W, WEBCAM_H, &wrgba);
        queue.write_buffer(&ubuf, 0, bytemuck::bytes_of(&u));

        let mut e = device.create_command_encoder(&Default::default());
        { let mut p = e.begin_render_pass(&wgpu::RenderPassDescriptor { label: None, color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &tv, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None });
          p.set_pipeline(&pipe); p.set_bind_group(0, &bind, &[]); p.draw(0..3, 0..1); }
        e.copy_texture_to_buffer(wgpu::ImageCopyTexture { texture: &target, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, wgpu::ImageCopyBuffer { buffer: &rbuf, layout: wgpu::ImageDataLayout { offset: 0, bytes_per_row: Some(bpr as u32), rows_per_image: Some(OUT_H) } }, wgpu::Extent3d { width: OUT_W, height: OUT_H, depth_or_array_layers: 1 });
        queue.submit([e.finish()]);
        if std::env::args().any(|a| a == "no-readback") {
            // Probe: isolate decode+composite from the descent. Still fence, so the
            // composite actually completes (no empty-loop artifact).
            device.poll(wgpu::Maintain::Wait);
        } else {
            let slice = rbuf.slice(..);
            slice.map_async(wgpu::MapMode::Read, |_| {});
            device.poll(wgpu::Maintain::Wait);
            { let m = slice.get_mapped_range(); for y in 0..OUT_H { let s = (y as u64 * bpr) as usize; let d = (y * OUT_W * 4) as usize; tight[d..d + (OUT_W * 4) as usize].copy_from_slice(&m[s..s + (OUT_W * 4) as usize]); } }
            rbuf.unmap();
            if let Some(tx) = &enc_tx { tx.send(tight.clone()).ok(); }
        }
        done = i + 1;
    }

    drop(enc_tx); // closes the channel → encode thread flushes and muxes
    if let Some(j) = enc_join { let _ = j.join(); } // include the drain in the wall
    let wf = done.saturating_sub(warm); let secs = warm_t.elapsed().as_secs_f32();
    println!("native throughput (threaded in-process decode): {:.1} fps  ({wf} frames after warm-up in {secs:.2}s{})", wf as f32 / secs, if no_encode { ", no encode" } else { ", + h264_amf" });
}
