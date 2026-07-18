//! Addon napi-rs : pont Electron ↔ `poc_d3d::live::LiveView`. Expose la vue D3D enfant
//! embarquée (Option A) à la glue TS (native-bridge domaine "compositor"). Les `#[napi]`
//! sont appelés depuis le thread principal Node (là où vit la `BrowserWindow`), donc la
//! fenêtre enfant est créée sur ce thread ; le rendu vit sur le thread de `LiveView`.

use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;
use poc_d3d::compositor::Compositor;
use poc_d3d::cursor::CursorTrack;
use poc_d3d::d3d::Gpu;
use poc_d3d::live::LiveView;
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
    type Output = (u32, f64, f64);
    type JsValue = ExportStats;

    fn compute(&mut self) -> Result<Self::Output> {
        // Désactive les previews pendant le rendu pour libérer le moteur 3D du GPU
        // (mesuré : preview active ~72 fps → preview off ~125 fps). Réactivées ensuite,
        // même en cas d'erreur.
        set_all_previews_playing(false);
        let result = (|| {
            let dir = fixture_dir();
            let gpu = Gpu::create(false).map_err(|e| Error::from_reason(format!("{e:#}")))?;
            let mut comp = Compositor::new(&gpu).map_err(|e| Error::from_reason(format!("{e:#}")))?;
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
            Ok((s.frames as u32, s.wall_s, s.fps))
        })();
        set_all_previews_playing(true);
        result
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(ExportStats { frames: out.0, wall_s: out.1, fps: out.2 })
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

/// Export multiclip mesuré (worker libuv). Rend la vraie timeline (clips + trims) en un MP4.
/// Layout statique (zoom/anim off, motion blur de layout off, curseur off) → composite propre
/// des vraies sources sans surcoût. Réactive les previews après le rendu (même en erreur).
pub struct ExportMultiTask {
    out_path: String,
    clips: Vec<pipeline::ClipSource>,
}

impl Task for ExportMultiTask {
    type Output = (u32, f64, f64);
    type JsValue = ExportStats;

    fn compute(&mut self) -> Result<Self::Output> {
        set_all_previews_playing(false);
        let result = (|| {
            let gpu = Gpu::create(false).map_err(|e| Error::from_reason(format!("{e:#}")))?;
            let comp = Compositor::new(&gpu).map_err(|e| Error::from_reason(format!("{e:#}")))?;
            let mut cfg = config::all().pop().expect("au moins une config"); // C8
            cfg.zoom = false;
            cfg.layout_anim = false;
            cfg.cursor = false; // pas de télémétrie curseur mappée encore
            cfg.mblur_n = 1; // layout statique → pas de motion blur de layout (pas de surcoût)
            let s = pipeline::run_composited_multi(
                &self.clips,
                &self.out_path,
                &gpu,
                &comp,
                &cfg,
                &mut |_| {},
            )
            .map_err(|e| Error::from_reason(format!("{e:#}")))?;
            Ok((s.frames as u32, s.wall_s, s.fps))
        })();
        set_all_previews_playing(true);
        result
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(ExportStats { frames: out.0, wall_s: out.1, fps: out.2 })
    }
}

/// Lance un export multiclip natif (vraie timeline → MP4) et résout `Promise<ExportStats>`.
#[napi]
pub fn export_multi(clips: Vec<ClipInput>, out_path: String) -> AsyncTask<ExportMultiTask> {
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
    AsyncTask::new(ExportMultiTask { out_path, clips })
}
