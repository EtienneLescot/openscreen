//! Remux « stream copy » vers le muxer MATROSKA — réécrit un fichier en gardant
//! ses paquets bit-pour-bit, uniquement pour lui donner un index de seek.
//!
//! # Le problème
//!
//! `MediaRecorder` (Chromium) écrit le WebM comme un flux **live** : il n'a pas
//! le droit de revenir en arrière pour remplir un index, donc le fichier final
//! n'a NI `Cues` NI `SeekHead`. Vérifié sur un vrai enregistrement de l'app :
//! les deux magic bytes sont absents du début comme de la fin du fichier. Sans
//! `Cues`, `av_seek_frame` n'a aucun point d'entrée et échoue pour tout
//! timestamp non nul — d'où le repli « rembobine et scanne » linéaire de
//! `linux_decode.rs`.
//!
//! # Le correctif
//!
//! Relire les paquets et les réécrire par le muxer matroska, qui lui connaît la
//! taille finale du fichier et écrit donc `Cues` + `SeekHead` en fin de course
//! (`av_write_trailer` revient au début patcher les offsets). Aucun ré-encodage :
//! les paquets sont copiés tels quels, seuls les timestamps sont rebasés sur la
//! timebase du flux de sortie. Mesuré sur un enregistrement réel de 7,8 Mo :
//! 0,084 s et +378 octets.
//!
//! # Pourquoi `matroska` et pas `webm`
//!
//! Le muxer `webm` REFUSE ce fichier : « Only VP8 or VP9 or AV1 video and Vorbis
//! or Opus audio ... are supported for WebM ». Chromium produit du **H.264 dans
//! du WebM**, une combinaison hors spec que seul lui écrit. On force donc le
//! muxer matroska par son nom (2e argument d'`avformat_alloc_output_context2`),
//! ce qui court-circuite la déduction par extension — le fichier de sortie garde
//! son nom `.webm` alors que son contenu est du Matroska, ce qui est un
//! sur-ensemble strict et décrit le contenu plus honnêtement que ne le faisait
//! `MediaRecorder`. L'extension NE CHANGE PAS : elle alimente le nom du sidecar
//! curseur, le JSON de session et la persistance projet côté TS.
//!
//! # Effet de bord utile : la `Duration`
//!
//! Le muxer matroska recalcule la `Duration` à partir des timestamps réels des
//! paquets, sans lire celle de l'entrée. Confronté à une entrée dont la
//! `Duration` avait été forcée à 999999, il a écrit 16977 — la vraie valeur. Ce
//! remux subsume donc le patch de `Duration` que `webm-duration.ts` applique
//! par ailleurs (`MediaRecorder` ne l'écrit pas non plus).

use anyhow::{bail, Context, Result};
use std::ffi::CString;
use std::ptr;

use crate::ffi::{
    av_interleaved_write_frame, av_packet_alloc, av_packet_free, av_packet_rescale_ts,
    av_packet_unref, av_read_frame, av_write_trailer, avcodec_parameters_copy,
    avformat_alloc_output_context2, avformat_close_input, avformat_find_stream_info,
    avformat_free_context, avformat_new_stream, avformat_open_input, avformat_write_header,
    averr, avio_closep, avio_open, sn_fmt_nb_streams, sn_fmt_set_pb, sn_fmt_stream, AVIOContext,
    AVFormatContext, AVMediaType, AVPacket, AVIO_FLAG_WRITE,
};

/// Bilan d'un remux, remonté jusqu'à la glue TS pour la journalisation.
#[derive(Debug)]
pub struct RemuxStats {
    /// Nombre de paquets recopiés (toutes pistes confondues).
    pub packets: u64,
    /// Nombre de pistes conservées dans la sortie.
    pub streams: u32,
    /// Durée du remux en secondes.
    pub wall_s: f64,
}

/// Ferme les ressources libav* quel que soit le chemin de sortie (`?` compris).
///
/// Sans ça, chaque `?` du corps de `remux_to_seekable_matroska` fuiterait un
/// `AVFormatContext` et un descripteur de fichier. `Drop` ne peut pas faillir,
/// donc les erreurs de fermeture sont ignorées — on est déjà en train de rendre
/// une erreur au caller quand ça arrive.
struct RemuxGuard {
    ictx: *mut AVFormatContext,
    octx: *mut AVFormatContext,
    pb: *mut AVIOContext,
    pkt: *mut AVPacket,
}

impl Drop for RemuxGuard {
    fn drop(&mut self) {
        unsafe {
            if !self.pkt.is_null() {
                av_packet_free(&mut self.pkt);
            }
            if !self.ictx.is_null() {
                avformat_close_input(&mut self.ictx);
            }
            if !self.pb.is_null() {
                avio_closep(&mut self.pb);
            }
            if !self.octx.is_null() {
                avformat_free_context(self.octx);
                self.octx = ptr::null_mut();
            }
        }
    }
}

/// Recopie `input` vers `output` par le muxer matroska, sans ré-encoder.
///
/// `output` DOIT être un chemin temporaire distinct de `input` : le caller
/// (`electron/recording/webm-seek-index.ts`) ne renomme par-dessus l'original
/// qu'une fois le remux terminé, pour qu'un échec laisse l'enregistrement
/// d'origine intact. Écrire directement sur `input` détruirait la seule copie
/// des pixels dès la première erreur d'écriture.
///
/// Les pistes autres que vidéo/audio/sous-titre sont ignorées : `MediaRecorder`
/// n'en produit pas, et un flux `DATA` ou `ATTACHMENT` inattendu ferait échouer
/// `avformat_write_header` plutôt que de dégrader proprement.
pub fn remux_to_seekable_matroska(input: &str, output: &str) -> Result<RemuxStats> {
    if input == output {
        bail!("remux : entrée et sortie identiques ({input}) — le caller doit passer un chemin temporaire");
    }
    let t0 = std::time::Instant::now();
    let cin = CString::new(input).context("chemin d'entrée non convertible en CString")?;
    let cout = CString::new(output).context("chemin de sortie non convertible en CString")?;
    // Nom du muxer, PAS une extension : c'est l'équivalent de `-f matroska`.
    let cfmt = CString::new("matroska").expect("littéral sans NUL");

    let mut guard = RemuxGuard {
        ictx: ptr::null_mut(),
        octx: ptr::null_mut(),
        pb: ptr::null_mut(),
        pkt: ptr::null_mut(),
    };

    unsafe {
        averr(
            avformat_open_input(&mut guard.ictx, cin.as_ptr(), ptr::null_mut(), ptr::null_mut()),
            "avformat_open_input",
        )?;
        averr(
            avformat_find_stream_info(guard.ictx, ptr::null_mut()),
            "avformat_find_stream_info",
        )?;

        averr(
            avformat_alloc_output_context2(
                &mut guard.octx,
                ptr::null(),
                cfmt.as_ptr(),
                cout.as_ptr(),
            ),
            "avformat_alloc_output_context2(matroska)",
        )?;
        if guard.octx.is_null() {
            bail!("avformat_alloc_output_context2 n'a pas alloué de contexte matroska");
        }

        // `stream_map[i]` = index de sortie de la piste d'entrée `i`, ou -1 si
        // elle est ignorée. Les index de sortie sont réattribués en séquence,
        // donc ils ne coïncident pas forcément avec ceux de l'entrée.
        let nb_in = sn_fmt_nb_streams(guard.ictx);
        let mut stream_map: Vec<i32> = vec![-1; nb_in as usize];
        let mut nb_out: i32 = 0;
        for i in 0..nb_in {
            let istream = sn_fmt_stream(guard.ictx, i as i32);
            if istream.is_null() {
                continue;
            }
            let codec_type = (*(*istream).codecpar).codec_type;
            if codec_type != AVMediaType::AVMEDIA_TYPE_VIDEO
                && codec_type != AVMediaType::AVMEDIA_TYPE_AUDIO
                && codec_type != AVMediaType::AVMEDIA_TYPE_SUBTITLE
            {
                continue;
            }
            let ostream = avformat_new_stream(guard.octx, ptr::null());
            if ostream.is_null() {
                bail!("avformat_new_stream a rendu NULL pour la piste {i}");
            }
            averr(
                avcodec_parameters_copy((*ostream).codecpar, (*istream).codecpar),
                "avcodec_parameters_copy",
            )?;
            // Le codec_tag est propre au conteneur d'origine ; le garder ferait
            // écrire à matroska un tag qu'il ne reconnaît pas. 0 = « au muxer de
            // choisir », c'est ce que fait `ffmpeg -c copy`.
            (*(*ostream).codecpar).codec_tag = 0;
            stream_map[i as usize] = nb_out;
            nb_out += 1;
        }
        if nb_out == 0 {
            bail!("remux : aucune piste vidéo/audio/sous-titre dans {input}");
        }

        averr(
            avio_open(&mut guard.pb, cout.as_ptr(), AVIO_FLAG_WRITE as i32),
            "avio_open",
        )?;
        sn_fmt_set_pb(guard.octx, guard.pb);
        averr(
            avformat_write_header(guard.octx, ptr::null_mut()),
            "avformat_write_header",
        )?;

        guard.pkt = av_packet_alloc();
        if guard.pkt.is_null() {
            bail!("av_packet_alloc a rendu NULL");
        }

        let mut packets: u64 = 0;
        loop {
            let r = av_read_frame(guard.ictx, guard.pkt);
            if r < 0 {
                // Fin de fichier ou flux tronqué : dans les deux cas on écrit le
                // trailer sur ce qu'on a. Un enregistrement coupé net (crash,
                // batterie) reste lisible et devient seekable jusqu'à sa coupure.
                break;
            }
            let in_idx = (*guard.pkt).stream_index;
            let out_idx = stream_map
                .get(in_idx as usize)
                .copied()
                .unwrap_or(-1);
            if out_idx < 0 {
                av_packet_unref(guard.pkt);
                continue;
            }
            let istream = sn_fmt_stream(guard.ictx, in_idx);
            let ostream = sn_fmt_stream(guard.octx, out_idx);
            if istream.is_null() || ostream.is_null() {
                av_packet_unref(guard.pkt);
                continue;
            }
            av_packet_rescale_ts(guard.pkt, (*istream).time_base, (*ostream).time_base);
            (*guard.pkt).stream_index = out_idx;
            // `pos` décrit un offset dans le fichier d'ENTRÉE ; le laisser
            // induirait le muxer en erreur sur la sortie.
            (*guard.pkt).pos = -1;
            let w = av_interleaved_write_frame(guard.octx, guard.pkt);
            // `av_interleaved_write_frame` prend possession du paquet (il le
            // déréférence lui-même), d'où l'absence d'`av_packet_unref` ici.
            averr(w, "av_interleaved_write_frame")?;
            packets += 1;
        }

        // C'est CE trailer qui écrit `Cues` puis revient patcher `SeekHead`.
        averr(av_write_trailer(guard.octx), "av_write_trailer")?;

        Ok(RemuxStats {
            packets,
            streams: nb_out as u32,
            wall_s: t0.elapsed().as_secs_f64(),
        })
    }
}
