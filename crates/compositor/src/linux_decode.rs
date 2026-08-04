//! Décodeur logiciel ffmpeg — utilisé par la tranche verticale `vk_render`
//! pour ouvrir un MP4 fixture et en extraire la `n`-ième frame en mémoire
//! système, sans aucune dépendance à `D3D11VA`. Côté production, ce sera
//! `pipeline::Decoder::open` côté Windows (qui route par D3D11VA quand FL 11_1
//! + vidéo disponible, par `vk_frames::VkFrames` sinon) ; ici on isole le
//! chemin « software decode + `vk_frames::present` » pour le démontrer sans
//! toucher `pipeline.rs` (cf. spec §3.4 — `pipeline.rs` est dans WP6).
//!
//! **Sécurité lifetime.** L'`AVFrame` retourné est alloué par `av_frame_alloc`
//! et libéré par `av_frame_free` — le caller doit soit appeler `free_frame()`
//! soit (mieux) laisser `vk_frames::VkFrames::present` la consommer puis
//! réécrire la prochaine. Garder une frame au-delà du prochain `decode_n`
//! libère l'ancienne, exactement comme `cpu_frames::present` côté #162.

use anyhow::{bail, Context, Result};
use std::ffi::CString;
use std::ptr;

use crate::timeline_walk::NextFrameTime;

use crate::ffi::{
    av_frame_alloc, av_frame_free, av_frame_move_ref, av_frame_unref, av_packet_alloc,
    av_packet_free, av_packet_unref, av_read_frame, av_seek_frame, avcodec_alloc_context3,
    avcodec_find_decoder, avcodec_flush_buffers, avcodec_free_context, avcodec_open2,
    avcodec_parameters_to_context, avcodec_receive_frame, avcodec_send_packet,
    avformat_close_input, avformat_find_stream_info, avformat_open_input, AVCodecContext,
    AVFormatContext, AVFrame, AVMediaType, AVPacket, AVStream, AVERROR_EAGAIN, AVERROR_EOF,
    AVERROR_INVALIDDATA, AVSEEK_FLAG_BACKWARD,
};

/// `sn_fmt_stream` est défini dans `crates/compositor/shim.c` — bindgen ne le voit pas
/// (shim.c est compilé séparément par `cc::Build`). On le déclare ici en `extern "C"`
/// comme `pipeline.rs` le fait. La même convention apparaît à plusieurs endroits du
/// crate pour tous les accesseurs du shim.
extern "C" {
    fn sn_fmt_stream(s: *mut AVFormatContext, i: i32) -> *mut AVStream;
}

/// `SEEK_SET` constant — la position de seek `av_seek_frame` interprète
/// `timestamp` comme un timestamp absolu (AV_TIME_BASE = microsecondes).
const SEEK_SET: i32 = 0;

/// Cherche la vidéo du fichier, ouvre le décodeur, et rend un état prêt à
/// décoder. La struct expose `decode_at(frame_idx)` qui seek + décode jusqu'à
/// la frame `frame_idx` (0-indexée depuis le début du flux).
///
/// Pub (pas `pub(crate)`) parce que `crates/compositor/tests/vk_cross_golden.rs`
/// est un crate externe vis-à-vis de la lib ; le test pilote la tranche.
pub struct SwDecoder {
    fmt: *mut AVFormatContext,
    dec: *mut AVCodecContext,
    stream_idx: i32,
    /// Timebase du flux vidéo (en secondes par tick). Permet de convertir un
    /// `frame_idx` en timestamp de seek.
    stream_timebase: f64,
    /// Cadence reelle du flux (avg_frame_rate), PAS 1/time_base.
    fps: f64,
    /// Packet/frame persistants du pompage SEQUENTIEL (`next_frame`).
    pkt: *mut AVPacket,
    frame: *mut AVFrame,
    sent_eof: bool,
    cur_pts: Option<i64>,
    /// Buffer de lookahead pour `peek_next_time_sec` : symétrique de
    /// `pipeline_macos::Decoder::peek_frame` — cf. là-bas pour la justification.
    peek_frame: *mut AVFrame,
    /// `true` si `peek_frame` porte une frame décodée en attente de `commit_peek`.
    has_peek: bool,
}

/// Libère toutes les ressources ffmpeg. `Drop` ne peut pas faillir ; on
/// panique sur une erreur double-free improbable (les handles sont nullifiés
/// après libération, un deuxième `Drop` les trouve à null et n'agit pas).
impl Drop for SwDecoder {
    fn drop(&mut self) {
        unsafe {
            if !self.dec.is_null() {
                avcodec_free_context(&mut self.dec);
            }
            if !self.fmt.is_null() {
                avformat_close_input(&mut self.fmt);
            }
            if !self.frame.is_null() {
                av_frame_free(&mut self.frame);
            }
            if !self.pkt.is_null() {
                av_packet_free(&mut self.pkt);
            }
            if !self.peek_frame.is_null() {
                av_frame_free(&mut self.peek_frame);
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
            bail!("avformat_open_input({path}) a échoué: {r}");
        }
        if fmt.is_null() {
            bail!("avformat_open_input({path}) a rendu un fmt null");
        }
        let r = avformat_find_stream_info(fmt, ptr::null_mut());
        if r < 0 {
            avformat_close_input(&mut fmt);
            bail!("avformat_find_stream_info({path}) a échoué: {r}");
        }
        // Trouver le premier flux vidéo. `av_find_best_stream` fait ça 1.0.
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
            bail!("av_find_best_stream n'a pas trouvé de flux vidéo dans {path}: {stream_idx}");
        }
        // Codec params → context → open. AVFormatContext est opaque : `sn_fmt_stream`
        // (du `shim.c`) extrait `streams[i]` ; AVStream ne l'est pas, on lit son
        // `codecpar` directement. Cf. `pipeline.rs` pour la convention.
        let stream = sn_fmt_stream(fmt, stream_idx);
        let mut dec = avcodec_alloc_context3(ptr::null());
        if dec.is_null() {
            avformat_close_input(&mut fmt);
            bail!("avcodec_alloc_context3 a échoué");
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
                "avcodec_find_decoder n'a pas trouvé de décodeur pour codec_id {}",
                (*par).codec_id
            );
        }
        // Threads de decodage : 0 = « autant que de coeurs », exactement ce que
        // `pipeline_windows.rs:526` et `pipeline_macos.rs:178` posent sur leur
        // decodeur. Sans ca ffmpeg reste a 1 thread.
        (*dec).thread_count = 0;
        let r = avcodec_open2(dec, codec, ptr::null_mut());
        if r < 0 {
            avcodec_free_context(&mut dec);
            avformat_close_input(&mut fmt);
            bail!("avcodec_open2: {r}");
        }
        // Timebase du flux vidéo — `AVRational { num, den }`. ffmpeg utilise `num` ticks
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
        let pkt = av_packet_alloc();
        let frame = av_frame_alloc();
        let peek_frame = av_frame_alloc();
        if pkt.is_null() || frame.is_null() || peek_frame.is_null() {
            avcodec_free_context(&mut dec);
            avformat_close_input(&mut fmt);
            bail!("av_packet_alloc/av_frame_alloc (pompage sequentiel)");
        }
        Ok(SwDecoder {
            fmt,
            dec,
            stream_idx,
            stream_timebase,
            fps,
            pkt,
            frame,
            sent_eof: false,
            cur_pts: None,
            peek_frame,
            has_peek: false,
        })
    }

    /// Rend la frame SUIVANTE du flux, valide jusqu'au prochain appel, ou null a
    /// EOF. C'est le pompage `receive_frame`/`read_frame`/`send_packet` classique,
    /// identique a `pipeline_windows::Decoder::next` et `pipeline_macos`. Il ne
    /// seek PAS : le decodeur garde son etat, donc une lecture sequentielle coute
    /// UN packet par frame au lieu d'un re-parcours de demi-GOP.
    pub unsafe fn next_frame(&mut self) -> Result<*mut AVFrame> {
        if self.has_peek {
            return self.commit_peek();
        }
        if !self.receive_into(self.frame)? {
            return Ok(ptr::null_mut());
        }
        let pts = (*self.frame).best_effort_timestamp;
        self.cur_pts = if pts == i64::MIN { None } else { Some(pts) };
        Ok(self.frame)
    }

    /// Décode dans `into` (buffer courant ou de lookahead) jusqu'à obtenir une frame ou
    /// l'EOF — cf. `pipeline_macos::Decoder::receive_into` pour la justification.
    unsafe fn receive_into(&mut self, into: *mut AVFrame) -> Result<bool> {
        loop {
            let r = avcodec_receive_frame(self.dec, into);
            if r == 0 {
                return Ok(true);
            }
            if r == AVERROR_EOF {
                return Ok(false);
            }
            if r != AVERROR_EAGAIN {
                bail!("avcodec_receive_frame: {r}");
            }
            if self.sent_eof {
                return Ok(false);
            }
            let rr = av_read_frame(self.fmt, self.pkt);
            if rr < 0 {
                // EOF (ou erreur de lecture) : on draine l'encodeur interne.
                avcodec_send_packet(self.dec, ptr::null_mut());
                self.sent_eof = true;
            } else {
                if (*self.pkt).stream_index == self.stream_idx {
                    let sr = avcodec_send_packet(self.dec, self.pkt);
                    // AVERROR_INVALIDDATA : packet mal aligne apres un seek, on saute.
                    // La valeur etait ecrite en dur a -0x2A2A2A2A, soit le tag `****`,
                    // qui ne designe aucune erreur ffmpeg : le garde ne matchait donc
                    // jamais et une vraie donnee invalide avortait tout le decodage --
                    // exactement le cas du scrub, qui seeke en permanence.
                    if sr < 0 && sr != AVERROR_INVALIDDATA && sr != AVERROR_EAGAIN {
                        av_packet_unref(self.pkt);
                        bail!("avcodec_send_packet: {sr}");
                    }
                }
                av_packet_unref(self.pkt);
            }
        }
    }

    /// Décode la prochaine frame dans le buffer de lookahead et renvoie son temps.
    /// Cf. `pipeline_macos::Decoder::peek_next_time_sec`.
    pub(crate) unsafe fn peek_next_time_sec(&mut self) -> Result<NextFrameTime> {
        if !self.has_peek {
            if !self.receive_into(self.peek_frame)? {
                return Ok(NextFrameTime::Eof);
            }
            self.has_peek = true;
        }
        let pts = (*self.peek_frame).best_effort_timestamp;
        // Sans pts ni time_base exploitables on ne PEUT pas dire si la frame est due :
        // `Unknown`, et non `0.0` — qui passait pour « due » à tous les coups.
        Ok(if pts == i64::MIN || self.stream_timebase <= 0.0 {
            NextFrameTime::Unknown
        } else {
            NextFrameTime::At(pts as f64 * self.stream_timebase)
        })
    }

    /// Promeut la frame de lookahead au rang de frame courante. Cf.
    /// `pipeline_macos::Decoder::commit_peek`.
    pub(crate) unsafe fn commit_peek(&mut self) -> Result<*mut AVFrame> {
        // `bail!` et non `debug_assert!` : compilée en release, l'assertion disparaissait
        // et l'échange promouvait un `AVFrame` jamais rempli, avec un
        // `best_effort_timestamp` indéterminé, jusque dans le chemin de présentation.
        if !self.has_peek {
            bail!("commit_peek sans peek_next_time_sec préalable");
        }
        std::mem::swap(&mut self.frame, &mut self.peek_frame);
        self.has_peek = false;
        let pts = (*self.frame).best_effort_timestamp;
        self.cur_pts = if pts == i64::MIN { None } else { Some(pts) };
        Ok(self.frame)
    }

    /// Temps source (secondes) de la derniere frame rendue par `next_frame` /
    /// `decode_at`, tire du pts REEL et non d'un compteur d'index.
    pub fn cur_time_sec(&self) -> Option<f64> {
        self.cur_pts.map(|pts| pts as f64 * self.stream_timebase)
    }

    /// Seek vers la keyframe la plus proche AVANT `frame_idx`, puis décode
    /// jusqu'à atteindre la frame demandée. Le seek est résolu par
    /// `av_seek_frame` avec `SEEK_SET | BACKWARD` (cherche le keyframe
    /// précédent le timestamp demandé). Renvoie une `AVFrame` allouée par
    /// `av_frame_alloc` que le caller doit libérer via `free_frame` —
    /// ou laisser `vk_frames::VkFrames::present` consommer (qui réécrit
    /// `present` avec son carrier, l'ancienne frame devient inaccessible).
    ///
    /// **Robustesse.** Pour la tranche verticale (`crates/fixture/screen.mp4`
    /// qui est un `-c copy` d'un fragment de recording), `av_seek_frame` peut
    /// renvoyer un packet dont la première lecture NAL est mal alignée (le
    /// moov de la source est en queue, le parser fait de son mieux mais le
    /// premier packet après un BACKWARD seek contient parfois un NAL
    /// fragmenté). On skippe ces packets avec `send_packet` qui renvoie
    /// `AVERROR_INVALIDDATA` plutôt que de paniquer : la prochaine itération
    /// lira le packet complet suivant.
    pub unsafe fn decode_at(&mut self, frame_idx: u32) -> Result<*mut AVFrame> {
        // Tout seek invalide un éventuel peek en attente — cf. pipeline_macos::Decoder::seek_to.
        self.has_peek = false;
        let fps = self.fps;
        let target_ts = (frame_idx as f64 / fps) * 1_000_000.0; // AV_TIME_BASE = µs
        // `AVSEEK_FLAG_BACKWARD` vaut 1, pas 4 — 4 est `AVSEEK_FLAG_ANY`. La constante
        // était écrite en dur à 4 avec un commentaire affirmant le contraire, et c'est
        // le seul seek du crate à ne pas passer par `ffi::AVSEEK_FLAG_BACKWARD` (cf.
        // pipeline_windows.rs, pipeline_macos.rs, audio.rs).
        //
        // Sans BACKWARD, ffmpeg se cale sur la première position indexée AU NIVEAU OU
        // APRÈS la cible, au lieu de la keyframe qui la précède. La boucle d'avance
        // ci-dessous s'arrête dès que `pts >= target`, condition alors satisfaite par la
        // toute première frame décodée : elle ne fait plus rien et `decode_at` rend la
        // keyframe SUIVANTE. L'erreur est d'un GOP entier.
        //
        // D'où le symptôme asymétrique signalé : l'écran porte une keyframe toutes les
        // ~1,78 s, la webcam toutes les ~6,73 s, donc l'écart y est ~4x plus grand. Et
        // comme `live::Player::step` rattrape la webcam par une boucle monotone vers
        // l'avant, une fois garée dans le futur elle ne revient jamais — elle fige.
        let seek_flags = SEEK_SET | AVSEEK_FLAG_BACKWARD;
        let r = av_seek_frame(self.fmt, -1, target_ts as i64, seek_flags);
        if r < 0 {
            // Repli : rembobiner au début et balayer en avant.
            //
            // Un WebM de `MediaRecorder` n'a NI Cues NI SeekHead — il est écrit en flux
            // et personne ne revient poser l'index —, donc tout seek vers un timestamp
            // arbitraire échoue. C'est le cas de tout enregistrement Linux tant qu'il
            // n'existe pas de helper de capture natif : la capture y passe par
            // getDisplayMedia/MediaRecorder, là où Windows et macOS ont des helpers qui
            // écrivent des fichiers indexés.
            //
            // Rembobiner à 0 reste possible sans index (c'est le début du fichier), et
            // la boucle ci-dessous sait déjà avancer jusqu'à `target_ts`. Le coût est
            // linéaire, ce qui n'est acceptable que depuis le pompage séquentiel : le
            // décodage mesure ~0,07 ms/frame, donc rejoindre la seconde 14 d'un
            // enregistrement coûte quelques dizaines de ms au lieu d'échouer.
            let rewound = av_seek_frame(self.fmt, -1, 0, seek_flags);
            if rewound < 0 {
                bail!(
                    "av_seek_frame(ts={target_ts:.0} µs) a échoué: {r}, et le rembobinage \
                     aussi: {rewound}"
                );
            }
        }
        // Flush le décodeur — sans ça, le seek laisse l'état interne avec les
        // frames de l'ancien GOP, et la première `receive_frame` peut être
        // une frame d'avant le seek.
        avcodec_flush_buffers(self.dec);
        // Le seek rouvre le flux : le drapeau EOF du pompage sequentiel retombe.
        self.sent_eof = false;

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
                // EOF ou erreur : on a épuisé le fichier sans atteindre la cible.
                av_packet_free(&mut pkt);
                break 'outer;
            }
            if (*pkt).stream_index != self.stream_idx {
                // Pas un packet vidéo — on le jette et on continue.
                av_packet_free(&mut pkt);
                continue;
            }
            let send_r = avcodec_send_packet(self.dec, pkt);
            av_packet_free(&mut pkt);
            if send_r == -0x2A2A2A2A {
                // AVERROR_INVALIDDATA — packet mal aligné après un seek. On le
                // saute et on continue ; le decodeur attendra un packet propre.
                // Valeur ffmpeg = -1094995529 (0xBEEBBEEB), ici écrite comme
                // un nombre négatif littéral pour éviter la dépendance `ffi::`.
                invalid_skips += 1;
                if invalid_skips > 8 {
                    bail!("plus de 8 packets invalides après seek — fichier ou codec cassé");
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
                    // FUITE MÉMOIRE si on l'oublie. `av_frame_move_ref` écrase
                    // `found` SANS déréférencer ce qu'il contenait — c'est écrit
                    // noir sur blanc dans libavutil/frame.h : « dst is not
                    // unreferenced, but directly overwritten without reading or
                    // deallocating its contents. Call av_frame_unref(dst)
                    // manually before calling this function to ensure that no
                    // memory is leaked. »
                    //
                    // Cette boucle décode en avant depuis la keyframe jusqu'à la
                    // cible, donc elle passe ici une fois par frame du GOP. Sans
                    // ce unref, chaque frame intermédiaire abandonnait ses
                    // buffers : ~3,1 Mo en 1080p YUV420P, plusieurs dizaines de
                    // fois par scrub. Symptôme observé : le scrubbing ralentit
                    // progressivement, puis l'app gèle et meurt.
                    av_frame_unref(found);
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
            bail!("decode_at(frame_idx={frame_idx}) : aucune frame reçue");
        }
        let pts = (*found).best_effort_timestamp;
        self.cur_pts = if pts == i64::MIN { None } else { Some(pts) };
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

    /// Libère une frame renvoyée par `decode_at`.
    pub unsafe fn free_frame(mut frame: *mut AVFrame) {
        av_frame_free(&mut frame);
    }
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    /// Le décodeur ne paniquera pas si le fichier n'existe pas — il renvoie
    /// `Err`. C'est ce que le test d'intégration attend pour skipper proprement
    /// quand `crates/fixture/screen.mp4` est absent.
    #[test]
    fn open_sur_chemin_inexistant_renvoie_err() {
        let r = SwDecoder::open("Z:/does/not/exist.mp4");
        assert!(r.is_err());
    }
}
