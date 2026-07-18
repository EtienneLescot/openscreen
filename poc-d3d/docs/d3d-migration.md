# Migration propre : ai-edition → compositeur D3D

But : **une seule preview (D3D), parité fonctionnelle complète, zéro fixture POC.**
On garde les primitives GPU (elles sont prouvées, C0–C8), on supprime tout ce qui est
spécifique à la fixture (animation layout codée en dur, boucle 6s, `cursor.json` fixture,
`fixture_dir` + fallbacks), on branche les vrais effets/paramètres de l'app dessus, et on
supprime l'ancienne preview web (DOM/Pixi).

Statut colonne « Primitive D3D » :
- **✅ a** = la primitive existe et rend déjà (il reste à la paramétrer depuis l'app).
- **⚙️ param** = primitive présente mais valeur codée en dur (fixture) → à exposer.
- **🆕 neuf** = à ajouter (nouvelle passe/logique GPU).

---

## 1. Barre latérale (inspector) — `EditorSettingsSnapshot` (`legacyEditor`)

### Background (`BackgroundPane`)
| Param | Type / valeurs | Sémantique app | Primitive D3D |
|---|---|---|---|
| `wallpaper` (couleur) | `#rrggbb` | fond plat derrière le screen | ✅ a (`bg_color`) |
| `wallpaper` (gradient) | `linear-gradient(deg, c1, c2, …)` | fond dégradé | 🆕 neuf (shader lerp N stops + angle) |
| `wallpaper` (image) | chemin `/wallpapers/…` ou `data:` | fond image | 🆕 neuf (upload texture + draw quad) |
| `aspectRatio` | `16:9` \| `native` \| … | ratio du cadre de sortie | 🆕 neuf (OUT_W/H dérivés du ratio, aujourd'hui figé 1920×1080) |

### Visual effects (`VideoEffectsPane`)
| Param | Type | Sémantique | Primitive D3D |
|---|---|---|---|
| `showBlur` | bool | fond = screen flouté | ✅ a (dual-Kawase) |
| `motionBlurAmount` | 0..1 | flou de mouvement | ✅ a (supersample temporel) — mais aujourd'hui *motion de layout* seulement ; à étendre au mouvement de contenu |
| `shadowIntensity` | 0..1 | ombre portée écran/webcam | ✅ a (`shadow_scale`) |
| `borderRadius` | px | coins arrondis écran | ⚙️ param (px absolu, pas ×base fixture) |
| `padding` | 0..100 | marge autour du screen | ✅ a (`padding`) |
| `cropRegion` | {x,y,w,h} 0..1 | recadrage source écran | 🆕 neuf (src rect du screen) |

### Layout / webcam (`LayoutPane`)
| Param | Type | Sémantique | Primitive D3D |
|---|---|---|---|
| `webcamLayoutPreset` | `picture-in-picture` \| `dual-frame` \| `vertical-stack` \| `no-webcam` | placement écran/webcam | ⚙️ param PiP (✅) + 🆕 side-by-side / top-bottom / no-webcam (la primitive de layout animé C6 existe) |
| `webcamSizePreset` | 10..50 % | taille webcam | ✅ a |
| `webcamMirrored` | bool | miroir horizontal | ✅ a |
| `webcamMaskShape` | rect \| circle \| square \| rounded | forme webcam | ✅ a |
| `webcamPosition` | {cx,cy} 0..1 | position webcam (drag) | 🆕 neuf (placement libre au lieu du coin fixe) |
| `webcamReactiveZoom` | bool | webcam rétrécit pendant un zoom | 🆕 neuf (lie taille webcam au zoom actif) |

### Cursor (`CursorPane`)
| Param | Type | Sémantique | Primitive D3D |
|---|---|---|---|
| `cursorShow` | bool | afficher le curseur | ✅ a (`cfg.cursor`) |
| `cursor.size` | échelle | taille | ✅ a (`cursor_size_scale`) |
| `cursor.clickBounce` | échelle | rebond au clic | ✅ a (`cursor_bounce_scale`) |
| `cursor.motionBlur` | 0..1 | traînée curseur | ⚙️ param (fantômes existent, liés à `mblur_n` ; à exposer) |
| `cursor.smoothing` | 0..1 | lissage trajectoire | 🆕 neuf (filtrage de `CursorTrack.at`) |
| `cursor.clipToBounds` | bool | clip au cadre écran | 🆕 neuf |
| `cursorTheme` | id | jeu de sprites curseur | 🆕 neuf (atlas sprites + sélection ; aujourd'hui anneau générique) |
| **télémétrie** | fichier/telem | positions réelles du curseur | 🆕 neuf (mapper la télémétrie app → `CursorTrack`, pas la fixture) |

### Divers (pas de rendu compositeur)
| Param | Rôle |
|---|---|
| `showTrimWaveform` | affichage waveform sur la piste trim (UI timeline) |
| `autoFocusAll` | génération auto de zooms (édition, pas rendu) |

---

## 2. Timeline — effets & régions

| Effet | Stockage | Champs | Sémantique | Primitive D3D |
|---|---|---|---|---|
| **Cut / trim** | `timeline.trimRanges[]` | assetId, startSec, endSec | retirer un segment | ✅ a (déjà reflété par les clips de l'export multiclip) |
| **Clips** | `timeline.clips[]` | assetId, source[Start/End]Sec, timeline[Start/End]Sec, cropRegion | multiclip + trims + ordre | ✅ a (export multiclip) — à étendre au **preview** |
| **Zoom** | `zoomRanges[]` | startMs, endMs, **depth 1..6**, **focus {cx,cy}**, focusMode auto/manual, **rotationPreset iso/left/right**, customScale | zoom animé sur un point | ⚙️ param (zoom+focus animés existent) + 🆕 rotation (iso/left/right) |
| **Speed** | `timeline.speedRanges[]` | startMs, endMs, **speed** | accélère/ralentit un segment | 🆕 neuf (cadence de décodage/sortie + audio) |
| **Annotation texte** | `annotations[]` type=text | content, position %, size, style, timing | overlay texte | 🆕 neuf (rendu texte) |
| **Annotation image** | `annotations[]` type=image | imageContent, position, size, timing | overlay image | 🆕 neuf (texture) |
| **Annotation figure** | `annotations[]` type=figure | figureData, … | flèche/forme | 🆕 neuf |
| **Annotation blur** | `annotations[]` type=blur | blurData, position, size, timing | flou d'une zone | 🆕 neuf (blur localisé) |
| **Caption** | `timeline.captionRanges[]` | startSec, endSec | sous-titres | 🆕 neuf (texte timé) |
| **Camera fullscreen** | régions | startMs/endMs | webcam grandit pour remplir | 🆕 neuf (layout animé webcam) |
| **Mute** | `timeline.muteRanges[]` | startSec, endSec | couper l'audio | audio (hors compositeur vidéo) |
| **Gaps** | `timeline.gaps[]` | — | trous timeline | ⚙️ (tenue de frame / noir) |

---

## 3. Primitives D3D à GARDER (compose_frame / passes GPU)
composite 2 sources · coins arrondis (SDF) · ombre portée · fond flouté (dual-Kawase) ·
zoom animé + focus · **layout paramétrable** (aujourd'hui A↔B fixture — à généraliser aux
presets) · curseur (dot+ring, bounce, fantômes motion-blur — à généraliser sprites+télémétrie) ·
flou de mouvement (supersample temporel) · encode h264_amf · export mono/multiclip.

## 4. Scaffolding fixture à SUPPRIMER (n'appartient qu'au POC)
- `compositor.rs::timeline()` — planning A↔B + zoom **codés en dur** → remplacé par des params pilotés par l'app (layout preset, zoom regions).
- `FIXTURE_FRAMES` (boucle 6s) et toute la logique de bouclage fixture.
- `fixture_dir()` + fallbacks fixture dans `create_view`/`export` (napi).
- fixture `poc-d3d/fixture/*` (screen.mp4, webcam.mp4, screen.cursor.json) — hors app.
- Harnais `--live` / `--export` fixture (rester dev-only, hors chemin app).
- Fallback « fixture » de l'overlay/hook côté TS.

## 5. Ancienne preview web à SUPPRIMER (après parité)
`PreviewCanvas` / `VirtualPreview` / `WebcamOverlay` / `CursorPreviewLayer` (Pixi) /
`ZoomFocusOverlay` / `AnnotationOverlay` / `PreviewCompositor` — une fois la parité D3D atteinte,
la preview DOM disparaît (le natif devient la seule surface).

---

## 6. Phases proposées
- **P0 — Nettoyage fixture** : retirer `timeline()` fixture, `FIXTURE_FRAMES`, `fixture_dir`, fallbacks. Le compositeur ne rend plus QUE ce que l'app lui décrit (layout/zoom/curseur pilotés). Rien de visible tant que les params ne sont pas branchés → à faire avec P1.
- **P1 — Contrat de scène** : un descripteur « scène » app → natif (clips + trims + layout preset + webcam pos/size/shape/mirror + bg + effets frame + zoom regions + curseur telemetry/theme), pour preview ET export, partagé.
- **P2 — Parité rendu** (par ordre de valeur) : layout presets · bg gradient/image · zoom regions (focus/depth/rotation) · curseur télémétrie+thèmes · crop · webcam position/reactive-zoom · speed · annotations/captions · camera-fullscreen.
- **P3 — Preview multiclip natif** (playhead pilote la scène) puis **suppression de la preview web**.
- **P4 — Params d'export** (fps/taille/codec + downscale/upscale) sur le moteur multiclip.

> Note perf (contrainte) : tout passe par décodage séquentiel + seek keyframe aux frontières,
> primitives GPU inchangées → l'objectif ~120fps export tient.
