//! Bindings libav* bruts, générés par bindgen sur les headers ffmpeg 8.x (voir build.rs).
#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case, dead_code)]
include!(concat!(env!("OUT_DIR"), "/ffi.rs"));

// ---------------------------------------------------------------------------
// Ce que bindgen ne peut PAS générer
// ---------------------------------------------------------------------------
//
// Deux catégories, et elles vivent ici parce qu'elles ne dépendent d'aucune
// plateforme — `pipeline_windows.rs`, `pipeline_macos.rs` et `audio.rs` en ont
// tous besoin :
//
//   1. Les macros. `AVERROR(EAGAIN)`, `AVERROR_EOF` et `AVSEEK_FLAG_BACKWARD` sont
//      des `#define`, donc invisibles à bindgen ; leurs valeurs sont figées par
//      l'ABI de libavutil.
//   2. Les accesseurs de `shim.c`. `AVFormatContext` n'est atteint que par pointeur
//      dans les headers, donc bindgen le rend opaque et ses champs (`streams`, `pb`)
//      sont inatteignables depuis Rust.

/// `AVERROR(EAGAIN)` — « pas encore de sortie, redonne-moi une entrée ».
///
/// **Cette valeur dépend de la plateforme.** `AVERROR(e)` vaut `-e`, et `EAGAIN` vaut
/// 11 sur Windows et Linux mais **35** sur macOS et les BSD. Une constante écrite en dur
/// à -11 ne fait pas planter macOS : elle fait juste que `avcodec_receive_frame` ne
/// reconnaît jamais son « redonne-moi un paquet », traite -35 comme fatal, et ne décode
/// pas une seule frame. `sn_averror_eagain()` (shim.c) est la valeur de référence, et le
/// test plus bas confronte les deux à chaque `cargo test`.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub const AVERROR_EAGAIN: i32 = -35;
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub const AVERROR_EAGAIN: i32 = -11;
/// `AVERROR_EOF` = `-MKTAG('E','O','F',' ')`.
pub const AVERROR_EOF: i32 = -541478725;
/// `AVERROR_INVALIDDATA` = `-MKTAG('I','N','D','A')`. Contrairement à `AVERROR_EAGAIN`,
/// c'est un FFERRTAG et pas un errno, donc la valeur est la même sur toutes les cibles.
pub const AVERROR_INVALIDDATA: i32 = -1094995529;
/// `AVSEEK_FLAG_BACKWARD` — chercher la keyframe <= ts.
pub const AVSEEK_FLAG_BACKWARD: i32 = 1;

extern "C" {
    /// `s->streams[i]` (cf. `shim.c`).
    pub fn sn_fmt_stream(s: *mut AVFormatContext, i: i32) -> *mut AVStream;
    /// `s->nb_streams` (cf. `shim.c`).
    pub fn sn_fmt_nb_streams(s: *mut AVFormatContext) -> u32;
    /// `s->pb` (cf. `shim.c`).
    pub fn sn_fmt_get_pb(s: *mut AVFormatContext) -> *mut AVIOContext;
    /// `s->pb = p` (cf. `shim.c`).
    pub fn sn_fmt_set_pb(s: *mut AVFormatContext, p: *mut AVIOContext);
    /// `AVERROR(EAGAIN)` tel que le voit le compilateur de la cible (cf. `shim.c`).
    pub fn sn_averror_eagain() -> i32;
    /// `AVERROR_EOF` tel que le voit le compilateur de la cible (cf. `shim.c`).
    pub fn sn_averror_eof() -> i32;
}

/// Transforme un code de retour libav* négatif en `Err` porteur du contexte d'appel.
///
/// Le message reprend le code brut plutôt que `av_strerror` : sur les erreurs de
/// device/hwaccel, `av_strerror` rend « Generic error in an external library », qui
/// ne distingue pas deux causes très différentes, alors que le code numérique se
/// recherche directement dans les sources ffmpeg.
pub fn averr(ret: i32, ctx: &str) -> anyhow::Result<()> {
    if ret < 0 {
        anyhow::bail!("{ctx} a échoué (ret={ret})");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    /// Les constantes Rust doivent valoir EXACTEMENT ce que les macros ffmpeg valent
    /// sur cette cible. C'est le test qui aurait attrapé le -11 en dur sur macOS avant
    /// qu'il ne se manifeste comme « la preview reste noire ».
    #[test]
    fn averror_constants_match_the_ffmpeg_macros() {
        assert_eq!(super::AVERROR_EAGAIN, unsafe { super::sn_averror_eagain() });
        assert_eq!(super::AVERROR_EOF, unsafe { super::sn_averror_eof() });
    }
}
