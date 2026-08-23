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
//! annotations texte mode 11, blur de fond, motion blur) sont dessines
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
    /// Meme shader et meme layout que `pipeline`, blend ADDITIF pondere par la
    /// constante de blend. Sert a sommer les copies de la trainee du curseur
    /// dans `accum` ; cf. `blend_add` cote Windows.
    pipeline_add: wgpu::RenderPipeline,
    /// Copie plein ecran d'`accum` vers le RT en « over » premultiplie
    /// (`blur.wgsl` : `vs_fullscreen` + `fs_copy`). Utilise le layout du blur.
    pipeline_copy: wgpu::RenderPipeline,
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
    /// Cible ISOLEE d'accumulation, meme taille et meme format que le RT.
    /// `_accum` garde la texture en vie ; seule la vue est utilisee.
    _accum: wgpu::Texture,
    accum_view: wgpu::TextureView,
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

    /// Copie mipmappee de la frame composee, lue par les annotations « flou »
    /// (mode 10). `ann_copy` garde la texture en vie, `ann_copy_view` porte tous
    /// les niveaux (echantillonnage), `ann_copy_mips` un niveau chacune (cibles
    /// de la generation). Cf. `make_ann_copy`.
    ann_copy: wgpu::Texture,
    ann_copy_view: wgpu::TextureView,
    ann_copy_mips: Vec<wgpu::TextureView>,

    /// Images d'annotation, indexees par ID d'annotation -- PAS par chemin comme
    /// `img_cache`. Une annotation image porte souvent une data-URI de plusieurs
    /// mega-octets ; s'en servir comme cle de HashMap la ferait hacher a chaque
    /// frame. La longueur de la source sert de temoin de changement, comme cote
    /// macOS.
    ann_img_cache: RefCell<std::collections::HashMap<String, (wgpu::Texture, u32, u32, usize)>>,
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
            // Trilineaire pour le LOD fractionnaire du mode 10 : `log2(rayon)`
            // tombe entre deux niveaux, et en `Nearest` le flou avancerait par
            // paliers visibles quand le rayon varie. Sans effet sur tout le
            // reste -- aucune autre texture liee ici n'a plus d'un niveau.
            mipmap_filter: wgpu::FilterMode::Linear,
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
        // Deux pipelines pour le MEME shader de calque : seul le blend change.
        let mk_layer = |label: &str, blend: wgpu::BlendState| {
            gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
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
                        blend: Some(blend),
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
            })
        };
        let pipeline = mk_layer("layer", wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING);
        // SOMME pondere : `src * constante + dst`. La constante (posee par pass
        // via `set_blend_constant`) vaut 1/taps, donc N copies d'un curseur
        // parfaitement immobile redonnent exactement ce curseur. Transcription
        // du `blend_add` D3D11 (BLEND_FACTOR / ONE / OP_ADD sur couleur ET
        // alpha) ; l'alpha doit suivre la couleur, sinon la somme n'est plus
        // premultipliee et la composition finale delave la trainee.
        let add = wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::Constant,
            dst_factor: wgpu::BlendFactor::One,
            operation: wgpu::BlendOperation::Add,
        };
        let pipeline_add = mk_layer(
            "layer-add",
            wgpu::BlendState { color: add, alpha: add },
        );

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
        // Composition d'`accum` sur le RT : meme layout que le blur (uniform +
        // 1 texture + sampler) et blend « over » premultiplie. Son VS est
        // `vs_fullscreen` et non le `vs_main` du Kawase -- une passe UNIQUE ne
        // pardonne pas une erreur d'orientation, cf. le commentaire la-bas.
        let pipeline_copy = gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("accum-copy"),
            layout: Some(&blur_pl),
            vertex: wgpu::VertexState {
                module: &blur_module,
                entry_point: Some("vs_fullscreen"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &blur_module,
                entry_point: Some("fs_copy"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
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
        });
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

        let (rt, rt_view, accum, accum_view, readback_bpr) = Self::make_targets(&gpu, w, h);
        let (ann_copy, ann_copy_view, ann_copy_mips) = Self::make_ann_copy(&gpu, w, h);
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
            pipeline_add,
            pipeline_copy,
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
            _accum: accum,
            accum_view,
            readback_bpr,
            readback,
            live_params: RefCell::new(LiveParams::default()),
            scene: RefCell::new(None),
            cursor: RefCell::new(None),
            cursor_time: RefCell::new(None),
            timeline_time: RefCell::new(None),
            text_raster: crate::text::TextRasterizer::new().ok(),
            img_cache: RefCell::new(std::collections::HashMap::new()),
            ann_copy,
            ann_copy_view,
            ann_copy_mips,
            ann_img_cache: RefCell::new(std::collections::HashMap::new()),
        })
    }

    /// RT RGBA8, cible d'accumulation de meme geometrie, et `bytes_per_row` de
    /// la relecture (padde a 256).
    ///
    /// `accum` est alloue ICI et pas ailleurs pour qu'il soit impossible de le
    /// laisser a l'ancienne taille apres un changement de resolution : c'est le
    /// meme appel qui produit les deux, et un accum plus petit que le RT ferait
    /// une passe de composition tronquee.
    fn make_targets(
        gpu: &Gpu,
        w: u32,
        h: u32,
    ) -> (wgpu::Texture, wgpu::TextureView, wgpu::Texture, wgpu::TextureView, u32) {
        let mk = |label: &str, extra: wgpu::TextureUsages| {
            gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
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
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | extra,
                view_formats: &[],
            })
        };
        let rt = mk("rt", wgpu::TextureUsages::COPY_SRC);
        let accum = mk("accum", wgpu::TextureUsages::empty());
        let rt_view = rt.create_view(&wgpu::TextureViewDescriptor::default());
        let accum_view = accum.create_view(&wgpu::TextureViewDescriptor::default());
        let bpr = (w * 4).div_ceil(256) * 256;
        (rt, rt_view, accum, accum_view, bpr)
    }

    /// Copie du RT avec chaine de mips COMPLETE, source des annotations « flou ».
    ///
    /// Le mode 10 lit un niveau de mip choisi par `log2(rayon)` : c'est la
    /// pyramide qui FAIT le flou, pas un noyau de taps (cf. le commentaire du
    /// shader). Il lui faut donc tous les niveaux jusqu'a 1x1, sinon un grand
    /// rayon demande un LOD qui n'existe pas et le sampler retombe sur le dernier
    /// disponible -- le flou plafonne en silence.
    ///
    /// Retourne aussi une vue PAR NIVEAU : `generate_ann_mips` rend le niveau i
    /// depuis le niveau i-1, et une vue de render target ne peut porter qu'un
    /// seul niveau.
    fn make_ann_copy(
        gpu: &Gpu,
        w: u32,
        h: u32,
    ) -> (wgpu::Texture, wgpu::TextureView, Vec<wgpu::TextureView>) {
        // floor(log2(max)) + 1 : le dernier niveau mesure 1x1.
        let levels = 32 - w.max(h).max(1).leading_zeros();
        let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("ann-copy"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: levels,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        let mips = (0..levels)
            .map(|level| {
                tex.create_view(&wgpu::TextureViewDescriptor {
                    label: Some("ann-copy-mip"),
                    base_mip_level: level,
                    mip_level_count: Some(1),
                    ..Default::default()
                })
            })
            .collect();
        (tex, view, mips)
    }

    /// Fige la frame composee dans `ann_copy` et remplit sa pyramide.
    ///
    /// UNE seule fois par frame, AVANT toute annotation : les flous doivent voir
    /// l'image composee SANS les flous eux-memes, sinon deux zones qui se
    /// recouvrent s'echantillonnent l'une l'autre selon l'ordre de dessin. Meme
    /// contrat que le `blit` + `generate_mipmaps` de `compositor_macos`.
    ///
    /// wgpu n'a pas de `generate_mipmaps` : chaque niveau est une passe de rendu
    /// plein ecran qui echantillonne le precedent. Le filtre lineaire sur une
    /// source exactement deux fois plus grande EST la moyenne 2x2, donc cette
    /// boucle produit la meme pyramide que le blit Metal.
    fn generate_ann_mips(&self, encoder: &mut wgpu::CommandEncoder) {
        encoder.copy_texture_to_texture(
            self.rt.as_image_copy(),
            self.ann_copy.as_image_copy(),
            wgpu::Extent3d {
                width: self.render_w,
                height: self.render_h,
                depth_or_array_layers: 1,
            },
        );
        // Les bind groups doivent survivre a leur passe : on les garde tous ici.
        let mut keep: Vec<(wgpu::Buffer, wgpu::BindGroup)> = Vec::new();
        for level in 1..self.ann_copy_mips.len() {
            let uniform = self.gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("ann-mip-uniform"),
                // `fs_copy` ne lit pas l'uniforme, mais le layout du blur l'exige.
                contents: layer_bytes(&LayerCB::default()),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let bind = self.gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("ann-mip"),
                layout: &self.blur_bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(
                            &self.ann_copy_mips[level - 1],
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                ],
            });
            keep.push((uniform, bind));
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("ann-mip-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.ann_copy_mips[level],
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // Clear plutot que Load : le niveau n'a jamais ete ecrit,
                        // et `pipeline_copy` blende « over ». Sur une cible vidée
                        // le « over » rend la source telle quelle -- l'ecrasement
                        // qu'on veut ici.
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            rpass.set_pipeline(&self.pipeline_copy);
            rpass.set_bind_group(0, &keep[keep.len() - 1].1, &[]);
            rpass.draw(0..3, 0..1);
        }
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

    /// Cf. `compositor_windows::set_has_webcam` — le seul champ de `LiveParams` qui dépend du
    /// clip courant, rebranché par `walk_composited_timeline` sans écraser le reste.
    pub fn set_has_webcam(&self, v: bool) {
        self.live_params.borrow_mut().has_webcam = v;
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
    /// `LayerCB` d'une ombre portee (mode 2), identique a `draw_shadow` cote
    /// macOS et au bloc equivalent cote Windows.
    ///
    /// Le quad est ELARGI de `spread` de chaque cote et decale de `offset_px` ;
    /// le shader y trace un SDF de rect arrondi dont l'alpha decroit sur la
    /// largeur du spread. C'est pour ca que `fx.x` porte le spread : le
    /// fragment en a besoin pour normaliser sa penombre.
    fn shadow_cb(
        &self,
        dst: [f32; 4],
        size_px: [f32; 2],
        radius: f32,
        spread: f32,
        offset_px: [f32; 2],
        opacity: f32,
    ) -> LayerCB {
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let (sx, sy) = (spread / rw, spread / rh);
        let (ox, oy) = (offset_px[0] / rw, offset_px[1] / rh);
        LayerCB {
            dst: [dst[0] - sx + ox, dst[1] - sy + oy, dst[2] + 2.0 * sx, dst[3] + 2.0 * sy],
            quad_px: [size_px[0] + 2.0 * spread, size_px[1] + 2.0 * spread],
            radius_px: radius,
            mode: 2.0,
            color: [0.0, 0.0, 0.0, opacity],
            fx: [spread, 0.0, 0.0, 0.0],
            mb: [0.0, 1.0, 1.0, 0.0],
            ..Default::default()
        }
    }

    /// `LayerCB` de l'ombre d'un ecran INCLINE (mode 12) : la penombre suit le
    /// quadrilatere projete, pas son rect englobant. Port de
    /// `compositor_macos::draw_quad_shadow`.
    fn quad_shadow_cb(
        &self,
        corners: &[(f32, f32); 4],
        center_px: [f32; 2],
        radius: f32,
        spread: f32,
        offset_px: [f32; 2],
        opacity: f32,
    ) -> LayerCB {
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let (min_x, max_x) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
        let (min_y, max_y) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
        // La boite doit contenir la penombre entiere, sinon elle se coupe net.
        let box_w = (max_x - min_x) + 2.0 * spread;
        let box_h = (max_y - min_y) + 2.0 * spread;
        let local = |(x, y): (f32, f32)| -> [f32; 2] { [x - min_x + spread, y - min_y + spread] };
        let [tl0, tl1] = local(corners[0]);
        let [tr0, tr1] = local(corners[1]);
        let [br0, br1] = local(corners[2]);
        let [bl0, bl1] = local(corners[3]);
        LayerCB {
            dst: [
                (center_px[0] + min_x - spread + offset_px[0]) / rw,
                (center_px[1] + min_y - spread + offset_px[1]) / rh,
                box_w / rw,
                box_h / rh,
            ],
            quad_px: [box_w, box_h],
            radius_px: radius,
            mode: 12.0,
            color: [0.0, 0.0, 0.0, opacity],
            fx: [tl0, tl1, tr0, tr1],
            src_prev: [br0, br1, bl0, bl1],
            // Le spread vit ici et NON dans `fx.x` : `fx` porte deja les coins.
            mb: [0.0, spread, 1.0, 0.0],
            ..Default::default()
        }
    }

    /// `LayerCB` de l'ecran incline (mode 8) : le quad projete est dessine dans sa
    /// BBOX et le fragment remonte au (s,t) du plan par warp bilineaire inverse.
    /// Port de `compositor_macos::draw_tilted_screen`. Pas de motion blur sur ce
    /// chemin -- le tilt est bref, la simplification ne se voit pas.
    fn tilted_screen_cb(
        &self,
        quad: &crate::regions::TiltedQuad,
        s_px: [f32; 2],
        center_px: [f32; 2],
        cut: [f32; 4],
        radius: f32,
    ) -> LayerCB {
        let (rw, rh) = (self.render_w as f32, self.render_h as f32);
        let corners = quad.corners;
        // Taille du plan dans son propre repere, AVANT projection : c'est la que vit
        // le rayon, pour qu'il reste constant le long du bord au lieu de s'etirer
        // avec la perspective.
        let plane_px = [s_px[0] * quad.scale, s_px[1] * quad.scale];
        let (min_x, max_x) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
        let (min_y, max_y) =
            corners.iter().fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
        let bbox_w = (max_x - min_x).max(1.0);
        let bbox_h = (max_y - min_y).max(1.0);
        // Coins en px LOCAUX a la bbox, pour matcher `i.local` du shader.
        let local = |(x, y): (f32, f32)| -> [f32; 2] { [x - min_x, y - min_y] };
        let [tl0, tl1] = local(corners[0]);
        let [tr0, tr1] = local(corners[1]);
        let [br0, br1] = local(corners[2]);
        let [bl0, bl1] = local(corners[3]);
        LayerCB {
            dst: [
                (center_px[0] + min_x) / rw,
                (center_px[1] + min_y) / rh,
                bbox_w / rw,
                bbox_h / rh,
            ],
            src: cut,
            quad_px: [bbox_w, bbox_h],
            radius_px: radius * quad.scale,
            mode: 8.0,
            fx: [tl0, tl1, tr0, tr1],
            src_prev: [br0, br1, bl0, bl1],
            dst_prev: [plane_px[0], plane_px[1], 0.0, 0.0],
            ..Default::default()
        }
    }

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
        // (`wtw`/`wth` sont les dims de la TEXTURE webcam, consommees par le
        // cover-crop du calque PiP plus bas.)

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

        // ROTATION 3D (presets iso/left/right d'une zoom region). La geometrie du
        // tilt est calculee UNE fois : l'ombre et l'ecran doivent porter exactement
        // le meme quadrilatere, sinon l'ombre se decolle des que l'un des deux
        // change. `regions` fait toute la trigo (partagee avec macOS/Windows) ; ici
        // on ne fait que l'empaqueter.
        let s_px = [g.s_dst[2] * rw, g.s_dst[3] * rh];
        let tilt = (!crate::regions::is_identity_rotation(g.zoom_rotation))
            .then(|| crate::regions::rotated_quad_corners_px(s_px[0], s_px[1], g.zoom_rotation));
        let quad_center_px = [
            (g.s_dst[0] + g.s_dst[2] * 0.5) * rw,
            (g.s_dst[1] + g.s_dst[3] * 0.5) * rh,
        ];

        // Calque ecran : mode 0 (rect droit, NV12 -> RGB) quand la rotation est
        // neutre, mode 8 (warp bilineaire inverse dans la bbox du quad projete)
        // sinon. Place par plan_frame (cover-fit + coins arrondis) ;
        // `src = g.cut` (crop utilisateur + zoom en UV texture) dans les deux cas.
        //
        // FLOU DE VELOCITE, ET POURQUOI SEULEMENT SUR LE MODE 0. `src_prev`/
        // `dst_prev` decrivent le MEME calque a la frame precedente ; le shader
        // remappe chaque pixel de sortie par ce couple pour retrouver l'UV qu'il
        // occupait alors, et floute le long du segment. `src_prev = g.cut` et non
        // un `cut` d'avant : la coupe est identique aux deux frames (`plan_frame`
        // ne fait varier que le rect de DESTINATION entre `s_dst` et
        // `s_dst_prev`), ce que Windows documente aussi. Le mouvement vient donc
        // entierement de `dst_prev`.
        //
        // Le mode 8 n'en recoit PAS, et ce n'est pas un oubli : ces deux champs y
        // portent deja les coins projetes du quad (BR/BL dans `src_prev`,
        // `plane_px` dans `dst_prev`). Les deux sens ne peuvent pas cohabiter dans
        // un meme draw. macOS et Windows sautent egalement le flou sur le chemin
        // incline, pour la meme raison.
        let screen_layer = match tilt.as_ref() {
            None => LayerCB {
                dst: g.s_dst,
                src: g.cut,
                quad_px: s_px,
                radius_px: g.s_radius,
                mode: 0.0,
                color: [1.0, 1.0, 1.0, 1.0],
                src_prev: g.cut,
                dst_prev: g.s_dst_prev,
                mb: [g.mb_taps, 1.0, 1.0, 0.0],
                ..Default::default()
            },
            Some(quad) => self.tilted_screen_cb(quad, s_px, quad_center_px, g.cut, g.s_radius),
        };
        // Bind group construit AVANT le pass (doit vivre pendant tout le pass) ;
        // `_screen_uniform` garde le buffer uniforme en vie (reference par le bind).
        let dummy = self.dummy_view();
        let (_screen_uniform, screen_bind) =
            self.make_bind(&screen_layer, Some((&sy, &suv)), &dummy);

        // OMBRE PORTEE de l'ecran, dessinee JUSTE AVANT le calque ecran. Le shader
        // la connait depuis le debut ; ce qui manquait etait uniquement le draw
        // cote Rust, si bien que le curseur « Ombre » de l'UI ne faisait rien sur
        // Linux.
        //
        // Les fractions de reglage viennent de `frame_geometry`, partagees avec
        // macOS/Windows : l'ombre a la meme taille relative sur les trois
        // plateformes quelle que soit la resolution de sortie.
        //
        // L'ombre suit la silhouette REELLEMENT affichee : rect arrondi (mode 2)
        // quand l'ecran est droit, quadrilatere projete (mode 12) quand il penche.
        let screen_shadow = cfg.shadow.then(|| {
            let spread = crate::frame_geometry::SCREEN_SHADOW_SPREAD_FRAC * g.frame_min_px;
            let offset = [0.0, crate::frame_geometry::SCREEN_SHADOW_OFFSET_FRAC * g.frame_min_px];
            let opacity = 0.45 * lp.shadow_scale;
            let cb = match tilt.as_ref() {
                None => self.shadow_cb(g.s_dst, s_px, g.s_radius, spread, offset, opacity),
                Some(quad) => self.quad_shadow_cb(
                    &quad.corners,
                    quad_center_px,
                    g.s_radius * quad.scale,
                    spread,
                    offset,
                    opacity,
                ),
            };
            self.make_bind(&cb, None, &dummy)
        });

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
        // `webcam_planes` garde les vues en vie pendant le pass.
        // `lp.has_webcam` is the gate Windows (`compositor_windows.rs`) and macOS
        // (`compositor_macos.rs`) both apply and this backend did not. It is false
        // when the clip has no camera — and in that case the "webcam" decoder holds
        // the SCREEN video, because `open_and_seek_clip` falls back to it rather
        // than leave the pair half-open. Without this check a recording with no
        // camera drew its own screen picture inside the PiP box.
        let webcam_planes = if lp.has_webcam && g.shape_fade > 0.0 && !webcam.is_null() {
            self.nv12_srvs(webcam).ok()
        } else {
            None
        };
        let webcam_draw = webcam_planes.as_ref().map(|(wy, wuv)| {
            // COVER-CROP. `src` etait cable a [0,0,1,1], donc la texture entiere
            // etait etiree sur la boite quelle que soit sa forme : le facteur de
            // deformation valait exactement `box_ar / cam_ar`. Invisible en PiP
            // rectangulaire (`compositeLayout.ts` y preserve deja le ratio),
            // spectaculaire des que le masque est un cercle ou un carre, ou la
            // boite est forcee carree et une camera 16:9 s'ecrase de 1,78x.
            //
            // `cover_crop_uv` est la primitive partagee que macOS et Windows
            // utilisent ; elle rend le rect inchange quand il a deja le bon
            // ratio, donc aucun placement correct ne bouge.
            let [cu0, cv0, cu1, cv1] = crate::frame_geometry::webcam_source_rect(
                [wcw, wch],
                [wtw as f32, wth as f32],
                scene_ref
                    .as_ref()
                    .and_then(|scene| scene.layout.webcam_crop),
                g.w_px[0] / g.w_px[1].max(0.0001),
            );
            // MIROIR : on inverse l'intervalle u. Le VS interpole `src`
            // lineairement et `fs_main` ne re-clampe pas `i.uv`, donc un
            // intervalle a l'envers suffit -- aucune retouche du WGSL. Apres le
            // cover-crop les deux bornes sont strictement a l'interieur de la
            // texture, donc le sampler ClampToEdge ne bave pas sur les bords.
            let (u0, u1) = if lp.webcam_mirror { (cu1, cu0) } else { (cu0, cu1) };
            // `src_prev` doit valoir EXACTEMENT le `src` de ce draw, miroir
            // compris : le shader s'en sert pour reconstruire l'UV de la frame
            // precedente, et un rect source qui ne correspond pas au calque
            // dessine ferait diverger la trainee vers une zone de la texture qui
            // n'a jamais ete affichee. Seul `dst_prev` porte le mouvement.
            let cb = LayerCB {
                dst: g.w_dst,
                src: [u0, cv0, u1, cv1],
                quad_px: g.w_px,
                radius_px: g.w_radius,
                mode: 0.0,
                color: [0.0, 0.0, 0.0, 1.0],
                src_prev: [u0, cv0, u1, cv1],
                dst_prev: g.w_dst_prev,
                mb: [g.mb_taps, 1.0, 1.0, 0.0],
                ..Default::default()
            };
            self.make_bind(&cb, Some((wy, wuv)), &dummy)
        });

        // OMBRE de la camera. Pas dans les presets « bloc » (dual-frame,
        // vertical-stack) : la camera y est collee a l'ecran comme une tuile,
        // et une ombre entre les deux dessinerait une couture. Meme condition
        // que macOS.
        let webcam_shadow = (cfg.shadow
            && g.shape_fade > 0.0
            && webcam_draw.is_some()
            && !matches!(
                g.scene_preset.as_deref(),
                Some("dual-frame") | Some("vertical-stack")
            ))
        .then(|| {
            let cb = self.shadow_cb(
                g.w_dst,
                g.w_px,
                g.w_radius,
                crate::frame_geometry::WEBCAM_SHADOW_SPREAD_FRAC * g.frame_min_px,
                [0.0, crate::frame_geometry::WEBCAM_SHADOW_OFFSET_FRAC * g.frame_min_px],
                crate::frame_geometry::WEBCAM_SHADOW_OPACITY * g.shape_fade,
            );
            self.make_bind(&cb, None, &dummy)
        });

        // ANNOTATIONS -- calque le plus haut, place relativement au rect ecran
        // (les coords x/y/w/h de l'annotation sont des fractions de ce rect, cf.
        // `scene.rs`). Le rect est `g.s_ann`, l'ecran SANS ZOOM, et surtout pas
        // `g.s_dst` : le contrat de `SceneAnnotation` dit « deliberately NOT
        // affected by the zoom crop », donc annotations et sous-titres tiennent
        // en place pendant que le contenu grossit dessous. `s_dst` a tenu ce role
        // gratuitement tant que le zoom vivait dans la coupe source ; depuis
        // l'issue #179 il vit dans la BOITE, et l'ancrer dessus fait zoomer les
        // sous-titres avec l'ecran. Windows et macOS ont ete corriges alors, ce
        // backend non -- d'ou le passage par `FrameGeometry::annotation_dst`, qui
        // ne laisse plus le choix. Le natif peignant AUSSI l'apercu, la derive se
        // voyait des l'edition, pas seulement a l'export.
        // Port de `compositor_macos::draw_annotations` : memes modes, memes
        // replis, meme ordre. Seul le texte diverge, tinte cote shader (atlas R8)
        // au lieu d'une couleur bakee dans la texture.
        struct AnnDraw {
            _buf: wgpu::Buffer,
            /// Gardent l'atlas / la texture image en vie jusqu'au submit. `None`
            /// pour les quads qui n'echantillonnent rien (plaque de fond, fleche).
            _glyphs: Option<crate::text::RasterizedGlyphs>,
            _tex: Option<wgpu::Texture>,
            bind: wgpu::BindGroup,
        }
        impl AnnDraw {
            fn plain(buf: wgpu::Buffer, bind: wgpu::BindGroup) -> AnnDraw {
                AnnDraw { _buf: buf, _glyphs: None, _tex: None, bind }
            }
        }
        // FENETRE TEMPORELLE. Sans ce test, TOUTES les annotations du projet sont
        // peintes sur TOUTES les frames : cinq sous-titres s'empilent les uns sur
        // les autres du debut a la fin de l'export. C'est le defaut qui se lit
        // comme « le texte s'affiche bizarrement » avant meme de regarder les
        // glyphes. Mirroir de `visible()` dans compositor_macos.rs.
        let visible = |a: &crate::scene::SceneAnnotation| {
            g.source_t >= a.start_sec as f32 && g.source_t < a.end_sec as f32
        };
        // Un flou lit la frame composee ; il faut donc la figer AVANT de dessiner
        // la moindre annotation. On ne le fait que si un flou est reellement
        // visible : la pyramide coute une passe par niveau.
        let needs_ann_copy = scene_ref
            .as_ref()
            .is_some_and(|s| s.annotations.iter().any(|a| a.kind == "blur" && visible(a)));
        let mut ann_draws: Vec<AnnDraw> = Vec::new();
        if let Some(scene) = scene_ref.as_ref() {
            // La liste arrive deja triee par zIndex cote app : l'ordre d'iteration
            // EST l'ordre de peinture.
            for a in &scene.annotations {
                if !visible(a) {
                    continue;
                }
                // Le rect d'ancrage se CHOISIT ici, mais le choix n'est pas
                // revenu : `anchor_rect` ne rend que `s_ann` ou le cadre de
                // sortie -- un sous-titre (`space: "frame"`) se mesure sur le
                // cadre. `s_dst` reste inatteignable, ce que `annotation_dst`
                // garantissait en ne prenant aucun parametre. L'arithmetique
                // elle-meme reste partagee, et les trois backends font
                // desormais exactement ces deux lignes.
                let anchor = a.anchor_rect(g.s_ann);
                let dst = crate::frame_geometry::annotation_dst_in(anchor, a.x, a.y, a.w, a.h);
                let quad_px = [dst[2] * rw, dst[3] * rh];
                // Une boite degeneree ferait un atlas 0x0 et un draw invisible ;
                // macOS l'ecarte de la meme facon.
                if quad_px[0] <= 0.0 || quad_px[1] <= 0.0 {
                    continue;
                }
                match a.kind.as_str() {
                    "figure" => {
                        let Some(figure) = a.figure.as_ref() else { continue };
                        let (segments, half_stroke) = crate::regions::arrow_local_geometry(
                            &figure.direction,
                            figure.stroke_width,
                            quad_px,
                        );
                        let cb = LayerCB {
                            dst,
                            quad_px,
                            mode: 9.0,
                            color: parse_hex(&figure.color).unwrap_or([1.0, 1.0, 1.0, 1.0]),
                            fx: segments[0],
                            src_prev: segments[1],
                            dst_prev: segments[2],
                            mb: [1.0, half_stroke, 0.0, 0.0],
                            ..Default::default()
                        };
                        let (buf, bind) = self.make_bind(&cb, None, &dummy);
                        ann_draws.push(AnnDraw::plain(buf, bind));
                    }
                    "blur" => {
                        let Some(blur) = a.blur.as_ref() else { continue };
                        // Le masque en trace libre demanderait une liste de points
                        // cote GPU : on masque la BOITE ENGLOBANTE. Choix
                        // deliberement asymetrique -- ne rien dessiner laisserait
                        // passer en clair ce que l'utilisateur a designe comme a
                        // cacher, et un masque qui ne masque pas donne confiance a
                        // tort.
                        let freehand = blur.shape == "freehand";
                        let is_blur = if blur.style == "blur" { 1.0 } else { 0.0 };
                        let amount =
                            if is_blur > 0.5 { blur.intensity } else { blur.block_size };
                        // Le repli passe par le rectangle, pas l'ovale : un ovale
                        // inscrit retirerait les coins, donc une partie de ce qui
                        // est couvert.
                        let is_oval = if blur.shape == "oval" && !freehand { 1.0 } else { 0.0 };
                        // La teinte n'a de sens qu'en mosaique : un flou teinte ne
                        // ressemble plus a un flou.
                        let tinted = if is_blur > 0.5 { 0.0 } else { 1.0 };
                        let tint = if blur.color == "black" {
                            [0.0, 0.0, 0.0, 1.0]
                        } else {
                            [1.0, 1.0, 1.0, 1.0]
                        };
                        let cb = LayerCB {
                            dst,
                            quad_px,
                            mode: 10.0,
                            color: tint,
                            fx: [is_blur, amount.max(1.0), is_oval, tinted],
                            ..Default::default()
                        };
                        // La copie mipmappee au binding 1 (texY), la ou le mode 10
                        // la lit.
                        let (buf, bind) = self.make_bind(
                            &cb,
                            Some((&self.ann_copy_view, &self.ann_copy_view)),
                            &dummy,
                        );
                        ann_draws.push(AnnDraw::plain(buf, bind));
                    }
                    "image" => {
                        let Some(src) = a.image_path.as_ref().filter(|s| !s.is_empty()) else {
                            continue;
                        };
                        let cached = {
                            let c = self.ann_img_cache.borrow();
                            c.get(&a.id).filter(|(_, _, _, len)| *len == src.len()).cloned()
                        };
                        let Some((tex, iw, ih, _)) = cached.or_else(|| {
                            match self.load_image_texture(src) {
                                Ok((tex, w, h)) => {
                                    let e = (tex, w, h, src.len());
                                    self.ann_img_cache
                                        .borrow_mut()
                                        .insert(a.id.clone(), e.clone());
                                    Some(e)
                                }
                                Err(e) => {
                                    eprintln!("[annotation image] {}: {e:#}", a.id);
                                    None
                                }
                            }
                        }) else {
                            continue;
                        };
                        if iw == 0 || ih == 0 {
                            continue;
                        }
                        // CONTAIN, pas cover : l'image tient entiere dans la boite
                        // et se centre. Etirer au rect deformerait une capture ou
                        // un logo, ce que le rendu web ne fait pas non plus.
                        let box_aspect = quad_px[0] / quad_px[1];
                        let img_aspect = iw as f32 / ih as f32;
                        let (fit_w, fit_h) = if img_aspect > box_aspect {
                            (dst[2], dst[3] * (box_aspect / img_aspect))
                        } else {
                            (dst[2] * (img_aspect / box_aspect), dst[3])
                        };
                        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
                        let cb = LayerCB {
                            dst: [
                                dst[0] + (dst[2] - fit_w) * 0.5,
                                dst[1] + (dst[3] - fit_h) * 0.5,
                                fit_w,
                                fit_h,
                            ],
                            src: [0.0, 0.0, 1.0, 1.0],
                            quad_px: [fit_w * rw, fit_h * rh],
                            mode: 7.0,
                            color: [1.0, 1.0, 1.0, 1.0],
                            // Mode 7 clippe sur `fx` : un rect qui couvre tout le
                            // cadre = pas de clip.
                            fx: [0.0, 0.0, 1.0, 1.0],
                            ..Default::default()
                        };
                        let (buf, bind) = self.make_bind(&cb, Some((&view, &view)), &dummy);
                        ann_draws.push(AnnDraw {
                            _buf: buf,
                            _glyphs: None,
                            _tex: Some(tex),
                            bind,
                        });
                    }
                    "text" => {
                        let Some(raster) = self.text_raster.as_ref() else { continue };
                        let Some(text) = a.text.as_ref() else { continue };
                        if text.content.trim().is_empty() {
                            continue;
                        }
                        let color = parse_hex(&text.color).unwrap_or([1.0, 1.0, 1.0, 1.0]);
                        let background =
                            parse_hex(&text.background_color).unwrap_or([0.0, 0.0, 0.0, 0.0]);
                        let spec = crate::text::TextSpec {
                            content: text.content.clone(),
                            color,
                            background,
                            font_size_px: text.font_size_rel * (anchor[3] * rh),
                            font_family: text.font_family.clone(),
                            bold: text.font_weight == "bold",
                            italic: text.font_style == "italic",
                            underline: text.text_decoration == "underline",
                            align: text.text_align.clone(),
                            // Absent = "center", le comportement historique : les
                            // annotations ne changent pas d'un pixel.
                            valign: text.vertical_align.clone().unwrap_or_default(),
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

                        // ANIMATION D'APPARITION (`text_anim`, partage avec macOS
                        // et Windows). Les decalages sont exprimes en px A 1080p
                        // et remis a l'echelle de la sortie, comme la taille de
                        // police : en px absolus la meme animation sauterait deux
                        // fois plus haut dans un rendu 4K que dans l'apercu.
                        let anim = crate::text_anim::text_animation_state(
                            text.animation.as_deref(),
                            (g.source_t - a.start_sec as f32) * 1000.0,
                        );
                        let anim_px = rh / crate::text_anim::ANIMATION_REFERENCE_HEIGHT;
                        let (mut ax, mut ay, mut aw, mut ah) = (
                            dst[0] + anim.translate_x * anim_px / rw,
                            dst[1] + anim.translate_y * anim_px / rh,
                            dst[2],
                            dst[3],
                        );
                        if (anim.scale - 1.0).abs() > 1e-4 {
                            let (cx, cy) = (ax + aw * 0.5, ay + ah * 0.5);
                            aw *= anim.scale;
                            ah *= anim.scale;
                            ax = cx - aw * 0.5;
                            ay = cy - ah * 0.5;
                        }
                        // Machine a ecrire : le quad ET son UV sont coupes a la
                        // meme fraction, donc la texture n'est pas etiree -- elle
                        // est revelee.
                        let reveal = anim.reveal.clamp(0.0, 1.0);
                        if reveal <= 0.0 {
                            continue;
                        }
                        let anim_dst = [ax, ay, aw * reveal, ah];

                        // PLAQUE DE FOND, dessinee AVANT les glyphes.
                        //
                        // macOS et Windows la peignent dans la texture de texte
                        // elle-meme ; ici c'est impossible : l'atlas est en R8, il
                        // ne porte qu'une couverture alpha et aucune couleur.
                        // Plutot que de convertir tout l'atlas en RGBA pour un
                        // aplat, on emet un quad mode 1 (couleur pleine + SDF de
                        // rect arrondi, cf. layer.wgsl) sous le quad de texte.
                        //
                        // Sans ca le fond n'existait tout simplement pas :
                        // `spec.background` arrivait jusqu'au rasteriseur et
                        // mourait dans `cache_key()`.
                        //
                        // LE RECT VIENT DU RASTERISEUR (`glyphs.plate`), pas de la
                        // boite : lui seul sait ou les lignes ont ete posees. Ici
                        // la plaque prenait toute la boite, ce qui sur un
                        // sous-titre — dont la boite est la bande de 22 % de
                        // hauteur — donnait un aplat bien plus haut que le texte,
                        // la ou Windows et macOS le serrent a `0.1em` pres.
                        if background[3] > 0.0 && glyphs.plate[2] > 0.0 && glyphs.plate[3] > 0.0 {
                            // Le rect est en px DANS la boite ; on le ramene en
                            // fractions pour le reporter sur le quad anime (que
                            // `anim.scale` a pu agrandir).
                            let (box_w, box_h) =
                                (spec.box_px[0].max(1) as f32, spec.box_px[1].max(1) as f32);
                            let px = ax + (glyphs.plate[0] / box_w) * aw;
                            let py = ay + (glyphs.plate[1] / box_h) * ah;
                            let ph = (glyphs.plate[3] / box_h) * ah;
                            // Machine a ecrire : la plaque se decouvre avec le
                            // texte, comme sur les backends qui la bakent dans la
                            // texture — sinon l'aplat entier precede les glyphes.
                            let pw = (((glyphs.plate[2] / box_w) * aw) + px)
                                .min(ax + aw * reveal)
                                - px;
                            if pw > 0.0 && ph > 0.0 {
                                let (pw_px, ph_px) = (pw * rw, ph * rh);
                                let plate = LayerCB {
                                    dst: [px, py, pw, ph],
                                    src: [0.0, 0.0, 1.0, 1.0],
                                    quad_px: [pw_px, ph_px],
                                    mode: 1.0,
                                    // La plaque suit l'opacite du texte : sinon un
                                    // fondu ferait apparaitre un aplat plein d'un
                                    // coup puis le texte dessus.
                                    color: [
                                        background[0],
                                        background[1],
                                        background[2],
                                        background[3] * anim.opacity,
                                    ],
                                    // Meme rayon que les deux autres backends —
                                    // en em de la police, borne par la plaque.
                                    radius_px: crate::text_plate::radius(
                                        spec.font_size_px,
                                        pw_px,
                                        ph_px,
                                    ),
                                    ..Default::default()
                                };
                                let (pbuf, pbind) = self.make_bind(&plate, None, &dummy);
                                ann_draws.push(AnnDraw::plain(pbuf, pbind));
                            }
                        }

                        let cb = LayerCB {
                            dst: anim_dst,
                            src: [0.0, 0.0, reveal, 1.0],
                            quad_px: [anim_dst[2] * rw, anim_dst[3] * rh],
                            mode: 11.0,
                            color: [color[0], color[1], color[2], color[3] * anim.opacity],
                            ..Default::default()
                        };
                        // Atlas R8 au binding 1 (texY) que le mode 11 echantillonne.
                        let (buf, bind) =
                            self.make_bind(&cb, Some((&glyphs.view, &glyphs.view)), &dummy);
                        ann_draws.push(AnnDraw {
                            _buf: buf,
                            _glyphs: Some(glyphs),
                            _tex: None,
                            bind,
                        });
                    }
                    _ => {}
                }
            }
        }

        // Curseur thematise : sprite RGBA droit (mode 7) ou pose sur le plan
        // incline (mode 13) selon ce que `plan_cursor` a resolu.
        // `_tex`/`_view`/`_bufs` gardent le sprite et les uniformes en vie
        // pendant le pass. Miroir de la branche curseur de `compositor_macos`.
        //
        // TRAINEE (`plan.taps > 1`) : `binds` porte une copie par echantillon,
        // interpolee entre `prev_placement` et le placement courant. Elles ne
        // sont PAS dessinees sur le RT mais dans `accum`, puis compositees en une
        // fois -- cf. le commentaire au point de dessin.
        struct CursorDraw {
            _bufs: Vec<wgpu::Buffer>,
            _tex: wgpu::Texture,
            _view: wgpu::TextureView,
            binds: Vec<wgpu::BindGroup>,
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
            // `taps == 1` : un seul placement, celui de l'instant rendu -- le
            // chemin net d'avant, inchange. Au-dela, on echelonne les copies
            // regulierement de `prev_placement` (inclus) au placement courant
            // (inclus) : c'est ce que font les deux autres backends, et inclure
            // les deux bornes est ce qui fait que la trainee touche a la fois
            // l'endroit d'ou le curseur vient et celui ou il est.
            //
            // On interpole des PLACEMENTS et non des centres : `lerp` sait
            // traiter le cas incline, si bien qu'une trainee sous zoom incline
            // reste dans le plan au lieu de repasser par un centre 2D qui
            // l'aplatirait.
            let placements: Vec<CursorPlacement> = if plan.taps <= 1 {
                vec![plan.placement]
            } else {
                (0..plan.taps)
                    .map(|k| {
                        let f = k as f32 / (plan.taps - 1) as f32;
                        plan.prev_placement.lerp(plan.placement, f)
                    })
                    .collect()
            };
            let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
            let (mut bufs, mut binds) = (Vec::new(), Vec::new());
            for placement in placements {
                let cb = match placement {
                    CursorPlacement::Upright { center } => LayerCB {
                        dst: cursor_sprite_dst(center, pw / rw, ph / rh, hotspot),
                        src: [0.0, 0.0, 1.0, 1.0],
                        mode: 7.0,
                        color: [1.0, 1.0, 1.0, 1.0],
                        fx: plan.clip,
                        ..Default::default()
                    },
                CursorPlacement::Tilted { plane_pt, quad, center_px, screen_px, .. } => {
                    // Le sprite est pose DANS le plan : sa taille devient une fraction
                    // du plan et ses quatre coins traversent la meme projection que la
                    // video. La reduction due au tilt vient donc de la projection --
                    // rien a multiplier a la main.
                    let (wf, hf) = (pw / screen_px[0], ph / screen_px[1]);
                    let x0 = plane_pt[0] - hotspot[0] * wf;
                    let y0 = plane_pt[1] - hotspot[1] * hf;
                    let corners = [(x0, y0), (x0 + wf, y0), (x0 + wf, y0 + hf), (x0, y0 + hf)]
                        .map(|(fx, fy)| {
                            let (px, py) = quad.point_px(fx, fy);
                            (center_px[0] + px, center_px[1] + py)
                        });
                    let (min_x, max_x) = corners
                        .iter()
                        .fold((f32::MAX, f32::MIN), |(mn, mx), &(x, _)| (mn.min(x), mx.max(x)));
                    let (min_y, max_y) = corners
                        .iter()
                        .fold((f32::MAX, f32::MIN), |(mn, mx), &(_, y)| (mn.min(y), mx.max(y)));
                    // Le quad projete d'un sprite peut etre tres fin de biais : une bbox
                    // d'un pixel de large ferait diverger le warp inverse, d'ou le
                    // plancher a 1 px.
                    let (bw, bh) = ((max_x - min_x).max(1.0), (max_y - min_y).max(1.0));
                    let local = |(x, y): (f32, f32)| [x - min_x, y - min_y];
                    let [tl0, tl1] = local(corners[0]);
                    let [tr0, tr1] = local(corners[1]);
                    let [br0, br1] = local(corners[2]);
                    let [bl0, bl1] = local(corners[3]);
                    LayerCB {
                        dst: [min_x / rw, min_y / rh, bw / rw, bh / rh],
                        quad_px: [bw, bh],
                        mode: 13.0,
                        color: [1.0, 1.0, 1.0, 1.0],
                        fx: [tl0, tl1, tr0, tr1],
                        src_prev: [br0, br1, bl0, bl1],
                        // Le clip vit ici et NON dans `fx` (mode 7) : `fx` porte les coins.
                        dst_prev: plan.clip,
                        ..Default::default()
                    }
                }
                };
                // Sprite RGBA au binding 1 (texY) que le mode 7 echantillonne.
                let (buf, bind) = self.make_bind(&cb, Some((&view, &view)), &dummy);
                bufs.push(buf);
                binds.push(bind);
            }
            Some(CursorDraw { _bufs: bufs, _tex: tex, _view: view, binds })
        })();
        // Bind group de la passe de composition d'`accum` (layout du blur :
        // uniform + texture + sampler). Construit hors de la pass, comme les
        // autres. L'uniforme n'est pas lu par `fs_copy` mais le layout l'exige.
        let accum_bind = cursor_draw
            .as_ref()
            .filter(|c| c.binds.len() > 1)
            .map(|_| {
                let cb = LayerCB::default();
                let uniform =
                    self.gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("accum-copy-uniform"),
                        contents: layer_bytes(&cb),
                        usage: wgpu::BufferUsages::UNIFORM,
                    });
                let bind = self.gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("accum-copy"),
                    layout: &self.blur_bgl,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&self.accum_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::Sampler(&self.sampler),
                        },
                    ],
                });
                (uniform, bind)
            });

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
        // Passe 2 : avant-plan (ecran + webcam), compose par-dessus le fond
        // (eventuellement floute) avec `LoadOp::Load`. Les annotations sont dans
        // une passe a part, cf. plus bas.
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
            // Chaque ombre est dessinee JUSTE AVANT le calque qu'elle porte :
            // elle doit passer sous lui mais au-dessus du fond (et, pour la
            // camera, au-dessus de l'ecran).
            if let Some((_buf, bind)) = &screen_shadow {
                rpass.set_bind_group(0, bind, &[]);
                rpass.draw(0..4, 0..1);
            }
            rpass.set_bind_group(0, &screen_bind, &[]);
            rpass.draw(0..4, 0..1);
            if let Some((_buf, bind)) = &webcam_shadow {
                rpass.set_bind_group(0, bind, &[]);
                rpass.draw(0..4, 0..1);
            }
            if let Some((_buf, bind)) = &webcam_draw {
                rpass.set_bind_group(0, bind, &[]);
                rpass.draw(0..4, 0..1);
            }
        }
        // Fige la frame composee pour les annotations « flou ». ICI et nulle part
        // ailleurs : apres l'ecran et la camera (sinon un flou masquerait du vide)
        // et avant la premiere annotation (sinon deux flous qui se recouvrent
        // s'echantillonnent l'un l'autre). Une passe de rendu ne peut pas lire sa
        // propre cible, d'ou la copie -- et d'ou le fait que les annotations
        // doivent avoir leur propre passe.
        if needs_ann_copy {
            self.generate_ann_mips(&mut encoder);
        }
        // Passe 3 : annotations puis curseur net, par-dessus tout le reste. Elle
        // existe meme sans flou : deux passes consecutives sur la MEME cible avec
        // `LoadOp::Load` ne coutent rien de plus qu'une seule sur un GPU
        // desktop, et un seul chemin de code vaut mieux qu'un branchement qui ne
        // serait exerce que dans un projet sur dix.
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("ann-pass"),
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
            for a in &ann_draws {
                rpass.set_bind_group(0, &a.bind, &[]);
                rpass.draw(0..4, 0..1);
            }
            // Curseur en dernier : au-dessus de l'ecran et des annotations.
            // Une seule copie = curseur net, il tient dans cette pass. La
            // trainee, elle, a besoin de sa propre cible (voir plus bas).
            if let Some(c) = cursor_draw.as_ref().filter(|c| c.binds.len() == 1) {
                rpass.set_bind_group(0, &c.binds[0], &[]);
                rpass.draw(0..4, 0..1);
            }
        }
        // TRAINEE DU CURSEUR : flou REEL, pas des copies discretes.
        //
        // Les N echantillons s'accumulent dans une cible ISOLEE partie de zero,
        // puis sont compositees « over » sur la scene. Les additionner
        // directement sur le RT reviendrait a AJOUTER la couleur du curseur
        // (souvent du blanc) a ce qui est deja dessous : sur un fond clair, deja
        // proche du blanc, ajouter du blanc*(1/taps) ne change presque rien --
        // curseur quasi invisible. Dans une cible a part la somme reste
        // correctement normalisee (alpha ~1 la ou les copies se recouvrent), et
        // la composition finale est un « over » ordinaire, correct quel que soit
        // le fond. Meme raisonnement, mot pour mot, cote macOS et Windows.
        if let (Some(c), Some((_ubuf, abind))) = (
            cursor_draw.as_ref().filter(|c| c.binds.len() > 1),
            accum_bind.as_ref(),
        ) {
            {
                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("cursor-accum-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &self.accum_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            // Le clear EST la raison d'etre de cette cible : elle
                            // doit partir vide a chaque frame, pas cumuler.
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                rpass.set_pipeline(&self.pipeline_add);
                let w = 1.0 / c.binds.len() as f64;
                rpass.set_blend_constant(wgpu::Color { r: w, g: w, b: w, a: w });
                for bind in &c.binds {
                    rpass.set_bind_group(0, bind, &[]);
                    rpass.draw(0..4, 0..1);
                }
            }
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("cursor-accum-composite"),
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
            rpass.set_pipeline(&self.pipeline_copy);
            rpass.set_bind_group(0, abind, &[]);
            rpass.draw(0..3, 0..1);
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
