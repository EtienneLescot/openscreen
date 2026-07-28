//! GUI native (Win32) : preview/playback du compositing + export avec barre de
//! progression et bilan (temps + fps). Rapproche le POC d'une intégration app :
//! le compositeur/pipeline mesuré alimente une vraie boucle de rendu interactive.
//!
//! Architecture :
//!  - une fenêtre hôte, un enfant "preview" portant une swapchain DXGI flip sur le
//!    device D3D11 partagé (blit zéro-copie du RT composité → backbuffer) ;
//!  - des contrôles Win32 natifs (combo preset, Play/Pause, Export, barre, label) —
//!    aucun rendu de texte maison ;
//!  - un modèle mono-thread coopératif : WM_TIMER cadence la playback à 60 fps ;
//!    l'export tourne sur le thread UI et rafraîchit la barre entre frames.

use crate::compositor::{Compositor, FIXTURE_FRAMES, OUT_H, OUT_W};
use crate::config::{self, Cfg};
use crate::cursor::CursorTrack;
use crate::d3d::Gpu;
use crate::live::Player;
use crate::pipeline;
use anyhow::Result;
use std::ffi::c_void;
use std::time::Instant;
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Direct3D11::ID3D11RenderTargetView;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter, IDXGIDevice, IDXGIFactory2, IDXGISwapChain1, DXGI_PRESENT,
    DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_EFFECT_FLIP_DISCARD,
    DXGI_USAGE_RENDER_TARGET_OUTPUT,
};
use windows::Win32::Graphics::Gdi::{
    CreateFontW, GetSysColorBrush, UpdateWindow, COLOR_BTNFACE, HFONT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
use windows::Win32::UI::Controls::{
    InitCommonControlsEx, ICC_PROGRESS_CLASS, ICC_STANDARD_CLASSES, INITCOMMONCONTROLSEX,
    PBM_SETPOS, PBM_SETRANGE32,
};
use windows::Win32::UI::WindowsAndMessaging::*;

const PREVIEW_W: i32 = 1280;
const PREVIEW_H: i32 = 720;
const STRIP_H: i32 = 64;
const CLIENT_W: i32 = PREVIEW_W;
const CLIENT_H: i32 = PREVIEW_H + STRIP_H;

const ID_COMBO: isize = 101;
const ID_PLAY: isize = 102;
const ID_EXPORT: isize = 103;
const ID_PROGRESS: isize = 104;
const ID_STATUS: isize = 105;
const TIMER_TICK: usize = 1;

/// Chaîne UTF-16 terminée par NUL (durée de vie tenue par l'appelant).
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Plus grand rectangle 16:9 centré dans `(cw, ch)` → viewport letterbox de la preview.
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

/// État applicatif complet (possédé par la fenêtre via GWLP_USERDATA).
struct App {
    gpu: Gpu,
    comp: Compositor,
    player: Player,
    cfgs: Vec<Cfg>,
    cur: usize,
    playing: bool,
    exporting: bool,
    total_frames: u64,
    screen: String,
    webcam: String,
    out: String,
    // win32
    preview: HWND,
    combo: HWND,
    play_btn: HWND,
    export_btn: HWND,
    progress: HWND,
    status: HWND,
    // dxgi (preview)
    swap: Option<IDXGISwapChain1>,
    bb_rtv: Option<ID3D11RenderTargetView>,
    // cadence playback
    last: Instant,
    acc: f64,
}

impl App {
    /// Compose + affiche la 1re frame, avant l'ouverture de la fenêtre.
    unsafe fn init_first_frame(&mut self) {
        let cfg = self.cfgs[self.cur].clone();
        let _ = self.player.step(&self.comp, &cfg);
        let _ = self.render();
        self.update_ready_status();
        self.last = Instant::now();
    }

    /// Cadence 60 fps par horloge murale (accumulateur), avec garde anti-spirale.
    unsafe fn on_tick(&mut self) -> Result<()> {
        if self.exporting || !self.playing {
            return Ok(());
        }
        let now = Instant::now();
        let dt = (now - self.last).as_secs_f64().min(0.1);
        self.last = now;
        self.acc += dt;
        let step = 1.0 / 60.0;
        let cfg = self.cfgs[self.cur].clone();
        let mut stepped = false;
        let mut n = 0;
        while self.acc >= step && n < 3 {
            if self.player.step(&self.comp, &cfg)? {
                stepped = true;
            }
            self.acc -= step;
            n += 1;
        }
        if self.acc > step {
            self.acc = 0.0; // largue le retard accumulé (fenêtre masquée, etc.)
        }
        if stepped {
            self.render()?;
        }
        Ok(())
    }

    /// Blit du RT composité vers le backbuffer, letterboxé, puis Present (vsync).
    unsafe fn render(&mut self) -> Result<()> {
        let (Some(swap), Some(rtv)) = (self.swap.as_ref(), self.bb_rtv.as_ref()) else {
            return Ok(());
        };
        let mut rc = RECT::default();
        let _ = GetClientRect(self.preview, &mut rc);
        let cw = (rc.right - rc.left).max(1) as f32;
        let ch = (rc.bottom - rc.top).max(1) as f32;
        let (x, y, w, h) = letterbox(cw, ch);
        self.gpu.context.ClearRenderTargetView(rtv, &[0.02, 0.02, 0.03, 1.0]);
        self.comp.blit_to(rtv, x, y, w, h);
        let _ = swap.Present(1, DXGI_PRESENT(0));
        Ok(())
    }

    unsafe fn on_command(&mut self, wp: WPARAM) -> Result<()> {
        let id = (wp.0 & 0xffff) as isize;
        let code = ((wp.0 >> 16) & 0xffff) as u32;
        match id {
            ID_PLAY => self.toggle_play(),
            ID_EXPORT => self.run_export()?,
            ID_COMBO if code == CBN_SELCHANGE => {
                let sel = SendMessageW(self.combo, CB_GETCURSEL, WPARAM(0), LPARAM(0)).0;
                if sel >= 0 && (sel as usize) < self.cfgs.len() {
                    self.cur = sel as usize;
                    if !self.playing {
                        let cfg = self.cfgs[self.cur].clone();
                        let _ = self.player.recompose(&self.comp, &cfg);
                        let _ = self.render();
                    }
                    self.update_ready_status();
                }
            }
            _ => {}
        }
        Ok(())
    }

    unsafe fn toggle_play(&mut self) {
        self.playing = !self.playing;
        let label = wide(if self.playing { "Pause" } else { "Play" });
        let _ = SetWindowTextW(self.play_btn, PCWSTR(label.as_ptr()));
        self.last = Instant::now();
        self.acc = 0.0;
    }

    /// Export coopératif (thread UI) : la barre avance via SendMessage+UpdateWindow sur le
    /// contrôle (pas de re-pompage du message-loop → aucune réentrance dans notre wndproc).
    /// La mesure fps reste enveloppante (§10) dans `run_composited`.
    unsafe fn run_export(&mut self) -> Result<()> {
        if self.exporting {
            return Ok(());
        }
        self.exporting = true;
        self.playing = false;
        let pl = wide("Play");
        let _ = SetWindowTextW(self.play_btn, PCWSTR(pl.as_ptr()));
        let _ = EnableWindow(self.export_btn, false);
        let _ = EnableWindow(self.play_btn, false);
        let _ = EnableWindow(self.combo, false);

        SendMessageW(self.progress, PBM_SETRANGE32, WPARAM(0), LPARAM(self.total_frames as isize));
        SendMessageW(self.progress, PBM_SETPOS, WPARAM(0), LPARAM(0));

        let cfg = self.cfgs[self.cur].clone();
        let s = wide(&format!("Exporting {} — {} …", cfg.name, cfg.desc));
        let _ = SetWindowTextW(self.status, PCWSTR(s.as_ptr()));
        let _ = UpdateWindow(self.status);
        let _ = UpdateWindow(self.progress);

        // sonde de progression : SendMessage throttlé au pourcent (µs, cf. §10).
        let prog = self.progress;
        let total = self.total_frames.max(1);
        let mut last_pct: i64 = -1;
        let mut cb = move |done: u64| {
            let pct = (done as i64 * 100) / total as i64;
            if pct != last_pct {
                last_pct = pct;
                SendMessageW(prog, PBM_SETPOS, WPARAM(done as usize), LPARAM(0));
                let _ = UpdateWindow(prog);
            }
        };
        let r = pipeline::run_composited(
            &self.screen, &self.webcam, &self.out, &self.gpu, &self.comp, &cfg, &mut cb,
        );
        self.comp.clear_srv_cache();

        let _ = EnableWindow(self.export_btn, true);
        let _ = EnableWindow(self.play_btn, true);
        let _ = EnableWindow(self.combo, true);
        self.exporting = false;

        match r {
            Ok(st) => {
                SendMessageW(self.progress, PBM_SETPOS, WPARAM(st.frames as usize), LPARAM(0));
                let msg = format!(
                    "Done — {}  ·  {} frames  ·  {:.2}s  ·  {:.1} fps  ->  {}",
                    cfg.name, st.frames, st.wall_s, st.fps, self.out
                );
                let w = wide(&msg);
                let _ = SetWindowTextW(self.status, PCWSTR(w.as_ptr()));
            }
            Err(e) => {
                let w = wide(&format!("Export failed: {e}"));
                let _ = SetWindowTextW(self.status, PCWSTR(w.as_ptr()));
            }
        }

        // reprise de la playback
        self.playing = true;
        let pb = wide("Pause");
        let _ = SetWindowTextW(self.play_btn, PCWSTR(pb.as_ptr()));
        self.last = Instant::now();
        self.acc = 0.0;
        Ok(())
    }

    unsafe fn update_ready_status(&self) {
        let cfg = &self.cfgs[self.cur];
        let s = wide(&format!(
            "Ready - {} · {}    ({} frames · export -> {})",
            cfg.name, cfg.desc, self.total_frames, self.out
        ));
        let _ = SetWindowTextW(self.status, PCWSTR(s.as_ptr()));
    }

    unsafe fn report_err(&self, e: &anyhow::Error) {
        let w = wide(&format!("error: {e}"));
        let _ = SetWindowTextW(self.status, PCWSTR(w.as_ptr()));
        eprintln!("[app] error: {e:#}");
    }
}

/// Police Segoe UI 9pt ClearType — les contrôles créés par CreateWindowEx héritent sinon
/// d'une vieille police bitmap système. Fuit un HFONT (durée de vie = process).
unsafe fn ui_font() -> HFONT {
    let face = wide("Segoe UI");
    // (height=-12 ≈ 9pt @96dpi, weight=400, charset=DEFAULT(1), quality=CLEARTYPE(5))
    CreateFontW(-12, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, PCWSTR(face.as_ptr()))
}

/// Crée l'enfant preview + les contrôles natifs. Renvoie leurs HWND.
unsafe fn create_children(
    parent: HWND,
    hinst: windows::Win32::Foundation::HINSTANCE,
    cfgs: &[Cfg],
) -> Result<(HWND, HWND, HWND, HWND, HWND, HWND)> {
    let btn_cls = wide("BUTTON");
    let combo_cls = wide("COMBOBOX");
    let static_cls = wide("STATIC");
    let prog_cls = wide("msctls_progress32");
    let prev_cls = wide("PocD3DPreview");

    let preview = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        PCWSTR(prev_cls.as_ptr()),
        PCWSTR::null(),
        WS_CHILD | WS_VISIBLE,
        0, 0, PREVIEW_W, PREVIEW_H,
        parent,
        HMENU::default(),
        hinst,
        None,
    )?;

    let y = PREVIEW_H + 18;
    let combo_style =
        WS_CHILD.0 | WS_VISIBLE.0 | WS_VSCROLL.0 | (CBS_DROPDOWNLIST as u32) | (CBS_HASSTRINGS as u32);
    let combo = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        PCWSTR(combo_cls.as_ptr()),
        PCWSTR::null(),
        WINDOW_STYLE(combo_style),
        14, y - 3, 250, 340,
        parent,
        HMENU(ID_COMBO as *mut c_void),
        hinst,
        None,
    )?;
    for c in cfgs {
        let item = wide(&format!("{} — {}", c.name, c.desc));
        SendMessageW(combo, CB_ADDSTRING, WPARAM(0), LPARAM(item.as_ptr() as isize));
    }
    SendMessageW(combo, CB_SETCURSEL, WPARAM(cfgs.len() - 1), LPARAM(0));

    let pl = wide("Pause");
    let play_btn = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        PCWSTR(btn_cls.as_ptr()),
        PCWSTR(pl.as_ptr()),
        WINDOW_STYLE(WS_CHILD.0 | WS_VISIBLE.0 | (BS_PUSHBUTTON as u32)),
        278, y, 96, 30,
        parent,
        HMENU(ID_PLAY as *mut c_void),
        hinst,
        None,
    )?;

    let ex = wide("Export");
    let export_btn = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        PCWSTR(btn_cls.as_ptr()),
        PCWSTR(ex.as_ptr()),
        WINDOW_STYLE(WS_CHILD.0 | WS_VISIBLE.0 | (BS_PUSHBUTTON as u32)),
        382, y, 96, 30,
        parent,
        HMENU(ID_EXPORT as *mut c_void),
        hinst,
        None,
    )?;

    let progress = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        PCWSTR(prog_cls.as_ptr()),
        PCWSTR::null(),
        WS_CHILD | WS_VISIBLE,
        494, y + 4, 300, 22,
        parent,
        HMENU(ID_PROGRESS as *mut c_void),
        hinst,
        None,
    )?;

    let st = wide("Ready");
    let status = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        PCWSTR(static_cls.as_ptr()),
        PCWSTR(st.as_ptr()),
        WS_CHILD | WS_VISIBLE,
        808, y + 6, 458, 40,
        parent,
        HMENU(ID_STATUS as *mut c_void),
        hinst,
        None,
    )?;

    let font = ui_font();
    for c in [combo, play_btn, export_btn, status] {
        SendMessageW(c, WM_SETFONT, WPARAM(font.0 as usize), LPARAM(1));
    }
    Ok((combo, play_btn, export_btn, progress, status, preview))
}

/// Crée la swapchain flip + RTV du backbuffer sur le device D3D11 partagé.
unsafe fn create_swapchain(
    device: &windows::Win32::Graphics::Direct3D11::ID3D11Device,
    hwnd: HWND,
) -> Result<(IDXGISwapChain1, ID3D11RenderTargetView)> {
    let dxdev: IDXGIDevice = device.cast()?;
    let adapter: IDXGIAdapter = dxdev.GetAdapter()?;
    let factory: IDXGIFactory2 = adapter.GetParent()?;
    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: PREVIEW_W as u32,
        Height: PREVIEW_H as u32,
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
    let bb: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D = swap.GetBuffer(0)?;
    let mut rtv: Option<ID3D11RenderTargetView> = None;
    device.CreateRenderTargetView(&bb, None, Some(&mut rtv))?;
    Ok((swap, rtv.unwrap()))
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut App;
        if ptr.is_null() {
            return DefWindowProcW(hwnd, msg, wp, lp);
        }
        let app = &mut *ptr;
        match msg {
            WM_TIMER => {
                if let Err(e) = app.on_tick() {
                    app.report_err(&e);
                }
                LRESULT(0)
            }
            WM_COMMAND => {
                if let Err(e) = app.on_command(wp) {
                    app.report_err(&e);
                }
                LRESULT(0)
            }
            WM_DESTROY => {
                let _ = KillTimer(hwnd, TIMER_TICK);
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }
}

/// Point d'entrée GUI (appelé par `main` quand aucun argument bench n'est passé).
pub fn run_gui(screen: &str, webcam: &str, cursor_json: &str, out_dir: &str) -> Result<()> {
    unsafe { run_gui_inner(screen, webcam, cursor_json, out_dir) }
}

unsafe fn run_gui_inner(screen: &str, webcam: &str, cursor_json: &str, out_dir: &str) -> Result<()> {
    std::fs::create_dir_all(out_dir).ok();
    let out = format!("{out_dir}/export.mp4");

    let gpu = Gpu::create(false)?;
    println!("d3d11 device ok (feature_level 0x{:X})", gpu.feature_level.0 as u32);
    let mut comp = Compositor::new(&gpu)?;
    if let Ok(track) = CursorTrack::load(cursor_json, 100_000.0, 6.0) {
        comp.set_cursor(track);
    }
    let player = Player::open(screen, webcam, &gpu)?;
    let total_frames = pipeline::probe_frame_count(screen).unwrap_or(FIXTURE_FRAMES as u64);
    let cfgs = config::all();
    let cur = cfgs.len() - 1; // C8 (tous effets) par défaut

    let hinst = windows::Win32::Foundation::HINSTANCE(GetModuleHandleW(None)?.0);

    let icc = INITCOMMONCONTROLSEX {
        dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
        dwICC: ICC_PROGRESS_CLASS | ICC_STANDARD_CLASSES,
    };
    let _ = InitCommonControlsEx(&icc);

    let main_cls = wide("PocD3DMain");
    let prev_cls = wide("PocD3DPreview");
    let cursor = LoadCursorW(None, IDC_ARROW)?;
    let wc_main = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(wndproc),
        hInstance: hinst,
        lpszClassName: PCWSTR(main_cls.as_ptr()),
        hCursor: cursor,
        hbrBackground: GetSysColorBrush(COLOR_BTNFACE),
        ..Default::default()
    };
    RegisterClassW(&wc_main);
    let wc_prev = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(wndproc), // USERDATA null sur l'enfant → DefWindowProcW
        hInstance: hinst,
        lpszClassName: PCWSTR(prev_cls.as_ptr()),
        hCursor: cursor,
        hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH(std::ptr::null_mut()),
        ..Default::default()
    };
    RegisterClassW(&wc_prev);

    let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    let mut rc = RECT { left: 0, top: 0, right: CLIENT_W, bottom: CLIENT_H };
    let _ = AdjustWindowRectEx(&mut rc, style, false, WINDOW_EX_STYLE(0));
    let ww = rc.right - rc.left;
    let wh = rc.bottom - rc.top;

    let title = wide("OpenScreen — POC D3D11 compositor · preview + export");
    let hwnd = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        PCWSTR(main_cls.as_ptr()),
        PCWSTR(title.as_ptr()),
        style,
        CW_USEDEFAULT, CW_USEDEFAULT, ww, wh,
        HWND::default(),
        HMENU::default(),
        hinst,
        None,
    )?;

    let (combo, play_btn, export_btn, progress, status, preview) =
        create_children(hwnd, hinst, &cfgs)?;
    let (swap, bb_rtv) = create_swapchain(&gpu.device, preview)?;

    let app = Box::new(App {
        gpu,
        comp,
        player,
        cfgs,
        cur,
        playing: true,
        exporting: false,
        total_frames,
        screen: screen.to_string(),
        webcam: webcam.to_string(),
        out,
        preview,
        combo,
        play_btn,
        export_btn,
        progress,
        status,
        swap: Some(swap),
        bb_rtv: Some(bb_rtv),
        last: Instant::now(),
        acc: 0.0,
    });
    let app_ptr = Box::into_raw(app);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, app_ptr as isize);

    (*app_ptr).init_first_frame();
    let _ = ShowWindow(hwnd, SW_SHOW);
    let _ = UpdateWindow(hwnd);
    SetTimer(hwnd, TIMER_TICK, 15, None);

    let mut msg = MSG::default();
    while GetMessageW(&mut msg, HWND::default(), 0, 0).0 > 0 {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    drop(Box::from_raw(app_ptr));
    Ok(())
}
