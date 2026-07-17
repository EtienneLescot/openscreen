// Native throughput POC: stream-decode both sources, composite every frame with
// the WGSL shader on wgpu, encode with the AMD hardware H.264 encoder (h264_amf).
// No browser, no WebCodecs. Reports the honest native throughput.
//
// This path DOES read the composited frame back to the CPU to pipe it into
// ffmpeg — the "descent" the architecture doc names as the killer. That is
// deliberate: it is the tractable native baseline. If it already beats the web
// platform's 79 fps, native wins even carrying the descent; the zero-descent
// GPU→encoder interop (the real §12 G-A prize) is the next step, and this is the
// number it must beat.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Instant;

const OUT_W: u32 = 1920;
const OUT_H: u32 = 1080;
const FPS: u32 = 30;
const SCREEN_W: u32 = 1920;
const SCREEN_H: u32 = 1032;
const WEBCAM_W: u32 = 640;
const WEBCAM_H: u32 = 480;
const FRAMES: u32 = 180; // 6 s

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms {
    a: [f32; 4],
    screen: [f32; 4],
    webcam: [f32; 4],
    fx: [f32; 4],
    b: [f32; 4],
    mb: [f32; 4],
    cursor: [f32; 4],
    cursor_fx: [f32; 4],
}

#[derive(Clone, Copy)]
struct Rect { x: f32, y: f32, w: f32, h: f32 }

fn ease(x: f32) -> f32 {
    if x < 0.5 { 4.0 * x * x * x } else { 1.0 - (-2.0 * x + 2.0).powi(3) / 2.0 }
}
fn region_strength(t: f32, start: f32, end: f32, ramp: f32) -> f32 {
    if t <= start || t >= end { return 0.0; }
    let in_r = ((t - start) / ramp).min(1.0);
    let out_r = ((end - t) / ramp).min(1.0);
    ease(in_r.min(out_r))
}
fn lerp(a: f32, b: f32, t: f32) -> f32 { a + (b - a) * t }

// evaluate(): zoom + layout animation + motion blur, ported from the web POC.
fn evaluate(t: f32, prev: Option<(f32, f32, f32, f32)>) -> (Uniforms, (f32, f32, f32, f32)) {
    let padding = 45.0;
    let s = 1.0 - (padding / 100.0) * 0.4;
    let bw = OUT_W as f32 * s;
    let bh = OUT_H as f32 * s;
    let base_screen = Rect { x: (OUT_W as f32 - bw) / 2.0, y: (OUT_H as f32 - bh) / 2.0, w: bw, h: bh };
    let size = (OUT_H as f32 * 0.22).round();
    let margin = (OUT_H as f32 * 0.04).round();
    let base_webcam = Rect { x: OUT_W as f32 - size - margin, y: OUT_H as f32 - size - margin, w: size, h: size };

    // zoom: strongest region wins
    let zooms = [(1.0, 3.2, 1.7, 0.62, 0.42, 0.55), (4.4, 6.5, 2.3, 0.3, 0.7, 0.5)];
    let (mut zoom, mut fxn, mut fyn, mut strength) = (1.0f32, 0.5f32, 0.5f32, 0.0f32);
    for (st, en, sc, cx, cy, ramp) in zooms {
        let str_ = region_strength(t, st, en, ramp);
        if str_ > strength { strength = str_; zoom = lerp(1.0, sc, str_); fxn = cx; fyn = cy; }
    }
    let fx = base_screen.x + base_screen.w * fxn;
    let fy = base_screen.y + base_screen.h * fyn;
    let screen = Rect {
        x: fx - (fx - base_screen.x) * zoom,
        y: fy - (fy - base_screen.y) * zoom,
        w: base_screen.w * zoom,
        h: base_screen.h * zoom,
    };

    // layout move: webcam grows into a panel, shape morphs
    let mut mv = 0.0f32;
    mv = mv.max(region_strength(t, 2.4, 5.0, 0.6));
    let panel_w = (OUT_W as f32 * 0.34).round();
    let panel_h = (panel_w * 0.75).round();
    let panel = Rect { x: OUT_W as f32 - panel_w - margin, y: OUT_H as f32 - panel_h - margin, w: panel_w, h: panel_h };
    let webcam = Rect {
        x: lerp(base_webcam.x, panel.x, mv),
        y: lerp(base_webcam.y, panel.y, mv),
        w: lerp(base_webcam.w, panel.w, mv),
        h: lerp(base_webcam.h, panel.h, mv),
    };
    let webcam_radius = lerp(base_webcam.w.min(base_webcam.h) / 2.0, 26.0, mv);

    // motion blur vector from centre delta
    let cx = screen.x + screen.w / 2.0;
    let cy = screen.y + screen.h / 2.0;
    let (mut sbx, mut sby) = (0.0f32, 0.0f32);
    if let Some((pcx, pcy, _, _)) = prev {
        let k = 0.9;
        sbx = ((cx - pcx) * k).clamp(-22.0, 22.0);
        sby = ((cy - pcy) * k).clamp(-22.0, 22.0);
    }

    let cam_aspect = WEBCAM_W as f32 / WEBCAM_H as f32;
    let cur_x = screen.x + 0.52 * screen.w;
    let cur_y = screen.y + 0.90 * screen.h;
    let u = Uniforms {
        a: [OUT_W as f32, OUT_H as f32, t, 28.0],
        screen: [screen.x, screen.y, screen.w, screen.h],
        webcam: [webcam.x, webcam.y, webcam.w, webcam.h],
        fx: [0.7, 0.0, 16.0, 22.0],
        b: [webcam_radius, 0.0, cam_aspect, 0.0],
        mb: [sbx, sby, 0.0, 0.0],
        cursor: [cur_x, cur_y, OUT_H as f32 * 0.05, 1.0],
        cursor_fx: [0.0, 0.0, 1.0, 0.0],
    };
    (u, (cx, cy, screen.w, screen.h))
}

fn spawn_decode(path: &str) -> std::process::Child {
    // Force 30 fps so screen (60) and webcam decode align frame-to-frame.
    Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-i", path, "-vf", "fps=30", "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("ffmpeg decode spawn")
}

fn read_frame(r: &mut impl Read, buf: &mut [u8]) -> bool {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => return false,
            Ok(n) => filled += n,
            Err(_) => return false,
        }
    }
    true
}

fn upload(queue: &wgpu::Queue, tex: &wgpu::Texture, w: u32, h: u32, rgba: &[u8]) {
    queue.write_texture(
        wgpu::ImageCopyTexture { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        rgba,
        wgpu::ImageDataLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(h) },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
}

fn tex2d(device: &wgpu::Device, w: u32, h: u32, label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

fn main() {
    // --- decoders + encoder ---
    let mut dec_s = spawn_decode("../poc/media/screen.mp4");
    let mut dec_w = spawn_decode("../poc/media/webcam.mp4");
    let mut sout = dec_s.stdout.take().unwrap();
    let mut wout = dec_w.stdout.take().unwrap();

    let mut enc = Command::new("ffmpeg")
        .args([
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", &format!("{OUT_W}x{OUT_H}"), "-framerate", &FPS.to_string(), "-i", "-",
            "-c:v", "h264_amf", "-b:v", "8M", "-usage", "transcoding", "out.mp4",
        ])
        .stdin(Stdio::piped())
        .spawn()
        .expect("ffmpeg encode spawn");
    let mut ein = enc.stdin.take().unwrap();

    // --- wgpu ---
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::default());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default()
    })).expect("adapter");
    println!("native gpu: {} (backend {:?})", adapter.get_info().name, adapter.get_info().backend);
    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor { label: None, required_features: wgpu::Features::empty(), required_limits: wgpu::Limits::default(), memory_hints: wgpu::MemoryHints::Performance }, None,
    )).expect("device");

    let screen_tex = tex2d(&device, SCREEN_W, SCREEN_H, "screen");
    let webcam_tex = tex2d(&device, WEBCAM_W, WEBCAM_H, "webcam");
    let screen_view = screen_tex.create_view(&Default::default());
    let webcam_view = webcam_tex.create_view(&Default::default());
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });

    let ubuf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: std::mem::size_of::<Uniforms>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(include_str!("../composite.wgsl").into()) });
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None, layout: None,
        vertex: wgpu::VertexState { module: &shader, entry_point: "vs", buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &shader, entry_point: "fs", targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }),
        primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview: None, cache: None,
    });
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: None, size: wgpu::Extent3d { width: OUT_W, height: OUT_H, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[],
    });
    let target_view = target.create_view(&Default::default());
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None, layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&screen_view) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&webcam_view) },
        ],
    });
    let bpr = ((OUT_W * 4 + 255) & !255) as u64;
    let rbuf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: bpr * OUT_H as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });

    let mut screen_rgba = vec![0u8; (SCREEN_W * SCREEN_H * 4) as usize];
    let mut webcam_rgba = vec![0u8; (WEBCAM_W * WEBCAM_H * 4) as usize];
    let mut have_webcam = false;
    let mut tight = vec![0u8; (OUT_W * OUT_H * 4) as usize];
    let mut prev = None;
    let warm = FRAMES / 4;
    let mut warm_t = Instant::now();
    let mut done = 0u32;

    for i in 0..FRAMES {
        if i == warm { warm_t = Instant::now(); }
        if !read_frame(&mut sout, &mut screen_rgba) { break; }
        if read_frame(&mut wout, &mut webcam_rgba) { have_webcam = true; } // else reuse last
        let _ = have_webcam;

        let t = i as f32 / FPS as f32;
        let (u, memo) = evaluate(t, prev);
        prev = Some(memo);

        upload(&queue, &screen_tex, SCREEN_W, SCREEN_H, &screen_rgba);
        upload(&queue, &webcam_tex, WEBCAM_W, WEBCAM_H, &webcam_rgba);
        queue.write_buffer(&ubuf, 0, bytemuck::bytes_of(&u));

        let mut e = device.create_command_encoder(&Default::default());
        {
            let mut pass = e.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &target_view, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.draw(0..3, 0..1);
        }
        e.copy_texture_to_buffer(
            wgpu::ImageCopyTexture { texture: &target, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::ImageCopyBuffer { buffer: &rbuf, layout: wgpu::ImageDataLayout { offset: 0, bytes_per_row: Some(bpr as u32), rows_per_image: Some(OUT_H) } },
            wgpu::Extent3d { width: OUT_W, height: OUT_H, depth_or_array_layers: 1 },
        );
        queue.submit([e.finish()]);

        // The descent: map the composited frame to the CPU, un-pad, pipe to encoder.
        let slice = rbuf.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::Maintain::Wait);
        {
            let mapped = slice.get_mapped_range();
            for y in 0..OUT_H {
                let src = (y as u64 * bpr) as usize;
                let dst = (y * OUT_W * 4) as usize;
                tight[dst..dst + (OUT_W * 4) as usize].copy_from_slice(&mapped[src..src + (OUT_W * 4) as usize]);
            }
        }
        rbuf.unmap();
        if std::env::args().nth(1).as_deref() != Some("no-encode") { ein.write_all(&tight).expect("pipe to encoder"); }
        done = i + 1;
    }

    drop(ein);
    let _ = enc.wait();
    let _ = dec_s.kill();
    let _ = dec_w.kill();

    let warm_frames = done.saturating_sub(warm);
    let secs = warm_t.elapsed().as_secs_f32();
    let fps = warm_frames as f32 / secs;
    println!("native throughput: {:.1} fps  ({warm_frames} frames after warm-up in {secs:.2}s, incl. descent + h264_amf)", fps);
}
