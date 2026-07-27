//! Animations d'apparition du texte d'annotation.
//!
//! Port VERBATIM de `src/lib/annotationTextAnimation.ts` : même durée, mêmes easings, mêmes
//! amplitudes. Les sept animations étaient déjà nommées dans le schéma, traduites dans les treize
//! langues et transportées jusqu'ici par la scène — mais rien ne les jouait. Reprendre les
//! constantes du TS plutôt que d'en réinventer garantit qu'un projet fait à l'époque de l'aperçu
//! DOM s'anime toujours pareil.

/// Les décalages ci-dessous sont exprimés en px À CETTE HAUTEUR : l'appelant les met à l'échelle
/// de la sortie, exactement comme la taille de police (cf. `annotationScale.ts`). En pixels
/// absolus, la même animation sauterait de deux fois plus haut dans un rendu 4K que dans l'aperçu.
pub const ANIMATION_REFERENCE_HEIGHT: f32 = 1080.0;

pub const TEXT_ANIMATION_DURATION_MS: f32 = 700.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextAnimationState {
    pub opacity: f32,
    pub scale: f32,
    pub translate_x: f32,
    pub translate_y: f32,
    /// Fraction du bloc révélée depuis la gauche (machine à écrire). 1 = tout visible.
    pub reveal: f32,
}

impl TextAnimationState {
    /// L'état « rien à animer » — aussi celui d'une animation inconnue ou absente.
    pub const IDLE: TextAnimationState =
        TextAnimationState { opacity: 1.0, scale: 1.0, translate_x: 0.0, translate_y: 0.0, reveal: 1.0 };
}

fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

fn ease_out_cubic(v: f32) -> f32 {
    let t = clamp01(v);
    1.0 - (1.0 - t).powi(3)
}

fn ease_out_back(v: f32) -> f32 {
    let t = clamp01(v);
    const C1: f32 = 1.70158;
    const C3: f32 = C1 + 1.0;
    1.0 + C3 * (t - 1.0).powi(3) + C1 * (t - 1.0).powi(2)
}

/// État de l'animation `animation` après `elapsed_ms` depuis le début de l'annotation.
pub fn text_animation_state(animation: Option<&str>, elapsed_ms: f32) -> TextAnimationState {
    let name = animation.unwrap_or("none");
    if name == "none" {
        return TextAnimationState::IDLE;
    }
    let progress = clamp01(elapsed_ms.max(0.0) / TEXT_ANIMATION_DURATION_MS);
    let eased = ease_out_cubic(progress);
    match name {
        "fade" => TextAnimationState { opacity: eased, ..TextAnimationState::IDLE },
        "rise" => TextAnimationState {
            opacity: eased,
            translate_y: (1.0 - eased) * 18.0,
            ..TextAnimationState::IDLE
        },
        "pop" => TextAnimationState {
            opacity: eased,
            scale: ease_out_back(progress).max(0.72),
            ..TextAnimationState::IDLE
        },
        "slide-left" => TextAnimationState {
            opacity: eased,
            translate_x: (1.0 - eased) * -28.0,
            ..TextAnimationState::IDLE
        },
        "typewriter" => TextAnimationState { reveal: progress, ..TextAnimationState::IDLE },
        "pulse" => TextAnimationState {
            scale: 1.0 + (progress * std::f32::consts::PI).sin() * 0.06,
            ..TextAnimationState::IDLE
        },
        // Un nom inconnu (projet plus récent que ce binaire) montre le texte tel quel plutôt que
        // de le faire disparaître.
        _ => TextAnimationState::IDLE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_animation_shows_the_text_as_is() {
        for at in [0.0, 350.0, 5000.0] {
            assert_eq!(text_animation_state(None, at), TextAnimationState::IDLE);
            assert_eq!(text_animation_state(Some("none"), at), TextAnimationState::IDLE);
        }
    }

    #[test]
    fn an_unknown_name_shows_the_text_rather_than_hiding_it() {
        // Le pire comportement serait une opacité 0 : l'annotation disparaîtrait sans explication.
        assert_eq!(text_animation_state(Some("kenburns"), 0.0), TextAnimationState::IDLE);
    }

    #[test]
    fn every_animation_settles_on_the_plain_text() {
        // Propriété qui compte le plus : passée la durée, aucune animation ne laisse de trace.
        for name in ["fade", "rise", "pop", "slide-left", "typewriter", "pulse"] {
            let end = text_animation_state(Some(name), TEXT_ANIMATION_DURATION_MS + 1.0);
            assert!((end.opacity - 1.0).abs() < 1e-3, "{name} : opacité {}", end.opacity);
            assert!((end.scale - 1.0).abs() < 1e-3, "{name} : échelle {}", end.scale);
            assert!(end.translate_x.abs() < 1e-3 && end.translate_y.abs() < 1e-3, "{name} : décalé");
            assert!((end.reveal - 1.0).abs() < 1e-3, "{name} : révélation {}", end.reveal);
        }
    }

    #[test]
    fn fade_and_rise_start_invisible_and_below() {
        let fade = text_animation_state(Some("fade"), 0.0);
        assert_eq!(fade.opacity, 0.0);
        let rise = text_animation_state(Some("rise"), 0.0);
        assert_eq!(rise.opacity, 0.0);
        assert!((rise.translate_y - 18.0).abs() < 1e-3, "part de 18px plus bas");
    }

    #[test]
    fn slide_left_enters_from_the_right() {
        // Signe négatif = le texte commence décalé vers la gauche et revient, comme le TS.
        let s = text_animation_state(Some("slide-left"), 0.0);
        assert!((s.translate_x + 28.0).abs() < 1e-3, "translate_x = {}", s.translate_x);
    }

    #[test]
    fn pop_overshoots_then_comes_back() {
        // easeOutBack dépasse 1 avant de retomber : c'est ce qui donne le « pop ».
        let mid = (0..=100)
            .map(|i| text_animation_state(Some("pop"), i as f32 * 7.0).scale)
            .fold(0.0f32, f32::max);
        assert!(mid > 1.0, "aucun dépassement : échelle max {mid}");
        assert!(text_animation_state(Some("pop"), 0.0).scale >= 0.72, "plancher du TS respecté");
    }

    #[test]
    fn pulse_swells_in_the_middle_and_never_moves() {
        let mid = text_animation_state(Some("pulse"), TEXT_ANIMATION_DURATION_MS * 0.5);
        assert!((mid.scale - 1.06).abs() < 1e-3, "échelle {}", mid.scale);
        assert_eq!(mid.opacity, 1.0);
        assert_eq!(mid.translate_x, 0.0);
    }

    #[test]
    fn typewriter_reveals_linearly_and_only_from_the_left() {
        for (at, expected) in [(0.0, 0.0), (175.0, 0.25), (350.0, 0.5), (700.0, 1.0)] {
            let s = text_animation_state(Some("typewriter"), at);
            assert!((s.reveal - expected).abs() < 1e-3, "à {at}ms : {}", s.reveal);
            // Le texte reste opaque : c'est la largeur qui se dévoile, pas l'alpha (l'aperçu DOM
            // faisait exactement ça avec un `inset()`).
            assert_eq!(s.opacity, 1.0);
        }
    }

    #[test]
    fn a_negative_elapsed_time_is_the_start_not_the_end() {
        // Peut arriver d'une frame calculée juste avant le début de l'annotation.
        assert_eq!(text_animation_state(Some("fade"), -50.0).opacity, 0.0);
    }
}
