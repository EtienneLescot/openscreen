# crates/ — le compositeur natif D3D11 (le fast-path natif retenu)

| Crate | Rôle |
|---|---|
| [`compositor/`](compositor) | La bibliothèque : D3D11, décodage, pipeline, effets HLSL, scène, curseur, audio, vue live. **Code de production** — la preview et l'export de l'app passent par là. |
| [`compositor-view-napi/`](compositor-view-napi) | L'addon napi-rs. C'est lui qui produit `compositor_view.node`, **le binaire packagé dans l'app**. |
| [`poc-d3d/`](poc-d3d) | Le POC d'origine : GUI Win32 de preview/export + harnais de bench fps. **Rien ici n'est packagé** ; conservé comme banc de mesure et pièce d'époque. |

Tout vivait auparavant sous `poc-d3d/`, ce qui laissait croire que la bibliothèque était
jetable alors que l'app en dépend — un `.node` périmé s'est ainsi retrouvé packagé sans que
personne tique. Le garde-fou est décrit dans
[`build-and-packaging.md`](../technical-documentation/engineering/build-and-packaging.md#stale-native-artifacts) ;
en un mot : sur Windows, packager avec `npm run build:win`, jamais `npm run build`.

Le reste de ce document est l'historique du POC qui a produit ce compositeur.

Troisième POC de rendu d'OpenScreen, à côté de [`poc/`](../poc) (web, WebCodecs + WebGPU)
et [`poc-native/`](../poc-native) (Rust + wgpu/Vulkan). Voir la spec :
[`technical-documentation/engineering/rendering-performance.md`](../technical-documentation/engineering/rendering-performance.md),
annexe D (D.6 en particulier).

**Ce qu'il prouve.** Le chemin natif GPU-résident — celui que `poc-native` a montré bloqué
sur le driver AMD (Vulkan Video absent, cf. D.5) — est en réalité **débloqué via D3D11**,
sur le driver actuel, sans mise à jour. Application Windows native écrite de zéro (pas un
fork) : **un seul `ID3D11Device`, zéro readback CPU entre les étapes** —

```
décode D3D11VA (×2 sources, NV12 GPU) → compositeur HLSL → RGB→NV12 (2 passes RTV)
                                      → encode h264_amf (GPU→GPU) → mux MP4
```

Effets, écrits depuis les maths (mêmes que le compositeur WGSL) : layout animé, zooms,
NV12→RGB BT.709, coins arrondis + masques (SDF), ombres portées (pénombre SDF), fond flouté
(dual-Kawase), flou de mouvement par vélocité, curseur custom + click bounce.

**Résultat mesuré** (protocole §C.2 du doc : régime soutenu, tour de chauffe jeté,
spread < 15 %) : config tous-effets **~126 fps** en 1080p60, au-dessus du web (79) et de
wgpu (48–68). Le fps enveloppe demux → décode → composite → encode → mux (§10 : une lecture
d'horloge avant/après tout le run). Détail des couches C0→C8 : [`technical-documentation/architecture/native-compositor.md`](../technical-documentation/architecture/native-compositor.md).

C'est le **fast-path natif retenu** pour Windows (cf. le marqueur de décision dans l'annexe D).
`poc/` reste l'hôte de lancement portable ; `poc-native` reste la preuve de portabilité du
compositeur (WGSL natif à l'identique) + la carte des coûts.

## Stack

- **Rust + windows-rs**, D3D11 nu (feature level 11_1, `VIDEO_SUPPORT`, multithread-protected).
  Décision framework en [`technical-documentation/architecture/native-compositor.md`](../technical-documentation/architecture/native-compositor.md) (Vulkan/Direct2D/GStreamer/wgpu instruits, écartés).
- **ffmpeg (libav\*)** LGPL pour demux / décode D3D11VA / encode `h264_amf` / mux. Bindings
  générés par `bindgen` (choix vs `ffmpeg-next` : suit ffmpeg 8.x — voir [`technical-documentation/architecture/native-compositor.md`](../technical-documentation/architecture/native-compositor.md)),
  shim C (`shim.c`) pour les structs opaques.
- Compositeur HLSL (`src/shaders.hlsl`) compilé au runtime.

## Prérequis

- Rust (toolchain msvc), Visual Studio (MSVC + Windows SDK), LLVM (libclang, pour bindgen).
- **Build ffmpeg LGPL-shared** dans `thirdparty/` (non versionné) : récupérer
  `ffmpeg-n8.1.2-win64-lgpl-shared` (le build pinné dans `.cargo/config.toml` — le
  MÊME que `scripts/fetch-ffmpeg.mjs` vendorise, sinon le require() de l'addon échoue),
  dézipper dans
  `thirdparty/`. Le chemin est relatif au dossier, fixé dans `.cargo/config.toml` (`FFMPEG_DIR`).
  `LIBCLANG_PATH` y pointe l'install LLVM. Ajuste le chemin vcvars dans `x.bat` si besoin.

## Build & run

`x.bat` encapsule vcvars + ffmpeg/bin sur le PATH runtime. Deux modes :

**GUI (défaut)** — preview/playback interactive + export. Rapproche le POC d'une intégration
app : le même compositeur/pipeline mesuré alimente une vraie boucle de rendu.

```
x.bat run --release [-- --fixture fixture --out out]
```

Fenêtre native : preview du compositing en lecture bouclée (swapchain DXGI flip, blit
zéro-copie du RT), sélecteur de preset C0→C8, Play/Pause, **Export** (barre de progression +
bilan _temps + fps_). Écrit `out/export.mp4`. Détail : [`technical-documentation/architecture/native-compositor.md`](../technical-documentation/architecture/native-compositor.md).

**Bench (§9/§10)** — la mesure fps headless, inchangée :

```
x.bat run --release -- --cfg C0..C8 --fixture fixture --repeat 3 --out out/
```

Produit `out/C{0..8}.mp4` (1080p60, 360 frames), `out/C{n}_f{60,180,300}.png`,
`out/report.json` + table markdown sur stdout.

## Fixture

Deux flux screen (le 2ᵉ simule une webcam HQ), 1080p60 CBP, 360 frames, coupés en `-c copy`.
Médias non versionnés (convention des autres POC) — provenance et commandes de régénération
dans `fixture/fixture.json`, qui est suivi.

## Docs

L'architecture du compositeur est documentée dans
[`technical-documentation/architecture/native-compositor.md`](../technical-documentation/architecture/native-compositor.md),
et les mesures qui l'ont choisie dans
[`technical-documentation/engineering/rendering-performance.md`](../technical-documentation/engineering/rendering-performance.md).
Ce README ne couvre que le build et le run de la crate. `spikes/` = les probes jetables
(Direct2D, NV12 render-target) conservés comme preuve.
