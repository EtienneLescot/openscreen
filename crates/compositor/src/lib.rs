//! Le compositeur natif multiplateforme d'OpenScreen : décodage, pipeline, effets, scène,
//! curseur, audio, et la vue live embarquable (`live`).
//!
//! C'est du code de PRODUCTION. `compositor-view-napi` s'y lie pour produire
//! `compositor_view.node`, le binaire que l'app Electron charge — la preview comme l'export
//! passent par ici. Le POC de mesure (`poc-d3d`) n'est qu'un autre consommateur de cette
//! bibliothèque, pas l'inverse : la GUI Win32 et le harnais de bench vivent chez lui.
//!
//! # Backends
//!
//! - Windows : `d3d_windows::Gpu` (D3D11 + D3D11VA), shaders HLSL compilés via `D3DCompile`
//!   à l'exécution, `cpu_frames_windows.rs` pour l'axe décodage logiciel du backend CPU.
//!   Le moteur est dans `compositor_windows.rs` et le rastériseur de texte dans `text_windows.rs`.
//!
//! - macOS : `d3d_macos::Gpu` (Metal + VideoToolbox), shaders MSL compilés via
//!   `MTLDevice.makeLibrary` à l'exécution, `mac_frames.rs` pour l'axe décodage logiciel
//!   (rare : VideoToolbox couvre les codecs standards sur chaque Mac supporté). Le moteur
//!   est dans `compositor_macos.rs` et le rastériseur de texte dans `text_macos.rs`.
//!
//! `live.rs` et `pipeline.rs` portent du code ffmpeg/thread portable ; les blocs
//! spécifiques à chaque backend sont cfg-gatés à l'intérieur (D3D11VA vs VideoToolbox,
//! harnais Win32 vs UI Carbon/AppKit).
//!
//! Les noms `d3d`, `cpu_frames`, `compositor`, `text` sont conservés à travers une
//! ré-export cfg-conditionnelle pour que les call-sites restent portables. Le contrat
//! de scène, l'API publique des moteurs, et le frame-seam 4-champ de l'AVFrame
//! (`data[0]`, `data[1]`, `width`, `height`) sont identiques sur les deux plateformes
//! — c'est précisément ce qui rend le port Metal possible (cf. PR #162).

pub mod audio;
pub mod config;
pub mod cursor;
pub mod ffi;
pub mod frame_geometry;
pub mod gif_export;
pub mod regions;
// Multiplateforme à dessein : n'utilise que libavformat (liée sur les trois
// cibles) et le shim C. Seul Linux l'appelle aujourd'hui, parce que c'est la
// seule plateforme dont la capture passe par `MediaRecorder`, mais rien dedans
// n'est spécifique à Linux.
pub mod remux;
pub mod scene;
pub mod text_anim;
pub mod text_plate;
pub(crate) mod timeline_walk;

// GPU backend : Windows → d3d_windows, macOS → d3d_macos. Ré-exporté sous le nom `d3d`
// pour que `crate::d3d::Gpu`/`Backend` reste portable. Le module sous-jacent est
// `pub mod` (pas `mod`) pour que `pub use … as d3d` puisse le ré-exporter hors du crate.
#[cfg(windows)]
pub mod d3d_windows;
#[cfg(windows)]
pub use d3d_windows as d3d;

#[cfg(target_os = "macos")]
pub mod d3d_macos;
#[cfg(target_os = "macos")]
pub use d3d_macos as d3d;

#[cfg(target_os = "linux")]
pub mod d3d_linux;
#[cfg(target_os = "linux")]
pub use d3d_linux as d3d;

// Source de frames du backend « CPU-like » : Windows → cpu_frames_windows (WARP + swscale),
// macOS → mac_frames (logiciel → CVPixelBuffer). Ré-exporté sous le nom `cpu_frames` (privé).
#[cfg(windows)]
mod cpu_frames_windows;
#[cfg(windows)]
use cpu_frames_windows as cpu_frames;

#[cfg(target_os = "macos")]
mod mac_frames;
#[cfg(target_os = "macos")]
use mac_frames as cpu_frames;

#[cfg(target_os = "linux")]
mod linux_frames;
#[cfg(target_os = "linux")]
use linux_frames as cpu_frames;
#[cfg(target_os = "linux")]
mod linux_decode;

// Moteur de composition + rastériseur de texte + pipeline : un fichier par plateforme.
// Le pipeline est gardé séparé (pas de fusion comme live) parce que la ffmpeg-side
// diffère entre D3D11VA et VideoToolbox : les types `AVD3D11VADeviceContext` vs
// `AVVideotoolboxContext` sont des structs distincts (générés via bindgen sur
// chaque wrapper.h), et le câblage decode/encode appelle des fonctions différentes
// (`av_hwframe_ctx_init` vs `av_hwdevice_ctx_create(AV_HWDEVICE_TYPE_VIDEOTOOLBOX)`).
#[cfg(windows)]
pub mod compositor_windows;
#[cfg(windows)]
pub mod pipeline_windows;
#[cfg(windows)]
pub mod text_windows;

#[cfg(target_os = "macos")]
pub mod compositor_macos;
#[cfg(target_os = "macos")]
pub mod pipeline_macos;
#[cfg(target_os = "macos")]
pub mod text_macos;

#[cfg(target_os = "linux")]
pub mod text_linux;
#[cfg(target_os = "linux")]
pub mod compositor_linux;
#[cfg(target_os = "linux")]
pub mod pipeline_linux;

#[cfg(windows)]
pub use compositor_windows as compositor;
#[cfg(windows)]
pub use pipeline_windows as pipeline;
#[cfg(windows)]
pub use text_windows as text;

#[cfg(target_os = "macos")]
pub use compositor_macos as compositor;
#[cfg(target_os = "macos")]
pub use pipeline_macos as pipeline;
#[cfg(target_os = "macos")]
pub use text_macos as text;

#[cfg(target_os = "linux")]
pub use text_linux as text;
#[cfg(target_os = "linux")]
pub use compositor_linux as compositor;
#[cfg(target_os = "linux")]
pub use pipeline_linux as pipeline;

// `live.rs` est resté un fichier unique parce que sa machinerie principale (Player,
// LiveView, render_thread) est entièrement cross-platform : elle ne touche qu'au
// Compositor (cfg-ré-exporté) et au ffmpeg `Decoder` (portable). Seules les
// helpers `run_standalone`/`host_proc`/`wide`/`client_size` (harnais Win32 du POC)
// sont cfg-gatées à l'intérieur du fichier.
pub mod live;