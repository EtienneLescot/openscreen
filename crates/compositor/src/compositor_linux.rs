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
//!
//! **Segmentation du sujet webcam.** Les quatre etages tournent ici comme sur les
//! deux autres back-ends : `capture_webcam_rgb` rend la camera dans une cible
//! 256x144 et la relit, `segmentation.rs` (partage, EP CPU d'ONNX Runtime) produit
//! le masque sur son propre thread, `set_webcam_mask` le televerse en R8, et
//! `layer.wgsl` branche dessus sur `fx.z`. Cf.
//! `technical-documentation/engineering/webcam-segmentation.md`.

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

/// Budget du cache de textures image (`img_cache`), en octets.
///
/// Doit tenir le JEU ACTIF d'une frame -- au pire un wallpaper d'ecran ET un
/// fond de camera, que rien n'empeche d'etre deux 7680x7680 a 225 Mo piece.
/// Sous ce seuil l'eviction ne peut plus rendre de memoire sans toucher au jeu
/// actif, ce qu'elle refuse de faire. 512 Mo borne la fuite (1 774 Mo mesures
/// en parcourant les 18 wallpapers livres) en laissant le jeu actif resident.
const IMG_CACHE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;

/// `&LayerCB` -> `&[u8; 128]`. `LayerCB` est `#[repr(C, align(16))]`, son layout
/// EST le buffer uniforme WGSL (16 vec4 + 1 vec2 + 2 f32 = 128 octets).
fn layer_bytes(cb: &LayerCB) -> &[u8] {
    unsafe { std::slice::from_raw_parts(cb as *const LayerCB as *const u8, 128) }
}

/// Un calque de fond deja lie, en attente de son `draw`. `_buf`/`_tex`/`_view`
/// ne sont jamais relus : ils gardent en vie ce que le bind group reference
/// jusqu'au submit. Ce backend encode toute la frame avant de la soumettre, la
/// ou D3D11 dessine au fil de l'eau ; d'ou cette boite, la que Windows n'a pas
/// besoin d'equivalent.
///
/// Vit au niveau module (et non dans `compose_frame`) parce que le fond d'ecran
/// ET le fond de la bulle webcam sont desormais construits par les memes
/// methodes.
struct BgDraw {
    _buf: wgpu::Buffer,
    _tex: Option<wgpu::Texture>,
    _view: Option<wgpu::TextureView>,
    bind: wgpu::BindGroup,
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

/// Cibles et pipelines de la conversion RGBA -> YUV420P sur le GPU.
///
/// Trois cibles R8Unorm plutot qu'une seule : Y est en pleine resolution et U/V
/// en demie (4:2:0), et wgpu ne sait pas ecrire des attachements de tailles
/// differentes dans une meme passe.
/// Disposition de la chrominance. PAS un gout : une consequence de l'encodeur
/// qui va consommer la frame. `libopenh264` n'accepte que du YUV420P planaire
/// (ses `pix_fmts` sont yuv420p/yuvj420p), VAAPI encode depuis du NV12. Le
/// compositeur doit donc savoir produire les deux.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum YuvFormat {
    /// U et V dans deux plans `R8Unorm` separes.
    I420,
    /// U et V entrelaces dans un seul plan `Rg8Unorm`.
    Nv12,
}

/// Les cibles de chrominance, dont la forme depend du format.
enum Chroma {
    Planar {
        _u: wgpu::Texture,
        _v: wgpu::Texture,
        u_view: wgpu::TextureView,
        v_view: wgpu::TextureView,
        pipe_u: wgpu::RenderPipeline,
        pipe_v: wgpu::RenderPipeline,
    },
    Interleaved {
        _uv: wgpu::Texture,
        uv_view: wgpu::TextureView,
        pipe_uv: wgpu::RenderPipeline,
    },
}

struct YuvTargets {
    /// Gardee en vie pour sa vue ; seule la vue sert au rendu.
    _y: wgpu::Texture,
    y_view: wgpu::TextureView,
    chroma: Chroma,
    fmt: YuvFormat,
    bind: wgpu::BindGroup,
    pipe_y: wgpu::RenderPipeline,
    /// Dimensions pour lesquelles tout ceci a ete construit : un resize doit
    /// tout refaire, et comparer ici est moins fragile que de s'en souvenir.
    w: u32,
    h: u32,
    /// `bytes_per_row` alignes a 256. En 1080p, Y passe de 1920 a 2048 et U/V de
    /// 960 a 1024 : contrairement au RGBA (7680 = 30*256, deja aligne), les plans
    /// PORTENT du padding, et le lecteur doit le retirer ligne a ligne.
    bpr_y: u32,
    bpr_uv: u32,
    /// Offsets des plans de chrominance dans le buffer de staging unique.
    /// Alignes a 256 (exigence de `copy_texture_to_buffer`), ce que la taille du
    /// plan Y garantit deja puisque `bpr_y` l'est. En NV12 il n'y a qu'un plan de
    /// chrominance : `off_v` vaut alors `off_u` et ne doit pas etre lu.
    off_u: u64,
    off_v: u64,
    total: u64,
}

// ---------------------------------------------------------------------------
// Segmentation du sujet webcam
// ---------------------------------------------------------------------------

/// Cadence de l'inference. Meme valeur et meme raison que
/// `compositor_windows::SEGMENTATION_HZ` : une silhouette ne bouge pas de facon
/// perceptible en 16 ms, et c'est le seul levier mesure qui divise le cout par
/// deux sans toucher au modele.
const SEGMENTATION_HZ: u32 = 30;

/// Cible RGBA + buffer de staging pour extraire la frame webcam a la resolution
/// du modele. Pendant wgpu de `compositor_windows::SegCapture`.
///
/// La divergence tient au `bpr`. D3D11 rend un row pitch decide par le driver et
/// Metal accepte la largeur nue ; `copy_texture_to_buffer` exige, lui, un
/// `bytes_per_row` multiple de 256. Il est donc padde ICI, a la creation, et
/// depadde a la lecture — exactement ce que `ReadbackRing` fait deja pour le RT.
/// A 256 px de large le padding est nul (1024 est deja aligne), mais rien dans
/// cette structure ne le suppose : c'est `width` qui decide, pas le modele.
struct SegCapture {
    /// Cible de la passe de capture, et source de la copie vers `staging`.
    rt: wgpu::Texture,
    view: wgpu::TextureView,
    /// Buffer de staging REUTILISE d'une capture a l'autre : a 30 Hz, en
    /// reallouer un par tour serait un cout gratuit.
    staging: wgpu::Buffer,
    width: u32,
    height: u32,
    bpr: u32,
}

/// Texture du masque de segmentation, recreee seulement quand la resolution du
/// modele change — c'est-a-dire jamais, en regime etabli.
///
/// La vue vit A COTE de la texture plutot que d'etre recreee par draw :
/// `make_bind` lie le binding 4 sur CHAQUE draw de calque (le layout l'exige, cf.
/// `tex_entry(4)`), donc une vue par draw ferait une dizaine d'allocations par
/// frame pour rien. La texture, elle, reste indispensable : `write_texture`
/// prend une `Texture`, pas une `TextureView`.
struct WebcamMask {
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
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

    /// Conversion RGBA -> Y/U/V sur le GPU, construite a la premiere demande.
    ///
    /// Paresseuse et non dans `new` pour une raison de contrat : la preview
    /// n'en veut pas (elle rend du RGBA a un `<canvas>`) et la payer a chaque
    /// construction de compositeur couterait trois textures et trois pipelines
    /// a tout le monde pour le seul benefice de l'export.
    yuv: RefCell<Option<YuvTargets>>,
    /// Ring de staging DEDIEE aux plans YUV : ses buffers font 3,1 Mo la ou
    /// ceux de `readback` en font 8,3, et melanger les deux tailles dans une
    /// seule ring rendrait la reutilisation dependante de l'ordre des appels.
    readback_yuv: RefCell<ReadbackRing>,

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
    /// role que `img_cache` cote macOS. Charge une fois, PAS pour la session : l'entree
    /// est evincable des qu'elle sort du jeu actif d'une frame, et un retour dessus la
    /// rechargera -- cf. `cached_image`.
    /// Le quatrieme champ du tuple est le tick d'usage, qui donne l'ordre LRU
    /// -- cf. `cached_image`.
    img_cache: RefCell<std::collections::HashMap<String, (wgpu::Texture, u32, u32, u64)>>,
    /// Compteur d'acces de `img_cache`, pour l'ordre LRU. Un compteur plutot
    /// que l'index de frame : une frame touche plusieurs entrees, et il faut
    /// pouvoir les ordonner entre elles.
    img_tick: std::cell::Cell<u64>,
    /// Valeur de `img_tick` au debut de la frame en cours. Tout ce qui a ete
    /// touche depuis appartient au jeu actif et ne peut pas etre evince -- voir
    /// `cached_image`.
    img_frame_start: std::cell::Cell<u64>,

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

    // --- Segmentation du sujet webcam (cf. `pump_segmentation`) ---
    /// Masque du sujet, R8 a la resolution du modele. Ecrit par
    /// `set_webcam_mask`, lu par `make_bind` au moment de construire chaque bind
    /// group. `None` tant qu'aucune frame n'a ete segmentee — l'effet reste
    /// alors eteint plutot que de rendre une webcam invisible en detourage.
    webcam_mask: RefCell<Option<WebcamMask>>,
    /// Cible + staging de la capture, crees a la premiere capture et jamais
    /// redimensionnes : le modele a une entree fixe.
    seg_capture: RefCell<Option<SegCapture>>,
    /// Worker d'inference, absent tant que `enable_segmentation` n'a pas ete
    /// appele.
    seg_worker: RefCell<Option<crate::segmentation::SegmentationWorker>>,
    /// Segmenteur tenu SUR LE THREAD DE RENDU, utilise a la place du worker en
    /// mode deterministe. Voir `set_segmentation_deterministic`.
    seg_sync: RefCell<Option<crate::segmentation::Segmenter>>,
    /// Export : cadence par frame et inference synchrone, au lieu de l'horloge
    /// et du worker.
    seg_deterministic: std::cell::Cell<bool>,
    /// Boite aux lettres du worker. Le masque est depose depuis le thread
    /// d'inference et televerse depuis le thread de rendu : aucun appel wgpu ne
    /// traverse de thread, ce qui compte ici puisque `Compositor` n'est ni `Send`
    /// ni `Sync` (tout son etat vit dans des `RefCell`).
    seg_inbox: std::sync::Arc<std::sync::Mutex<Option<Vec<u8>>>>,
    seg_rate: RefCell<crate::segmentation::RateLimiter>,
    /// Frame RGB reutilisee d'une capture a l'autre.
    seg_scratch: RefCell<Vec<u8>>,
    /// Le chargement du modele a echoue : ne pas reessayer a chaque frame.
    seg_failed: RefCell<bool>,
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
                    // Masque de segmentation du sujet webcam. TOUJOURS declare, meme sans
                    // masque : wgpu valide le bind group contre le layout, donc une entree
                    // absente ferait echouer chaque draw et pas seulement ceux qui l'utilisent.
                    // `dummy_view()` est lie a la place, et la branche du shader n'est de
                    // toute facon prise que si fx.z > 0.5.
                    tex_entry(4),
                    // Plan V. En 5 et pas en 3 : les bindings 0-4 etaient deja
                    // pris quand le chroma est passe d'un plan entrelace a deux
                    // plans, et renumeroter aurait touche tous les bind groups
                    // pour un gain nul.
                    tex_entry(5),
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
        // Vide : les buffers YUV sont dimensionnes par `YuvTargets` (qui connait
        // les trois `bytes_per_row` alignes) et alloues a la premiere relecture.
        let readback_yuv = RefCell::new(ReadbackRing {
            depth: 1,
            free: Vec::new(),
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
            yuv: RefCell::new(None),
            readback_yuv,
            live_params: RefCell::new(LiveParams::default()),
            scene: RefCell::new(None),
            cursor: RefCell::new(None),
            cursor_time: RefCell::new(None),
            timeline_time: RefCell::new(None),
            text_raster: crate::text::TextRasterizer::new().ok(),
            img_cache: RefCell::new(std::collections::HashMap::new()),
            img_tick: std::cell::Cell::new(0),
            img_frame_start: std::cell::Cell::new(0),
            ann_copy,
            ann_copy_view,
            ann_copy_mips,
            ann_img_cache: RefCell::new(std::collections::HashMap::new()),
            webcam_mask: RefCell::new(None),
            seg_capture: RefCell::new(None),
            seg_worker: RefCell::new(None),
            seg_sync: RefCell::new(None),
            seg_deterministic: std::cell::Cell::new(false),
            seg_inbox: std::sync::Arc::new(std::sync::Mutex::new(None)),
            seg_rate: RefCell::new(crate::segmentation::RateLimiter::new(SEGMENTATION_HZ)),
            seg_scratch: RefCell::new(Vec::new()),
            seg_failed: RefCell::new(false),
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
    ) -> Result<(wgpu::TextureView, wgpu::TextureView, wgpu::TextureView)> {
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
        planes: Option<(&wgpu::TextureView, &wgpu::TextureView, &wgpu::TextureView)>,
        dummy: &wgpu::TextureView,
    ) -> (wgpu::Buffer, wgpu::BindGroup) {
        let uniform = self.gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("layer-uniform"),
            contents: layer_bytes(cb),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let (y, u, v) = planes.unwrap_or((dummy, dummy, dummy));
        // Le masque est lie sur TOUS les draws, pas seulement celui de la camera.
        // wgpu valide le bind group contre le layout : le binding 4 est declare
        // (`tex_entry(4)`), donc une entree absente ferait echouer CHAQUE draw et
        // pas seulement ceux qui l'echantillonnent. Le lier partout ne coute rien
        // — la branche du shader n'est prise que si `fx.z > 0.5`, et seul le
        // calque webcam leve `fx.z`. `dummy` reste le repli tant qu'aucune frame
        // n'a ete segmentee.
        let mask = self.webcam_mask.borrow();
        let mask_view = mask.as_ref().map_or(dummy, |m| &m.view);
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
                    resource: wgpu::BindingResource::TextureView(u),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(mask_view),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(v),
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

    /// Ouvre une frame du point de vue d'`img_cache` : tout ce qui sera touche
    /// apres cet appel est le jeu actif, et devient inevincable jusqu'a la
    /// frame suivante.
    fn begin_image_frame(&self) {
        // `+ 1` : la premiere entrée de cette frame recevra `img_tick + 1`, et la protection
        // porte sur `tick >= img_frame_start`. Sans le decalage on protégerait aussi la
        // DERNIERE entrée de la frame precedente, qui n'appartient plus au jeu actif — le
        // résident pourrait alors dépasser le budget d'une texture entière.
        self.img_frame_start.set(self.img_tick.get() + 1);
    }

    /// Texture d'un fichier image, decodee une seule fois puis reutilisee.
    ///
    /// Le cache etait NON BORNE, et c'est un vrai cout : les wallpapers livres
    /// pesent 23,7 Mo sur disque mais 1 774 Mo une fois decodes en RGBA8 --
    /// `wallpaper8.jpg` fait 7680x7680, soit 225 Mo a lui seul. Parcourir le
    /// selecteur les chargeait tous et n'en liberait aucun.
    ///
    /// L'eviction est LRU sous un budget en octets, et ne touche jamais une
    /// texture que la frame EN COURS a deja servie : sans ca, un fond d'ecran
    /// et un fond de camera un peu gros se chasseraient l'un l'autre a chaque
    /// frame, et un decodage coute 129 ms contre les ~3,5 ms d'une frame. Si le
    /// jeu actif depasse a lui seul le budget, on depasse le budget.
    fn cached_image(&self, path: &str) -> Result<(wgpu::Texture, u32, u32)> {
        let tick = self.img_tick.get() + 1;
        self.img_tick.set(tick);
        // Recherche isolee dans un `let` pour que l'emprunt immuable soit
        // relache AVANT le `borrow_mut` (piege du double emprunt 1re frame).
        let hit = self.img_cache.borrow().get(path).cloned();
        if let Some((tex, w, h, _)) = hit {
            self.img_cache.borrow_mut().insert(path.to_string(), (tex.clone(), w, h, tick));
            return Ok((tex, w, h));
        }
        let (tex, w, h) = self.load_image_texture(path)?;
        let mut cache = self.img_cache.borrow_mut();
        cache.insert(path.to_string(), (tex.clone(), w, h, tick));
        // La politique vit dans `frame_geometry` : les trois backends la
        // partagent, comme la geometrie, plutot que d'entretenir trois copies
        // qui finiraient par diverger.
        let entries: Vec<(String, u64, u64)> =
            cache.iter().map(|(k, e)| (k.clone(), e.1 as u64 * e.2 as u64 * 4, e.3)).collect();
        let protect_from = self.img_frame_start.get();
        for key in
            crate::frame_geometry::lru_evictions(&entries, IMG_CACHE_BUDGET_BYTES, protect_from)
        {
            cache.remove(&key);
        }
        Ok((tex, w, h))
    }

    /// Calque image (mode 6) couvrant `dst`, en cover-fit contre `aspect` -- le
    /// ratio du RECT vise, et non celui de la sortie : le rognage se calcule
    /// contre la zone qu'on remplit, ce qui permet a la bulle webcam d'emprunter
    /// le chemin du fond d'ecran au lieu d'en refaire un.
    ///
    /// Err plutot qu'un repli maison : chaque appelant a son propre message et
    /// son propre repli, et un echec silencieux redonnerait le noir qu'on corrige.
    fn image_bg_draw(
        &self,
        path: &str,
        dst: [f32; 4],
        quad_px: [f32; 2],
        radius_px: f32,
        aspect: f32,
        dummy: &wgpu::TextureView,
    ) -> Result<BgDraw> {
        let (tex, iw, ih) = self.cached_image(path)?;
        // Cover-fit : l'image remplit tout le rect, on rogne l'axe long.
        let ai = iw as f32 / ih.max(1) as f32;
        let src = if ai > aspect {
            let vis = aspect / ai;
            [(1.0 - vis) * 0.5, 0.0, 1.0 - (1.0 - vis) * 0.5, 1.0]
        } else {
            let vis = ai / aspect;
            [0.0, (1.0 - vis) * 0.5, 1.0, 1.0 - (1.0 - vis) * 0.5]
        };
        let cb = LayerCB {
            dst,
            src,
            quad_px,
            radius_px,
            mode: 6.0,
            ..Default::default()
        };
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        let (buf, bind) = self.make_bind(&cb, Some((&view, &view, &view)), dummy);
        Ok(BgDraw { _buf: buf, _tex: Some(tex), _view: Some(view), bind })
    }

    /// Prepare le fond du mode « personnalise », peint DANS la bulle webcam juste
    /// avant que la camera n'y soit decoupee par-dessus.
    ///
    /// Le shader ne sait peindre qu'une couleur plate sous le masque, donc un
    /// degrade ou une image y tombaient sur du noir -- et le defaut EST une image
    /// (`DEFAULT_WALLPAPER`), si bien que le mode ne rendait jamais ce que le
    /// selecteur montrait. Peindre le fond puis composer la camera en detourage
    /// donne exactement le meme resultat (`lerp(fond, camera, personne)`, ici par
    /// le melange alpha) pour les trois sortes de fond, en reutilisant les chemins
    /// deja eprouves du fond d'ecran, et sans rien ajouter aux trois shaders.
    ///
    /// `quad_px` / `radius_px` sont ceux de la bulle : le fond doit epouser ses
    /// coins arrondis, sinon un rectangle deborde derriere la camera.
    fn webcam_bg_draw(
        &self,
        bg: Option<&SceneBackground>,
        dst: [f32; 4],
        quad_px: [f32; 2],
        radius_px: f32,
        dummy: &wgpu::TextureView,
    ) -> BgDraw {
        const BLACK: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
        let flat = |cb: LayerCB| {
            let (buf, bind) = self.make_bind(&cb, None, dummy);
            BgDraw { _buf: buf, _tex: None, _view: None, bind }
        };
        let solid = |color: [f32; 4]| LayerCB {
            dst,
            quad_px,
            radius_px,
            mode: 1.0,
            color,
            ..Default::default()
        };
        match bg {
            Some(SceneBackground::Color { color }) => {
                flat(solid(parse_hex(color).unwrap_or(BLACK)))
            }
            Some(SceneBackground::Gradient { angle_deg, stops }) => {
                let c0 = stops.first().and_then(|s| parse_hex(s)).unwrap_or(BLACK);
                let c1 = stops.last().and_then(|s| parse_hex(s)).unwrap_or(c0);
                // angle CSS -> direction unitaire, meme convention que le fond
                // d'ecran (dont la direction se lit en espace SORTIE : le degrade
                // traverse le cadre, la bulle n'en montre que sa tranche).
                let a = angle_deg.to_radians();
                flat(LayerCB {
                    dst,
                    src: [c1[0], c1[1], c1[2], c1[3]],
                    quad_px,
                    radius_px,
                    mode: 5.0,
                    color: c0,
                    fx: [a.sin(), -a.cos(), 0.0, 0.0],
                    ..Default::default()
                })
            }
            Some(SceneBackground::Image { path }) => {
                // Le cover-fit se mesure sur la BULLE, pas sur la sortie : c'est
                // elle que l'image doit remplir sans etirement.
                let aspect = if quad_px[1] > 0.0 { quad_px[0] / quad_px[1] } else { 1.0 };
                match self.image_bg_draw(path, dst, quad_px, radius_px, aspect, dummy) {
                    Ok(d) => d,
                    Err(e) => {
                        // Meme contrat que le fond d'ecran : un chemin casse est
                        // logge puis remplace par du noir. Un repli silencieux
                        // redonnerait le bug qu'on corrige.
                        eprintln!("[fond webcam] \"{path}\" : {e:#}");
                        flat(solid(BLACK))
                    }
                }
            }
            // Personnalise sans fond : noir, comme avant -- mais c'est desormais
            // le seul chemin qui y mene, au lieu de l'etre pour toute image et
            // tout degrade.
            None => flat(solid(BLACK)),
        }
    }

    // -- segmentation du sujet webcam --

    /// Extrait la frame webcam en RGB8 a la resolution du modele, dans `out`.
    ///
    /// Pendant wgpu de `compositor_windows::capture_webcam_rgb`, avec les memes
    /// contraintes d'appel. Comme cote Metal, rien n'est « requisitionne » : la
    /// passe s'ouvre sur `SegCapture::view` et se referme. La contrainte d'ordre
    /// tient malgre tout, et pour une autre raison — cette methode ATTEND sa
    /// propre soumission, donc l'appeler une fois la passe de composition
    /// encodee serialiserait CPU et GPU sur exactement le chemin que cette
    /// conception garde recouvert. Elle tourne donc dans le prologue de
    /// `compose_frame`, avant le moindre encodeur.
    ///
    /// `src` est le rect source en UV. L'appelant y passe la frame ENTIERE et non
    /// le sous-rect dessine — cf. `pump_segmentation`.
    ///
    /// # Le readback
    ///
    /// Meme forme que `ReadbackRing`, en plus simple parce qu'il n'y a rien a
    /// recouvrir : une seule copie, attendue tout de suite. Ce qui EST repris de
    /// la ring, parce que c'est la lecon qu'elle porte, c'est
    /// `WaitForSubmissionIndex` — jamais `Maintain::Wait`, qui absorberait toute
    /// la file GPU (3,8 a 6,2 ms mesurees en 1080p, cf. l'en-tete de
    /// `ReadbackRing`) au lieu de la seule copie de 147 Ko demandee ici.
    ///
    /// C'est le second readback synchrone du chemin de preview, qui en paie deja
    /// un a profondeur 1 (`live.rs`). C'est le seul cout que ce portage ajoute au
    /// rendu, et il ne se paie que quand un effet est demande.
    ///
    /// A l'EXPORT, ou la ring tourne a profondeur 2, il faut etre honnete sur ce
    /// que cette attente coute : une file GPU se termine dans l'ordre, donc
    /// attendre CETTE soumission, c'est attendre aussi la copie de la frame
    /// precedente que la ring gardait justement en vol. Le travail CPU de la
    /// frame courante ne la recouvre donc plus. Ce n'est pas gratuit, c'est
    /// seulement borne : 30 Hz et non 60, et zero quand aucun effet n'est demande.
    /// Aucune des deux mesures §C.2 n'a ete faite — cf. « Still open » dans
    /// `webcam-segmentation.md`.
    pub unsafe fn capture_webcam_rgb(
        &self,
        wy: &wgpu::TextureView,
        wu: &wgpu::TextureView,
        wv: &wgpu::TextureView,
        src: [f32; 4],
        width: u32,
        height: u32,
        out: &mut Vec<u8>,
    ) -> Result<()> {
        if width == 0 || height == 0 {
            anyhow::bail!("capture webcam de dimensions nulles ({width}x{height})");
        }
        {
            let mut slot = self.seg_capture.borrow_mut();
            if !matches!(slot.as_ref(), Some(c) if c.width == width && c.height == height) {
                let rt = self.gpu.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("seg-capture"),
                    size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    // Meme format que le RT : c'est celui que `mk_layer` a cable
                    // dans la cible couleur du pipeline de calque, et une passe
                    // dont la piece jointe ne l'a pas est refusee.
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::COPY_SRC,
                    view_formats: &[],
                });
                let view = rt.create_view(&wgpu::TextureViewDescriptor::default());
                let bpr = (width * 4).div_ceil(256) * 256;
                let staging = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("seg-capture-staging"),
                    size: u64::from(bpr) * u64::from(height),
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                });
                *slot = Some(SegCapture { rt, view, staging, width, height, bpr });
            }
        }
        let slot = self.seg_capture.borrow();
        let cap = slot.as_ref().expect("cree juste au-dessus");

        // Plein cadre de la cible, sans coins ni motion blur : le modele veut
        // l'image, pas la mise en forme. `fx` reste a zero — la branche de masque
        // du shader ne doit surtout pas se prendre sur la capture qui l'alimente.
        // `color.a = 1` n'est pas decoratif : `fs_main` calcule son alpha en
        // `layer.color.a * alpha_mask`, donc le defaut (0) rendrait un quad
        // entierement transparent.
        let (_uniform, bind) = self.make_bind(
            &LayerCB {
                dst: [0.0, 0.0, 1.0, 1.0],
                src,
                quad_px: [width as f32, height as f32],
                mode: 0.0,
                color: [0.0, 0.0, 0.0, 1.0],
                mb: [1.0, 1.0, 1.0, 0.0],
                ..Default::default()
            },
            Some((wy, wu, wv)),
            &self.dummy_view(),
        );

        let mut encoder = self.gpu.device.create_command_encoder(
            &wgpu::CommandEncoderDescriptor { label: Some("seg-capture") },
        );
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("seg-capture-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &cap.view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            rpass.set_pipeline(&self.pipeline);
            rpass.set_bind_group(0, &bind, &[]);
            rpass.draw(0..4, 0..1);
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &cap.rt,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &cap.staging,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(cap.bpr),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        let idx = self.gpu.context.submit(std::iter::once(encoder.finish()));
        let (tx, rx) = std::sync::mpsc::channel();
        cap.staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        // `WaitForSubmissionIndex` et JAMAIS `Maintain::Wait` : cf. l'en-tete de
        // `ReadbackRing`, qui est le proces-verbal de cette regression-la.
        self.gpu.device.poll(wgpu::Maintain::WaitForSubmissionIndex(idx));
        rx.recv()
            .map_err(|_| anyhow::anyhow!("map_async channel (capture webcam)"))?
            .map_err(|e| anyhow::anyhow!("map_async (capture webcam): {e:?}"))?;
        let slice = cap.staging.slice(..);
        let mapped = slice.get_mapped_range();

        let (w, h, bpr) = (width as usize, height as usize, cap.bpr as usize);
        // `clear` + `reserve` plutot qu'un `Vec` neuf : la capacite survit d'une
        // capture a l'autre, donc apres le premier tour plus une seule
        // reallocation. A 30 Hz ce n'est pas une coquetterie.
        out.clear();
        out.reserve(w * h * 3);
        for row in 0..h {
            // La ligne fait `w * 4` octets utiles dans un pas de `bpr` : le
            // padding d'alignement se saute ici, il n'a jamais de sens pour le
            // modele.
            for px in mapped[row * bpr..row * bpr + w * 4].chunks_exact(4) {
                // RGBA -> RGB : le modele n'a pas de canal alpha en entree.
                out.push(px[0]);
                out.push(px[1]);
                out.push(px[2]);
            }
        }
        drop(mapped);
        // Sans `unmap`, la capture suivante echouerait a re-armer `map_async` sur
        // un buffer deja mappe.
        cap.staging.unmap();
        Ok(())
    }

    /// Publie le masque de segmentation du sujet webcam (R8, `width`x`height`,
    /// 0 = fond).
    ///
    /// `Queue::write_texture` et non une copie par buffer : il n'impose aucun
    /// alignement de ligne (c'est `copy_texture_to_buffer` qui exige 256, cf.
    /// `SegCapture`), et c'est deja par lui que `linux_frames` televerse les plans
    /// NV12 avec les strides SIMD de swscale. La texture n'est recreee que si la
    /// resolution du modele change, ce qui n'arrive pas en regime etabli.
    ///
    /// Pas de double buffer, et pour la meme raison que cote Metal : quand
    /// `pump_segmentation` appelle ceci, la frame precedente est deja drainee —
    /// `capture_webcam_rgb` attend sa soumission, et la preview comme l'export
    /// passent par `readback_take`, qui attend la sienne. Si cet invariant
    /// changeait, c'est ce code-ci qui casserait.
    pub fn set_webcam_mask(&self, data: &[u8], width: u32, height: u32) -> Result<()> {
        if width == 0 || height == 0 {
            anyhow::bail!("masque webcam de dimensions nulles ({width}x{height})");
        }
        let expected = (width as usize) * (height as usize);
        if data.len() < expected {
            anyhow::bail!(
                "masque webcam trop court : {} octets pour {width}x{height}",
                data.len()
            );
        }

        let mut slot = self.webcam_mask.borrow_mut();
        if !matches!(slot.as_ref(), Some(m) if m.width == width && m.height == height) {
            let tex = self.gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("webcam-mask"),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
            *slot = Some(WebcamMask { tex, view, width, height });
        }
        let mask = slot.as_ref().expect("alloue juste au-dessus");
        self.gpu.context.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &mask.tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            // `data` peut etre plus long que le masque (le garde ci-dessus est un
            // minimum) : on ne televerse que ce que la texture porte.
            &data[..expected],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        Ok(())
    }

    /// Un tour de segmentation : televerse le masque pret, puis soumet une
    /// nouvelle frame si la cadence l'autorise. Port de
    /// `compositor_windows::pump_segmentation` — worker, boite aux lettres,
    /// limiteur de cadence et demarrage paresseux sont independants de la
    /// plateforme, seuls les deux appels GPU changent.
    ///
    /// Les deux moities sont volontairement desynchronisees. Le masque televerse
    /// ici vient de la frame precedente — une frame de retard sur une silhouette
    /// est invisible, alors qu'attendre l'inference bloquerait le rendu, ce qui
    /// est exactement le cout que toute cette conception cherche a ne pas payer.
    unsafe fn pump_segmentation(
        &self,
        wy: &wgpu::TextureView,
        wu: &wgpu::TextureView,
        wv: &wgpu::TextureView,
        valid: [f32; 2],
    ) -> Result<()> {
        if *self.seg_failed.borrow() {
            return Ok(());
        }
        // Rien a faire si aucun effet n'est demande : ni capture, ni inference,
        // ni masque. Le cout de la fonctionnalite est alors exactement nul.
        let (wants_effect, model_path) = {
            let scene = self.scene.borrow();
            match scene.as_ref().and_then(|s| s.webcam_effect.as_ref()) {
                Some(e) if e.shader_code() > 0.0 => (true, e.model_path.clone()),
                _ => (false, None),
            }
        };
        if !wants_effect {
            return Ok(());
        }

        // Demarrage paresseux, pilote par la scene : personne n'a a appeler
        // `enable_segmentation` a la main, et un modele introuvable eteint l'effet
        // au lieu de faire tomber le rendu.
        if self.seg_worker.borrow().is_none() && self.seg_sync.borrow().is_none() {
            let Some(path) = model_path else { return Ok(()) };
            if let Err(e) = self.enable_segmentation(std::path::Path::new(&path)) {
                eprintln!("[segmentation] desactivee : {e}");
                // Une scene qui reste identique retenterait a chaque frame ; on
                // leve le verrou plutot que de journaliser 60 fois par seconde.
                *self.seg_failed.borrow_mut() = true;
                return Ok(());
            }
            // En preview on rend cette frame sans masque : le worker vient de
            // demarrer et l'effet apparaitra dans quelques millisecondes, ce que
            // personne ne voit. A l'export cette frame part dans le fichier — on
            // enchaine donc sur la capture et l'inference plutot que de la laisser
            // sortir non detouree.
            if !self.seg_deterministic.get() {
                return Ok(());
            }
        }

        if let Some(mask) = self.seg_inbox.lock().unwrap().take() {
            self.set_webcam_mask(
                &mask,
                crate::segmentation::MODEL_WIDTH,
                crate::segmentation::MODEL_HEIGHT,
            )?;
        }

        // La cadence horloge est le bon reglage en preview et le mauvais a
        // l'export, ou les frames defilent aussi vite que la machine decode : le
        // nombre de frames couvertes par un masque dependrait alors de la charge.
        // En deterministe, une inference par frame.
        if !self.seg_deterministic.get()
            && !self.seg_rate.borrow_mut().should_run(std::time::Instant::now())
        {
            return Ok(());
        }
        let mut scratch = self.seg_scratch.borrow_mut();
        // La frame ENTIERE, pas le sous-rect dessine : un crop utilisateur serre
        // amputerait le sujet en entree du modele, et le masque serait faux la ou
        // il compte le plus. Le shader ramene ses coordonnees dans cet espace via
        // `fx.xy`.
        self.capture_webcam_rgb(
            wy,
            wu,
            wv,
            [0.0, 0.0, valid[0], valid[1]],
            crate::segmentation::MODEL_WIDTH,
            crate::segmentation::MODEL_HEIGHT,
            &mut scratch,
        )?;
        if self.seg_deterministic.get() {
            // Synchrone : le masque doit exister avant que cette frame ne soit
            // composee, sinon on retombe sur le defaut qu'on corrige. Une
            // inference ratee laisse le masque precedent, comme le fait le worker.
            let mut sync = self.seg_sync.borrow_mut();
            if let Some(seg) = sync.as_mut() {
                match seg.run(&scratch) {
                    Ok(mask) => {
                        // `run` rend une tranche empruntee au segmenteur : copier
                        // puis relacher, sinon `set_webcam_mask` reemprunterait
                        // `seg_sync` encore emprunte ici.
                        let mask = mask.to_vec();
                        drop(sync);
                        self.set_webcam_mask(
                            &mask,
                            crate::segmentation::MODEL_WIDTH,
                            crate::segmentation::MODEL_HEIGHT,
                        )?;
                    }
                    Err(e) => eprintln!("[segmentation] frame ignoree : {e}"),
                }
            }
        } else if let Some(w) = self.seg_worker.borrow().as_ref() {
            w.submit(&scratch);
        }
        Ok(())
    }

    /// Demarre la segmentation du sujet webcam pour ce compositeur.
    ///
    /// Idempotent. Tant qu'elle n'est pas appelee, `compose_frame` ne fait rien de
    /// plus et la webcam se dessine comme avant — c'est ce qui rend l'effet inerte
    /// plutot que casse sur une build sans modele.
    pub fn enable_segmentation(&self, model_path: &std::path::Path) -> Result<()> {
        if self.seg_worker.borrow().is_some() || self.seg_sync.borrow().is_some() {
            return Ok(());
        }
        let segmenter = crate::segmentation::Segmenter::load(model_path)?;
        // En deterministe, le segmenteur reste ici : l'inference tourne sur le
        // thread de rendu, donc le masque de la frame N est pret AVANT qu'elle ne
        // soit composee. Le worker est un choix de preview — ne jamais bloquer
        // l'affichage — et c'est exactement ce qui rend l'export irreproductible,
        // le masque arrivant quelques frames plus tard selon la charge.
        if self.seg_deterministic.get() {
            *self.seg_sync.borrow_mut() = Some(segmenter);
            return Ok(());
        }
        let inbox = std::sync::Arc::clone(&self.seg_inbox);
        let worker =
            crate::segmentation::SegmentationWorker::spawn(segmenter, move |mask, _, _| {
                // Ecrase le masque precedent s'il n'a pas encore ete televerse :
                // c'est le plus recent qui vaut, jamais une file.
                *inbox.lock().unwrap() = Some(mask.to_vec());
            });
        *self.seg_worker.borrow_mut() = Some(worker);
        Ok(())
    }

    /// Bascule la segmentation en mode reproductible, pour l'export.
    ///
    /// En preview, la cadence suit l'horloge (30 Hz reels) et l'inference tourne
    /// sur un worker : c'est le bon choix, l'affichage ne doit jamais attendre. A
    /// l'export les frames sont rendues aussi vite que la machine decode, sans
    /// rapport avec le temps reel — et ces deux choix deviennent alors des bugs.
    /// La cadence horloge fait dependre le nombre de frames couvertes par un
    /// masque de la vitesse de la machine, et le worker asynchrone rend les
    /// premieres frames AVANT que le premier masque n'existe : elles partent dans
    /// le fichier avec le vrai arriere-plan de la webcam. Deux exports du meme
    /// projet ne donnent donc pas les memes pixels, ce qui casse l'invariant
    /// « l'export est identique a la preview ».
    ///
    /// En deterministe : une inference PAR FRAME, synchrone. Plus couteux
    /// (~3 ms/frame), mais l'export est hors ligne et chaque frame porte le masque
    /// calcule depuis SA propre image.
    ///
    /// A appeler avant la premiere frame — c'est ce qui decide comment
    /// `enable_segmentation` s'installe.
    pub fn set_segmentation_deterministic(&self, on: bool) {
        if self.seg_deterministic.get() == on {
            return;
        }
        self.seg_deterministic.set(on);
        // Changer de mode change le MOTEUR, et `enable_segmentation` est idempotent sur la
        // PRESENCE d'un moteur : sans demonter celui qui ne correspond plus, le drapeau
        // mentirait. Un compositeur qui a deja servi en preview garderait son worker,
        // `seg_sync` resterait vide, et l'export entier ne ferait AUCUNE inference. Le
        // demarrage paresseux de `pump_segmentation` reinstalle le bon moteur a la frame
        // suivante.
        *self.seg_worker.borrow_mut() = None;
        *self.seg_sync.borrow_mut() = None;
        // Et le masque que le worker demonte avait peut-etre deja depose : il vient de l'autre
        // mode, il n'a rien a faire sur la premiere frame de celui-ci.
        *self.seg_inbox.lock().unwrap() = None;
    }

    /// Eteint l'effet : la webcam se redessine telle quelle a la frame suivante.
    pub fn clear_webcam_mask(&self) {
        *self.webcam_mask.borrow_mut() = None;
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
        self.begin_image_frame();
        if Self::pixel_buffer_of(screen).is_none() {
            return self.clear_rt();
        }
        let (sy, su, sv) = self.nv12_srvs(screen)?;
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
        // Etendue valide de la texture webcam : les decodeurs allouent des
        // textures alignees (`linux_frames` arrondit deja aux dimensions paires),
        // donc la frame n'occupe pas forcement toute la texture. `.max(1)` au
        // denominateur — `tex_dims` rend (1, 1) sur une webcam absente, la ou le
        // chemin Windows divise sans garde parce qu'il a toujours les deux frames.
        let w_valid = [wcw / (wtw.max(1)) as f32, wch / (wth.max(1)) as f32];

        // Segmentation, AVANT le moindre encodeur de composition :
        // `capture_webcam_rgb` attend sa propre soumission, et attendre au milieu
        // de la frame serialiserait CPU et GPU. Dernier point ou `wtw/wth/wcw/wch`
        // sont en portee sans emprunt de `self.scene` — `pump_segmentation`
        // emprunte la scene lui-meme.
        //
        // L'effet est teste ICI en plus de l'etre dans `pump_segmentation` : sur
        // ce backend `nv12_srvs` ALLOUE deux `TextureView` a chaque appel (il n'y
        // a pas de cache, cf. `clear_srv_cache`), et la fonctionnalite doit couter
        // exactement zero quand elle est eteinte — ce qui est le cas general.
        let wants_seg = self
            .scene
            .borrow()
            .as_ref()
            .and_then(|s| s.webcam_effect.as_ref())
            .is_some_and(|e| e.shader_code() > 0.0);
        if wants_seg && !webcam.is_null() {
            // `nv12_srvs` dereference `data[0]` sans verifier la frame elle-meme,
            // d'ou le garde de nullite au-dessus (meme condition que le draw PiP).
            if let Ok((wy, wu, wv)) = self.nv12_srvs(webcam) {
                self.pump_segmentation(&wy, &wu, &wv, w_valid)?;
            }
        }

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
            self.make_bind(&screen_layer, Some((&sy, &su, &sv)), &dummy);

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
        let bg_draw = bg_layer.and_then(|bl| match bl {
            BgLayer::Gradient(cb) => {
                let (buf, bind) = self.make_bind(&cb, None, &dummy);
                Some(BgDraw { _buf: buf, _tex: None, _view: None, bind })
            }
            // Le wallpaper couvre tout le cadre, donc dst plein et pas de coins :
            // `image_bg_draw` sert aussi la bulle webcam, qui elle en a.
            BgLayer::Image(path) => {
                match self
                    .image_bg_draw(&path, [0.0, 0.0, 1.0, 1.0], [0.0, 0.0], 0.0, rw / rh, &dummy)
                {
                    Ok(d) => Some(d),
                    Err(e) => {
                        eprintln!("[fond image] \"{path}\" : {e:#}");
                        None
                    }
                }
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
        // Effet d'arriere-plan : le mode vient de la scene, le masque par pixel de
        // l'inference. Les DEUX sont requis — un mode sans masque rendrait la
        // webcam invisible en detourage, donc tant que rien n'a ete segmente on
        // dessine la piste telle quelle. C'est aussi ce qui rend le premier
        // lancement gracieux, le temps que l'inference rende son premier masque.
        //
        // Calcule ICI, avant le draw comme avant l'ombre : les deux en dependent.
        let (effect_code, blur_intensity, webcam_bg) = {
            let has_mask = self.webcam_mask.borrow().is_some();
            let effect = scene_ref
                .as_ref()
                .and_then(|s| s.webcam_effect.as_ref())
                .filter(|_| has_mask)
                .map(|e| (e.shader_code(), e))
                .filter(|(code, _)| *code > 0.0);
            match effect {
                // Fond personnalise : on PEINT le fond dans la bulle, puis on y
                // decoupe la camera par-dessus — le melange alpha donne
                // `lerp(fond, camera, personne)`, soit exactement ce que la branche
                // « mode 3 » du shader calculait, mais pour les TROIS sortes de
                // fond. Le shader ne sait peindre qu'une couleur plate sous le
                // masque ; degrades et images y tombaient sur du noir, et le defaut
                // EST une image.
                Some((code, e)) if code > 2.5 => {
                    // Sans piste webcam le fond peindrait un rectangle seul dans le
                    // cadre : il ne se prepare que si la camera se dessine.
                    let bg = webcam_planes.is_some().then(|| {
                        self.webcam_bg_draw(
                            e.background.as_ref(),
                            g.w_dst,
                            g.w_px,
                            g.w_radius,
                            &dummy,
                        )
                    });
                    (1.0, 0.0, bg)
                }
                Some((code, e)) => (code, e.blur_intensity.clamp(0.0, 1.0), None),
                None => (0.0, 0.0, None),
            }
        };
        // L'ombre se juge sur le mode DE LA SCENE, pas sur `effect_code` : le fond
        // personnalise se compose desormais en detourage (code 1) tout en gardant
        // sa bulle, et tester le code compose la lui retirerait. Meme lecture que
        // `is_cutout` cote Windows.
        let is_cutout = matches!(
            scene_ref.as_ref().and_then(|s| s.webcam_effect.as_ref()),
            Some(e) if e.shader_code() == 1.0
        ) && self.webcam_mask.borrow().is_some();
        let webcam_draw = webcam_planes.as_ref().map(|(wy, wu, wv)| {
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
                // `color.a` porte l'alpha du decoupage (`color.a * personne`) ; le
                // RGB n'est plus lu, le fond ayant deja ete peint sous la camera.
                color: [0.0, 0.0, 0.0, 1.0],
                // `fx.xy` = etendue valide de la texture webcam, par quoi le
                // shader divise `uv` pour retomber dans l'espace du masque ;
                // `fx.z` = mode, `fx.w` = intensite du flou. Contrat commun aux
                // trois back-ends, cf. `layer.wgsl` et `webcam-segmentation.md`.
                fx: [w_valid[0], w_valid[1], effect_code, blur_intensity],
                src_prev: [u0, cv0, u1, cv1],
                dst_prev: g.w_dst_prev,
                mb: [g.mb_taps, 1.0, 1.0, 0.0],
                ..Default::default()
            };
            // Le masque est lie par `make_bind` sur tous les draws, pas seulement
            // celui-ci : le layout l'exige (cf. `tex_entry(4)`).
            self.make_bind(&cb, Some((wy, wu, wv)), &dummy)
        });

        // OMBRE de la camera. Pas dans les presets « bloc » (dual-frame,
        // vertical-stack) : la camera y est collee a l'ecran comme une tuile,
        // et une ombre entre les deux dessinerait une couture. Meme condition
        // que macOS.
        //
        // Pas en detourage non plus : l'ombre appartient a la bulle PiP, et en
        // detourage il n'y a plus de bulle — une ombre portee par un rectangle
        // devenu invisible se lit comme un artefact.
        let webcam_shadow = (cfg.shadow
            && g.shape_fade > 0.0
            && webcam_draw.is_some()
            && !is_cutout
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
                            Some((&self.ann_copy_view, &self.ann_copy_view, &self.ann_copy_view)),
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
                        let (buf, bind) = self.make_bind(&cb, Some((&view, &view, &view)), &dummy);
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
                            self.make_bind(&cb, Some((&glyphs.view, &glyphs.view, &glyphs.view)), &dummy);
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
            // Charge (ou recupere du cache) le sprite.
            let (tex, iw, ih) = match self.cached_image(&sprite.path) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[curseur] sprite \"{}\" : {e:#}", sprite.path);
                    return None;
                }
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
                let (buf, bind) = self.make_bind(&cb, Some((&view, &view, &view)), &dummy);
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
            // Fond personnalise : ENTRE l'ombre et la camera. C'est ce sandwich qui
            // remplace la branche « mode 3 » du shader — la camera, decoupee, se
            // fond dessus par alpha ; l'ombre reste dessous, elle appartient a la
            // bulle et non a son contenu.
            if let Some(bg) = &webcam_bg {
                rpass.set_bind_group(0, &bg.bind, &[]);
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

    /// Construit (ou reconstruit apres resize) les cibles et pipelines YUV.
    fn ensure_yuv(&self) -> Result<()> {
        // I420 par defaut : c'est le seul format que l'encodeur software sait
        // lire, donc le seul que l'export utilise aujourd'hui.
        self.ensure_yuv_fmt(YuvFormat::I420)
    }

    /// La disposition du buffer de staging pour un format donne, sans rien
    /// construire. Existe pour que le test puisse verifier l'arithmetique sans
    /// GPU — c'est elle qui doit correspondre a ce que VAAPI attend, et une
    /// erreur d'un octet y donnerait une image decalee plutot qu'une panne.
    pub fn yuv_layout_for(w: u32, h: u32, fmt: YuvFormat) -> (u32, u32, u64, u64) {
        let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
        let bpr_y = w.div_ceil(256) * 256;
        let chroma_row_bytes = match fmt {
            YuvFormat::I420 => cw,
            YuvFormat::Nv12 => cw * 2,
        };
        let bpr_uv = chroma_row_bytes.div_ceil(256) * 256;
        let size_y = u64::from(bpr_y) * u64::from(h);
        let size_uv = u64::from(bpr_uv) * u64::from(ch);
        let total = match fmt {
            YuvFormat::I420 => size_y + 2 * size_uv,
            YuvFormat::Nv12 => size_y + size_uv,
        };
        (bpr_y, bpr_uv, size_y, total)
    }

    /// Comme `ensure_yuv`, pour un format donne. Reconstruit tout si le format
    /// change : les cibles, les pipelines et la disposition du buffer en
    /// dependent toutes.
    fn ensure_yuv_fmt(&self, fmt: YuvFormat) -> Result<()> {
        let (w, h) = (self.render_w, self.render_h);
        if let Some(t) = self.yuv.borrow().as_ref() {
            if t.w == w && t.h == h && t.fmt == fmt {
                return Ok(());
            }
        }
        // 4:2:0 : les plans de chrominance font la moitie, arrondie au superieur
        // pour ne jamais perdre la derniere colonne/ligne d'une dimension impaire.
        let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
        let gpu = &self.gpu;

        let mk = |label: &str, tw: u32, th: u32, f: wgpu::TextureFormat| {
            gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: tw, height: th, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: f,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            })
        };
        let r8 = wgpu::TextureFormat::R8Unorm;
        let y = mk("yuv-y", w, h, r8);
        let y_view = y.create_view(&wgpu::TextureViewDescriptor::default());

        let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("yuv"),
            source: wgpu::ShaderSource::Wgsl(include_str!("vk_shaders/yuv.wgsl").into()),
        });
        let bgl = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("yuv-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        // Sampler LINEAIRE : c'est lui qui fait le sous-echantillonnage 2x2 des
        // plans de chrominance. Avec un `Nearest` on prendrait un pixel sur
        // quatre au lieu de leur moyenne, ce qui aliase visiblement les bords.
        let samp = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("yuv-samp"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("yuv-bg"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&self.rt_view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&samp) },
            ],
        });
        let layout = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("yuv-pl"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });
        let mk_pipe = |entry: &str, label: &str, target: wgpu::TextureFormat| {
            gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vs_fullscreen"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some(entry),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: target,
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

        let bpr_y = w.div_ceil(256) * 256;
        // La LARGEUR EN OCTETS d'une ligne de chrominance, pas en texels : en NV12
        // le plan est `Rg8Unorm`, donc 2 octets par texel. En 1080p, I420 donne
        // 960 -> 1024 et NV12 1920 -> 2048.
        let chroma_row_bytes = match fmt {
            YuvFormat::I420 => cw,
            YuvFormat::Nv12 => cw * 2,
        };
        let bpr_uv = chroma_row_bytes.div_ceil(256) * 256;
        let size_y = u64::from(bpr_y) * u64::from(h);
        let size_uv = u64::from(bpr_uv) * u64::from(ch);
        let (chroma, off_v, total) = match fmt {
            YuvFormat::I420 => {
                let u = mk("yuv-u", cw, ch, r8);
                let v = mk("yuv-v", cw, ch, r8);
                let d = wgpu::TextureViewDescriptor::default();
                let (u_view, v_view) = (u.create_view(&d), v.create_view(&d));
                (
                    Chroma::Planar {
                        _u: u,
                        _v: v,
                        u_view,
                        v_view,
                        pipe_u: mk_pipe("fs_u", "yuv-u", r8),
                        pipe_v: mk_pipe("fs_v", "yuv-v", r8),
                    },
                    size_y + size_uv,
                    size_y + 2 * size_uv,
                )
            }
            YuvFormat::Nv12 => {
                let rg8 = wgpu::TextureFormat::Rg8Unorm;
                let uv = mk("yuv-uv", cw, ch, rg8);
                let uv_view = uv.create_view(&wgpu::TextureViewDescriptor::default());
                (
                    Chroma::Interleaved {
                        _uv: uv,
                        uv_view,
                        pipe_uv: mk_pipe("fs_uv", "yuv-uv", rg8),
                    },
                    // Un seul plan de chrominance : `off_v` duplique `off_u` et
                    // n'est jamais lu (cf. le commentaire du champ).
                    size_y,
                    size_y + size_uv,
                )
            }
        };
        let targets = YuvTargets {
            _y: y,
            y_view,
            chroma,
            fmt,
            bind,
            pipe_y: mk_pipe("fs_y", "yuv-y", r8),
            w,
            h,
            bpr_y,
            bpr_uv,
            off_u: size_y,
            off_v,
            total,
        };
        // Les buffers de l'ancienne taille ne conviennent plus.
        self.readback_yuv.borrow_mut().free.clear();
        *self.yuv.borrow_mut() = Some(targets);
        Ok(())
    }

    /// Pendant YUV de `readback_submit` : convertit le RT en Y/U/V sur le GPU,
    /// copie les trois plans dans UN buffer de staging, et recolte la frame
    /// precedente. Meme contrat de ring et de profondeur que la version RGBA.
    ///
    /// Rend les plans avec leur padding : `(w, h, buf)` ou `buf` contient Y a
    /// l'offset 0 (stride `align256(w)`), puis U et V (stride `align256(w/2)`).
    /// L'appelant recalcule ces strides depuis `w`/`h` — les depadder ici
    /// couterait une recopie de plus pour rien, l'encodeur sachant lire un
    /// `linesize`.
    pub unsafe fn readback_submit_yuv<F>(&self, f: F) -> Result<bool>
    where
        F: FnMut(u32, u32, &[u8]) -> Result<()>,
    {
        self.ensure_yuv()?;
        let (w, h, cw, ch, bpr_y, bpr_uv, off_u, off_v, total) = {
            let g = self.yuv.borrow();
            let t = g.as_ref().expect("ensure_yuv");
            (t.w, t.h, t.w.div_ceil(2), t.h.div_ceil(2), t.bpr_y, t.bpr_uv, t.off_u, t.off_v, t.total)
        };

        let buf = {
            let mut ring = self.readback_yuv.borrow_mut();
            match ring.free.pop() {
                Some(b) => b,
                None => self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("readback-yuv"),
                    size: total,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                }),
            }
        };

        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("yuv-convert") });
        {
            let g = self.yuv.borrow();
            let t = g.as_ref().expect("ensure_yuv");
            // Une passe par plan : Y toujours, puis U et V separement (I420) ou
            // un seul plan entrelace (NV12).
            let mut passes: Vec<(&wgpu::TextureView, &wgpu::RenderPipeline)> =
                vec![(&t.y_view, &t.pipe_y)];
            match &t.chroma {
                Chroma::Planar { u_view, v_view, pipe_u, pipe_v, .. } => {
                    passes.push((u_view, pipe_u));
                    passes.push((v_view, pipe_v));
                }
                Chroma::Interleaved { uv_view, pipe_uv, .. } => passes.push((uv_view, pipe_uv)),
            }
            for (view, pipe) in passes {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("yuv-plane"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            // Chaque passe reecrit chaque texel : `Load` ferait lire
                            // une cible dont on va ecraser le contenu.
                            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                pass.set_pipeline(pipe);
                pass.set_bind_group(0, &t.bind, &[]);
                pass.draw(0..3, 0..1);
            }
            // `pw` est en TEXELS (`copy_texture_to_buffer` veut une extent), et
            // `bpr` en octets : en NV12 le plan de chrominance fait `cw` texels de
            // 2 octets, d'ou le meme `cw` avec un `bpr_uv` deux fois plus grand.
            let mut copies: Vec<(&wgpu::Texture, u64, u32, u32, u32)> =
                vec![(&t._y, 0u64, bpr_y, w, h)];
            match &t.chroma {
                Chroma::Planar { _u, _v, .. } => {
                    copies.push((_u, off_u, bpr_uv, cw, ch));
                    copies.push((_v, off_v, bpr_uv, cw, ch));
                }
                Chroma::Interleaved { _uv, .. } => copies.push((_uv, off_u, bpr_uv, cw, ch)),
            }
            for (tex, off, bpr, pw, ph) in copies {
                encoder.copy_texture_to_buffer(
                    wgpu::TexelCopyTextureInfo {
                        texture: tex,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::TexelCopyBufferInfo {
                        buffer: &buf,
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: off,
                            bytes_per_row: Some(bpr),
                            rows_per_image: Some(ph),
                        },
                    },
                    wgpu::Extent3d { width: pw, height: ph, depth_or_array_layers: 1 },
                );
            }
        }

        let idx = self.gpu.context.submit(std::iter::once(encoder.finish()));
        let (tx, rx) = std::sync::mpsc::channel();
        buf.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        {
            let mut ring = self.readback_yuv.borrow_mut();
            ring.pending.push_back(PendingCopy { buf, idx, rx, w, h, bpr: bpr_y });
            if ring.pending.len() < ring.depth {
                return Ok(false); // amorcage, comme la ring RGBA
            }
        }
        self.readback_take_yuv_with(f)
    }

    /// Recolte la plus ancienne conversion en vol et la PRESENTE au lecteur sans
    /// la copier : `f` recoit la vue mappee telle quelle, lignes paddees a 256
    /// comprises. Rend `false` si la ring est vide. Pendant de `readback_take`.
    ///
    /// POURQUOI UNE CLOSURE, ET PAS UN `Vec` RENDU. La version precedente faisait
    /// `mapped.to_vec()` — 3,3 Mo alloues, copies puis liberes par frame, soit
    /// 11,9 Go de va-et-vient sur un export de 3600 frames — dans le seul but que
    /// la donnee survive a l'`unmap`. Or l'appelant la recopie immediatement dans
    /// l'AVFrame de l'encodeur : la copie intermediaire ne servait que la
    /// signature. Avec une closure, le lecteur travaille dans la fenetre ou le
    /// buffer est mappe et il n'y a plus qu'une seule copie sur le chemin.
    ///
    /// LE SLOT EST RENDU MEME SI `f` ECHOUE. Autrement une erreur d'encodage
    /// laisserait le buffer mappe et hors de la ring : la frame suivante en
    /// allouerait un neuf, et ainsi de suite jusqu'a epuisement de la memoire
    /// mappable — un mode de panne bien pire que l'erreur d'origine.
    pub unsafe fn readback_take_yuv_with<F>(&self, mut f: F) -> Result<bool>
    where
        F: FnMut(u32, u32, &[u8]) -> Result<()>,
    {
        let Some(p) = self.readback_yuv.borrow_mut().pending.pop_front() else {
            return Ok(false);
        };
        self.gpu.device.poll(wgpu::Maintain::WaitForSubmissionIndex(p.idx));
        p.rx
            .recv()
            .map_err(|_| anyhow::anyhow!("map_async channel (yuv)"))?
            .map_err(|e| anyhow::anyhow!("map_async yuv: {e:?}"))?;
        // `mapped` et `slice` meurent a la fin du bloc : `unmap` ne peut donc pas
        // etre appele pendant qu'une vue est encore accessible (wgpu l'assert).
        let r = {
            let slice = p.buf.slice(..);
            let mapped = slice.get_mapped_range();
            f(p.w, p.h, &mapped)
        };
        p.buf.unmap();
        self.readback_yuv.borrow_mut().free.push(p.buf);
        r.map(|()| true)
    }

    /// Profondeur de la ring YUV. Meme role et memes raisons que
    /// `set_readback_depth` pour la ring RGBA.
    pub fn set_readback_yuv_depth(&self, depth: usize) -> Result<()> {
        let depth = depth.max(1);
        // SAFETY : meme contrat que `set_readback_depth` — le drain ne touche que
        // des buffers dont la soumission est terminee.
        while unsafe { self.readback_take_yuv_with(|_, _, _| Ok(()))? } {}
        let mut ring = self.readback_yuv.borrow_mut();
        ring.depth = depth;
        while ring.free.len() > depth {
            ring.free.pop();
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

// ---------------------------------------------------------------------------
// Tests
//
// Tous rendent de VRAIS pixels sur le device de la machine, et tous sauf un se
// lisent SANS ONNX Runtime : le masque y est pose a la main par
// `set_webcam_mask` et l'inference n'est pas ce qu'ils testent. C'est delibere —
// ce que ce portage ajoute cote GPU doit etre verifiable la ou la bibliotheque
// n'est pas installee, ce qui est le cas de la CI. Meme parti que
// `compositor_macos::tests`, dont ceci est le pendant.
//
// `poc-d3d` etant `cfg(windows)`, le banc `--cfg C8 --scene` qui a prouve le
// chemin Windows n'existe pas ici : ces tests en tiennent lieu, plus le harnais
// visuel opt-in en fin de fichier pour ce qu'une assertion ne peut pas dire.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::d3d::Gpu;
    use crate::ffi::AVFrame;

    /// NV12 « limited range » (BT.709), les memes valeurs que `yuv709_limited`
    /// inverse : 16 rend du noir franc, 235 du blanc franc, 128 une chroma nulle.
    const Y_WHITE: u8 = 235;
    const Y_BLACK: u8 = 16;
    const UV_NEUTRAL: u8 = 128;

    /// `create_auto` et NON `create` : la CI (`rust-linux-compositor-check`,
    /// ubuntu-latest) n'a pas de GPU et rend sur lavapipe. Avec la creation
    /// hardware-stricte, tous ces tests s'y sauteraient en silence — c'est-a-dire
    /// que le seul endroit ou ils tournent automatiquement ne les executerait pas.
    fn gpu() -> Option<Gpu> {
        match Gpu::create_auto(false) {
            Ok(g) => Some(g),
            Err(e) => {
                eprintln!("pas d'adaptateur Vulkan ({e:#}) — test saute");
                None
            }
        }
    }

    /// Deux `TextureView` NV12-split, comme `linux_frames::nv12_planes` en rend.
    ///
    /// Les textures ne sont pas retournees : en wgpu une `TextureView` garde la
    /// sienne en vie (c'est deja ce dont depend la pyramide de blur du
    /// compositeur, qui n'existe que sous forme de vues).
    fn nv12_views(
        gpu: &Gpu,
        w: u32,
        h: u32,
        luma: impl Fn(u32, u32) -> u8,
    ) -> (wgpu::TextureView, wgpu::TextureView, wgpu::TextureView) {
        let mut y = vec![0u8; (w * h) as usize];
        for row in 0..h {
            for col in 0..w {
                y[(row * w + col) as usize] = luma(col, row);
            }
        }
        let (ytex, utex, vtex) =
            nv12_textures(gpu, w, h, &y, &vec![UV_NEUTRAL; (w * (h / 2)) as usize]);
        let d = wgpu::TextureViewDescriptor::default();
        (ytex.create_view(&d), utex.create_view(&d), vtex.create_view(&d))
    }

    /// Le couple de textures NV12-split (Y `R8Unorm`, UV entrelacee `Rg8Unorm`)
    /// exactement comme `linux_frames::CpuFrames::ensure_textures` les alloue.
    fn nv12_textures(
        gpu: &Gpu,
        w: u32,
        h: u32,
        y: &[u8],
        uv: &[u8],
    ) -> (wgpu::Texture, wgpu::Texture, wgpu::Texture) {
        let mk = |label: &str, format, tw: u32, th: u32| {
            gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: tw, height: th, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        };
        let ytex = mk("test-nv12-y", wgpu::TextureFormat::R8Unorm, w, h);
        // Les helpers de test parlent encore NV12 entrelace parce que c'est la
        // forme lisible pour ecrire un cas ; le carrier, lui, veut deux plans.
        // On desentrelace ici plutot que de reecrire chaque test.
        let utex = mk("test-yuv-u", wgpu::TextureFormat::R8Unorm, w / 2, h / 2);
        let vtex = mk("test-yuv-v", wgpu::TextureFormat::R8Unorm, w / 2, h / 2);
        let u_plane: Vec<u8> = uv.iter().step_by(2).copied().collect();
        let v_plane: Vec<u8> = uv.iter().skip(1).step_by(2).copied().collect();
        let write = |tex: &wgpu::Texture, data: &[u8], bpr: u32, tw: u32, th: u32| {
            gpu.context.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bpr),
                    rows_per_image: Some(th),
                },
                wgpu::Extent3d { width: tw, height: th, depth_or_array_layers: 1 },
            );
        };
        write(&ytex, y, w, w, h);
        write(&utex, &u_plane, w / 2, w / 2, h / 2);
        write(&vtex, &v_plane, w / 2, w / 2, h / 2);
        (ytex, utex, vtex)
    }

    /// Masque 0 sur la moitie gauche, 255 sur la droite. La frontiere tombe pile
    /// au milieu, donc un echantillon pris au quart et un aux trois quarts sont
    /// loin du degrade que le filtrage lineaire pose sur la couture.
    fn half_mask(w: u32, h: u32) -> Vec<u8> {
        (0..w * h).map(|i| if i % w < w / 2 { 0u8 } else { 255u8 }).collect()
    }

    /// Le buffer de staging exportable doit etre une VRAIE zone partagee : ce que
    /// wgpu y ecrit, notre propre mapping doit le relire a l'identique.
    ///
    /// C'est le seul point reellement incertain de l'export dmabuf, et il se
    /// verifie sans encodeur. Si ce test passe, la memoire qu'on remettra a VAAPI
    /// est bien celle que le compositeur remplit ; s'il echoue, tout ce qui est
    /// bati dessus produirait une image fausse plutot qu'une panne.
    #[test]
    fn exportable_staging_round_trips_through_wgpu() {
        let Some(gpu) = gpu() else { return };
        let comp = Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        const N: u64 = 4096;
        let Some(st) = comp.create_exportable_staging(N) else {
            eprintln!("pas d'extensions de memoire externe — test saute");
            return;
        };
        assert!(st.fd >= 0, "descripteur dmabuf invalide");
        assert_eq!(st.size, N);

        // Un motif non trivial : un remplissage constant passerait meme si les
        // deux cotes regardaient deux zones differentes mais nulles.
        let pattern: Vec<u8> = (0..N as usize).map(|i| (i * 31 + 7) as u8).collect();
        gpu.context.write_buffer(st.buffer(), 0, &pattern);
        gpu.context.submit(std::iter::empty());
        gpu.device.poll(wgpu::Maintain::Wait);

        let got = st.read_back().expect("read_back");
        assert_eq!(got.len(), N as usize);
        assert_eq!(got, pattern, "la memoire exportee ne porte pas ce que wgpu y a ecrit");
    }

    /// La disposition NV12 doit etre EXACTEMENT celle que le pilote produit pour
    /// une image NV12 lineaire, parce que c'est elle qu'on decrira a VAAPI dans
    /// un `AVDRMFrameDescriptor`. Les valeurs ci-dessous ne sont pas devinees :
    /// elles ont ete relevees sur ce materiel via `vkGetImageSubresourceLayout`
    /// d'une `VkImage` NV12 en `DRM_FORMAT_MOD_LINEAR` (Y pitch 2048, UV a
    /// l'offset 2211840, pitch 2048, total 3317760). Un ecart d'un octet ici
    /// donnerait une image decalee et non une panne, d'ou le test.
    #[test]
    fn nv12_layout_matches_what_the_driver_produces() {
        let (bpr_y, bpr_uv, off_uv, total) =
            Compositor::yuv_layout_for(1920, 1080, YuvFormat::Nv12);
        assert_eq!(bpr_y, 2048, "pitch du plan Y");
        assert_eq!(bpr_uv, 2048, "pitch du plan UV entrelace (960 texels x 2 octets)");
        assert_eq!(off_uv, 2_211_840, "offset du plan UV");
        assert_eq!(total, 3_317_760, "taille totale");
    }

    /// I420 reste ce qu'il etait : c'est le format que l'encodeur software lit,
    /// et ce test est ce qui garantit qu'ajouter NV12 ne l'a pas deplace.
    #[test]
    fn i420_layout_is_unchanged() {
        let (bpr_y, bpr_uv, off_u, total) =
            Compositor::yuv_layout_for(1920, 1080, YuvFormat::I420);
        assert_eq!((bpr_y, bpr_uv), (2048, 1024));
        assert_eq!(off_u, 2_211_840);
        assert_eq!(total, 2_211_840 + 2 * 1024 * 540);
    }

    /// Dessine UN calque plein cadre sur le RT, par-dessus `clear`, et rend le
    /// RGBA relu.
    ///
    /// Court-circuite `compose_frame` a dessein : ces tests-ci isolent le shader
    /// et la liaison du masque, pas la geometrie que `plan_frame` decide.
    fn draw_one_layer(
        comp: &Compositor,
        clear: wgpu::Color,
        cb: &LayerCB,
        planes: (&wgpu::TextureView, &wgpu::TextureView, &wgpu::TextureView),
    ) -> (u32, u32, Vec<u8>) {
        let dummy = comp.dummy_view();
        let (_buf, bind) = comp.make_bind(cb, Some(planes), &dummy);
        let mut encoder = comp.gpu.device.create_command_encoder(
            &wgpu::CommandEncoderDescriptor { label: Some("test-layer") },
        );
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("test-layer-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &comp.rt_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(clear),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            rpass.set_pipeline(&comp.pipeline);
            rpass.set_bind_group(0, &bind, &[]);
            rpass.draw(0..4, 0..1);
        }
        comp.gpu.context.submit(std::iter::once(encoder.finish()));
        unsafe { comp.readback_direct().expect("readback_direct") }
    }

    // -----------------------------------------------------------------------
    // La capture
    // -----------------------------------------------------------------------

    #[test]
    fn the_webcam_capture_comes_back_as_interleaved_rgb_at_model_resolution() {
        let Some(gpu) = gpu() else { return };
        let comp = Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        // Moitie gauche noire, moitie droite blanche : la capture doit rendre les
        // deux dans le bon sens. Une inversion d'axe passerait un test de taille
        // sans se voir.
        let (y, u, v) = nv12_views(&gpu, 64, 64, |col, _| if col < 32 { Y_BLACK } else { Y_WHITE });

        let mut out = Vec::new();
        unsafe {
            comp.capture_webcam_rgb(
                &y,
                &u,
                &v,
                [0.0, 0.0, 1.0, 1.0],
                crate::segmentation::MODEL_WIDTH,
                crate::segmentation::MODEL_HEIGHT,
                &mut out,
            )
            .expect("capture_webcam_rgb");
        }

        let (w, h) = (
            crate::segmentation::MODEL_WIDTH as usize,
            crate::segmentation::MODEL_HEIGHT as usize,
        );
        assert_eq!(out.len(), w * h * 3, "le modele veut du RGB8 entrelace, sans alpha");

        let px = |buf: &[u8], col: usize, row: usize| -> [u8; 3] {
            let i = (row * w + col) * 3;
            [buf[i], buf[i + 1], buf[i + 2]]
        };
        let left = px(&out, w / 4, h / 2);
        let right = px(&out, 3 * w / 4, h / 2);
        assert!(left.iter().all(|&c| c < 24), "moitie gauche pas noire : {left:?}");
        assert!(right.iter().all(|&c| c > 231), "moitie droite pas blanche : {right:?}");

        // Deuxieme capture sur le meme buffer : c'est le regime etabli (30 fois
        // par seconde), et il ne doit ni reallouer ni trainer les octets du tour
        // precedent.
        let capacity = out.capacity();
        unsafe {
            comp.capture_webcam_rgb(
                &y,
                &u,
                &v,
                [0.0, 0.0, 1.0, 1.0],
                crate::segmentation::MODEL_WIDTH,
                crate::segmentation::MODEL_HEIGHT,
                &mut out,
            )
            .expect("deuxieme capture");
        }
        assert_eq!(out.len(), w * h * 3);
        assert_eq!(out.capacity(), capacity, "le scratch se realloue d'une frame a l'autre");
        assert_eq!(px(&out, w / 4, h / 2), left);
        assert_eq!(px(&out, 3 * w / 4, h / 2), right);
    }

    /// Le piege PROPRE a ce backend : `copy_texture_to_buffer` exige un
    /// `bytes_per_row` multiple de 256, et le depadder est a la charge de
    /// l'appelant. A la resolution livree (256 px, 1024 octets) le padding est nul
    /// — donc la resolution livree n'exerce JAMAIS ce chemin. Il faut une largeur
    /// qui le fasse : 100 px = 400 octets utiles dans un pas de 512.
    ///
    /// Un depad rate ne rend pas du bruit, il rend un CISAILLEMENT : chaque ligne
    /// glisse de 28 px sur la precedente. D'ou l'echantillonnage sur plusieurs
    /// lignes plutot que sur une seule.
    #[test]
    fn a_capture_whose_rows_need_padding_is_depadded_correctly() {
        let Some(gpu) = gpu() else { return };
        let comp = Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        let (y, u, v) = nv12_views(&gpu, 64, 64, |col, _| if col < 32 { Y_BLACK } else { Y_WHITE });

        let (w, h) = (100usize, 56usize);
        assert_ne!((w * 4) % 256, 0, "cette largeur doit justement ETRE mal alignee");
        let mut out = Vec::new();
        unsafe {
            comp.capture_webcam_rgb(&y, &u, &v, [0.0, 0.0, 1.0, 1.0], w as u32, h as u32, &mut out)
                .expect("capture_webcam_rgb");
        }
        assert_eq!(out.len(), w * h * 3, "le padding d'alignement a fuit dans la sortie");

        let px = |col: usize, row: usize| -> [u8; 3] {
            let i = (row * w + col) * 3;
            [out[i], out[i + 1], out[i + 2]]
        };
        for row in [0usize, h / 3, h / 2, h - 1] {
            let left = px(w / 4, row);
            let right = px(3 * w / 4, row);
            assert!(left.iter().all(|&c| c < 24), "ligne {row}, gauche pas noire : {left:?}");
            assert!(right.iter().all(|&c| c > 231), "ligne {row}, droite pas blanche : {right:?}");
        }
    }

    #[test]
    fn a_capture_of_zero_size_is_refused_rather_than_rendered() {
        let Some(gpu) = gpu() else { return };
        let comp = Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        let (y, u, v) = nv12_views(&gpu, 16, 16, |_, _| Y_WHITE);
        let mut out = Vec::new();
        let r = unsafe { comp.capture_webcam_rgb(&y, &u, &v, [0.0, 0.0, 1.0, 1.0], 0, 144, &mut out) };
        assert!(r.is_err(), "une cible de largeur nulle doit etre refusee");
    }

    // -----------------------------------------------------------------------
    // Le masque
    // -----------------------------------------------------------------------

    #[test]
    fn the_mask_texture_is_allocated_once_and_a_short_buffer_is_refused() {
        let Some(gpu) = gpu() else { return };
        let comp = Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        let (w, h) = (crate::segmentation::MODEL_WIDTH, crate::segmentation::MODEL_HEIGHT);
        let mask = vec![255u8; (w * h) as usize];

        comp.set_webcam_mask(&mask, w, h).expect("premier televersement");
        let first = comp.webcam_mask.borrow().as_ref().map(|m| m.tex.clone());
        comp.set_webcam_mask(&mask, w, h).expect("deuxieme televersement");
        let second = comp.webcam_mask.borrow().as_ref().map(|m| m.tex.clone());
        assert_eq!(
            first, second,
            "la texture est recreee a chaque frame alors que la resolution du modele est fixe"
        );

        // Un masque trop court doit etre refuse, pas lu hors bornes.
        assert!(comp.set_webcam_mask(&mask[..(w * h) as usize - 1], w, h).is_err());
        assert!(comp.set_webcam_mask(&mask, 0, h).is_err());
        comp.clear_webcam_mask();
        assert!(comp.webcam_mask.borrow().is_none());
    }

    /// Le test qui compte : le masque DECOUPE vraiment la camera.
    ///
    /// Il rend le calque webcam plein cadre avec `fx.z = 1` (detourage) et un
    /// masque mi-fond mi-sujet, puis relit les pixels. Il couvre d'un coup les
    /// trois choses que le portage ajoute et qu'aucune compilation ne verifie :
    /// le televersement R8, la liaison de la texture au binding 4, et la branche
    /// `fx.z` de `fs_main` sur un vrai device.
    #[test]
    fn the_mask_actually_cuts_the_camera_out() {
        let Some(gpu) = gpu() else { return };
        let comp = Compositor::new_sized(&gpu, 64, 64).expect("Compositor::new_sized");
        comp.set_webcam_mask(&half_mask(8, 8), 8, 8).expect("set_webcam_mask");
        let (y, u, v) = nv12_views(&gpu, 16, 16, |_, _| Y_WHITE);

        // Fond bleu franc : une couleur que la camera (blanche, chroma neutre) ne
        // peut pas produire, donc « il reste du bleu » signifie « la camera a ete
        // decoupee ici ».
        let (rw, _, rgba) = draw_one_layer(
            &comp,
            wgpu::Color { r: 0.0, g: 0.0, b: 1.0, a: 1.0 },
            &LayerCB {
                dst: [0.0, 0.0, 1.0, 1.0],
                src: [0.0, 0.0, 1.0, 1.0],
                quad_px: [64.0, 64.0],
                mode: 0.0,
                color: [0.0, 0.0, 0.0, 1.0],
                // fx.xy = etendue valide (toute la texture ici), fx.z = 1 -> detourage.
                fx: [1.0, 1.0, 1.0, 0.0],
                src_prev: [0.0, 0.0, 1.0, 1.0],
                dst_prev: [0.0, 0.0, 1.0, 1.0],
                mb: [1.0, 1.0, 1.0, 0.0],
                ..Default::default()
            },
            (&y, &u, &v),
        );

        let px = |col: usize, row: usize| -> [u8; 4] {
            let i = (row * rw as usize + col) * 4;
            [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
        };
        assert_eq!(px(16, 32), [0, 0, 255, 255], "masque a 0 : le fond doit rester visible");
        assert_eq!(px(48, 32), [255, 255, 255, 255], "masque a 255 : la camera doit rester opaque");
    }

    /// Meme montage, mode fond personnalise (`fx.z = 3`) : la ou le masque dit
    /// « fond », le shader doit peindre `color` — c'est le seul mode ou
    /// `LayerCB::color` cesse d'etre du noir opaque decoratif et porte une valeur
    /// que le portage doit transmettre.
    #[test]
    fn the_custom_background_colour_replaces_the_masked_out_pixels() {
        let Some(gpu) = gpu() else { return };
        let comp = Compositor::new_sized(&gpu, 64, 64).expect("Compositor::new_sized");
        comp.set_webcam_mask(&half_mask(8, 8), 8, 8).expect("set_webcam_mask");
        let (y, u, v) = nv12_views(&gpu, 16, 16, |_, _| Y_WHITE);

        let (rw, _, rgba) = draw_one_layer(
            &comp,
            wgpu::Color::BLACK,
            &LayerCB {
                dst: [0.0, 0.0, 1.0, 1.0],
                src: [0.0, 0.0, 1.0, 1.0],
                quad_px: [64.0, 64.0],
                mode: 0.0,
                color: [1.0, 0.0, 0.0, 1.0],
                fx: [1.0, 1.0, 3.0, 0.0],
                src_prev: [0.0, 0.0, 1.0, 1.0],
                dst_prev: [0.0, 0.0, 1.0, 1.0],
                mb: [1.0, 1.0, 1.0, 0.0],
                ..Default::default()
            },
            (&y, &u, &v),
        );
        let px = |col: usize, row: usize| -> [u8; 4] {
            let i = (row * rw as usize + col) * 4;
            [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
        };
        assert_eq!(px(16, 32), [255, 0, 0, 255], "fond masque : la couleur custom doit peindre");
        assert_eq!(px(48, 32), [255, 255, 255, 255], "sujet : la camera doit rester intacte");
    }

    // -----------------------------------------------------------------------
    // `compose_frame` de bout en bout
    //
    // Les tests ci-dessus prouvent les pieces ; ceux-ci prouvent le CABLAGE — que
    // `compose_frame` porte bien `fx`/`color` sur le calque webcam, qu'il lie le
    // masque, et qu'il ne leve `fx.z` qu'une fois un masque reellement televerse.
    // Ils passent par de vraies `AVFrame` porteuses d'un carrier `VkFrameTex`,
    // donc par le MEME `nv12_srvs` que le decodeur : aucun raccourci n'est pris
    // sur le seam de frame.
    // -----------------------------------------------------------------------

    /// Une `AVFrame` du backend Linux. `compose_frame` n'en lit que `format`,
    /// `data[0]`, `width` et `height` : le reste peut rester a zero.
    struct FakeFrame {
        frame: Box<AVFrame>,
    }

    impl FakeFrame {
        fn new(gpu: &Gpu, w: u32, h: u32, luma: impl Fn(u32, u32) -> u8) -> FakeFrame {
            let mut y = vec![0u8; (w * h) as usize];
            for row in 0..h {
                for col in 0..w {
                    y[(row * w + col) as usize] = luma(col, row);
                }
            }
            FakeFrame::from_planes(gpu, w, h, &y, &vec![UV_NEUTRAL; (w * (h / 2)) as usize])
        }

        fn from_planes(gpu: &Gpu, w: u32, h: u32, y: &[u8], uv: &[u8]) -> FakeFrame {
            let (ytex, utex, vtex) = nv12_textures(gpu, w, h, y, uv);
            // Le carrier que `linux_frames::nv12_planes` et `carrier_dims`
            // deballent. `Box::into_raw` ici, `Box::from_raw` dans `Drop` — c'est
            // exactement la mecanique de `CpuFrames::attach_carrier`.
            let carrier = Box::into_raw(Box::new(crate::linux_frames::VkFrameTex {
                y: ytex,
                u: utex,
                v: vtex,
                width: w,
                height: h,
            })) as *mut u8;
            let mut frame: Box<AVFrame> = Box::new(unsafe { std::mem::zeroed() });
            // Le sentinel « buffer GPU natif dans data[0] », le meme que pose
            // `CpuFrames::present`.
            frame.format = crate::ffi::AVPixelFormat::AV_PIX_FMT_D3D11 as i32;
            frame.data[0] = carrier;
            frame.width = w as i32;
            frame.height = h as i32;
            FakeFrame { frame }
        }

        fn as_ptr(&self) -> *const AVFrame {
            &*self.frame as *const AVFrame
        }
    }

    impl Drop for FakeFrame {
        fn drop(&mut self) {
            if !self.frame.data[0].is_null() {
                unsafe {
                    drop(Box::from_raw(
                        self.frame.data[0] as *mut crate::linux_frames::VkFrameTex,
                    ));
                }
                self.frame.data[0] = std::ptr::null_mut();
            }
        }
    }

    /// Scene PiP minimale. `effect` est le JSON de `webcamEffect` (`"null"` pour
    /// aucun).
    ///
    /// `effects.shadow` vaut 0 A DESSEIN : ce curseur ne pilote plus que l'ombre
    /// de l'ecran, alors que celle du PiP est fixe (`WEBCAM_SHADOW_OPACITY`) et ne
    /// depend que de `cfg.shadow`. Le mettre a zero est donc ce qui isole les
    /// deux — sinon un test sur `cfg.shadow` mesure les deux ombres a la fois et
    /// ne dit plus rien de la camera.
    fn pip_scene_json(effect: &str) -> String {
        format!(
            r##"{{"clips":[],
                "layout":{{"preset":"picture-in-picture","webcamSize":1,"webcamShape":"rectangle",
                           "webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},
                "effects":{{"padding":0.18,"blur":false,"shadow":0,"roundnessFrac":0.05,"motionBlur":0}},
                "background":{{"kind":"color","color":"#0080ff"}},
                "zoomRegions":[],"annotations":[],
                "cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,
                           "clipToBounds":false,"theme":"default"}},
                "cropByClip":[],
                "webcamEffect":{effect},
                "output":{{"width":1920,"height":1080,"fps":30}}}}"##
        )
    }

    /// Compose une frame et rend le RGBA du RT. `screen` est gris moyen, `webcam`
    /// blanche : le blanc franc devient alors la SIGNATURE de la camera, une
    /// couleur qu'aucun autre calque de cette scene ne produit, donc comptable
    /// sans connaitre la geometrie du PiP.
    ///
    /// Le fond est un bleu franc et NON du noir : le PiP par defaut tombe dans la
    /// marge, hors de l'ecran, et une ombre noire sur un fond noir ne se voit
    /// pas — le controle du test d'ombre passerait alors pour une suppression
    /// reussie.
    ///
    /// `set_live_params(live_params_from_scene(..))` n'est PAS decoratif : padding,
    /// effets et forme de la webcam transitent par `LiveParams` et non par la
    /// scene brute. L'omettre laisse la scene parser correctement puis etre
    /// ignoree, et le rendu tombe sur les defauts.
    fn compose_pip(
        comp: &Compositor,
        gpu: &Gpu,
        effect: &str,
        shadow: bool,
    ) -> Vec<u8> {
        let scene = Scene::from_json(&pip_scene_json(effect)).expect("scene json");
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_has_webcam(true);
        comp.set_scene(Some(scene));

        let screen = FakeFrame::new(gpu, 128, 128, |_, _| 126);
        let webcam = FakeFrame::new(gpu, 64, 64, |_, _| Y_WHITE);
        let mut cfg = Cfg::c8();
        cfg.bg_blur = false;
        cfg.zoom = false;
        cfg.layout_anim = false;
        cfg.cursor = false;
        cfg.mblur_n = 1;
        cfg.shadow = shadow;
        unsafe {
            comp.compose_frame(screen.as_ptr(), webcam.as_ptr(), 0.0, &cfg)
                .expect("compose_frame");
            let (_, _, rgba) = comp.readback_direct().expect("readback_direct");
            rgba
        }
    }

    /// Pixels quasi blancs = pixels de camera encore visibles.
    fn camera_pixels(rgba: &[u8]) -> usize {
        rgba.chunks_exact(4)
            .filter(|px| px[0] > 240 && px[1] > 240 && px[2] > 240)
            .count()
    }

    const NO_EFFECT: &str = "null";
    const CUTOUT: &str =
        r#"{"mode":"transparent","blurIntensity":0,"background":null,"modelPath":null}"#;

    /// Le piege que le brief nomme : un mode SANS masque ne doit rien changer.
    ///
    /// `effect_code` doit rester a 0 tant que rien n'a ete segmente, sinon le
    /// detourage rend une webcam invisible sur les premieres frames — le temps que
    /// l'inference rende son premier masque, c'est-a-dire a chaque ouverture de
    /// l'editeur. L'assertion est octet pour octet : « inchange » ne souffre pas
    /// d'a-peu-pres.
    #[test]
    fn a_mode_without_a_mask_composites_exactly_like_no_effect_at_all() {
        let Some(gpu) = gpu() else { return };
        let comp = Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        let plain = compose_pip(&comp, &gpu, NO_EFFECT, true);
        let requested = compose_pip(&comp, &gpu, CUTOUT, true);
        assert!(
            comp.webcam_mask.borrow().is_none(),
            "aucun masque n'a ete televerse : `modelPath` est absent, donc rien ne segmente"
        );
        assert!(
            camera_pixels(&plain) > 200,
            "la camera n'est pas a l'ecran, le test ne prouve rien"
        );
        assert_eq!(plain, requested, "un mode sans masque a change des pixels");
    }

    /// Et une fois le masque la, le detourage doit VRAIMENT decouper — dans la
    /// bonne proportion. Le masque couvre la moitie de la camera, donc la moitie
    /// de ses pixels doit disparaitre. Compter plutot que d'echantillonner un
    /// point evite de coder en dur la geometrie du PiP, qui appartient a
    /// `plan_frame` et non a ce portage.
    #[test]
    fn compose_frame_cuts_the_camera_out_once_a_mask_exists() {
        let Some(gpu) = gpu() else { return };
        let comp = Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        let whole = camera_pixels(&compose_pip(&comp, &gpu, NO_EFFECT, true));
        assert!(whole > 200, "la camera n'est pas a l'ecran, le test ne prouve rien");

        let (mw, mh) = (crate::segmentation::MODEL_WIDTH, crate::segmentation::MODEL_HEIGHT);
        comp.set_webcam_mask(&half_mask(mw, mh), mw, mh).expect("set_webcam_mask");
        let cut = camera_pixels(&compose_pip(&comp, &gpu, CUTOUT, true));

        let expected = whole as f32 / 2.0;
        assert!(
            (cut as f32 - expected).abs() < expected * 0.15,
            "detourage : {cut} pixels de camera restants pour ~{expected:.0} attendus \
             (entier : {whole})"
        );
    }

    /// L'ombre portee du PiP doit disparaitre en detourage : une ombre projetee
    /// par un rectangle devenu invisible se lit comme un artefact. Le test le
    /// prouve sans jamais localiser l'ombre — en detourage, `cfg.shadow` ne doit
    /// plus rien changer du tout.
    ///
    /// Le controle est ce qui empeche l'assertion d'etre vide : sans effet,
    /// `cfg.shadow` DOIT changer des pixels, sinon la premiere moitie passerait
    /// aussi pour une scene ou aucune ombre n'a jamais ete dessinee.
    #[test]
    fn the_pip_shadow_is_suppressed_in_cutout_mode() {
        let Some(gpu) = gpu() else { return };
        let comp = Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        assert_ne!(
            compose_pip(&comp, &gpu, NO_EFFECT, true),
            compose_pip(&comp, &gpu, NO_EFFECT, false),
            "controle : sans effet, l'ombre du PiP doit bel et bien se voir"
        );

        let (mw, mh) = (crate::segmentation::MODEL_WIDTH, crate::segmentation::MODEL_HEIGHT);
        comp.set_webcam_mask(&half_mask(mw, mh), mw, mh).expect("set_webcam_mask");
        assert_eq!(
            compose_pip(&comp, &gpu, CUTOUT, true),
            compose_pip(&comp, &gpu, CUTOUT, false),
            "en detourage, l'ombre est encore dessinee"
        );
    }

    /// Le tour complet, celui qui a besoin d'ONNX Runtime : capture -> inference
    /// -> masque -> composite, entraine par `compose_frame` seul. Se saute
    /// proprement sans la bibliotheque, ce que fait la CI — cf.
    /// `segmentation::runtime_available`.
    #[test]
    fn the_whole_loop_produces_a_mask_from_compose_frame_alone() {
        if !crate::segmentation::runtime_available() {
            eprintln!("ONNX Runtime absent (ORT_DYLIB_PATH) — test saute");
            return;
        }
        let model = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../public/mediapipe/selfie_segmentation/selfie_segmentation_landscape.onnx");
        if !model.is_file() {
            eprintln!("modele absent ({}) — test saute", model.display());
            return;
        }
        let Some(gpu) = gpu() else { return };
        let comp = Compositor::new_sized(&gpu, 320, 180).expect("Compositor::new_sized");
        let effect = format!(
            r#"{{"mode":"transparent","blurIntensity":0,"background":null,"modelPath":{}}}"#,
            serde_json::to_string(&model.to_string_lossy()).expect("chemin serialisable")
        );

        // Le limiteur est a 30 Hz : une frame par tour ne suffirait pas, et
        // l'inference est asynchrone. On laisse au worker le temps de rendre un
        // masque, sans jamais l'attendre dans le rendu — ce qui est precisement le
        // contrat.
        let mut uploaded = false;
        for _ in 0..40 {
            let _ = compose_pip(&comp, &gpu, &effect, true);
            if comp.webcam_mask.borrow().is_some() {
                uploaded = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        assert!(
            uploaded,
            "aucun masque n'est remonte : la boucle capture -> inference -> upload est rompue"
        );
        assert!(!*comp.seg_failed.borrow(), "la segmentation s'est eteinte d'elle-meme");
    }

    // -----------------------------------------------------------------------
    // Harnais visuel (opt-in)
    //
    // Les tests ci-dessus prouvent le mecanisme sur des images synthetiques, ou le
    // masque est pose a la main et donc trivialement juste. Ils ne peuvent rien
    // dire de la QUALITE du masque que le modele produit sur une vraie camera — et
    // « un masque qui composite » n'est pas la meme affirmation que « un masque qui
    // est correct ».
    //
    // Meme forme d'opt-in que `tests/compose_linux.rs` (variable d'environnement +
    // skip propre), et pour la meme raison : ca rend sur GPU et ca lit un fichier
    // que le depot ne porte pas.
    //
    // ```
    // ORT_DYLIB_PATH=/chemin/libonnxruntime.so \
    // OPENSCREEN_SEG_CAM=camera.png \
    // OPENSCREEN_SEG_VISUAL=target/seg \
    //   cargo test -p openscreen-compositor --lib seg_visual -- --nocapture
    // ```
    // -----------------------------------------------------------------------

    /// RGB8 -> NV12 BT.709 limited. Inverse EXACT de `yuv709_limited` dans
    /// `layer.wgsl` : une autre matrice ferait deriver les couleurs du rendu et on
    /// croirait a un bug du compositeur la ou il n'y aurait qu'une conversion
    /// d'entree fausse.
    fn rgb_to_nv12(rgb: &[u8], w: u32, h: u32) -> (Vec<u8>, Vec<u8>) {
        let luma = |i: usize| -> (f32, f32, f32, f32) {
            let (r, g, b) = (
                rgb[i * 3] as f32 / 255.0,
                rgb[i * 3 + 1] as f32 / 255.0,
                rgb[i * 3 + 2] as f32 / 255.0,
            );
            (r, g, b, 0.2126 * r + 0.7152 * g + 0.0722 * b)
        };
        let mut y = vec![0u8; (w * h) as usize];
        for i in 0..(w * h) as usize {
            let (_, _, _, yl) = luma(i);
            y[i] = (16.0 + 219.0 * yl).round().clamp(0.0, 255.0) as u8;
        }
        // Chroma au plus proche voisin : l'echantillon en haut a gauche de chaque
        // bloc 2x2. Un vrai filtre ne changerait rien a ce que ce harnais donne a
        // voir.
        let mut uv = vec![0u8; (w * (h / 2)) as usize];
        for row in 0..h / 2 {
            for col in 0..w / 2 {
                let (r, _, b, yl) = luma(((row * 2) * w + col * 2) as usize);
                let cb = 128.0 + 224.0 * ((b - yl) / 1.8556);
                let cr = 128.0 + 224.0 * ((r - yl) / 1.5748);
                let o = (row * w + col * 2) as usize;
                uv[o] = cb.round().clamp(0.0, 255.0) as u8;
                uv[o + 1] = cr.round().clamp(0.0, 255.0) as u8;
            }
        }
        (y, uv)
    }

    fn frame_from_png(gpu: &Gpu, path: &std::path::Path) -> FakeFrame {
        let img = image::open(path)
            .unwrap_or_else(|e| panic!("{} : {e}", path.display()))
            .to_rgb8();
        // NV12 veut des dimensions paires ; on rogne d'un pixel plutot que de
        // reechantillonner.
        let (w, h) = (img.width() & !1, img.height() & !1);
        let src = img.as_raw();
        let mut rgb = vec![0u8; (w * h * 3) as usize];
        for row in 0..h {
            let (d, s) = ((row * w * 3) as usize, (row * img.width() * 3) as usize);
            rgb[d..d + (w * 3) as usize].copy_from_slice(&src[s..s + (w * 3) as usize]);
        }
        let (y, uv) = rgb_to_nv12(&rgb, w, h);
        FakeFrame::from_planes(gpu, w, h, &y, &uv)
    }

    #[test]
    fn seg_visual_renders_the_four_modes_from_a_real_photo() {
        let (Ok(out_dir), Ok(cam)) = (
            std::env::var("OPENSCREEN_SEG_VISUAL"),
            std::env::var("OPENSCREEN_SEG_CAM"),
        ) else {
            eprintln!(
                "harnais visuel : OPENSCREEN_SEG_VISUAL + OPENSCREEN_SEG_CAM absents — saute"
            );
            return;
        };
        if !crate::segmentation::runtime_available() {
            eprintln!("ONNX Runtime absent (ORT_DYLIB_PATH) — saute");
            return;
        }
        let model = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../public/mediapipe/selfie_segmentation/selfie_segmentation_landscape.onnx");
        let Some(gpu) = gpu() else { return };
        std::fs::create_dir_all(&out_dir).expect("dossier de sortie");

        let (rw, rh) = (1280u32, 720u32);
        let comp = Compositor::new_sized(&gpu, rw, rh).expect("Compositor::new_sized");
        let webcam = frame_from_png(&gpu, std::path::Path::new(&cam));
        let screen = match std::env::var("OPENSCREEN_SEG_SCREEN") {
            Ok(p) => frame_from_png(&gpu, std::path::Path::new(&p)),
            // Sans capture d'ecran sous la main, un damier : il rend le detourage
            // lisible, la ou un aplat laisserait croire a un fond simplement peint.
            Err(_) => FakeFrame::new(&gpu, 640, 360, |col, row| {
                if (col / 40 + row / 40) % 2 == 0 { 180 } else { 60 }
            }),
        };
        let model_json = serde_json::to_string(&model.to_string_lossy()).expect("chemin");

        let mut wrote = Vec::new();
        for (name, effect) in [
            ("00-none", "null".to_string()),
            ("01-cutout", format!(r#"{{"mode":"transparent","blurIntensity":0,"background":null,"modelPath":{model_json}}}"#)),
            ("02-blur", format!(r#"{{"mode":"blur","blurIntensity":0.8,"background":null,"modelPath":{model_json}}}"#)),
            ("03-custom", format!(r##"{{"mode":"custom","blurIntensity":0,"background":{{"kind":"color","color":"#ff2d95"}},"modelPath":{model_json}}}"##)),
        ] {
            // Le masque arrive de facon asynchrone : on tourne jusqu'a ce qu'il
            // soit la, ce qui est aussi une verification en soi — la boucle du
            // rendu ne l'attend jamais.
            let mut rgba = Vec::new();
            for _ in 0..60 {
                rgba = compose_visual(&comp, &screen, &webcam, &effect);
                if effect == "null" || comp.webcam_mask.borrow().is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            let path = format!("{out_dir}/seg-{name}.png");
            image::RgbaImage::from_raw(rw, rh, rgba)
                .expect("dimensions du readback")
                .save(&path)
                .unwrap_or_else(|e| panic!("ecriture {path} : {e}"));
            wrote.push(path);
        }
        for p in &wrote {
            println!("wrote {p}");
        }
        assert!(
            comp.webcam_mask.borrow().is_some(),
            "aucun masque n'a ete produit : les trois modes d'effet sont sans objet"
        );
    }

    /// Camera grand format (rect force via `webcamRect`), pour que le masque
    /// occupe une bonne part de l'image et se juge a taille reelle.
    fn compose_visual(
        comp: &Compositor,
        screen: &FakeFrame,
        webcam: &FakeFrame,
        effect: &str,
    ) -> Vec<u8> {
        let json = format!(
            r##"{{"clips":[],
                "layout":{{"preset":"picture-in-picture","webcamSize":1,"webcamShape":"rectangle",
                           "webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false,
                           "webcamRect":{{"x":0.06,"y":0.10,"width":0.55,"height":0.72}}}},
                "effects":{{"padding":0.10,"blur":false,"shadow":1,"roundnessFrac":0.02,"motionBlur":0}},
                "background":{{"kind":"gradient","angleDeg":45,"stops":["#1b2a4a","#0b0f1a"]}},
                "zoomRegions":[],"annotations":[],
                "cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,
                           "clipToBounds":false,"theme":"default"}},
                "cropByClip":[],
                "webcamEffect":{effect},
                "output":{{"width":1280,"height":720,"fps":30}}}}"##
        );
        let scene = Scene::from_json(&json).expect("scene json");
        comp.set_live_params(live_params_from_scene(&scene));
        comp.set_has_webcam(true);
        comp.set_scene(Some(scene));
        let mut cfg = Cfg::c8();
        cfg.zoom = false;
        cfg.layout_anim = false;
        cfg.cursor = false;
        cfg.mblur_n = 1;
        unsafe {
            comp.compose_frame(screen.as_ptr(), webcam.as_ptr(), 0.0, &cfg)
                .expect("compose_frame");
            let (_, _, rgba) = comp.readback_direct().expect("readback_direct");
            rgba
        }
    }
}

// ---------------------------------------------------------------------------
// Staging exportable en dmabuf
// ---------------------------------------------------------------------------

/// Un buffer de staging dont la MEMOIRE est exportable en dmabuf, pour qu'un
/// encodeur materiel puisse la lire sans repasser par le CPU.
///
/// POURQUOI IL EN FAUT UN DEUXIEME, ET PAS UN DRAPEAU SUR L'EXISTANT. wgpu
/// n'expose aucun moyen de demander une allocation exportable : il faut la
/// fabriquer soi-meme et la lui confier. Or `buffer_from_raw` construit un
/// `Buffer { block: None }` -- wgpu accepte d'y ECRIRE (c'est une cible de
/// `copy_texture_to_buffer` comme une autre) mais ne peut pas le faire lire par
/// le CPU, sa mecanique de mapping passant par ce bloc qu'il ne possede pas.
/// Le chemin logiciel, lui, DOIT le lire. Les deux ne peuvent donc pas partager
/// un buffer, et l'export choisit lequel il alloue selon l'encodeur retenu.
///
/// La memoire est demandee HOST_VISIBLE pour que la verification puisse la
/// relire directement ; un chemin purement GPU pourrait s'en passer.
pub struct ExportableStaging {
    /// Vue wgpu, utilisable comme destination de copie. En `Option` UNIQUEMENT
    /// pour pouvoir la relacher explicitement avant la memoire dans `Drop`, cf.
    /// l'ordre impose la-bas.
    buffer: Option<wgpu::Buffer>,
    /// Le descripteur a passer au consommateur. Possede : ferme dans `Drop`.
    pub fd: i32,
    pub size: u64,
    device: ash::Device,
    memory: ash::vk::DeviceMemory,
}

impl ExportableStaging {
    /// La cible de copie a passer a wgpu.
    pub fn buffer(&self) -> &wgpu::Buffer {
        self.buffer.as_ref().expect("buffer relache")
    }
}

impl ExportableStaging {
    /// Relit la memoire exportee telle que le GPU l'a laissee.
    ///
    /// Passe par `vkMapMemory` et NON par wgpu, pour la raison ci-dessus. C'est
    /// ce qui permet de verifier le contenu sans encodeur : si ces octets sont
    /// ceux du chemin de relecture normal, la memoire exportee porte bien
    /// l'image composee.
    pub fn read_back(&self) -> Result<Vec<u8>> {
        unsafe {
            let p = self
                .device
                .map_memory(self.memory, 0, self.size, ash::vk::MemoryMapFlags::empty())
                .map_err(|e| anyhow::anyhow!("vkMapMemory: {e}"))?;
            let out = std::slice::from_raw_parts(p as *const u8, self.size as usize).to_vec();
            self.device.unmap_memory(self.memory);
            Ok(out)
        }
    }
}

impl Drop for ExportableStaging {
    fn drop(&mut self) {
        // L'ORDRE EST LE FOND DU SUJET, et le premier jet le faisait a l'envers :
        // il detruisait le `VkBuffer` puis liberait la memoire, alors que wgpu
        // detruit DEJA le buffer quand son wrapper tombe -- double liberation,
        // et par-dessus, memoire liberee alors qu'un buffer y etait encore lie.
        //
        // Le partage est donc : wgpu possede le HANDLE (il l'a recu par
        // `buffer_from_raw` et le detruira), nous possedons la MEMOIRE (son
        // `block` est `None`, personne d'autre ne la liberera). D'ou : relacher
        // le wrapper d'abord, liberer la memoire ensuite.
        drop(self.buffer.take());
        unsafe {
            self.device.free_memory(self.memory, None);
        }
        // Le fd est un handle a part : l'exporter duplique la propriete, donc le
        // fermer ne libere pas la memoire -- mais l'oublier fuirait un
        // descripteur par frame.
        if self.fd >= 0 {
            let _ = nix_close(self.fd);
        }
    }
}

fn nix_close(fd: i32) -> std::io::Result<()> {
    // `libc::close` sans dependance supplementaire : la libc est deja liee.
    extern "C" {
        fn close(fd: i32) -> i32;
    }
    if unsafe { close(fd) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

impl Compositor {
    /// Alloue un buffer de staging exportable de `size` octets, ou `None` si le
    /// device n'a pas ete ouvert avec les extensions de memoire externe (cf.
    /// `d3d_linux::open_device_with_dmabuf_export`).
    pub fn create_exportable_staging(&self, size: u64) -> Option<ExportableStaging> {
        use ash::vk;
        unsafe {
            self.gpu.device.as_hal::<wgpu_hal::api::Vulkan, _, _>(|hal| {
                let hal = hal?;
                let dev = hal.raw_device().clone();
                let phys = hal.raw_physical_device();
                let instance = hal.shared_instance().raw_instance();

                let mut ext_info = vk::ExternalMemoryBufferCreateInfo::default()
                    .handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
                let bci = vk::BufferCreateInfo::default()
                    .push_next(&mut ext_info)
                    .size(size)
                    .usage(vk::BufferUsageFlags::TRANSFER_DST)
                    .sharing_mode(vk::SharingMode::EXCLUSIVE);
                let raw = dev.create_buffer(&bci, None).ok()?;

                let req = dev.get_buffer_memory_requirements(raw);
                let props = instance.get_physical_device_memory_properties(phys);
                // HOST_VISIBLE pour que `read_back` puisse verifier le contenu.
                let mt = (0..props.memory_type_count).find(|i| {
                    req.memory_type_bits & (1 << i) != 0
                        && props.memory_types[*i as usize]
                            .property_flags
                            .contains(vk::MemoryPropertyFlags::HOST_VISIBLE)
                })?;

                let mut export = vk::ExportMemoryAllocateInfo::default()
                    .handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
                let mai = vk::MemoryAllocateInfo::default()
                    .push_next(&mut export)
                    .allocation_size(req.size)
                    .memory_type_index(mt);
                let memory = dev.allocate_memory(&mai, None).ok()?;
                dev.bind_buffer_memory(raw, memory, 0).ok()?;

                let getter = ash::khr::external_memory_fd::Device::new(instance, &dev);
                let fd = getter
                    .get_memory_fd(
                        &vk::MemoryGetFdInfoKHR::default()
                            .memory(memory)
                            .handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT),
                    )
                    .ok()?;

                let hal_buf = wgpu_hal::vulkan::Device::buffer_from_raw(raw);
                let buffer = self.gpu.device.create_buffer_from_hal::<wgpu_hal::api::Vulkan>(
                    hal_buf,
                    &wgpu::BufferDescriptor {
                        label: Some("staging-exportable"),
                        size,
                        usage: wgpu::BufferUsages::COPY_DST,
                        mapped_at_creation: false,
                    },
                );
                Some(ExportableStaging { buffer: Some(buffer), fd, size, device: dev, memory })
            })
        }
    }
}

impl Compositor {
    /// Compose la frame courante en NV12 et la depose dans `staging`, dont la
    /// memoire est exportable en dmabuf. Rend la main quand le GPU a fini.
    ///
    /// PAS DE RING, PAS DE `map_async`, CONTRAIREMENT A `readback_submit_yuv`.
    /// Cette variante-ci n'a rien a faire relire par le CPU : le consommateur est
    /// l'encodeur materiel, qui lit la meme memoire par son fd. Toute la
    /// mecanique de staging mappe et de recolte differee n'aurait donc personne a
    /// servir.
    ///
    /// L'attente est SYNCHRONE et c'est un choix de premiere version : le travail
    /// GPU par frame se compte en millisecondes et l'encodage materiel aussi, la
    /// ou l'encodeur logiciel qui a justifie le worker en demandait 8. Recouvrir
    /// les deux demanderait plusieurs tampons exportables en rotation ; ca se
    /// mesure avant de se decider, et ca ne change pas l'image produite.
    pub unsafe fn compose_into_dmabuf(&self, staging: &ExportableStaging) -> Result<()> {
        self.ensure_yuv_fmt(YuvFormat::Nv12)?;
        let (bpr_y, bpr_uv, off_uv, total) = {
            let g = self.yuv.borrow();
            let t = g.as_ref().expect("ensure_yuv");
            (t.bpr_y, t.bpr_uv, t.off_u, t.total)
        };
        if staging.size < total {
            anyhow::bail!("staging de {} octets pour {total} attendus", staging.size);
        }
        let (w, h) = (self.render_w, self.render_h);
        let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));

        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("yuv-dmabuf") });
        {
            let g = self.yuv.borrow();
            let t = g.as_ref().expect("ensure_yuv");
            let (uv_view, pipe_uv, _uv) = match &t.chroma {
                Chroma::Interleaved { uv_view, pipe_uv, _uv } => (uv_view, pipe_uv, _uv),
                Chroma::Planar { .. } => {
                    anyhow::bail!("compose_into_dmabuf attend des cibles NV12")
                }
            };
            for (view, pipe) in [(&t.y_view, &t.pipe_y), (uv_view, pipe_uv)] {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("yuv-dmabuf-plane"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                pass.set_pipeline(pipe);
                pass.set_bind_group(0, &t.bind, &[]);
                pass.draw(0..3, 0..1);
            }
            for (tex, off, bpr, pw, ph) in
                [(&t._y, 0u64, bpr_y, w, h), (_uv, off_uv, bpr_uv, cw, ch)]
            {
                encoder.copy_texture_to_buffer(
                    wgpu::TexelCopyTextureInfo {
                        texture: tex,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::TexelCopyBufferInfo {
                        buffer: staging.buffer(),
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: off,
                            bytes_per_row: Some(bpr),
                            rows_per_image: Some(ph),
                        },
                    },
                    wgpu::Extent3d { width: pw, height: ph, depth_or_array_layers: 1 },
                );
            }
        }
        let idx = self.gpu.context.submit(std::iter::once(encoder.finish()));
        // L'encodeur va lire cette memoire par un autre chemin que wgpu : rien
        // d'autre ne garantirait que la copie est terminee quand on lui passe
        // le fd.
        self.gpu.device.poll(wgpu::Maintain::WaitForSubmissionIndex(idx));
        Ok(())
    }

    /// La geometrie NV12 courante, pour decrire le dmabuf au consommateur.
    pub fn nv12_geometry(&self) -> (u32, u32, u64, u64) {
        Compositor::yuv_layout_for(self.render_w, self.render_h, YuvFormat::Nv12)
    }
}
