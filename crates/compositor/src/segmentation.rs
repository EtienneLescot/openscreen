//! Segmentation du sujet webcam — le masque que `ps_main` consomme en `t3`.
//!
//! # Pourquoi l'EP CPU et pas le GPU
//!
//! Mesuré sur la cible (Radeon 610M intégré, cf.
//! `technical-documentation/engineering/webcam-segmentation.md`) : l'EP CPU coûte **+0,47 ms
//! par frame** au compositeur contre **+1,03 ms** pour DirectML, et — le point qui décide —
//! son coût **ne dépend pas de la résolution d'entrée**, là où celui de DirectML suit les
//! pixels. L'EP CPU à pleine résolution est donc moins cher que DirectML ne l'est jamais,
//! même à résolution réduite.
//!
//! Le vrai gain n'est pas la marge, il est architectural : pas de DirectML ⇒ pas de device
//! D3D12, pas de handle partagé, pas d'appariement de LUID d'adaptateur, pas de fence
//! inter-queue, et un seul chemin sur les trois plateformes au lieu de trois.
//!
//! # Le piège du nombre de threads
//!
//! Une session ONNX Runtime laissée par défaut prend tous les cœurs. Sur la machine de
//! mesure (4 cœurs) ça donne un **p95 de 24,9 ms** — une frame perdue à chaque fois que ça
//! tombe. `intra_op_num_threads = 2` est à 8 % du meilleur p10 avec moins de la moitié de la
//! traîne, et laisse deux cœurs au compositeur. La bonne valeur n'était pas la plus rapide.

use anyhow::{bail, Result};
use std::path::Path;

/// Résolution d'entrée du modèle vendorisé (`selfie_segmentation_landscape.onnx`).
///
/// Le graphe est entièrement convolutif, donc réductible — mais mesuré, ça ne sert à rien :
/// le coût de l'EP CPU est plat en résolution. Et 128x80 n'est pas livrable, la caméra en
/// plein écran agrandit le masque ~15x et les cheveux s'effondrent en rampe.
pub const MODEL_WIDTH: u32 = 256;
pub const MODEL_HEIGHT: u32 = 144;

/// Deux threads intra-op. Voir la note du module : le défaut prend toute la machine.
const INTRA_OP_THREADS: usize = 2;

/// Segmenteur chargé, prêt à produire un masque par frame.
pub struct Segmenter {
    #[cfg(feature = "segmentation")]
    session: ort::session::Session,
    /// Réutilisé d'une frame à l'autre pour ne pas réallouer 110 Ko à 30 Hz.
    input_scratch: Vec<f32>,
    mask_scratch: Vec<u8>,
}

impl Segmenter {
    /// Charge le modèle ONNX. `model_path` est le `.onnx` vendorisé à côté des `.tflite`.
    #[cfg(feature = "segmentation")]
    pub fn load(model_path: &Path) -> Result<Self> {
        if !model_path.exists() {
            bail!("modèle de segmentation absent : {}", model_path.display());
        }
        // `ort::Error` est générique sur le type du builder, donc il ne satisfait pas les
        // bornes d'`anyhow::Context` — d'où le `map_err` explicite plutôt qu'un `?` direct.
        let session = (|| -> ort::Result<ort::session::Session> {
            ort::session::Session::builder()?
                .with_intra_threads(INTRA_OP_THREADS)?
                // Un seul thread inter-op : le graphe est une chaîne, il n'y a rien à
                // paralléliser entre branches, et un pool de plus ne ferait que disputer les
                // cœurs au compositeur.
                .with_inter_threads(1)?
                .commit_from_file(model_path)
        })()
        .map_err(|e| anyhow::anyhow!("chargement de {} : {e}", model_path.display()))?;
        Ok(Self {
            session,
            input_scratch: vec![0.0; (MODEL_WIDTH * MODEL_HEIGHT * 3) as usize],
            mask_scratch: vec![0; (MODEL_WIDTH * MODEL_HEIGHT) as usize],
        })
    }

    #[cfg(not(feature = "segmentation"))]
    pub fn load(_model_path: &Path) -> Result<Self> {
        bail!("compilé sans la feature `segmentation`")
    }

    /// Produit le masque du sujet à partir d'une frame RGB8 déjà mise à l'échelle du modèle.
    ///
    /// `rgb` fait `MODEL_WIDTH * MODEL_HEIGHT * 3` octets, entrelacé R,G,B. Le retour fait
    /// `MODEL_WIDTH * MODEL_HEIGHT` octets, 0 = fond, 255 = sujet — exactement ce que
    /// `Compositor::set_webcam_mask` attend.
    ///
    /// Le redimensionnement n'est pas fait ici : l'appelant a déjà la frame sur le GPU et sait
    /// la réduire bien mieux qu'une boucle CPU.
    #[cfg(feature = "segmentation")]
    pub fn run(&mut self, rgb: &[u8]) -> Result<&[u8]> {
        let expected = (MODEL_WIDTH * MODEL_HEIGHT * 3) as usize;
        if rgb.len() != expected {
            bail!("frame de {} octets, {expected} attendus", rgb.len());
        }
        // Le modèle veut du 0..1 en NHWC — le même ordre que la frame entrelacée, donc une
        // simple division sans transposition.
        for (dst, &src) in self.input_scratch.iter_mut().zip(rgb.iter()) {
            *dst = src as f32 * (1.0 / 255.0);
        }

        // `TensorRef` emprunte le scratch au lieu de le copier : à 30 Hz, 442 Ko recopiés par
        // frame pour rien seraient exactement le genre de coût que cette conception évite.
        let shape = [1_i64, MODEL_HEIGHT as i64, MODEL_WIDTH as i64, 3];
        let input = ort::value::TensorRef::from_array_view((shape, self.input_scratch.as_slice()))
            .map_err(|e| anyhow::anyhow!("construction du tenseur d'entrée : {e}"))?;
        let outputs = self
            .session
            .run(ort::inputs!["input_1" => input])
            .map_err(|e| anyhow::anyhow!("inférence : {e}"))?;
        let (_, mask) = outputs["segment_back"]
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow::anyhow!("extraction du masque : {e}"))?;

        if mask.len() != self.mask_scratch.len() {
            bail!("masque de {} valeurs, {} attendues", mask.len(), self.mask_scratch.len());
        }
        // Déjà passé par une sigmoïde dans le graphe, donc borné 0..1 — le clamp ne protège
        // que d'un modèle regénéré différemment.
        for (dst, &src) in self.mask_scratch.iter_mut().zip(mask.iter()) {
            *dst = (src.clamp(0.0, 1.0) * 255.0) as u8;
        }
        Ok(&self.mask_scratch)
    }

    #[cfg(not(feature = "segmentation"))]
    pub fn run(&mut self, _rgb: &[u8]) -> Result<&[u8]> {
        bail!("compilé sans la feature `segmentation`")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Le chemin par défaut du modèle vendorisé, depuis la racine du dépôt.
    fn vendored_model() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../public/mediapipe/selfie_segmentation/selfie_segmentation_landscape.onnx")
    }

    #[test]
    fn the_vendored_model_is_where_the_loader_expects_it() {
        // Ne charge pas le modèle (la feature peut être éteinte) : vérifie seulement que le
        // fichier que `load` ira chercher existe et n'est pas un pointeur LFS ou un tronçon.
        let path = vendored_model();
        let meta = std::fs::metadata(&path)
            .unwrap_or_else(|e| panic!("modèle introuvable en {} : {e}", path.display()));
        assert!(meta.len() > 100_000, "modèle suspicieusement petit : {} octets", meta.len());
    }

    // Sans la feature, `load` échoue en disant que la feature manque — un message utile lui
    // aussi, mais pas celui-ci.
    #[cfg(feature = "segmentation")]
    #[test]
    fn a_missing_model_fails_with_the_path_in_the_message() {
        // `.err()` plutôt que `.unwrap_err()` : ce dernier exigerait `Debug` sur `Segmenter`,
        // qui contient une session ONNX Runtime.
        let err = match Segmenter::load(Path::new("nexiste/pas.onnx")) {
            Ok(_) => panic!("un modèle inexistant ne doit pas charger"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("nexiste"), "message peu utile : {err}");
    }

    #[cfg(feature = "segmentation")]
    #[test]
    fn a_frame_of_the_wrong_size_is_refused_rather_than_read_out_of_bounds() {
        let mut seg = Segmenter::load(&vendored_model()).expect("chargement du modèle");
        let err = seg.run(&[0u8; 12]).unwrap_err().to_string();
        assert!(err.contains("attendus"), "message peu utile : {err}");
    }

    #[cfg(feature = "segmentation")]
    #[test]
    fn segments_a_uniform_frame_without_panicking_and_returns_the_right_size() {
        let mut seg = Segmenter::load(&vendored_model()).expect("chargement du modèle");
        let frame = vec![128u8; (MODEL_WIDTH * MODEL_HEIGHT * 3) as usize];
        let mask = seg.run(&frame).expect("inférence");
        assert_eq!(mask.len(), (MODEL_WIDTH * MODEL_HEIGHT) as usize);
        // Un gris uniforme ne contient pas de sujet : le masque doit être massivement du
        // fond. C'est une borne large, pas une assertion de qualité — elle attrape un modèle
        // qui renverrait du bruit ou du plein.
        let subject = mask.iter().filter(|&&v| v > 128).count();
        assert!(
            subject * 10 < mask.len(),
            "{subject} pixels sujet sur {} pour une image unie",
            mask.len()
        );
    }
}
