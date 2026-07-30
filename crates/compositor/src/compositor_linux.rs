//! Moteur de composition Linux -- wgpu / WGSL.
//!
//! Equivalent Linux de `compositor_windows.rs` / `compositor_macos.rs` : meme
//! surface publique (`Compositor::{new, new_sized, normalize_render_size,
//! render_size, set_scene, set_live_params, set_cursor, set_cursor_time,
//! set_timeline_time, clear_cursor, scene_snapshot, clear_srv_cache,
//! compose_frame, readback_direct}`) pour que `live.rs` et `compositor-view-napi`
//! (cfg-re-exportes via `crate::compositor`) l'utilisent sans connaitre la
//! plateforme.
//!
//! **Iso-render.** La GEOMETRIE (placement de chaque calque) vient de
//! `frame_geometry::plan_frame` -- la MEME fonction que Windows/macOS, au pixel
//! pres. Ce module ne fait que RENDRE le `FrameGeometry` via wgpu/WGSL
//! (`vk_shaders/layer.wgsl`), la ou macOS le rend via Metal/MSL.
//!
//! **Portee actuelle.** `compose_frame` rend le coeur : fond uni + calque ecran
//! cover-fit (coins arrondis). Les calques riches (webcam PiP, curseur,
//! annotations texte mode 11, blur de fond, tilt 3D, motion blur) sont dessines
//! par les memes primitives (`draw_layer`) et arrivent par iterations, comme le
//! port Metal les a ajoutes -- chacun reutilise `layer.wgsl` (modes deja portes)
//! ou une passe dediee (`blur.wgsl`).

use std::cell::RefCell;

use anyhow::Result;
use wgpu::util::DeviceExt;

use crate::config::Cfg;
use crate::d3d::Gpu;
use crate::ffi::AVFrame;
// Re-exports que le code partage (live.rs, compositor-view-napi) consomme via
// `crate::compositor::…`, a l'identique de `compositor_macos`.
pub use crate::frame_geometry::{
    live_params_from_scene, webcam_shape_code, FIXTURE_FRAMES, LayerCB, LiveParams, OUT_H, OUT_W,
};
use crate::frame_geometry::{parse_hex, plan_frame, FrameGeometryInput};
use crate::scene::{Scene, SceneBackground};

const LAYER_WGSL: &str = include_str!("vk_shaders/layer.wgsl");

/// `&LayerCB` -> `&[u8; 128]`. `LayerCB` est `#[repr(C, align(16))]`, son layout
/// EST le buffer uniforme WGSL (16 vec4 + 1 vec2 + 2 f32 = 128 octets).
fn layer_bytes(cb: &LayerCB) -> &[u8] {
    unsafe { std::slice::from_raw_parts(cb as *const LayerCB as *const u8, 128) }
}

pub struct Compositor {
    gpu: Gpu,
    render_w: u32,
    render_h: u32,

    // Pipeline de calque (VS + FS `layer.wgsl`), sampler lineaire, bind group
    // layout (uniform + 2 textures + sampler). Immuables apres `new_sized`.
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,

    // Render target offscreen + buffer de readback (recree au resize).
    rt: wgpu::Texture,
    rt_view: wgpu::TextureView,
    readback_buf: wgpu::Buffer,
    /// `bytes_per_row` padde a 256 (contrainte wgpu de copy_texture_to_buffer).
    readback_bpr: u32,

    // Etat pilote par live.rs (interior mutability : les methodes sont `&self`).
    live_params: RefCell<LiveParams>,
    scene: RefCell<Option<Scene>>,
    cursor: RefCell<Option<crate::cursor::CursorTrack>>,
    cursor_time: RefCell<Option<f32>>,
    timeline_time: RefCell<Option<f32>>,

    /// Rasterizer de texte (annotations mode 11). `None` si l'init cosmic-text
    /// echoue -- le rendu continue sans texte plutot que de tout casser.
    #[allow(dead_code)]
    text_raster: Option<crate::text::TextRasterizer>,
}

impl Compositor {
    pub fn new(gpu: &Gpu) -> Result<Compositor> {
        Self::new_sized(gpu, OUT_W, OUT_H)
    }

    pub fn new_sized(gpu: &Gpu, w: u32, h: u32) -> Result<Compositor> {
        let (w, h) = Self::normalize_render_size(w, h);
        let gpu = Gpu {
            device: gpu.device.clone(),
            context: gpu.context.clone(),
            backend: gpu.backend,
            feature_level: gpu.feature_level,
        };

        let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("layer.wgsl"),
            source: wgpu::ShaderSource::Wgsl(LAYER_WGSL.into()),
        });
        let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("layer"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        let tex_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let bind_group_layout =
            gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("layer"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(128),
                        },
                        count: None,
                    },
                    tex_entry(1),
                    tex_entry(2),
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
        let pipeline_layout = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("layer"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let pipeline = gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("layer"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let (rt, rt_view, readback_buf, readback_bpr) = Self::make_targets(&gpu, w, h);

        Ok(Compositor {
            gpu,
            render_w: w,
            render_h: h,
            pipeline,
            bind_group_layout,
            sampler,
            rt,
            rt_view,
            readback_buf,
            readback_bpr,
            live_params: RefCell::new(LiveParams::default()),
            scene: RefCell::new(None),
            cursor: RefCell::new(None),
            cursor_time: RefCell::new(None),
            timeline_time: RefCell::new(None),
            text_raster: crate::text::TextRasterizer::new().ok(),
        })
    }

    /// RT RGBA8 + buffer de readback (bytes_per_row padde a 256).
    fn make_targets(
        gpu: &Gpu,
        w: u32,
        h: u32,
    ) -> (wgpu::Texture, wgpu::TextureView, wgpu::Buffer, u32) {
        let rt = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("rt"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let rt_view = rt.create_view(&wgpu::TextureViewDescriptor::default());
        let bpr = (w * 4).div_ceil(256) * 256;
        let readback_buf = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: u64::from(bpr) * u64::from(h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        (rt, rt_view, readback_buf, bpr)
    }

    /// Dimensions paires (NV12 4:2:0), min 2x2. Symetrie avec les autres backends.
    pub fn normalize_render_size(w: u32, h: u32) -> (u32, u32) {
        ((w.max(2) + 1) & !1, (h.max(2) + 1) & !1)
    }

    pub fn render_size(&self) -> (u32, u32) {
        (self.render_w, self.render_h)
    }

    pub fn set_live_params(&self, p: LiveParams) {
        *self.live_params.borrow_mut() = p;
    }

    pub fn set_scene(&self, s: Option<Scene>) {
        *self.scene.borrow_mut() = s;
    }

    pub fn set_cursor(&self, track: crate::cursor::CursorTrack) {
        *self.cursor.borrow_mut() = Some(track);
    }

    pub fn set_cursor_time(&self, t: Option<f32>) {
        *self.cursor_time.borrow_mut() = t;
    }

    pub fn set_timeline_time(&self, t: Option<f32>) {
        *self.timeline_time.borrow_mut() = t;
    }

    pub fn clear_cursor(&self) {
        *self.cursor.borrow_mut() = None;
    }

    pub fn scene_snapshot(&self) -> Option<Scene> {
        self.scene.borrow().clone()
    }

    /// Pas de cache de SRV cote wgpu (les `TextureView`s sont recreees a chaque
    /// draw depuis le carrier) -- no-op conserve pour la symetrie d'API.
    pub fn clear_srv_cache(&self) {}

    // -- seam frame (lit le carrier `data[0]`) --

    fn pixel_buffer_of(frame: *const AVFrame) -> Option<()> {
        if frame.is_null() || unsafe { (*frame).data[0] }.is_null() {
            None
        } else {
            Some(())
        }
    }

    unsafe fn nv12_srvs(
        &self,
        frame: *const AVFrame,
    ) -> Result<(wgpu::TextureView, wgpu::TextureView)> {
        crate::linux_frames::nv12_planes(frame)
    }

    unsafe fn tex_dims(&self, frame: *const AVFrame) -> (u32, u32) {
        if frame.is_null() || (*frame).data[0].is_null() {
            return (1, 1);
        }
        crate::linux_frames::carrier_dims(frame)
    }

    // -- rendu --

    /// Prepare un draw de calque : buffer uniforme init a `cb` + bind group
    /// (uniform + deux textures + sampler). Cree AVANT la render pass pour que
    /// les ressources vivent pendant tout le pass. Un buffer PAR draw :
    /// `write_buffer` entre draws d'une meme pass ne s'entrelace pas.
    fn make_bind(
        &self,
        cb: &LayerCB,
        planes: Option<(&wgpu::TextureView, &wgpu::TextureView)>,
        dummy: &wgpu::TextureView,
    ) -> (wgpu::Buffer, wgpu::BindGroup) {
        let uniform = self.gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("layer-uniform"),
            contents: layer_bytes(cb),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let (y, uv) = planes.unwrap_or((dummy, dummy));
        let bind = self.gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("layer"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(y),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(uv),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        (uniform, bind)
    }

    /// Rend une frame dans le RT interne. Le screen `screen`/`webcam` sont des
    /// carriers `linux_frames` ; la geometrie vient de `plan_frame`. Coeur :
    /// fond uni + ecran cover-fit. `readback_direct` lit ensuite le RT.
    pub unsafe fn compose_frame(
        &self,
        screen: *const AVFrame,
        webcam: *const AVFrame,
        frame: f32,
        cfg: &Cfg,
    ) -> Result<()> {
        if Self::pixel_buffer_of(screen).is_none() {
            return self.clear_rt();
        }
        let (sy, suv) = self.nv12_srvs(screen)?;
        let (stw, sth) = self.tex_dims(screen);
        let (wtw, wth) = self.tex_dims(webcam);
        let (scw, sch) = ((*screen).width as f32, (*screen).height as f32);
        let (wcw, wch) = if webcam.is_null() {
            (1.0, 1.0)
        } else {
            ((*webcam).width as f32, (*webcam).height as f32)
        };
        let u_max = scw / (stw.max(1)) as f32;
        let v_max = sch / (sth.max(1)) as f32;
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);

        let scene_ref = self.scene.borrow();
        let cursor_ref = self.cursor.borrow();
        let lp = *self.live_params.borrow();
        let g = plan_frame(&FrameGeometryInput {
            render_px: [rw, rh],
            screen_tex_px: [stw as f32, sth as f32],
            screen_visible_px: [scw, sch],
            webcam_visible_px: [wcw, wch],
            u_max,
            v_max,
            frame,
            cfg,
            live: lp,
            scene: scene_ref.as_ref(),
            cursor: cursor_ref.as_ref(),
            timeline_t_override: *self.timeline_time.borrow(),
        });
        let _ = (wtw, wth); // webcam PiP : calque a venir.

        // Couleur de fond : scene Color -> sa couleur, sinon live_params.bg_color.
        // (Gradient/Image : calques a venir ; repli couleur ici.)
        let bg = match scene_ref.as_ref().map(|s| s.background.clone()) {
            Some(SceneBackground::Color { color }) => parse_hex(&color).unwrap_or(lp.bg_color),
            _ => lp.bg_color,
        };

        // Calque ecran (mode 0 : NV12 -> RGB), place par plan_frame (cover-fit +
        // coins arrondis). `src = g.cut` (crop utilisateur + zoom en UV texture).
        let screen_layer = LayerCB {
            dst: g.s_dst,
            src: g.cut,
            quad_px: [g.s_dst[2] * rw, g.s_dst[3] * rh],
            radius_px: g.s_radius,
            mode: 0.0,
            color: [1.0, 1.0, 1.0, 1.0],
            ..Default::default()
        };
        // Bind group construit AVANT le pass (doit vivre pendant tout le pass) ;
        // `_screen_uniform` garde le buffer uniforme en vie (reference par le bind).
        let dummy = self.dummy_view();
        let (_screen_uniform, screen_bind) =
            self.make_bind(&screen_layer, Some((&sy, &suv)), &dummy);

        // Annotations TEXTE (mode 11) -- placees relativement au rect ecran
        // `g.s_dst` (les coords x/y/w/h de l'annotation sont des fractions de ce
        // rect, cf. `scene.rs`). Mirroir de la branche "text" de
        // `compositor_macos`, tint cote shader (atlas R8) au lieu de couleur
        // bakee. (image/figure/blur + animation `text_anim` : incremental.)
        struct AnnDraw {
            _buf: wgpu::Buffer,
            _glyphs: crate::text::RasterizedGlyphs,
            bind: wgpu::BindGroup,
        }
        let mut ann_draws: Vec<AnnDraw> = Vec::new();
        if let (Some(scene), Some(raster)) = (scene_ref.as_ref(), self.text_raster.as_ref()) {
            for a in &scene.annotations {
                if a.kind != "text" {
                    continue;
                }
                let Some(text) = a.text.as_ref() else { continue };
                if text.content.trim().is_empty() {
                    continue;
                }
                let dst = [
                    g.s_dst[0] + a.x * g.s_dst[2],
                    g.s_dst[1] + a.y * g.s_dst[3],
                    a.w * g.s_dst[2],
                    a.h * g.s_dst[3],
                ];
                let quad_px = [dst[2] * rw, dst[3] * rh];
                let color = parse_hex(&text.color).unwrap_or([1.0, 1.0, 1.0, 1.0]);
                let spec = crate::text::TextSpec {
                    content: text.content.clone(),
                    color,
                    background: parse_hex(&text.background_color).unwrap_or([0.0, 0.0, 0.0, 0.0]),
                    font_size_px: text.font_size_rel * (g.s_dst[3] * rh),
                    font_family: text.font_family.clone(),
                    bold: text.font_weight == "bold",
                    italic: text.font_style == "italic",
                    underline: text.text_decoration == "underline",
                    align: text.text_align.clone(),
                    box_px: [
                        quad_px[0].round().max(1.0) as u32,
                        quad_px[1].round().max(1.0) as u32,
                    ],
                };
                let glyphs = match raster.rasterize(&self.gpu, &spec) {
                    Ok(gl) => gl,
                    Err(e) => {
                        eprintln!("[annotation texte] {}: {e:#}", a.id);
                        continue;
                    }
                };
                let cb = LayerCB {
                    dst,
                    src: [0.0, 0.0, 1.0, 1.0],
                    quad_px,
                    mode: 11.0,
                    color,
                    ..Default::default()
                };
                // Atlas R8 au binding 1 (texY) que le mode 11 echantillonne.
                let (buf, bind) = self.make_bind(&cb, Some((&glyphs.view, &glyphs.view)), &dummy);
                ann_draws.push(AnnDraw {
                    _buf: buf,
                    _glyphs: glyphs,
                    bind,
                });
            }
        }

        let mut encoder = self.gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("compose"),
        });
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("compose-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.rt_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // Le fond uni EST la couleur de clear (gradient/image
                        // ajouteront un draw ici).
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: bg[0] as f64,
                            g: bg[1] as f64,
                            b: bg[2] as f64,
                            a: bg[3] as f64,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            rpass.set_pipeline(&self.pipeline);
            rpass.set_bind_group(0, &screen_bind, &[]);
            rpass.draw(0..4, 0..1);
            // Annotations texte par-dessus (ordre de la liste = z-index, deja
            // trie cote app).
            for a in &ann_draws {
                rpass.set_bind_group(0, &a.bind, &[]);
                rpass.draw(0..4, 0..1);
            }
        }
        self.gpu.context.submit(std::iter::once(encoder.finish()));
        Ok(())
    }

    /// Clear le RT a la couleur de fond (ecran absent).
    fn clear_rt(&self) -> Result<()> {
        let bg = self.live_params.borrow().bg_color;
        let mut encoder = self.gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("clear"),
        });
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("clear-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.rt_view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: bg[0] as f64,
                        g: bg[1] as f64,
                        b: bg[2] as f64,
                        a: bg[3] as f64,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        self.gpu.context.submit(std::iter::once(encoder.finish()));
        Ok(())
    }

    fn dummy_view(&self) -> wgpu::TextureView {
        let t = self.gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("dummy"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        t.create_view(&wgpu::TextureViewDescriptor::default())
    }

    /// Lit le RT en RGBA8 tightly-packed `(render_w * render_h * 4)`. Depadde le
    /// `bytes_per_row` aligne a 256 exige par wgpu.
    pub unsafe fn readback_direct(&self) -> Result<(u32, u32, Vec<u8>)> {
        let (w, h) = (self.render_w, self.render_h);
        let mut encoder = self.gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("readback"),
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.rt,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &self.readback_buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(self.readback_bpr),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        self.gpu.context.submit(std::iter::once(encoder.finish()));

        let slice = self.readback_buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.gpu.device.poll(wgpu::Maintain::Wait);
        rx.recv()
            .map_err(|_| anyhow::anyhow!("map_async channel"))?
            .map_err(|e| anyhow::anyhow!("map_async: {e:?}"))?;
        let mapped = slice.get_mapped_range();

        let row = (w * 4) as usize;
        let bpr = self.readback_bpr as usize;
        let mut out = vec![0u8; row * h as usize];
        for y in 0..h as usize {
            out[y * row..(y + 1) * row].copy_from_slice(&mapped[y * bpr..y * bpr + row]);
        }
        drop(mapped);
        self.readback_buf.unmap();
        Ok((w, h, out))
    }
}
