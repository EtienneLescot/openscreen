// Native full-shader compositor POC — milestone 1: prove wgpu runs the WGSL and
// composites a real frame, natively, no browser.
//
// Decode one real frame from each source with ffmpeg (to raw RGBA), upload as
// wgpu textures, run the SAME shader as the web POC (adapted for native), render
// to an offscreen 1080p target, read it back, write a BMP. If the picture matches
// the web POC at the same t, the compositor has moved to native unchanged.

use std::fs;
use std::process::Command;

const OUT_W: u32 = 1920;
const OUT_H: u32 = 1080;
const SCREEN_W: u32 = 1920;
const SCREEN_H: u32 = 1032;
const WEBCAM_W: u32 = 640;
const WEBCAM_H: u32 = 480;

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

struct Rect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

// evaluate(), ported from the web POC. At t=0.5s: no zoom (starts 1.0), no layout
// move (starts 2.4), so the recording sits padded and the webcam is a docked
// circle — the frame where background + shadow + rounded corners are all visible.
fn base_layout(padding: f32) -> (Rect, Rect) {
    let s = 1.0 - (padding / 100.0) * 0.4;
    let w = OUT_W as f32 * s;
    let h = OUT_H as f32 * s;
    let screen = Rect {
        x: (OUT_W as f32 - w) / 2.0,
        y: (OUT_H as f32 - h) / 2.0,
        w,
        h,
    };
    let size = (OUT_H as f32 * 0.22).round();
    let margin = (OUT_H as f32 * 0.04).round();
    let webcam = Rect {
        x: OUT_W as f32 - size - margin,
        y: OUT_H as f32 - size - margin,
        w: size,
        h: size,
    };
    (screen, webcam)
}

fn decode_frame(path: &str, t: &str, w: u32, h: u32, out: &str) -> Vec<u8> {
    // One real frame → raw RGBA. ffmpeg is the native hardware/software decoder;
    // this is the decode seam. For the compositor milestone it runs once.
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner", "-loglevel", "error", "-y", "-ss", t, "-i", path, "-frames:v", "1",
            "-f", "rawvideo", "-pix_fmt", "rgba", out,
        ])
        .status()
        .expect("ffmpeg failed to run");
    assert!(status.success(), "ffmpeg decode failed for {path}");
    let data = fs::read(out).expect("read decoded frame");
    assert_eq!(data.len(), (w * h * 4) as usize, "unexpected frame size for {path}");
    data
}

fn make_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    w: u32,
    h: u32,
    rgba: &[u8],
    label: &str,
) -> wgpu::TextureView {
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::ImageCopyTexture {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        rgba,
        wgpu::ImageDataLayout {
            offset: 0,
            bytes_per_row: Some(w * 4),
            rows_per_image: Some(h),
        },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    tex.create_view(&wgpu::TextureViewDescriptor::default())
}

fn write_bmp(path: &str, w: u32, h: u32, rgba: &[u8]) {
    // 24-bit BMP, bottom-up. No image crate: keeps the native POC's deps to wgpu.
    let row = (w * 3 + 3) & !3; // 4-byte aligned
    let size = 54 + row * h;
    let mut f = Vec::with_capacity(size as usize);
    f.extend_from_slice(b"BM");
    f.extend_from_slice(&size.to_le_bytes());
    f.extend_from_slice(&0u32.to_le_bytes());
    f.extend_from_slice(&54u32.to_le_bytes());
    f.extend_from_slice(&40u32.to_le_bytes());
    f.extend_from_slice(&(w as i32).to_le_bytes());
    f.extend_from_slice(&(h as i32).to_le_bytes());
    f.extend_from_slice(&1u16.to_le_bytes());
    f.extend_from_slice(&24u16.to_le_bytes());
    f.extend_from_slice(&[0u8; 24]);
    for y in (0..h).rev() {
        let mut written = 0u32;
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            f.push(rgba[i + 2]);
            f.push(rgba[i + 1]);
            f.push(rgba[i]);
            written += 3;
        }
        while written < row {
            f.push(0);
            written += 1;
        }
    }
    fs::write(path, f).expect("write bmp");
}

fn main() {
    let t = 0.5f32;
    let padding = 45.0f32;

    // --- decode one real frame from each source ---
    let screen_rgba = decode_frame("../poc/media/screen.mp4", "0.5", SCREEN_W, SCREEN_H, "screen.rgba");
    let webcam_rgba = decode_frame("../poc/media/webcam.mp4", "0.5", WEBCAM_W, WEBCAM_H, "webcam.rgba");

    // --- wgpu init (native: Vulkan/D3D12/Metal under the hood) ---
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::default());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .expect("no GPU adapter");
    let info = adapter.get_info();
    println!("native gpu: {} ({:?}, backend {:?})", info.name, info.device_type, info.backend);
    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor { label: None, required_features: wgpu::Features::empty(), required_limits: wgpu::Limits::default(), memory_hints: wgpu::MemoryHints::Performance },
        None,
    ))
    .expect("no device");

    let screen_view = make_texture(&device, &queue, SCREEN_W, SCREEN_H, &screen_rgba, "screen");
    let webcam_view = make_texture(&device, &queue, WEBCAM_W, WEBCAM_H, &webcam_rgba, "webcam");
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });

    // --- uniforms: evaluate() at t=0.5 ---
    let (screen, webcam) = base_layout(padding);
    let cam_aspect = WEBCAM_W as f32 / WEBCAM_H as f32;
    let cur_x = screen.x + 0.52 * screen.w;
    let cur_y = screen.y + 0.90 * screen.h;
    let cur_size = OUT_H as f32 * 0.05;
    let uniforms = Uniforms {
        a: [OUT_W as f32, OUT_H as f32, t, 28.0],
        screen: [screen.x, screen.y, screen.w, screen.h],
        webcam: [webcam.x, webcam.y, webcam.w, webcam.h],
        fx: [0.7, 0.0, 16.0, 22.0],
        b: [webcam.w.min(webcam.h) / 2.0, 0.0, cam_aspect, 0.0],
        mb: [0.0, 0.0, 0.0, 0.0],
        cursor: [cur_x, cur_y, cur_size, 1.0],
        cursor_fx: [0.0, 0.0, 1.0, 0.0],
    };
    let ubuf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("uniforms"),
        size: std::mem::size_of::<Uniforms>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&ubuf, 0, bytemuck::bytes_of(&uniforms));

    // --- pipeline ---
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("composite"),
        source: wgpu::ShaderSource::Wgsl(include_str!("composite.wgsl").into()),
    });
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("composite"),
        layout: None,
        vertex: wgpu::VertexState { module: &shader, entry_point: "vs", buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: "fs",
            targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    });

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("target"),
        size: wgpu::Extent3d { width: OUT_W, height: OUT_H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());

    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&screen_view) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&webcam_view) },
        ],
    });

    // --- render ---
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &target_view,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..3, 0..1);
    }

    // --- readback → BMP ---
    let bpr = ((OUT_W * 4 + 255) & !255) as u64; // 256-aligned
    let rbuf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: bpr * OUT_H as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    enc.copy_texture_to_buffer(
        wgpu::ImageCopyTexture { texture: &target, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::ImageCopyBuffer { buffer: &rbuf, layout: wgpu::ImageDataLayout { offset: 0, bytes_per_row: Some(bpr as u32), rows_per_image: Some(OUT_H) } },
        wgpu::Extent3d { width: OUT_W, height: OUT_H, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);

    let slice = rbuf.slice(..);
    slice.map_async(wgpu::MapMode::Read, |r| r.unwrap());
    device.poll(wgpu::Maintain::Wait);
    let mapped = slice.get_mapped_range();
    // Un-pad the 256-aligned rows into tight RGBA.
    let mut tight = vec![0u8; (OUT_W * OUT_H * 4) as usize];
    for y in 0..OUT_H {
        let src = (y as u64 * bpr) as usize;
        let dst = (y * OUT_W * 4) as usize;
        tight[dst..dst + (OUT_W * 4) as usize].copy_from_slice(&mapped[src..src + (OUT_W * 4) as usize]);
    }
    write_bmp("out.bmp", OUT_W, OUT_H, &tight);
    println!("wrote out.bmp — composited natively at t={t}s");
}
