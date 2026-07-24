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
    /// Une source sans piste audio décodable garde sa durée via du silence natif.
    #[serde(default)]
    pub has_audio: bool,
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
    /// "rectangle" | "circle" | "square" | "rounded" — la forme RÉSOLUE par le layout, pas le
    /// réglage brut de l'utilisateur : seul le PiP honore le sélecteur de forme, les layouts en
    /// bloc découpent toujours un rectangle (côté app, cf. `computeCompositeLayout`).
    pub webcam_shape: String,
    pub webcam_mirror: bool,
    /// position normalisée (0..1) du centre webcam, ou None → défaut du preset.
    pub webcam_position: Option<WebcamPosition>,
    /// la webcam rétrécit pendant un zoom actif.
    pub webcam_reactive_zoom: bool,
    /// Rect webcam résolu côté app (0..1 fractions du cadre de sortie), en PARITÉ EXACTE avec
    /// `computeCompositeLayout` (TS). Permet à TS et Rust de partager la même source de vérité :
    /// le natif ne dérive PLUS ses propres placements pour PiP/dual-frame/vertical-stack — il
    /// consomme ce rect directement et applique par-dessus les ajustements purement par-frame
    /// (`webcam_size_scale`, `reactive_scale`, Full Camera).
    ///
    /// `#[serde(default)]` : champ ajouté après coup ; les anciens JSON (et les tests) omettent
    /// ce champ, ce qui active le fallback `preset_placements` Rust historique (PiP codé en dur).
    #[serde(default)]
    pub webcam_rect: Option<SceneRect>,
    /// Rect ÉCRAN résolu côté app (mêmes fractions 0..1 du cadre de sortie que `webcam_rect`).
    /// Déjà paddé et déjà au ratio du crop — le natif le consomme TEL QUEL, sans `padding_scale`
    /// ni `fit_dst_to_aspect`. Sans lui, le natif gardait sa boîte écran codée en dur
    /// (`preset_placements`) tout en respectant la boîte caméra de l'app : les deux ne
    /// s'accordaient plus et la caméra du preset side-by-side sortait du cadre.
    ///
    /// `#[serde(default)]` : ancien payload / tests → None → fallback `preset_placements`.
    #[serde(default)]
    pub screen_rect: Option<SceneRect>,
    /// Rayon des coins de l'écran en px de la sortie, quand le preset en impose un (les layouts
    /// en bloc encadrent écran et caméra à l'identique). None → slider Roundness, comme avant.
    #[serde(default)]
    pub screen_radius: Option<f32>,
    /// Rayon des coins de la CAMÉRA, même convention px-de-sortie que `screen_radius` et issu du
    /// même appel `computeCompositeLayout`. C'est la seule façon que « le bloc encadre écran et
    /// caméra à l'identique » soit vrai : sans lui l'écran prenait le rayon de l'app pendant que
    /// la caméra gardait la table Rust indépendante ci-dessous (`min * 0.5 | 0.3 | 0.12`, non
    /// bornée), donc deux moitiés d'un même bloc arrondies par deux formules différentes.
    ///
    /// Donné pour la taille NOMINALE de la caméra ; le natif le remet à l'échelle de la boîte
    /// réellement dessinée (zoom réactif, Full Camera).
    ///
    /// `#[serde(default)]` : ancien payload / tests → None → table Rust historique.
    #[serde(default)]
    pub webcam_radius: Option<f32>,
}

/// Rect normalisé 0..1 du cadre de sortie : x, y en haut-gauche ; width, height.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
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
    /// Identifiant stable — nécessaire pour apparier les régions adjacentes (connected pan).
    /// `#[serde(default)]` : champ ajouté après coup.
    #[serde(default)]
    pub id: String,
    /// Index du clip dont les temps source portent cette région. `None` garde la compatibilité
    /// avec les payloads antérieurs et déclenche le repli par chevauchement de fenêtre source.
    #[serde(default)]
    pub clip_index: Option<usize>,
    pub start_sec: f64,
    pub end_sec: f64,
    /// échelle cible (>1 = zoom avant).
    pub scale: f32,
    pub focus_x: f32,
    pub focus_y: f32,
    /// "manual" | "auto" (suit la télémétrie curseur) | null (= manual).
    #[serde(default)]
    pub focus_mode: Option<String>,
    /// "iso" | "left" | "right" | null.
    pub rotation: Option<String>,
}

/// Une zone de vitesse portée par le temps source d'un clip.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSpeedRegion {
    /// Index du clip dont les temps source portent cette région (voir `SceneZoomRegion`).
    #[serde(default)]
    pub clip_index: Option<usize>,
    pub start_sec: f64,
    pub end_sec: f64,
    pub speed: f64,
}

/// Une zone "Full Camera" de la timeline (temps en secondes) : la caméra PREND tout le cadre
/// pendant cette fenêtre (plein écran net — ni marge, ni arrondi, ni masque, ni fond derrière).
/// Pas de champs au-delà des bornes temporelles (miroir de `CameraFullscreenRegion`, TS).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneCameraFullscreenRegion {
    /// Index du clip dont les temps source portent cette région (voir `SceneZoomRegion`).
    #[serde(default)]
    pub clip_index: Option<usize>,
    pub start_sec: f64,
    pub end_sec: f64,
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
    /// `#[serde(default)]` : champ ajouté après coup, absent des JSON de test existants.
    #[serde(default)]
    pub speed_regions: Vec<SceneSpeedRegion>,
    /// `#[serde(default)]` : champ ajouté après coup, absent des JSON de test existants.
    #[serde(default)]
    pub camera_fullscreen_regions: Vec<SceneCameraFullscreenRegion>,
    pub cursor: SceneCursor,
    /// Crop écran par clip, dans le même ordre que `clips` (`cropByClip` côté TS).
    #[serde(default)]
    pub crop_by_clip: Vec<Option<SceneCrop>>,
    /// État de rendu interne, positionné par `for_clip_window` (jamais envoyé par l'app).
    #[serde(skip)]
    pub(crate) active_clip_index: usize,
    pub output: SceneOutput,
}

impl Scene {
    /// Parse le JSON produit par `buildSceneDescription` (TS).
    pub fn from_json(json: &str) -> anyhow::Result<Scene> {
        Ok(serde_json::from_str(json)?)
    }

    /// Copie de scène limitée aux régions du clip actif. `clipIndex` est l'identité fiable
    /// lorsque plusieurs clips réutilisent les mêmes temps source ; son absence retombe sur le
    /// chevauchement avec la fenêtre source pour accepter les anciens payloads.
    pub(crate) fn for_clip_window(
        &self,
        clip_index: usize,
        source_start_sec: f64,
        source_end_sec: f64,
    ) -> Scene {
        let belongs = |region_clip_index: Option<usize>, start_sec: f64, end_sec: f64| {
            let overlaps_window = end_sec > source_start_sec && start_sec < source_end_sec;
            overlaps_window && region_clip_index.map(|i| i == clip_index).unwrap_or(true)
        };
        let mut scene = self.clone();
        scene.zoom_regions.retain(|region| {
            belongs(region.clip_index, region.start_sec, region.end_sec)
        });
        scene.speed_regions.retain(|region| {
            belongs(region.clip_index, region.start_sec, region.end_sec)
        });
        scene.camera_fullscreen_regions.retain(|region| {
            belongs(region.clip_index, region.start_sec, region.end_sec)
        });
        scene.active_clip_index = clip_index;
        scene
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_minimal_scene_json() {
        let json = r##"{
            "clips": [{"screenPath":"/s.mp4","webcamPath":"/w.mp4","sourceStartSec":0,"sourceEndSec":4,"webcamOffsetSec":0,"hasAudio":true}],
            "layout": {"preset":"picture-in-picture","webcamSize":1.5,"webcamShape":"circle","webcamMirror":true,"webcamPosition":null,"webcamReactiveZoom":false},
            "effects": {"padding":0.5,"blur":true,"shadow":0.8,"roundnessPx":24,"motionBlur":0.0},
            "background": {"kind":"gradient","angleDeg":135,"stops":["#eaebed","#bcc0c6"]},
            "zoomRegions": [{"clipIndex":0,"startSec":1.0,"endSec":3.0,"scale":2.0,"focusX":0.5,"focusY":0.3,"rotation":"iso"}],
            "speedRegions": [{"clipIndex":0,"startSec":1.0,"endSec":2.0,"speed":2.0}],
            "cursor": {"show":true,"size":1,"smoothing":0.5,"motionBlur":0.2,"clickBounce":1,"clipToBounds":false,"theme":"default"},
            "cropByClip": [null],
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
        assert_eq!(scene.zoom_regions[0].clip_index, Some(0));
        assert_eq!(scene.speed_regions[0].speed, 2.0);
        assert!(scene.clips[0].has_audio);
        assert_eq!(scene.crop_by_clip.len(), 1);
        assert_eq!(scene.output.width, 1920);
    }

    #[test]
    fn parses_color_and_image_backgrounds() {
        let color = r##"{"clips":[],"layout":{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false},"effects":{"padding":0,"blur":false,"shadow":0,"roundnessPx":0,"motionBlur":0},"background":{"kind":"color","color":"#123456"},"zoomRegions":[],"cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"},"cropByClip":[],"output":{"width":1280,"height":720,"fps":30}}"##;
        let s = Scene::from_json(color).expect("parse color");
        match s.background {
            SceneBackground::Color { ref color } => assert_eq!(color, "#123456"),
            _ => panic!("expected color"),
        }
        assert_eq!(s.output.fps, Some(30.0));
    }

    #[test]
    fn parses_webcam_rect_payload() {
        // webcamRect est une fraction 0..1 du cadre de sortie ; sa présence doit désactiver
        // le fallback `preset_placements` Rust côté `compose_frame` (voir `compositor.rs`).
        let json = r##"{
            "clips": [],
            "layout": {
                "preset": "picture-in-picture",
                "webcamSize": 0.25,
                "webcamShape": "rounded",
                "webcamMirror": false,
                "webcamPosition": null,
                "webcamReactiveZoom": false,
                "webcamRect": { "x": 0.8125, "y": 0.8125, "width": 0.1666667, "height": 0.1666667 }
            },
            "effects": {"padding": 0, "blur": false, "shadow": 0, "roundnessPx": 24, "motionBlur": 0},
            "background": {"kind":"color","color":"#000000"},
            "zoomRegions": [],
            "cursor": {"show": true, "size": 1, "smoothing": 0, "motionBlur": 0, "clickBounce": 1, "clipToBounds": false, "theme": "default"},
            "cropByClip": [],
            "output": {"width": 1920, "height": 1080, "fps": null}
        }"##;
        let s = Scene::from_json(json).expect("parse w/ webcamRect");
        let r = s
            .layout
            .webcam_rect
            .expect("webcam_rect doit être présent pour ce payload");
        // bornes + ratio cohérent avec `computeCompositeLayout` (TS) pour le preset PiP @25%.
        assert!((0.0..=1.0).contains(&r.x) && (0.0..=1.0).contains(&r.y));
        assert!(r.width > 0.0 && r.width <= 1.0);
        assert!((r.width - r.height).abs() < 1e-5);
    }

    #[test]
    fn webcam_rect_field_optional_in_payload() {
        // L'ancien payload sans `webcamRect` doit toujours parser sans erreur (le champ est
        // `#[serde(default)]`) ; `webcam_rect` est alors None → fallback `preset_placements`.
        let json = r##"{"clips":[],"layout":{"preset":"picture-in-picture","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false},"effects":{"padding":0,"blur":false,"shadow":0,"roundnessPx":0,"motionBlur":0},"background":{"kind":"color","color":"#000000"},"zoomRegions":[],"cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"},"cropByClip":[],"output":{"width":1920,"height":1080,"fps":null}}"##;
        let s = Scene::from_json(json).expect("parse sans webcam_rect");
        assert!(s.layout.webcam_rect.is_none());
        assert_eq!(s.layout.preset, "picture-in-picture");
    }
}
