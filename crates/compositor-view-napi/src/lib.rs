//! Addon napi-rs : pont Electron ↔ `openscreen_compositor::live::LiveView`. Expose la vue
//! offscreen (Option B, post-readback `Vec<u8>` RGBA8 → `<canvas>` HTML) à la
//! glue TS (native-bridge domaine "compositor"). Les `#[napi]` sont appelés
//! depuis le thread principal Node (là où vit la `BrowserWindow`) ; le rendu et
//! la publication de la dernière frame vivent sur le thread dédié de `LiveView`
//! et sont récupérés via `read_frame`.

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, JsFunction, Task};
use napi_derive::napi;
use openscreen_compositor::compositor::{live_params_from_scene, Compositor};
use openscreen_compositor::d3d::{Backend, Gpu};
use openscreen_compositor::gif_export::{GifExportParams, GifStats};
use openscreen_compositor::live::{LiveView, PausedPreviews};
use openscreen_compositor::scene::Scene;
use openscreen_compositor::{config, pipeline};
use std::collections::HashMap;
use std::path::PathBuf;
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

/// Crée une vue **offscreen** (pas de HWND, pas de fenêtre native). Démarre juste
/// un thread de rendu qui compose chaque frame, blit-resize vers `rect.width`×
/// `rect.height` (réutilise le même `ensure_resize_target`/`blit_resized` que
/// l'export), lit le résultat vers CPU via staging `D3D11_USAGE_STAGING` +
/// `Map`/`Unmap` et stocke un `Vec<u8>` RGBA8 tightly-packed dans la vue pour
/// que `read_frame` le retourne à la glue TS.
///
/// `screen_path` est requis (F3 : le vrai enregistrement de l'app — deux
/// fichiers H264 séparés). `webcam_path`/`cursor_path` sont optionnels
/// (absents → pas de caméra / pas de curseur).
///
/// `rect` ne sert plus que pour `width`/`height` (résolution cible du preview) ;
/// `x`/`y` sont ignorés (compat structurelle — la position est gérée par CSS).
/// Quel backend cette machine utilisera : `"hardware"`, `"cpu"`, ou `"none"` si aucun
/// device D3D11 ne se crée (la vue échouera alors avec son propre message, plus précis).
///
/// Sert à PRÉVENIR : sur `"cpu"`, le rendu passe par WARP + décodage logiciel — la
/// preview tombe à ~8 fps avec tous les effets et l'export met des minutes au lieu de
/// secondes. L'utilisateur doit le savoir AVANT de lancer un export, pas après. D'où une
/// question posée au système et non à une vue : la modale d'export la pose sans qu'aucune
/// preview n'existe. Réponse mise en cache côté Rust — c'est une propriété de la machine.
#[napi]
pub fn probe_backend() -> String {
    match Gpu::probe() {
        Some(Backend::Hardware) => "hardware",
        Some(Backend::Cpu) => "cpu",
        None => "none",
    }
    .to_string()
}

#[napi]
pub fn create_view(
    rect: CompositorViewRect,
    screen_path: Option<String>,
    webcam_path: Option<String>,
    cursor_path: Option<String>,
) -> Result<i32> {
    let screen = screen_path
        .ok_or_else(|| Error::from_reason("create_view: screen_path is required"))?;
    let webcam = webcam_path.unwrap_or_default();
    let cursor = cursor_path.unwrap_or_default();
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

/// Une frame de preview auto-descriptive : ses pixels PLUS tout ce qu'il faut pour
/// les interpréter (dimensions) et pour décider s'il faut les repeindre (génération).
/// Retournée par `read_frame`. Le consommateur JS n'a plus à deviner la taille depuis
/// `canvas.width` (ancien couplage implicite fragile) : elle voyage avec les octets.
#[napi(object)]
pub struct FramePacket {
    /// Génération monotone de CETTE frame (≥ 1). Le consommateur la retient et la
    /// repasse en `since_gen` au prochain appel ; tant qu'elle ne change pas, il n'y
    /// a rien de neuf à peindre. `f64` car napi n'expose pas `u64` — sans risque : la
    /// génération n'atteindra jamais 2^53 (ce serait des milliards d'années de rendu).
    pub gen: f64,
    pub width: u32,
    pub height: u32,
    /// R,G,B,A tightly-packed, `width * height * 4` octets — ce que `putImageData` /
    /// `ImageData` attendent côté JS (canvas 2D, format natif RGBA8).
    pub data: Buffer,
}

/// Renvoie la dernière frame readback du thread de rendu SI elle est plus récente que
/// `since_gen`, sous forme de {@link FramePacket} (génération + dimensions + pixels).
///
/// `Ok(None)` — le consommateur n'a rien à peindre — si :
///   - la vue `id` n'existe pas dans le registre (jamais créée ou déjà détruite),
///   - aucune frame n'a encore été composée (1er appel avant que le thread de rendu
///     n'ait publié quoi que ce soit), OU
///   - le consommateur possède déjà la génération courante (`gen <= since_gen`). C'est
///     le cas dominant en édition (preview figée en pause) : on renvoie `None` SANS
///     cloner le buffer ni traverser l'IPC. Tout le coût `O(w·h)` par frame — clone
///     Rust + structured-clone IPC + copies canvas — disparaît tant que rien ne bouge.
///     Passer `since_gen = 0` force la livraison de la frame courante (1re lecture).
///
/// Quand une frame EST retournée, son `data` est détaché du `Vec<u8>` interne
/// (l'ownership passe au JS GC) ; le thread de rendu continue à composer sans bloquer
/// le thread Node.
#[napi]
pub fn read_frame(id: i32, since_gen: f64) -> Result<Option<FramePacket>> {
    // Snapshot le pixel buffer HORS du lock du registre : on en a besoin vivant
    // (r#[napi] retourne un Buffer qui consomme l'ownership du Vec). Sinon le
    // MutexGuard serait tenu pendant que la frame est consommée par JS, ce qui
    // bloquerait tout autre appel napi (`set_rect`, `destroy_view`, ...).
    let slot = match registry().lock().unwrap().get(&id) {
        None => return Ok(None),
        Some(v) => {
            // Le thread de rendu est mort (device D3D11 indisponible, décodeur en échec…) :
            // il ne publiera plus jamais de frame. Sans ce relais, `create_view` a déjà
            // répondu Ok et l'échec ne se voyait que dans un `eprintln!` — l'utilisateur
            // restait devant un canvas noir sans explication (PR #162). La boucle de pull
            // du renderer appelle ceci ~30×/s, donc l'erreur remonte tout de suite, et par
            // le chemin d'erreur que `read_frame` a déjà (`Result`), sans changer le contrat.
            if let Some(fatal) = v.fatal_error() {
                return Err(Error::from_reason(fatal));
            }
            v.latest_frame_since(since_gen.max(0.0) as u64)
        }
    };
    Ok(slot.map(|(gen, w, h, pixels)| {
        debug_assert_eq!(pixels.len(), (w as usize) * (h as usize) * 4);
        FramePacket {
            gen: gen as f64,
            width: w,
            height: h,
            data: Buffer::from(pixels),
        }
    }))
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

/// Bilan d'un export GIF natif. Mêmes champs que `ExportStats` (frames /
/// wall / fps / durée) plus la taille du fichier sur disque — le format
/// est petit (256-color indexed + LZW) et la taille est une mesure
/// d'utilité, pas un détail technique. Sert à la fois au bench et à
/// l'UI d'export, seul chemin GIF de l'app.
#[napi(object)]
pub struct GifExportStats {
    pub frames: u32,
    pub wall_s: f64,
    pub fps: f64,
    /// Durée du GIF exporté (s) — distincte de `wall_s` (temps de rendu).
    pub video_duration_s: f64,
    /// Taille du fichier `.gif` final sur disque (octets), mesurée après
    /// le drop de l'encodeur (donc après le flush du trailer GIF89a).
    pub file_bytes: f64,
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

/// Pauses every live preview of this process for the duration of an export — their render
/// threads stop composing/presenting, which frees the GPU's 3D engine (measured: preview on
/// ~72 fps → preview off ~125 fps) — and gives each one back the transport it was found with
/// when dropped, including on an early `return Err` or a panic.
///
/// Restoring the saved state instead of resuming everything is the whole point; see
/// `PausedPreviews` for the bug the blanket resume caused (a preview left free-running behind
/// a paused editor, ending up on another clip's scene with the zoom regions filtered out).
struct PreviewPause(PausedPreviews<i32>);

impl PreviewPause {
    fn begin() -> Self {
        // A poisoned registry means some other napi call panicked mid-mutation; the export
        // itself is still worth running, we just have no previews we can speak for.
        Self(match registry().lock() {
            Ok(reg) => PausedPreviews::pause(reg.iter().map(|(id, view)| (*id, view))),
            Err(_) => PausedPreviews::default(),
        })
    }
}

impl Drop for PreviewPause {
    fn drop(&mut self) {
        if let Ok(reg) = registry().lock() {
            self.0.restore(reg.iter().map(|(id, view)| (*id, view)));
        }
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
/// ni de camera-fullscreen animés côté export). Rend aux previews le transport qu'elles avaient
/// (même en erreur) — voir `PreviewPause`.
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
        // Previews paused for the whole render (GPU 3D engine freed) and restored
        // exactly as found when this guard drops, including on the error paths.
        let _previews = PreviewPause::begin();
        // Même sélection que la preview : l'export d'un hôte sans GPU passe par
        // libopenh264 au lieu d'AMF, plutôt que d'échouer.
        let gpu = Gpu::create_auto(false).map_err(|e| Error::from_reason(format!("{e:#}")))?;
        let mut cfg = config::all().pop().expect("au moins une config"); // C8
        cfg.zoom = false;
        cfg.layout_anim = false;
        cfg.mblur_n = 1; // layout statique → pas de motion blur de layout (pas de surcoût)

        // scène de l'app = même chemin que la preview live : fond, layout, webcam, curseur.
        // JSON absent/invalide → pas de scène (fixture), pareil que si la preview n'en avait
        // jamais reçu — jamais un fallback masquant, juste rien de configuré.
        let scene = self.scene_json.as_deref().and_then(|j| Scene::from_json(j).ok());
        if let Some(scene) = &scene {
            cfg.bg_blur = scene.effects.blur;
            cfg.cursor = scene.cursor.show;
        } else {
            cfg.cursor = false;
        }

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

        // Le compositeur rastérise à la taille RÉELLEMENT encodée — d'où sa
        // construction ici, une fois `export_params` résolu.
        //
        // Avant : il composait toujours en 1920×1080 puis `blit_resized` étirait
        // vers la taille d'export. Deux défauts, une seule cause — tout export
        // dépassant 1080p sur un axe était un AGRANDISSEMENT (un 4K portait le
        // quart de l'information), et tout ratio ≠ 16:9 devait passer par une
        // compensation géométrique. En construisant le compositeur à la
        // géométrie de sortie, `blit_resized` devient une identité et les pixels
        // sont rastérisés exactement là où ils seront encodés.
        let comp = Compositor::new_sized(&gpu, export_params.width, export_params.height)
            .map_err(|e| Error::from_reason(format!("{e:#}")))?;
        if let Some(scene) = &scene {
            comp.set_live_params(live_params_from_scene(scene));
        }
        comp.set_scene(scene);

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

/// Sortie GIF native (slice 1) — taille, cadence, compteur de loop, dithering.
/// Tout optionnel : absent → 854×480, 12 fps, boucle infinie, pas de
/// dithering. Les défauts sont choisis pour un export « petit / net » :
/// GIF est un format 256-couleurs, 12 fps est la cadence historique de
/// `gif.js` côté renderer, et 854×480 tient confortablement dans la
/// palette 8 bits sans banding visible sur du contenu de présentation.
#[napi(object)]
pub struct GifParamsInput {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<u32>,
    /// Compteur de loop GIF : `None` ou `0` = infini, sinon `n` boucles.
    pub loop_count: Option<u16>,
    /// Floyd-Steinberg error diffusion avant quantification. Off par
    /// défaut (qualité acceptable sans, et ça double تقريبًا le coût
    /// CPU du quantize par frame).
    pub dither: Option<bool>,
}

/// Tâche d'export GIF (worker libuv, comme `ExportMultiTask`). Le
/// pipeline natif vit dans `openscreen_compositor::gif_export` ; ce
/// binding n'est qu'un adaptateur qui :
///   1. résout la `screen.cursor.json` sidecar selon la convention
///      `ExportDialog` (même chemin que `run_composited_multi` côté
///      MP4 — voir `pipeline.rs:1199`),
///   2. construit un `GifExportParams` à partir du `GifParamsInput`,
///   3. appelle `gif_export::export_gif` et reporte le `GifStats` au JS.
///
/// `cursor_path` est optionnel : un export sans curseur (utile pour
/// tester la pipeline) est légitime. La fonction côté Rust prend
/// `Option<&str>`, et `None` désactive le rendu du curseur côté
/// `Compositor` (équivalent de `cfg.cursor = false` dans
/// `run_composited_multi`).
pub struct ExportGifTask {
    /// Same clip list the MP4 export takes — GIF is now a multiclip export
    /// driven by the same walk, not a single-file special case.
    clips: Vec<pipeline::ClipSource>,
    /// Scene JSON from the app, exactly as `exportMulti` receives it: it
    /// carries background, layout, webcam and cursor. Absent/invalid → no
    /// scene, same as a preview that was never configured.
    scene_json: Option<String>,
    out_path: PathBuf,
    params: GifExportParams,
    on_progress: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
}

impl Task for ExportGifTask {
    type Output = GifStats;
    type JsValue = GifExportStats;

    fn compute(&mut self) -> Result<Self::Output> {
        // Mêmes garanties que `ExportMultiTask` : previews paused for the
        // whole render et restored exactement comme trouvées, y compris
        // sur les chemins d'erreur. L'export GPU+CPU ne partage pas le
        // RT avec la preview (sa propre `Compositor::new_sized`) mais le
        // 3D engine de la preview pollue quand même, d'où la pause.
        let _previews = PreviewPause::begin();

        // Same construction as ExportMultiTask — GIF and MP4 differ only in the
        // encoder, so everything up to it is built identically. That includes the
        // device: `create_auto`, not `create`. `create` is hardware-strict (goldens
        // and benches want to fail rather than measure a software rasteriser), so a
        // host without a usable GPU could export an MP4 but not a GIF — the one path
        // where the CPU backend exists specifically so the export still completes.
        let gpu = Gpu::create_auto(false).map_err(|e| Error::from_reason(format!("{e:#}")))?;
        let mut cfg = config::all().pop().expect("au moins une config"); // C8
        cfg.zoom = false;
        cfg.layout_anim = false;
        cfg.mblur_n = 1;

        let scene = self.scene_json.as_deref().and_then(|j| Scene::from_json(j).ok());
        if let Some(scene) = &scene {
            cfg.bg_blur = scene.effects.blur;
            cfg.cursor = scene.cursor.show;
        } else {
            cfg.cursor = false;
        }

        let width = self
            .params
            .width
            .unwrap_or(openscreen_compositor::gif_export::DEFAULT_GIF_WIDTH);
        let height = self
            .params
            .height
            .unwrap_or(openscreen_compositor::gif_export::DEFAULT_GIF_HEIGHT);
        let comp = Compositor::new_sized(&gpu, width, height)
            .map_err(|e| Error::from_reason(format!("{e:#}")))?;
        if let Some(scene) = &scene {
            comp.set_live_params(live_params_from_scene(scene));
        }
        comp.set_scene(scene);

        let mut progress = throttled_progress(self.on_progress.take());
        openscreen_compositor::gif_export::export_gif(
            &self.clips,
            &self.out_path,
            &gpu,
            &comp,
            &cfg,
            &self.params,
            &mut progress,
        )
        .map_err(|e| Error::from_reason(format!("{e:#}")))
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(GifExportStats {
            frames: out.frames as u32,
            wall_s: out.wall_s,
            fps: out.fps,
            video_duration_s: out.video_duration_s,
            file_bytes: out.file_bytes as f64,
        })
    }
}

/// Lance un export GIF natif — le seul chemin GIF depuis la suppression de
/// l'exporteur `gif.js` — et résout `Promise<GifExportStats>`. `screen_path` et `webcam_path` sont
/// requis (la convention de l'app : deux fichiers H264 séparés, voir
/// `ClipInput` côté MP4). `cursor_path` est optionnel — s'il est `null` ou
/// pointe vers un fichier absent, l'export rend sans curseur (le `Player`
/// compose quand même les frames, la scène du curseur est juste vide).
/// `params` : taille, cadence, loop, dithering — tous optionnels, défauts
/// dans `GifExportParams::default`. `on_progress(framesProduced)` optionnel,
/// throttled à ~10/s comme l'export MP4 (voir `throttled_progress`).
#[napi]
pub fn export_gif(
    clips: Vec<ClipInput>,
    out_path: String,
    scene_json: Option<String>,
    params: Option<GifParamsInput>,
    on_progress: Option<JsFunction>,
) -> Result<AsyncTask<ExportGifTask>> {
    // Deliberately the same argument shape as `export_multi`: the caller builds
    // one clip list and one scene, and picks the container. Cursor comes from
    // the scene like every other effect — there is no GIF-specific input left.
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
    let gif_params = params
        .map(|p| GifExportParams {
            width: p.width,
            height: p.height,
            fps: p.fps,
            loop_count: p.loop_count,
            dither: p.dither.unwrap_or(false),
        })
        .unwrap_or_default();
    Ok(AsyncTask::new(ExportGifTask {
        clips,
        scene_json,
        out_path: PathBuf::from(out_path),
        params: gif_params,
        on_progress: make_progress_tsfn(on_progress)?,
    }))
}

/// Bilan d'un remux, tel que le voit la glue TS.
#[napi(object)]
pub struct RemuxStats {
    /// Paquets recopiés, toutes pistes confondues. `f64` car napi n'expose pas
    /// `u64` — sans risque, un enregistrement plausible reste très loin de 2^53.
    pub packets: f64,
    pub streams: u32,
    pub wall_s: f64,
}

pub struct RemuxTask {
    input_path: String,
    output_path: String,
}

impl Task for RemuxTask {
    type Output = openscreen_compositor::remux::RemuxStats;
    type JsValue = RemuxStats;

    fn compute(&mut self) -> Result<Self::Output> {
        openscreen_compositor::remux::remux_to_seekable_matroska(&self.input_path, &self.output_path)
            .map_err(|e| Error::from_reason(format!("{e:#}")))
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(RemuxStats {
            packets: out.packets as f64,
            streams: out.streams,
            wall_s: out.wall_s,
        })
    }
}

/// Recopie `input_path` vers `output_path` par le muxer matroska (aucun
/// ré-encodage) pour doter le fichier des `Cues`/`SeekHead` que `MediaRecorder`
/// n'écrit pas. Voir `openscreen_compositor::remux` pour le détail.
///
/// `AsyncTask` et pas une fonction synchrone : le remux lit et réécrit tout le
/// fichier, ce qui se compte en secondes sur un long enregistrement. Le faire
/// sur le thread principal de Node gèlerait la fenêtre pendant la sauvegarde,
/// exactement au moment où l'UI affiche « enregistrement en cours ».
///
/// `output_path` doit être un chemin TEMPORAIRE : c'est au caller TS de
/// renommer par-dessus l'original une fois la promesse résolue, pour qu'un échec
/// laisse l'enregistrement intact.
#[napi]
pub fn remux_seekable(input_path: String, output_path: String) -> AsyncTask<RemuxTask> {
    AsyncTask::new(RemuxTask {
        input_path,
        output_path,
    })
}
