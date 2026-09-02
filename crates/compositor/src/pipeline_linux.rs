//! Pipeline Linux (PR #183) : decode software (`linux_decode::SwDecoder`) +
//! upload NV12-split (`linux_frames::CpuFrames`).
//!
//! Equivalent Linux de `pipeline_windows.rs` / `pipeline_macos.rs` : meme
//! surface publique consommee par le code partage (`Decoder`, `ClipSource`,
//! `ExportCodec`, `ExportParams`, `Stats`, `run_composited_multi`).
//!
//! **Export (WP6).** `run_composited_multi` encode + mux un MP4 **vidéo** :
//! encodeur SOFTWARE (`libopenh264` H264 / `libkvazaar` H265 -- les seuls du
//! build LGPL BtbN qui marchent sans device HW, VAAPI/Vulkan-encode = suivi),
//! la frame composée est relue en RGBA (ring de staging à 2, cf.
//! `Compositor::set_readback_depth`) puis convertie
//! YUV420P par `sws_scale`. La marche de timeline est PARTAGÉE
//! (`timeline_walk::walk_composited_timeline`) et le muxer passe par le shim C
//! `sn_fmt_set_pb` (comme Windows/macOS). **L'audio AAC n'est pas encore muxé**
//! (increment suivant : `audio.rs` + `AacEncoder` sont déjà partagés).
//!
//! **Le débit demandé n'est pas un contrat sur ce chemin.** `libopenh264` n'a pas
//! de contrôle de débit utilisable — la cause est en amont, pas ici, et elle est
//! documentée avec ce qui a été mesuré dans `VideoEncoder::tune_openh264`. À lire
//! avant de toucher au calcul de `bit_rate` ou d'ajouter une option d'encodage :
//! la moitié des réglages qui semblent évidents ont été essayés et ne font rien.

use anyhow::{bail, Result};
use std::collections::HashMap;
use std::ffi::CString;
use std::ptr;

use crate::audio::{
    assemble_concatenated_pcm, build_audio_concat_plan, finish_audio,
    AacEncoder, PlanarPcm,
};
use crate::audio_jobs::{decode_and_stretch_clip_audio, ClipAudioJobs};
use crate::config::Cfg;
use crate::d3d::Gpu;
use crate::ffi::AVFrame;
use crate::linux_decode::SwDecoder;
use crate::timeline_walk::NextFrameTime;
use crate::linux_frames::CpuFrames;

/// `SWS_POINT` (plus proche voisin). Bindgen ne genere pas les `SWS_*` (macros),
/// valeur figee par l'ABI de libswscale -- comme `linux_frames::SWS_POINT`.
const SWS_POINT: i32 = 0x10;

/// Bilan d'un run d'export. Memes champs que `pipeline_macos::Stats`.
pub struct Stats {
    pub frames: u64,
    pub wall_s: f64,
    pub fps: f64,
    pub video_duration_s: f64,
}

/// Un clip de la timeline. Memes champs que `pipeline_macos::ClipSource`.
pub struct ClipSource {
    pub screen: String,
    pub webcam: String,
    pub source_start_sec: f64,
    pub source_end_sec: f64,
    pub webcam_offset_sec: f64,
    pub has_audio: bool,
}

/// Codec cible. Memes variantes que `pipeline_macos::ExportCodec`.
#[derive(Clone, Copy, Debug)]
pub enum ExportCodec {
    H264,
    H265,
}

/// Params d'export. Memes champs que `pipeline_macos::ExportParams`.
pub struct ExportParams {
    pub width: u32,
    pub height: u32,
    pub fps: Option<u32>,
    pub codec: ExportCodec,
}

impl Default for ExportParams {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: None,
            codec: ExportCodec::H264,
        }
    }
}

/// Decodeur Linux : software decode (`SwDecoder`) + upload NV12-split
/// (`CpuFrames`). Meme surface que `pipeline_macos::Decoder`
/// (`open`/`seek_to`/`next`/`cur_frame`/`cur_time_sec`/`fps`) pour que `live.rs`
/// le pilote sans connaitre la plateforme.
pub struct Decoder {
    sw: SwDecoder,
    frames: CpuFrames,
    cur: *mut AVFrame,
    /// Index de la prochaine frame a decoder (sequentiel).
    next_idx: u32,
    fps: f64,
}

// SAFETY : les pointeurs FFI n'ont pas d'affinite thread ; le caller uphold la
// regle « un thread a la fois » (idem `pipeline_macos::Decoder`).
unsafe impl Send for Decoder {}

impl Decoder {
    pub fn open(path: &str, gpu: &Gpu) -> Result<Decoder> {
        let sw = SwDecoder::open(path)?;
        let fps = sw.fps();
        let frames = CpuFrames::new(gpu)?;
        Ok(Decoder {
            sw,
            frames,
            cur: ptr::null_mut(),
            next_idx: 0,
            fps,
        })
    }

    /// Decode la frame a `seconds` (seek), la presente en carrier, la retourne.
    pub unsafe fn seek_to(&mut self, seconds: f64) -> Result<*mut AVFrame> {
        let idx = (seconds.max(0.0) * self.fps).round() as u32;
        self.decode_present(idx)
    }

    /// Decode la frame SEQUENTIELLE suivante — pompage `next_frame`, PAS de seek.
    /// La frame rendue appartient au decodeur (valide jusqu'au prochain appel),
    /// donc elle ne se libere pas ici, contrairement au chemin `decode_at`.
    pub unsafe fn next(&mut self) -> Result<*mut AVFrame> {
        let raw = self.sw.next_frame()?;
        if raw.is_null() {
            self.cur = ptr::null_mut();
            return Ok(ptr::null_mut());
        }
        let carrier = self.frames.present(raw)?;
        self.cur = carrier;
        self.next_idx = self.next_idx.saturating_add(1);
        Ok(carrier)
    }

    unsafe fn decode_present(&mut self, idx: u32) -> Result<*mut AVFrame> {
        let raw = self.sw.decode_at(idx)?;
        let carrier = self.frames.present(raw)?;
        SwDecoder::free_frame(raw);
        self.cur = carrier;
        self.next_idx = idx + 1;
        Ok(carrier)
    }

    /// Décode la prochaine frame dans le buffer de lookahead du décodeur sous-jacent et
    /// renvoie son temps, sans la présenter (donc sans toucher `self.cur`).
    /// Cf. `pipeline_macos::Decoder::peek_next_time_sec` pour la sémantique "hold".
    pub(crate) unsafe fn peek_next_time_sec(&mut self) -> Result<NextFrameTime> {
        self.sw.peek_next_time_sec()
    }

    /// Promeut la frame de lookahead au rang de frame courante ET la présente (upload NV12
    /// vers la texture carrier), contrairement au chemin macOS/Windows où la promotion est
    /// un pur échange de pointeurs — ici la présentation est le pas qui manque.
    pub(crate) unsafe fn commit_peek(&mut self) -> Result<*mut AVFrame> {
        let raw = self.sw.commit_peek()?;
        let carrier = self.frames.present(raw)?;
        self.cur = carrier;
        self.next_idx = self.next_idx.saturating_add(1);
        Ok(carrier)
    }

    pub unsafe fn cur_frame(&self) -> *mut AVFrame {
        self.cur
    }

    /// Temps source (secondes) de la frame courante — pts REEL du decodeur, avec
    /// repli sur le compteur d'index si le flux ne porte pas de pts.
    pub unsafe fn cur_time_sec(&self) -> f64 {
        if let Some(t) = self.sw.cur_time_sec() {
            return t.max(0.0);
        }
        if self.next_idx == 0 || self.fps <= 0.0 {
            0.0
        } else {
            (self.next_idx as f64 - 1.0) / self.fps
        }
    }

    pub unsafe fn fps(&self) -> f64 {
        self.fps
    }

    /// Duree du flux (secondes). Pendant de
    /// `pipeline_macos::Decoder::available_duration_sec` ; consomme par
    /// `timeline_walk` pour borner la marche d'export.
    pub unsafe fn available_duration_sec(&self) -> Option<f64> {
        self.sw.duration_sec()
    }
}

/// Encodeur video SOFTWARE (`libopenh264` / `libkvazaar`). Pas de zero-copy HW
/// (VAAPI/Vulkan-encode = suivi) : la frame composee est relue RGBA par
/// l'appelant puis convertie YUV420P par `sws_scale`. Surface
/// `open`/`send_rgba`/`flush` alignee sur le chemin software de
/// `pipeline_macos::VideoEncoder`.
pub struct VideoEncoder {
    ctx: *mut crate::ffi::AVCodecContext,
    /// AVFrame YUV420P envoyee a l'encodeur.
    sw: *mut AVFrame,
    /// RGBA (sortie compositeur) -> YUV420P. Cree paresseusement (dims du readback).
    sws: *mut crate::ffi::SwsContext,
    w: i32,
    h: i32,
}

// SAFETY : pointeurs FFI sans affinite thread ; caller mono-thread (idem Decoder).
unsafe impl Send for VideoEncoder {}

impl VideoEncoder {
    /// Encodeurs software candidats du build LGPL, par codec. La premiere qui
    /// ouvre gagne ; `OPENSCREEN_EXPORT_ENCODER=<name>` force un choix.
    fn candidate_names(codec: &ExportCodec) -> &'static [&'static str] {
        match codec {
            ExportCodec::H264 => &["libopenh264"],
            ExportCodec::H265 => &["libkvazaar"],
        }
    }

    pub fn open(codec: &ExportCodec, w: i32, h: i32, fps: i32, bit_rate: i64) -> Result<VideoEncoder> {
        let forced = std::env::var("OPENSCREEN_EXPORT_ENCODER").ok();
        let mut refused: Vec<String> = Vec::new();
        // Liste par defaut, plus l'encodeur force s'il n'y figure pas (ex. h264_vaapi).
        let defaults = Self::candidate_names(codec);
        let extra: Vec<&str> = forced
            .as_deref()
            .filter(|f| !defaults.contains(f))
            .into_iter()
            .collect();
        for &name in defaults.iter().chain(extra.iter()) {
            if forced.as_deref().is_some_and(|f| f != name) {
                continue;
            }
            match unsafe { Self::try_open(name, w, h, fps, bit_rate) } {
                Ok(enc) => {
                    eprintln!("[pipeline] encodeur video : {name} (software YUV420P)");
                    return Ok(enc);
                }
                Err(e) => refused.push(format!("{name}: {e}")),
            }
        }
        match forced {
            Some(name) => bail!("OPENSCREEN_EXPORT_ENCODER={name} inutilisable : {}", refused.join(" ; ")),
            None => bail!("aucun encodeur video utilisable : {}", refused.join(" ; ")),
        }
    }

    unsafe fn try_open(name: &str, w: i32, h: i32, fps: i32, bit_rate: i64) -> Result<VideoEncoder> {
        use crate::ffi::*;
        let cname = CString::new(name)?;
        let enc = avcodec_find_encoder_by_name(cname.as_ptr());
        if enc.is_null() {
            bail!("absent de ce build ffmpeg");
        }
        let mut ctx = avcodec_alloc_context3(enc);
        if ctx.is_null() {
            bail!("avcodec_alloc_context3");
        }
        (*ctx).width = w;
        (*ctx).height = h;
        (*ctx).pix_fmt = AVPixelFormat::AV_PIX_FMT_YUV420P;
        (*ctx).time_base = AVRational { num: 1, den: fps };
        (*ctx).framerate = AVRational { num: fps, den: 1 };
        (*ctx).bit_rate = bit_rate;
        // Une image clé toutes les 2 s. SANS ce réglage le MP4 exporté n'en contient
        // qu'UNE SEULE : le wrapper ffmpeg de `libopenh264` pose `g = -1` dans ses
        // `FFCodecDefault`, et `try_open` ne touchait pas `gop_size`, donc openh264
        // recevait `uiIntraPeriod = 0` — mesuré 1 image I pour 300 frames. Le fichier
        // reste lisible mais tout seek doit redécoder depuis le début, et un paquet
        // abîmé emporte le reste de la vidéo. 2 s est le compromis usuel pour un
        // fichier de sortie ; mesuré sur un vrai enregistrement 1080p60 il coûte
        // +5,7 % de débit sur du contenu dense et +14,6 % sur un écran statique.
        // Le défaut générique d'`AVCodecContext` (12 frames, soit 0,2 s à 60 fps)
        // serait bien plus cher : on le pose donc explicitement pour tous les
        // encodeurs, pas seulement pour celui qui a le défaut cassé.
        (*ctx).gop_size = (fps * 2).max(1);
        Self::tune_openh264(ctx, name);
        // MP4 : header global dans l'extradata (pas par-paquet).
        (*ctx).flags |= AV_CODEC_FLAG_GLOBAL_HEADER as i32;
        if let Err(e) = averr(avcodec_open2(ctx, enc, ptr::null_mut()), "avcodec_open2(enc)") {
            avcodec_free_context(&mut ctx);
            return Err(e);
        }
        match alloc_sw_frame(AVPixelFormat::AV_PIX_FMT_YUV420P, w, h) {
            Ok(sw) => Ok(VideoEncoder { ctx, sw, sws: ptr::null_mut(), w, h }),
            Err(e) => {
                avcodec_free_context(&mut ctx);
                Err(e)
            }
        }
    }

    /// Réglages propres à `libopenh264`, à poser AVANT `avcodec_open2` (openh264 fige
    /// ses `SEncParamExt` à l'ouverture). No-op pour tout autre encodeur.
    ///
    /// **`libopenh264` n'a pas de contrôle de débit utilisable, et ce n'est pas
    /// réparable ici** (issue #572). Le wrapper ffmpeg laisse `bEnableFrameSkip = 0`,
    /// et openh264 le dit lui-même à l'ouverture :
    ///
    /// > `bEnableFrameSkip = 0, bitrate can't be controlled for RC_QUALITY_MODE,`
    /// > `RC_BITRATE_MODE and RC_TIMESTAMP_MODE without enabling skip frame.`
    ///
    /// La seule option qui rétablit un vrai plafond est `allow_skip_frames`, et elle
    /// le paie en frames jetées — mesuré 3 frames sur 120 conservées sur du contenu
    /// incompressible. Inacceptable pour un export, donc on n'y touche pas. Sont
    /// aussi des impasses vérifiées à la mesure : `rc_max_rate` et `rc_buffer_size`
    /// (que ce wrapper ne lit pas, ou dont openh264 ne se sert que dans le chemin
    /// frame-skip), `rc_mode`, `max_nal_size` et `level`.
    ///
    /// Restent deux réglages qui, eux, se mesurent :
    ///
    /// 1. **Ouvrir la fenêtre de QP.** Le wrapper ne transmet `iMinQp`/`iMaxQp` que
    ///    si `qmin`/`qmax` sont >= 0, et ses `FFCodecDefault` les posent à -1.
    ///    openh264 part alors sur ses propres défauts (0, 51) — puis sa
    ///    `ParamValidation()` juge `iMinQp = 0` invalide et REMPLACE toute la fenêtre
    ///    par (12, 42) (`GOM_MIN_QP_MODE`, `MAX_LOW_BR_QP`). Un `qmin` >= 1 évite la
    ///    substitution et rend le QP 51 atteignable. La borne basse, elle, reste
    ///    clampée à 12 quoi qu'on demande, donc `qmin = 1` ne fait qu'éviter le piège.
    ///
    ///    L'intérêt premier est de ne plus subir une fenêtre qu'on n'a pas choisie :
    ///    (12, 42) n'est pas une décision, c'est ce qu'openh264 substitue en silence.
    ///
    ///    Sur les quatre classes de contenu réel essayées, le changement est INERTE —
    ///    sortie identique à l'octet sur un écran statique, sur une capture dense, sur
    ///    du mixte (UI + fenêtre vidéo sur un tiers de l'image) et sur de la webcam
    ///    plein cadre. Sur ces mêmes clips le débit demandé est d'ailleurs plutôt bien
    ///    suivi (mixte 1080p30 : 1 -> 0,98, 2 -> 1,94, 4 -> 3,67 Mbps ; webcam :
    ///    2 -> 1,99, 8 -> 7,51), ce qui vaut d'être su avant de conclure du titre de
    ///    #572 que l'export Linux serait à l'abandon.
    ///
    ///    La fenêtre ne mord que sur du contenu que l'encodeur ne sait pas comprimer,
    ///    et là elle échange de la qualité contre de la taille : sur 120 frames de
    ///    bruit incompressible 720p30 à 2 Mbps demandés, 113,2 -> 65,5 Mbps mais
    ///    SSIM 0,949 -> 0,652. C'est le bon sens de l'échange pour un export (le
    ///    fichier restait 56x au-dessus de la cible), mais si on le regrettait,
    ///    `qmin = 12 ; qmax = 42` fige exactement le comportement d'avant tout en
    ///    gardant le réglage explicite.
    /// 2. **Profil High.** Par défaut ce wrapper produit du Constrained Baseline en
    ///    CAVLC (`profile_idc = 66`, `entropy_coding_mode_flag = 0`). Le profil High
    ///    active CABAC. Mesuré à qualité égale sur un vrai enregistrement 1080p60
    ///    (VMAF 96,2 dans les deux cas) : -3,8 % de débit sur du contenu dense,
    ///    -8,0 % sur un écran statique.
    ///
    /// Ce qu'il reste de cassé après ça, et qui ne se règle pas depuis l'application :
    /// le débit demandé n'est qu'une entrée faible d'un modèle complexité -> QP, borné
    /// à [12, 51]. Sur un écran statique l'encodeur se colle à QP 12 et ne dépense pas
    /// plus, quel que soit le `bit_rate` (mesuré 0,68 Mbps pour 8 comme pour 40 Mbps
    /// demandés) ; sur du contenu qu'il ne sait pas comprimer il dépasse la cible sans
    /// borne. Le mode `SCREEN_CONTENT_REAL_TIME` d'openh264 — celui qui conviendrait à
    /// un enregistreur d'écran — n'est atteignable par aucune option ffmpeg.
    /// Suivi en amont : cisco/openh264#3259 (fermé sans correctif).
    unsafe fn tune_openh264(ctx: *mut crate::ffi::AVCodecContext, name: &str) {
        use crate::ffi::*;
        if name != "libopenh264" {
            return;
        }
        (*ctx).qmin = 1;
        (*ctx).qmax = 51;
        // L'encodeur expose AUSSI `profile` en option privée, mais le wrapper lit
        // `avctx->profile` quand la privée vaut `AV_PROFILE_UNKNOWN` (son défaut,
        // -99). Les deux chemins produisent le même SPS — vérifié, `profile_idc`
        // passe à 100 dans les deux cas — donc on prend le champ : il est typé,
        // vérifié à la compilation, et n'a pas besoin d'une `CString` ni d'une
        // branche d'erreur, contrairement à `av_opt_set` sur `priv_data`.
        (*ctx).profile = AV_PROFILE_H264_HIGH as i32;
    }

    /// Envoie une frame composee DEJA RELUE (RGBA) a l'encodeur, en YUV420P.
    ///
    /// La relecture est sortie d'ici : avec la ring de staging, la frame rendue
    /// par `readback_submit` n'est pas celle qui vient d'etre composee mais la
    /// precedente, donc l'appelant doit apparier lui-meme la frame et son pts
    /// (cf. `run_composited_multi`).
    pub unsafe fn send_rgba(&mut self, rgba: &[u8], rw: i32, rh: i32, pts: i64) -> Result<()> {
        use crate::ffi::*;
        if self.sws.is_null() {
            self.sws = sws_getContext(
                rw,
                rh,
                AVPixelFormat::AV_PIX_FMT_RGBA,
                self.w,
                self.h,
                AVPixelFormat::AV_PIX_FMT_YUV420P,
                // POINT : le compositeur est dimensionne a la sortie -> pas de
                // mise a l'echelle, donc echantillonnage exact (cf. mac_frames).
                SWS_POINT,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            );
            if self.sws.is_null() {
                bail!("sws_getContext {rw}x{rh} RGBA -> {}x{} YUV420P", self.w, self.h);
            }
        }
        averr(av_frame_make_writable(self.sw), "make_writable")?;
        // RGBA est un plan unique : data[0] + stride rw*4, les autres nuls.
        let src_data: [*const u8; 4] = [rgba.as_ptr(), ptr::null(), ptr::null(), ptr::null()];
        let src_stride: [i32; 4] = [rw * 4, 0, 0, 0];
        let converted = sws_scale(
            self.sws,
            src_data.as_ptr(),
            src_stride.as_ptr(),
            0,
            rh,
            (*self.sw).data.as_ptr() as *const *mut u8,
            (*self.sw).linesize.as_ptr(),
        );
        if converted <= 0 {
            bail!("sws_scale RGBA->YUV420P : {converted} lignes");
        }
        (*self.sw).pts = pts;
        averr(avcodec_send_frame(self.ctx, self.sw), "send_frame")
    }

    /// Envoie une frame deja en YUV420P, convertie par le GPU.
    ///
    /// Recopie le buffer relu dans une AVFrame du pool. Les deux ont la MEME
    /// disposition (`alloc_padded_yuv_frame`), donc c'est un seul bloc contigu :
    /// pas de reformatage, juste un transfert hors de la memoire mappee avant que
    /// la ring ne recycle le slot.
    ///
    /// C'EST UNE COPIE, ET ELLE RESTE. La supprimer voudrait dire encoder
    /// directement depuis le buffer de staging, donc le maintenir mappe pendant
    /// que le worker travaille, a travers une frontiere de thread. Le gain est le
    /// meme ~0,30 ms/frame que ce memcpy coute deja ; le prix serait un slot wgpu
    /// dont la duree de vie depend de l'encodeur. Pas le bon echange tant que ce
    /// n'est pas ce thread-ci le goulot.
    pub unsafe fn copy_into(
        dst_frame: *mut AVFrame,
        planes: &[u8],
        rw: i32,
        rh: i32,
        enc_w: i32,
        enc_h: i32,
    ) -> Result<()> {
        // Les DEUX bornes comptent. La verification de taille seule laisserait
        // passer un buffer assez gros mais de mauvaise geometrie : la disposition
        // serait recalculee depuis rw/rh et l'image sortirait silencieusement
        // decalee, bien plus difficile a diagnostiquer qu'un echec franc.
        if rw != enc_w || rh != enc_h {
            bail!("copy_into {rw}x{rh} != encodeur {enc_w}x{enc_h}");
        }
        let lay = YuvLayout::for_size(rw, rh);
        if planes.len() < lay.total {
            bail!("plans YUV tronques : {} octets pour {}", planes.len(), lay.total);
        }
        // REND LA FRAME ECRIVABLE AVANT DE LA REECRIRE. `avcodec_send_frame`
        // prend une reference sur le buffer ; un encodeur qui garde la frame —
        // parce qu'il a du delai, ou parce que `OPENSCREEN_EXPORT_ENCODER` en a
        // choisi un autre — la tiendrait encore quand le pool la recycle, et on
        // ecrirait dans une image en cours d'encodage.
        //
        // J'avais retire cet appel en le jugeant inutile : avec `libopenh264` le
        // refcount EST retombe a 1 au retour, mesure. Mais c'est une propriete de
        // CET encodeur-la, pas du pool, et rien dans le code ne la maintenait.
        // Ici l'appel est gratuit quand elle tient (refcount 1 = no-op) et
        // correct quand elle ne tient pas. Le buffer ne porte pas
        // `AV_BUFFER_FLAG_READONLY`, donc pas de branche recopie a redouter.
        crate::ffi::averr(crate::ffi::av_frame_make_writable(dst_frame), "make_writable")?;
        debug_assert_eq!((*dst_frame).linesize[0] as usize, lay.bpr_y);
        debug_assert_eq!((*dst_frame).linesize[1] as usize, lay.bpr_uv);
        std::ptr::copy_nonoverlapping(planes.as_ptr(), (*dst_frame).data[0], lay.total);
        Ok(())
    }

    /// Flush : une frame nulle finalise le bitstream de l'encodeur.
    pub unsafe fn flush(&mut self) -> Result<()> {
        crate::ffi::averr(
            crate::ffi::avcodec_send_frame(self.ctx, ptr::null_mut()),
            "send_frame_flush",
        )
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        unsafe {
            crate::ffi::avcodec_free_context(&mut self.ctx);
            if !self.sw.is_null() {
                crate::ffi::av_frame_free(&mut self.sw);
            }
            if !self.sws.is_null() {
                crate::ffi::sws_freeContext(self.sws);
            }
        }
    }
}

/// Alloue une AVFrame systeme au format demande. Symetrique de
/// `pipeline_macos::alloc_sw_frame`.
unsafe fn alloc_sw_frame(pix_fmt: crate::ffi::AVPixelFormat::Type, w: i32, h: i32) -> Result<*mut AVFrame> {
    let mut frame = crate::ffi::av_frame_alloc();
    if frame.is_null() {
        bail!("av_frame_alloc (encodeur)");
    }
    (*frame).format = pix_fmt as i32;
    (*frame).width = w;
    (*frame).height = h;
    if crate::ffi::av_frame_get_buffer(frame, 32) < 0 {
        crate::ffi::av_frame_free(&mut frame);
        bail!("av_frame_get_buffer {w}x{h} pix_fmt={pix_fmt}");
    }
    Ok(frame)
}

/// Geometrie du buffer relu : strides alignes a 256 (ce que
/// `copy_texture_to_buffer` impose) et offsets des trois plans dans l'allocation
/// unique. Calculee a UN SEUL endroit, parce que le producteur (le compositeur)
/// et le consommateur (l'AVFrame du pool) doivent s'accorder a l'octet pres.
#[derive(Clone, Copy)]
struct YuvLayout {
    bpr_y: usize,
    bpr_uv: usize,
    off_u: usize,
    off_v: usize,
    total: usize,
}

impl YuvLayout {
    /// DERIVE de `Compositor::yuv_layout_for`, jamais recalculee. Cette
    /// arithmetique existait ici en double, et c'est precisement le genre de
    /// duplication qui ne casse rien tant qu'elle est identique : le producteur
    /// (le compositeur, qui remplit le buffer) et le consommateur (l'AVFrame du
    /// pool) doivent s'accorder A L'OCTET, et un ecart ne donnerait pas une
    /// panne mais une image decalee.
    fn for_size(w: i32, h: i32) -> YuvLayout {
        let (bpr_y, bpr_uv, off_u, total) = crate::compositor::Compositor::yuv_layout_for(
            w.max(0) as u32,
            h.max(0) as u32,
            crate::compositor::YuvFormat::I420,
        );
        let ch = (h.max(0) as u64).div_ceil(2);
        let size_uv = u64::from(bpr_uv) * ch;
        YuvLayout {
            bpr_y: bpr_y as usize,
            bpr_uv: bpr_uv as usize,
            off_u: off_u as usize,
            off_v: (off_u + size_uv) as usize,
            total: total as usize,
        }
    }
}

/// Alloue une AVFrame YUV420P dont les `linesize` sont EXACTEMENT les strides du
/// buffer relu, et dont les trois plans se suivent dans une seule allocation,
/// dans le meme ordre.
///
/// POURQUOI PAS `av_frame_get_buffer`. Il choisit ses propres strides — 1920 et
/// 960 en 1080p — la ou le GPU impose 2048 et 1024. Recopier de l'un vers
/// l'autre demandait 3240 petits memcpy decales par frame (~0,67 ms) ; avec une
/// disposition identique des deux cotes, la meme donnee se recopie d'un seul
/// bloc contigu (~0,30 ms). libopenh264 lit `linesize[i]` et `data[i]` tels
/// quels et se moque qu'un plan soit sur-stride.
///
/// LA FRAME RESTE REFCOMPTEE (`av_buffer_alloc`). Sans `buf[0]`, `av_frame_ref`
/// a l'interieur d'`avcodec_send_frame` prend la branche « donnee non
/// refcomptee » et REFAIT une allocation plus une copie complete — a l'interieur
/// de l'encodeur, donc precisement la ou on ne penserait pas a la chercher.
unsafe fn alloc_padded_yuv_frame(w: i32, h: i32) -> Result<*mut AVFrame> {
    let lay = YuvLayout::for_size(w, h);
    let mut frame = crate::ffi::av_frame_alloc();
    if frame.is_null() {
        bail!("av_frame_alloc (pool)");
    }
    (*frame).format = crate::ffi::AVPixelFormat::AV_PIX_FMT_YUV420P as i32;
    (*frame).width = w;
    (*frame).height = h;
    let buf = crate::ffi::av_buffer_alloc(lay.total);
    if buf.is_null() {
        crate::ffi::av_frame_free(&mut frame);
        bail!("av_buffer_alloc {} octets", lay.total);
    }
    let base = (*buf).data;
    (*frame).buf[0] = buf;
    (*frame).data[0] = base;
    (*frame).data[1] = base.add(lay.off_u);
    (*frame).data[2] = base.add(lay.off_v);
    (*frame).linesize[0] = lay.bpr_y as i32;
    (*frame).linesize[1] = lay.bpr_uv as i32;
    (*frame).linesize[2] = lay.bpr_uv as i32;
    Ok(frame)
}

/// Etat du muxer MP4, deplacable en bloc sur le thread d'encodage.
///
/// POURQUOI UN SEUL TYPE PLUTOT QUE QUATRE VARIABLES. `av_interleaved_write_frame`
/// touche `octx`, la piste video `ostream` et le paquet de travail `opkt` ; et
/// `AacEncoder` garde un `*mut AVStream` qui pointe DANS la table de flux de
/// `octx` (audio.rs). Les separer laisserait un pointeur vers l'interieur d'un
/// objet possede par un autre thread. Ils partent donc ensemble, ou pas du tout.
struct Muxer {
    octx: *mut crate::ffi::AVFormatContext,
    pb: *mut crate::ffi::AVIOContext,
    ostream: *mut crate::ffi::AVStream,
    opkt: *mut crate::ffi::AVPacket,
    aac: AacEncoder,
}

// SAFETY : aucun de ces pointeurs n'a d'affinite de thread. Le muxer est DEPLACE
// vers le worker puis rendu au thread appelant par le `join` ; il n'est jamais
// partage, d'ou `Send` sans `Sync`.
unsafe impl Send for Muxer {}

impl Muxer {
    /// Draine les paquets de l'encodeur vers le fichier. Symetrique de
    /// `pipeline_macos::drain_encoder`.
    unsafe fn drain(&mut self, ectx: *mut crate::ffi::AVCodecContext) -> Result<()> {
        use crate::ffi::*;
        loop {
            let r = avcodec_receive_packet(ectx, self.opkt);
            if r == AVERROR_EOF || r == AVERROR_EAGAIN {
                return Ok(());
            }
            averr(r, "receive_packet")?;
            av_packet_rescale_ts(self.opkt, (*ectx).time_base, (*self.ostream).time_base);
            averr(
                av_interleaved_write_frame(self.octx, self.opkt),
                "interleaved_write_frame",
            )?;
            av_packet_unref(self.opkt);
        }
    }

    /// Ferme le conteneur. La liberation, elle, est dans `Drop` : un `?` entre
    /// l'ouverture et ici ne doit pas fuir le contexte ni le fichier.
    unsafe fn finish(&mut self) -> Result<()> {
        crate::ffi::averr(crate::ffi::av_write_trailer(self.octx), "write_trailer")
    }
}

impl Drop for Muxer {
    fn drop(&mut self) {
        unsafe {
            crate::ffi::avio_closep(&mut self.pb);
            crate::ffi::avformat_free_context(self.octx);
            crate::ffi::av_packet_free(&mut self.opkt);
        }
    }
}

/// Une frame remplie, en route vers l'encodeur.
struct EncJob {
    frame: *mut AVFrame,
    pts: i64,
}
// SAFETY : la frame appartient au pool et n'est touchee que par UN thread a la
// fois — le passage par le canal est le transfert de propriete.
unsafe impl Send for EncJob {}

/// Une frame vidée que le worker rend au pool.
struct FreeFrame(*mut AVFrame);
// SAFETY : idem `EncJob`, dans l'autre sens.
unsafe impl Send for FreeFrame {}

/// Encodeur + muxer deportes sur leur propre thread.
///
/// POURQUOI. L'export tenait sur UN thread : decodage, composition, relecture,
/// de-padding puis encodage a la queue leu leu, pendant que sept coeurs ne
/// faisaient rien. `avcodec_send_frame` pese a lui seul 29,5 s des ~57 s d'un
/// export de 3600 frames ; le sortir du chemin critique laisse la marche de
/// timeline avancer pendant que l'encodeur travaille la frame precedente.
///
/// LE POOL BORNE LA MEMOIRE, PAS UN CANAL. Le thread de marche va plus vite que
/// l'encodeur : une file non bornee finirait par contenir les 3600 frames, soit
/// ~11,2 Go. Ici il existe EXACTEMENT `depth` AVFrames, qui tournent entre le
/// canal `empty` et le canal `full`. Le depassement n'est pas evite, il est
/// inexprimable — et `empty_rx.recv()` est le seul point ou la marche attend
/// l'encodeur, donc le seul endroit a instrumenter si le debit deçoit.
///
/// LE DE-PADDING RESTE COTE MARCHE. Recopier les plans depuis le buffer relu
/// (lignes alignees a 256) vers l'AVFrame coute ~0,67 ms par frame. Le mettre
/// ici le poserait sur le thread qui est desormais le goulot ; le laisser sur la
/// marche, qui a du mou, ne coute rien. Meme raison pour laquelle il ne sert a
/// rien de donner la memoire mappee du GPU directement a l'encodeur : ca
/// supprimerait cette copie sans deplacer le goulot, en echange d'un slot de
/// staging maintenu mappe a travers une frontiere de thread.
struct EncodeWorker {
    full_tx: Option<std::sync::mpsc::Sender<EncJob>>,
    empty_rx: std::sync::mpsc::Receiver<FreeFrame>,
    /// Frame empruntee mais finalement pas remplie — l'amorcage de la ring de
    /// relecture ne produit rien les premiers tours — gardee ici pour le tour
    /// suivant. `null` quand il n'y en a pas.
    ///
    /// POURQUOI PAS UN CLONE DU `Sender`. C'etait la premiere version, et elle
    /// interdisait de detecter la mort du worker : tant que `EncodeWorker`
    /// gardait un emetteur vivant, `empty_rx.recv()` ne pouvait JAMAIS rendre
    /// `Err`, donc un worker qui panique laissait la marche bloquee pour
    /// toujours sur `take_free` — `finish` n'etait jamais atteint. Le canal ne
    /// doit avoir qu'un seul emetteur, celui du worker, pour que sa disparition
    /// soit observable.
    spare: std::cell::Cell<*mut AVFrame>,
    handle: Option<std::thread::JoinHandle<Result<Muxer>>>,
    /// Premiere erreur rencontree par le worker. La marche la relit a chaque
    /// frame : sans ca, un encodeur mort a la frame 12 laisserait composer les
    /// 3588 suivantes avant que quiconque s'en apercoive.
    fatal: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

impl EncodeWorker {
    /// Demarre le thread et alloue le pool. `enc` et `mux` lui appartiennent
    /// jusqu'au `finish`.
    fn spawn(mut enc: VideoEncoder, mut mux: Muxer, depth: usize) -> Result<EncodeWorker> {
        let (full_tx, full_rx) = std::sync::mpsc::channel::<EncJob>();
        let (empty_tx, empty_rx) = std::sync::mpsc::channel::<FreeFrame>();
        for _ in 0..depth.max(2) {
            let f = unsafe { alloc_padded_yuv_frame(enc.w, enc.h)? };
            empty_tx
                .send(FreeFrame(f))
                .map_err(|_| anyhow::anyhow!("pool d'encodage: canal ferme a l'amorcage"))?;
        }
        let fatal = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        let fatal_worker = std::sync::Arc::clone(&fatal);
        let handle = std::thread::Builder::new()
            .name("openscreen-encode".into())
            .spawn(move || -> Result<Muxer> {
                while let Ok(job) = full_rx.recv() {
                    let r = unsafe {
                        (*job.frame).pts = job.pts;
                        crate::ffi::averr(
                            crate::ffi::avcodec_send_frame(enc.ctx, job.frame),
                            "send_frame",
                        )
                        .and_then(|()| mux.drain(enc.ctx))
                    };
                    // La frame retourne au pool DANS TOUS LES CAS : la garder
                    // sur une erreur bloquerait la marche sur `empty_rx.recv()`
                    // au lieu de lui laisser voir `fatal`.
                    let _ = empty_tx.send(FreeFrame(job.frame));
                    if let Err(e) = r {
                        *fatal_worker.lock().unwrap() = Some(format!("{e:#}"));
                        return Err(e);
                    }
                }
                // Canal ferme = plus aucune frame ne viendra : on vide
                // l'encodeur ici, pendant qu'il nous appartient encore.
                unsafe {
                    enc.flush()?;
                    mux.drain(enc.ctx)?;
                }
                Ok(mux)
            })?;
        Ok(EncodeWorker {
            full_tx: Some(full_tx),
            empty_rx,
            spare: std::cell::Cell::new(std::ptr::null_mut()),
            handle: Some(handle),
            fatal,
        })
    }

    /// Garde une frame empruntee sans avoir ete remplie, pour le tour suivant.
    fn give_back(&self, frame: *mut AVFrame) {
        let prev = self.spare.replace(frame);
        debug_assert!(prev.is_null(), "give_back deux fois sans take_free");
    }

    /// Emprunte une frame libre au pool. C'est ICI que la marche attend quand
    /// l'encodeur prend du retard.
    fn take_free(&self) -> Result<*mut AVFrame> {
        let spare = self.spare.replace(std::ptr::null_mut());
        if !spare.is_null() {
            return Ok(spare);
        }
        match self.empty_rx.recv() {
            Ok(FreeFrame(f)) => Ok(f),
            Err(_) => Err(self.fatal_error("le thread d'encodage s'est arrete")),
        }
    }

    fn submit(&self, frame: *mut AVFrame, pts: i64) -> Result<()> {
        match self.full_tx.as_ref() {
            Some(tx) => tx
                .send(EncJob { frame, pts })
                .map_err(|_| self.fatal_error("le thread d'encodage s'est arrete")),
            None => Err(anyhow::anyhow!("submit apres finish")),
        }
    }

    /// Prefere l'erreur reelle du worker au symptome (« canal ferme »).
    fn fatal_error(&self, fallback: &str) -> anyhow::Error {
        match self.fatal.lock().unwrap().clone() {
            Some(e) => anyhow::anyhow!("encodage: {e}"),
            None => anyhow::anyhow!("{fallback}"),
        }
    }

    /// Ferme la file, attend le worker et RECUPERE le muxer : le `join` est
    /// l'arete de synchronisation qui rend `octx` utilisable ici pour l'audio et
    /// le trailer.
    fn finish(&mut self) -> Result<Muxer> {
        drop(self.full_tx.take());
        let handle = self
            .handle
            .take()
            .ok_or_else(|| anyhow::anyhow!("finish appele deux fois"))?;
        match handle.join() {
            Ok(r) => r,
            // Un panic du worker ne passe pas par `fatal` : le relayer en erreur
            // plutot que de le repropager sur le thread de marche.
            Err(_) => Err(self.fatal_error("le thread d'encodage a panique")),
        }
    }
}

impl Drop for EncodeWorker {
    fn drop(&mut self) {
        // Chemin d'abandon (un `?` ailleurs) : fermer la file debloque le worker,
        // et le join evite de liberer le pool sous ses pieds.
        drop(self.full_tx.take());
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        let mut spare = self.spare.replace(std::ptr::null_mut());
        if !spare.is_null() {
            unsafe { crate::ffi::av_frame_free(&mut spare) };
        }
        while let Ok(FreeFrame(f)) = self.empty_rx.try_recv() {
            let mut f = f;
            unsafe { crate::ffi::av_frame_free(&mut f) };
        }
    }
}

/// Export multiclip VIDEO (WP6). Encode software + mux MP4. Audio AAC = suivi
/// (`audio.rs`/`AacEncoder` partages, il ne manque que le branchement du 2e flux
/// + l'assemblage PCM par clip, cf. `pipeline_macos::run_composited_multi`).
///
/// La marche de timeline est PARTAGEE (`walk_composited_timeline`) : elle compose
/// chaque frame de sortie (vitesse/fenetrage/curseur inclus) puis appelle
/// `on_frame(n)`, ou on relit + encode + draine.

/// Fin de marche du chemin SOFTWARE : vider la ring de relecture, puis rendre au
/// compositeur sa profondeur par defaut.
///
/// Le drain doit avoir lieu AVANT de fermer la file : les `depth - 1` dernieres
/// copies sont encore en vol, et sans lui la derniere frame composee ne serait
/// jamais encodee — video amputee d'une frame.
fn hw_none_tail(
    comp: &crate::compositor::Compositor,
    worker: &mut EncodeWorker,
    out_w: u32,
    out_h: u32,
    encoded_pts: &mut i64,
) -> Result<()> {
    unsafe {
        loop {
            let frame = worker.take_free()?;
            let mut filled = false;
            let got = comp.readback_take_yuv_with(|rw, rh, planes| {
                VideoEncoder::copy_into(frame, planes, rw as i32, rh as i32, out_w as i32, out_h as i32)?;
                filled = true;
                Ok(())
            })?;
            if filled {
                worker.submit(frame, *encoded_pts)?;
                *encoded_pts += 1;
            } else {
                worker.give_back(frame);
            }
            if !got {
                break;
            }
        }
        // Le compositeur peut survivre a l'export (l'appelant le possede) : on lui
        // rend sa profondeur par defaut plutot que de lui laisser une ring a 2 et
        // le buffer qui va avec.
        comp.set_readback_yuv_depth(1)?;
    }
    Ok(())
}

/// Ou partent les frames composees. Voir le commentaire au point de choix.
enum Sink {
    /// Encodage software, deporte sur un thread.
    Software(Box<EncodeWorker>),
    /// Encodage materiel depuis un dmabuf, sur place.
    ///
    /// PLUSIEURS TAMPONS, PAS UN. Avec un seul, composer et encoder se
    /// serialisent : le GPU compose, on l'attend, on encode, et rien ne se
    /// recouvre. Deux tampons suffisent a decaler d'une frame — on compose la
    /// n pendant que la n-1 s'encode — et c'est le meme raisonnement que la
    /// profondeur 2 de la ring de relecture software.
    Hardware {
        enc: VaapiEncoder,
        mux: Muxer,
        staging: Vec<crate::compositor::ExportableStaging>,
        /// Frame soumise mais pas encore encodee : (slot, soumission, pts).
        pending: Option<(usize, wgpu::SubmissionIndex, i64)>,
        /// Frame mappee remise a l'encodeur pour le slot precedent, gardee VIVANTE
        /// tant qu'il peut la lire. `(slot, frame)`.
        in_flight: Option<(usize, *mut AVFrame)>,
        next: usize,
    },
}

impl Sink {
    /// Le worker software. Ne doit etre appele qu'apres avoir ecarte le cas
    /// materiel — le chemin materiel n'en a pas.
    fn worker(&mut self) -> &mut EncodeWorker {
        match self {
            Sink::Software(w) => w,
            Sink::Hardware { .. } => unreachable!("worker() sur le chemin materiel"),
        }
    }
}

pub fn run_composited_multi(
    clips: &[ClipSource],
    out: &str,
    gpu: &Gpu,
    comp: &crate::compositor::Compositor,
    cfg: &Cfg,
    params: &ExportParams,
    progress: &mut dyn FnMut(u64),
) -> Result<Stats> {
    if clips.is_empty() {
        bail!("run_composited_multi: aucun clip a exporter");
    }
    let (out_w, out_h) = (params.width, params.height);
    let out_fps = params.fps.unwrap_or(30) as i32;
    // bitrate proportionnel a la surface (reference : 8 Mbps @ 1920x1080). Formule
    // IDENTIQUE a celle de `pipeline_macos.rs` et `pipeline_windows.rs` : la garder
    // alignee est ce qui fait que les trois plateformes exportent au meme poids.
    //
    // Sur `libopenh264` ce nombre n'est qu'indicatif : c'est une entree d'un modele
    // complexite -> QP, pas un contrat. Il agit comme un plafond APPROXIMATIF sur du
    // contenu dense (mesure sur un vrai enregistrement 1080p60 : 1 Mbps demande ->
    // 0,97 produit, 2 -> 1,72, 4 -> 2,86, 8 -> 3,85) et n'a aucun effet sur un ecran
    // statique, ou l'encodeur sature son plancher de QP. Voir
    // `VideoEncoder::tune_openh264` pour le pourquoi et ce qui a ete tente.
    let bit_rate = ((out_w as i64 * out_h as i64 * 8_000_000) / (1920 * 1080)).max(2_000_000);
    let t0 = std::time::Instant::now();

    // L'ENCODEUR SE CHOISIT AVANT LE MUXER, parce que c'est lui qui decrit le
    // flux video. `h264_vaapi` s'il s'ouvre et que le compositeur sait exporter
    // sa memoire ; sinon l'encodeur software, inchange.
    //
    // Le repli couvre plus que l'absence de GPU : pas de `/dev/dri/renderD128`,
    // un pilote sans VAAPI, un device wgpu ouvert sans les extensions de memoire
    // externe. Aucun de ces cas n'est une erreur — l'export doit juste rester
    // celui d'avant.
    // L'ECHAPPATOIRE DOIT AUSSI COUVRIR CE CHOIX. `OPENSCREEN_EXPORT_ENCODER`
    // existe pour forcer un encodeur ; si le chemin materiel l'ignorait, demander
    // `libopenh264` donnerait quand meme du VAAPI — et le reglage servirait
    // surtout a diagnostiquer, donc mentir ici est pire qu'ailleurs.
    let forced = std::env::var("OPENSCREEN_EXPORT_ENCODER").ok();
    let hw_allowed = match forced.as_deref() {
        None => true,
        Some(name) => name.contains("vaapi"),
    };
    let hw = if hw_allowed && matches!(params.codec, ExportCodec::H264) {
        unsafe { VaapiEncoder::open(out_w as i32, out_h as i32, out_fps, bit_rate) }
            .and_then(|v| {
                // PLUS DE TAMPONS QUE L'ENCODEUR N'A DE LATENCE. Deux suffisaient
                // pour recouvrir composition et encodage, mais pas pour la
                // question de propriete : `h264_vaapi` garde plusieurs frames
                // avant d'emettre le premier paquet, donc a deux tampons on
                // revenait sur le slot 0 alors que la surface qui le mappe etait
                // encore detenue. Le garde-fou de `frame_released` le prouve —
                // avec deux, il declenche des la premiere boucle.
                //
                // Six, pas deux : c'est au-dessus de la latence observee, ca
                // coute 6 x 3,3 Mo, et le garde-fou reste en place pour le cas ou
                // un pilote irait plus loin.
                let total = comp.nv12_geometry().3;
                let mut v_st = Vec::new();
                for _ in 0..6 {
                    v_st.push(comp.create_exportable_staging(total)?);
                }
                Some((v, v_st))
            })
    } else {
        None
    };
    // N'OUVRE PAS L'ENCODEUR SOFTWARE SI LE MATERIEL A GAGNE. Il etait construit
    // dans tous les cas, donc alloue puis jamais utilise — visible par deux
    // lignes « encodeur video » dans le log, et par un AVFrame de 3,1 Mo qui ne
    // sert a rien.
    let enc = match &hw {
        Some(_) => None,
        None => Some(VideoEncoder::open(
            &params.codec,
            out_w as i32,
            out_h as i32,
            out_fps,
            bit_rate,
        )?),
    };
    // ALIAS LU UNIQUEMENT AVANT LE DEMARRAGE DU WORKER. Il ne sert qu'a decrire
    // le flux au muxer, juste en dessous ; passe `EncodeWorker::spawn`, le
    // contexte appartient au thread d'encodage et cette variable ne doit plus
    // etre touchee. S'en resservir apres serait un `Sync` officieux :
    // `VideoEncoder` est `Send` et volontairement pas `Sync`, et un
    // `*mut AVCodecContext` recopie efface exactement cette distinction.
    let ectx = match (&hw, &enc) {
        (Some((v, _)), _) => v.ctx(),
        (None, Some(e)) => e.ctx,
        (None, None) => bail!("aucun encodeur video disponible"),
    };
    eprintln!(
        "[pipeline] encodeur video : {}",
        if hw.is_some() { "h264_vaapi (materiel, dmabuf)" } else { "software" }
    );

    let mut screen_decs: HashMap<String, Decoder> = HashMap::new();
    let mut webcam_decs: HashMap<String, Decoder> = HashMap::new();

    // ---- muxer MP4 (flux video + flux AAC) ----
    let outc = CString::new(out)?;
    let mut octx: *mut crate::ffi::AVFormatContext = ptr::null_mut();
    let mut pb: *mut crate::ffi::AVIOContext = ptr::null_mut();
    let ostream;
    let opkt;
    let audio_encoder;
    unsafe {
        crate::ffi::averr(
            crate::ffi::avformat_alloc_output_context2(&mut octx, ptr::null(), ptr::null(), outc.as_ptr()),
            "alloc_output_context2",
        )?;
        ostream = crate::ffi::avformat_new_stream(octx, ptr::null());
        if ostream.is_null() {
            bail!("avformat_new_stream");
        }
        crate::ffi::averr(
            crate::ffi::avcodec_parameters_from_context((*ostream).codecpar, ectx),
            "params_from_ctx",
        )?;
        (*ostream).time_base = (*ectx).time_base;
        crate::ffi::averr(
            crate::ffi::avio_open(&mut pb, outc.as_ptr(), crate::ffi::AVIO_FLAG_WRITE as i32),
            "avio_open",
        )?;
        crate::ffi::sn_fmt_set_pb(octx, pb);
        // Le flux AAC doit exister AVANT l'en-tete (le muxer y fige sa table de flux).
        // Meme si aucun clip n'a d'audio, on ecrit une piste silencieuse -- parite
        // avec Windows/macOS, qui muxent toujours l'AAC.
        audio_encoder = AacEncoder::open(octx)?;
        crate::ffi::averr(
            crate::ffi::avformat_write_header(octx, ptr::null_mut()),
            "write_header",
        )?;
        opkt = crate::ffi::av_packet_alloc();
    }
    // A partir d'ici le muxer est un seul objet, et il part avec l'encodeur.
    let mux = Muxer { octx, pb, ostream, opkt, aac: audio_encoder };
    // Profondeur 3 : deux frames en vol suffisent a couvrir l'encodeur, la
    // troisieme absorbe les a-coups de la marche (une fin de clip y decode tout
    // l'audio du clip d'un coup, cf. `on_clip_end`).
    // Deux formes, pas deux variantes d'une meme : le chemin software encode sur
    // un thread (l'encodeur y coute ~8 ms/frame, il faut le sortir du chemin
    // critique), le chemin materiel encode sur place (~3 ms) et garde le muxer
    // sous la main. Les melanger rendrait les deux illisibles.
    let mut sink = match hw {
        Some((venc, staging)) => Sink::Hardware {
            enc: venc,
            mux,
            staging,
            pending: None,
            in_flight: None,
            next: 0,
        },
        None => {
            let enc = enc.ok_or_else(|| anyhow::anyhow!("aucun encodeur video disponible"))?;
            Sink::Software(Box::new(EncodeWorker::spawn(enc, mux, 3)?))
        }
    };

    // Un PCM par clip, assemble apres la marche video (elle seule dit combien de
    // frames chaque clip a produit, donc combien d'audio lui revient).
    let mut audio_jobs: ClipAudioJobs<Option<PlanarPcm>> = ClipAudioJobs::new(clips.len());
    let mut clip_frame_counts: Vec<u64> = vec![0; clips.len()];

    let scene = comp.scene_snapshot();
    let audio_settings = scene.as_ref().map(|scene| scene.audio).unwrap_or_default();
    // Ring de staging a 2 : l'export ne veut que du debit, une frame de latence
    // ne se voit pas dans un fichier. Voir `Compositor::set_readback_depth` pour
    // la raison pour laquelle la preview, elle, reste a 1.
    comp.set_readback_yuv_depth(2)?;
    // pts d'encodage : DECOUPLE de l'index de marche `n`, puisque la frame
    // recoltee a l'iteration n est celle composee a n-1. Il reste contigu (les
    // frames sortent de la ring dans l'ordre de composition), donc le fichier
    // produit est identique a celui du chemin synchrone.
    let mut encoded_pts: i64 = 0;
    let frames = unsafe {
        crate::timeline_walk::walk_composited_timeline(
            clips,
            gpu,
            comp,
            cfg,
            out_fps,
            &scene,
            &mut screen_decs,
            &mut webcam_decs,
            &mut |n| {
                // Soumet la copie de la frame n SANS l'attendre et recolte la
                // precedente : c'est tout le pipelining GPU. L'encodage, lui,
                // n'est plus ici du tout — il tourne sur `worker` pendant que
                // cette closure compose deja la frame suivante.
                match &mut sink {
                    Sink::Hardware { enc, mux, staging, pending, in_flight, next } => {
                        // Soumet la frame n SANS l'attendre, puis encode la
                        // precedente : le GPU compose pendant que l'encodeur
                        // travaille. La toute premiere passe n'a rien a encoder,
                        // comme l'amorcage de la ring software.
                        let slot = *next;
                        // AVANT d'ecrire dans ce slot : s'assurer que l'encodeur
                        // ne lit plus la surface qui le mappait. Draine tant qu'il
                        // la retient — c'est le drain qui fait sortir les paquets
                        // et relache les references, donc la boucle progresse.
                        if let Some((busy, frame)) = in_flight.take() {
                            if busy == slot {
                                let mut spins = 0;
                                while !VaapiEncoder::frame_released(frame) {
                                    mux.drain(enc.ctx())?;
                                    spins += 1;
                                    if spins > 1000 {
                                        bail!("l'encodeur retient la surface du slot {slot}");
                                    }
                                }
                                let mut f = frame;
                                crate::ffi::av_frame_free(&mut f);
                            } else {
                                *in_flight = Some((busy, frame));
                            }
                        }
                        let idx = comp.compose_into_dmabuf(&staging[slot])?;
                        if let Some((prev, prev_idx, pts)) = pending.take() {
                            comp.wait_submission(prev_idx);
                            let (bpr_y, bpr_uv, off_uv, _) = comp.nv12_geometry();
                            let f = enc.send_dmabuf(staging[prev].fd, bpr_y, bpr_uv, off_uv, pts)?;
                            mux.drain(enc.ctx())?;
                            // Remplace le precedent : il a ete relache plus haut
                            // si son slot revenait, sinon il l'est par ce drain.
                            if let Some((_, old)) = in_flight.take() {
                                let mut o = old;
                                crate::ffi::av_frame_free(&mut o);
                            }
                            *in_flight = Some((prev, f));
                        }
                        *pending = Some((slot, idx, encoded_pts));
                        encoded_pts += 1;
                        *next = (slot + 1) % staging.len();
                        progress(n + 1);
                        return Ok(());
                    }
                    Sink::Software(_) => {}
                }
                let worker = sink.worker();
                let frame = worker.take_free()?;
                let mut filled = false;
                comp.readback_submit_yuv(|rw, rh, planes| {
                    VideoEncoder::copy_into(
                        frame,
                        planes,
                        rw as i32,
                        rh as i32,
                        out_w as i32,
                        out_h as i32,
                    )?;
                    filled = true;
                    Ok(())
                })?;
                if filled {
                    worker.submit(frame, encoded_pts)?;
                    encoded_pts += 1;
                } else {
                    // Amorcage de la ring : rien a encoder, la frame empruntee
                    // retourne au pool telle quelle.
                    worker.give_back(frame);
                }
                // Progression = frames COMPOSEES (inchangee) : la barre ne doit
                // pas reculer d'une frame parce que l'encodage a un tour de
                // retard.
                progress(n + 1);
                Ok(())
            },
            &mut |clip_index, source_end_sec, frames_in_clip, speed_segments| {
                clip_frame_counts[clip_index] = frames_in_clip;
                let clip = &clips[clip_index];
                if clip.has_audio && frames_in_clip > 0 {
                    // L'audio d'un clip ne dépend que de ce clip : le décoder et l'étirer ici,
                    // sur le thread de rendu, immobilisait la barre d'export pour toute sa
                    // durée — rien n'appelle `progress()` entre deux clips. Le travail part
                    // sur un thread et se recouvre avec la composition du clip suivant ; les
                    // résultats sont récupérés après le parcours, rangés par index de clip.
                    let path = clip.screen.clone();
                    let source_start_sec = clip.source_start_sec;
                    let segments = speed_segments.to_vec();
                    audio_jobs.spawn(clip_index, move || {
                        decode_and_stretch_clip_audio(
                            clip_index,
                            &path,
                            source_start_sec,
                            source_end_sec,
                            &segments,
                            out_fps as f64,
                        )
                    });
                }
                Ok(())
            },
        )?
    };

    // Le chemin materiel n'a ni ring ni file : il ne reste qu'a vider l'encodeur.
    if let Sink::Hardware { enc, mux, staging, pending, in_flight, .. } = &mut sink {
        unsafe {
            // La derniere frame composee est encore en vol : sans ca la video
            // sortirait amputee d'une frame, exactement comme le drain de la
            // ring cote software.
            if let Some((prev, prev_idx, pts)) = pending.take() {
                comp.wait_submission(prev_idx);
                let (bpr_y, bpr_uv, off_uv, _) = comp.nv12_geometry();
                let f = enc.send_dmabuf(staging[prev].fd, bpr_y, bpr_uv, off_uv, pts)?;
                mux.drain(enc.ctx())?;
                if let Some((_, old)) = in_flight.take() {
                    let mut o = old;
                    crate::ffi::av_frame_free(&mut o);
                }
                *in_flight = Some((prev, f));
            }
            crate::ffi::avcodec_send_frame(enc.ctx(), ptr::null_mut());
            mux.drain(enc.ctx())?;
            // Le flush a fait sortir tout ce qui restait : plus rien ne reference
            // les surfaces, on peut liberer la derniere.
            if let Some((_, f)) = in_flight.take() {
                let mut f = f;
                crate::ffi::av_frame_free(&mut f);
            }
            // Le compositeur survit a l'export : lui rendre sa profondeur par
            // defaut vaut pour LES DEUX chemins. Le chemin materiel n'utilise pas
            // la ring, mais `ensure_yuv_fmt` a pu la vider et la redimensionner,
            // et la preview qui suit n'a pas a heriter de cet etat.
            comp.set_readback_yuv_depth(1)?;
        }
    }
    let mut mux = match sink {
        Sink::Hardware { mux, .. } => mux,
        Sink::Software(worker) => {
            let mut worker = worker;
            hw_none_tail(comp, &mut worker, out_w, out_h, &mut encoded_pts)?;
            worker.finish()?
        }
    };

    unsafe {
        // Audio : le plan part des frames REELLEMENT produites par clip (un clip
        // raccourci voit son audio raccourci d'autant), puis un seul encode AAC.
        // Récupération des jobs audio lancés pendant le parcours. `spawn` en admet quatre
        // avant d'en collecter un, donc il en reste au plus quatre à attendre ici — bornés
        // par le plus lent, pas par leur somme ; les autres se sont recouverts avec
        // l'encodage vidéo.
        let clip_pcm: Vec<Option<PlanarPcm>> = audio_jobs
            .into_results()
            .into_iter()
            .map(|slot| slot.flatten())
            .collect();

        let declared_audio: Vec<bool> = clips.iter().map(|c| c.has_audio).collect();
        let plan = build_audio_concat_plan(&clip_frame_counts, &declared_audio, out_fps as f64);
        let octx = mux.octx;
        mux.aac.encode(
            &finish_audio(assemble_concatenated_pcm(&clip_pcm, &plan), audio_settings),
            octx,
        )?;
        mux.finish()?;
    }

    let wall_s = t0.elapsed().as_secs_f64();
    Ok(Stats {
        frames,
        wall_s,
        fps: if wall_s > 0.0 { frames as f64 / wall_s } else { 0.0 },
        video_duration_s: frames as f64 / out_fps as f64,
    })
}

// ---------------------------------------------------------------------------
// Encodage materiel depuis un dmabuf
// ---------------------------------------------------------------------------

/// Encodeur `h264_vaapi` alimente par un dmabuf, sans relecture CPU.
///
/// POURQUOI `av_hwframe_map` ET JAMAIS `av_hwframe_transfer_data`. Le second
/// est le chemin d'UPLOAD CPU -> GPU, et c'est lui qui appelle `vaMapBuffer2`,
/// absent de libva avant 2.22 : sur Ubuntu 24.04 (libva 2.20) il ne rend pas une
/// erreur, il `assert(0)` et le processus meurt (cf. issue #552). Le mapping,
/// lui, ne prend pas ce chemin -- c'est ce qui rend cet encodeur utilisable la
/// ou l'upload ne l'est pas.
pub struct VaapiEncoder {
    ctx: *mut crate::ffi::AVCodecContext,
    drm_device: *mut crate::ffi::AVBufferRef,
    va_device: *mut crate::ffi::AVBufferRef,
    drm_frames: *mut crate::ffi::AVBufferRef,
    va_frames: *mut crate::ffi::AVBufferRef,
    w: i32,
    h: i32,
}

// SAFETY : memes raisons que `VideoEncoder` -- pointeurs FFI sans affinite de
// thread, un seul thread a la fois.
unsafe impl Send for VaapiEncoder {}

/// Libere le descripteur porte par l'`AVBufferRef` de la frame source.
unsafe extern "C" fn drm_desc_free(_opaque: *mut std::ffi::c_void, data: *mut u8) {
    crate::ffi::av_free(data as *mut std::ffi::c_void);
}

impl VaapiEncoder {
    /// Ouvre la chaine DRM -> VAAPI -> `h264_vaapi`. `None` si quoi que ce soit
    /// manque : l'appelant retombe alors sur l'encodeur software.
    pub unsafe fn open(w: i32, h: i32, fps: i32, bit_rate: i64) -> Option<VaapiEncoder> {
        use crate::ffi::*;
        let mut me = VaapiEncoder {
            ctx: ptr::null_mut(),
            drm_device: ptr::null_mut(),
            va_device: ptr::null_mut(),
            drm_frames: ptr::null_mut(),
            va_frames: ptr::null_mut(),
            w,
            h,
        };
        // LE DEVICE DRM D'ABORD, PUIS VAAPI DERIVE DE LUI. L'ordre inverse
        // (VAAPI ouvert seul) rend ENOSYS sur radeonsi : le mapping veut les deux
        // cotes d'un meme device.
        let node = std::ffi::CString::new("/dev/dri/renderD128").ok()?;
        if av_hwdevice_ctx_create(
            &mut me.drm_device,
            AVHWDeviceType::AV_HWDEVICE_TYPE_DRM,
            node.as_ptr(),
            ptr::null_mut(),
            0,
        ) < 0
        {
            return None;
        }
        if av_hwdevice_ctx_create_derived(
            &mut me.va_device,
            AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI,
            me.drm_device,
            0,
        ) < 0
        {
            return None;
        }
        // `initial_pool_size = 0` sur LES DEUX contextes : ils ne font
        // qu'ENVELOPPER des surfaces fournies de l'exterieur (le dmabuf d'un
        // cote, ce que `av_hwframe_map` remplit de l'autre). Demander un pool
        // pre-alloue fait rejeter le format par `av_hwframe_ctx_init` en EINVAL,
        // faute d'allocateur pour ces dispositions.
        let mk_frames = |dev: *mut AVBufferRef, fmt: AVPixelFormat::Type| -> *mut AVBufferRef {
            let frames = av_hwframe_ctx_alloc(dev);
            if frames.is_null() {
                return ptr::null_mut();
            }
            let c = (*frames).data as *mut AVHWFramesContext;
            (*c).format = fmt;
            (*c).sw_format = AVPixelFormat::AV_PIX_FMT_NV12;
            (*c).width = w;
            (*c).height = h;
            (*c).initial_pool_size = 0;
            if av_hwframe_ctx_init(frames) < 0 {
                return ptr::null_mut();
            }
            frames
        };
        me.drm_frames = mk_frames(me.drm_device, AVPixelFormat::AV_PIX_FMT_DRM_PRIME);
        me.va_frames = mk_frames(me.va_device, AVPixelFormat::AV_PIX_FMT_VAAPI);
        if me.drm_frames.is_null() || me.va_frames.is_null() {
            return None;
        }

        let name = std::ffi::CString::new("h264_vaapi").ok()?;
        let enc = avcodec_find_encoder_by_name(name.as_ptr());
        if enc.is_null() {
            return None;
        }
        me.ctx = avcodec_alloc_context3(enc);
        if me.ctx.is_null() {
            return None;
        }
        (*me.ctx).width = w;
        (*me.ctx).height = h;
        (*me.ctx).pix_fmt = AVPixelFormat::AV_PIX_FMT_VAAPI as i32;
        (*me.ctx).time_base = AVRational { num: 1, den: fps };
        (*me.ctx).framerate = AVRational { num: fps, den: 1 };
        (*me.ctx).bit_rate = bit_rate;
        // MP4 veut SPS/PPS dans l'extradata, pas repetes devant chaque image
        // cle. Le chemin software le pose depuis toujours (`try_open`) ; l'avoir
        // oublie ici produisait un fichier qui se lit quand meme, parce que le
        // muxer recupere ce qu'il trouve — mais un lecteur qui se fie a
        // `codecpar` seul aurait de quoi echouer.
        (*me.ctx).flags |= AV_CODEC_FLAG_GLOBAL_HEADER as i32;
        (*me.ctx).hw_frames_ctx = av_buffer_ref(me.va_frames);
        if avcodec_open2(me.ctx, enc, ptr::null_mut()) < 0 {
            return None;
        }
        Some(me)
    }

    /// Envoie a l'encodeur l'image qui se trouve derriere `fd`, decrite comme un
    /// NV12 lineaire de pitches `bpr_y` / `bpr_uv`.
    pub unsafe fn send_dmabuf(
        &mut self,
        fd: i32,
        bpr_y: u32,
        bpr_uv: u32,
        off_uv: u64,
        pts: i64,
    ) -> Result<*mut AVFrame> {
        use crate::ffi::*;
        let desc = av_mallocz(std::mem::size_of::<AVDRMFrameDescriptor>())
            as *mut AVDRMFrameDescriptor;
        if desc.is_null() {
            bail!("av_mallocz(AVDRMFrameDescriptor)");
        }
        (*desc).nb_objects = 1;
        (*desc).objects[0].fd = fd;
        // 0 : la taille est retrouvee par le pilote depuis le fd lui-meme.
        (*desc).objects[0].size = 0;
        (*desc).objects[0].format_modifier = 0; // DRM_FORMAT_MOD_LINEAR
        (*desc).nb_layers = 1;
        // fourcc 'NV12', ecrit a la main : bindgen ne genere pas MKTAG.
        (*desc).layers[0].format = u32::from_le_bytes(*b"NV12");
        (*desc).layers[0].nb_planes = 2;
        (*desc).layers[0].planes[0].object_index = 0;
        (*desc).layers[0].planes[0].offset = 0;
        (*desc).layers[0].planes[0].pitch = bpr_y as isize;
        (*desc).layers[0].planes[1].object_index = 0;
        (*desc).layers[0].planes[1].offset = off_uv as isize;
        (*desc).layers[0].planes[1].pitch = bpr_uv as isize;

        let src = av_frame_alloc();
        (*src).format = AVPixelFormat::AV_PIX_FMT_DRM_PRIME as i32;
        (*src).width = self.w;
        (*src).height = self.h;
        (*src).data[0] = desc as *mut u8;
        // LA SOURCE DOIT ETRE REFCOMPTEE. Sans `buf[0]`, `av_hwframe_map` rend
        // EINVAL -- et son message ne dit pas un mot de comptage de references,
        // ce qui rend la panne tres difficile a lire.
        (*src).buf[0] = av_buffer_create(
            desc as *mut u8,
            std::mem::size_of::<AVDRMFrameDescriptor>(),
            Some(drm_desc_free),
            ptr::null_mut(),
            0,
        );
        (*src).hw_frames_ctx = av_buffer_ref(self.drm_frames);

        let dst = av_frame_alloc();
        (*dst).format = AVPixelFormat::AV_PIX_FMT_VAAPI as i32;
        (*dst).width = self.w;
        (*dst).height = self.h;
        (*dst).hw_frames_ctx = av_buffer_ref(self.va_frames);
        // Bindgen range les `AV_HWFRAME_MAP_*` dans un module anonyme : les
        // nommer par leur valeur serait plus fragile que de passer par lui.
        let flags = (crate::ffi::_bindgen_ty_3::AV_HWFRAME_MAP_READ
            | crate::ffi::_bindgen_ty_3::AV_HWFRAME_MAP_DIRECT) as i32;
        let mapped = av_hwframe_map(dst, src, flags);
        if mapped < 0 {
            let mut s = src;
            let mut d = dst;
            av_frame_free(&mut s);
            av_frame_free(&mut d);
            averr(mapped, "av_hwframe_map(DRM -> VAAPI)")?;
            unreachable!("averr rend une erreur pour mapped < 0");
        }
        (*dst).pts = pts;
        let r = averr(avcodec_send_frame(self.ctx, dst), "send_frame(vaapi)");
        // `src` a fini son role : `av_hwframe_map` a copie ce qu'il fallait dans
        // `dst`, et le descripteur DRM meurt avec lui.
        let mut s = src;
        av_frame_free(&mut s);
        // `dst` PAS libere ici. `avcodec_send_frame` en a pris une reference, et
        // cette frame mappe le dmabuf du slot : tant qu'elle vit, l'encodeur peut
        // encore lire cette memoire. L'appelant la garde et ne la relache — donc
        // ne recycle le slot — qu'apres avoir draine le paquet correspondant.
        r.map(|()| dst)
    }

    /// Vrai si l'encodeur ne detient plus la frame mappee, donc si le slot qu'elle
    /// couvre peut etre reecrit.
    ///
    /// C'est la SEULE question qui compte pour reutiliser un slot. Un `drain` qui
    /// rend `EAGAIN` ne dit rien la-dessus : il signale qu'aucun paquet n'est
    /// pret, pas que la surface est relachee.
    pub unsafe fn frame_released(frame: *mut AVFrame) -> bool {
        frame.is_null()
            || (*frame).buf[0].is_null()
            || crate::ffi::av_buffer_get_ref_count((*frame).buf[0]) <= 1
    }

    pub fn ctx(&self) -> *mut crate::ffi::AVCodecContext {
        self.ctx
    }
}

impl Drop for VaapiEncoder {
    fn drop(&mut self) {
        unsafe {
            if !self.ctx.is_null() {
                crate::ffi::avcodec_free_context(&mut self.ctx);
            }
            for b in [
                &mut self.va_frames,
                &mut self.drm_frames,
                &mut self.va_device,
                &mut self.drm_device,
            ] {
                if !b.is_null() {
                    crate::ffi::av_buffer_unref(b);
                }
            }
        }
    }
}

#[cfg(test)]
mod vaapi_tests {
    use super::*;

    /// La chaine complete, dans le crate et non dans un bac a sable : un tampon
    /// de staging EXPORTABLE alloue par le compositeur, son fd donne a
    /// `av_hwframe_map`, et `h264_vaapi` qui en sort un paquet.
    ///
    /// C'est le premier test qui touche reellement l'encodeur materiel. Il se
    /// saute proprement partout ou la chaine n'existe pas (pas de GPU, pas de
    /// `/dev/dri/renderD128`, pas de VAAPI) -- la CI rend sur lavapipe, et
    /// l'echec y serait un faux negatif.
    #[test]
    fn vaapi_encodes_from_an_exported_dmabuf() {
        let Ok(gpu) = crate::d3d::Gpu::create_auto(false) else {
            eprintln!("pas d'adaptateur Vulkan — test saute");
            return;
        };
        let (w, h) = (640i32, 480i32);
        let comp = match crate::compositor::Compositor::new_sized(&gpu, w as u32, h as u32) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("compositeur indisponible ({e:#}) — test saute");
                return;
            }
        };
        let (bpr_y, bpr_uv, off_uv, total) = crate::compositor::Compositor::yuv_layout_for(
            w as u32,
            h as u32,
            crate::compositor::YuvFormat::Nv12,
        );
        let Some(st) = comp.create_exportable_staging(total) else {
            eprintln!("pas de memoire externe — test saute");
            return;
        };

        // Du gris legal plutot que des zeros : un plan Y a 0 est du noir hors
        // plage en BT.601 limite, et on veut que l'encodeur voie une image
        // valide, pas qu'il la rattrape.
        let mut grey = vec![128u8; total as usize];
        grey[..off_uv as usize].fill(128);
        gpu.context.write_buffer(st.buffer(), 0, &grey);
        gpu.context.submit(std::iter::empty());
        gpu.device.poll(wgpu::Maintain::Wait);

        unsafe {
            let Some(mut enc) = VaapiEncoder::open(w, h, 60, 4_000_000) else {
                eprintln!("h264_vaapi indisponible — test saute");
                return;
            };
            enc.send_dmabuf(st.fd, bpr_y, bpr_uv, off_uv, 0)
                .expect("send_dmabuf");
            // Un encodeur peut legitimement retenir la premiere frame : on le
            // vide pour forcer la sortie du paquet.
            let _ = crate::ffi::avcodec_send_frame(enc.ctx(), std::ptr::null_mut());
            let pkt = crate::ffi::av_packet_alloc();
            let r = crate::ffi::avcodec_receive_packet(enc.ctx(), pkt);
            assert!(r >= 0, "avcodec_receive_packet a rendu {r}");
            assert!((*pkt).size > 0, "paquet H.264 vide");
            let mut p = pkt;
            crate::ffi::av_packet_free(&mut p);
        }

#[cfg(test)]
mod tests {
    use super::*;

    const W: i32 = 320;
    const H: i32 = 180;

    /// Sortie d'un encodage de test : les drapeaux « image clé » paquet par paquet,
    /// et l'extradata (le SPS, en Annex-B, puisque `try_open` pose
    /// `AV_CODEC_FLAG_GLOBAL_HEADER`).
    struct Encoded {
        keyframes: Vec<bool>,
        extradata: Vec<u8>,
        qmin: i32,
        qmax: i32,
        gop_size: i32,
    }

    /// Encode `n` images 320x180 par le chemin RÉEL de l'export — `VideoEncoder::open`,
    /// donc `try_open`, donc toute la configuration que ce fichier pose. Un contexte
    /// monté à la main dans le test ne prouverait rien.
    ///
    /// Rend `None` quand l'encodeur n'est pas ouvrable (build ffmpeg sans
    /// `libopenh264`), pour que le test se saute proprement au lieu d'échouer sur
    /// l'environnement.
    fn encode(fps: i32, n: usize) -> Option<Encoded> {
        // Un dev qui force un autre encodeur ne doit pas voir ce test rougir : il ne
        // décrit que `libopenh264`.
        match std::env::var("OPENSCREEN_EXPORT_ENCODER") {
            Ok(name) if name != "libopenh264" => return None,
            _ => {}
        }
        let mut enc = VideoEncoder::open(&ExportCodec::H264, W, H, fps, 1_000_000).ok()?;

        let mut out = Encoded {
            keyframes: Vec::new(),
            extradata: Vec::new(),
            qmin: 0,
            qmax: 0,
            gop_size: 0,
        };
        unsafe {
            use crate::ffi::*;
            out.qmin = (*enc.ctx).qmin;
            out.qmax = (*enc.ctx).qmax;
            out.gop_size = (*enc.ctx).gop_size;
            let (ptr, len) = ((*enc.ctx).extradata, (*enc.ctx).extradata_size);
            if !ptr.is_null() && len > 0 {
                out.extradata = std::slice::from_raw_parts(ptr, len as usize).to_vec();
            }

            let pkt = av_packet_alloc();
            let mut rgba = vec![0u8; (W * H * 4) as usize];
            // Copie du pointeur AVANT la closure : la capturer via `enc.ctx`
            // emprunterait `enc` en lecture pour toute la durée du drain, et
            // `send_rgba` en veut un emprunt mutable juste après.
            let ectx = enc.ctx;
            let mut drain = |pkt: *mut AVPacket, out: &mut Encoded| loop {
                let r = avcodec_receive_packet(ectx, pkt);
                if r == AVERROR_EOF || r == AVERROR_EAGAIN {
                    return;
                }
                out.keyframes.push((*pkt).flags & AV_PKT_FLAG_KEY as i32 != 0);
                av_packet_unref(pkt);
            };
            for i in 0..n {
                // Un dégradé qui glisse : de quoi donner du résidu à coder, sans quoi
                // l'encodeur travaille sur une image morte.
                for (p, px) in rgba.chunks_exact_mut(4).enumerate() {
                    px[0] = ((p + i * 7) % 251) as u8;
                    px[1] = ((p / W as usize + i * 3) % 253) as u8;
                    px[2] = (i * 5 % 257) as u8;
                    px[3] = 255;
                }
                enc.send_rgba(&rgba, W, H, i as i64).expect("send_rgba");
                drain(pkt, &mut out);
            }
            enc.flush().expect("flush");
            drain(pkt, &mut out);
            let mut pkt = pkt;
            av_packet_free(&mut pkt);
        }
        Some(out)
    }

    /// `profile_idc` porté par le SPS de l'extradata (Annex-B : `00 00 00 01 67 <idc>`).
    fn profile_idc(extradata: &[u8]) -> Option<u8> {
        extradata
            .windows(6)
            .find(|w| w[..4] == [0, 0, 0, 1] && w[4] & 0x1f == 7)
            .map(|w| w[5])
    }

    /// L'export doit porter des images clés PÉRIODIQUES.
    ///
    /// Sans `(*ctx).gop_size`, le wrapper ffmpeg de `libopenh264` pose `g = -1` dans
    /// ses `FFCodecDefault`, openh264 reçoit `uiIntraPeriod = 0` et n'émet qu'UNE
    /// image clé pour tout le fichier — mesuré 1 image I sur 300 avant ce correctif.
    /// Le MP4 reste lisible, mais tout seek redécode depuis le début et un paquet
    /// abîmé emporte le reste. C'est le test qui aurait attrapé ça.
    #[test]
    fn l_export_h264_emet_des_images_cles_periodiques() {
        let Some(enc) = encode(10, 45) else {
            eprintln!("libopenh264 indisponible — test sauté");
            return;
        };
        assert_eq!(enc.gop_size, 20, "gop_size doit valoir fps * 2");
        let keys: Vec<usize> = enc
            .keyframes
            .iter()
            .enumerate()
            .filter(|(_, k)| **k)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(
            keys,
            vec![0, 20, 40],
            "images clés attendues toutes les {} frames, obtenu {keys:?} sur {} paquets",
            enc.gop_size,
            enc.keyframes.len()
        );
    }

    /// `tune_openh264` doit atteindre l'encodeur : fenêtre de QP explicite (sans quoi
    /// openh264 remplace la sienne par (12, 42), cf. la doc de la fonction) et profil
    /// High dans le SPS (sans quoi on expédie du Constrained Baseline en CAVLC).
    #[test]
    fn l_export_h264_configure_openh264() {
        let Some(enc) = encode(10, 3) else {
            eprintln!("libopenh264 indisponible — test sauté");
            return;
        };
        assert_eq!((enc.qmin, enc.qmax), (1, 51), "fenêtre de QP non transmise");
        assert_eq!(
            profile_idc(&enc.extradata),
            Some(100),
            "le SPS doit annoncer le profil High (100) ; 66 = Constrained Baseline, \
             le défaut du wrapper. extradata={:02x?}",
            &enc.extradata[..enc.extradata.len().min(12)]
        );
    }
}
