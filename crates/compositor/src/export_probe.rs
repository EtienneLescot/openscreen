//! Sondes de temps par étage pour l'export, activées par `OPENSCREEN_EXPORT_PROFILE=1`.
//!
//! Le but est de répondre à UNE question — où part le temps d'un export — sans avoir à
//! croire une intuition. Chaque étage accumule des nanosecondes et un compte d'appels ;
//! `report` imprime le tableau sur stderr à la fin de la marche.
//!
//! # Coût quand c'est éteint
//!
//! `scope()` lit un `OnceLock<bool>` et, si la sonde est éteinte, ne prend AUCUNE horloge :
//! le `Scope` rendu porte `None` et son `Drop` ne fait rien. Allumée, elle coûte deux
//! `Instant::now()` (un `mach_absolute_time` chacun, ~20 ns sur Apple Silicon) et un
//! `fetch_add` relaxé par étage et par frame.
//!
//! # Ce que les nombres veulent dire, et ne veulent pas dire
//!
//! Les étages sont mesurés là où le CPU les appelle, pas là où le GPU les exécute. Metal
//! est asynchrone : `compose_frame` ne fait que soumettre, et l'attente de TOUT le travail
//! GPU de la frame tombe dans `gpu_wait`. Lire `compose` comme « le coût de la composition »
//! est donc faux — c'est le coût de la CONSTRUIRE, pas de la rendre.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

#[derive(Clone, Copy)]
pub enum Stage {
    DecodeScreen = 0,
    DecodeWebcam = 1,
    Compose = 2,
    VtGetBuffer = 3,
    Nv12Passes = 4,
    GpuWait = 5,
    SendFrame = 6,
    DrainMux = 7,
    Progress = 8,
    Finalize = 9,
}

const N: usize = 10;

const NAMES: [&str; N] = [
    "decode.screen",
    "decode.webcam",
    "compose.submit",
    "vt.get_buffer",
    "nv12.passes",
    "gpu.wait",
    "enc.send_frame",
    "mux.drain",
    "progress.cb",
    "finalize",
];

static NANOS: [AtomicU64; N] = [
    AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0),
    AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0),
];
static COUNT: [AtomicU64; N] = [
    AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0),
    AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0),
];

static ENABLED: OnceLock<bool> = OnceLock::new();

pub fn enabled() -> bool {
    *ENABLED.get_or_init(|| {
        matches!(
            std::env::var("OPENSCREEN_EXPORT_PROFILE").ok().as_deref(),
            Some("1") | Some("true")
        )
    })
}

pub struct Scope {
    stage: usize,
    t0: Option<Instant>,
}

impl Drop for Scope {
    fn drop(&mut self) {
        if let Some(t0) = self.t0 {
            NANOS[self.stage].fetch_add(t0.elapsed().as_nanos() as u64, Ordering::Relaxed);
            COUNT[self.stage].fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Ouvre une sonde sur `stage`. Le temps est compté jusqu'au `Drop` du `Scope` rendu.
pub fn scope(stage: Stage) -> Scope {
    Scope {
        stage: stage as usize,
        t0: if enabled() { Some(Instant::now()) } else { None },
    }
}

/// Imprime le tableau sur stderr. `wall_s` est le mur total de la fonction d'export, ce qui
/// permet de voir ce que les étages NE couvrent pas.
pub fn report(wall_s: f64, frames: u64) {
    if !enabled() {
        return;
    }
    let total_ns: u64 = (0..N).map(|i| NANOS[i].load(Ordering::Relaxed)).sum();
    eprintln!("[profile] {frames} frames en {wall_s:.3} s ({:.1} fps)", frames as f64 / wall_s.max(1e-9));
    eprintln!("[profile] {:<16} {:>10} {:>9} {:>8} {:>7}", "étage", "total (s)", "µs/frame", "% mur", "appels");
    let mut rows: Vec<usize> = (0..N).collect();
    rows.sort_by_key(|&i| std::cmp::Reverse(NANOS[i].load(Ordering::Relaxed)));
    for i in rows {
        let ns = NANOS[i].load(Ordering::Relaxed);
        let c = COUNT[i].load(Ordering::Relaxed);
        if c == 0 {
            continue;
        }
        eprintln!(
            "[profile] {:<16} {:>10.3} {:>9.1} {:>7.1}% {:>7}",
            NAMES[i],
            ns as f64 / 1e9,
            ns as f64 / 1e3 / c as f64,
            100.0 * (ns as f64 / 1e9) / wall_s.max(1e-9),
            c
        );
    }
    eprintln!(
        "[profile] {:<16} {:>10.3} {:>9} {:>7.1}%",
        "SOMME sondes",
        total_ns as f64 / 1e9,
        "",
        100.0 * (total_ns as f64 / 1e9) / wall_s.max(1e-9)
    );
    eprintln!(
        "[profile] {:<16} {:>10.3} {:>9} {:>7.1}%   <- ce que les sondes ne couvrent pas",
        "non sondé",
        wall_s - total_ns as f64 / 1e9,
        "",
        100.0 * (wall_s - total_ns as f64 / 1e9) / wall_s.max(1e-9)
    );
}

/// Remet tous les compteurs à zéro. Un même process peut enchaîner deux exports.
pub fn reset() {
    for i in 0..N {
        NANOS[i].store(0, Ordering::Relaxed);
        COUNT[i].store(0, Ordering::Relaxed);
    }
}
