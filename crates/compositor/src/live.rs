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
use crate::d3d::Gpu;
use crate::frame_geometry::webcam_is_real;
use crate::pipeline::Decoder;
use crate::timeline_walk::{frame_step, FrameStep, NextFrameTime};
use anyhow::Result;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// `wdec` est-il la VRAIE caméra, ou le remplaçant écran (pas de caméra déclarée, ou
    /// déclarée et illisible) ? Voyage avec la paire de décodeurs parce que c'est d'ELLE que
    /// la réponse dépend, pas de la scène : deux clips de la même timeline peuvent avoir l'un
    /// une caméra qui s'ouvre et l'autre un fichier mort, et le pool (`PooledClip`) réactive
    /// des paires ouvertes plusieurs bascules plus tôt. Cf. `open_webcam_or_stand_in`.
    webcam_decoder_is_real: bool,
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
/// Ouvre le décodeur webcam, ou un remplaçant quand le clip n'a pas de caméra.
///
/// La question « ce chemin désigne-t-il une vraie caméra ? » a déjà une réponse dans ce
/// crate : `webcam_is_real`. Elle couvre le chemin vide, le chemin composé d'espaces, et le
/// cas où l'appelant renvoie le chemin de l'écran lui-même — ce que fait `ExportDialog.tsx`
/// et ce que contiennent les scènes plus anciennes. Un simple `is_empty()` en raterait deux
/// sur trois, et le commentaire de `webcam_is_real` rappelle que c'est exactement cet oubli
/// qui avait mis l'enregistrement d'écran dans la vignette caméra (#265).
///
/// Sans caméra, le remplaçant est l'écran : le moteur veut une paire de décodeurs toujours
/// valide plutôt qu'un `Option` à dérouler sur tout le chemin chaud, et rien ne le dessine
/// puisque la composition ne pose une vignette que si le document déclare une caméra.
///
/// Avec une caméra déclarée dont le fichier ne s'ouvre pas, le chemin, lui, reste parfaitement
/// plausible : `webcam_is_real` répond vrai, la vignette était donc dessinée — sur le
/// remplaçant, c'est-à-dire l'enregistrement d'écran dupliqué dans son propre coin. Vu en vrai
/// avec un `.mp4` webcam de 0 octet, laissé non finalisé par le helper de capture natif.
///
/// D'où le `bool` rendu à côté du décodeur : « ce que je te rends est-il VRAIMENT la caméra ? ».
/// Seule l'ouverture peut répondre — aucune inspection du chemin ne sait qu'un fichier est mort
/// — et c'est cette réponse, et pas le chemin, qui décide de dessiner la vignette (voir
/// `should_draw_webcam`).
///
/// ponytail: on garde le remplaçant plutôt que de passer `wdec` en `Option<Decoder>`, ce qui
/// toucherait 22 sites dont le pool de décodeurs et la boucle de composition `unsafe`. À faire
/// si quelqu'un mesure que le décodeur inutile coûte (VRAM des pools D3D11VA, une ouverture
/// par clip) — l'avertissement ci-dessous dit enfin à quelle fréquence le cas visible arrive.
unsafe fn open_webcam_or_stand_in(
    screen_path: &str,
    webcam_path: &str,
    gpu: &Gpu,
) -> Result<(Decoder, bool)> {
    if !webcam_is_real(webcam_path, screen_path) {
        return Ok((Decoder::open(screen_path, gpu)?, false));
    }
    match Decoder::open(webcam_path, gpu) {
        Ok(d) => Ok((d, true)),
        Err(e) => {
            eprintln!(
                "WARNING: caméra déclarée mais illisible ({webcam_path}) : {e}. La vignette caméra ne sera pas dessinée ; le média est à relier."
            );
            Ok((Decoder::open(screen_path, gpu)?, false))
        }
    }
}

/// Faut-il dessiner la vignette caméra ? Il faut les DEUX moitiés :
///
///   - le document déclare une caméra — `webcam_is_real`, un test de chemins ;
///   - et son décodeur s'est vraiment ouvert — `decoder_is_real`, ce que seul
///     `open_webcam_or_stand_in` sait, transporté jusqu'ici par `PrefetchedClip`/`Player`.
///
/// Le test de chemins seul ne suffit pas : il a répondu « vraie caméra » pour un `.mp4` webcam
/// de 0 octet (fichier non finalisé par le helper de capture), la vignette a été dessinée, et
/// le décodeur derrière elle était le remplaçant écran — l'utilisateur voyait son propre
/// enregistrement d'écran répliqué dans le petit rectangle caméra.
fn should_draw_webcam(webcam_path: &str, screen_path: &str, decoder_is_real: bool) -> bool {
    webcam_is_real(webcam_path, screen_path) && decoder_is_real
}

unsafe fn open_and_seek_clip(
    screen_path: &str,
    webcam_path: &str,
    webcam_offset_sec: f64,
    source_time_sec: f64,
    gpu: &Gpu,
) -> Result<PrefetchedClip> {
    let source_time_sec = source_time_sec.max(0.0);
    let mut sdec = Decoder::open(screen_path, gpu)?;
    let (mut wdec, webcam_decoder_is_real) = open_webcam_or_stand_in(screen_path, webcam_path, gpu)?;
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
    Ok(PrefetchedClip { sdec, wdec, webcam_decoder_is_real, webcam_offset_sec, idx, cursor_track })
}

/// Nombre de paires de décodeurs INACTIVES gardées ouvertes en plus de la paire active.
/// Franchir un clip cross-média rouvre sinon 2 décodeurs (~39 ms) et reseek depuis une image
/// clé (~81 ms) — mesuré ~120 ms/franchissement, le plus gros à-coup du scrub. Les garder
/// ouverts à leur dernière position transforme un RETOUR sur un clip (motif A→B→A ultra
/// fréquent au scrub) en simple reseek, souvent par le chemin rapide `decode_forward`.
/// ponytail: cap fixe. Chaque paire retient son pool de surfaces D3D11VA (VRAM) ; 3 couvre
/// les timelines 2-4 clips, à baisser si la VRAM serre.
const DECODER_POOL_CAP: usize = 3;

/// Une paire de décodeurs mise de côté, prête à être réactivée sans réouverture.
struct PooledClip {
    screen_path: String,
    webcam_path: String,
    webcam_offset_sec: f64,
    clip: PrefetchedClip,
}

/// Repositionne une paire (écran + webcam) au temps source voulu. `false` = un des deux flux
/// n'a pas de frame utilisable là (position hors flux, EOF non rembobinable) ; l'appelant DOIT
/// alors repartir sur une ouverture fraîche plutôt que de composer une frame vide (« frame sans
/// texture » → preview noire définitive). Partagé par `seek_active` (paire active) et le pool.
unsafe fn seek_pair(
    sdec: &mut Decoder,
    wdec: &mut Decoder,
    source_time_sec: f64,
    webcam_offset_sec: f64,
) -> Result<bool> {
    let sf = sdec.seek_to(source_time_sec)?;
    if sf.is_null() {
        return Ok(false);
    }
    let mut wf = wdec.seek_to(webcam_seek_time(source_time_sec, webcam_offset_sec))?;
    if wf.is_null() {
        wf = wdec.seek_to(0.0)?;
    }
    if wf.is_null() {
        return Ok(false);
    }
    Ok(true)
}

/// Bascule cross-média en réutilisant le pool de décodeurs. Réactive la paire cible si elle
/// est déjà en pool (reseek au lieu de rouvrir), sinon ouvre à neuf ; dans les DEUX cas met en
/// pool la paire qu'on QUITTE (au lieu de la fermer), dédupliquée par clé et bornée en LRU.
/// Le vidage du cache de SRV reste à la charge de l'appelant (comme avant) — over-clear est
/// sûr et bon marché, ce qui écarte tout risque « image du clip précédent ».
/// `OPENSCREEN_CLIPSWITCH_TIMING=1` journalise hit/miss + durée.
unsafe fn swap_clip_pooled(
    player: &mut Player,
    pool: &mut Vec<PooledClip>,
    request: &ActiveClipRequest,
    active_screen: &str,
    active_webcam: &str,
    active_webcam_offset_sec: f64,
) -> Result<()> {
    let timing = std::env::var("OPENSCREEN_CLIPSWITCH_TIMING").is_ok();
    let t0 = std::time::Instant::now();
    let t = request.source_time_sec.max(0.0);
    let matches = |p: &PooledClip| {
        p.screen_path == request.screen_path
            && p.webcam_path == request.webcam_path
            && (p.webcam_offset_sec - request.webcam_offset_sec).abs() < 1e-9
    };
    let mut hit = false;
    let incoming: PrefetchedClip = match pool.iter().position(&matches) {
        Some(i) => {
            let mut pooled = pool.remove(i);
            // Reseek les décodeurs poolés AVANT de les installer. Échec → on les jette et on
            // ouvre à neuf (chemin connu sûr), jamais une frame vide.
            if seek_pair(&mut pooled.clip.sdec, &mut pooled.clip.wdec, t, request.webcam_offset_sec)? {
                pooled.clip.idx = (t * pooled.clip.sdec.fps()).round().max(0.0) as u32;
                hit = true;
                pooled.clip
            } else {
                drop(pooled);
                player.open_clip(&request.screen_path, &request.webcam_path, request.webcam_offset_sec, t)?
            }
        }
        None => player.open_clip(&request.screen_path, &request.webcam_path, request.webcam_offset_sec, t)?,
    };
    let outgoing = player.swap_active(incoming);
    // Met la paire quittée en pool : dédup par clé (jamais deux entrées d'un même média), puis
    // éviction LRU (le plus ancien, en tête, part en premier).
    pool.retain(|p| {
        !(p.screen_path == active_screen
            && p.webcam_path == active_webcam
            && (p.webcam_offset_sec - active_webcam_offset_sec).abs() < 1e-9)
    });
    pool.push(PooledClip {
        screen_path: active_screen.to_string(),
        webcam_path: active_webcam.to_string(),
        webcam_offset_sec: active_webcam_offset_sec,
        clip: outgoing,
    });
    while pool.len() > DECODER_POOL_CAP {
        pool.remove(0);
    }
    if timing {
        eprintln!(
            "[clipswitch] {} {:.1}ms (t_src={:.2}s, pool={})",
            if hit { "POOL_HIT reseek" } else { "OPEN     fresh " },
            t0.elapsed().as_secs_f64() * 1000.0,
            t,
            pool.len(),
        );
    }
    Ok(())
}

/// Lit deux sources en lockstep et compose la frame courante dans le RT du compositeur.
/// Partagé avec la GUI standalone (`app.rs`).
pub struct Player {
    sdec: Decoder,
    wdec: Decoder,
    gpu: Gpu,
    /// Même question que `PrefetchedClip::webcam_decoder_is_real`, pour la paire ACTIVE :
    /// `wdec` est-il la caméra ou le remplaçant écran ? Mis à jour à chaque bascule de clip
    /// (`swap_active`), lu par la boucle de rendu pour décider de dessiner la vignette.
    webcam_decoder_is_real: bool,
    webcam_offset_sec: f64,
    has_current_frame: bool,
    use_current_on_next_step: bool,
    idx: u32,
}

impl Player {
    pub unsafe fn open(screen: &str, webcam: &str, gpu: &Gpu) -> Result<Player> {
        let (wdec, webcam_decoder_is_real) = open_webcam_or_stand_in(screen, webcam, gpu)?;
        Ok(Player {
            sdec: Decoder::open(screen, gpu)?,
            wdec,
            gpu: Gpu {
                device: gpu.device.clone(),
                context: gpu.context.clone(),
                feature_level: gpu.feature_level,
                backend: gpu.backend,
            },
            webcam_decoder_is_real,
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

    /// Repositionne les décodeurs DÉJÀ ouverts, sans en rouvrir aucun.
    ///
    /// Pendant de `set_active_clip` pour le cas — dominant — où les FICHIERS n'ont pas
    /// changé. L'app raisonne en *segments* (`resolveVisibleClips` découpe les clips aux
    /// trims), et deux segments consécutifs d'un même clip pointent sur le même fichier
    /// source : seule la fenêtre temporelle diffère. Y répondre par un `set_active_clip`
    /// complet, c'est refaire un `Decoder::open` + `avformat_find_stream_info` + une init
    /// D3D11VA, deux fois, pour rien.
    ///
    /// Mesuré : un scrub traversant deux clips a produit 31 bascules — 21 à moins de 500 ms
    /// l'une de l'autre — pour deux changements de média réels.
    /// Rend `false` quand le repositionnement n'aboutit pas — l'appelant DOIT alors
    /// retomber sur `set_active_clip`.
    ///
    /// Cette sortie existe parce que ce chemin hérite de décodeurs déjà ouverts, donc d'un
    /// état : fin de piste atteinte, position hors de la fenêtre, EOF déjà envoyé.
    /// `open_and_seek_clip` ne peut pas rencontrer ça (ses décodeurs sont neufs). Une
    /// première version marquait la frame comme utilisable sans vérifier les DEUX seeks ;
    /// `compose_frame` recevait alors un `AVFrame` vide, `nv12_srvs` échouait avec « frame
    /// sans texture D3D11 », et le thread de rendu s'arrêtait définitivement — preview noire
    /// jusqu'à recréation de la vue.
    pub unsafe fn seek_active(&mut self, source_time_sec: f64) -> Result<bool> {
        let source_time_sec = source_time_sec.max(0.0);
        // Les DEUX flux doivent avoir une frame : `compose_frame` les échantillonne tous les
        // deux sans condition, un seul manquant suffit à le faire échouer (d'où le `false` que
        // `seek_pair` peut rendre → l'appelant retombe sur l'ouverture complète).
        if !seek_pair(&mut self.sdec, &mut self.wdec, source_time_sec, self.webcam_offset_sec)? {
            return Ok(false);
        }
        self.idx = (source_time_sec * self.sdec.fps()).round().max(0.0) as u32;
        self.has_current_frame = true;
        self.use_current_on_next_step = true;
        Ok(true)
    }

    /// Bascule instantanément sur une paire de décodeurs déjà ouverte + positionnée — aucune
    /// E/S ici, juste l'échange des champs. Utilisé par `set_active_clip` (juste après son
    /// propre `open_and_seek_clip`) et directement par `render_thread` quand un préchargement
    /// en tâche de fond est déjà prêt au moment de franchir la frontière du clip.
    unsafe fn apply_prefetched(&mut self, prefetched: PrefetchedClip) {
        // La paire sortante est droppée ici (comportement inchangé pour la lecture libre) ; le
        // pool du scrub, lui, récupère la sortante en appelant `swap_active` directement.
        let _ = self.swap_active(prefetched);
    }

    /// Échange la paire active contre `incoming` (déjà ouverte + positionnée) et REND la paire
    /// sortante — pour la mettre en pool au lieu de la fermer. Aucune E/S : juste des champs.
    unsafe fn swap_active(&mut self, incoming: PrefetchedClip) -> PrefetchedClip {
        let outgoing = PrefetchedClip {
            sdec: std::mem::replace(&mut self.sdec, incoming.sdec),
            wdec: std::mem::replace(&mut self.wdec, incoming.wdec),
            // Suit son décodeur dans les deux sens : la paire sortante emporte sa réponse vers
            // le pool (elle sera réactivée sans réouverture, donc sans personne pour la
            // recalculer), l'entrante impose la sienne au player.
            webcam_decoder_is_real: self.webcam_decoder_is_real,
            webcam_offset_sec: self.webcam_offset_sec,
            idx: self.idx,
            // Le curseur est re-dérivé du chemin à la réactivation ; inutile de le trimballer.
            cursor_track: None,
        };
        self.webcam_decoder_is_real = incoming.webcam_decoder_is_real;
        self.webcam_offset_sec = incoming.webcam_offset_sec;
        self.idx = incoming.idx;
        self.has_current_frame = true;
        self.use_current_on_next_step = true;
        outgoing
    }

    /// Ouvre une nouvelle paire de décodeurs positionnée à `source_time_sec`, SANS l'installer
    /// (l'appelant l'échange via `swap_active`). Réutilise le device D3D11 du player.
    unsafe fn open_clip(
        &self,
        screen: &str,
        webcam: &str,
        webcam_offset_sec: f64,
        source_time_sec: f64,
    ) -> Result<PrefetchedClip> {
        open_and_seek_clip(screen, webcam, webcam_offset_sec, source_time_sec, &self.gpu)
    }

    /// Le décodeur webcam ACTIF est-il la vraie caméra ? `false` quand c'est le remplaçant
    /// écran — aucune caméra déclarée, ou une caméra déclarée dont le fichier ne s'ouvre pas.
    /// La boucle de rendu en a besoin parce que la seule autre source d'information dont elle
    /// dispose, le chemin webcam du clip, ment dans le second cas (cf. `should_draw_webcam`).
    pub fn webcam_decoder_is_real(&self) -> bool {
        self.webcam_decoder_is_real
    }

    /// Temps source courant du décodeur écran — utilisé par `render_thread` pour détecter le
    /// franchissement de la fin de fenêtre du clip actif pendant la lecture libre, et pour
    /// calculer la cible de `step` en lecture libre. `pub` (pas `pub(crate)`) : le harnais
    /// `poc-d3d` (crate externe) en a besoin pour piloter sa propre boucle de lecture libre.
    pub unsafe fn screen_time_sec(&self) -> f64 {
        self.sdec.cur_time_sec()
    }

    /// Compose la PROCHAINE frame due (→ `comp.rt`), au plus une, si `target_source_time`
    /// (temps écran) est atteint. Sémantique de "hold" : `false` sans rien composer quand la
    /// frame suivante n'est pas encore due — l'appelant garde alors l'image déjà affichée,
    /// au lieu d'avancer aveuglément. Boucle sur EOF réel. `false` aussi si fixture vide.
    ///
    /// BUG corrigé : cette fonction consommait auparavant EXACTEMENT une frame réelle par
    /// appel (un `next()` inconditionnel), et `render_thread` l'appelait une fois par tranche
    /// de 1/60s de temps réel écoulé — une hypothèse de vidéo à ~60 fps constant. Or
    /// ScreenCaptureKit (et les captures équivalentes) ne livre une frame que quand l'écran
    /// change : un enregistrement de 26s avec de longs plans fixes peut ne contenir que
    /// quelques centaines de frames RÉELLES. Consommer 1 frame/tick épuisait alors le flux
    /// bien avant que le temps réel écoulé n'atteigne la durée de l'enregistrement — le
    /// décodeur retombait sur l'EOF, rebouclait sur `seek_to(0.0)`, et la preview semblait
    /// « accélérer puis sauter au début » en boucle. Le curseur/zoom, eux, suivent le pts réel
    /// (`sync_time`) et se retrouvaient donc en avance sur ce que l'œil voyait défiler.
    ///
    /// Le correctif : ne décoder/adopter (`commit_peek`) la frame suivante QUE si son pts a
    /// réellement été atteint par `target_source_time` (le temps réel écoulé, mis à l'échelle
    /// par la vitesse active — cf. `render_thread`) ; sinon on continue de tenir la frame
    /// courante, aussi longtemps qu'il le faut. Même principe que `advance_decoder_to`
    /// (`timeline_walk.rs`), déjà correct côté export.
    ///
    /// La webcam suit le MÊME principe indépendamment (son propre temps source =
    /// `screen_time - webcam_offset_sec`, pas un pas 1:1 avec l'écran) : deux pipelines de
    /// capture indépendants n'ont pas la même cadence ni les mêmes trous. Arrivée à son
    /// propre EOF — un clip webcam plus court que l'écran, cas normal quand la caméra
    /// s'arrête avant la capture — elle TIENT sa dernière image et laisse l'écran
    /// continuer seul, plutôt que de reboucler au début.
    pub unsafe fn step(&mut self, comp: &Compositor, cfg: &Cfg, target_source_time: f64) -> Result<bool> {
        let use_current = self.use_current_on_next_step;
        self.use_current_on_next_step = false;

        let sf = if use_current {
            self.sdec.cur_frame()
        } else {
            // Match direct sur `NextFrameTime` plutôt que via `frame_step` : la lecture
            // live a une politique d'EOF PROPRE (reboucler au début), là où l'export tient
            // la dernière frame. Le reste — « due » vs « pas encore due » — est la même
            // règle, `>`/`<=` compris.
            match self.sdec.peek_next_time_sec()? {
                NextFrameTime::At(t) if t <= target_source_time => self.sdec.commit_peek()?,
                NextFrameTime::At(_) => return Ok(false), // pas encore due : on tient la courante.
                // pts inexploitable : impossible de dire si elle est due. `step()` n'adopte
                // qu'une frame écran par appel, donc l'adopter revient exactement à
                // l'ancien « une frame par tick » — le repli correct pour un flux cassé.
                NextFrameTime::Unknown => self.sdec.commit_peek()?,
                NextFrameTime::Eof => {
                    // EOF réel (plus aucune frame à décoder) : reboucle sur le début.
                    self.idx = 0;
                    self.sdec.seek_to(0.0)?
                }
            }
        };
        if sf.is_null() {
            self.has_current_frame = false;
            return Ok(false);
        }

        let target_webcam_t = (self.sdec.cur_time_sec() - self.webcam_offset_sec).max(0.0);
        let wf = if use_current {
            self.wdec.cur_frame()
        } else {
            let cur = self.wdec.cur_frame();
            if cur.is_null() {
                // Jamais décodée (nouvelle ouverture) : on saute directement au temps synchronisé.
                self.wdec.seek_to(target_webcam_t)?
            } else {
                // Rattrape la webcam vers `target_webcam_t` par pts réel, jamais au-delà —
                // même sémantique de hold que l'écran ci-dessus (et que `advance_decoder_to`) :
                // adopter une frame webcam dont le pts dépasse `target_webcam_t` l'afficherait
                // en avance sur son heure. Le garde-fou ne joue que contre un cas pathologique.
                //
                // BUG corrigé : à son EOF la webcam était reseekée à 0 alors que
                // `target_webcam_t` continue de croître avec le temps écran. Au tick
                // suivant, le rattrapage repartait donc de 0 et réavalait le fichier
                // entier vers une cible toujours aussi lointaine — 1000 frames par tick
                // (le plafond du garde-fou), en boucle, pour l'éternité. Un décodage
                // permanent à fond, pour afficher une webcam qui n'a plus rien à montrer.
                // Une fois l'EOF traité comme un hold, la décision webcam est EXACTEMENT
                // celle de l'écran à l'export : `frame_step` couvre les quatre cas sans
                // rien de spécifique, et ses tests couvrent donc aussi ce chemin.
                let mut wf = cur;
                let mut guard = 0u32;
                loop {
                    match frame_step(self.wdec.peek_next_time_sec()?, 0.0, target_webcam_t) {
                        FrameStep::Commit => wf = self.wdec.commit_peek()?,
                        FrameStep::CommitAndStop => {
                            wf = self.wdec.commit_peek()?;
                            break;
                        }
                        FrameStep::Hold => break,
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

/// Retranche de l'accumulateur le temps source RÉELLEMENT consommé par la frame qui vient
/// d'être adoptée. C'est ce qui fait jouer une source à sa propre cadence : une frame de
/// 1/24 s consomme 1/24 s d'accumulateur, donc 24 frames par seconde réelle — là où
/// l'ancien pas fixe de 1/60 s en décodait 60, soit 2,5× trop vite sur du 24 fps.
///
/// `after < before` : `step()` a rebouclé sur l'EOF (le temps recule) — le delta n'a plus
/// de sens, on repart d'un accumulateur propre.
///
/// Fonction à part pour être testable : c'est l'arithmétique dont dépend la vitesse de
/// lecture, et elle vivait au milieu de la boucle de rendu.
pub(crate) fn consume_acc(acc: f64, before: f64, after: f64) -> f64 {
    if after >= before {
        (acc - (after - before)).max(0.0)
    } else {
        0.0
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
    /// Génération de la dernière frame publiée. Tenue À PART de `latest_frame` : la
    /// livraison sans copie vide le slot en le lisant, et dériver la génération d'un slot
    /// vide la ferait repartir à 1 — donc rejouer des générations déjà peintes. Monotone,
    /// jamais remise à zéro.
    frame_gen: AtomicU64,
    /// Erreur fatale du thread de rendu (device D3D11 introuvable, décodeur qui refuse
    /// le fichier…). Le thread meurt sur la première erreur ; sans ce champ, elle
    /// finissait dans un `eprintln!` que personne ne lit et l'utilisateur n'avait
    /// qu'un canvas noir — exactement le « on dirait que l'app rame » de la PR #162.
    /// `read_frame` la relaie en `Err` au prochain tour de la boucle de pull (~33 ms),
    /// donc elle remonte jusqu'à l'UI par le chemin d'erreur qui existe déjà.
    fatal: Mutex<Option<String>>,
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
            frame_gen: AtomicU64::new(0),
            fatal: Mutex::new(None),
        });
        let sh = shared.clone();
        let (s, wc, cj) = (screen.to_string(), webcam.to_string(), cursor_json.to_string());
        let thread = std::thread::spawn(move || {
            if let Err(e) = unsafe { render_thread(sh.clone(), &s, &wc, &cj) } {
                eprintln!("[live] render thread error: {e:#}");
                if let Ok(mut fatal) = sh.fatal.lock() {
                    *fatal = Some(format!("{e:#}"));
                }
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

    /// Message de l'erreur qui a tué le thread de rendu, `None` tant qu'il tourne.
    /// Définitif : le thread ne redémarre pas.
    pub fn fatal_error(&self) -> Option<String> {
        self.shared.fatal.lock().ok().and_then(|guard| guard.clone())
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
        let mut guard = self.shared.latest_frame.lock().ok()?;
        match guard.as_ref() {
            // Le buffer est EMPORTÉ, pas copié. Le thread de rendu le remplace à chaque
            // frame composée et le consommateur garde ses pixels peints sur le canvas :
            // personne ne relit jamais la même génération. Le `clone()` d'avant était un
            // memcpy `O(w·h)` — 1,5 ms à 1280×720, 3,4 ms à 1920×1080 — payé sur le THREAD
            // PRINCIPAL de Node, celui-là même qui doit rester libre pour que React peigne
            // la tête de lecture.
            //
            // Contrepartie assumée : une relecture forcée (`since_gen = 0`) après la
            // première ne retrouve rien tant qu'une nouvelle frame n'est pas composée. Sans
            // conséquence ici — le seul consommateur ne l'utilise qu'au montage, et un
            // redimensionnement provoque de toute façon une recomposition.
            Some((gen, ..)) if *gen > since_gen => guard.take(),
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

    /// Ce que la vue est en train de faire : lecture libre (`true`) ou pause (`false`).
    /// Lu par l'export, qui met les previews en pause le temps d'encoder et doit pouvoir
    /// leur rendre CET état plutôt que d'en supposer un (voir `PausedPreviews`).
    pub fn playing(&self) -> bool {
        self.shared.playing.load(Ordering::Relaxed)
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

/// A preview's transport — free-run or paused — readable AND writable without touching the
/// GPU. It is the only slice of `LiveView` an export needs: it pauses the previews to free
/// the 3D engine, then hands the transport back. A trait rather than `LiveView` itself so
/// that `PausedPreviews` can be tested with no D3D device (see this file's tests).
pub trait PreviewTransport {
    fn playing(&self) -> bool;
    fn set_playing(&self, playing: bool);
}

impl PreviewTransport for LiveView {
    fn playing(&self) -> bool {
        // Fully-qualified on purpose: inside a trait impl, `self.playing()` resolving to the
        // inherent method is a silent coincidence of method resolution, not a guarantee.
        LiveView::playing(self)
    }

    fn set_playing(&self, playing: bool) {
        LiveView::set_playing(self, playing);
    }
}

/// What every preview was doing when an export paused them — enough to give EACH ONE back the
/// state it was found in, instead of resuming them all.
///
/// That distinction is the fix for a visible bug, not a nicety. While editing, the preview is
/// PAUSED; the renderer only pushes `setPlaying` when the transport actually changes, so
/// nothing ever came along to re-pause a preview an export had resumed on its own authority.
/// It went back to free-running for its own account: its playhead left the moment the app
/// believed was on screen (the zoom then sampled at the wrong source time), and at the first
/// clip boundary it crossed, it swapped its scene over to ANOTHER clip
/// (`scene_for_clip`) — after which the zoom regions of the clip actually being displayed were
/// filtered out of the scene, and no amount of seeking brought them back (the app only pushes
/// `set_active_clip` when ITS active clip changes, and its own had not changed). Only a window
/// reload, which recreates the view, repaired it.
///
/// `K` is the caller's identity for a view (the napi registry id). Previews created AFTER the
/// pause are absent from the snapshot and are left strictly alone: their transport belongs to
/// whoever created them.
pub struct PausedPreviews<K> {
    was_playing: Vec<(K, bool)>,
}

impl<K> Default for PausedPreviews<K> {
    fn default() -> Self {
        Self { was_playing: Vec::new() }
    }
}

impl<K: Copy + PartialEq> PausedPreviews<K> {
    /// Pauses every preview and reports what each one was doing.
    pub fn pause<'a, V: PreviewTransport + 'a>(views: impl IntoIterator<Item = (K, &'a V)>) -> Self {
        let mut was_playing = Vec::new();
        for (key, view) in views {
            was_playing.push((key, view.playing()));
            view.set_playing(false);
        }
        Self { was_playing }
    }

    /// Gives every preview the snapshot knows about the state it was found in.
    pub fn restore<'a, V: PreviewTransport + 'a>(&self, views: impl IntoIterator<Item = (K, &'a V)>) {
        for (key, view) in views {
            if let Some((_, was_playing)) = self.was_playing.iter().find(|(k, _)| *k == key) {
                view.set_playing(*was_playing);
            }
        }
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
        backend: gpu.backend,
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
            // Jeu de décodeurs remplacé ici aussi (franchissement pendant la lecture libre) :
            // même raison qu'au traitement d'`active_clip_request` — le cache de SRV est keyé
            // sur l'adresse de la texture, et garder des entrées d'un décodeur fermé fait
            // fuir de la VRAM puis, en cas de réutilisation d'adresse, rendre l'image du clip
            // précédent.
            comp.clear_srv_cache();
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
    // Chemin de PRODUCTION : matériel si possible, backend CPU sinon (voir `create_auto`).
    let gpu = Gpu::create_auto(false)?;
    let mut comp = Compositor::new(&gpu)?;
    // Vue live = le VRAI enregistrement, pas la fenêtre fixture (100s@6s, taillée pour l'ancien
    // fixture POC). On charge toute la piste depuis t=0 ; 24h couvre large toute recording réelle.
    // Gardée à part (raw_cursor) pour pouvoir régénérer une variante lissée sans relire le
    // fichier à chaque changement du slider "smoothing" (voir la boucle plus bas).
    let mut raw_cursor = CursorTrack::load(cursor_json, 0.0, 24.0 * 3600.0).ok();
    /// Chemin de la télémétrie curseur actuellement chargée dans `raw_cursor` — évite de
    /// relire le même fichier à chaque changement de segment (voir plus bas).
    let mut loaded_cursor_path = cursor_json.to_string();
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
    // Pool de décodeurs INACTIFS gardés ouverts entre franchissements de clip (scrub). Vidé
    // quand le thread de rendu meurt (vue détruite / document rechargé). Voir `swap_clip_pooled`
    // et `DECODER_POOL_CAP` — c'est le remède au ~120 ms/franchissement mesuré.
    let mut decoder_pool: Vec<PooledClip> = Vec::new();

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
            // Mêmes fichiers que ceux déjà ouverts → seule la fenêtre temporelle change
            // (segments d'un même clip séparés par un trim). On repositionne au lieu de
            // rouvrir : voir `Player::seek_active` pour ce que ça évite.
            let same_media = request.screen_path == active_screen_path
                && request.webcam_path == active_webcam_path
                && (request.webcam_offset_sec - active_webcam_offset_sec).abs() < 1e-9;
            // Le repositionnement n'est tenté que sur médias identiques, et son échec n'est
            // JAMAIS fatal : on retombe sur l'ouverture complète, chemin connu comme sûr.
            // L'optimisation ne s'applique donc que là où elle fonctionne démontrablement.
            let repositioned = same_media && matches!(player.seek_active(request.source_time_sec), Ok(true));
            let switch_result = if repositioned {
                Ok(())
            } else {
                // Cross-média : passe par le pool de décodeurs — réutilise une paire déjà
                // ouverte si possible (reseek au lieu de rouvrir) et met en pool celle qu'on
                // quitte, au lieu du couple ouvrir-puis-fermer. Voir `swap_clip_pooled` et la
                // mesure de ~120 ms/franchissement qui l'a motivé.
                swap_clip_pooled(
                    &mut player,
                    &mut decoder_pool,
                    &request,
                    &active_screen_path,
                    &active_webcam_path,
                    active_webcam_offset_sec,
                )
            };
            match switch_result {
                Ok(()) => {
                    // Condition sur `repositioned`, pas sur `same_media` : un repositionnement
                    // qui a échoué est retombé sur l'ouverture complète, donc des décodeurs
                    // ONT été fermés et le cache doit être vidé malgré des médias identiques.
                    if !repositioned {
                        // Les anciens décodeurs viennent d'être fermés : leurs textures ne
                        // doivent plus figurer dans le cache de SRV, qui est keyé sur
                        // l'ADRESSE de la texture. Sans ce vidage, deux défauts se cumulent —
                        // le cache grandit sans borne et retient les textures via les SRV
                        // clonés ; et un décodeur neuf peut allouer à une adresse déjà vue,
                        // donner une collision de clé, et faire rendre l'image du clip
                        // PRÉCÉDENT. `clear_srv_cache` existait pour ça et n'avait aucun
                        // appelant.
                        comp.clear_srv_cache();
                    }
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
                    // Relire la télémétrie curseur seulement si le FICHIER change. Elle était
                    // rechargée — ouverture disque + parse JSON — à chaque demande de clip, y
                    // compris quand seul le segment changeait, où le chemin est par
                    // construction identique. Mesuré : 66 bascules sur un scrub de deux clips,
                    // donc 66 relectures du même fichier.
                    let cursor_path = format!("{}.cursor.json", active_screen_path);
                    if cursor_path != loaded_cursor_path {
                        loaded_cursor_path = cursor_path.clone();
                        raw_cursor = CursorTrack::load(&cursor_path, 0.0, 24.0 * 3600.0).ok();
                        // Journalisé ICI seulement : sinon la ligne annonce « loaded=ok » à
                        // chaque changement de segment alors que rien n'a été relu, et le log
                        // laisse croire à un travail qui n'a plus lieu.
                        match &raw_cursor {
                            Some(track) => eprintln!(
                                "[live] cursor: path={} loaded=ok samples={}",
                                cursor_path,
                                track.sample_count(),
                            ),
                            None => eprintln!(
                                "[live] cursor: path={} loaded=FAIL — clear_cursor()",
                                cursor_path,
                            ),
                        }
                    }
                    // Appliqué à chaque fois, y compris sans relecture : le compositeur peut
                    // avoir été reconstruit (changement de taille) et perdu son curseur.
                    match &raw_cursor {
                        Some(track) => comp.set_cursor(track.smoothed(0.0)),
                        None => comp.clear_cursor(),
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
        // A clip with no camera must not draw the PiP box — the decoder behind it is the
        // screen video, so drawing it duplicates the recording into its own corner. The
        // paths alone cannot answer that: a declared camera whose file will not open (the
        // 0-byte MP4 an unfinalized capture leaves behind) keeps a perfectly plausible
        // path, and the decoder behind its box is the screen fallback just the same. So
        // ask the player what it actually opened.
        let has_real_webcam = should_draw_webcam(
            &active_webcam_path,
            &active_screen_path,
            player.webcam_decoder_is_real(),
        );
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
            // BUG corrigé : la lecture libre décodait auparavant exactement 1 frame RÉELLE par
            // tranche de 1/60s de temps réel écoulé, quelle que soit la densité effective de
            // frames de la source. ScreenCaptureKit (et les captures équivalentes) ne livre une
            // frame que quand l'écran change : un enregistrement avec de longs plans fixes peut
            // ne contenir que quelques centaines de frames RÉELLES sur toute sa durée. Consommer
            // 1 frame/tick épuisait alors le flux bien avant que le temps réel écoulé n'atteigne
            // la durée de l'enregistrement — `step()` retombait sur l'EOF et rebouclait sur
            // `seek_to(0.0)`, d'où la preview qui semblait « accélérer puis sauter au début » en
            // boucle (cf. doc de `step()` pour le détail).
            //
            // Le correctif : `acc` (mis à l'échelle par la speed region active, cf. mod 3 plus
            // bas pour le fps-mismatch webcam/écran) n'est plus consommé par tranches fixes de
            // 1/60s — c'est une CIBLE de temps source (`target = temps courant + acc`) que
            // `step()` n'atteint qu'en adoptant une frame dont le pts est réellement dû (hold
            // sinon). `acc` n'est décrémenté que du temps source RÉELLEMENT consommé par chaque
            // frame adoptée, jamais d'un pas fixe — donc les plans fixes ne consomment aucune
            // frame et n'avancent le décodeur que quand une frame due existe vraiment.
            let speed = full_scene
                .as_ref()
                .map(|scene| speed_at(&scene.speed_regions, active_clip_index, player.screen_time_sec()))
                .unwrap_or(1.0);
            acc += dt * speed;
            let mut n = 0;
            // Cap sur le nombre de frames RÉELLEMENT adoptées par tick (pas sur le nombre de
            // ticks) : à vitesse élevée sur du contenu dense, plus de frames doivent être
            // décodées par tick réel pour ne pas prendre du retard sur l'accumulateur.
            let max_steps = ((3.0 * speed.max(1.0)).ceil() as i32).min(64);
            loop {
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
                let before = player.screen_time_sec();
                let target = before + acc;
                let committed = player.step(&comp, &cfg, target)?;
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
                if !committed {
                    // Rien n'est dû pour l'instant (hold) : `acc` reste tel quel — il continue
                    // de s'accumuler aux ticks suivants jusqu'à ce qu'une vraie frame arrive.
                    break;
                }
                stepped = true;
                let after = player.screen_time_sec();
                acc = consume_acc(acc, before, after);
                n += 1;
                if n >= max_steps {
                    // Rattrapage plafonné : le contenu dû est plus dense que ce qu'on peut décoder
                    // en un tick réel. On laisse tomber le reliquat plutôt que de creuser une
                    // dette qui s'accumulerait indéfiniment d'un tick à l'autre.
                    acc = 0.0;
                    break;
                }
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
                        // La génération vient d'un compteur atomique et non du slot : la
                        // livraison sans copie VIDE le slot en le lisant, et un
                        // `unwrap_or(1)` repartirait alors de 1 — le consommateur recevrait
                        // des générations déjà peintes et boucherait. Séquence identique à
                        // l'ancienne dérivation tant que le slot n'est pas vidé.
                        let next_gen = shared.frame_gen.fetch_add(1, Ordering::Relaxed) + 1;
                        if let Ok(mut slot) = shared.latest_frame.lock() {
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
//
// Le harnais crée une fenêtre Win32 simple qui héberge la preview live ; c'est un
// outil de dev, pas un chemin de production (le production est 100 % offscreen et
// passe par `LiveView::create`, cf. plus haut). Sur macOS le harnais n'a pas
// d'équivalent — `poc-d3d` ne tourne que sur Windows — et l'intégralité de cette
// section est cfg-gatée pour que le crate compile sur les deux plateformes.
//
// `run_standalone` reste à portée du module `live` (poc-d3d l'appelle via
// `live::run_standalone`); les helpers internes (`host_proc`, `wide`,
// `client_size`) sont mis dans un sous-module privé pour que les types Win32 ne
// polluent pas le scope module-level.

#[cfg(windows)]
pub mod standalone_harness {

use crate::live::LiveView;
use anyhow::Result;
use std::time::Duration;
use windows::core::PCWSTR;
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

} // fin du mod standalone_harness — pas d'équivalent macOS, c'est un harnais dev Windows.

// Ré-export pour que `live::run_standalone` reste l'API stable appelée par `poc-d3d`.
#[cfg(windows)]
pub use standalone_harness::run_standalone;

/// Stub no-op pour que le crate compile sur macOS sans laisser de chemin mort
/// derrière le cfg(windows) ci-dessus. À supprimer si un harnais AppKit/Carbon
/// est ajouté dans un commit ultérieur.
#[cfg(target_os = "macos")]
pub fn run_standalone(_screen: &str, _webcam: &str, _cursor_json: &str) -> anyhow::Result<()> {
    anyhow::bail!("run_standalone: pas d'équivalent macOS — `poc-d3d` est un outil dev Windows")
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
            "effects":{"padding":0,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0},
            "background":{"kind":"color","color":"#000000"},
            "zoomRegions":[],
            "cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"},
            "cropByClip":[null,null,null],
            "output":{"width":1920,"height":1080,"fps":30}
        }"##).expect("multiclip scene")
    }

    #[test]
    fn acc_is_reduced_by_the_source_time_the_frame_actually_consumed() {
        // 1/24 s d'accumulateur par frame de 24 fps : c'est ce qui fait jouer une source à
        // SA cadence. L'ancien pas fixe retranchait 1/60 s quelle que soit la source, d'où
        // 60 frames décodées par seconde réelle — 2,5× trop vite sur du 24 fps.
        let acc = consume_acc(0.05, 10.0, 10.0 + 1.0 / 24.0);
        assert!((acc - (0.05 - 1.0 / 24.0)).abs() < 1e-12);
    }

    #[test]
    fn acc_never_goes_negative() {
        // Une frame plus longue que le retard accumulé ne doit pas creuser une dette
        // négative qui ferait sauter la frame suivante.
        assert_eq!(consume_acc(0.01, 10.0, 10.5), 0.0);
    }

    #[test]
    fn acc_resets_when_playback_loops_back_to_the_start() {
        // `after < before` : `step()` a rebouclé sur l'EOF. Le delta serait négatif et
        // gonflerait l'accumulateur — lecture emballée juste après la boucle.
        assert_eq!(consume_acc(0.02, 1950.0, 0.0), 0.0);
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

    #[test]
    fn a_clip_without_a_camera_has_no_webcam_to_draw() {
        // What the app actually sends for an asset with no `cameraTrack`. Treating
        // this as a real camera drew the screen recording inside the PiP box, since
        // the webcam decoder falls back to the screen file when the path won't open.
        assert!(!webcam_is_real("", "/rec/recording-1.mp4"));
        assert!(!webcam_is_real("   ", "/rec/recording-1.mp4"));
        // The older sentinel: webcam path == screen path.
        assert!(!webcam_is_real("/rec/recording-1.mp4", "/rec/recording-1.mp4"));
        assert!(!webcam_is_real("/rec/RECORDING-1.mp4", "/rec/recording-1.mp4"));
    }

    #[test]
    fn a_clip_with_a_camera_draws_it() {
        assert!(webcam_is_real("/rec/recording-1-webcam.webm", "/rec/recording-1.mp4"));
    }

    #[test]
    fn a_camera_whose_file_would_not_open_draws_nothing() {
        // Reproduced on a real machine: the native capture helper left a 0-byte webcam
        // MP4, so `Decoder::open` failed and the webcam decoder fell back to the SCREEN
        // file — while the path stayed as plausible as any other, which is why the string
        // test still says "real camera" on the very same input.
        assert!(webcam_is_real("/rec/recording-1-webcam.mp4", "/rec/recording-1.mp4"));
        assert!(!should_draw_webcam(
            "/rec/recording-1-webcam.mp4",
            "/rec/recording-1.mp4",
            false,
        ));
    }

    #[test]
    fn a_camera_that_did_open_is_drawn() {
        assert!(should_draw_webcam(
            "/rec/recording-1-webcam.webm",
            "/rec/recording-1.mp4",
            true,
        ));
    }

    #[test]
    fn a_clip_without_a_camera_draws_nothing_however_well_its_decoder_opened() {
        // The stand-in decoder always opens — it IS the screen file — so the path test
        // remains the half of the answer that catches "this clip has no camera at all".
        assert!(!should_draw_webcam("", "/rec/recording-1.mp4", true));
        assert!(!should_draw_webcam("/rec/recording-1.mp4", "/rec/recording-1.mp4", true));
    }

    // --- transport handed to an export and back -------------------------------
    // A real `LiveView` needs a D3D device and a decoder; the transport is the only
    // part an export touches, so these exercise it through `PreviewTransport` alone.

    /// A preview reduced to its transport flag — no GPU, no render thread.
    struct FakePreview(std::cell::Cell<bool>);

    impl FakePreview {
        fn new(playing: bool) -> Self {
            Self(std::cell::Cell::new(playing))
        }
    }

    impl PreviewTransport for FakePreview {
        fn playing(&self) -> bool {
            self.0.get()
        }

        fn set_playing(&self, playing: bool) {
            self.0.set(playing);
        }
    }

    /// The regression this exists for: an export used to resume every preview it had
    /// paused, so exporting while the editor sat paused left the preview free-running —
    /// it drifted off the app's playhead and out of the zoom region the inspector still
    /// showed, and only a window reload brought the zoom back.
    #[test]
    fn an_export_leaves_a_paused_preview_paused() {
        let paused = FakePreview::new(false);
        let snapshot = PausedPreviews::pause([(7, &paused)]);
        assert!(!paused.playing(), "the export must free the GPU while it encodes");

        snapshot.restore([(7, &paused)]);
        assert!(!paused.playing(), "the app never asked for playback — it must still be paused");
    }

    /// The other half of "as found": a preview that WAS playing gets its playback back,
    /// which is what the blanket resume happened to get right.
    #[test]
    fn an_export_gives_a_playing_preview_its_playback_back() {
        let playing = FakePreview::new(true);
        let snapshot = PausedPreviews::pause([(1, &playing)]);
        assert!(!playing.playing(), "paused for the duration of the encode");

        snapshot.restore([(1, &playing)]);
        assert!(playing.playing());
    }

    /// Each preview gets ITS state back, not the majority's.
    #[test]
    fn each_preview_is_restored_independently() {
        let (a, b) = (FakePreview::new(true), FakePreview::new(false));
        let snapshot = PausedPreviews::pause([(1, &a), (2, &b)]);
        snapshot.restore([(1, &a), (2, &b)]);
        assert_eq!((a.playing(), b.playing()), (true, false));
    }

    /// A preview born mid-export was never paused by it, so the export has no state of
    /// its own to hand back — forcing one would overwrite what its creator just pushed.
    #[test]
    fn a_preview_created_during_an_export_keeps_its_own_transport() {
        let existing = FakePreview::new(false);
        let snapshot = PausedPreviews::pause([(1, &existing)]);

        let newborn = FakePreview::new(true);
        snapshot.restore([(1, &existing), (2, &newborn)]);
        assert!(newborn.playing(), "untouched: it is not in the snapshot");
        assert!(!existing.playing());
    }

    /// A preview destroyed during the export simply isn't there to restore — no panic,
    /// and the survivors are still handled.
    #[test]
    fn a_preview_destroyed_during_an_export_is_skipped() {
        let (kept, doomed) = (FakePreview::new(true), FakePreview::new(true));
        let snapshot = PausedPreviews::pause([(1, &kept), (2, &doomed)]);
        drop(doomed);
        snapshot.restore([(1, &kept)]);
        assert!(kept.playing());
    }

    // --- taille de rastérisation de la preview ---------------------------
    // Ces tests remplacent le filet géométrique qui verrouillait la
    // compensation anisotrope : celle-ci n'existe plus (le RT porte la
    // géométrie de sortie), donc la logique qui reste à couvrir est le choix
    // de la taille. La non-régression pixel, elle, vit dans le golden
    // (`tests/output_geometry_golden.rs`).

    fn scene_with_output(w: u32, h: u32) -> Scene {
        Scene::from_json(&format!(
            r##"{{"clips":[],"layout":{{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false}},"effects":{{"padding":0,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0}},"background":{{"kind":"color","color":"#000000"}},"zoomRegions":[],"cursor":{{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"}},"cropByClip":[],"output":{{"width":{w},"height":{h},"fps":null}}}}"##
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
