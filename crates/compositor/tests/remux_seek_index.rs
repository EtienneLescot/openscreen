//! Le remux doit doter un Matroska « live » (sans index) de ses `Cues`.
//!
//! C'est le filet du correctif « les enregistrements Linux ne sont pas
//! seekables » : `MediaRecorder` écrit son WebM en flux live, donc sans `Cues`
//! ni `SeekHead`, et `av_seek_frame` échoue alors pour tout timestamp non nul.
//!
//! Le test est AUTONOME — il ne dépend ni d'un binaire ffmpeg ni d'une fixture
//! média (celles de `crates/fixture/` ne sont pas versionnées, cf.
//! `export_timing.rs` qui doit être opt-in pour cette raison). Il fabrique son
//! entrée avec le muxer matroska lui-même en mode `live=1`, qui est précisément
//! le mode « je ne peux pas revenir en arrière » que subit `MediaRecorder` :
//! aucun `Cues` n'est écrit. Une piste `rawvideo` porte quelques octets
//! arbitraires — le test est de niveau CONTENEUR, la charge utile n'est jamais
//! décodée.

use openscreen_compositor::ffi::*;
use openscreen_compositor::remux::remux_to_seekable_matroska;
use std::ffi::CString;
use std::ptr;

/// ID EBML de `Cues` (0x1C53BB6B) et de `SeekHead` (0x114D9B74), en big-endian
/// tels qu'ils apparaissent tels quels dans les octets du fichier.
const CUES_ID: &[u8] = &[0x1C, 0x53, 0xBB, 0x6B];
const SEEKHEAD_ID: &[u8] = &[0x11, 0x4D, 0x9B, 0x74];

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Écrit un Matroska minimal SANS `Cues`, en forçant l'option `live` du muxer.
///
/// Retourne le nombre de paquets écrits, pour que le test puisse vérifier que le
/// remux les retrouve tous.
fn write_live_matroska(path: &str, packets: i64) -> i64 {
    let cpath = CString::new(path).unwrap();
    let cfmt = CString::new("matroska").unwrap();
    unsafe {
        let mut octx: *mut AVFormatContext = ptr::null_mut();
        assert!(
            avformat_alloc_output_context2(
                &mut octx,
                ptr::null(),
                cfmt.as_ptr(),
                cpath.as_ptr()
            ) >= 0,
            "alloc_output_context2"
        );

        let st = avformat_new_stream(octx, ptr::null());
        assert!(!st.is_null(), "avformat_new_stream");
        // VP8 : matroska le range en `V_VP8` sans jamais regarder la charge
        // utile (contrairement à H264, qui exige un `extradata` avcC valide, et
        // à RAWVIDEO, que le muxer refuse). Le test reste donc de niveau
        // conteneur, sans encodeur ni bitstream réel.
        (*(*st).codecpar).codec_type = AVMediaType::AVMEDIA_TYPE_VIDEO;
        (*(*st).codecpar).codec_id = AVCodecID::AV_CODEC_ID_VP8;
        (*(*st).codecpar).width = 16;
        (*(*st).codecpar).height = 16;
        // 1 ms par tick : les timestamps du test sont alors directement des ms.
        (*st).time_base = AVRational { num: 1, den: 1000 };

        let mut pb: *mut AVIOContext = ptr::null_mut();
        assert!(
            avio_open(&mut pb, cpath.as_ptr(), AVIO_FLAG_WRITE as i32) >= 0,
            "avio_open"
        );
        sn_fmt_set_pb(octx, pb);

        // `live=1` : le muxer se comporte comme s'il ne pouvait pas revenir en
        // arrière — pas de Cues. C'est la contrainte que subit MediaRecorder.
        let mut opts: *mut AVDictionary = ptr::null_mut();
        let k = CString::new("live").unwrap();
        let v = CString::new("1").unwrap();
        av_dict_set(&mut opts, k.as_ptr(), v.as_ptr(), 0);
        assert!(avformat_write_header(octx, &mut opts) >= 0, "write_header");
        av_dict_free(&mut opts);

        // Contenu arbitraire : jamais décodé, seul le conteneur est testé.
        let payload = vec![0x42u8; 256];
        let mut pkt = av_packet_alloc();
        for i in 0..packets {
            assert!(av_new_packet(pkt, payload.len() as i32) >= 0, "av_new_packet");
            ptr::copy_nonoverlapping(payload.as_ptr(), (*pkt).data, payload.len());
            (*pkt).stream_index = 0;
            (*pkt).pts = i * 40; // 25 fps en timebase 1/1000
            (*pkt).dts = i * 40;
            (*pkt).duration = 40;
            (*pkt).flags = AV_PKT_FLAG_KEY as i32;
            assert!(
                av_interleaved_write_frame(octx, pkt) >= 0,
                "interleaved_write_frame"
            );
        }
        av_packet_free(&mut pkt);
        assert!(av_write_trailer(octx) >= 0, "write_trailer");
        avio_closep(&mut pb);
        avformat_free_context(octx);
    }
    packets
}

#[test]
fn remux_adds_cues_to_a_live_matroska() {
    // `avformat_find_stream_info` tente de décoder la charge utile bidon pour
    // deviner les paramètres du flux et crache un « Invalid sync code » par
    // paquet. C'est attendu ici (et sans effet : les `codecpar` sont déjà
    // renseignés par le muxer d'entrée) ; on coupe le log pour que la sortie du
    // test reste lisible.
    unsafe { av_log_set_level(AV_LOG_QUIET) };

    let dir = std::env::temp_dir().join(format!("openscreen-remux-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("live.webm");
    let output = dir.join("indexed.webm");
    let input_s = input.to_str().unwrap().to_string();
    let output_s = output.to_str().unwrap().to_string();

    let written = write_live_matroska(&input_s, 25);

    // Prémisse du correctif : l'entrée n'a PAS d'index. Si cette assertion
    // tombe un jour, c'est le mode `live` du muxer qui a changé, et le test ne
    // prouve plus rien — mieux vaut qu'il échoue ici que silencieusement.
    let before = std::fs::read(&input).unwrap();
    assert!(
        !contains(&before, CUES_ID),
        "l'entrée de test ne doit pas avoir de Cues (mode live)"
    );

    let stats = remux_to_seekable_matroska(&input_s, &output_s).expect("remux");

    let after = std::fs::read(&output).unwrap();
    assert!(contains(&after, CUES_ID), "la sortie doit contenir des Cues");
    assert!(
        contains(&after, SEEKHEAD_ID),
        "la sortie doit contenir un SeekHead"
    );
    assert_eq!(stats.packets, written as u64, "tous les paquets recopiés");
    assert_eq!(stats.streams, 1);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn remux_refuses_to_write_over_its_own_input() {
    // Garde-fou : écrire sur l'entrée détruirait la seule copie des pixels dès
    // la première erreur d'écriture. Le contrat « passe un chemin temporaire »
    // est vérifié, pas seulement documenté.
    let err = remux_to_seekable_matroska("/tmp/same.webm", "/tmp/same.webm")
        .expect_err("doit refuser entrée == sortie");
    assert!(err.to_string().contains("identiques"), "message: {err}");
}

#[test]
fn remux_reports_an_error_for_a_missing_input() {
    // Le caller TS traite toute erreur comme « garde l'original » ; encore
    // faut-il qu'une entrée absente en produise une plutôt que de paniquer.
    let out = std::env::temp_dir().join("openscreen-remux-never-written.webm");
    let err = remux_to_seekable_matroska(
        "/nonexistent/openscreen/no-such-recording.webm",
        out.to_str().unwrap(),
    )
    .expect_err("doit échouer sur une entrée absente");
    assert!(err.to_string().contains("avformat_open_input"), "message: {err}");
}
