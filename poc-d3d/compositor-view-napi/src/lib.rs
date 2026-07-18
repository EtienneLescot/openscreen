//! Addon napi-rs : pont Electron ↔ `poc_d3d::live::LiveView`. Expose la vue D3D enfant
//! embarquée (Option A) à la glue TS (native-bridge domaine "compositor"). Les `#[napi]`
//! sont appelés depuis le thread principal Node (là où vit la `BrowserWindow`), donc la
//! fenêtre enfant est créée sur ce thread ; le rendu vit sur le thread de `LiveView`.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use poc_d3d::live::LiveView;
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

#[napi]
pub fn create_view(parent_handle: Buffer, rect: CompositorViewRect) -> Result<i32> {
    let hwnd = hwnd_from_buffer(&parent_handle);
    let dir = fixture_dir();
    let view = LiveView::create(
        hwnd,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        &format!("{dir}/screen.mp4"),
        &format!("{dir}/webcam.mp4"),
        &format!("{dir}/screen.cursor.json"),
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

/// Param live. Phase 1 : seul `backgroundBlur` (booléen) est branché côté compositeur.
#[napi]
pub fn set_param(id: i32, key: String, value: bool) {
    if let Some(v) = registry().lock().unwrap().get(&id) {
        v.set_param(&key, value);
    }
}

#[napi]
pub fn set_playing(id: i32, playing: bool) {
    if let Some(v) = registry().lock().unwrap().get(&id) {
        v.set_playing(playing);
    }
}

#[napi]
pub fn destroy_view(id: i32) {
    // remove hors du lock : le Drop (join du thread de rendu + DestroyWindow) ne le tient pas.
    let removed = registry().lock().unwrap().remove(&id);
    drop(removed);
}
