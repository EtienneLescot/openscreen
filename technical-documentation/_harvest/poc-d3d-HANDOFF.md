# Passation de contexte — poc-d3d (compositeur natif D3D11)

Document d'onboarding pour un agent qui reprend ce travail. Complète le
[README](README.md) (orienté build/usage) et la spec
[`docs/architecture/rendering-architecture.md`](../docs/architecture/rendering-architecture.md)
(source de vérité, annexe D). Écrit le 2026-07-18.

---

## 1. En une phrase

`poc-d3d/` est un **POC natif Windows écrit de zéro** qui compose deux sources vidéo
D3D11 **zéro-copie GPU** avec 9 effets HLSL, encode en H.264 matériel, et se mesure en
fps de C0 (décode+encode nu) à C8 (tous effets). Il est le **fast-path natif RETENU**
d'OpenScreen : mesuré **~126 fps** en 1080p60 tous-effets, au-dessus du web (79) et du
POC wgpu (48–68), **sans interop Vulkan bloquée** (le driver AMD la gate).

## 2. Où tout se trouve

| quoi | où |
|---|---|
| Repo | `getopenscreen/openscreen` (remote `origin`). Forks : `contributor`=SakuraiSatoru, `gede`=gede-cahya. |
| Branche | `claude/openscreen-rendering-architecture-b2a670` (suit `origin`). **Ne jamais toucher `main`.** |
| Worktree local | `repos/openscreen/.claude/worktrees/pr-11-closure-5b322b/` |
| Ce POC | `poc-d3d/` (à côté de `poc/` = web, `poc-native/` = wgpu) |
| Spec / décision | `docs/architecture/rendering-architecture.md`, **annexe D** (D.6 = ce POC, marqueur de décision ; D.7 = cross-platform) |
| Docs du POC | `poc-d3d/docs/` = parcours **S0→S6** (voir §9 ci-dessous) |
| Source POC d'origine | `C:\Users\camil\Documents\spike-native\` (repo standalone d'origine, même code + gros artefacts déjà buildés — pratique pour re-mesurer vite) |

Commits sur la branche : `64360ea4` (poc-d3d), `9be8a21d` (doc). Les deux poussés sur origin.

## 3. La décision architecturale (et pourquoi)

**Trois POC de rendu, une décision "exploration → décision" :**
- `poc/` (web, WebCodecs + WebGPU) = **hôte de lancement portable**, 79 fps partout. Reste le défaut d'expédition (§12 de la spec).
- `poc-native/` (Rust + wgpu/Vulkan) = **preuve de portabilité** (le compositeur WGSL tourne natif à l'identique) + carte des coûts. MAIS chemin CPU-transport plafonné à 48–68 fps, et zéro-copie Vulkan **bloqué** (driver AMD sans `VK_KHR_video_maintenance1`).
- `poc-d3d/` (ce POC) = **fast-path natif retenu**. La correction clé de D.6 : la GPU-résidence était toujours le bon principe ; seule la *route* était fausse. `D3D11VA` (décode) + `AMF` (encode) sont les chemins D3D-natifs d'AMD, ne demandent **aucune** extension Vulkan Video, donc atteignent la pleine résidence GPU **sur le driver actuel** où Vulkan ne peut pas.

**Stack par défaut = D3D11 nu** (pas de framework). La R&D S0 a instruit et écarté, chacun sur un critère + un fait (`docs/S0-frameworks.md`) : libavfilter Vulkan (K2 ✗, `hwmap` d3d11↔vulkan = ENOSYS), Direct2D (passe K2 mais contredit "effets écrits depuis les maths"), GStreamer (possède la boucle → §10, compositeur fixed-function), wgpu (ne paie que la portabilité, hors périmètre). D3D11 nu gagne : contrôle total, zéro couche entre la mesure et le GPU.

## 4. Le pipeline (zéro-copie de bout en bout)

```
demux → décode D3D11VA (×2 sources, NV12 GPU) → compositeur HLSL (RT RGBA)
      → RGB→NV12 (2 passes RTV) → encode h264_amf (GPU→GPU) → mux MP4
```

Un seul `ID3D11Device` partagé (feature level 11_1, flag `VIDEO_SUPPORT`,
`SetMultithreadProtected(TRUE)`), injecté dans le décodeur ffmpeg via
`AVD3D11VAFramesContext`. Seul le bitstream encodé descend en RAM. Textures décodeur
rendues échantillonnables via `BindFlags |= SHADER_RESOURCE` (§5).

## 5. La stack technique

- **Rust + `windows-rs`** (D3D11, DXGI, Fxc pour compiler le HLSL au runtime).
- **ffmpeg `libav*` LGPL** (demux / décode D3D11VA / encode `h264_amf` / mux). Bindings
  générés par **`bindgen`** sur les headers 8.x (choix vs `ffmpeg-next` qui ne suit que 7.x)
  + **shim C** (`shim.c`) pour les structs que bindgen rend opaques (`AVFormatContext`).
- **Compositeur HLSL** maison (`src/shaders.hlsl`), effets écrits depuis les maths.
- Modules : `d3d.rs` (device), `pipeline.rs` (Decoder, run_c0/run_composited, encode+mux),
  `compositor.rs` (rendu+effets+timeline anim), `cursor.rs` (parse .cursor.json),
  `config.rs` (cfg cumulatives C0..C8), `ffi.rs` (bindings), `main.rs` (runner CLI).
- **Toolchain** : Rust msvc, Visual Studio (MSVC + Windows SDK), LLVM (libclang, pour
  bindgen), build ffmpeg LGPL-shared BtbN dans `thirdparty/` (non versionné).

## 6. Les 9 effets (tous dans les vidéos encodées)

padding + background · **background flouté** (dual-Kawase) · masques rounded-corner (SDF)
sur les 2 sources · **ombres portées** (pénombre SDF) sur les 2 · **layout animé** A(PIP)↔B(côte-à-côte)
· **zooms** (1.0→1.8→1.0) · **flou de mouvement** par vélocité (zoom+layout) · **curseur custom**
dot+ring + flou de mouvement + **click bounce** (depuis `.cursor.json`).

## 7. Résultats mesurés (release, protocole §C.2)

Config cumulative, fps end-to-end (demux→…→mux), une lecture d'horloge avant/après tout le run :

```
C0 239  décode+encode nu        C5 125  +zoom
C1 151  +composite 2 sources    C6 133  +layout animé
C2 151  +coins arrondis         C7 133  +curseur
C3 140  +ombres                 C8 126  +flou de mouvement (tous effets)
C4 131  +fond flouté
```

- **Headline : C8 (tous effets) ~126 fps** (médiane 125.9, spread 11.8 % → admissible),
  confirmé au protocole (interleavé vs C0, tour de chauffe jeté, régime **soutenu** — pas
  un transitoire de boost à froid, qui monte à ~240 mais ne tient pas sous export répété).
- **Direction thermiquement robuste** : les absolus dérivent (iGPU passif boost/throttle),
  mais à *chaque* état mesuré, tous-effets bat web (79) et wgpu (48–68), plancher bridé inclus.

## 8. Ce que la mesure des moteurs GPU a établi (externe, non intrusif)

Via compteurs Windows `\GPU Engine\Utilization` (sans élévation, sans instrumenter le process) :

- **Le goulot glisse avec la charge** : configs légères = **encode-bound** (moteur video codec ~71 %),
  configs lourdes = **composite-bound** (moteur 3d ~84 %). Le **décode ne borne jamais** (~2 ms bursty).
- **Les moteurs se recouvrent déjà** (3d 84 % + codec 61 % = 145 % > 100 % sur la même fenêtre) :
  le GPU pipeline décode/composite/encode entre frames tout seul, malgré une boucle CPU sérielle.
  → **Un pipeline CPU multi-thread n'apporterait ~rien** (confirmé par un cache SRV resté sans effet).
  C'est le **jumeau natif de l'annexe C.3** (pipelining de l'encodeur PERD sur cet iGPU : bus mémoire
  partagé → le recouvrement force la contention de bande passante).
- **Plafond dur = l'encodeur VCN (~210 fps, fixed-function)** : `-quality speed` ne gagne que +2 %.
  Le composite est le **seul terrain optimisable** sur les configs lourdes.

## 9. Optimisations faites (méthode : mesure → optim ciblée → re-mesure)

1. **Cache SRV** (par texture/slice) — **aucun gain** → confirme qu'on est GPU-bound, pas CPU-bound.
   Gardé (correct, utile à plus haute réso).
2. **Flou de mouvement : supersampling temporel N=6 → flou directionnel par vélocité** — 23 → 104 fps.
   Le shader floute le long de `uv(f)−uv(f−1)` par pixel (translation + zoom), early-out si immobile.
3. **Fond flouté : gaussien 49-tap → dual-Kawase** (chaîne down/up 5–8 taps) — C8 104 → 126 fps.
   Profite à C4–C8 (toutes ont le fond flouté). Qualité équivalente (fond isotrope doux).

## 10. Discipline de mesure — à respecter

- **Chrono §10 = UNE lecture d'horloge avant / une après**, enveloppant tout le run
  (`Instant::now()`, mappe QPC). Jamais instrumenté. Les sondes par-passe/par-moteur vont dans un
  **mode séparé** (les compteurs GPU externes ci-dessus jouent ce rôle — jamais dans le chrono headline).
- **Comparaison** = A/B interleavé, **1 tour de chauffe jeté**, **VOID si spread intra-bras > ~15 %**.
- **Optimiser TOUTES les configs C0→C8** (le chemin commun décode/encode lève toute la table),
  pas une ligne isolée.
- Build **`--release`** (LTO, `debug_assertions` off) pour tout run mesuré. Pas de `println!`/alloc par frame.
- Piège vécu : la machine chauffe après des runs en rafale → spreads 15–25 %. Pour un chiffre absolu
  fiable, viser GPU froid / secteur ; sinon s'appuyer sur la **direction** (robuste) plutôt que l'absolu.

## 11. Pièges / gotchas (déjà résolus — ne pas re-payer)

- **ffmpeg = build LGPL** (BtbN `*-lgpl-shared`), pas le gyan système (GPL → K1 ✗ pour app MIT). Garde D3D11VA + AMF.
- **bindgen rend opaques les structs atteintes seulement par pointeur** (`AVFormatContext` → `_address:u8`) → shim C pour `streams[]`/`pb`.
- **enums bindgen = modules** : `ffi::AVPixelFormat::AV_PIX_FMT_D3D11`, etc. **AVERROR non générés** → `EAGAIN=-11`, `EOF=-541478725`.
- **device donné à ffmpeg** : il le `Release` au teardown → lui donner un +1 via `std::mem::forget(gpu.device.clone())`.
- **NV12 + RENDER_TARGET refusé en texture ARRAY** (E_INVALIDARG) sur cet iGPU → rendre dans une NV12 simple puis `CopySubresourceRegion` vers le pool encodeur (bind DECODER|SHADER_RESOURCE).
- **`D3D11_BLEND_DESC::default()` a WriteMask=0** (rien écrit) → forcer `COLOR_WRITE_ENABLE_ALL`.
- **Ordre RTV/SRV** : basculer le render target AVANT de binder une ressource en SRV (sinon D3D11 rejette le SRV).
- **Webcam réelle openscreen = H.264 Baseline (cs1=0)** → refusée par D3D11VA (`No decoder device`), retombe en software SANS erreur. La fixture utilise deux flux screen (CBP cs1=1) pour éviter ça ; à la capture, exiger `constraint_set1_flag=1` ou Main/High.
- **Surface décodeur alignée macrobloc** (1080→1088, 1032→1040) : corriger dans les UV.
- **Sources BT.709 limited** (mesuré, non taggé) — une seule matrice NV12→RGB.
- **Repo openscreen : hook husky/biome pre-commit** formate les `.json`/`.ts` au style repo (tabs). Ne pas contourner (`--no-verify`) — formater le fichier (`node_modules/.bin/biome format --write`).

## 12. Build & run

```
# déposer le build ffmpeg LGPL-shared BtbN dans poc-d3d/thirdparty/  (voir README)
x.bat run --release -- --fixture fixture --cfg C0..C8 --repeat 3 --out out/
```
`x.bat` = vcvars + ffmpeg/bin sur PATH + cargo. Produit `out/C{0..8}.mp4`, PNG f60/180/300, `report.json`.
La **fixture média est non versionnée** (convention des POC) — régénération dans `docs/S1-sources.md`
(commandes `ffmpeg -ss … -t 6 -c copy`, sources dans `%APPDATA%\openscreen\recordings`).

## 13. Ce qui reste ouvert (threads pour la suite)

- **Mode `--profile detail` interne** (queries GPU timestamp par passe, anneau 4 frames, DONOTFLUSH) :
  non construit. La question "décode/composite/encode share + serial/parallel" a été répondue **en
  externe** (compteurs moteurs, §8) — le détail interne resterait diagnostic (RGP recommandé de toute façon).
- **Compositing en espace linéaire** : on compose en gamma (RT `UNORM`, pas `UNORM_SRGB`). Flou/blend
  légèrement faux (halos). Gain **qualité**, pas vitesse. Écart au spec assumé.
- **Cross-platform** (D.7) : 1 compositeur + 1 couche codec ffmpeg + 3 bridges zéro-copie (Windows =
  texture D3D11 partagée ✓ fait ; Linux = dma-buf ; macOS = IOSurface). Le bridge Windows pourra passer
  à Vulkan quand les drivers AMD mûriront, sans toucher compositeur ni ffmpeg.
- **Laptops hybrides** (iGPU+dGPU) : si décode/composite/encode atterrissent sur des adaptateurs
  différents, la copie cross-adaptateur casse le zéro-copie. À détecter + épingler sur un adaptateur.
- **Encodeur** : le plafond VCN est le mur. Segment-parallèle sur plusieurs GOP (plusieurs instances
  d'encodeur, pas une file plus profonde) est la seule piste, marginale aux ceilings actuels.
