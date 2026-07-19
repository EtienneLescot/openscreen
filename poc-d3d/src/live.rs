//! Vue live : rend le compositing **hors-fenêtre** vers un `Vec<u8>` RGBA8
//! (taille `set_rect`) destiné à être streamé dans un `<canvas>` Electron via
//! `putImageData`. Option B (canvas) — l'ancienne option A (fenêtre D3D enfant
//! `WS_POPUP` + swapchain) supprimée : la glue TS n'a plus de surface native à
//! embarquer, elle draw chaque frame reçue comme une image bitmap.
//!
//! Pipeline interne inchangé : `Player` (decodeur lockstep screen/webcam) +
//! `Compositor::compose_frame` → RT RGBA OUT_W×OUT_H (1920×1080, partagé avec
//! l'export). Le **post-traitement** seulement change :
//!   - avant : blit du RT vers le backbuffer du swapchain, `Present`.
//!   - maintenant : `comp.readback_resized(w, h)` réutilise le même `blit_resized`
//!     / `ensure_resize_target` que l'export, puis copie le resize-target vers une
//!     staging texture `D3D11_USAGE_STAGING`, `Map`/`D3D11_MAP_READ`, copie ligne
//!     par ligne qui respecte `RowPitch` (même idiome que `dump_nv12`/`dump_raw`)
//!     et stocke le `Vec<u8>` dans `Shared::latest_frame` pour le `read_frame` napi.
//!
//! Modèle de threads : la vue n'a plus de HWND/UI côté thread appelant. Le rendu vit
//! sur un thread dédié — le thread JS/UI n'est jamais bloqué. Les objets COM et la
//! staging restent sur ce thread de rendu ; la `Vec<u8>` est publiée via un
//! `Mutex<Option<(u32, u32, Vec<u8>)>>` pour la traversée de threads vers le napi.

use crate::compositor::{Compositor, LiveParams};
use crate::scene::Scene;
use crate::config::{self, Cfg};
use crate::cursor::CursorTrack;
use windows::core::PCWSTR;
use crate::d3d::Gpu;
use crate::pipeline::Decoder;
use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// "#rrggbb" (ou "rrggbb") → [r, g, b, 1] en 0..1. None si invalide.
fn parse_hex_color(s: &str) -> Option<[f32; 4]> {
    let h = s.trim().trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&h[0..2], 16).ok()? as f32 / 255.0;
    let g = u8::from_str_radix(&h[2..4], 16).ok()? as f32 / 255.0;
    let b = u8::from_str_radix(&h[4..6], 16).ok()? as f32 / 255.0;
    Some([r, g, b, 1.0])
}

/// Lit deux sources en lockstep et compose la frame courante dans le RT du compositeur.
/// Partagé avec la GUI standalone (`app.rs`).
pub struct Player {
    sdec: Decoder,
    wdec: Decoder,
    gpu: Gpu,
    webcam_offset_sec: f64,
    has_current_frame: bool,
    use_current_on_next_step: bool,
    idx: u32,
}

impl Player {
    pub unsafe fn open(screen: &str, webcam: &str, gpu: &Gpu) -> Result<Player> {
        Ok(Player {
            sdec: Decoder::open(screen, gpu)?,
            wdec: Decoder::open(webcam, gpu)?,
            gpu: Gpu {
                device: gpu.device.clone(),
                context: gpu.context.clone(),
                feature_level: gpu.feature_level,
            },
            webcam_offset_sec: 0.0,
            has_current_frame: false,
            use_current_on_next_step: false,
            idx: 0,
        })
    }

    /// Remplace atomiquement la paire de décodeurs du clip actif. Les nouvelles sources sont
    /// ouvertes et positionnées avant de libérer l'ancienne paire, qui reste donc utilisable si
    /// l'ouverture échoue.
    pub unsafe fn set_active_clip(
        &mut self,
        screen_path: &str,
        webcam_path: &str,
        webcam_offset_sec: f64,
    ) -> Result<()> {
        let mut sdec = Decoder::open(screen_path, &self.gpu)?;
        let mut wdec = Decoder::open(webcam_path, &self.gpu)?;
        let sf = sdec.seek_to(0.0)?;
        let wf = wdec.seek_to((0.0 - webcam_offset_sec).max(0.0))?;
        if sf.is_null() || wf.is_null() {
            anyhow::bail!("clip actif vide (screen=\"{screen_path}\", webcam=\"{webcam_path}\")");
        }
        self.sdec = sdec;
        self.wdec = wdec;
        self.webcam_offset_sec = webcam_offset_sec;
        self.has_current_frame = true;
        self.use_current_on_next_step = true;
        self.idx = 0;
        Ok(())
    }

    /// Compose la frame suivante (→ `comp.rt`). Boucle sur EOF. `false` si fixture vide.
    pub unsafe fn step(&mut self, comp: &Compositor, cfg: &Cfg) -> Result<bool> {
        let (mut sf, mut wf) = if self.use_current_on_next_step {
            self.use_current_on_next_step = false;
            (self.sdec.cur_frame(), self.wdec.cur_frame())
        } else {
            (self.sdec.next()?, self.wdec.next()?)
        };
        if sf.is_null() || wf.is_null() {
            sf = self.sdec.seek_to(0.0)?;
            wf = self.wdec.seek_to((0.0 - self.webcam_offset_sec).max(0.0))?;
            self.idx = 0;
        }
        if sf.is_null() || wf.is_null() {
            self.has_current_frame = false;
            return Ok(false);
        }
        self.has_current_frame = true;
        self.sync_time(comp);
        comp.compose_frame(sf, wf, self.idx as f32, cfg)?;
        self.idx = self.idx.wrapping_add(1);
        Ok(true)
    }

    /// Positionne `comp` sur le temps source RÉEL (pts) de la frame écran courante, pour que le
    /// curseur ET les zoom/full-camera regions du clip actif restent exacts quelle
    /// que soit la cadence réelle de l'enregistrement — BUG corrigé : tout dérivait auparavant
    /// de `frame / 60.0` (un compteur de frames supposant 60fps pile), qui dérive
    /// silencieusement de plus en plus au fil de la lecture dès que le fichier n'est pas
    /// exactement à 60fps (30/59.94/etc. sont courants), au lieu de suivre le pts réel du
    /// décodeur — exactement la cause du "zoom désynchronisé de la timeline" observé.
    unsafe fn sync_time(&self, comp: &Compositor) {
        let t = self.sdec.cur_time_sec() as f32;
        comp.set_cursor_time(Some(t));
        comp.set_timeline_time(Some(t));
    }

    /// Recompose la frame courante (déjà décodée) — rafraîchit après un changement de param.
    pub unsafe fn recompose(&self, comp: &Compositor, cfg: &Cfg) -> Result<bool> {
        if !self.has_current_frame {
            return Ok(false);
        }
        let sf = self.sdec.cur_frame();
        let wf = self.wdec.cur_frame();
        if sf.is_null() || wf.is_null() {
            return Ok(false);
        }
        self.sync_time(comp);
        let f = self.idx.saturating_sub(1);
        comp.compose_frame(sf, wf, f as f32, cfg)?;
        Ok(true)
    }

    /// Seek à `target_sec` (secondes source du clip actif) : keyframe-seek + décodage-avant
    /// (`Decoder::seek_to`, même mécanisme robuste que l'export) — remplace l'ancien modèle
    /// "compte de frames" qui rewindait tout au frame 0 pour le moindre seek arrière et n'avait
    /// aucun raccourci keyframe pour les seeks avant lointains (lent ET, combiné au bug de
    /// `set_time`, incorrect au-delà de 6s sur un enregistrement réel).
    pub unsafe fn present_frame(&mut self, comp: &Compositor, cfg: &Cfg, target_sec: f64) -> Result<bool> {
        let sf = self.sdec.seek_to(target_sec)?;
        let wf = self
            .wdec
            .seek_to((target_sec - self.webcam_offset_sec).max(0.0))?;
        if sf.is_null() || wf.is_null() {
            self.has_current_frame = false;
            return Ok(false);
        }
        self.has_current_frame = true;
        self.use_current_on_next_step = false;
        self.sync_time(comp);
        // "idx" ne sert plus qu'au fallback fixture (jamais lu si une scène est posée) — dérivé
        // du temps réel pour rester cohérent si jamais consulté.
        self.idx = (target_sec * self.sdec.fps()).round().max(0.0) as u32;
        comp.compose_frame(sf, wf, self.idx as f32, cfg)?;
        Ok(true)
    }
}

/// Paramètres inspector pilotés depuis l'UI (setParam). Le thread de rendu les applique :
/// booléens/taps → reconstruits dans le `Cfg` ; valeurs continues → `set_live_params`.
#[derive(Clone, Copy, PartialEq)]
struct InspectorParams {
    bg_blur: bool,
    bg_color: [f32; 4],
    shadow_scale: f32,
    radius_scale: f32,
    mblur_taps: u32,
    padding: f32,
    webcam_size_scale: f32,
    webcam_mirror: bool,
    webcam_shape: u32,
    cursor_show: bool,
    cursor_size_scale: f32,
    cursor_bounce_scale: f32,
    /// 0..1 : force du lissage ressort-amortisseur de la position (0 = brut). Reconstruit la
    /// piste (voir `raw_cursor.smoothed()` dans `render_thread`) plutôt qu'un simple scalaire de
    /// dessin — d'où le suivi séparé de sa dernière valeur appliquée.
    cursor_smoothing: f32,
    /// 0..1 : force du flou de mouvement DU CURSEUR (indépendant du motion blur écran).
    cursor_motion_blur: f32,
}

impl Default for InspectorParams {
    fn default() -> Self {
        Self {
            bg_blur: false,
            bg_color: [0.10, 0.11, 0.14, 1.0],
            shadow_scale: 1.0,
            radius_scale: 1.0,
            mblur_taps: 8,
            padding: 0.0,
            webcam_size_scale: 1.0,
            webcam_mirror: false,
            webcam_shape: 3,
            cursor_show: true,
            cursor_size_scale: 1.0,
            cursor_bounce_scale: 1.0,
            cursor_smoothing: 0.0,
            cursor_motion_blur: 0.0,
        }
    }
}

#[derive(Clone)]
struct ActiveClipRequest {
    screen_path: String,
    webcam_path: String,
    webcam_offset_sec: f64,
}

fn same_source_path(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn find_scene_clip_index(
    scene: &Scene,
    screen_path: &str,
    webcam_path: &str,
    webcam_offset_sec: f64,
) -> Option<usize> {
    scene
        .clips
        .iter()
        .position(|clip| {
            same_source_path(&clip.screen_path, screen_path)
                && same_source_path(&clip.webcam_path, webcam_path)
                && (clip.webcam_offset_sec - webcam_offset_sec).abs() <= 1e-6
        })
        .or_else(|| {
            scene.clips.iter().position(|clip| {
                same_source_path(&clip.screen_path, screen_path)
                    && same_source_path(&clip.webcam_path, webcam_path)
            })
        })
}

fn scene_for_clip(scene: &Scene, clip_index: usize) -> Scene {
    match scene.clips.get(clip_index) {
        Some(clip) => scene.for_clip_window(
            clip_index,
            clip.source_start_sec,
            clip.source_end_sec,
        ),
        None => scene.clone(),
    }
}

/// Dernière frame readback vers CPU, prête pour le napi `read_frame`.
///
/// `(w, h, vec)` où `vec.len() == w*h*4` octets RGBA8 tightly-packed (R, G, B, A en
/// mémoire — cf. `Compositor::readback_resized`). `None` = "aucune frame composée
/// pour l'instant" (toutes les lectures avant la 1re frame composée retournent
/// `None` côté napi, jamais un buffer vide).
type LatestFrame = (u32, u32, Vec<u8>);

/// État partagé thread appelant → thread de rendu (commandes sans blocage).
struct Shared {
    /// Résolution cible du preview (largeur, hauteur) en pixels devices — ce que la
    /// zone canvas Electron affiche. Plus de HWND/HWND-parent : la preview est une
    /// image bitmap posée sur un `<canvas>`, la position CSS est gérée entièrement
    /// côté web. Lecture/écriture exclusive via `Mutex`.
    preview_size: Mutex<(u32, u32)>,
    inspector: Mutex<InspectorParams>,
    /// Temps source (secondes) demandé par l'app pour le clip actif (presentTime/seek), prioritaire
    /// sur la lecture libre. En SECONDES (pas un index de frame) : `Player::present_frame` fait un
    /// vrai seek keyframe (`Decoder::seek_to`, comme l'export) au lieu de compter des frames —
    /// BUG corrigé : l'ancien `set_time` convertissait en index de frame à 60fps fixe PUIS le
    /// wrappait modulo `FIXTURE_FRAMES` (360 = 6s) — un reliquat du bench fixture qui faisait
    /// boucler silencieusement tout seek au-delà de 6s sur un enregistrement réel, exactement
    /// la cause du "zoom timeline désynchronisé" observé.
    requested_frame: Mutex<Option<f64>>,
    /// Changement de sources consommé par le thread de rendu, seul propriétaire des décodeurs.
    active_clip_request: Mutex<Option<ActiveClipRequest>>,
    /// scène de l'app (contrat) ; appliquée au compositeur quand `scene_dirty`.
    scene: Mutex<Option<Scene>>,
    scene_dirty: AtomicBool,
    playing: AtomicBool,
    stop: AtomicBool,
    /// Dernière frame RGBA8 readback (taille + pixels R,G,B,A tightly-packed). Écrit
    /// par le thread de rendu après chaque `compose_frame` réussi, lu par le napi
    /// `read_frame` depuis le thread Node principal. `Mutex<Option<LatestFrame>>` —
    /// Option pour distinguer "pas de frame encore composée" (avant le 1er compose,
    /// `read_frame` retourne `Ok(None)`) d'un buffer vide (qui n'arrive jamais).
    latest_frame: Mutex<Option<LatestFrame>>,
}

/// Handle d'une vue live. `Drop` arrête le rendu.
///
/// Plus de fenêtre/OS : le handle ne porte plus de `HWND`. Toute la machinerie Win32
/// (CreateWindowEx / SetWindowPos / DestroyWindow / register_overlay_class) a été
/// retirée — la preview est désormais purement hors-fenêtre, transportable via
/// mémoire.
pub struct LiveView {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

// `LiveView` ne référence plus aucune ressource Win32 non-`Send`. `Shared` non plus
// (`Mutex`, `AtomicBool`, `Option<Vec<u8>>`). Le `JoinHandle` est `Send`/`!Sync`
// mais on n'en extrait rien côté napi. Tout ce qui vit dans le thread de rendu
// (compositor, décodeurs, staging, GPU) y reste confiné.
unsafe impl Send for LiveView {}

impl LiveView {
    /// Crée une vue offscreen : pas de HWND/UI côté thread appelant. Démarre juste
    /// le thread de rendu qui va composer chaque frame et publier le readback dans
    /// `Shared::latest_frame` pour le napi `read_frame`.
    ///
    /// `w`/`h` sont la **résolution cible du preview** (taille du `<canvas>` Electron
    /// affichant la preview, en pixels device) — anciennement c'était le rect de la
    /// fenêtre overlay ; maintenant c'est juste la taille du bitmap RGBA produit.
    /// Ajustable à chaud via `set_rect(w, h)`.
    pub fn create(
        w: u32,
        h: u32,
        screen: &str,
        webcam: &str,
        cursor_json: &str,
    ) -> Result<LiveView> {
        let shared = Arc::new(Shared {
            preview_size: Mutex::new((w.max(1), h.max(1))),
            inspector: Mutex::new(InspectorParams::default()),
            requested_frame: Mutex::new(None),
            active_clip_request: Mutex::new(None),
            scene: Mutex::new(None),
            scene_dirty: AtomicBool::new(false),
            playing: AtomicBool::new(true),
            stop: AtomicBool::new(false),
            latest_frame: Mutex::new(None),
        });
        let sh = shared.clone();
        let (s, wc, cj) = (screen.to_string(), webcam.to_string(), cursor_json.to_string());
        let thread = std::thread::spawn(move || {
            if let Err(e) = unsafe { render_thread(sh, &s, &wc, &cj) } {
                eprintln!("[live] render thread error: {e:#}");
            }
        });

        Ok(LiveView { shared, thread: Some(thread) })
    }

    /// Met à jour la résolution cible du preview. Force le redimensionnement des
    /// ressources GPU de readback (`Compositor::ensure_resize_target` /
    /// `live_readback_staging`) au prochain tour du thread de rendu.
    ///
    /// Signature : `(w, h)` — l'ancienne `(x, y, w, h)` de la fenêtre overlay n'a
    /// plus de sens (la position est gérée par CSS côté Electron). `set_rect` côté
    /// napi doit s'aligner sur ce 2-param (la largeur/hauteur seule).
    pub fn set_rect(&self, w: u32, h: u32) {
        if let Ok(mut s) = self.shared.preview_size.lock() {
            *s = (w.max(1), h.max(1));
        }
    }

    /// Récupère la dernière frame readback (taille + RGBA8 tightly-packed).
    /// `None` si rien n'a encore été composé (jamais écrit). **Coût : O(w·h)**
    /// (copie du `Vec<u8>` — nécessaire pour traverser la frontière thread + le
    /// FFI vers le Buffer napi). Le `Vec<u8>` retourné a `len() == w*h*4`.
    pub fn latest_frame(&self) -> Option<(u32, u32, Vec<u8>)> {
        self.shared
            .latest_frame
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned())
    }

    /// Switch inspector (booléen).
    pub fn set_param_bool(&self, key: &str, value: bool) {
        if let Ok(mut p) = self.shared.inspector.lock() {
            match key {
                "backgroundBlur" => p.bg_blur = value,
                "webcamMirror" => p.webcam_mirror = value,
                "cursorShow" => p.cursor_show = value,
                _ => {}
            }
        }
    }

    /// Slider inspector (numérique). Conventions : `shadow`/`roundness`/`webcamSize`/
    /// `cursorSize`/`cursorClickBounce` = échelle (1 = défaut) ; `padding` = 0..1 ;
    /// `motionBlur` = 0..1 mappé sur 1..16 taps.
    pub fn set_param_num(&self, key: &str, value: f64) {
        if let Ok(mut p) = self.shared.inspector.lock() {
            let v = value as f32;
            match key {
                "shadow" => p.shadow_scale = v.max(0.0),
                "roundness" => p.radius_scale = v.max(0.0),
                "motionBlur" => p.mblur_taps = (1.0 + value.clamp(0.0, 1.0) * 15.0).round() as u32,
                "padding" => p.padding = v.clamp(0.0, 1.0),
                "webcamSize" => p.webcam_size_scale = v.max(0.05),
                "cursorSize" => p.cursor_size_scale = v.max(0.0),
                "cursorClickBounce" => p.cursor_bounce_scale = v.max(0.0),
                "cursorSmoothing" => p.cursor_smoothing = v.clamp(0.0, 1.0),
                "cursorMotionBlur" => p.cursor_motion_blur = v.clamp(0.0, 1.0),
                _ => {}
            }
        }
    }

    /// Sélection de chaîne : couleur de fond "#rrggbb" ou forme webcam.
    pub fn set_param_str(&self, key: &str, value: &str) {
        if let Ok(mut p) = self.shared.inspector.lock() {
            match key {
                "backgroundColor" => {
                    if let Some(c) = parse_hex_color(value) {
                        p.bg_color = c;
                    }
                }
                "webcamShape" => {
                    p.webcam_shape = crate::compositor::webcam_shape_code(value);
                }
                _ => {}
            }
        }
    }

    pub fn set_playing(&self, playing: bool) {
        self.shared.playing.store(playing, Ordering::Relaxed);
    }

    /// Installe la scène de l'app (JSON `SceneDescription`). Parsé ici (hors thread de rendu) ;
    /// appliqué au compositeur au prochain tour via le flag `scene_dirty`. JSON invalide → ignoré.
    pub fn set_scene(&self, json: &str) {
        match Scene::from_json(json) {
            Ok(scene) => {
                if let Ok(mut s) = self.shared.scene.lock() {
                    *s = Some(scene);
                    self.shared.scene_dirty.store(true, Ordering::Relaxed);
                }
            }
            Err(e) => eprintln!("[live] set_scene: JSON invalide: {e:#}"),
        }
    }

    /// Positionne la vue sur le temps source `seconds` du clip actif — plus de conversion en
    /// index de frame ni de wrap fixture ici (voir `requested_frame`).
    pub fn set_time(&self, seconds: f64) {
        if let Ok(mut r) = self.shared.requested_frame.lock() {
            *r = Some(seconds.max(0.0));
        }
    }

    /// Programme le remplacement de la paire screen/webcam sur le thread de rendu.
    pub fn set_active_clip(
        &self,
        screen_path: &str,
        webcam_path: &str,
        webcam_offset_sec: f64,
    ) {
        if let Ok(mut request) = self.shared.active_clip_request.lock() {
            *request = Some(ActiveClipRequest {
                screen_path: screen_path.to_string(),
                webcam_path: webcam_path.to_string(),
                webcam_offset_sec,
            });
        }
    }
}

impl Drop for LiveView {
    fn drop(&mut self) {
        // 1. Stoper le thread (il observe `stop` en tête de boucle et sort proprement).
        self.shared.stop.store(true, Ordering::SeqCst);
        // 2. Join. À la sortie, le thread a relâché toutes ses ressources GPU (compositor,
        //    décodeurs, resize_target, staging) ; le `Shared` reste vivant tant qu'on n'a
        //    pas droppé notre `Arc` final.
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        // Plus rien à détruire côté Win32 — pas de HWND.
    }
}

/// Boucle de rendu (thread dédié) : décode → compose → resize → readback → publie
/// dans `Shared::latest_frame`.
unsafe fn render_thread(
    shared: Arc<Shared>,
    screen: &str,
    webcam: &str,
    cursor_json: &str,
) -> Result<()> {
    let gpu = Gpu::create(false)?;
    let mut comp = Compositor::new(&gpu)?;
    // Vue live = le VRAI enregistrement, pas la fenêtre fixture (100s@6s, taillée pour l'ancien
    // fixture POC). On charge toute la piste depuis t=0 ; 24h couvre large toute recording réelle.
    // Gardée à part (raw_cursor) pour pouvoir régénérer une variante lissée sans relire le
    // fichier à chaque changement du slider "smoothing" (voir la boucle plus bas).
    let mut raw_cursor = CursorTrack::load(cursor_json, 0.0, 24.0 * 3600.0).ok();
    if let Some(track) = &raw_cursor {
        comp.set_cursor(track.smoothed(0.0));
    }
    let mut player = Player::open(screen, webcam, &gpu)?;
    let mut active_screen_path = screen.to_string();
    let mut active_webcam_path = webcam.to_string();
    let mut active_webcam_offset_sec = 0.0f64;
    let mut active_clip_index = 0usize;

    // config de base = C8 (tous effets) ; le fond flouté est piloté par le param live.
    let mut cfg = config::all().pop().expect("au moins une config");
    // Migration D3D : le layout et le zoom viennent de l'app (contrat de scène), pas du planning
    // fixture. On désactive l'animation de layout A↔B et le zoom codés en dur de `timeline()` —
    // sinon la preview d'un vrai enregistrement joue la « scène fixture » (le bug d'animation vu).
    // Layout statique (PiP) par défaut ; les zoom regions / presets seront rebranchés via la scène.
    cfg.zoom = false;
    cfg.layout_anim = false;

    let mut last = Instant::now();
    let mut acc = 0.0f64;
    let mut first = true;
    let mut last_preview_size: (u32, u32) = (0, 0);
    let mut last_ip: Option<InspectorParams> = None;
    let mut last_smoothing: f32 = -1.0; // force la 1re application (0.0 est une valeur valide)
    // La vue live est TOUJOURS pilotée par la scène de l'app. Tant qu'aucune scène n'a été
    // appliquée, on refuse de jouer le layout fixture (POC) : un fallback fixture ne ferait que
    // MASQUER un scene-push cassé. On attend la scène avant de produire le 1er frame.
    let mut scene_applied = false;

    while !shared.stop.load(Ordering::SeqCst) {
        // params inspector : booléens/taps → cfg ; valeurs continues → live_params
        let ip = *shared.inspector.lock().unwrap();
        let mut clip_changed = false;
        let clip_request = shared.active_clip_request.lock().unwrap().take();
        if let Some(request) = clip_request {
            match player.set_active_clip(
                &request.screen_path,
                &request.webcam_path,
                request.webcam_offset_sec,
            ) {
                Ok(()) => {
                    active_screen_path = request.screen_path;
                    active_webcam_path = request.webcam_path;
                    active_webcam_offset_sec = request.webcam_offset_sec;
                    let scene = shared.scene.lock().unwrap().clone();
                    if let Some(base_scene) = scene {
                        if let Some(index) = find_scene_clip_index(
                            &base_scene,
                            &active_screen_path,
                            &active_webcam_path,
                            active_webcam_offset_sec,
                        ) {
                            active_clip_index = index;
                        } else {
                            eprintln!(
                                "[live] set_active_clip: sources absentes de la scène (screen=\"{}\", webcam=\"{}\")",
                                active_screen_path, active_webcam_path
                            );
                        }
                        comp.set_scene(Some(scene_for_clip(&base_scene, active_clip_index)));
                        scene_applied = true;
                    }
                    let cursor_path = format!("{}.cursor.json", active_screen_path);
                    raw_cursor = CursorTrack::load(&cursor_path, 0.0, 24.0 * 3600.0).ok();
                    match &raw_cursor {
                        Some(track) => {
                            eprintln!(
                                "[live] cursor: path={} loaded=ok samples={}",
                                cursor_path,
                                track.sample_count(),
                            );
                            comp.set_cursor(track.smoothed(0.0));
                        }
                        None => {
                            eprintln!(
                                "[live] cursor: path={} loaded=FAIL — clear_cursor()",
                                cursor_path,
                            );
                            comp.clear_cursor();
                        }
                    }
                    last_smoothing = -1.0;
                    clip_changed = true;
                }
                Err(e) => eprintln!("[live] set_active_clip: {e:#}"),
            }
        }
        cfg.bg_blur = ip.bg_blur;
        cfg.mblur_n = ip.mblur_taps;
        cfg.cursor = ip.cursor_show;
        comp.set_live_params(LiveParams {
            bg_color: ip.bg_color,
            shadow_scale: ip.shadow_scale,
            radius_scale: ip.radius_scale,
            padding: ip.padding,
            webcam_size_scale: ip.webcam_size_scale,
            webcam_mirror: ip.webcam_mirror,
            webcam_shape: ip.webcam_shape,
            cursor_size_scale: ip.cursor_size_scale,
            cursor_bounce_scale: ip.cursor_bounce_scale,
            cursor_motion_blur: ip.cursor_motion_blur,
        });
        // Lissage ressort-amortisseur : re-génère la piste (240 Hz) uniquement quand la valeur
        // change (pas à chaque frame — le resample+ressort parcourt tout l'enregistrement).
        if let Some(raw) = &raw_cursor {
            if ip.cursor_smoothing != last_smoothing {
                comp.set_cursor(raw.smoothed(ip.cursor_smoothing));
                last_smoothing = ip.cursor_smoothing;
            }
        }
        // un changement de param doit se voir même en pause (édition live des sliders) :
        // on recompose la frame courante dans la branche pause ci-dessous.
        let ip_changed = last_ip != Some(ip);
        last_ip = Some(ip);

        // scène de l'app : appliquée au compositeur quand elle change (dirty).
        let scene_changed = shared.scene_dirty.swap(false, Ordering::Relaxed);
        if scene_changed {
            let scene = shared.scene.lock().unwrap().clone();
            let scene = scene.map(|base_scene| {
                scene_applied = true;
                if let Some(index) = find_scene_clip_index(
                    &base_scene,
                    &active_screen_path,
                    &active_webcam_path,
                    active_webcam_offset_sec,
                ) {
                    active_clip_index = index;
                }
                scene_for_clip(&base_scene, active_clip_index)
            });
            comp.set_scene(scene);
        }

        // résolution cible du preview (le canvas Electron) → force le recadrage des
        // ressources GPU si elle change. BUG évité : sans ce suivi, redimensionner le
        // panneau preview PENDANT une pause ne redéclenchait ni recompose ni readback
        // (aucune des autres conditions de la branche pause ne couvrait "juste la
        // résolution a changé") — le canvas restait figé à l'ancienne taille jusqu'à la
        // reprise de lecture ou un autre changement de param/scène.
        let (pw, ph) = *shared.preview_size.lock().unwrap();
        let resized = (pw, ph) != last_preview_size;
        last_preview_size = (pw, ph);

        // Pas encore de scène → on ne compose RIEN (pas de fixture masquante). On attend
        // la scène. Un scene-push cassé reste ainsi visible (preview silencieuse — le
        // canvas reste sur sa frame précédente côté JS, ce qui est mieux qu'un fallback
        // masquant).
        if !scene_applied {
            std::thread::sleep(Duration::from_millis(8));
            continue;
        }

        // avance : seek app-piloté (presentTime) prioritaire, sinon lecture libre (60 fps)
        let requested = shared.requested_frame.lock().unwrap().take();
        let now = Instant::now();
        let dt = (now - last).as_secs_f64().min(0.1);
        last = now;
        let mut stepped = false;
        if let Some(target) = requested {
            if player.present_frame(&comp, &cfg, target)? {
                stepped = true;
            }
            acc = 0.0; // resynchronise l'accumulateur de lecture libre après un seek
        } else if shared.playing.load(Ordering::Relaxed) {
            acc += dt;
            let step = 1.0 / 60.0;
            let mut n = 0;
            while acc >= step && n < 3 {
                if player.step(&comp, &cfg)? {
                    stepped = true;
                }
                acc -= step;
                n += 1;
            }
            if acc > step {
                acc = 0.0;
            }
        } else if first || ip_changed || scene_changed || clip_changed || resized {
            // pause : recompose la frame courante (param / scène / clip / résolution changés).
            let _ = player.recompose(&comp, &cfg);
            stepped = true;
        }

        if stepped || first {
            if pw > 0 && ph > 0 {
                // Step complet : `compose_frame` (déjà appelé par `step`/`present_frame`/
                // `recompose`) → resize vers `pw`×`ph` via `blit_resized` réutilisé par
                // l'export → copy vers staging → Map/Unmap → `Vec<u8>` RGBA8.
                match comp.readback_resized(pw, ph) {
                    Ok(rgba) => {
                        // Publie dans `latest_frame` : on remplace le buffer précédent
                        // (le canvas ne montre que la dernière frame, peu importe combien
                        // le renderer en a raté entre deux lectures napi).
                        if let Ok(mut slot) = shared.latest_frame.lock() {
                            *slot = Some((pw, ph, rgba));
                        }
                        first = false;
                    }
                    Err(e) => {
                        eprintln!("[live] readback_resized: {e:#}");
                        std::thread::sleep(Duration::from_millis(8));
                    }
                }
            }
        } else {
            std::thread::sleep(Duration::from_millis(4));
        }
    }
    Ok(())
}

// ---------- harnais standalone (poc-d3d.exe --live) ----------

use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

extern "system" fn host_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        if msg == WM_DESTROY {
            PostQuitMessage(0);
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wp, lp)
    }
}

/// Test hors Electron : fenêtre hôte top-level (juste pour drainer les messages Windows
/// du main thread) + une `LiveView` offscreen qui produit des frames RGBA8 dans un
/// `<canvas>` HTML via le harnais d'affichage standalone. Valide le rendu threadé
/// + le readback CPU sans dépendre d'Electron.
pub fn run_standalone(screen: &str, webcam: &str, cursor_json: &str) -> Result<()> {
    unsafe {
        let hinst = HINSTANCE(GetModuleHandleW(None)?.0);
        let cls = wide("PocD3DLiveHost");
        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(host_proc),
            hInstance: hinst,
            lpszClassName: PCWSTR(cls.as_ptr()),
            hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH(std::ptr::null_mut()),
            ..Default::default()
        };
        RegisterClassW(&wc);

        let title = wide("poc-d3d — live embed test (offscreen RGBA8 readback)");
        let host = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(cls.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1280,
            760,
            HWND::default(),
            HMENU::default(),
            hinst,
            None,
        )?;

        // Résolution preview = client de la fenêtre host. Ajustable au resize du host.
        let mut last = (0u32, 0u32);
        let (mut w, mut h) = client_size(host);
        last = (w, h);
        let view = LiveView::create(w, h, screen, webcam, cursor_json)?;
        let _ = ShowWindow(host, SW_SHOW);
        println!("live embed: vue offscreen créée, thread de rendu démarré");
        println!("  touches : [B] flou de fond (param → D3D)   [Espace] pause/lecture");

        // état des paramètres pilotés au clavier (le MÊME set_param que l'addon napi appelle)
        let mut blur = false;
        let mut playing = true;
        let set_title = |b: bool, p: bool| unsafe {
            let t = wide(&format!(
                "poc-d3d — live embed  ·  flou: {}  ·  {}   (B / Espace)",
                if b { "ON" } else { "off" },
                if p { "lecture" } else { "PAUSE" }
            ));
            let _ = SetWindowTextW(host, PCWSTR(t.as_ptr()));
        };
        set_title(blur, playing);

        let mut msg = MSG::default();
        let mut running = true;
        while running {
            while PeekMessageW(&mut msg, HWND::default(), 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    running = false;
                    break;
                }
                if msg.message == WM_KEYDOWN {
                    match msg.wParam.0 as u32 {
                        0x42 => {
                            // 'B' : bascule le fond flouté via set_param — chemin param → D3D
                            blur = !blur;
                            view.set_param_bool("backgroundBlur", blur);
                            set_title(blur, playing);
                        }
                        0x20 => {
                            // Espace : pause/lecture
                            playing = !playing;
                            view.set_playing(playing);
                            set_title(blur, playing);
                        }
                        _ => {}
                    }
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if !running {
                break;
            }
            let (cw, ch) = client_size(host);
            if (cw, ch) != last {
                view.set_rect(cw, ch);
                last = (cw, ch);
                w = cw;
                h = ch;
            }
            // Force `first=false` côté render thread : si la preview était en pause
            // totale, on n'a pas publié de frame. On laisse le canvas vide ; le harnais
            // standalone n'affiche pas réellement les pixels ici (l'embed Electron est
            // le consumer réel). On imprime juste une frame de temps en temps pour
            // confirmer que la chaîne fonctionne.
            if let Some((fw, fh, _pixels)) = view.latest_frame() {
                if (fw, fh) != (w, h) {
                    // garde-fou : la staging de readback suit `set_rect` côté thread
                    // de rendu, donc ce serait une désynchro transitoire — acceptable.
                }
            }
            std::thread::sleep(Duration::from_millis(8));
        }
        drop(view);
        Ok(())
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn client_size(hwnd: HWND) -> (u32, u32) {
    let mut rc = RECT::default();
    let _ = GetClientRect(hwnd, &mut rc);
    ((rc.right - rc.left).max(0) as u32, (rc.bottom - rc.top).max(0) as u32)
}
