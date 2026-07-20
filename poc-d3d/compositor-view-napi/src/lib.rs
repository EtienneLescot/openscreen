//! Addon napi-rs : pont Electron ↔ `poc_d3d::live::LiveView`. Expose la vue
//! offscreen (Option B, post-readback `Vec<u8>` RGBA8 → `<canvas>` HTML) à la
//! glue TS (native-bridge domaine "compositor"). Les `#[napi]` sont appelés
//! depuis le thread principal Node (là où vit la `BrowserWindow`) ; le rendu et
//! la publication de la dernière frame vivent sur le thread dédié de `LiveView`
//! et sont récupérés via `read_frame`.

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, JsFunction, Task};
use napi_derive::napi;
use poc_d3d::compositor::{live_params_from_scene, Compositor};
use poc_d3d::cursor::CursorTrack;
use poc_d3d::d3d::Gpu;
use poc_d3d::live::LiveView;
use poc_d3d::scene::Scene;
use poc_d3d::{config, pipeline};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Résolution cible du preview en pixels device (largeur/hauteur du `<canvas>`
/// Electron affichant la preview). `x`/`y` ne sont plus utilisés (Option B :
/// la position est gérée par CSS côté web) — conservés dans l'objet pour
/// compatibilité structurelle avec l'ancien code de la glue TS, simplement
/// ignorés côté Rust.
#[napi(object)]
pub struct CompositorViewRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

static REGISTRY: OnceLock<Mutex<HashMap<i32, LiveView>>> = OnceLock::new();
static NEXT_ID: Mutex<i32> = Mutex::new(1);

fn registry() -> &'static Mutex<HashMap<i32, LiveView>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Répertoire fixture (POC) : env `OPENSCREEN_COMPOSITOR_FIXTURE`, sinon défaut local.
/// Le Lot 3 fournira les vraies sources ; ici on prouve l'embed avec la fixture.
fn fixture_dir() -> String {
    std::env::var("OPENSCREEN_COMPOSITOR_FIXTURE").unwrap_or_else(|_| {
        r"C:\Users\camil\Documents\repos\openscreen\.claude\worktrees\prerelease-version-tag-ee96ae\poc-d3d\fixture".to_string()
    })
}

/// Crée une vue **offscreen** (pas de HWND, pas de fenêtre native). Démarre juste
/// un thread de rendu qui compose chaque frame, blit-resize vers `rect.width`×
/// `rect.height` (réutilise le même `ensure_resize_target`/`blit_resized` que
/// l'export), lit le résultat vers CPU via staging `D3D11_USAGE_STAGING` +
/// `Map`/`Unmap` et stocke un `Vec<u8>` RGBA8 tightly-packed dans la vue pour
/// que `read_frame` le retourne à la glue TS.
///
/// Si `screen_path`/`webcam_path` sont fournis (F3 : le vrai enregistrement de
/// l'app — deux fichiers H264 séparés), on rend ces sources ; sinon on retombe
/// sur la fixture POC. `cursor_path` optionnel (télémétrie curseur ; absent →
/// pas de curseur).
///
/// `rect` ne sert plus que pour `width`/`height` (résolution cible du preview) ;
/// `x`/`y` sont ignorés (compat structurelle — la position est gérée par CSS).
#[napi]
pub fn create_view(
    rect: CompositorViewRect,
    screen_path: Option<String>,
    webcam_path: Option<String>,
    cursor_path: Option<String>,
) -> Result<i32> {
    let dir = fixture_dir();
    let screen = screen_path.unwrap_or_else(|| format!("{dir}/screen.mp4"));
    let webcam = webcam_path.unwrap_or_else(|| format!("{dir}/webcam.mp4"));
    let cursor = cursor_path.unwrap_or_else(|| format!("{dir}/screen.cursor.json"));
    let view = LiveView::create(
        rect.width.max(1) as u32,
        rect.height.max(1) as u32,
        &screen,
        &webcam,
        &cursor,
    )
    .map_err(|e| Error::from_reason(format!("{e:#}")))?;
    let id = {
        let mut n = NEXT_ID.lock().unwrap();
        let id = *n;
        *n += 1;
        id
    };
    registry().lock().unwrap().insert(id, view);
    Ok(id)
}

/// Met à jour la résolution cible du preview. L'ancienne sémantique « position
/// + taille de la fenêtre overlay » (`x, y, w, h`) n'a plus lieu d'être (la
/// preview est un bitmap posé sur un `<canvas>` Electron, positionné en CSS) :
/// on garde la même forme d'objet `CompositorViewRect` côté TS pour ne pas
/// casser l'ABI, mais `x`/`y` sont silencieusement ignorés et seules
/// `width`/`height` sont propagées au thread de rendu. La résolution prend
/// effet au prochain tour (`compositor::readback_resized` reconstruit la
/// staging si `width`/`height` ont changé).
#[napi]
pub fn set_rect(id: i32, rect: CompositorViewRect) {
    if let Some(v) = registry().lock().unwrap().get(&id) {
        v.set_rect(rect.width.max(1) as u32, rect.height.max(1) as u32);
    }
}

/// Renvoie la dernière frame RGBA8 readback du thread de rendu, dans un
/// `napi::Buffer` (octets R,G,B,A tightly-packed, `width * height * 4` octets,
/// même ordre que `putImageData(..., 'rgba8')` attend côté JS).
///
/// `Ok(None)` si :
///   - la vue `id` n'existe pas dans le registre (jamais créée ou déjà détruite),
///   - ou si aucune frame n'a encore été composée (1er appel avant que le
///     thread de rendu n'ait publié quoi que ce soit — composition suspendue tant
///     qu'aucune scène n'a été posée, lecture libre en pause avant la 1re frame,
///     etc.).
///
/// Le `Buffer` retourné est détaché du `Vec<u8>` interne (copie zéro-copy via
/// le mécanisme de `napi::bindgen_prelude::Buffer` — l'ownership du
/// stockage sous-jacent est transféré au JS GC). Le thread de rendu continue
/// à composer/remplacer le buffer interne à chaque frame sans bloquer le
/// thread Node ; le prochain `read_frame` verra la frame suivante.
///
/// Coût dominant : l'alloc `Vec<u8>` côté rendu + la copie `O(w·h)` vers le
/// Buffer napi — c'est le prix du transport cross-thread + cross-FFI.
#[napi]
pub fn read_frame(id: i32) -> Result<Option<Buffer>> {
    // Snapshot le pixel buffer HORS du lock du registre : on en a besoin vivant
    // (r#[napi] retourne un Buffer qui consomme l'ownership du Vec). Sinon le
    // MutexGuard serait tenu pendant que la frame est consommée par JS, ce qui
    // bloquerait tout autre appel napi (`set_rect`, `destroy_view`, ...).
    let slot = match registry().lock().unwrap().get(&id) {
        None => return Ok(None),
        Some(v) => v.latest_frame(),
    };
    match slot {
        None => Ok(None),
        Some((w, h, pixels)) => {
            debug_assert_eq!(pixels.len(), (w as usize) * (h as usize) * 4);
            // Format : R, G, B, A tightly-packed, ce que `ctx.putImageData(buffer, ...)` attend
            // via un `Uint8ClampedArray` côté JS (canvas 2D, format natif RGBA8). Le compactage
            // ignore le canal alpha (constant 255 — pas de transparence côté canvas, on rend sur
            // fond déjà opaque) mais on garde quand même les 4 octets pour respecter le contrat
            // `width*height*4` qu'on documente.
            Ok(Some(Buffer::from(pixels)))
        }
    }
}

/// Param live (inspector). Le type de valeur route vers le bon setter :
/// bool = switch (backgroundBlur…), number = slider (shadow/roundness/motionBlur),
/// string = sélection (backgroundColor "#rrggbb").
#[napi]
pub fn set_param(id: i32, key: String, value: Either3<bool, f64, String>) {
    if let Some(v) = registry().lock().unwrap().get(&id) {
        match value {
            Either3::A(b) => v.set_param_bool(&key, b),
            Either3::B(n) => v.set_param_num(&key, n),
            Either3::C(s) => v.set_param_str(&key, &s),
        }
    }
}

#[napi]
pub fn set_playing(id: i32, playing: bool) {
    if let Some(v) = registry().lock().unwrap().get(&id) {
        v.set_playing(playing);
    }
}

/// Positionne la vue au temps SOURCE du clip actif (conversion timeline faite côté renderer).
#[napi]
pub fn present_time(id: i32, seconds: f64) {
    if let Some(v) = registry().lock().unwrap().get(&id) {
        v.set_time(seconds);
    }
}

/// Remplace les sources du clip actif sans recréer la vue ni son thread de rendu. L'identité
/// timeline et le playhead source sont atomiques avec le switch : deux clips partageant les
/// mêmes fichiers restent distincts, et les deux décodeurs ouvrent directement la bonne frame.
#[napi]
pub fn set_active_clip(
    id: i32,
    screen_path: String,
    webcam_path: String,
    webcam_offset_sec: f64,
    clip_index: u32,
    source_time_sec: f64,
) {
    if let Some(v) = registry().lock().unwrap().get(&id) {
        v.set_active_clip(
            &screen_path,
            &webcam_path,
            webcam_offset_sec,
            clip_index as usize,
            source_time_sec,
        );
    }
}

/// Installe la scène de l'app (JSON `SceneDescription`) sur la vue : layout preset piloté par
/// l'app au lieu de la fixture. JSON invalide → ignoré côté natif.
#[napi]
pub fn set_scene(id: i32, scene_json: String) {
    if let Some(v) = registry().lock().unwrap().get(&id) {
        v.set_scene(&scene_json);
    }
}

#[napi]
pub fn destroy_view(id: i32) {
    // remove hors du lock : le Drop (join du thread de rendu) ne le tient pas.
    let removed = registry().lock().unwrap().remove(&id);
    drop(removed);
}

/// Bilan d'un export natif (mesure §10 : une lecture d'horloge avant-après tout le run).
#[napi(object)]
pub struct ExportStats {
    pub frames: u32,
    pub wall_s: f64,
    pub fps: f64,
    /// Durée de la vidéo exportée (secondes) — distincte de `wall_s` (temps de rendu réel).
    pub video_duration_s: f64,
}

/// Export mesuré, exécuté sur un thread worker libuv (l'UI n'est pas bloquée ; la mesure
/// reste enveloppante dans `run_composited`). Config = C8 (tous effets), pour comparer
/// directement au bench headless. Le device/compositeur/encodeur vivent sur ce thread.
pub struct ExportTask {
    out_path: String,
    on_progress: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
}

/// Builds a `progress: &mut dyn FnMut(u64)` closure (the shape both `run_composited` and
/// `run_composited_multi` already call once per encoded frame, for free — measured to not
/// affect the C8 benchmark's fps) that forwards to `tsfn`, throttled to ~10/s. Encoding at
/// typical export rates would otherwise cross the JS thread boundary dozens of times a
/// second for no UI benefit; the throttle keeps that cost negligible regardless of encode
/// speed. Always reports the very first tick (frame <= 1) so a fast/short export still
/// shows at least one progress update instead of jumping straight to the final Promise
/// resolution.
fn throttled_progress(
    tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
) -> impl FnMut(u64) {
    let mut last_sent = std::time::Instant::now() - std::time::Duration::from_secs(1);
    move |frames: u64| {
        let Some(tsfn) = &tsfn else { return };
        let now = std::time::Instant::now();
        if frames <= 1 || now.duration_since(last_sent).as_millis() >= 100 {
            last_sent = now;
            tsfn.call(frames as u32, ThreadsafeFunctionCallMode::NonBlocking);
        }
    }
}

/// Active/désactive la composition de toutes les previews vivantes (même process).
/// Désactivées, leurs threads de rendu cessent de composer/présenter → GPU libéré.
fn set_all_previews_playing(playing: bool) {
    if let Ok(reg) = registry().lock() {
        for v in reg.values() {
            v.set_playing(playing);
        }
    }
}

impl Task for ExportTask {
    type Output = (u32, f64, f64, f64);
    type JsValue = ExportStats;

    fn compute(&mut self) -> Result<Self::Output> {
        // Désactive les previews pendant le rendu pour libérer le moteur 3D du GPU
        // (mesuré : preview active ~72 fps → preview off ~125 fps). Réactivées ensuite,
        // même en cas d'erreur.
        set_all_previews_playing(false);
        let result = (|| {
            let dir = fixture_dir();
            let gpu = Gpu::create(false).map_err(|e| Error::from_reason(format!("{e:#}")))?;
            let comp = Compositor::new(&gpu).map_err(|e| Error::from_reason(format!("{e:#}")))?;
            if let Ok(t) = CursorTrack::load(&format!("{dir}/screen.cursor.json"), 100_000.0, 6.0) {
                comp.set_cursor(t);
            }
            let cfg = config::all().pop().expect("au moins une config"); // C8
            let mut progress = throttled_progress(self.on_progress.take());
            let s = pipeline::run_composited(
                &format!("{dir}/screen.mp4"),
                &format!("{dir}/webcam.mp4"),
                &self.out_path,
                &gpu,
                &comp,
                &cfg,
                &mut progress,
            )
            .map_err(|e| Error::from_reason(format!("{e:#}")))?;
            Ok((s.frames as u32, s.wall_s, s.fps, s.video_duration_s))
        })();
        set_all_previews_playing(true);
        result
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(ExportStats { frames: out.0, wall_s: out.1, fps: out.2, video_duration_s: out.3 })
    }
}

/// Convertit une fonction JS optionnelle en `ThreadsafeFunction` appelable depuis le thread
/// libuv qui exécute `Task::compute` — c'est la seule façon de rappeler JS depuis là. Chaque
/// appel transporte juste le nombre de frames encodées (`u32`) ; le JS connaît déjà le total
/// attendu (durée × fps des clips) et calcule le pourcentage lui-même.
fn make_progress_tsfn(
    f: Option<JsFunction>,
) -> Result<Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>> {
    f.map(|f| f.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value])))
        .transpose()
}

/// Lance un export natif (fixture → MP4, C8) et résout `Promise<ExportStats>`.
/// `on_progress(framesEncodées)` optionnel — rappelé côté JS à ~10 Hz max pendant le rendu.
#[napi]
pub fn export(out_path: String, on_progress: Option<JsFunction>) -> Result<AsyncTask<ExportTask>> {
    Ok(AsyncTask::new(ExportTask { out_path, on_progress: make_progress_tsfn(on_progress)? }))
}

/// Un clip de la timeline pour l'export multiclip (JS : camelCase).
#[napi(object)]
pub struct ClipInput {
    pub screen_path: String,
    pub webcam_path: String,
    pub source_start_sec: f64,
    pub source_end_sec: f64,
    /// Décalage caméra (s) : temps source webcam = temps source screen - offset.
    pub webcam_offset_sec: f64,
    /// `false` évite une ouverture ffmpeg vouée à échouer et réserve du silence à ce clip.
    pub has_audio: bool,
}

/// Taille/cadence/codec de sortie voulus par l'app (modale d'export). Tous optionnels :
/// absent → comportement historique (1920x1080, fps du 1er clip, h264). `width`/`height`
/// sont arrondis au pair le plus proche (exigence NV12 4:2:0) côté `export_multi`.
#[napi(object)]
pub struct ExportParamsInput {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<u32>,
    /// "h264" | "h265". Toute autre valeur (ex. "vp9", pas d'équivalent matériel AMF) fait
    /// échouer l'export avec un message clair plutôt que de silencieusement retomber sur h264.
    pub codec: Option<String>,
}

/// Export multiclip mesuré (worker libuv). Rend la vraie timeline (clips + trims) en un MP4.
/// `scene_json` (optionnel) = la même scène que la preview live : fond/layout/webcam/curseur —
/// sans elle on ne retomberait QUE sur le layout fixture A↔B, plus du tout ce que l'utilisateur
/// a configuré (le bug corrigé ici). Layout/zoom restent statiques (pas encore de zoom regions
/// ni de camera-fullscreen animés côté export). Réactive les previews après coup (même en erreur).
pub struct ExportMultiTask {
    out_path: String,
    clips: Vec<pipeline::ClipSource>,
    scene_json: Option<String>,
    params: Option<ExportParamsInput>,
    on_progress: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
}

impl Task for ExportMultiTask {
    type Output = (u32, f64, f64, f64);
    type JsValue = ExportStats;

    fn compute(&mut self) -> Result<Self::Output> {
        set_all_previews_playing(false);
        let result = (|| {
            let gpu = Gpu::create(false).map_err(|e| Error::from_reason(format!("{e:#}")))?;
            let comp = Compositor::new(&gpu).map_err(|e| Error::from_reason(format!("{e:#}")))?;
            let mut cfg = config::all().pop().expect("au moins une config"); // C8
            cfg.zoom = false;
            cfg.layout_anim = false;
            cfg.mblur_n = 1; // layout statique → pas de motion blur de layout (pas de surcoût)

            // scène de l'app = même chemin que la preview live : fond, layout, webcam, curseur.
            // JSON absent/invalide → pas de scène (fixture), pareil que si la preview n'en avait
            // jamais reçu — jamais un fallback masquant, juste rien de configuré.
            let scene = self.scene_json.as_deref().and_then(|j| Scene::from_json(j).ok());
            if let Some(scene) = &scene {
                comp.set_live_params(live_params_from_scene(scene));
                cfg.bg_blur = scene.effects.blur;
                cfg.cursor = scene.cursor.show;
            } else {
                cfg.cursor = false;
            }
            comp.set_scene(scene);

            let mut export_params = pipeline::ExportParams::default();
            if let Some(p) = &self.params {
                if let Some(w) = p.width {
                    export_params.width = w.max(2) & !1; // pair le plus proche (>=2, NV12)
                }
                if let Some(h) = p.height {
                    export_params.height = h.max(2) & !1;
                }
                export_params.fps = p.fps;
                if let Some(codec) = &p.codec {
                    export_params.codec = match codec.as_str() {
                        "h264" => pipeline::ExportCodec::H264,
                        "h265" => pipeline::ExportCodec::H265,
                        other => {
                            return Err(Error::from_reason(format!(
                                "codec d'export \"{other}\" non supporté par le pipeline natif (h264/h265 seulement — pas d'équivalent matériel AMF pour VP9, et le chemin logiciel testé était trop lent pour être utile)"
                            )));
                        }
                    };
                }
            }

            let mut progress = throttled_progress(self.on_progress.take());
            let s = pipeline::run_composited_multi(
                &self.clips,
                &self.out_path,
                &gpu,
                &comp,
                &cfg,
                &export_params,
                &mut progress,
            )
            .map_err(|e| Error::from_reason(format!("{e:#}")))?;
            Ok((s.frames as u32, s.wall_s, s.fps, s.video_duration_s))
        })();
        set_all_previews_playing(true);
        result
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(ExportStats { frames: out.0, wall_s: out.1, fps: out.2, video_duration_s: out.3 })
    }
}

/// Lance un export multiclip natif (vraie timeline → MP4) et résout `Promise<ExportStats>`.
/// `scene_json` : même `SceneDescription` que la preview (fond/layout/webcam/effets/curseur).
/// `params` : taille/cadence/codec de sortie voulus (absent → 1920x1080/fps du 1er clip/h264).
/// `on_progress(framesEncodées)` optionnel — rappelé côté JS à ~10 Hz max pendant le rendu ;
/// le JS calcule lui-même le pourcentage (il connaît déjà le total attendu, durée×fps des clips).
#[napi]
pub fn export_multi(
    clips: Vec<ClipInput>,
    out_path: String,
    scene_json: Option<String>,
    params: Option<ExportParamsInput>,
    on_progress: Option<JsFunction>,
) -> Result<AsyncTask<ExportMultiTask>> {
    let clips = clips
        .into_iter()
        .map(|c| pipeline::ClipSource {
            screen: c.screen_path,
            webcam: c.webcam_path,
            source_start_sec: c.source_start_sec,
            source_end_sec: c.source_end_sec,
            webcam_offset_sec: c.webcam_offset_sec,
            has_audio: c.has_audio,
        })
        .collect();
    Ok(AsyncTask::new(ExportMultiTask {
        out_path,
        clips,
        scene_json,
        params,
        on_progress: make_progress_tsfn(on_progress)?,
    }))
}
