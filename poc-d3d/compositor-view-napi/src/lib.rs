//! Addon napi-rs : pont Electron ↔ `poc_d3d::live::LiveView`. Expose la vue D3D enfant
//! embarquée (Option A) à la glue TS (native-bridge domaine "compositor"). Les `#[napi]`
//! sont appelés depuis le thread principal Node (là où vit la `BrowserWindow`), donc la
//! fenêtre enfant est créée sur ce thread ; le rendu vit sur le thread de `LiveView`.

use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;
use poc_d3d::compositor::{live_params_from_scene, Compositor};
use poc_d3d::cursor::CursorTrack;
use poc_d3d::d3d::Gpu;
use poc_d3d::live::LiveView;
use poc_d3d::scene::Scene;
use poc_d3d::{config, pipeline};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use windows::Win32::Foundation::HWND;

/// Rect en pixels device, relatif au client de la fenêtre parente (miroir de la glue TS).
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

/// `getNativeWindowHandle()` d'Electron : buffer little-endian contenant le HWND natif.
fn hwnd_from_buffer(buf: &Buffer) -> HWND {
    let bytes: &[u8] = buf.as_ref();
    let mut v: usize = 0;
    for (i, b) in bytes.iter().take(std::mem::size_of::<usize>()).enumerate() {
        v |= (*b as usize) << (8 * i);
    }
    HWND(v as *mut core::ffi::c_void)
}

/// Répertoire fixture (POC) : env `OPENSCREEN_COMPOSITOR_FIXTURE`, sinon défaut local.
/// Le Lot 3 fournira les vraies sources ; ici on prouve l'embed avec la fixture.
fn fixture_dir() -> String {
    std::env::var("OPENSCREEN_COMPOSITOR_FIXTURE").unwrap_or_else(|_| {
        r"C:\Users\camil\Documents\repos\openscreen\.claude\worktrees\prerelease-version-tag-ee96ae\poc-d3d\fixture".to_string()
    })
}

/// Crée une vue. Si `screen_path`/`webcam_path` sont fournis (F3 : le vrai enregistrement
/// de l'app — deux fichiers H264 séparés), on rend ces sources ; sinon on retombe sur la
/// fixture POC. `cursor_path` optionnel (télémétrie curseur ; absent → pas de curseur).
#[napi]
pub fn create_view(
    parent_handle: Buffer,
    rect: CompositorViewRect,
    screen_path: Option<String>,
    webcam_path: Option<String>,
    cursor_path: Option<String>,
) -> Result<i32> {
    let hwnd = hwnd_from_buffer(&parent_handle);
    let dir = fixture_dir();
    let screen = screen_path.unwrap_or_else(|| format!("{dir}/screen.mp4"));
    let webcam = webcam_path.unwrap_or_else(|| format!("{dir}/webcam.mp4"));
    let cursor = cursor_path.unwrap_or_else(|| format!("{dir}/screen.cursor.json"));
    let view = LiveView::create(
        hwnd,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
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

#[napi]
pub fn set_rect(id: i32, rect: CompositorViewRect) {
    if let Some(v) = registry().lock().unwrap().get(&id) {
        v.set_rect(rect.x, rect.y, rect.width, rect.height);
    }
}

/// Masque/affiche l'overlay natif — nécessaire quand une modale web (export…) doit passer
/// devant : c'est une fenêtre top-level hors de la surface Chromium, le z-index CSS n'y peut
/// rien.
#[napi]
pub fn set_view_visible(id: i32, visible: bool) {
    if let Some(v) = registry().lock().unwrap().get(&id) {
        v.set_visible(visible);
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

/// Positionne la vue au temps `seconds` (seek piloté par la playhead de l'app).
#[napi]
pub fn present_time(id: i32, seconds: f64) {
    if let Some(v) = registry().lock().unwrap().get(&id) {
        v.set_time(seconds);
    }
}

/// Remplace les sources du clip actif sans recréer la vue ni son thread de rendu.
#[napi]
pub fn set_active_clip(
    id: i32,
    screen_path: String,
    webcam_path: String,
    webcam_offset_sec: f64,
) {
    if let Some(v) = registry().lock().unwrap().get(&id) {
        v.set_active_clip(&screen_path, &webcam_path, webcam_offset_sec);
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
    // remove hors du lock : le Drop (join du thread de rendu + DestroyWindow) ne le tient pas.
    let removed = registry().lock().unwrap().remove(&id);
    drop(removed);
}

/// Bilan d'un export natif (mesure §10 : une lecture d'horloge avant/après tout le run).
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
            let s = pipeline::run_composited(
                &format!("{dir}/screen.mp4"),
                &format!("{dir}/webcam.mp4"),
                &self.out_path,
                &gpu,
                &comp,
                &cfg,
                &mut |_| {},
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

/// Lance un export natif (fixture → MP4, C8) et résout `Promise<ExportStats>`.
#[napi]
pub fn export(out_path: String) -> AsyncTask<ExportTask> {
    AsyncTask::new(ExportTask { out_path })
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

            let s = pipeline::run_composited_multi(
                &self.clips,
                &self.out_path,
                &gpu,
                &comp,
                &cfg,
                &export_params,
                &mut |_| {},
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
#[napi]
pub fn export_multi(
    clips: Vec<ClipInput>,
    out_path: String,
    scene_json: Option<String>,
    params: Option<ExportParamsInput>,
) -> AsyncTask<ExportMultiTask> {
    let clips = clips
        .into_iter()
        .map(|c| pipeline::ClipSource {
            screen: c.screen_path,
            webcam: c.webcam_path,
            source_start_sec: c.source_start_sec,
            source_end_sec: c.source_end_sec,
            webcam_offset_sec: c.webcam_offset_sec,
        })
        .collect();
    AsyncTask::new(ExportMultiTask { out_path, clips, scene_json, params })
}
