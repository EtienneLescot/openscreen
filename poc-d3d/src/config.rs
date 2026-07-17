//! Configurations cumulatives (§9) : chaque cfg ajoute une couche. Le delta de fps
//! entre deux lignes = le coût de la couche ajoutée. Même fixture, mêmes réglages sortie.

#[derive(Clone)]
pub struct Cfg {
    pub name: &'static str,
    pub composite: bool,   // C1+ : composite 2 sources (sinon décode+encode seul = C0)
    pub rounded: bool,     // C2+ : coins arrondis (SDF)
    pub shadow: bool,      // C3+ : ombres portées
    pub bg_blur: bool,     // C4+ : fond flouté (gaussien séparable)
    pub zoom: bool,        // C5+ : zoom animé
    pub layout_anim: bool, // C6+ : animation de layout A<->B
    pub cursor: bool,      // C7+ : curseur custom + click bounce
    pub mblur_n: u32,      // C8 : flou de mouvement — nb de taps du flou par vélocité (1 = off)
    pub desc: &'static str,
}

impl Cfg {
    pub fn by_name(name: &str) -> Option<Cfg> {
        all().into_iter().find(|c| c.name == name)
    }
}

/// C0..C8, cumulatives.
pub fn all() -> Vec<Cfg> {
    let base = Cfg {
        name: "C0",
        composite: false,
        rounded: false,
        shadow: false,
        bg_blur: false,
        zoom: false,
        layout_anim: false,
        cursor: false,
        mblur_n: 1,
        desc: "décode + encode, aucun composite",
    };
    let c1 = Cfg { name: "C1", composite: true, desc: "+ fond, layout, 2 sources (E1)", ..base.clone() };
    let c2 = Cfg { name: "C2", rounded: true, desc: "+ coins arrondis (E2)", ..c1.clone() };
    let c3 = Cfg { name: "C3", shadow: true, desc: "+ ombres portées (E4)", ..c2.clone() };
    let c4 = Cfg { name: "C4", bg_blur: true, desc: "+ fond flouté (E3)", ..c3.clone() };
    let c5 = Cfg { name: "C5", zoom: true, desc: "+ zoom animé", ..c4.clone() };
    let c6 = Cfg { name: "C6", layout_anim: true, desc: "+ animation de layout", ..c5.clone() };
    let c7 = Cfg { name: "C7", cursor: true, desc: "+ curseur custom (bounce)", ..c6.clone() };
    let c8 = Cfg { name: "C8", mblur_n: 8, desc: "+ flou de mouvement (vélocité, 8 taps)", ..c7.clone() };
    vec![base, c1, c2, c3, c4, c5, c6, c7, c8]
}
