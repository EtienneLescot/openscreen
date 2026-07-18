//! Vue live **embarquable** : rend le compositing dans une fenêtre D3D11 *enfant*
//! (`WS_CHILD`) parentée à une fenêtre hôte (p.ex. la `BrowserWindow` Electron).
//! C'est le cœur réutilisable de l'intégration Option A : l'addon napi-rs appellera
//! `LiveView::create(parent_hwnd, rect, …)` puis `set_rect`/`set_param`/`set_playing`.
//!
//! Modèle de threads : la fenêtre enfant est créée sur le thread appelant (ses messages
//! sont pompés par l'hôte). Le rendu (device D3D, compositeur, décodeurs, swapchain,
//! Present) tourne sur un **thread dédié** — le thread JS/UI n'est jamais bloqué. Les
//! objets COM restent sur le thread de rendu (le HWND, lui, traverse en `isize`).

use crate::compositor::{Compositor, LiveParams};
use crate::config::{self, Cfg};
use crate::cursor::CursorTrack;
use crate::d3d::Gpu;
use crate::pipeline::Decoder;
use anyhow::Result;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11RenderTargetView, ID3D11Texture2D};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter, IDXGIDevice, IDXGIFactory2, IDXGISwapChain1, DXGI_PRESENT, DXGI_SCALING_STRETCH,
    DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG, DXGI_SWAP_EFFECT_FLIP_DISCARD,
    DXGI_USAGE_RENDER_TARGET_OUTPUT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::compositor::{OUT_H, OUT_W};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

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
    idx: u32,
}

impl Player {
    pub unsafe fn open(screen: &str, webcam: &str, gpu: &Gpu) -> Result<Player> {
        Ok(Player {
            sdec: Decoder::open(screen, gpu)?,
            wdec: Decoder::open(webcam, gpu)?,
            idx: 0,
        })
    }

    /// Compose la frame suivante (→ `comp.rt`). Boucle sur EOF. `false` si fixture vide.
    pub unsafe fn step(&mut self, comp: &Compositor, cfg: &Cfg) -> Result<bool> {
        let mut sf = self.sdec.next()?;
        let mut wf = self.wdec.next()?;
        if sf.is_null() || wf.is_null() {
            self.sdec.rewind()?;
            self.wdec.rewind()?;
            self.idx = 0;
            sf = self.sdec.next()?;
            wf = self.wdec.next()?;
        }
        if sf.is_null() || wf.is_null() {
            return Ok(false);
        }
        comp.compose_frame(sf, wf, self.idx as f32, cfg)?;
        self.idx = self.idx.wrapping_add(1);
        Ok(true)
    }

    /// Recompose la frame courante (déjà décodée) — rafraîchit après un changement de param.
    pub unsafe fn recompose(&self, comp: &Compositor, cfg: &Cfg) -> Result<bool> {
        let sf = self.sdec.cur_frame();
        let wf = self.wdec.cur_frame();
        if sf.is_null() || wf.is_null() {
            return Ok(false);
        }
        let f = self.idx.saturating_sub(1);
        comp.compose_frame(sf, wf, f as f32, cfg)?;
        Ok(true)
    }
}

/// Paramètres inspector pilotés depuis l'UI (setParam). Le thread de rendu les applique :
/// booléens/taps → reconstruits dans le `Cfg` ; valeurs continues → `set_live_params`.
#[derive(Clone, Copy)]
struct InspectorParams {
    bg_blur: bool,
    bg_color: [f32; 4],
    shadow_scale: f32,
    radius_scale: f32,
    mblur_taps: u32,
}

impl Default for InspectorParams {
    fn default() -> Self {
        Self {
            bg_blur: false,
            bg_color: [0.10, 0.11, 0.14, 1.0],
            shadow_scale: 1.0,
            radius_scale: 1.0,
            mblur_taps: 8,
        }
    }
}

/// État partagé thread appelant → thread de rendu (commandes sans blocage).
struct Shared {
    /// rect viewport en px device [x, y, w, h], relatif au client de la fenêtre parente.
    /// Le thread de rendu le mappe en coords écran (le parent peut bouger) et repositionne.
    rect: Mutex<[i32; 4]>,
    inspector: Mutex<InspectorParams>,
    playing: AtomicBool,
    stop: AtomicBool,
}

/// Handle d'une vue live embarquée. `Drop` arrête le rendu et détruit la fenêtre.
pub struct LiveView {
    hwnd: HWND,
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

// Le HWND ne sert qu'au thread appelant (create/set_rect/drop) ; il n'est pas partagé
// avec le thread de rendu autrement que par sa valeur numérique. Sûr à déplacer.
unsafe impl Send for LiveView {}

impl LiveView {
    /// Crée la fenêtre enfant (thread appelant) et démarre le thread de rendu.
    pub fn create(
        parent: HWND,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        screen: &str,
        webcam: &str,
        cursor_json: &str,
    ) -> Result<LiveView> {
        unsafe {
            let hinst = HINSTANCE(GetModuleHandleW(None)?.0);
            register_overlay_class(hinst);
            let cls = wide("PocD3DOverlay");
            // position écran initiale = origine client du parent + (x, y)
            let mut pt = POINT { x, y };
            let _ = ClientToScreen(parent, &mut pt);
            // Fenêtre top-level "overlay" OWNED par le parent (WS_POPUP), sans activation.
            // Une fenêtre SŒUR (pas enfant) n'est pas dans la surface de Chromium → elle
            // n'est PAS occultée par son compositeur GPU (contrairement à WS_CHILD).
            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                PCWSTR(cls.as_ptr()),
                PCWSTR::null(),
                WS_POPUP | WS_VISIBLE,
                pt.x,
                pt.y,
                w.max(1),
                h.max(1),
                parent, // owner
                HMENU::default(),
                hinst,
                None,
            )?;

            let shared = Arc::new(Shared {
                rect: Mutex::new([x, y, w, h]),
                inspector: Mutex::new(InspectorParams::default()),
                playing: AtomicBool::new(true),
                stop: AtomicBool::new(false),
            });
            let overlay_val = hwnd.0 as isize;
            let parent_val = parent.0 as isize;
            let sh = shared.clone();
            let (s, wc, cj) = (screen.to_string(), webcam.to_string(), cursor_json.to_string());
            let thread = std::thread::spawn(move || {
                if let Err(e) = render_thread(overlay_val, parent_val, sh, &s, &wc, &cj) {
                    eprintln!("[live] render thread error: {e:#}");
                }
            });

            Ok(LiveView { hwnd, shared, thread: Some(thread) })
        }
    }

    /// Met à jour le rect viewport (sync du rect DOM en Electron). Le thread de rendu le
    /// mappe en coords écran et repositionne l'overlay (suit aussi le déplacement du parent).
    pub fn set_rect(&self, x: i32, y: i32, w: i32, h: i32) {
        if let Ok(mut r) = self.shared.rect.lock() {
            *r = [x, y, w.max(1), h.max(1)];
        }
    }

    /// Switch inspector (booléen).
    pub fn set_param_bool(&self, key: &str, value: bool) {
        if let Ok(mut p) = self.shared.inspector.lock() {
            if key == "backgroundBlur" {
                p.bg_blur = value;
            }
        }
    }

    /// Slider inspector (numérique). Conventions : `shadow`/`roundness` = échelle (1 = défaut),
    /// `motionBlur` = 0..1 mappé sur 1..16 taps.
    pub fn set_param_num(&self, key: &str, value: f64) {
        if let Ok(mut p) = self.shared.inspector.lock() {
            let v = value as f32;
            match key {
                "shadow" => p.shadow_scale = v.max(0.0),
                "roundness" => p.radius_scale = v.max(0.0),
                "motionBlur" => p.mblur_taps = (1.0 + value.clamp(0.0, 1.0) * 15.0).round() as u32,
                _ => {}
            }
        }
    }

    /// Sélection de fond (couleur "#rrggbb").
    pub fn set_param_str(&self, key: &str, value: &str) {
        if key == "backgroundColor" {
            if let Some(c) = parse_hex_color(value) {
                if let Ok(mut p) = self.shared.inspector.lock() {
                    p.bg_color = c;
                }
            }
        }
    }

    pub fn set_playing(&self, playing: bool) {
        self.shared.playing.store(playing, Ordering::Relaxed);
    }
}

impl Drop for LiveView {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

/// Plus grand rectangle 16:9 centré dans `(cw, ch)` → viewport letterbox.
fn letterbox(cw: f32, ch: f32) -> (f32, f32, f32, f32) {
    let ar = OUT_W as f32 / OUT_H as f32;
    let (mut w, mut h) = (cw, ch);
    if cw / ch > ar {
        w = ch * ar;
    } else {
        h = cw / ar;
    }
    ((cw - w) * 0.5, (ch - h) * 0.5, w, h)
}

unsafe fn client_size(hwnd: HWND) -> (u32, u32) {
    let mut rc = RECT::default();
    let _ = GetClientRect(hwnd, &mut rc);
    ((rc.right - rc.left).max(0) as u32, (rc.bottom - rc.top).max(0) as u32)
}

unsafe fn make_bb_rtv(swap: &IDXGISwapChain1, device: &ID3D11Device) -> Result<ID3D11RenderTargetView> {
    let bb: ID3D11Texture2D = swap.GetBuffer(0)?;
    let mut rtv: Option<ID3D11RenderTargetView> = None;
    device.CreateRenderTargetView(&bb, None, Some(&mut rtv))?;
    Ok(rtv.unwrap())
}

unsafe fn create_swapchain(
    device: &ID3D11Device,
    hwnd: HWND,
    w: u32,
    h: u32,
) -> Result<(IDXGISwapChain1, ID3D11RenderTargetView)> {
    let dxdev: IDXGIDevice = device.cast()?;
    let adapter: IDXGIAdapter = dxdev.GetAdapter()?;
    let factory: IDXGIFactory2 = adapter.GetParent()?;
    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: w.max(1),
        Height: h.max(1),
        Format: DXGI_FORMAT_R8G8B8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        BufferCount: 2,
        SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
        Scaling: DXGI_SCALING_STRETCH,
        AlphaMode: DXGI_ALPHA_MODE_IGNORE,
        ..Default::default()
    };
    let swap = factory.CreateSwapChainForHwnd(device, hwnd, &desc, None, None)?;
    let rtv = make_bb_rtv(&swap, device)?;
    Ok((swap, rtv))
}

/// Boucle de rendu (thread dédié) : décode → compose → blit letterboxé → Present.
/// Suit la taille client de la fenêtre enfant (ResizeBuffers) et le param live.
unsafe fn render_thread(
    overlay_val: isize,
    parent_val: isize,
    shared: Arc<Shared>,
    screen: &str,
    webcam: &str,
    cursor_json: &str,
) -> Result<()> {
    let overlay = HWND(overlay_val as *mut c_void);
    let parent = HWND(parent_val as *mut c_void);
    let gpu = Gpu::create(false)?;
    let mut comp = Compositor::new(&gpu)?;
    if let Ok(track) = CursorTrack::load(cursor_json, 100_000.0, 6.0) {
        comp.set_cursor(track);
    }
    let mut player = Player::open(screen, webcam, &gpu)?;

    // config de base = C8 (tous effets) ; le fond flouté est piloté par le param live.
    let mut cfg = config::all().pop().expect("au moins une config");

    let (mut w, mut h) = {
        let r = *shared.rect.lock().unwrap();
        (r[2].max(1) as u32, r[3].max(1) as u32)
    };
    let (swap, mut bb_rtv) = create_swapchain(&gpu.device, overlay, w, h)?;

    let mut last = Instant::now();
    let mut acc = 0.0f64;
    let mut first = true;
    let mut last_screen = [i32::MIN; 4];

    while !shared.stop.load(Ordering::SeqCst) {
        // params inspector : booléens/taps → cfg ; valeurs continues → live_params
        {
            let ip = *shared.inspector.lock().unwrap();
            cfg.bg_blur = ip.bg_blur;
            cfg.mblur_n = ip.mblur_taps;
            comp.set_live_params(LiveParams {
                bg_color: ip.bg_color,
                shadow_scale: ip.shadow_scale,
                radius_scale: ip.radius_scale,
            });
        }

        // rect viewport → coords écran : suit le rect DOM (set_rect) ET le déplacement du parent
        let [vx, vy, vw, vh] = *shared.rect.lock().unwrap();
        let mut pt = POINT { x: vx, y: vy };
        let _ = ClientToScreen(parent, &mut pt);
        let screen_rect = [pt.x, pt.y, vw, vh];
        if screen_rect != last_screen {
            let _ = SetWindowPos(
                overlay,
                HWND::default(),
                pt.x,
                pt.y,
                vw.max(1),
                vh.max(1),
                SWP_NOACTIVATE | SWP_NOZORDER,
            );
            last_screen = screen_rect;
        }

        // suivi de taille → ResizeBuffers
        let (nw, nh) = (vw.max(1) as u32, vh.max(1) as u32);
        let mut resized = false;
        if (nw, nh) != (w, h) {
            drop(bb_rtv);
            swap.ResizeBuffers(0, nw, nh, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SWAP_CHAIN_FLAG(0))?;
            bb_rtv = make_bb_rtv(&swap, &gpu.device)?;
            w = nw;
            h = nh;
            resized = true;
        }

        // avance temporelle (60 fps, horloge murale)
        let now = Instant::now();
        let dt = (now - last).as_secs_f64().min(0.1);
        last = now;
        let mut stepped = false;
        if shared.playing.load(Ordering::Relaxed) {
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
        } else if resized || first {
            // pause : recompose la frame courante pour un present à la nouvelle taille
            let _ = player.recompose(&comp, &cfg);
            stepped = true;
        }

        if stepped || resized || first {
            if w > 0 && h > 0 {
                gpu.context.ClearRenderTargetView(&bb_rtv, &[0.0, 0.0, 0.0, 1.0]);
                let (lx, ly, lw, lh) = letterbox(w as f32, h as f32);
                comp.blit_to(&bb_rtv, lx, ly, lw, lh);
                let _ = swap.Present(1, DXGI_PRESENT(0));
            }
            first = false;
        } else {
            std::thread::sleep(Duration::from_millis(4));
        }
    }
    Ok(())
}

// ---------- classes de fenêtres ----------

extern "system" fn child_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

fn register_overlay_class(hinst: HINSTANCE) {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let cls = wide("PocD3DOverlay");
        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(child_proc),
            hInstance: hinst,
            lpszClassName: PCWSTR(cls.as_ptr()),
            hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH(std::ptr::null_mut()),
            ..Default::default()
        };
        RegisterClassW(&wc);
    });
}

// ---------- harnais standalone (poc-d3d.exe --live) ----------

extern "system" fn host_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        if msg == WM_DESTROY {
            PostQuitMessage(0);
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wp, lp)
    }
}

/// Test embed hors Electron : fenêtre hôte top-level + une `LiveView` enfant qui la
/// remplit, resync au resize. Valide le child-window + le rendu threadé.
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

        let title = wide("poc-d3d — live embed test (fenêtre D3D enfant)");
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

        let (cw, ch) = client_size(host);
        let view = LiveView::create(host, 0, 0, cw as i32, ch as i32, screen, webcam, cursor_json)?;
        let _ = ShowWindow(host, SW_SHOW);
        println!("live embed: fenêtre enfant D3D créée, thread de rendu démarré");
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
            view.set_rect(0, 0, cw as i32, ch as i32);
            std::thread::sleep(Duration::from_millis(8));
        }
        drop(view);
        Ok(())
    }
}
