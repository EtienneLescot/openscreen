//! Moteur de composition Linux -- wgpu / WGSL.
//!
//! Equivalent Linux de `compositor_windows.rs` / `compositor_macos.rs` : meme
//! surface publique (`Compositor::{new, new_sized, normalize_render_size,
//! render_size, set_scene, set_live_params, set_cursor, set_cursor_time,
//! set_timeline_time, clear_cursor, scene_snapshot, clear_srv_cache,
//! compose_frame, readback_direct}`) pour que `live.rs` et `compositor-view-napi`
//! (cfg-re-exportes via `crate::compositor`) l'utilisent sans connaitre la
//! plateforme. S'y ajoutent, specifiques a ce backend, les trois entrees de la
//! ring de staging (`set_readback_depth`, `readback_submit`, `readback_take`) :
//! seul l'export Linux les utilise, cf. `ReadbackRing`.
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
use crate::frame_geometry::{
    cursor_sprite_dst, parse_hex, plan_cursor, plan_frame, CursorPlacement, CursorPlanInput,
    FrameGeometryInput,
};
use crate::scene::{Scene, SceneBackground};

const LAYER_WGSL: &str = include_str!("vk_shaders/layer.wgsl");
const BLUR_WGSL: &str = include_str!("vk_shaders/blur.wgsl");

/// `&LayerCB` -> `&[u8; 128]`. `LayerCB` est `#[repr(C, align(16))]`, son layout
/// EST le buffer uniforme WGSL (16 vec4 + 1 vec2 + 2 f32 = 128 octets).
fn layer_bytes(cb: &LayerCB) -> &[u8] {
    unsafe { std::slice::from_raw_parts(cb as *const LayerCB as *const u8, 128) }
}

/// Une copie RT -> staging DEJA SOUMISE, dont le mapping est arme mais pas
/// encore recolte. On garde `idx` (l'index de soumission rendu par
/// `Queue::submit`) pour n'attendre QUE cette soumission-la, et les dimensions
/// telles qu'elles etaient au moment de la copie -- ce sont elles qui decrivent
/// le contenu du buffer, pas celles du compositeur au moment de la recolte.
struct PendingCopy {
    buf: wgpu::Buffer,
    idx: wgpu::SubmissionIndex,
    rx: std::sync::mpsc::Receiver<Result<(), wgpu::BufferAsyncError>>,
    w: u32,
    h: u32,
    bpr: u32,
}

/// Ring de staging de la relecture.
///
/// AVANT : `readback_direct` enregistrait la copie, la soumettait, puis bloquait
/// dans `device.poll(Maintain::Wait)`. Cette attente n'absorbait pas la copie
/// (8,3 Mo = ~0,33 ms de DMA) mais TOUTE la file GPU en cours -- la chaine
/// Kawase et chaque draw de calque, que `compose_frame` avait soumis sans
/// attendre juste avant. Mesure 1080p : 3,8 ms (scene simple) a 6,2 ms (scene
/// chargee) par frame, pendant que `sws_scale` + `avcodec_send_frame` (12,6 ms
/// de CPU pur) attendaient leur tour. Le GPU et le CPU ne se recouvraient
/// jamais.
///
/// MAINTENANT : `readback_submit` soumet la copie de la frame N vers un buffer
/// libre, arme son `map_async` et rend la main ; il ne recolte que la frame la
/// plus ANCIENNE encore en vol. Avec `depth = 2`, c'est la frame N-1, dont la
/// copie a ete soumise avant l'encodage de N-1 et le decodage/composition de N :
/// le GPU a eu ~19 ms de CPU pour finir 6 ms de travail, l'attente tombe a zero.
///
/// PROFONDEUR. 2 est le minimum utile et suffit ici : le seul travail a
/// recouvrir est ce que le CPU fait entre deux relectures (sws + encode,
/// 12,6 ms mesures) et il depasse deja largement la chaine GPU (3,8 a 6,2 ms).
/// Une 3e frame n'ajouterait que 8 Mo de memoire mappable et une frame de
/// latence de plus. La profondeur reste parametrable parce que la POLITIQUE
/// differe par chemin (cf. `set_readback_depth`), pas pour empiler les buffers.
///
/// UN SEUL RT. Le RT n'est pas double-bufferise : la copie de la frame N est
/// soumise AVANT les commandes de composition de la frame N+1, sur la meme
/// queue, et wgpu insere la barriere qui va bien. Le GPU lit donc le RT avant
/// de le reecrire, sans que le CPU ait a l'attendre.
struct ReadbackRing {
    depth: usize,
    /// Buffers disponibles (aucune copie en vol, aucun mapping arme).
    free: Vec<wgpu::Buffer>,
    /// Copies soumises, dans l'ordre de soumission (FIFO strict : les frames
    /// sortent dans l'ordre ou elles ont ete composees).
    pending: std::collections::VecDeque<PendingCopy>,
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

    // Chaine de blur Kawase du fond (`blur.wgsl`) : layout dedie (uniform + 1
    // tex + sampler), 2 pipelines (down/up), 3 textures de pyramide (1/2, 1/4,
    // 1/8 de la sortie). Les `TextureView` gardent leurs textures en vie.
    blur_bgl: wgpu::BindGroupLayout,
    blur_down: wgpu::RenderPipeline,
    blur_up: wgpu::RenderPipeline,
    blur_half: wgpu::TextureView,
    blur_qtr: wgpu::TextureView,
    blur_oct: wgpu::TextureView,

    // Render target offscreen + ring de staging de la relecture (recrees au resize).
    rt: wgpu::Texture,
    rt_view: wgpu::TextureView,
    /// `bytes_per_row` padde a 256 (contrainte wgpu de copy_texture_to_buffer).
    readback_bpr: u32,
    /// Ring de buffers de staging (cf. `ReadbackRing`). `RefCell` : les methodes
    /// publiques du compositeur sont `&self`, comme tout le reste de l'etat.
    readback: RefCell<ReadbackRing>,

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

    /// Cache des sprites curseur (PNG RGBA -> texture wgpu), par chemin. Meme
    /// role que `img_cache` cote macOS : un sprite chargé une fois par session.
    img_cache: RefCell<std::collections::HashMap<String, (wgpu::Texture, u32, u32)>>,
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

        // --- Chaine de blur Kawase du fond (`blur.wgsl`) ---
        let blur_module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("blur.wgsl"),
            source: wgpu::ShaderSource::Wgsl(BLUR_WGSL.into()),
        });
        // Layout blur : 0 = uniform, 1 = texture, 2 = sampler (blur.wgsl).
        let blur_bgl = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("blur"),
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
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let blur_pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("blur"),
            bind_group_layouts: &[&blur_bgl],
            push_constant_ranges: &[],
        });
        let mk_blur = |entry: &str| {
            gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry),
                layout: Some(&blur_pl),
                vertex: wgpu::VertexState {
                    module: &blur_module,
                    entry_point: Some("vs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &blur_module,
                    entry_point: Some(entry),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        let blur_down = mk_blur("fs_kawase_down");
        let blur_up = mk_blur("fs_kawase_up");
        let mk_pyr = |dw: u32, dh: u32, label: &str| {
            gpu.device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some(label),
                    size: wgpu::Extent3d {
                        width: dw.max(1),
                        height: dh.max(1),
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                })
                .create_view(&wgpu::TextureViewDescriptor::default())
        };
        let blur_half = mk_pyr(w / 2, h / 2, "blur-half");
        let blur_qtr = mk_pyr(w / 4, h / 4, "blur-qtr");
        let blur_oct = mk_pyr(w / 8, h / 8, "blur-oct");

        let (rt, rt_view, readback_bpr) = Self::make_targets(&gpu, w, h);
        // Profondeur 1 par defaut = chemin synchrone historique, a l'octet et a
        // la latence pres. C'est l'export qui demande explicitement 2 (cf.
        // `set_readback_depth`) ; tout autre appelant garde l'ancien contrat.
        let readback = RefCell::new(ReadbackRing {
            depth: 1,
            free: vec![Self::make_staging(&gpu, readback_bpr, h)],
            pending: std::collections::VecDeque::new(),
        });

        Ok(Compositor {
            gpu,
            render_w: w,
            render_h: h,
            pipeline,
            bind_group_layout,
            sampler,
            blur_bgl,
            blur_down,
            blur_up,
            blur_half,
            blur_qtr,
            blur_oct,
            rt,
            rt_view,
            readback_bpr,
            readback,
            live_params: RefCell::new(LiveParams::default()),
            scene: RefCell::new(None),
            cursor: RefCell::new(None),
            cursor_time: RefCell::new(None),
            timeline_time: RefCell::new(None),
            text_raster: crate::text::TextRasterizer::new().ok(),
            img_cache: RefCell::new(std::collections::HashMap::new()),
        })
    }

    /// RT RGBA8 + `bytes_per_row` de la relecture (padde a 256).
    fn make_targets(gpu: &Gpu, w: u32, h: u32) -> (wgpu::Texture, wgpu::TextureView, u32) {
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
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let rt_view = rt.create_view(&wgpu::TextureViewDescriptor::default());
        let bpr = (w * 4).div_ceil(256) * 256;
        (rt, rt_view, bpr)
    }

    /// Un buffer de staging de la ring. La taille depend de `bpr` (donc de la
    /// largeur de rendu) et de la hauteur : changer la geometrie de rendu impose
    /// de les reallouer -- ce que fait `new_sized`, puisque la preview
    /// RECONSTRUIT le compositeur au resize (`live.rs`) au lieu de le
    /// redimensionner a chaud. Aucune copie ne peut donc etre en vol au moment
    /// ou la taille change : l'ancien compositeur (et sa ring) est detruit
    /// entier, wgpu gardant ses buffers vivants jusqu'a la fin des soumissions
    /// qui les referencent.
    fn make_staging(gpu: &Gpu, bpr: u32, h: u32) -> wgpu::Buffer {
        gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: u64::from(bpr) * u64::from(h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        })
    }

    /// Une passe Kawase : lit `src`, ecrit `dst` (fullscreen triangle, 3
    /// vertices). `src_px` = dimensions de la source (pour le pas de texel).
    fn blur_pass(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        pipeline: &wgpu::RenderPipeline,
        src: &wgpu::TextureView,
        dst: &wgpu::TextureView,
        src_px: [f32; 2],
    ) {
        let cb = LayerCB {
            quad_px: src_px,
            mode: -1.0,
            color: [1.0, 1.0, 1.0, 1.0],
            fx: [2.0, 0.0, 0.0, 0.0], // texel offset Kawase
            ..Default::default()
        };
        let uniform = self.gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("blur-uniform"),
            contents: layer_bytes(&cb),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind = self.gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("blur"),
            layout: &self.blur_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(src),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("blur-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: dst,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        rpass.set_pipeline(pipeline);
        rpass.set_bind_group(0, &bind, &[]);
        rpass.draw(0..3, 0..1);
    }

    /// Floute le RT (le fond deja dessine) : dual-Kawase 3 down (RT -> 1/2 ->
    /// 1/4 -> 1/8) + 3 up (1/8 -> 1/4 -> 1/2 -> RT). ~gaussien a cout constant.
    fn blur_bg(&self, encoder: &mut wgpu::CommandEncoder) {
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let (hw, hh) = (rw * 0.5, rh * 0.5);
        let (qw, qh) = (rw * 0.25, rh * 0.25);
        let (ow, oh) = (rw * 0.125, rh * 0.125);
        self.blur_pass(encoder, &self.blur_down, &self.rt_view, &self.blur_half, [rw, rh]);
        self.blur_pass(encoder, &self.blur_down, &self.blur_half, &self.blur_qtr, [hw, hh]);
        self.blur_pass(encoder, &self.blur_down, &self.blur_qtr, &self.blur_oct, [qw, qh]);
        self.blur_pass(encoder, &self.blur_up, &self.blur_oct, &self.blur_qtr, [ow, oh]);
        self.blur_pass(encoder, &self.blur_up, &self.blur_qtr, &self.blur_half, [qw, qh]);
        self.blur_pass(encoder, &self.blur_up, &self.blur_half, &self.rt_view, [hw, hh]);
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

    /// Charge un PNG/JPEG (chemin fichier ou data URI) en texture RGBA8. Port
    /// wgpu du `load_image_texture` macOS, memes chemins (`decode_data_uri`
    /// partage, crate `image`). Sert aux sprites de curseur (mode 7).
    fn load_image_texture(&self, path: &str) -> Result<(wgpu::Texture, u32, u32)> {
        let img = if let Some(bytes) = crate::frame_geometry::decode_data_uri(path) {
            image::load_from_memory(&bytes)
                .map_err(|e| anyhow::anyhow!("data URI image ({} octets) : {e}", bytes.len()))?
                .to_rgba8()
        } else {
            image::open(path)
                .map_err(|e| anyhow::anyhow!("sprite {path} : {e}"))?
                .to_rgba8()
        };
        let (w, h) = (img.width(), img.height());
        let pixels = img.into_raw();
        let tex = self.gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("sprite"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.gpu.context.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w * 4),
                rows_per_image: Some(h),
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        Ok((tex, w, h))
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

        // Fond : Color -> clear a la couleur ; Gradient -> mode 5 ; Image ->
        // mode 6 wallpaper cover-fit (via load_image_texture). Le blur (si
        // cfg.bg_blur) floute ensuite ce fond, avant l'ecran.
        enum BgLayer {
            Gradient(LayerCB),
            Image(String),
        }
        let (bg_clear, bg_layer) = match scene_ref.as_ref().map(|s| s.background.clone()) {
            Some(SceneBackground::Color { color }) => {
                (parse_hex(&color).unwrap_or(lp.bg_color), None)
            }
            Some(SceneBackground::Gradient { angle_deg, stops }) => {
                let c0 = stops.first().and_then(|s| parse_hex(s)).unwrap_or(lp.bg_color);
                let c1 = stops.last().and_then(|s| parse_hex(s)).unwrap_or(c0);
                let a = angle_deg.to_radians();
                let cb = LayerCB {
                    dst: [0.0, 0.0, 1.0, 1.0],
                    src: [c1[0], c1[1], c1[2], c1[3]],
                    quad_px: [rw, rh],
                    mode: 5.0,
                    color: c0,
                    fx: [a.sin(), -a.cos(), 0.0, 0.0],
                    ..Default::default()
                };
                ([0.0, 0.0, 0.0, 1.0], Some(BgLayer::Gradient(cb)))
            }
            Some(SceneBackground::Image { path }) => {
                ([0.0, 0.0, 0.0, 1.0], Some(BgLayer::Image(path)))
            }
            None => (lp.bg_color, None),
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

        // Fond (gradient mode 5 OU image mode 6), dessine dans la passe de fond.
        // `_tex`/`_view` gardent l'image en vie pendant le pass.
        struct BgDraw {
            _buf: wgpu::Buffer,
            _tex: Option<wgpu::Texture>,
            _view: Option<wgpu::TextureView>,
            bind: wgpu::BindGroup,
        }
        let bg_draw = bg_layer.and_then(|bl| match bl {
            BgLayer::Gradient(cb) => {
                let (buf, bind) = self.make_bind(&cb, None, &dummy);
                Some(BgDraw { _buf: buf, _tex: None, _view: None, bind })
            }
            BgLayer::Image(path) => {
                // Charge (ou recupere du cache) le wallpaper. Emprunt isole AVANT
                // le borrow_mut (piege du double emprunt 1re frame, cf. macOS).
                let cached = self.img_cache.borrow().get(path.as_str()).cloned();
                let (tex, iw, ih) = match cached {
                    Some(v) => v,
                    None => match self.load_image_texture(&path) {
                        Ok(v) => {
                            self.img_cache.borrow_mut().insert(path.clone(), v.clone());
                            v
                        }
                        Err(e) => {
                            eprintln!("[fond image] \"{path}\" : {e:#}");
                            return None;
                        }
                    },
                };
                // Cover-fit : l'image remplit tout le cadre, on rogne l'axe long.
                let ai = iw as f32 / ih.max(1) as f32;
                let ao = rw / rh;
                let src = if ai > ao {
                    let vis = ao / ai;
                    [(1.0 - vis) * 0.5, 0.0, 1.0 - (1.0 - vis) * 0.5, 1.0]
                } else {
                    let vis = ai / ao;
                    [0.0, (1.0 - vis) * 0.5, 1.0, 1.0 - (1.0 - vis) * 0.5]
                };
                let cb = LayerCB {
                    dst: [0.0, 0.0, 1.0, 1.0],
                    src,
                    mode: 6.0,
                    ..Default::default()
                };
                let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
                let (buf, bind) = self.make_bind(&cb, Some((&view, &view)), &dummy);
                Some(BgDraw { _buf: buf, _tex: Some(tex), _view: Some(view), bind })
            }
        });

        // Webcam PiP (mode 0) -- placee par plan_frame (`g.w_dst`, coins
        // `g.w_radius`), gardee par `g.shape_fade > 0` (webcam visible).
        // cover-crop UV + miroir + ombre + forme cercle = incremental (src plein
        // cadre ici). `webcam_planes` garde les vues en vie pendant le pass.
        let webcam_planes = if g.shape_fade > 0.0 && !webcam.is_null() {
            self.nv12_srvs(webcam).ok()
        } else {
            None
        };
        let webcam_draw = webcam_planes.as_ref().map(|(wy, wuv)| {
            let cb = LayerCB {
                dst: g.w_dst,
                src: [0.0, 0.0, 1.0, 1.0],
                quad_px: g.w_px,
                radius_px: g.w_radius,
                mode: 0.0,
                color: [0.0, 0.0, 0.0, 1.0],
                ..Default::default()
            };
            self.make_bind(&cb, Some((wy, wuv)), &dummy)
        });

        // Annotations TEXTE (mode 11) -- placees relativement au rect ecran
        // `g.s_dst` (les coords x/y/w/h de l'annotation sont des fractions de ce
        // rect, cf. `scene.rs`). Mirroir de la branche "text" de
        // `compositor_macos`, tint cote shader (atlas R8) au lieu de couleur
        // bakee. (image/figure/blur + animation `text_anim` : incremental.)
        struct AnnDraw {
            _buf: wgpu::Buffer,
            /// Garde l'atlas en vie jusqu'au submit. `None` pour la plaque de
            /// fond, qui est un aplat mode 1 et n'echantillonne aucune texture.
            _glyphs: Option<crate::text::RasterizedGlyphs>,
            bind: wgpu::BindGroup,
        }
        let mut ann_draws: Vec<AnnDraw> = Vec::new();
        if let (Some(scene), Some(raster)) = (scene_ref.as_ref(), self.text_raster.as_ref()) {
            for a in &scene.annotations {
                if a.kind != "text" {
                    continue;
                }
                // FENETRE TEMPORELLE. Sans ce test, TOUTES les annotations du
                // projet sont peintes sur TOUTES les frames : cinq sous-titres
                // s'empilent les uns sur les autres du debut a la fin de
                // l'export. C'est le defaut qui se lit comme « le texte
                // s'affiche bizarrement » avant meme de regarder les glyphes.
                // Mirroir de `visible()` dans compositor_macos.rs et du test
                // equivalent dans compositor_windows.rs.
                if !(g.source_t >= a.start_sec as f32 && g.source_t < a.end_sec as f32) {
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
                // Une boite degeneree ferait un atlas 0x0 et un draw invisible ;
                // macOS l'ecarte de la meme facon.
                if quad_px[0] <= 0.0 || quad_px[1] <= 0.0 {
                    continue;
                }
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

                // PLAQUE DE FOND, dessinee AVANT les glyphes.
                //
                // macOS et Windows la peignent dans la texture de texte
                // elle-meme ; ici c'est impossible : l'atlas est en R8, il ne
                // porte qu'une couverture alpha et aucune couleur. Plutot que
                // de convertir tout l'atlas en RGBA pour un aplat, on emet un
                // quad mode 1 (couleur pleine + SDF de rect arrondi, cf.
                // layer.wgsl) sous le quad de texte. Meme rect, meme rayon que
                // le rendu web (`annotationRenderer.ts`).
                //
                // Sans ca le fond n'existait tout simplement pas : `spec.background`
                // arrivait jusqu'au rasteriseur et mourait dans `cache_key()`.
                let background = parse_hex(&text.background_color).unwrap_or([0.0, 0.0, 0.0, 0.0]);
                if background[3] > 0.0 {
                    let plate = LayerCB {
                        dst,
                        src: [0.0, 0.0, 1.0, 1.0],
                        quad_px,
                        mode: 1.0,
                        color: background,
                        radius_px: 4.0 * (rh / 1080.0).max(0.5),
                        ..Default::default()
                    };
                    let (pbuf, pbind) = self.make_bind(&plate, None, &dummy);
                    ann_draws.push(AnnDraw {
                        _buf: pbuf,
                        _glyphs: None,
                        bind: pbind,
                    });
                }

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
                    _glyphs: Some(glyphs),
                    bind,
                });
            }
        }

        // Curseur thematise (mode 7, sprite RGBA). Placement UPRIGHT uniquement :
        // le tilt (mode 13, sous zoom incline) et le motion blur (taps>1) sont
        // des increments a venir. `_tex`/`_view`/`_buf` gardent le sprite en vie
        // pendant le pass. Miroir de la branche curseur de `compositor_macos`.
        struct CursorDraw {
            _buf: wgpu::Buffer,
            _tex: wgpu::Texture,
            _view: wgpu::TextureView,
            bind: wgpu::BindGroup,
        }
        let cursor_draw: Option<CursorDraw> = (|| {
            let track = cursor_ref.as_ref()?;
            let plan = plan_cursor(
                &g,
                &CursorPlanInput {
                    render_px: [rw, rh],
                    u_max,
                    v_max,
                    cfg,
                    live: lp,
                    scene: scene_ref.as_ref(),
                    track,
                    t: self
                        .cursor_time
                        .borrow()
                        .unwrap_or(frame / crate::frame_geometry::FPS),
                },
            )?;
            let CursorPlacement::Upright { center } = plan.placement else {
                // ponytail: tilt (mode 13) a porter quand un zoom incline sera teste.
                return None;
            };
            let sprites = scene_ref
                .as_ref()
                .map(|s| s.cursor.cursor_sprites.clone())
                .unwrap_or_default();
            let sprite = plan
                .cursor_type
                .as_deref()
                .and_then(|t| sprites.get(t))
                .or_else(|| sprites.get("arrow"))?;
            // Charge (ou recupere du cache) le sprite. Emprunt isole AVANT le
            // borrow_mut, comme cote macOS (piege du double emprunt 1re frame).
            let cached = self.img_cache.borrow().get(sprite.path.as_str()).cloned();
            let (tex, iw, ih) = match cached {
                Some(v) => v,
                None => match self.load_image_texture(&sprite.path) {
                    Ok(v) => {
                        self.img_cache.borrow_mut().insert(sprite.path.clone(), v.clone());
                        v
                    }
                    Err(e) => {
                        eprintln!("[curseur] sprite \"{}\" : {e:#}", sprite.path);
                        return None;
                    }
                },
            };
            // Ratio preserve : le sprite tient dans un carre de `size_px` de cote.
            let ar = iw as f32 / ih.max(1) as f32;
            let (pw, ph) = if ar >= 1.0 {
                (plan.size_px, plan.size_px / ar)
            } else {
                (plan.size_px * ar, plan.size_px)
            };
            let hotspot = [sprite.hotspot_x, sprite.hotspot_y];
            let cb = LayerCB {
                dst: cursor_sprite_dst(center, pw / rw, ph / rh, hotspot),
                src: [0.0, 0.0, 1.0, 1.0],
                mode: 7.0,
                color: [1.0, 1.0, 1.0, 1.0],
                fx: plan.clip,
                ..Default::default()
            };
            let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
            // Sprite RGBA au binding 1 (texY) que le mode 7 echantillonne.
            let (buf, bind) = self.make_bind(&cb, Some((&view, &view)), &dummy);
            Some(CursorDraw { _buf: buf, _tex: tex, _view: view, bind })
        })();

        let mut encoder = self.gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("compose"),
        });
        // Passe 1 : fond (clear a `bg_clear` + gradient mode 5 eventuel).
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("bg-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.rt_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: bg_clear[0] as f64,
                            g: bg_clear[1] as f64,
                            b: bg_clear[2] as f64,
                            a: bg_clear[3] as f64,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            if let Some(bg) = &bg_draw {
                rpass.set_pipeline(&self.pipeline);
                rpass.set_bind_group(0, &bg.bind, &[]);
                rpass.draw(0..4, 0..1);
            }
        }
        // Blur du fond (avant l'ecran), si active par la scene/l'inspector.
        if cfg.bg_blur {
            self.blur_bg(&mut encoder);
        }
        // Passe 2 : avant-plan (ecran + webcam + annotations), compose par-dessus
        // le fond (eventuellement floute) avec `LoadOp::Load`.
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("fg-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.rt_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
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
            if let Some((_buf, bind)) = &webcam_draw {
                rpass.set_bind_group(0, bind, &[]);
                rpass.draw(0..4, 0..1);
            }
            for a in &ann_draws {
                rpass.set_bind_group(0, &a.bind, &[]);
                rpass.draw(0..4, 0..1);
            }
            // Curseur en dernier : au-dessus de l'ecran et des annotations.
            if let Some(c) = &cursor_draw {
                rpass.set_bind_group(0, &c.bind, &[]);
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

    /// Regle la profondeur de la ring de staging. A appeler AVANT la premiere
    /// relecture (elle vide la ring, donc toute frame encore en vol serait
    /// perdue -- d'ou le drain explicite plutot qu'un silence).
    ///
    /// POLITIQUE PAR CHEMIN, et c'est volontaire :
    ///
    /// - **Export** (`pipeline_linux::run_composited_multi`) : profondeur 2. Il
    ///   ne veut que du DEBIT, la latence d'une frame ne se voit nulle part
    ///   puisque la sortie est un fichier. Il draine la ring a la fin, donc
    ///   aucune frame ne manque au montage.
    /// - **Preview live** (`live.rs`) : profondeur 1, inchangee. Une frame de
    ///   retard y est perceptible -- le canvas afficherait l'avant-derniere
    ///   frame composee, et surtout la boucle ne relit QUE quand elle a avance
    ///   (`stepped`) : au repos (fin d'un scrub, pause) la derniere frame
    ///   resterait coincee dans la ring et le canvas figerait sur la
    ///   precedente jusqu'au prochain evenement. Le pipeline demanderait donc
    ///   un drain sur inactivite pour n'etre que neutre visuellement, pour un
    ///   gain qui n'est pas le goulot mesure ici. On ne l'impose pas.
    ///
    /// A profondeur 1 le chemin est exactement l'ancien : soumettre, attendre,
    /// mapper, depadder.
    pub fn set_readback_depth(&self, depth: usize) -> Result<()> {
        let depth = depth.max(1);
        // Draine d'abord : les frames en vol appartiennent a l'appelant
        // precedent, les jeter en silence serait une perte de donnees muette.
        while unsafe { self.readback_take()? }.is_some() {}
        let mut ring = self.readback.borrow_mut();
        ring.depth = depth;
        while ring.free.len() > depth {
            ring.free.pop();
        }
        while ring.free.len() < depth {
            let buf = Self::make_staging(&self.gpu, self.readback_bpr, self.render_h);
            ring.free.push(buf);
        }
        Ok(())
    }

    /// Soumet la copie RT -> staging de la frame COURANTE sans l'attendre, puis
    /// rend la frame la plus ancienne encore en vol des que la ring est pleine.
    ///
    /// PREMIERES FRAMES. Tant que moins de `depth` copies sont en vol, il n'y a
    /// rien a rendre et la reponse est `Ok(None)` : c'est l'amorcage du
    /// pipeline, et il coute exactement `depth - 1` frames de decalage (0 a
    /// profondeur 1). L'appelant ne doit donc PAS supposer une frame par appel,
    /// mais drainer a la fin (`readback_take`) -- sinon les `depth - 1`
    /// dernieres frames composees ne sortiraient jamais.
    pub unsafe fn readback_submit(&self) -> Result<Option<(u32, u32, Vec<u8>)>> {
        let (w, h) = (self.render_w, self.render_h);
        let bpr = self.readback_bpr;
        // Invariant : cette fonction recolte toujours des que `pending` atteint
        // `depth`, donc un buffer est libre a chaque entree. Un echec ici
        // signalerait une ring desynchronisee -- on le dit plutot que d'allouer
        // 8 Mo de plus en silence a chaque frame.
        let buf = self
            .readback
            .borrow_mut()
            .free
            .pop()
            .ok_or_else(|| anyhow::anyhow!("staging ring saturee (aucun buffer libre)"))?;

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
                buffer: &buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bpr),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        // `submit` rend l'index de soumission : c'est LUI qui permet plus tard
        // de n'attendre que cette copie-ci, au lieu de `Maintain::Wait` qui
        // draine toute la file (donc la composition qui suit).
        let idx = self.gpu.context.submit(std::iter::once(encoder.finish()));
        // `map_async` juste apres la soumission : wgpu differe le mapping
        // jusqu'a la fin de la soumission qui ecrit le buffer, le callback
        // n'est tire que par un `poll`.
        let (tx, rx) = std::sync::mpsc::channel();
        buf.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        {
            let mut ring = self.readback.borrow_mut();
            ring.pending.push_back(PendingCopy { buf, idx, rx, w, h, bpr });
            if ring.pending.len() < ring.depth {
                return Ok(None); // amorcage
            }
        }
        self.readback_take()
    }

    /// Recolte la frame la plus ancienne en vol (`None` si la ring est vide).
    /// C'est le drain de fin de session : l'appeler en boucle apres la derniere
    /// `readback_submit` rend les `depth - 1` frames encore en vol.
    pub unsafe fn readback_take(&self) -> Result<Option<(u32, u32, Vec<u8>)>> {
        let Some(p) = self.readback.borrow_mut().pending.pop_front() else {
            return Ok(None);
        };
        // N'attend QUE la soumission de cette copie. A profondeur >= 2 elle est
        // terminee depuis longtemps (l'encodage de la frame precedente lui a
        // laisse ~19 ms de CPU) et l'appel rend la main immediatement.
        self.gpu.device.poll(wgpu::Maintain::WaitForSubmissionIndex(p.idx));
        p.rx
            .recv()
            .map_err(|_| anyhow::anyhow!("map_async channel"))?
            .map_err(|e| anyhow::anyhow!("map_async: {e:?}"))?;
        let slice = p.buf.slice(..);
        let mapped = slice.get_mapped_range();

        let (w, h) = (p.w, p.h);
        let row = (w * 4) as usize;
        let bpr = p.bpr as usize;
        let total = row * h as usize;

        // `Vec::with_capacity` + `extend_from_slice`, PAS `vec![0u8; total]` : ce dernier
        // memset 8 Mo (en 1080p) qu'on écrase intégralement ligne suivante. Mesuré : la
        // relecture pèse 82 % de la frame de preview, et ce zero-fill en est une part
        // gratuite à rendre.
        let mut out = Vec::with_capacity(total);
        if bpr == row {
            // Cas courant, et il n'a rien d'exotique : wgpu aligne `bytes_per_row` sur 256
            // et une largeur RGBA multiple de 64 px l'est déjà (1280 et 1920 le sont).
            // Il n'y a alors AUCUN padding à retirer, et la boucle ligne à ligne recopiait
            // un tampon identique à l'octet près en `h` memcpy au lieu d'un seul.
            out.extend_from_slice(&mapped[..total]);
        } else {
            for y in 0..h as usize {
                out.extend_from_slice(&mapped[y * bpr..y * bpr + row]);
            }
        }
        drop(mapped);
        p.buf.unmap();
        // Buffer demappe -> reutilisable au prochain `readback_submit`.
        self.readback.borrow_mut().free.push(p.buf);
        Ok(Some((w, h, out)))
    }

    /// Lit le RT en RGBA8 tightly-packed `(render_w * render_h * 4)`. Depadde le
    /// `bytes_per_row` aligne a 256 exige par wgpu.
    ///
    /// Contrat SYNCHRONE : rend la frame que le RT contient MAINTENANT. A la
    /// profondeur par defaut (1) c'est litteralement soumettre-attendre-mapper,
    /// donc le chemin d'avant la ring. A profondeur > 1 elle vide le pipeline
    /// pour honorer ce contrat -- a n'utiliser que la ou la frame courante est
    /// exigee (preview, GIF, tests), pas dans une boucle d'export.
    pub unsafe fn readback_direct(&self) -> Result<(u32, u32, Vec<u8>)> {
        let mut last = self.readback_submit()?;
        while let Some(next) = self.readback_take()? {
            last = Some(next);
        }
        last.ok_or_else(|| anyhow::anyhow!("readback_direct: aucune frame recoltee"))
    }
}
