//! Décodage et étirement de l'audio d'un clip, en parallèle du parcours vidéo.
//!
//! Les trois pipelines faisaient ce travail **dans** le callback `on_clip_end` de
//! `walk_composited_timeline`, donc sur le thread de rendu et entre deux clips. Rien
//! n'appelle `progress()` pendant ce temps : la barre d'export s'arrêtait sur le
//! pourcentage de la dernière frame du clip et y restait pour toute la durée du décodage
//! et de l'étirement. C'est la moitié « reporting » du « figé à ~80 % » — la moitié
//! « coût » a été traitée par le passage à atempo, mais un clip long, un repli WSOLA ou
//! n'importe quelle étape audio future reproduisent le symptôme à l'identique.
//!
//! Y répondre en publiant une progression pendant cette phase aurait demandé de changer le
//! protocole natif → JS (il ne transporte qu'un compteur de frames absolu) et de répartir
//! un total que les deux côtés calculent séparément. Déplacer le travail est plus simple et
//! strictement meilleur : l'audio d'un clip ne dépend que de ce clip, il n'y a donc aucune
//! raison qu'il occupe le thread qui compose les frames du clip suivant. Le parcours vidéo
//! continue de rapporter sa progression sans interruption, et le temps audio disparaît du
//! mur d'export au lieu d'y être seulement mieux affiché — ce que
//! `export-pipeline.md` prétendait déjà.
//!
//! Chaque job ouvre son propre `AVFormatContext` sur le fichier du clip : libavformat
//! n'a pas d'état partagé entre contextes, et le décodeur vidéo du parcours en a un autre
//! sur le même chemin, en lecture seule lui aussi.

use crate::audio::{decode_clip_audio, stretch_clip_pcm_by_speed, PlanarPcm};
use crate::regions::SpeedSegment;
use std::collections::VecDeque;
use std::thread::JoinHandle;

/// Nombre de jobs audio en vol.
///
/// Un thread par clip serait sans plafond : une timeline de deux cents clips décoderait
/// deux cents pistes à la fois, chacune avec son contexte ffmpeg et son PCM complet en
/// mémoire. Quatre suffisent à couvrir le décodage d'un clip par le rendu du suivant, qui
/// est tout ce qu'on cherche ici.
const MAX_INFLIGHT_AUDIO_JOBS: usize = 4;

/// Le corps d'un job : décode la fenêtre gardée du clip et l'étire sur ses spans de vitesse.
///
/// Rend `None` quand le clip se déclare audio mais n'a pas de flux décodable, ou quand le
/// décodage échoue — dans les deux cas l'export continue et le clip sort muet, comme avant
/// que ce travail passe sur un thread. Les deux messages sont les mêmes qu'alors ; ils
/// sortent seulement d'un autre thread.
pub fn decode_and_stretch_clip_audio(
    clip_index: usize,
    screen_path: &str,
    source_start_sec: f64,
    source_end_sec: f64,
    speed_segments: &[SpeedSegment],
    out_fps: f64,
) -> Option<PlanarPcm> {
    match decode_clip_audio(screen_path, source_start_sec, source_end_sec) {
        Ok(Some(pcm)) => Some(stretch_clip_pcm_by_speed(&pcm, speed_segments, out_fps)),
        Ok(None) => {
            eprintln!(
                "[pipeline] warning: clip #{clip_index} déclaré audio mais sans flux décodable; silence conservé"
            );
            None
        }
        Err(error) => {
            eprintln!(
                "[pipeline] warning: décodage audio du clip #{clip_index} échoué ({error:#}); silence conservé"
            );
            None
        }
    }
}

/// Collecte les résultats de jobs indexés lancés au fil du parcours, en bornant le nombre
/// de threads simultanés.
///
/// L'ordre de restitution est celui des index, pas celui d'achèvement : `into_results` rend
/// un `Vec` de la taille annoncée où chaque case porte le résultat de son clip.
pub struct ClipAudioJobs<T> {
    inflight: VecDeque<(usize, JoinHandle<T>)>,
    results: Vec<Option<T>>,
}

impl<T: Send + 'static> ClipAudioJobs<T> {
    pub fn new(clip_count: usize) -> Self {
        Self {
            inflight: VecDeque::new(),
            results: (0..clip_count).map(|_| None).collect(),
        }
    }

    /// Lance `job` pour `clip_index`. Si le plafond est atteint, attend d'abord le plus
    /// ancien job en vol — celui qui a eu le plus de temps pour finir.
    pub fn spawn(&mut self, clip_index: usize, job: impl FnOnce() -> T + Send + 'static) {
        while self.inflight.len() >= MAX_INFLIGHT_AUDIO_JOBS {
            self.collect_oldest();
        }
        self.inflight
            .push_back((clip_index, std::thread::spawn(job)));
    }

    /// Attend tous les jobs restants et rend les résultats rangés par index de clip.
    pub fn into_results(mut self) -> Vec<Option<T>> {
        while !self.inflight.is_empty() {
            self.collect_oldest();
        }
        // `mem::take` et pas un move : le `Drop` ci-dessous interdit de sortir un champ de
        // `self`. Il ne trouvera plus rien à joindre, la file étant vide.
        std::mem::take(&mut self.results)
    }

    fn collect_oldest(&mut self) {
        let Some((clip_index, handle)) = self.inflight.pop_front() else {
            return;
        };
        match handle.join() {
            Ok(value) => {
                if let Some(slot) = self.results.get_mut(clip_index) {
                    *slot = Some(value);
                }
            }
            // Un panic dans un job audio ne doit pas emporter l'export : le clip sort
            // muet, comme il le faisait déjà quand `decode_clip_audio` échouait.
            Err(_) => eprintln!(
                "[pipeline] warning: le job audio du clip #{clip_index} a paniqué; silence conservé"
            ),
        }
    }
}

/// Un `JoinHandle` droppé **détache** son thread. Entre le premier `spawn` et
/// `into_results` il y a des `?` — le parcours lui-même, le flush de l'encodeur — et sur
/// l'un d'eux la collection partait en fumée en laissant jusqu'à quatre décodages en vol
/// dans un addon natif que l'hôte peut décharger. On joint donc à la destruction : rien ne
/// survit à la portée, chemin d'erreur compris.
///
/// Ce n'est pas une annulation : `decode_clip_audio` est un appel opaque et long, et
/// l'interrompre demanderait de lui passer un `AVIOInterruptCB` — un autre changement, dans
/// un autre fichier. L'attente est bornée par le plus lent des quatre, soit quelques
/// secondes depuis que le stretch passe par atempo, et elle ne coûte que sur un export qui
/// a déjà échoué.
impl<T> Drop for ClipAudioJobs<T> {
    fn drop(&mut self) {
        for (clip_index, handle) in std::mem::take(&mut self.inflight) {
            if handle.join().is_err() {
                eprintln!(
                    "[pipeline] warning: le job audio du clip #{clip_index} a paniqué pendant l'abandon de l'export"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn results_are_indexed_by_clip_not_by_completion_order() {
        // Le premier job est le plus lent : si on rangeait par ordre d'achèvement, le PCM
        // du clip 0 atterrirait sur le clip 2 et l'export monterait l'audio dans le
        // désordre sans rien signaler.
        let mut jobs = ClipAudioJobs::new(3);
        jobs.spawn(0, || {
            std::thread::sleep(std::time::Duration::from_millis(60));
            "zero"
        });
        jobs.spawn(1, || "one");
        jobs.spawn(2, || "two");
        assert_eq!(
            jobs.into_results(),
            vec![Some("zero"), Some("one"), Some("two")]
        );
    }

    #[test]
    fn a_clip_without_a_job_keeps_its_empty_slot() {
        // Les clips sans audio ne lancent rien ; leur case doit rester `None` pour que
        // `assemble_concatenated_pcm` y mette du silence.
        let mut jobs = ClipAudioJobs::new(3);
        jobs.spawn(1, || 7u32);
        assert_eq!(jobs.into_results(), vec![None, Some(7), None]);
    }

    #[test]
    fn never_more_than_the_cap_run_at_once() {
        // Sans plafond, une timeline longue ouvrirait un contexte ffmpeg et un PCM complet
        // par clip, tous en même temps.
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut jobs = ClipAudioJobs::new(32);
        for index in 0..32 {
            let live = Arc::clone(&live);
            let peak = Arc::clone(&peak);
            jobs.spawn(index, move || {
                let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(5));
                live.fetch_sub(1, Ordering::SeqCst);
                index
            });
        }
        let results = jobs.into_results();
        assert_eq!(results.len(), 32);
        assert!(results.iter().enumerate().all(|(i, r)| *r == Some(i)));
        assert!(
            peak.load(Ordering::SeqCst) <= MAX_INFLIGHT_AUDIO_JOBS,
            "jusqu'à {} jobs simultanés pour un plafond de {MAX_INFLIGHT_AUDIO_JOBS}",
            peak.load(Ordering::SeqCst)
        );
    }

    #[test]
    fn dropping_the_collection_joins_its_jobs_instead_of_detaching_them() {
        // Le chemin d'erreur : entre le premier `spawn` et `into_results` il y a des `?`.
        // Sans le `Drop`, jusqu'à quatre décodages continuaient dans le vide après l'abandon
        // de l'export, dans un addon que l'hôte peut décharger.
        let finished = Arc::new(AtomicUsize::new(0));
        {
            let mut jobs = ClipAudioJobs::new(4);
            for index in 0..4 {
                let finished = Arc::clone(&finished);
                jobs.spawn(index, move || {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    finished.fetch_add(1, Ordering::SeqCst);
                });
            }
            // Pas d'`into_results` : on abandonne, comme le ferait un `?`.
        }
        assert_eq!(
            finished.load(Ordering::SeqCst),
            4,
            "des jobs tournaient encore après la destruction de la collection"
        );
    }

    #[test]
    fn a_panicking_job_leaves_its_clip_silent_without_taking_the_export_down() {
        let mut jobs = ClipAudioJobs::new(2);
        jobs.spawn(0, || panic!("décodage impossible"));
        jobs.spawn(1, || 42u32);
        assert_eq!(jobs.into_results(), vec![None, Some(42)]);
    }
}
