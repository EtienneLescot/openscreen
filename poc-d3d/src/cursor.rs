//! Piste curseur depuis un `.cursor.json` openscreen. Fournit position interpolée
//! et facteur de « click bounce » — consommés par frame (temps fractionnaire), donc
//! le motion blur du curseur vient gratuitement du supersampling temporel.

use anyhow::{Context, Result};

pub struct CursorTrack {
    /// (t_secondes, cx, cy) normalisés dans le cadre screen, triés.
    samples: Vec<(f32, f32, f32)>,
    /// instants de clic (secondes) dans la fenêtre.
    clicks: Vec<f32>,
}

impl CursorTrack {
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

    /// Facteur d'échelle « click bounce » : pop qui décroît après le clic le plus récent.
    pub fn bounce(&self, t: f32) -> f32 {
        let mut scale: f32 = 1.0;
        for &tc in &self.clicks {
            if t >= tc {
                let dt = t - tc;
                // pop amorti : ~1.5x à l'impact, retour à 1 en ~0.35 s
                scale = scale.max(1.0 + 0.5 * (-10.0 * dt).exp());
            }
        }
        scale
    }
}
