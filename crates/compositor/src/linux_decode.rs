//! D├®codeur logiciel ffmpeg ÔÇö utilis├® par la tranche verticale `vk_render`
//! pour ouvrir un MP4 fixture et en extraire la `n`-i├¿me frame en m├®moire
//! syst├¿me, sans aucune d├®pendance ├á `D3D11VA`. C├┤t├® production, ce sera
//! `pipeline::Decoder::open` c├┤t├® Windows (qui route par D3D11VA quand FL 11_1
//! + vid├®o disponible, par `vk_frames::VkFrames` sinon) ; ici on isole le
//! chemin ┬½ software decode + `vk_frames::present` ┬╗ pour le d├®montrer sans
//! toucher `pipeline.rs` (cf. spec ┬º3.4 ÔÇö `pipeline.rs` est dans WP6).
//!
//! **S├®curit├® lifetime.** L'`AVFrame` retourn├® est allou├® par `av_frame_alloc`
//! et lib├®r├® par `av_frame_free` ÔÇö le caller doit soit appeler `free_frame()`
//! soit (mieux) laisser `vk_frames::VkFrames::present` la consommer puis
//! r├®├®crire la prochaine. Garder une frame au-del├á du prochain `decode_n`
//! lib├¿re l'ancienne, exactement comme `cpu_frames::present` c├┤t├® #162.

use anyhow::{bail, Context, Result};
use std::ffi::CString;
use std::ptr;

use crate::ffi::{
    av_frame_alloc, av_frame_free, av_frame_move_ref, av_frame_unref, av_packet_alloc,
    av_packet_free, av_read_frame, av_seek_frame, avcodec_alloc_context3, avcodec_find_decoder,
    avcodec_flush_buffers, avcodec_free_context, avcodec_open2, avcodec_parameters_to_context,
    avcodec_receive_frame, avcodec_send_packet, avformat_close_input, avformat_find_stream_info,
    avformat_open_input, AVCodecContext, AVFormatContext, AVFrame, AVMediaType, AVStream,
};

/// `sn_fmt_stream` est d├®fini dans `crates/compositor/shim.c` ÔÇö bindgen ne le voit pas
/// (shim.c est compil├® s├®par├®ment par `cc::Build`). On le d├®clare ici en `extern "C"`
/// comme `pipeline.rs` le fait. La m├¬me convention appara├«t ├á plusieurs endroits du
/// crate pour tous les accesseurs du shim.
extern "C" {
    fn sn_fmt_stream(s: *mut AVFormatContext, i: i32) -> *mut AVStream;
}

/// `SEEK_SET` constant ÔÇö la position de seek `av_seek_frame` interpr├¿te
/// `timestamp` comme un timestamp absolu (AV_TIME_BASE = microsecondes).
const SEEK_SET: i32 = 0;

/// Cherche la vid├®o du fichier, ouvre le d├®codeur, et rend un ├®tat pr├¬t ├á
/// d├®coder. La struct expose `decode_at(frame_idx)` qui seek + d├®code jusqu'├á
/// la frame `frame_idx` (0-index├®e depuis le d├®but du flux).
///
/// Pub (pas `pub(crate)`) parce que `crates/compositor/tests/vk_cross_golden.rs`
/// est un crate externe vis-├á-vis de la lib ; le test pilote la tranche.
pub struct SwDecoder {
    fmt: *mut AVFormatContext,
    dec: *mut AVCodecContext,
    stream_idx: i32,
    /// Timebase du flux vid├®o (en secondes par tick). Permet de convertir un
    /// `frame_idx` en timestamp de seek.
    stream_timebase: f64,
    /// Cadence reelle du flux (avg_frame_rate), PAS 1/time_base.
    fps: f64,
}

/// Lib├¿re toutes les ressources ffmpeg. `Drop` ne peut pas faillir ; on
/// panique sur une erreur double-free improbable (les handles sont nullifi├®s
/// apr├¿s lib├®ration, un deuxi├¿me `Drop` les trouve ├á null et n'agit pas).
impl Drop for SwDecoder {
    fn drop(&mut self) {
        unsafe {
            if !self.dec.is_null() {
                avcodec_free_context(&mut self.dec);
            }
            if !self.fmt.is_null() {
                avformat_close_input(&mut self.fmt);
            }
        }
    }
}

impl SwDecoder {
    pub fn open(path: &str) -> Result<SwDecoder> {
        unsafe { Self::open_inner(path) }
    }

    unsafe fn open_inner(path: &str) -> Result<SwDecoder> {
        let path_c = CString::new(path).context("chemin NUL inattendu")?;
        let mut fmt: *mut AVFormatContext = ptr::null_mut();
        let r = avformat_open_input(&mut fmt, path_c.as_ptr(), ptr::null(), ptr::null_mut());
        if r < 0 {
            bail!("avformat_open_input({path}) a ├®chou├®: {r}");
        }
        if fmt.is_null() {
            bail!("avformat_open_input({path}) a rendu un fmt null");
        }
        let r = avformat_find_stream_info(fmt, ptr::null_mut());
        if r < 0 {
            avformat_close_input(&mut fmt);
            bail!("avformat_find_stream_info({path}) a ├®chou├®: {r}");
        }
        // Trouver le premier flux vid├®o. `av_find_best_stream` fait ├ºa 1.0.
        let stream_idx = crate::ffi::av_find_best_stream(
            fmt,
            AVMediaType::AVMEDIA_TYPE_VIDEO,
            -1,
            -1,
            ptr::null_mut(),
            0,
        );
        if stream_idx < 0 {
            avformat_close_input(&mut fmt);
            bail!("av_find_best_stream n'a pas trouv├® de flux vid├®o dans {path}: {stream_idx}");
        }
        // Codec params ÔåÆ context ÔåÆ open. AVFormatContext est opaque : `sn_fmt_stream`
        // (du `shim.c`) extrait `streams[i]` ; AVStream ne l'est pas, on lit son
        // `codecpar` directement. Cf. `pipeline.rs` pour la convention.
        let stream = sn_fmt_stream(fmt, stream_idx);
        let mut dec = avcodec_alloc_context3(ptr::null());
        if dec.is_null() {
            avformat_close_input(&mut fmt);
            bail!("avcodec_alloc_context3 a ├®chou├®");
        }
        let par = (*stream).codecpar;
        let r = avcodec_parameters_to_context(dec, par);
        if r < 0 {
            avcodec_free_context(&mut dec);
            avformat_close_input(&mut fmt);
            bail!("avcodec_parameters_to_context: {r}");
        }
        let codec = avcodec_find_decoder((*par).codec_id);
        if codec.is_null() {
            avcodec_free_context(&mut dec);
            avformat_close_input(&mut fmt);
            bail!(
                "avcodec_find_decoder n'a pas trouv├® de d├®codeur pour codec_id {}",
                (*par).codec_id
            );
        }
        let r = avcodec_open2(dec, codec, ptr::null_mut());
        if r < 0 {
            avcodec_free_context(&mut dec);
            avformat_close_input(&mut fmt);
            bail!("avcodec_open2: {r}");
        }
        // Timebase du flux vid├®o ÔÇö `AVRational { num, den }`. ffmpeg utilise `num` ticks
        // par `den` secondes. Le wrapper bindgen expose les deux champs en i32.
        let stream_timebase = {
            let num = (*stream).time_base.num as f64;
            let den = (*stream).time_base.den as f64;
            if den == 0.0 {
                1.0 / 60.0 // fallback : suppose 60 fps
            } else {
                num / den
            }
        };
        // fps reel du flux : avg_frame_rate d'abord, r_frame_rate en secours,
        // 60 en dernier recours. PAS 1/time_base (le time_base est le timescale
        // du conteneur, souvent 15360, pas la cadence).
        let fps = {
            let a = (*stream).avg_frame_rate;
            let r = (*stream).r_frame_rate;
            if a.num > 0 && a.den > 0 {
                a.num as f64 / a.den as f64
            } else if r.num > 0 && r.den > 0 {
                r.num as f64 / r.den as f64
            } else {
                60.0
            }
        };
        Ok(SwDecoder {
            fmt,
            dec,
            stream_idx,
            stream_timebase,
            fps,
        })
    }

    /// Seek vers la keyframe la plus proche AVANT `frame_idx`, puis d├®code
    /// jusqu'├á atteindre la frame demand├®e. Le seek est r├®solu par
    /// `av_seek_frame` avec `SEEK_SET | BACKWARD` (cherche le keyframe
    /// pr├®c├®dent le timestamp demand├®). Renvoie une `AVFrame` allou├®e par
    /// `av_frame_alloc` que le caller doit lib├®rer via `free_frame` ÔÇö
    /// ou laisser `vk_frames::VkFrames::present` consommer (qui r├®├®crit
    /// `present` avec son carrier, l'ancienne frame devient inaccessible).
    ///
    /// **Robustesse.** Pour la tranche verticale (`crates/fixture/screen.mp4`
    /// qui est un `-c copy` d'un fragment de recording), `av_seek_frame` peut
    /// renvoyer un packet dont la premi├¿re lecture NAL est mal align├®e (le
    /// moov de la source est en queue, le parser fait de son mieux mais le
    /// premier packet apr├¿s un BACKWARD seek contient parfois un NAL
    /// fragment├®). On skippe ces packets avec `send_packet` qui renvoie
    /// `AVERROR_INVALIDDATA` plut├┤t que de paniquer : la prochaine it├®ration
    /// lira le packet complet suivant.
    pub unsafe fn decode_at(&mut self, frame_idx: u32) -> Result<*mut AVFrame> {
        let fps = self.fps;
        let target_ts = (frame_idx as f64 / fps) * 1_000_000.0; // AV_TIME_BASE = ┬Ás
                                                                // BACKWARD = 4 (chercher la keyframe pr├®c├®dente). Cf. ffmpeg `av_seek_flag`.
        let seek_flags = SEEK_SET | 4;
        let r = av_seek_frame(self.fmt, -1, target_ts as i64, seek_flags);
        if r < 0 {
            bail!("av_seek_frame(ts={target_ts:.0} ┬Ás) a ├®chou├®: {r}");
        }
        // Flush le d├®codeur ÔÇö sans ├ºa, le seek laisse l'├®tat interne avec les
        // frames de l'ancien GOP, et la premi├¿re `receive_frame` peut ├¬tre
        // une frame d'avant le seek.
        avcodec_flush_buffers(self.dec);

        let mut pkt: *mut crate::ffi::AVPacket = ptr::null_mut();
        let mut frame: *mut AVFrame = ptr::null_mut();
        let mut found: *mut AVFrame = ptr::null_mut();

        let target_ts_seconds = target_ts / 1_000_000.0;
        let mut invalid_skips = 0u32;
        'outer: loop {
            pkt = av_packet_alloc();
            if pkt.is_null() {
                bail!("av_packet_alloc en boucle");
            }
            let r = av_read_frame(self.fmt, pkt);
            if r < 0 {
                // EOF ou erreur : on a ├®puis├® le fichier sans atteindre la cible.
                av_packet_free(&mut pkt);
                break 'outer;
            }
            if (*pkt).stream_index != self.stream_idx {
                // Pas un packet vid├®o ÔÇö on le jette et on continue.
                av_packet_free(&mut pkt);
                continue;
            }
            let send_r = avcodec_send_packet(self.dec, pkt);
            av_packet_free(&mut pkt);
            if send_r == -0x2A2A2A2A {
                // AVERROR_INVALIDDATA ÔÇö packet mal align├® apr├¿s un seek. On le
                // saute et on continue ; le decodeur attendra un packet propre.
                // Valeur ffmpeg = -1094995529 (0xBEEBBEEB), ici ├®crite comme
                // un nombre n├®gatif litt├®ral pour ├®viter la d├®pendance `ffi::`.
                invalid_skips += 1;
                if invalid_skips > 8 {
                    bail!("plus de 8 packets invalides apr├¿s seek ÔÇö fichier ou codec cass├®");
                }
                continue;
            }
            if send_r < 0 && send_r != -11 {
                bail!("avcodec_send_packet: {send_r}");
            }
            frame = av_frame_alloc();
            if frame.is_null() {
                bail!("av_frame_alloc en boucle");
            }
            loop {
                let recv_r = avcodec_receive_frame(self.dec, frame);
                if recv_r == 0 {
                    if found.is_null() {
                        found = av_frame_alloc();
                        if found.is_null() {
                            bail!("av_frame_alloc pour resultat");
                        }
                    }
                    av_frame_move_ref(found, frame);
                    av_frame_unref(frame);
                    if (*found).best_effort_timestamp as f64 * self.stream_timebase >= target_ts_seconds {
                        break 'outer;
                    }
                } else if recv_r == -11 {
                    break;
                } else if recv_r == -541478725 {
                    // AVERROR_EOF
                    break 'outer;
                } else if recv_r < 0 {
                    bail!("avcodec_receive_frame: {recv_r}");
                } else {
                    break;
                }
            }
            av_frame_free(&mut frame);
        }
        if !frame.is_null() {
            av_frame_free(&mut frame);
        }
        if !pkt.is_null() {
            av_packet_free(&mut pkt);
        }
        if found.is_null() {
            bail!("decode_at(frame_idx={frame_idx}) : aucune frame re├ºue");
        }
        Ok(found)
    }

    /// Cadence reelle du flux (images/s). Sert a convertir un temps en secondes
    /// vers un index de frame pour le seek du preview Linux.
    pub fn fps(&self) -> f64 {
        self.fps
    }

    /// Duree du flux video en secondes (`stream.duration * time_base`), lue via
    /// le shim `sn_fmt_stream` (AVFormatContext opaque en bindgen). `None` si
    /// indisponible. Pendant Linux de `pipeline_macos::Decoder::available_duration_sec`.
    pub fn duration_sec(&self) -> Option<f64> {
        unsafe {
            let stream = sn_fmt_stream(self.fmt, self.stream_idx);
            if stream.is_null() {
                return None;
            }
            let duration = (*stream).duration;
            if duration > 0 && self.stream_timebase > 0.0 {
                let s = duration as f64 * self.stream_timebase;
                if s.is_finite() && s > 0.0 {
                    return Some(s);
                }
            }
            None
        }
    }

    /// Lib├¿re une frame renvoy├®e par `decode_at`.
    pub unsafe fn free_frame(mut frame: *mut AVFrame) {
        av_frame_free(&mut frame);
    }
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    /// Le d├®codeur ne paniquera pas si le fichier n'existe pas ÔÇö il renvoie
    /// `Err`. C'est ce que le test d'int├®gration attend pour skipper proprement
    /// quand `crates/fixture/screen.mp4` est absent.
    #[test]
    fn open_sur_chemin_inexistant_renvoie_err() {
        let r = SwDecoder::open("Z:/does/not/exist.mp4");
        assert!(r.is_err());
    }
}
