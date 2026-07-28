# S0 — R&D frameworks / moteurs de rendu

Décision *build vs. build-on*, position par défaut à réfuter : **D3D11 nu**. Un framework n'est adopté que s'il **gagne sur un critère éliminatoire** (K1/K2/K3), jamais sur le confort.

Machine : Ryzen 5 7520U / Radeon 610M (Vulkan `0x1506`) · Windows 11 · ffmpeg 8.1.2-full · MSVC 14.51 (VS18 Insiders) + Windows SDK 10.0.26100.

Critères : **K1** licence MIT-compat · **K2** interop zéro-copie DXVA/D3D11 ↔ AMF/MF · **K3** point d'extension shader (flou/ombre/masque/coins) · P1 contrôle boucle+synchro · P2 multiplateforme ultérieur · P3 poids build/dépendances.

---

## DÉCISION : `D3D11 nu` (windows-rs)

La stack par défaut du §2 est confirmée. **Aucun candidat ne fait basculer un critère éliminatoire** que D3D11 nu échoue. Rust 1.97.1 (msvc) installé, S1 a déjà prouvé la chaîne D3D11VA→AMF zéro-copie : le défaut fait tout le chemin, sans couche entre la mesure et le GPU (« le critère qui compte ici et nulle part ailleurs », §3).

Motifs d'élimination / non-adoption, chacun un critère + un fait :

- **libavfilter Vulkan — K2 ✗.** `hwmap` d3d11↔vulkan = `ENOSYS` ; seul le readback marche.
- **Direct2D — non adopté.** Passe K2 (BGRA) mais ne bat aucun critère du défaut, et son unique gain (E3/E4 natifs) contredit la prémisse §1/§2 « effets réécrits depuis les maths ». NV12 non ingéré. Gardé en échappatoire (ne possède pas la boucle, P1 intact).
- **GStreamer — non instruit, motivé.** (a) P1 : possède la boucle et la synchro → frontalement opposé au cœur méthodologique du §10 (mesurer *notre* soumission/attente). (b) K3 : `d3d11compositor` est fixed-function ; un shader custom impose un fork → défait le seul argument (« sur étagère »). Deux faits structurels, pas un README. Réversible : si P2 devenait éliminatoire, réinstruire par un pipeline `gst-launch`.
- **wgpu — non instruit, motivé.** Ne paie que P2 (portabilité), **pondéré, pas éliminatoire**, et hors périmètre d'un POC Windows-only jetable (§1). Son interop K2 (shared NT handle + fence) ajouterait précisément la couche de synchro entre la mesure et le GPU que le §3 dit de fuir. Décision produit prise (2026-07-17) : cross-platform hors scope → non instruit.

> Conformément au §3 : « Si la décision reste D3D11 nu, cette section n'a pas été inutile : elle a coûté quelques commandes et acheté le droit de ne plus se poser la question. »

---

## Grille

| candidat | K1 | K2 | K3 | statut | tranché par |
|---|---|---|---|---|---|
| **D3D11 nu** (windows-rs) | ✅ | ✅ | ✅ | **référence — à battre** | position par défaut (S1 a déjà prouvé la chaîne D3D11VA→AMF zéro-copie) |
| libavfilter Vulkan | ✅ | **✗** | ✅ | **ÉLIMINÉ** | spike : `hwmap` d3d11↔vulkan = `ENOSYS` |
| Direct2D / DirectComp | ✅ | ✅ | ✅ | **non adopté** (voir motif) | spike compilé : K2 ok, mais contredit §1/§2 |
| GStreamer | ✅ | ? | ? | à instruire | non installé |
| wgpu | ✅ | ? | ✅ | à instruire | attend Rust (install en cours) |
| Skia / Vello | ✅ | ? | ✗(Vello) | reporté | pré-jugé faible ratio coût/info (§3) |
| libobs, MLT/Olive/VSE, moteurs de jeu | ✗/P1 | — | — | éliminés d'office | GPL (K1) ou boucle non maîtrisée (P1) |

---

## 1. libavfilter Vulkan — ÉLIMINÉ (K2 ✗)

**Question §3 :** le `hwmap` d3d11va→vulkan sans copie existe-t-il sur cet iGPU, ou faut-il le `hwdownload,format=nv12,hwupload` qu'on fuit ?

**Spikes (ffmpeg 8.1.2, Vulkan présent : AMD Radeon 0x1506) :**

```
vulkan=vk@d3d       (dériver vulkan depuis d3d11) -> Device creation failed: -40 (ENOSYS)
d3d11va=d3d@vk      (dériver d3d11 depuis vulkan) -> -40 (ENOSYS)
opencl=ocl@vk       (contrôle)                    -> -40 (ENOSYS)
hwmap d3d11->vulkan (devices indépendants)        -> "Failed to configure output pad", -40
```

Le filtre lui-même **fonctionne** (chemin readback : `gblur_vulkan` fait chuter la netteté 9,75 → 1,46). Le seul maillon manquant est l'**interop zéro-copie** : ffmpeg n'implémente les maps Vulkan que pour vaapi/cuda/drm, **pas d3d11** — trou upstream, pas limite de l'iGPU.

> **Fait + critère :** alimenter les filtres Vulkan depuis le décodeur D3D11VA impose `hwdownload…hwupload`, c'est-à-dire le round-trip RAM que le POC existe pour supprimer. **K2 ✗.** Exactement ce que le §3 soupçonnait, confirmé par commande.

## 2. Direct2D / DirectComposition — NON ADOPTÉ (passe K2, mais contredit le §1/§2)

**Question §3 :** effets natifs Gaussian Blur / Shadow de qualité, interop D3D11 sans friction ?

**Spike compilé** (`spikes/d2d_probe.cpp`, MSVC + Windows SDK) :

```
d3d11_device=ok feature_level=0xB100        (= 11_1, exactement §2)
k2_d2d_shares_d3d11_device=ok               (ID2D1Device sur le MÊME ID3D11Device)
sharp_source=127.25
e3_gaussian_blur=ok sharp_after=0.28 ratio=0.002   (Gaussian natif : /500 de netteté)
e4_shadow=ok                                        (Shadow natif)
```

K2 ✅ **en BGRA** : les textures D3D11 sont emballées en `ID2D1Bitmap1` via `IDXGISurface` sur le device partagé — **zéro copie**. Et D2D **supprimerait E3+E4** (les deux effets coûteux) via `CLSID_D2D1GaussianBlur` / `CLSID_D2D1Shadow`.

**Nuance NV12 (le format réel du décodeur) :** emballer une texture `DXGI_FORMAT_NV12` en bitmap D2D échoue dans le probe — `nv12_as_d2d_bitmap=fail hr=0x88982F80` (`WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT`). D2D prend donc le BGRA sans friction mais **pas la sortie NV12 du décodeur telle quelle** : le chemin D2D-effets imposerait une conversion couleur en amont. Ça n'infirme pas K2 (le partage de device est prouvé) mais ça érode encore le « supprime du travail ».

> **Motif de non-adoption (critère + fait) :** Direct2D ne fait basculer **aucun** critère éliminatoire que D3D11 nu échoue — le défaut passe K1/K2/K3 par construction. Son seul gain est « supprimer E3/E4 », or le §1/§2 posent que **les effets sont réécrits depuis les maths** : c'est la raison d'être du POC (isolation de l'ancien paradigme). Adopter le Gaussian natif violerait cette prémisse.
>
> **Conservé comme échappatoire :** contrairement à GStreamer, D2D est une **bibliothèque** appelée sur notre propre device et notre propre boucle — il **ne possède ni la boucle ni la synchro** (P1 intact, §10 non menacé). Donc utilisable ponctuellement en S4 si le Gaussian séparable maison sous-performe, et sert de référence de qualité connue. Décision reportée à S4, pas un blocage.

## 3. À instruire

- **wgpu** (P2, « paie la suite ») — attend Rust (install en cours). K2 = interop via shared NT handle D3D11→D3D12/Vulkan + fence partagée : c'est le seul candidat qui rend Metal/VAAPI quasi gratuits. Spike : créer une texture D3D11, exporter un handle partagé, l'importer côté wgpu.
- **GStreamer** — non installé. Deux réserves avant même K3 : (a) `d3d11compositor` est *fixed-function* (position/scale/blend/alpha) — l'injection d'un shader custom (flou/ombre) est l'inconnue K3 ; (b) **P1 : GStreamer possède la boucle et la synchro**, ce que le §10 désigne comme la source d'erreur de mesure n°1. Un candidat qui, même en passant K3, se heurte au cœur méthodologique du POC.

## 4. Éliminés d'office (K1 / P1)

- **libobs** (GPLv2), **MLT / Olive / Blender VSE** : GPL → contaminerait la licence MIT cible. **K1 ✗**, sans instruction.
- **Moteurs de jeu (Bevy…)** : K3 ok mais **la boucle est à eux → P1 ✗**, hors sujet pour un POC dont l'objet *est* la mesure de la boucle.
