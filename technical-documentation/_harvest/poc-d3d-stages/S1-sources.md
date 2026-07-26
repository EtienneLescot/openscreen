# S1 — Sources, chaîne matérielle, fixture

Statut : **critère de sortie atteint.** Codec / range / fps consignés ci-dessous ; `out/smoke_*.mp4` produits sans `hwdownload`.

Machine : Ryzen 5 7520U / Radeon 610M · Windows 11 · ffmpeg 8.1.2-full (gyan).

---

## 1. Ce que sont réellement les sources

Corpus : `C:\Users\camil\AppData\Roaming\openscreen\recordings` — 61 paires screen + `-webcam`.

Tout est déjà en **H.264**, y compris les `.webm` (conteneur WebM avec H.264 dedans, signature MediaRecorder/Chromium). L'hypothèse D3D11VA du §2 tient donc : pas de VP9/AV1 à gérer.

| | screen | webcam (réelle) |
|---|---|---|
| conteneur | `.mp4` (récents) / `.webm` (anciens) | `.webm` puis `.mp4` |
| codec | h264 | h264 |
| profil | **Constrained Baseline** (cs1=1), level 4.2 | **Baseline** (cs1=0), level 3.2 |
| résolution | 1920×1080, parfois 1920×1032 | 640×480 |
| fps | **60 CFR** | **~30 VFR** |
| `color_space` / `color_range` | **non taggés** | `bt709` / `tv` |

---

## 2. E1 — la matrice, décidée par la mesure

Le §4 prévenait : « une capture d'écran est souvent en full range → image délavée si on suppose limited ». **La mesure dit le contraire.**

Le screen ne tague ni `color_space` ni `color_range` : impossible de lire, il faut mesurer. `signalstats` seul est trompeur (YMIN=13, YMAX=242 — ni limited propre ni full propre), parce que les extrêmes sont dominés par le ringing du codec. L'histogramme du plan Y brut tranche, sur 3 enregistrements × 12 frames :

```
argmax = 235 partout          <- pic à 21-71% des pixels : le blanc de l'UI
Y = 255  : 0.000%  partout    <- aucun pixel au point blanc full range
Y > 242  : 0.0000% partout    <- la queue 236..242 décroît 36929 -> 1 : du ringing
Y < 16   : ~0%                <- plancher limited
```

La webcam, qui **déclare** `tv`/bt709, montre la même signature (argmax=235, rien au-dessus de 242). Le screen se comporte exactement comme un flux qui déclare limited. ffmpeg lui-même tague sa sortie `d3d11(tv, progressive)`.

> **Décision : BT.709 limited/tv pour les deux sources. Une seule matrice en dur, pas deux.**

---

## 3. La chaîne matérielle — et le piège qu'elle cache

La commande du §4 passe :

```
ffmpeg -hwaccel d3d11va -hwaccel_output_format d3d11 -i <screen> -c:v h264_amf -b:v 8M smoke.mp4
→ 3864 frames, 250 fps, 4.16x temps réel
```

Le verbose confirme le chemin zéro-copie complet :

```
Selecting decoder 'h264' because of requested hwaccel method d3d11va
[h264] Reinit context to 1920x1088, pix_fmt: d3d11
[enc:h264_amf] Using input frames context (format d3d11) with h264_amf encoder.
[AMF] AMF initialisation succeeded via D3D11.
```

### 3.1 La webcam réelle ne décode PAS en matériel — et échoue silencieusement

```
[h264] Decoder GUIDs reported as supported:   (20 GUIDs, dont 1b81be68-… = DXVA2_ModeH264_E)
[h264] No decoder device for codec found
[h264] Failed setup for format d3d11: hwaccel initialisation returned error.
[h264] Reinit context to 640x480, pix_fmt: yuv420p        <-- SOFTWARE
```

**Et le fichier de sortie est quand même produit.** Un critère de sortie formulé « `smoke.mp4` existe » aurait validé une chaîne à moitié logicielle. C'est le mode d'échec à retenir : ffmpeg retombe en software sans code d'erreur.

Isolation des trois différences (conteneur / résolution / profil) :

| test | flux | résultat |
|---|---|---|
| remux `.webm`→`.mp4`, bitstream intact | Baseline 640×480 | `No decoder device` → **software** |
| ré-encode **Constrained Baseline**, 640×480 | CBP | `pixfmt:d3d11` ✅ |
| ré-encode **High**, 640×480 | High | `pixfmt:d3d11` ✅ |

Ni le conteneur ni la résolution. **C'est le profil, et rien d'autre.**

### 3.2 Cause racine : un bit dans le SPS

Les deux flux ont `profile_idc = 66`. Toute la différence :

| | screen (✅) | webcam (❌) |
|---|---|---|
| `profile_idc` | 66 | 66 |
| **`constraint_set1_flag`** | **1** | **0** |
| `constraint_set0_flag` | 1 | 0 |
| `constraint_set5_flag` | 0 | 1 |
| `level_idc` | 42 | 32 |
| chaîne codec | `avc1.42C02A` | `avc1.420420` |

*Constrained Baseline* est **défini** par `profile_idc==66 && constraint_set1_flag==1`. Sans ce bit, le flux déclare du Baseline nu (FMO / ASO / slices redondantes autorisées) : DXVA n'expose aucun GUID pour ça, d'où `No decoder device` malgré un décodeur H.264 bien présent.

> **Action côté capture (hors POC) :** le screen et la webcam ne sortent pas du même encodeur — même app, même run, mais CBP/4.2 en MP4 d'un côté, Baseline/3.2 en WebM de l'autre. Faire émettre `constraint_set1_flag=1` à la webcam (`avc1.42E01E`), ou passer en Main/High (`avc1.4D…` / `avc1.64…`), tous deux vérifiés ici.
>
> Tant que ce n'est pas fait, **toute webcam réelle décodera en software** sans le dire.

### 3.3 Deux autres réglages de capture à corriger

- **Tagger les couleurs du screen** (`bt709` / `tv`). Elles sont justes mais implicites : aujourd'hui il faut mesurer pour les connaître.
- **Webcam VFR** : ~30 fps avec jitter (14→56 ms) et un trou mesuré à **191 ms** (frames droppées à la capture). Contre 60 CFR pour le screen.

---

## 4. Fixture gelée

Le §4 demandait la vraie webcam. **Écarté sur décision produit :** on utilise **deux flux screen**, le second simulant une webcam HQ. Ce n'est pas un contournement du problème du §3.2 — c'est un meilleur banc :

- les deux sources sont **déjà CBP cs1=1** → D3D11VA des deux côtés, aucun transcode, aucun bitstream touché ;
- les deux sont **déjà 60 CFR** → 360 frames chacune, appariement 1:1, le VFR sort de l'équation ;
- **deux décodes 1080p60** au lieu d'un 1080p60 + un 480p30 → le cas le plus lourd, la mesure penche du bon côté ;
- une « webcam » à contenu net révèle bien mieux le masque, les coins et le flou (§11) qu'un visage flou en 640×480.

| | `fixture/screen.mp4` | `fixture/webcam.mp4` |
|---|---|---|
| origine | `recording-1783845220910.mp4` @ **t=100 s** | `recording-1783894784128.mp4` @ **t=428 s** |
| profil | Constrained Baseline, cs1=1, L4.2 | Constrained Baseline, cs1=1, L4.2 |
| résolution | **1920×1080** | 1920×1032 → center-crop 1032² |
| fps / frames | 60 CFR / **360** | 60 CFR / **360** |
| décode | `pixfmt:d3d11` ✅ | `pixfmt:d3d11` ✅ |
| contenu | scroll de page GitHub plein écran | fenêtre Claude Code, texte défilant |

Coupée en **`-c copy` sur IDR** (GOP = 60, keyframe à chaque seconde entière) : le bitstream est exactement celui de la capture. Ré-encoder la fixture changerait sa complexité et ferait mesurer à C0 le décodage de *notre* encodage — pas celui du produit.

Throughput indicatif, décode+encode matériel, **une seule source**, boucle ffmpeg (donc **pas** un chiffre publiable au sens du §10) : screen 209-214 fps (spread 2,7 %), webcam 224-225 fps (spread 0,4 %). C0 en aura deux à décoder.

---

## 5. Réserves ouvertes pour la suite

1. **Surface décodeur 1088, pas 1080.** `Reinit context to 1920x1088` : alignement macrobloc (68×16). La source « webcam » 1032 donnera 1040. Les SRV échantillonnent une texture plus haute que l'image utile — à corriger dans les UV, sous peine d'une bande en bas. (§5)

2. **Le corpus est intrinsèquement peu animé, et ça biaise le delta C5→C6.** Le contenu se rafraîchit à ~10-15 fps effectifs sous une capture 60 CFR : ~80 % des frames sont des doublons, y compris dans la meilleure fenêtre disponible (scan exhaustif : 17 fichiers, toutes les fenêtres de 6 s — rien ne descend sous 77 % de doublons). Conséquence : de C0 à C5 la sortie est quasi statique et `h264_amf` sort des frames minuscules ; dès C6 le zoom animé fait bouger toute l'image à chaque frame et le coût d'encodage explose (~68 → 360 frames « lourdes »). **Le delta C5→C6 mélangera donc le shader de zoom et le réveil de l'encodeur.** Le breakdown `--profile detail` du §10 le désambiguïsera (le saut apparaîtra dans `encode`, pas dans `comp`) — mais la lecture « delta = coût de la couche » du §9 mérite une note à cette ligne.

3. **ffmpeg GPL.** Le build gyan installé est `--enable-gpl --enable-version3` : bon pour ces spikes en ligne de commande, **incompatible K1** pour un lien dans une app MIT. Le POC devra lier un build LGPL (sans `--enable-gpl`) en dynamique. À traiter en S0/S2, pas ici.
