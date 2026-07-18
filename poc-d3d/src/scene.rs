//! Contrat de scène côté Rust — miroir exact de `SceneDescription` (TS, `src/native/sceneDescription.ts`).
//! L'app sérialise le document en JSON ; le natif le parse ici puis calcule la composition par frame,
//! ce qui **remplace le `timeline()` fixture** (placements A↔B + zoom codés en dur). Le natif possède
//! toute la maths par-frame (géométrie du layout, easing du zoom, application des effets) ; ce module
//! ne fait que le modèle de données + le parse. La conversion JS (camelCase) est gérée par serde.

use serde::Deserialize;

/// Un clip de la timeline (fichiers screen+webcam + fenêtre source). = `CompositorClipInput` (TS).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneClip {
    pub screen_path: String,
    pub webcam_path: String,
    pub source_start_sec: f64,
    pub source_end_sec: f64,
    /// temps source webcam = temps source screen − ceci.
    pub webcam_offset_sec: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebcamPosition {
    pub cx: f32,
    pub cy: f32,
}

/// Placement de la webcam (preset + réglages).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneLayout {
    /// "picture-in-picture" | "dual-frame" | "vertical-stack" | "no-webcam".
    pub preset: String,
    /// échelle taille webcam (1 = défaut PiP du compositeur).
    pub webcam_size: f32,
    /// "rectangle" | "circle" | "square" | "rounded".
    pub webcam_shape: String,
    pub webcam_mirror: bool,
    /// position normalisée (0..1) du centre webcam, ou None → défaut du preset.
    pub webcam_position: Option<WebcamPosition>,
    /// la webcam rétrécit pendant un zoom actif.
    pub webcam_reactive_zoom: bool,
}

/// Effets de cadre (padding, blur, ombre, coins, motion blur).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneEffects {
    /// 0..1 inset supplémentaire de l'écran.
    pub padding: f32,
    pub blur: bool,
    /// 0..1 force de l'ombre.
    pub shadow: f32,
    /// rayon des coins en px de sortie.
    pub roundness_px: f32,
    /// 0..1 flou de mouvement.
    pub motion_blur: f32,
}

/// Fond derrière l'écran (parsé depuis `settings.wallpaper`).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SceneBackground {
    Color { color: String },
    Gradient {
        #[serde(rename = "angleDeg")]
        angle_deg: f32,
        stops: Vec<String>,
    },
    Image { path: String },
}

/// Une zone de zoom de la timeline (temps en secondes).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneZoomRegion {
    pub start_sec: f64,
    pub end_sec: f64,
    /// échelle cible (>1 = zoom avant).
    pub scale: f32,
    pub focus_x: f32,
    pub focus_y: f32,
    /// "iso" | "left" | "right" | null.
    pub rotation: Option<String>,
}

/// Rendu du curseur.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneCursor {
    pub show: bool,
    /// échelle directe (1 = défaut).
    pub size: f32,
    pub smoothing: f32,
    pub motion_blur: f32,
    pub click_bounce: f32,
    pub clip_to_bounds: bool,
    /// id du thème (jeu de sprites) — "default" = pas d'override, curseur math dot+ring.
    pub theme: String,
    /// Chemin absolu du sprite "arrow" du thème, résolu côté app (compositorViewService,
    /// même mécanisme que le wallpaper image). Absent/`None` → curseur math par défaut.
    /// `#[serde(default)]` : champ ajouté après coup, absent des JSON de test existants.
    #[serde(default)]
    pub cursor_sprite_path: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneCrop {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneOutput {
    pub width: u32,
    pub height: u32,
    /// null = fps du 1er clip.
    pub fps: Option<f64>,
}

/// Tout ce dont le natif a besoin pour composer la scène, sérialisé depuis un document.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub clips: Vec<SceneClip>,
    pub layout: SceneLayout,
    pub effects: SceneEffects,
    pub background: SceneBackground,
    pub zoom_regions: Vec<SceneZoomRegion>,
    pub cursor: SceneCursor,
    pub crop: Option<SceneCrop>,
    pub output: SceneOutput,
}

impl Scene {
    /// Parse le JSON produit par `buildSceneDescription` (TS).
    pub fn from_json(json: &str) -> anyhow::Result<Scene> {
        Ok(serde_json::from_str(json)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_minimal_scene_json() {
        let json = r##"{
            "clips": [{"screenPath":"/s.mp4","webcamPath":"/w.mp4","sourceStartSec":0,"sourceEndSec":4,"webcamOffsetSec":0}],
            "layout": {"preset":"picture-in-picture","webcamSize":1.5,"webcamShape":"circle","webcamMirror":true,"webcamPosition":null,"webcamReactiveZoom":false},
            "effects": {"padding":0.5,"blur":true,"shadow":0.8,"roundnessPx":24,"motionBlur":0.0},
            "background": {"kind":"gradient","angleDeg":135,"stops":["#eaebed","#bcc0c6"]},
            "zoomRegions": [{"startSec":1.0,"endSec":3.0,"scale":2.0,"focusX":0.5,"focusY":0.3,"rotation":"iso"}],
            "cursor": {"show":true,"size":1,"smoothing":0.5,"motionBlur":0.2,"clickBounce":1,"clipToBounds":false,"theme":"default"},
            "crop": null,
            "output": {"width":1920,"height":1080,"fps":null}
        }"##;
        let scene = Scene::from_json(json).expect("parse");
        assert_eq!(scene.clips.len(), 1);
        assert_eq!(scene.clips[0].screen_path, "/s.mp4");
        assert_eq!(scene.layout.preset, "picture-in-picture");
        assert!(scene.layout.webcam_mirror);
        assert_eq!(scene.effects.roundness_px, 24.0);
        match scene.background {
            SceneBackground::Gradient { angle_deg, ref stops } => {
                assert_eq!(angle_deg, 135.0);
                assert_eq!(stops.len(), 2);
            }
            _ => panic!("expected gradient"),
        }
        assert_eq!(scene.zoom_regions[0].scale, 2.0);
        assert_eq!(scene.output.width, 1920);
    }

    #[test]
    fn parses_color_and_image_backgrounds() {
        let color = r##"{"clips":[],"layout":{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false},"effects":{"padding":0,"blur":false,"shadow":0,"roundnessPx":0,"motionBlur":0},"background":{"kind":"color","color":"#123456"},"zoomRegions":[],"cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"},"crop":null,"output":{"width":1280,"height":720,"fps":30}}"##;
        let s = Scene::from_json(color).expect("parse color");
        match s.background {
            SceneBackground::Color { ref color } => assert_eq!(color, "#123456"),
            _ => panic!("expected color"),
        }
        assert_eq!(s.output.fps, Some(30.0));
    }
}
