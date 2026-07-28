//! Le compositeur natif D3D11 d'OpenScreen : décodage, pipeline, effets HLSL, scène, curseur,
//! audio, et la vue live embarquable (`live`).
//!
//! C'est du code de PRODUCTION. `compositor-view-napi` s'y lie pour produire
//! `compositor_view.node`, le binaire que l'app Electron charge — la preview comme l'export
//! passent par ici. Le POC de mesure (`poc-d3d`) n'est qu'un autre consommateur de cette
//! bibliothèque, pas l'inverse : la GUI Win32 et le harnais de bench vivent chez lui.

pub mod audio;
pub mod compositor;
pub mod config;
pub mod cursor;
pub mod d3d;
pub mod ffi;
pub mod gif_export;
pub mod live;
pub mod pipeline;
pub mod regions;
pub mod scene;
pub mod text;
pub mod text_anim;
