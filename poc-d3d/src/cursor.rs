//! Piste curseur depuis un `.cursor.json` openscreen. Fournit position interpolée
//! et facteur de « click bounce » — consommés par frame (temps fractionnaire), donc
//! le motion blur du curseur vient gratuitement du supersampling temporel.

use anyhow::{Context, Result};

#[derive(Clone)]
pub struct CursorTrack {
    /// (t_secondes, cx, cy) normalisés dans le cadre screen, triés.
    samples: Vec<(f32, f32, f32)>,
    /// instants de clic (secondes) dans la fenêtre.
    clicks: Vec<f32>,
}

impl CursorTrack {
    /// Nombre d'échantillons de la piste (utile au diag de chargement).
    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }

    /// Charge la fenêtre [offset_ms, offset_ms + dur_s*1000] et la ramène à t=0.
    pub fn load(path: &str, offset_ms: f64, dur_s: f64) -> Result<CursorTrack> {
        let txt = std::fs::read_to_string(path).with_context(|| format!("lecture {path}"))?;
        let v: serde_json::Value = serde_json::from_str(&txt)?;
        let arr = v["samples"].as_array().context("samples[]")?;
        let mut samples = Vec::new();
        let mut clicks = Vec::new();
        let end = offset_ms + dur_s * 1000.0;
        for s in arr {
            let tm = s["timeMs"].as_f64().unwrap_or(-1.0);
            if tm < offset_ms || tm > end {
                continue;
            }
            let t = ((tm - offset_ms) / 1000.0) as f32;
            let cx = s["cx"].as_f64().unwrap_or(0.0) as f32;
            let cy = s["cy"].as_f64().unwrap_or(0.0) as f32;
            samples.push((t, cx, cy));
            if s["interactionType"].as_str() == Some("click") {
                clicks.push(t);
            }
        }
        samples.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        clicks.sort_by(|a, b| a.partial_cmp(b).unwrap());
        Ok(CursorTrack { samples, clicks })
    }

    /// Position (cx, cy) au temps `t` (interpolation linéaire), ou None si hors piste.
    pub fn at(&self, t: f32) -> Option<(f32, f32)> {
        if self.samples.is_empty() {
            return None;
        }
        if t <= self.samples[0].0 {
            let s = self.samples[0];
            return Some((s.1, s.2));
        }
        if t >= self.samples[self.samples.len() - 1].0 {
            let s = *self.samples.last().unwrap();
            return Some((s.1, s.2));
        }
        // recherche du segment encadrant
        let i = self.samples.partition_point(|s| s.0 <= t);
        let a = self.samples[i - 1];
        let b = self.samples[i];
        let f = if b.0 > a.0 { (t - a.0) / (b.0 - a.0) } else { 0.0 };
        Some((a.1 + (b.1 - a.1) * f, a.2 + (b.2 - a.2) * f))
    }

    /// Facteur d'échelle « click bounce » — parité `getNativeCursorClickBounceScale` (TS,
    /// `nativeCursor.ts`) : le curseur PRESSE (rétrécit, 0..38% de la fenêtre d'animation)
    /// PUIS REBONDIT (grossit, 38..100%), pas un simple pop qui ne fait que grossir puis
    /// redécroître. Seul le clic le plus récent précédant `t` compte (au-delà de la fenêtre,
    /// un clic antérieur n'a plus aucun effet — contrairement à l'ancienne décroissance
    /// exponentielle à queue infinie qui masquait ce bug).
    pub fn bounce(&self, t: f32) -> f32 {
        const ANIM_S: f32 = 0.26; // NATIVE_CURSOR_CLICK_ANIMATION_MS (TS) = 260ms
        const PRESS_FRAC: f32 = 0.38;
        let mut last_tc: Option<f32> = None;
        for &tc in &self.clicks {
            if tc <= t {
                last_tc = Some(tc); // clics triés croissant -> garde le plus récent <= t
            } else {
                break;
            }
        }
        let Some(tc) = last_tc else { return 1.0 };
        let elapsed = (t - tc) / ANIM_S;
        if elapsed >= 1.0 {
            return 1.0;
        }
        if elapsed < PRESS_FRAC {
            let press = (elapsed / PRESS_FRAC * std::f32::consts::PI).sin();
            1.0 - press * 0.24
        } else {
            let rebound = ((elapsed - PRESS_FRAC) / (1.0 - PRESS_FRAC) * std::f32::consts::PI).sin();
            1.0 + rebound * 0.16
        }
    }

    /// Piste repositionnée par un ressort-amortisseur (parité `cursorPathSmoothing.ts` :
    /// resample à 240 Hz + intégration semi-implicite d'Euler). `factor` 0..1 = valeur brute
    /// du slider (0 = passthrough, retourne un clone). Les clics restent sur leurs instants
    /// bruts (le bounce est temporel, pas positionnel — ne doit pas suivre le lissage).
    pub fn smoothed(&self, factor: f32) -> CursorTrack {
        if self.samples.len() < 2 || factor <= 0.0 {
            return CursorTrack { samples: self.samples.clone(), clicks: self.clicks.clone() };
        }
        const STEP_S: f32 = 1.0 / 240.0;
        let start = self.samples[0].0;
        let end = self.samples[self.samples.len() - 1].0;
        let step_count = (((end - start) / STEP_S).round() as usize).max(1);
        let n = step_count + 1;
        let mut times = Vec::with_capacity(n);
        let mut raw_x = Vec::with_capacity(n);
        let mut raw_y = Vec::with_capacity(n);
        for i in 0..n {
            let t = if i == n - 1 { end } else { start + i as f32 * STEP_S };
            let (cx, cy) = self.at(t).unwrap_or((0.0, 0.0));
            times.push(t);
            raw_x.push(cx);
            raw_y.push(cy);
        }
        let (stiffness, damping, mass) = cursor_spring_config(factor);
        let xs = spring_smooth(&raw_x, stiffness, damping, mass, STEP_S);
        let ys = spring_smooth(&raw_y, stiffness, damping, mass, STEP_S);
        let samples = times.into_iter().zip(xs).zip(ys).map(|((t, x), y)| (t, x, y)).collect();
        CursorTrack { samples, clicks: self.clicks.clone() }
    }
}

/// Ressort-amortisseur, intégration semi-implicite (symplectique) d'Euler — stable pour ces
/// raideurs à la grille 240 Hz (port direct de `springSmooth` en TS).
fn spring_smooth(targets: &[f32], stiffness: f32, damping: f32, mass: f32, step_s: f32) -> Vec<f32> {
    let mut out = vec![0.0f32; targets.len()];
    if targets.is_empty() {
        return out;
    }
    let mut x = targets[0];
    let mut v = 0.0f32;
    out[0] = x;
    for i in 1..targets.len() {
        let accel = (-stiffness * (x - targets[i]) - damping * v) / mass;
        v += accel * step_s;
        x += v * step_s;
        out[i] = x;
    }
    out
}

/// Port direct de `getCursorSpringConfig` (TS) → (stiffness, damping, mass). N'accepte que
/// 0..1 (plage réelle du slider, cf. `RightPanes.tsx` : `smoothing * 100` sur un slider 0..100).
fn cursor_spring_config(smoothing_factor: f32) -> (f32, f32, f32) {
    let clamped = smoothing_factor.clamp(0.0, 2.0);
    if clamped <= 0.0 {
        return (1000.0, 100.0, 1.0);
    }
    const LEGACY_MAX: f32 = 0.5;
    if clamped <= LEGACY_MAX {
        let n = (clamped / LEGACY_MAX).clamp(0.0, 1.0);
        return (760.0 - n * 420.0, 34.0 + n * 24.0, 0.55 + n * 0.45);
    }
    let n = ((clamped - LEGACY_MAX) / (2.0 - LEGACY_MAX)).clamp(0.0, 1.0);
    (340.0 - n * 180.0, 58.0 + n * 22.0, 1.0 + n * 0.35)
}
