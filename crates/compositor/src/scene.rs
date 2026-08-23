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
    /// User-authored source crop for the camera. Absent keeps the full frame.
    #[serde(default)]
    pub webcam_crop: Option<SceneCrop>,
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
    /// Rayon des coins de l'écran, en FRACTION du petit côté de sa propre boîte, quand le preset
    /// en impose un (les layouts en bloc encadrent écran et caméra à l'identique). None → slider
    /// Roundness. Une fraction, pas des px : cf. `SceneEffects::roundness_frac`.
    #[serde(default)]
    pub screen_radius_frac: Option<f32>,
    /// L'écran doit-il REMPLIR sa boîte quitte à être rogné (`object-fit: cover`) plutôt que d'y
    /// tenir en entier ? Vrai pour les layouts en bloc, dont la boîte écran est un slot au ratio
    /// arbitraire : c'est ce que `computeCompositeLayout` renvoie sous `screenCover` et que
    /// `frameRenderer` applique déjà côté web. Sans ce drapeau le natif étirait la source pour
    /// remplir le slot — d'autant plus visible sur un clip recadré, le crop éloignant encore le
    /// ratio de la source de celui du slot.
    ///
    /// `#[serde(default)]` : absent → `false` → comportement "contain" historique.
    #[serde(default)]
    pub screen_cover: bool,
    /// Un layout résolu PAR CLIP visible, aligné par index sur `Scene::clips` / `crop_by_clip`.
    /// Les champs scalaires ci-dessus sont ceux du PREMIER clip (repli pour un payload sans ce
    /// tableau, et valeur de départ tant qu'aucun clip n'est actif).
    ///
    /// Par clip parce que la FORME de la source écran l'est : un clip est un enregistrement
    /// d'écran + une caméra et un son optionnels, et rien n'impose à deux clips d'avoir été
    /// enregistrés à la même taille ni au même ratio. Le crop n'est qu'une manière de plus de
    /// faire varier cette forme — un 16:9 recadré en 9:16 doit se disposer exactement comme un
    /// enregistrement nativement en 9:16. À ne pas confondre avec le ratio de la SCÈNE, global.
    ///
    /// `for_clip_window` recopie l'entrée du clip composé dans les champs scalaires, si bien que
    /// `compose_frame` continue de lire un seul `layout` sans branche supplémentaire.
    #[serde(default)]
    pub layout_by_clip: Vec<Option<ResolvedClipLayout>>,
    /// Rayon des coins de la CAMÉRA, en fraction du petit côté de SA boîte — même règle que
    /// `screen_radius_frac`, issu du même appel `computeCompositeLayout`. C'est la seule façon
    /// que « le bloc encadre écran et caméra à l'identique » soit vrai : sans lui l'écran prenait
    /// le rayon de l'app pendant que la caméra gardait la table Rust indépendante
    /// (`min * 0.5 | 0.3 | 0.12`, non bornée), donc deux moitiés d'un même bloc arrondies par
    /// deux formules différentes.
    ///
    /// `#[serde(default)]` : ancien payload / tests → None → table Rust historique.
    #[serde(default)]
    pub webcam_radius_frac: Option<f32>,
}

/// La moitié du layout qui dépend de la FORME de la source, résolue pour un clip.
/// Voir `SceneLayout::layout_by_clip`.
///
/// Les rayons sont des fractions du petit côté de LEUR boîte, exactement comme les champs
/// scalaires `screen_radius_frac`/`webcam_radius_frac` — aucune longueur ne traverse ce
/// contrat en pixels, par clip ou non.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedClipLayout {
    pub screen_rect: SceneRect,
    #[serde(default)]
    pub webcam_rect: Option<SceneRect>,
    #[serde(default)]
    pub screen_radius_frac: Option<f32>,
    #[serde(default)]
    pub webcam_radius_frac: Option<f32>,
    #[serde(default)]
    pub webcam_shape: Option<String>,
    #[serde(default)]
    pub screen_cover: bool,
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
    /// Slider Roundness, en FRACTION du petit côté du cadre de sortie.
    ///
    /// Toute longueur qui traverse ce contrat est une fraction, jamais un nombre de pixels, et
    /// c'est porteur : le compositeur rastérise la preview dans un cadre contain-fitté petit et
    /// l'export à la pleine résolution, donc « un pixel » ne désigne pas la même chose des deux
    /// côtés de la frontière. Des valeurs absolues la traversaient et signifiaient en silence
    /// « px du render target » — d'où le cercle PiP dégénéré en preview alors que l'export était
    /// juste, et l'ombre proportionnellement plus faible en 4K qu'en 1080p. Une fraction n'a
    /// pas d'unité à confondre : le natif multiplie par ce que sa référence mesure ici et
    /// maintenant.
    pub roundness_frac: f32,
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

/// Une annotation de la timeline (temps en secondes, source du clip).
///
/// Espace de coordonnées — à respecter au rendu : `x`/`y`/`w`/`h` sont des fractions du **rect
/// écran**, pas du cadre de sortie (le calque web reçoit `layout.screenRect` comme conteneur), et
/// elles ne subissent **pas** le crop de zoom : l'overlay est frère de l'élément qui porte la
/// transform, donc les annotations restent en place pendant que le contenu zoome dessous.
///
/// `space: "frame"` change cette boîte de référence pour le **cadre de sortie**. Seuls les
/// sous-titres l'envoient : une annotation est posée sur la vidéo visible et doit donc suivre le
/// rect écran, alors qu'un sous-titre appartient au cadre que le spectateur voit et doit rester
/// immobile quand le padding rétrécit l'image dessous (issue #396). La clé est absente pour les
/// annotations, dont la charge utile ne bouge pas d'un octet.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneAnnotation {
    #[serde(default)]
    pub id: String,
    /// Voir `SceneZoomRegion::clip_index`.
    #[serde(default)]
    pub clip_index: Option<usize>,
    pub start_sec: f64,
    pub end_sec: f64,
    /// "text" | "image" | "figure" | "blur".
    pub kind: String,
    /// `Some("frame")` = coordonnées rapportées au cadre de sortie ; absent ou toute autre
    /// valeur = rect écran, le comportement historique.
    ///
    /// Volontairement `Option<String>` et non une enum : serde refuse une variante inconnue
    /// d'une enum unitaire sans `#[serde(other)]`, donc un futur `"space":"safe-area"` ferait
    /// échouer `Scene::from_json` **en entier** sur un binaire plus ancien. En chaîne, l'inconnu
    /// retombe simplement sur le rect écran.
    #[serde(default)]
    pub space: Option<String>,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// Ordre de peinture ; l'app envoie déjà la liste triée croissante.
    #[serde(default)]
    pub z_index: i32,
    #[serde(default)]
    pub text: Option<SceneAnnotationText>,
    #[serde(default)]
    pub image_path: Option<String>,
    #[serde(default)]
    pub figure: Option<SceneAnnotationFigure>,
    #[serde(default)]
    pub blur: Option<SceneAnnotationBlur>,
}

impl SceneAnnotation {
    /// La boîte que `x`/`y`/`w`/`h` — **et** `text.font_size_rel` — mesurent, en fractions de
    /// sortie. Le cadre de sortie est la cible de rendu, donc `[0, 0, 1, 1]` par construction.
    ///
    /// Un seul point de décision, partagé par les trois backends : le rect ET le dénominateur de
    /// la police doivent basculer ensemble. Mesurer le rect sur le cadre en dimensionnant le texte
    /// sur le rect écran immobiliserait le sous-titre tout en continuant de rétrécir ses lettres
    /// avec le curseur de padding.
    pub fn anchor_rect(&self, screen_dst: [f32; 4]) -> [f32; 4] {
        match self.space.as_deref() {
            Some("frame") => [0.0, 0.0, 1.0, 1.0],
            _ => screen_dst,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneAnnotationText {
    pub content: String,
    /// Chaînes CSS, parsées ici comme la couleur de fond (`parse_hex`) ; "transparent" = pas de
    /// remplissage.
    pub color: String,
    pub background_color: String,
    /// Taille de police en **fraction de la hauteur du rect écran**, comme tout le reste de ce
    /// contrat : à multiplier par la hauteur du rect en pixels de sortie. La preview applique le
    /// même produit contre sa propre boîte (`annotationScale.ts`), donc preview et rendu
    /// s'accordent à n'importe quelle résolution.
    pub font_size_rel: f32,
    pub font_family: String,
    pub font_weight: String,
    pub font_style: String,
    pub text_decoration: String,
    pub text_align: String,
    /// Quelle arête du bloc de texte est épinglée à sa boîte : `"top"` / `"center"`
    /// / `"bottom"`. Absent = `"center"`, le comportement historique — les
    /// annotations n'émettent jamais la clé et ne bougent donc pas d'un pixel.
    /// Les sous-titres l'émettent pour que l'arête ancrée tienne quand le texte
    /// gagne une ligne (un bloc centré voit ses deux arêtes se déplacer).
    ///
    /// `Option<String>` et pas une enum, pour la même raison que `space` : serde
    /// rejette une variante d'unité inconnue, donc une valeur future ferait
    /// échouer `Scene::from_json` *en entier* sur un binaire plus ancien, au lieu
    /// de coûter un seul sous-titre mal placé.
    #[serde(default)]
    pub vertical_align: Option<String>,
    #[serde(default)]
    pub animation: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneAnnotationFigure {
    /// "up" | "down" | "left" | "right" | "up-right" | "up-left" | "down-right" | "down-left".
    pub direction: String,
    pub color: String,
    pub stroke_width: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneAnnotationBlur {
    /// "blur" | "mosaic".
    pub style: String,
    /// "rectangle" | "oval" | "freehand".
    pub shape: String,
    /// "white" | "black".
    pub color: String,
    pub intensity: f32,
    pub block_size: f32,
    /// Fractions du rect écran, même espace que le rect.
    #[serde(default)]
    pub freehand_points: Option<Vec<SceneAnnotationPoint>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SceneAnnotationPoint {
    pub x: f32,
    pub y: f32,
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
    /// id du thème (jeu de sprites) — informatif ici : le natif consomme `cursor_sprites`.
    pub theme: String,
    /// Sprites par état de curseur (`"arrow"`, `"text"`, `"pointer"`, `"resize-ew"`, …), chemins
    /// absolus résolus côté app (compositorViewService, même mécanisme que le wallpaper image).
    /// Le thème choisi n'y fournit que les états qu'il possède ; l'app complète le reste avec
    /// l'art intégrée, si bien qu'ici la table est TOUJOURS complète ou vide.
    ///
    /// Vide → curseur math dot+ring, qui n'est qu'un filet de sécurité : ce n'est PAS à quoi
    /// ressemble un pointeur système, et l'afficher en temps normal était le bug « le curseur
    /// par défaut est un point dans un cercle ».
    /// `#[serde(default)]` : champ ajouté après coup, absent des JSON de test existants.
    #[serde(default)]
    pub cursor_sprites: std::collections::HashMap<String, SceneCursorSprite>,
}

/// Un sprite de curseur : image + point de pivot.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneCursorSprite {
    /// Chemin absolu d'un PNG/JPEG déchiffrable par le crate `image`.
    pub path: String,
    /// Pivot en FRACTION de l'image (0..1), pas en pixels : le sprite est redimensionné au
    /// réglage « taille du curseur », et seule une fraction survit à cette mise à l'échelle.
    /// Un pivot centré (0.5, 0.5) imposé à tous les sprites décalait la pointe d'autant plus
    /// que le curseur était agrandi — le bug que ce champ corrige.
    pub hotspot_x: f32,
    pub hotspot_y: f32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneCrop {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Audio finishing. Deliberately limited to a linear gain — the one operation the editor
/// preview can apply identically to the source file it plays. See `audio::finish_audio`
/// before adding a field here; a sync offset was tried and removed.
///
/// The field carries `#[serde(default)]`: a payload from a build that predates it must
/// degrade to "that stage is neutral", not fail the whole scene.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneAudio {
    #[serde(default)]
    pub gain_db: f32,
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
    pub annotations: Vec<SceneAnnotation>,
    /// `#[serde(default)]` : champ ajouté après coup, absent des JSON de test existants.
    #[serde(default)]
    pub speed_regions: Vec<SceneSpeedRegion>,
    /// `#[serde(default)]` : champ ajouté après coup, absent des JSON de test existants.
    #[serde(default)]
    pub camera_fullscreen_regions: Vec<SceneCameraFullscreenRegion>,
    pub cursor: SceneCursor,
    /// Global audio finishing. Default keeps old scene payloads bit-for-bit compatible.
    #[serde(default)]
    pub audio: SceneAudio,
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
        scene.annotations.retain(|annotation| {
            belongs(annotation.clip_index, annotation.start_sec, annotation.end_sec)
        });
        // Le layout dépend de la FORME de la source du clip (dimensions natives × crop), qui
        // varie d'un clip à l'autre. On installe donc celui du clip composé dans les champs
        // scalaires : `compose_frame` continue de lire un seul `layout`, sans jamais avoir à
        // savoir qu'il en existe un par clip. Absent (payload ancien) → on garde les scalaires.
        if let Some(Some(l)) = scene.layout.layout_by_clip.get(clip_index).cloned() {
            scene.layout.screen_rect = Some(l.screen_rect);
            scene.layout.webcam_rect = l.webcam_rect;
            scene.layout.screen_radius_frac = l.screen_radius_frac;
            scene.layout.webcam_radius_frac = l.webcam_radius_frac;
            scene.layout.screen_cover = l.screen_cover;
            if let Some(shape) = l.webcam_shape {
                scene.layout.webcam_shape = shape;
            }
        }
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
            "effects": {"padding":0.5,"blur":true,"shadow":0.8,"roundnessFrac":0.0222,"motionBlur":0.0},
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
        assert!((scene.effects.roundness_frac - 0.0222).abs() < 1e-6);
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
        let color = r##"{"clips":[],"layout":{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false},"effects":{"padding":0,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0},"background":{"kind":"color","color":"#123456"},"zoomRegions":[],"cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"},"cropByClip":[],"output":{"width":1280,"height":720,"fps":30}}"##;
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
            "effects": {"padding": 0, "blur": false, "shadow": 0, "roundnessFrac": 0.0222, "motionBlur": 0},
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
        let json = r##"{"clips":[],"layout":{"preset":"picture-in-picture","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false},"effects":{"padding":0,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0},"background":{"kind":"color","color":"#000000"},"zoomRegions":[],"cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"},"cropByClip":[],"output":{"width":1920,"height":1080,"fps":null}}"##;
        let s = Scene::from_json(json).expect("parse sans webcam_rect");
        assert!(s.layout.webcam_rect.is_none());
        assert_eq!(s.layout.preset, "picture-in-picture");
    }
}

#[cfg(test)]
mod annotation_tests {
    use super::*;

    /// Enveloppe minimale valide + les annotations passées en paramètre.
    fn scene_json(annotations: &str) -> String {
        format!(
            r##"{{"clips":[],"layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0}},"background":{{"kind":"color","color":"#000000"}},"zoomRegions":[],"annotations":{annotations},"cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},"cropByClip":[],"output":{{"width":1920,"height":1080,"fps":30}}}}"##
        )
    }

    #[test]
    fn an_older_payload_without_annotations_still_parses() {
        // `#[serde(default)]` : tout JSON produit avant ce champ doit continuer à charger.
        let json = scene_json("[]").replace(r#""annotations":[],"#, "");
        let scene = Scene::from_json(&json).expect("parse sans annotations");
        assert!(scene.annotations.is_empty());
    }

    #[test]
    fn parses_a_text_annotation_with_its_style() {
        let json = scene_json(
            r##"[{"id":"ann1","clipIndex":0,"startSec":1.0,"endSec":3.0,"kind":"text","x":0.25,"y":0.5,"w":0.4,"h":0.1,"zIndex":2,"text":{"content":"Bonjour","color":"#ffffff","backgroundColor":"transparent","fontSizeRel":0.0296,"fontFamily":"Inter","fontWeight":"bold","fontStyle":"normal","textDecoration":"none","textAlign":"center","animation":"fade"}}]"##,
        );
        let scene = Scene::from_json(&json).expect("parse texte");
        let ann = &scene.annotations[0];
        assert_eq!(ann.kind, "text");
        assert_eq!(ann.clip_index, Some(0));
        assert_eq!(ann.z_index, 2);
        assert!((ann.x - 0.25).abs() < 1e-6 && (ann.h - 0.1).abs() < 1e-6);
        let text = ann.text.as_ref().expect("payload texte");
        assert_eq!(text.content, "Bonjour");
        assert_eq!(text.text_align, "center");
        assert_eq!(text.animation.as_deref(), Some("fade"));
        assert!(ann.figure.is_none() && ann.blur.is_none());
    }

    /// Le rect écran arbitraire des tests d'ancrage : décalé ET rétréci, comme un
    /// écran que le padding a rentré dans le cadre.
    const PADDED_SCREEN: [f32; 4] = [0.1, 0.1, 0.8, 0.8];

    fn annotation_with_space(space: &str) -> SceneAnnotation {
        let json = scene_json(&format!(
            r##"[{{"id":"a","startSec":0.0,"endSec":1.0,"kind":"text",{space}"x":0.25,"y":0.5,"w":0.4,"h":0.1,"zIndex":0}}]"##
        ));
        Scene::from_json(&json)
            .expect("parse annotation")
            .annotations
            .into_iter()
            .next()
            .expect("une annotation")
    }

    #[test]
    fn an_annotation_without_a_space_still_measures_against_the_screen_rect() {
        // Le champ est arrivé après coup : tout payload existant — et toute annotation,
        // qui n'en envoie jamais — doit garder l'ancrage historique.
        let ann = annotation_with_space("");
        assert!(ann.space.is_none());
        assert_eq!(ann.anchor_rect(PADDED_SCREEN), PADDED_SCREEN);
    }

    #[test]
    fn a_frame_space_annotation_measures_against_the_output_frame() {
        // C'est tout l'objet de l'issue #396 : le sous-titre ne bouge pas quand le
        // padding rentre l'écran, parce qu'il ne mesure plus l'écran.
        let ann = annotation_with_space(r#""space":"frame","#);
        assert_eq!(ann.space.as_deref(), Some("frame"));
        assert_eq!(ann.anchor_rect(PADDED_SCREEN), [0.0, 0.0, 1.0, 1.0]);
        // Et il tombe au même endroit quel que soit le rect écran.
        assert_eq!(ann.anchor_rect([0.3, 0.3, 0.4, 0.4]), ann.anchor_rect(PADDED_SCREEN));
    }

    #[test]
    fn an_unknown_space_falls_back_instead_of_failing_the_whole_scene() {
        // La raison du `Option<String>` : serde refuserait une variante inconnue d'une
        // enum unitaire et ferait échouer `from_json` EN ENTIER, donc un binaire plus
        // ancien perdrait la scène complète pour un mot qu'il ne connaît pas.
        let ann = annotation_with_space(r#""space":"safe-area","#);
        assert_eq!(ann.anchor_rect(PADDED_SCREEN), PADDED_SCREEN);
        // Un null explicite doit passer par la même porte.
        let nulled = annotation_with_space(r#""space":null,"#);
        assert!(nulled.space.is_none());
        assert_eq!(nulled.anchor_rect(PADDED_SCREEN), PADDED_SCREEN);
    }

    #[test]
    fn parses_figure_and_blur_payloads() {
        let json = scene_json(
            r##"[{"id":"f","startSec":0.0,"endSec":1.0,"kind":"figure","x":0.1,"y":0.1,"w":0.2,"h":0.2,"zIndex":0,"figure":{"direction":"up-left","color":"#34B27B","strokeWidth":6}},
                 {"id":"b","startSec":0.0,"endSec":1.0,"kind":"blur","x":0.0,"y":0.0,"w":0.5,"h":0.5,"zIndex":1,"blur":{"style":"mosaic","shape":"freehand","color":"black","intensity":8,"blockSize":16,"freehandPoints":[{"x":0.1,"y":0.2},{"x":0.3,"y":0.4}]}}]"##,
        );
        let scene = Scene::from_json(&json).expect("parse figure+blur");
        let figure = scene.annotations[0].figure.as_ref().expect("payload figure");
        assert_eq!(figure.direction, "up-left");
        assert!((figure.stroke_width - 6.0).abs() < 1e-6);
        let blur = scene.annotations[1].blur.as_ref().expect("payload blur");
        assert_eq!(blur.shape, "freehand");
        let points = blur.freehand_points.as_ref().expect("points");
        assert_eq!(points.len(), 2);
        assert!((points[1].x - 0.3).abs() < 1e-6);
    }

    #[test]
    fn for_clip_window_keeps_only_the_annotations_of_the_composed_clip() {
        // Même règle que les zoom/speed/camera regions : bon clip ET recouvrement de la fenêtre.
        let json = scene_json(
            r##"[{"id":"keep","clipIndex":0,"startSec":1.0,"endSec":2.0,"kind":"figure","x":0,"y":0,"w":0.1,"h":0.1,"zIndex":0},
                 {"id":"other-clip","clipIndex":1,"startSec":1.0,"endSec":2.0,"kind":"figure","x":0,"y":0,"w":0.1,"h":0.1,"zIndex":0},
                 {"id":"out-of-window","clipIndex":0,"startSec":50.0,"endSec":51.0,"kind":"figure","x":0,"y":0,"w":0.1,"h":0.1,"zIndex":0}]"##,
        );
        let scene = Scene::from_json(&json).expect("parse");
        let filtered = scene.for_clip_window(0, 0.0, 10.0);
        assert_eq!(
            filtered.annotations.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            vec!["keep"]
        );
    }
}
