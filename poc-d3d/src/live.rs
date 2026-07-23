//! Vue live : rend le compositing **hors-fenêtre** vers un `Vec<u8>` RGBA8
//! (taille `set_rect`) destiné à être streamé dans un `<canvas>` Electron via
//! `putImageData`. Option B (canvas) — l'ancienne option A (fenêtre D3D enfant
//! `WS_POPUP` + swapchain) supprimée : la glue TS n'a plus de surface native à
//! embarquer, elle draw chaque frame reçue comme une image bitmap.
//!
//! Pipeline interne : `Player` (decodeur lockstep screen/webcam) +
//! `Compositor::compose_frame` → RT RGBA rastérisé à la GÉOMÉTRIE DE RENDU (depuis la
//! refonte ratio : géométrie de sortie ramenée à la taille du panneau, plus le canvas
//! 16:9 figé d'avant). Le **post-traitement** :
//!   - avant : blit du RT vers le backbuffer du swapchain, `Present`.
//!   - maintenant : `comp.readback_direct()` copie le RT directement vers la staging
//!     `D3D11_USAGE_STAGING` (déjà dimensionnée à la résolution de rendu), `Map`/
//!     `D3D11_MAP_READ`, copie ligne par ligne qui respecte `RowPitch` (même idiome que
//!     `dump_nv12`/`dump_raw`), et stocke le `Vec<u8>` dans `Shared::latest_frame` pour
//!     le `read_frame` napi. Plus de resize intermédiaire (`blit_resized`) : le RT est
//!     déjà à la taille voulue, CSS met à l'échelle vers la boîte du panneau côté JS.
//!
//! Modèle de threads : la vue n'a plus de HWND/UI côté thread appelant. Le rendu vit
//! sur un thread dédié — le thread JS/UI n'est jamais bloqué. Les objets COM et la
//! staging restent sur ce thread de rendu ; la frame est publiée via un
//! `Mutex<Option<(u64 gen, u32 w, u32 h, Vec<u8>)>>` pour la traversée de threads vers
//! le napi — le `gen` est l'identité de la frame (cf. `LatestFrame`).

use crate::compositor::{Compositor, LiveParams};
use crate::regions::speed_at;
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

fn webcam_seek_time(screen_source_time_sec: f64, webcam_offset_sec: f64) -> f64 {
    (screen_source_time_sec - webcam_offset_sec).max(0.0)
}

/// Décodeurs déjà ouverts ET positionnés au bon playhead pour un clip à venir — le résultat
/// d'un préchargement en tâche de fond (voir `open_and_seek_clip`/`maybe_start_prefetch`
/// dans `render_thread`). Appliquer ceci à un `Player` (`apply_prefetched`) ne fait plus
/// aucune E/S : c'est ce qui rend la bascule à la frontière d'un clip instantanée au lieu de
/// payer un `Decoder::open` (ouverture fichier + parsing FFmpeg) synchrone pile au moment de
/// la transition — la pause perceptible observée en usage réel.
struct PrefetchedClip {
    sdec: Decoder,
    wdec: Decoder,
    webcam_offset_sec: f64,
    idx: u32,
    /// Piste curseur du clip à venir, préchargée ici pour la même raison que les décodeurs :
    /// sans ça, la bascule à la frontière restait synchrone sur CE point précis (lecture +
    /// parsing JSON du `.cursor.json`, potentiellement des milliers d'échantillons pour un
    /// enregistrement long) même après que le préchargement des décodeurs a supprimé le gros
    /// de la pause perceptible — un second petit accroc au même endroit, pour la même raison
    /// (une E/S synchrone pile à la frontière) qu'on venait de corriger pour les décodeurs.
    cursor_track: Option<CursorTrack>,
}

/// Ouvre + positionne la paire de décodeurs d'un clip (même travail que
/// `Player::set_active_clip`, mais autonome — sans instance `Player` existante, pour pouvoir
/// tourner sur un thread dédié pendant que le `Player` réel joue encore le clip actif).
unsafe fn open_and_seek_clip(
    screen_path: &str,
    webcam_path: &str,
    webcam_offset_sec: f64,
    source_time_sec: f64,
    gpu: &Gpu,
) -> Result<PrefetchedClip> {
    let source_time_sec = source_time_sec.max(0.0);
    let mut sdec = Decoder::open(screen_path, gpu)?;
    let mut wdec = match Decoder::open(webcam_path, gpu) {
        Ok(d) => d,
        Err(_) => Decoder::open(screen_path, gpu)?,
    };
    let sf = sdec.seek_to(source_time_sec)?;
    let mut wf = wdec.seek_to(webcam_seek_time(source_time_sec, webcam_offset_sec))?;
    if wf.is_null() {
        wf = wdec.seek_to(0.0)?;
    }
    if sf.is_null() {
        anyhow::bail!("clip préchargé vide au temps source {source_time_sec:.3}s (screen=\"{screen_path}\")");
    }
    let idx = (source_time_sec * sdec.fps()).round().max(0.0) as u32;
    let cursor_track = CursorTrack::load(&format!("{screen_path}.cursor.json"), 0.0, 24.0 * 3600.0).ok();
    Ok(PrefetchedClip { sdec, wdec, webcam_offset_sec, idx, cursor_track })
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
        let wdec = match Decoder::open(webcam, gpu) {
            Ok(d) => d,
            Err(_) => Decoder::open(screen, gpu)?,
        };
        Ok(Player {
            sdec: Decoder::open(screen, gpu)?,
            wdec,
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
    /// ouvertes et positionnées au playhead source courant avant de libérer l'ancienne paire.
    /// Synchrone (bloque le thread appelant le temps de l'ouverture) — `render_thread` préfère
    /// `apply_prefetched` quand un préchargement en tâche de fond est déjà prêt ; ceci reste le
    /// repli correct dans tous les autres cas (changement de clip explicite depuis l'app,
    /// préchargement pas encore prêt, etc).
    pub unsafe fn set_active_clip(
        &mut self,
        screen_path: &str,
        webcam_path: &str,
        webcam_offset_sec: f64,
        source_time_sec: f64,
    ) -> Result<()> {
        let prefetched =
            open_and_seek_clip(screen_path, webcam_path, webcam_offset_sec, source_time_sec, &self.gpu)?;
        self.apply_prefetched(prefetched);
        Ok(())
    }

    /// Bascule instantanément sur une paire de décodeurs déjà ouverte + positionnée — aucune
    /// E/S ici, juste l'échange des champs. Utilisé par `set_active_clip` (juste après son
    /// propre `open_and_seek_clip`) et directement par `render_thread` quand un préchargement
    /// en tâche de fond est déjà prêt au moment de franchir la frontière du clip.
    unsafe fn apply_prefetched(&mut self, prefetched: PrefetchedClip) {
        self.sdec = prefetched.sdec;
        self.wdec = prefetched.wdec;
        self.webcam_offset_sec = prefetched.webcam_offset_sec;
        self.has_current_frame = true;
        self.use_current_on_next_step = true;
        self.idx = prefetched.idx;
    }

    /// Temps source courant du décodeur écran — utilisé par `render_thread` pour détecter le
    /// franchissement de la fin de fenêtre du clip actif pendant la lecture libre.
    pub(crate) unsafe fn screen_time_sec(&self) -> f64 {
        self.sdec.cur_time_sec()
    }

    /// Compose la frame suivante (→ `comp.rt`). Boucle sur EOF. `false` si fixture vide.
    ///
    /// L'écran pilote la cadence (1 frame/tick) ; la webcam suit son PROPRE temps source
    /// (`screen_time - webcam_offset_sec`), pas un pas 1:1 avec l'écran — BUG corrigé : les
    /// deux décodeurs avançaient d'exactement une frame par tick chacun, quelle que soit leur
    /// cadence réelle. Écran et webcam sont capturés par des pipelines indépendants (souvent
    /// à des fps différents), donc la webcam jouait 2× trop vite dès que sa cadence était
    /// inférieure à celle de l'écran. Même logique que `advance_decoder_to` (pipeline.rs),
    /// déjà correcte côté export — la preview live ne l'avait jamais reprise. La webcam boucle
    /// aussi de façon INDÉPENDANTE à son propre EOF (un clip webcam plus court que l'écran ne
    /// doit pas réinitialiser le décodeur écran).
    pub unsafe fn step(&mut self, comp: &Compositor, cfg: &Cfg) -> Result<bool> {
        let use_current = self.use_current_on_next_step;
        self.use_current_on_next_step = false;

        let mut sf = if use_current {
            self.sdec.cur_frame()
        } else {
            self.sdec.next()?
        };
        if sf.is_null() {
            sf = self.sdec.seek_to(0.0)?;
            self.idx = 0;
        }
        if sf.is_null() {
            self.has_current_frame = false;
            return Ok(false);
        }

        let target_webcam_t = (self.sdec.cur_time_sec() - self.webcam_offset_sec).max(0.0);
        let mut wf = if use_current {
            self.wdec.cur_frame()
        } else {
            let cur = self.wdec.cur_frame();
            if cur.is_null() {
                // Jamais décodée (nouvelle ouverture) : on saute directement au temps synchronisé.
                self.wdec.seek_to(target_webcam_t)?
            } else {
                // Rattrape la webcam vers `target_webcam_t`, au pire une poignée de frames par
                // tick (fps proches) — le garde-fou n'existe que contre un cas pathologique.
                let mut wf = cur;
                let mut guard = 0u32;
                while self.wdec.cur_time_sec() < target_webcam_t {
                    match self.wdec.next()? {
                        f if f.is_null() => {
                            // Fin de la webcam avant l'écran : elle boucle SEULE — l'écran
                            // garde sa propre position, inchangée.
                            wf = self.wdec.seek_to(0.0)?;
                            break;
                        }
                        f => wf = f,
                    }
                    guard += 1;
                    if guard > 1000 {
                        break;
                    }
                }
                wf
            }
        };
        if wf.is_null() {
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
            .seek_to(webcam_seek_time(target_sec, self.webcam_offset_sec))?;
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
    /// Identité dans le flux `Scene.clips` trié (les chemins ne suffisent pas pour un asset partagé).
    clip_index: usize,
    /// Playhead exprimé sur l'horloge source écran du nouveau clip.
    source_time_sec: f64,
}

fn same_source_path(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn scene_clip_matches(
    clip: &crate::scene::SceneClip,
    screen_path: &str,
    webcam_path: &str,
    webcam_offset_sec: f64,
) -> bool {
    same_source_path(&clip.screen_path, screen_path)
        && same_source_path(&clip.webcam_path, webcam_path)
        && (clip.webcam_offset_sec - webcam_offset_sec).abs() <= 1e-6
}

fn find_scene_clip_index(
    scene: &Scene,
    screen_path: &str,
    webcam_path: &str,
    webcam_offset_sec: f64,
) -> Option<usize> {
    scene.clips.iter()
        .position(|clip| scene_clip_matches(clip, screen_path, webcam_path, webcam_offset_sec))
        .or_else(|| scene.clips.iter().position(|clip| {
            same_source_path(&clip.screen_path, screen_path)
                && same_source_path(&clip.webcam_path, webcam_path)
        }))
}

/// Paths and the asset-level webcam offset are identical for multiple cuts of one recording,
/// so path lookup alone always returns clip 0. Prefer the explicit timeline identity.
fn resolve_scene_clip_index(
    scene: &Scene,
    requested_clip_index: usize,
    screen_path: &str,
    webcam_path: &str,
    webcam_offset_sec: f64,
) -> Option<usize> {
    if scene.clips.get(requested_clip_index)
        .is_some_and(|clip| scene_clip_matches(clip, screen_path, webcam_path, webcam_offset_sec))
    {
        Some(requested_clip_index)
    } else {
        find_scene_clip_index(scene, screen_path, webcam_path, webcam_offset_sec)
    }
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
/// `(gen, w, h, vec)` où `vec.len() == w*h*4` octets RGBA8 tightly-packed (R, G, B, A
/// en mémoire — cf. `Compositor::readback_resized`). `gen` est une génération monotone
/// (≥ 1, `0` réservé à « le consommateur n'a encore rien vu ») incrémentée à CHAQUE
/// publication, càd uniquement quand une nouvelle frame a réellement été composée (le
/// thread de rendu ne republie pas une frame identique — cf. `stepped || first`). Elle
/// est l'IDENTITÉ de la frame : le consommateur (`read_frame`) ne repaie le clone + l'IPC
/// que lorsqu'elle change. `None` = "aucune frame composée pour l'instant" (toutes les
/// lectures avant la 1re frame composée retournent `None` côté napi, jamais un buffer vide).
type LatestFrame = (u64, u32, u32, Vec<u8>);

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

    /// Récupère la dernière frame readback (gen + taille + RGBA8 tightly-packed).
    /// `None` si rien n'a encore été composé (jamais écrit). **Coût : O(w·h)**
    /// (copie du `Vec<u8>` — nécessaire pour traverser la frontière thread + le
    /// FFI vers le Buffer napi). Le `Vec<u8>` retourné a `len() == w*h*4`.
    /// Préférer `latest_frame_since` sur le chemin chaud : il évite ce clone quand
    /// le consommateur possède déjà la génération courante.
    pub fn latest_frame(&self) -> Option<(u64, u32, u32, Vec<u8>)> {
        self.shared
            .latest_frame
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned())
    }

    /// Récupère la dernière frame UNIQUEMENT si sa génération est postérieure à
    /// `since_gen`. `None` couvre les DEUX cas où le consommateur n'a rien à peindre :
    ///   - rien n'a encore été composé (aucune frame publiée), ou
    ///   - il possède déjà la génération courante (`gen <= since_gen`).
    /// Dans ce second cas — l'essentiel du temps d'édition, preview en pause sur une
    /// frame figée — on n'exécute PAS le clone `O(w·h)` : c'est tout l'intérêt du
    /// compteur. Le consommateur passe la dernière génération qu'il a peinte (`0` au
    /// départ) ; `None` ⇒ il ne fait rien, `Some` ⇒ il peint et retient `gen`.
    pub fn latest_frame_since(&self, since_gen: u64) -> Option<(u64, u32, u32, Vec<u8>)> {
        let guard = self.shared.latest_frame.lock().ok()?;
        match guard.as_ref() {
            Some((gen, w, h, px)) if *gen > since_gen => Some((*gen, *w, *h, px.clone())),
            _ => None,
        }
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

    /// Programme le remplacement de la paire screen/webcam sur le thread de rendu. L'identité
    /// du clip et son playhead source voyagent avec les chemins pour rendre le switch atomique.
    pub fn set_active_clip(
        &self,
        screen_path: &str,
        webcam_path: &str,
        webcam_offset_sec: f64,
        clip_index: usize,
        source_time_sec: f64,
    ) {
        if let Ok(mut request) = self.shared.active_clip_request.lock() {
            *request = Some(ActiveClipRequest {
                screen_path: screen_path.to_string(),
                webcam_path: webcam_path.to_string(),
                webcam_offset_sec,
                clip_index,
                source_time_sec: source_time_sec.max(0.0),
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

/// Un préchargement en cours : quel `next_index` (dans `Scene.clips`) il prépare, et le canal
/// par lequel le thread de fond livre le résultat une fois prêt.
type PendingPrefetch = (usize, std::sync::mpsc::Receiver<Result<PrefetchedClip>>);

/// Combien de secondes avant la fin du clip actif on lance le préchargement du suivant en
/// tâche de fond. Assez large pour couvrir un `Decoder::open` typique (ouverture fichier +
/// `avformat_find_stream_info` + init D3D11VA), assez court pour ne pas garder deux paires de
/// décodeurs ouvertes plus longtemps que nécessaire.
const PREFETCH_LEAD_SEC: f64 = 0.75;

/// Démarre le préchargement du clip suivant sur un thread dédié dès qu'on entre dans la
/// fenêtre `PREFETCH_LEAD_SEC` avant la fin du clip actif — pour que la bascule à la
/// frontière (`advance_to_next_scene_clip`) trouve les décodeurs déjà ouverts et positionnés
/// au lieu de payer l'E/S + le parsing FFmpeg sur le thread de rendu pile au moment de la
/// transition (la pause perceptible observée en usage réel). No-op si un préchargement est
/// déjà en cours, ou pour une scène à 1 clip (voir `advance_to_next_scene_clip`).
unsafe fn maybe_start_prefetch(
    scene: &Scene,
    active_clip_index: usize,
    screen_time_sec: f64,
    gpu: &Gpu,
    prefetch: &mut Option<PendingPrefetch>,
) {
    if scene.clips.len() <= 1 || prefetch.is_some() {
        return;
    }
    let Some(clip) = scene.clips.get(active_clip_index) else {
        return;
    };
    let remaining = clip.source_end_sec - screen_time_sec;
    if !(0.0..PREFETCH_LEAD_SEC).contains(&remaining) {
        return;
    }
    let next_index = if active_clip_index + 1 < scene.clips.len() {
        active_clip_index + 1
    } else {
        0
    };
    let next_clip = scene.clips[next_index].clone();
    // Copie légère (COM refcount, pas de nouveau device) — même motif que `Player::open`.
    let gpu_clone = Gpu {
        device: gpu.device.clone(),
        context: gpu.context.clone(),
        feature_level: gpu.feature_level,
    };
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = unsafe {
            open_and_seek_clip(
                &next_clip.screen_path,
                &next_clip.webcam_path,
                next_clip.webcam_offset_sec,
                next_clip.source_start_sec,
                &gpu_clone,
            )
        };
        // L'appelant a pu abandonner ce préchargement entre-temps (changement de clip
        // explicite, scène remplacée) — un receiver droppé fait juste échouer `send`
        // silencieusement ; les décodeurs déjà ouverts sont libérés normalement (`Drop`).
        let _ = tx.send(result);
    });
    *prefetch = Some((next_index, rx));
}

/// Bascule le `Player` + le compositeur sur le clip suivant de `scene` (reboucle sur le
/// premier après le dernier). No-op pour une scène à 1 clip (le bouclage léger existant de
/// `Player::step` suffit et coûte moins cher qu'un `set_active_clip` — reopen des décodeurs).
///
/// Partagée entre le déclenchement PROACTIF (seuil `source_end_sec` franchi) et le filet de
/// sécurité RÉACTIF de `render_thread` (le temps du décodeur a reculé — `Player::step` a
/// bouclé sur l'EOF RÉEL du fichier avant que le seuil ne soit jamais atteint : cas d'un clip
/// NON trimmé dont la dernière frame réelle a un PTS strictement inférieur au
/// `source_end_sec` déclaré, qui égale alors la durée totale du fichier — le seuil `>=` ne se
/// déclenche jamais dans ce cas, d'où le "ça boucle sur le 1er clip" observé malgré le
/// déclenchement proactif).
///
/// Si `maybe_start_prefetch` a eu le temps de préparer ce même `next_index` à l'avance, la
/// bascule est instantanée (juste un échange de champs, `Player::apply_prefetched`) ; sinon
/// on retombe sur l'ouverture synchrone habituelle (`Player::set_active_clip`) — correct dans
/// tous les cas, juste plus lent quand le préchargement n'a pas eu le temps de finir.
#[allow(clippy::too_many_arguments)]
unsafe fn advance_to_next_scene_clip(
    player: &mut Player,
    comp: &Compositor,
    scene: &Scene,
    prefetch: &mut Option<PendingPrefetch>,
    active_screen_path: &mut String,
    active_webcam_path: &mut String,
    active_webcam_offset_sec: &mut f64,
    active_clip_index: &mut usize,
    raw_cursor: &mut Option<CursorTrack>,
    last_smoothing: &mut f32,
) {
    if scene.clips.len() <= 1 {
        return;
    }
    let next_index = if *active_clip_index + 1 < scene.clips.len() {
        *active_clip_index + 1
    } else {
        0
    };
    let next_clip = &scene.clips[next_index];

    // N'importe quel préchargement en cours ne concerne plus que CETTE frontière (on vient
    // de la franchir, bien ou mal ciblée) — on le consomme s'il correspond, on l'abandonne
    // sinon, dans tous les cas il ne doit pas survivre à cet appel.
    let ready = prefetch.take().and_then(|(idx, rx)| {
        if idx == next_index { rx.try_recv().ok() } else { None }
    });

    // Le curseur préchargé (voir `PrefetchedClip::cursor_track`) doit être extrait AVANT de
    // passer `prefetched` (par valeur) à `apply_prefetched`, qui ne s'occupe que des
    // décodeurs — sinon ce champ serait silencieusement perdu avec le reste de la struct.
    let prefetched_cursor: Option<Option<CursorTrack>> = match &ready {
        Some(Ok(p)) => Some(p.cursor_track.clone()),
        _ => None,
    };

    let applied = match ready {
        Some(Ok(prefetched)) => {
            player.apply_prefetched(prefetched);
            Ok(())
        }
        Some(Err(e)) => {
            eprintln!("[live] préchargement du clip suivant: {e:#} — repli sur ouverture synchrone");
            player.set_active_clip(
                &next_clip.screen_path,
                &next_clip.webcam_path,
                next_clip.webcam_offset_sec,
                next_clip.source_start_sec,
            )
        }
        None => player.set_active_clip(
            &next_clip.screen_path,
            &next_clip.webcam_path,
            next_clip.webcam_offset_sec,
            next_clip.source_start_sec,
        ),
    };

    match applied {
        Ok(()) => {
            *active_screen_path = next_clip.screen_path.clone();
            *active_webcam_path = next_clip.webcam_path.clone();
            *active_webcam_offset_sec = next_clip.webcam_offset_sec;
            *active_clip_index = next_index;
            comp.set_scene(Some(scene_for_clip(scene, *active_clip_index)));
            // Réutilise le curseur préchargé s'il est disponible (voir plus haut) — sinon
            // (préchargement pas encore prêt / raté) on retombe sur la lecture synchrone
            // habituelle, comme avant cette optimisation.
            *raw_cursor = match prefetched_cursor {
                Some(track) => track,
                None => {
                    let cursor_path = format!("{}.cursor.json", active_screen_path);
                    CursorTrack::load(&cursor_path, 0.0, 24.0 * 3600.0).ok()
                }
            };
            match raw_cursor {
                Some(track) => comp.set_cursor(track.smoothed(0.0)),
                None => comp.clear_cursor(),
            }
            *last_smoothing = -1.0;
        }
        Err(e) => eprintln!("[live] auto-advance clip: {e:#}"),
    }
}

/// Taille à laquelle la preview doit rastériser : la **géométrie de sortie** (donc
/// le ratio réel de l'export — la preview doit montrer ce qui sera rendu), ramenée
/// à ce que le canvas affiche réellement.
///
/// Deux bornes, pour deux raisons distinctes :
///   - jamais plus grand que le **panneau** : les pixels en trop seraient réduits
///     dans la foulée par `readback_resized`, c'est du coût pur (sur un projet 4K
///     ce serait 8 Mpx rastérisés pour un canvas qui en affiche moins d'un) ;
///   - jamais plus grand que la **sortie** : au-delà, la preview serait plus
///     détaillée que l'export, donc mensongère.
///
/// Sans scène, on ne connaît pas encore le ratio : on prend la taille du panneau
/// telle quelle (aucune composition n'a lieu tant que la scène n'est pas posée).
fn preview_render_size(scene: Option<&Scene>, pw: u32, ph: u32) -> (u32, u32) {
    let (pw, ph) = (pw.max(2), ph.max(2));
    let Some(scene) = scene else {
        return (pw, ph);
    };
    let (ow, oh) = (scene.output.width.max(1) as f64, scene.output.height.max(1) as f64);
    // "contain" : le plus grand cadre au ratio de sortie qui tienne dans le panneau.
    let scale = (pw as f64 / ow).min(ph as f64 / oh).min(1.0);
    // Arrondi via la MÊME règle que `new_sized` : la boucle de rendu compare cette
    // taille à `comp.render_size()` (qui renvoie la valeur arrondie) pour décider de
    // reconstruire. Sans ce passage par `normalize_render_size`, une cible impaire
    // ne serait jamais égalée → reconstruction du compositeur à chaque frame.
    Compositor::normalize_render_size((ow * scale).round() as u32, (oh * scale).round() as u32)
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
    // Copie de la Scene complète (tous les clips), tenue à jour à chaque push de l'app —
    // permet à la boucle de lecture libre de connaître la fenêtre source
    // [source_start_sec, source_end_sec) du clip actif et d'enchaîner elle-même sur le
    // clip suivant (voir plus bas), sans dépendre d'un aller-retour JS par frontière de
    // clip : la timeline est un niveau d'abstraction AU-DESSUS des clips, elle se lit
    // dans son entièreté et l'utilisateur ne doit jamais remarquer la frontière.
    let mut full_scene: Option<Scene> = None;
    // Préchargement du clip suivant en cours (voir `maybe_start_prefetch`) — `None` la
    // plupart du temps, `Some` seulement dans la fenêtre `PREFETCH_LEAD_SEC` avant une
    // frontière de clip. Invalidé (mis à `None`) dès que le contexte qui l'a déclenché
    // devient obsolète (nouvelle scène, changement de clip explicite) pour ne jamais risquer
    // d'appliquer les décodeurs d'un préchargement qui ne correspond plus à la situation.
    let mut prefetch: Option<PendingPrefetch> = None;

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
            // Un changement de clip explicite depuis l'app rend obsolète tout préchargement
            // en cours (il visait la suite du clip qu'on est en train de quitter maintenant
            // autrement) — sans ça, `advance_to_next_scene_clip` pourrait plus tard appliquer
            // des décodeurs qui ne correspondent plus au contexte réel.
            prefetch = None;
            match player.set_active_clip(
                &request.screen_path,
                &request.webcam_path,
                request.webcam_offset_sec,
                request.source_time_sec,
            ) {
                Ok(()) => {
                    active_screen_path = request.screen_path;
                    active_webcam_path = request.webcam_path;
                    active_webcam_offset_sec = request.webcam_offset_sec;
                    let scene = shared.scene.lock().unwrap().clone();
                    full_scene = scene.clone();
                    if let Some(base_scene) = scene {
                        if let Some(index) = resolve_scene_clip_index(
                            &base_scene,
                            request.clip_index,
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
        // TS falls `webcamPath` back to the screen asset's own path when a clip has no real
        // camera (so the decoder pipeline always has something valid to open) — if we drew the
        // PiP box in that case it would just duplicate the screen video into its own corner.
        // `same_source_path` already exists for exactly this comparison (scene/clip matching).
        let has_real_webcam = !same_source_path(&active_webcam_path, &active_screen_path);
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
            has_webcam: has_real_webcam,
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
            // La nouvelle scène peut avoir réordonné/modifié les clips — tout index visé par
            // un préchargement en cours n'est plus fiable.
            prefetch = None;
            let scene = shared.scene.lock().unwrap().clone();
            full_scene = scene.clone();
            let scene = scene.map(|base_scene| {
                scene_applied = true;
                if let Some(index) = resolve_scene_clip_index(
                    &base_scene,
                    active_clip_index,
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

        // Le compositeur rastérise à la géométrie de SORTIE (ramenée à la taille du
        // canvas) et non plus dans un canvas 16:9 figé. Quand cette géométrie change
        // — l'utilisateur change de ratio, ou redimensionne le panneau — on
        // reconstruit le compositeur. Voir `Compositor::new_sized` pour le choix
        // "reconstruire" plutôt que "redimensionner à chaud".
        let want = preview_render_size(full_scene.as_ref(), pw, ph);
        if want != comp.render_size() {
            comp = Compositor::new_sized(&gpu, want.0, want.1)?;
            // Le compositeur neuf est vierge : on repasse par les mécanismes
            // d'invalidation existants plutôt que de recopier l'état à la main —
            // une seule façon d'appliquer la scène, les params et le curseur.
            shared.scene_dirty.store(true, Ordering::Relaxed);
            last_ip = None;
            last_smoothing = -1.0;
            first = true;
            continue;
        }

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
            // BUG corrigé : la lecture libre décodait toujours exactement 1 frame par tick de
            // 1/60s réel, quelle que soit la speed region active au temps source courant — ni
            // l'écran ni la webcam n'accéléraient/ralentissaient jamais en preview live (seul
            // l'export, via `speed_segments_for_window`/`advance_decoder_to` dans pipeline.rs,
            // retimait correctement). Mod 3 corrige déjà le fps-mismatch webcam/écran (la webcam
            // suit le temps source RÉEL de l'écran, pas un pas 1:1) — reprend ici la même idée :
            // l'accumulateur de temps réel est mis à l'échelle par le multiplicateur de vitesse
            // actif, donc `step()` (qui resynchronise la webcam sur le temps écran courant,
            // cf. plus haut) décode plus/moins de frames par seconde réelle selon la région.
            let speed = full_scene
                .as_ref()
                .map(|scene| speed_at(&scene.speed_regions, active_clip_index, player.screen_time_sec()))
                .unwrap_or(1.0);
            acc += dt * speed;
            let step = 1.0 / 60.0;
            let mut n = 0;
            // Cap proportionnel à la vitesse (borné) : à vitesse élevée, plus de frames doivent
            // être décodées par tick réel pour ne pas prendre du retard sur l'accumulateur.
            let max_steps = ((3.0 * speed.max(1.0)).ceil() as i32).min(64);
            while acc >= step && n < max_steps {
                // Timeline = niveau d'abstraction AU-DESSUS des clips : dès que le décodeur
                // écran atteint la fin de fenêtre du clip actif, on enchaîne nous-mêmes sur
                // le clip suivant (ou on reboucle sur le premier après le dernier) — sans
                // dépendre d'un `active_clip_request` poussé par le JS en réaction au
                // franchissement. Ce round-trip arrivait toujours trop tard : le décodeur
                // avait déjà dépassé la fin de la fenêtre, voire atteint l'EOF brut du
                // fichier et rebouclé sur lui-même — d'où le "retour au 1er clip" observé.
                if let Some(scene) = &full_scene {
                    // Approche de la frontière : lance (ou laisse tourner) le préchargement
                    // du clip suivant en tâche de fond, pour que la bascule ci-dessous soit
                    // instantanée plutôt que de payer un `Decoder::open` synchrone pile au
                    // moment de la transition — la pause perceptible observée en usage réel.
                    maybe_start_prefetch(
                        scene,
                        active_clip_index,
                        player.screen_time_sec(),
                        &gpu,
                        &mut prefetch,
                    );
                    if let Some(clip) = scene.clips.get(active_clip_index) {
                        if player.screen_time_sec() >= clip.source_end_sec {
                            advance_to_next_scene_clip(
                                &mut player,
                                &comp,
                                scene,
                                &mut prefetch,
                                &mut active_screen_path,
                                &mut active_webcam_path,
                                &mut active_webcam_offset_sec,
                                &mut active_clip_index,
                                &mut raw_cursor,
                                &mut last_smoothing,
                            );
                        }
                    }
                }
                let screen_time_before_step = full_scene.as_ref().map(|_| player.screen_time_sec());
                if player.step(&comp, &cfg)? {
                    stepped = true;
                }
                // Filet de sécurité : un clip NON trimmé (source_end_sec == durée totale du
                // fichier) peut ne jamais franchir le seuil ci-dessus si la dernière frame
                // réelle a un PTS strictement inférieur à `source_end_sec` déclaré — `step()`
                // finit alors par boucler tout seul sur l'EOF réel (temps qui recule
                // brutalement). On détecte ce recul et on corrige immédiatement en enchaînant
                // sur le clip suivant, plutôt que de rester bloqué sur le 1er clip.
                if let (Some(scene), Some(t_before)) = (&full_scene, screen_time_before_step) {
                    if player.screen_time_sec() < t_before {
                        advance_to_next_scene_clip(
                            &mut player,
                            &comp,
                            scene,
                            &mut prefetch,
                            &mut active_screen_path,
                            &mut active_webcam_path,
                            &mut active_webcam_offset_sec,
                            &mut active_clip_index,
                            &mut raw_cursor,
                            &mut last_smoothing,
                        );
                    }
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
                // `recompose`) a rastérisé le RT à la géométrie de sortie ramenée au panneau.
                // On lit ce RT DIRECTEMENT à sa résolution de rendu (`readback_direct` : copy
                // rt → staging → Map/Unmap), sans le resize `blit_resized` qui, depuis la
                // refonte ratio, n'était plus qu'une copie identité + une alloc NV12 inutile.
                match comp.readback_direct() {
                    Ok((rw, rh, rgba)) => {
                        // Publie dans `latest_frame` : on remplace le buffer précédent
                        // (le canvas ne montre que la dernière frame, peu importe combien
                        // le renderer en a raté entre deux lectures napi). On incrémente
                        // la génération sous le MÊME lock que l'écriture du buffer, pour
                        // qu'un lecteur ne puisse jamais voir un `gen` neuf appairé à un
                        // buffer périmé (ou l'inverse). `+ 1` depuis la précédente, `1` au
                        // premier publish. Les dims publiées sont celles du RENDU (`rw`×`rh`) :
                        // le canvas JS s'y dimensionne (packet auto-descriptif) puis CSS met à
                        // l'échelle vers la boîte du panneau — plus de resize GPU intermédiaire.
                        if let Ok(mut slot) = shared.latest_frame.lock() {
                            let next_gen = slot.as_ref().map(|(g, ..)| g + 1).unwrap_or(1);
                            *slot = Some((next_gen, rw, rh, rgba));
                        }
                        first = false;
                    }
                    Err(e) => {
                        eprintln!("[live] readback_direct: {e:#}");
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
            if let Some((_gen, fw, fh, _pixels)) = view.latest_frame() {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn multiclip_scene() -> Scene {
        Scene::from_json(r##"{
            "clips": [
                {"screenPath":"/shared-screen.mp4","webcamPath":"/shared-webcam.mp4","sourceStartSec":0,"sourceEndSec":4,"webcamOffsetSec":1.25,"hasAudio":true},
                {"screenPath":"/shared-screen.mp4","webcamPath":"/shared-webcam.mp4","sourceStartSec":20,"sourceEndSec":24,"webcamOffsetSec":1.25,"hasAudio":true},
                {"screenPath":"/distinct-screen.mp4","webcamPath":"/distinct-webcam.mp4","sourceStartSec":100,"sourceEndSec":104,"webcamOffsetSec":0.5,"hasAudio":true}
            ],
            "layout":{"preset":"picture-in-picture","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false},
            "effects":{"padding":0,"blur":false,"shadow":0,"roundnessPx":0,"motionBlur":0},
            "background":{"kind":"color","color":"#000000"},
            "zoomRegions":[],
            "cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"},
            "cropByClip":[null,null,null],
            "output":{"width":1920,"height":1080,"fps":30}
        }"##).expect("multiclip scene")
    }

    #[test]
    fn explicit_index_disambiguates_clips_sharing_sources() {
        let scene = multiclip_scene();
        assert_eq!(find_scene_clip_index(&scene, "/shared-screen.mp4", "/shared-webcam.mp4", 1.25), Some(0));
        assert_eq!(resolve_scene_clip_index(&scene, 1, "/shared-screen.mp4", "/shared-webcam.mp4", 1.25), Some(1));
    }

    #[test]
    fn explicit_index_tracks_a_distinct_asset() {
        let scene = multiclip_scene();
        assert_eq!(resolve_scene_clip_index(&scene, 2, "/distinct-screen.mp4", "/distinct-webcam.mp4", 0.5), Some(2));
    }

    #[test]
    fn webcam_seek_uses_screen_source_time_and_offset() {
        assert_eq!(webcam_seek_time(22.5, 1.25), 21.25);
        assert_eq!(webcam_seek_time(0.5, 1.25), 0.0);
    }

    // --- taille de rastérisation de la preview ---------------------------
    // Ces tests remplacent le filet géométrique qui verrouillait la
    // compensation anisotrope : celle-ci n'existe plus (le RT porte la
    // géométrie de sortie), donc la logique qui reste à couvrir est le choix
    // de la taille. La non-régression pixel, elle, vit dans le golden
    // (`tests/output_geometry_golden.rs`).

    fn scene_with_output(w: u32, h: u32) -> Scene {
        Scene::from_json(&format!(
            r##"{{"clips":[],"layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0,"blur":false,"shadow":0,"roundnessPx":0,"motionBlur":0}},"background":{{"kind":"color","color":"#000000"}},"zoomRegions":[],"cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},"cropByClip":[],"output":{{"width":{w},"height":{h},"fps":null}}}}"##
        ))
        .expect("scene valide")
    }

    /// Sans scène on ne connaît pas encore le ratio de sortie : on prend le
    /// panneau tel quel (rien n'est composé tant que la scène n'est pas posée).
    #[test]
    fn preview_size_without_a_scene_is_the_panel() {
        assert_eq!(preview_render_size(None, 800, 450), (800, 450));
    }

    /// Le ratio rendu est celui de la SORTIE, pas celui du panneau — sinon la
    /// preview montrerait un cadrage que l'export ne produira pas.
    #[test]
    fn preview_size_follows_the_output_shape_not_the_panel_shape() {
        let portrait = scene_with_output(1080, 1920);
        let (w, h) = preview_render_size(Some(&portrait), 1600, 900);
        assert!(h > w, "sortie portrait dans un panneau paysage → cadre portrait, obtenu {w}x{h}");
        let got = w as f64 / h as f64;
        assert!((got - 1080.0 / 1920.0).abs() < 0.01, "ratio {got}, attendu 0.5625");
    }

    /// Jamais plus grand que le panneau : les pixels en trop seraient réduits
    /// dans la foulée par le readback — c'est du coût pur.
    #[test]
    fn preview_size_never_exceeds_the_panel() {
        let uhd = scene_with_output(3840, 2160);
        let (w, h) = preview_render_size(Some(&uhd), 960, 540);
        assert!(w <= 960 && h <= 540, "{w}x{h} depasse le panneau 960x540");
    }

    /// Jamais plus grand que la sortie : au-delà, la preview serait plus nette
    /// que l'export, donc mensongère.
    #[test]
    fn preview_size_never_exceeds_the_output() {
        let small = scene_with_output(640, 360);
        let (w, h) = preview_render_size(Some(&small), 3000, 2000);
        assert_eq!((w, h), (640, 360));
    }

    /// Anti-régression du bug de reconstruction en boucle : la taille produite
    /// doit être un POINT FIXE de `normalize_render_size`. Si ce n'est pas le cas,
    /// `want != comp.render_size()` reste vrai indéfiniment et le compositeur se
    /// reconstruit à chaque frame (média qui disparaissent, VRAM qui sature).
    /// On balaie beaucoup de tailles de panneau : une seule qui produit une
    /// dimension impaire suffirait à faire boucler la preview en vrai.
    #[test]
    fn preview_size_is_always_a_fixed_point_of_the_render_size_rounding() {
        let scene = scene_with_output(1920, 1080);
        for pw in 200..1400 {
            let (w, h) = preview_render_size(Some(&scene), pw, 900);
            assert_eq!(
                (w, h),
                Compositor::normalize_render_size(w, h),
                "panneau {pw}x900 → {w}x{h} n'est pas stable → reconstruction en boucle",
            );
        }
    }
}
