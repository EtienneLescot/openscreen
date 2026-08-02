//! Le backend CPU Linux (lavapipe) est ATTEIGNABLE, et se declare comme tel.
//!
//! Pendant Linux de `warp_device_cannot_decode.rs` cote Windows. Ce que ce fichier
//! epingle est la propriete que PR #162 a etablie sur Windows et que Linux n'avait
//! que par accident : sur un hote qui possede un GPU, on doit pouvoir DEMANDER le
//! rasteriseur logiciel et l'obtenir.
//!
//! Pourquoi ca vaut un test plutot qu'une note : sans ce forcage, le seul moyen
//! d'exercer le chemin CPU etait de vider le loader Vulkan du processus
//! (`VK_DRIVER_FILES`) -- ce qui, sous Electron, prive AUSSI Chromium de son GPU. Il
//! rasterise alors toute son UI sur CPU, sature la machine, et la mesure ne dit plus
//! rien sur notre compositeur. Le chemin n'etait donc pas testable du tout.

// Linux UNIQUEMENT, comme `warp_device_cannot_decode.rs` l'est a Windows : les
// fichiers de `tests/` sont compiles quelle que soit la plateforme, et `d3d` y
// resout vers un autre module.
#![cfg(target_os = "linux")]

use openscreen_compositor::d3d::{create_backend, Backend, Gpu};

/// Pose a 1 par la CI, ou `mesa-vulkan-drivers` est installe. Sur un poste de dev
/// sans ICD logiciel, ces tests se contentent de le dire : echouer y ferait rougir
/// une machine ou rien n'est casse, et le signal deviendrait du bruit.
const REQUIRE: &str = "OPENSCREEN_REQUIRE_CPU_BACKEND";

fn required() -> bool {
    std::env::var(REQUIRE).is_ok_and(|v| v != "0")
}

/// La propriete centrale : `Backend::Cpu` demande explicitement rend un adaptateur
/// que `classify` range bien en `Cpu`. Si `force_fallback_adapter` cessait d'etre
/// honore par wgpu, ce test attraperait le retour silencieux au GPU -- exactement le
/// mode de panne qui rendrait le chemin CPU intestable sans qu'on s'en apercoive.
#[test]
fn le_backend_cpu_est_demandable_et_se_declare_cpu() {
    match create_backend(Backend::Cpu) {
        Ok(gpu) => assert_eq!(
            gpu.backend,
            Backend::Cpu,
            "force_fallback_adapter a rendu un adaptateur que classify() ne range pas en Cpu"
        ),
        Err(e) if required() => {
            panic!("{REQUIRE} est pose mais le backend CPU est inatteignable : {e:#}")
        }
        Err(e) => {
            eprintln!("cpu_backend_linux: pas de rasteriseur logiciel Vulkan ici ({e:#}). Skip.")
        }
    }
}

/// `probe()` ne doit JAMAIS rendre `None` tant qu'un adaptateur -- n'importe lequel --
/// existe.
///
/// L'enjeu n'est pas cosmetique : `None` remonte a l'UI en `"none"`, que le TS traite
/// comme "pas d'addon natif du tout" (dev pur-web, jsdom) et qui n'affiche donc
/// AUCUNE notice. Un hote lavapipe-seul doit obtenir `Cpu`, sans quoi il rend a
/// quelques fps en silence -- le "l'app rame" que PR #162 avait supprime cote Windows.
#[test]
fn probe_ne_rend_pas_none_quand_un_adaptateur_existe() {
    let cpu = create_backend(Backend::Cpu).is_ok();
    let hw = create_backend(Backend::Hardware).is_ok();
    if !cpu && !hw {
        assert!(
            !required(),
            "{REQUIRE} est pose mais aucun adaptateur Vulkan n'existe ici"
        );
        eprintln!("cpu_backend_linux: aucun adaptateur Vulkan ici. Skip.");
        return;
    }
    assert!(
        Gpu::probe().is_some(),
        "un adaptateur existe (cpu={cpu}, hardware={hw}) mais probe() rend None"
    );
}

/// `create` est documente "materiel strict" -- les goldens et le bench comptent
/// dessus. Sur un hote qui n'a QUE lavapipe, il doit echouer plutot que de rendre un
/// device logiciel : une mesure prise dessus serait presentee comme une mesure GPU.
///
/// Le test n'est concluant que la ou le materiel manque ; ailleurs il verifie la
/// contrepartie, qui est tout aussi cassable : `create` ne rend jamais du `Cpu`.
#[test]
fn create_est_materiel_strict() {
    match create_backend(Backend::Hardware) {
        Ok(gpu) => assert_eq!(
            gpu.backend,
            Backend::Hardware,
            "create() a rendu un device logiciel alors qu'il est documente materiel strict"
        ),
        Err(e) => eprintln!("cpu_backend_linux: pas de GPU ici, create() a bien echoue ({e:#})."),
    }
}
