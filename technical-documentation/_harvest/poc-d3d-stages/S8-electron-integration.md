# S8 — Intégration Electron (Option A) + mesures d'export

**Verdict.** Le compositeur natif tourne **dans la vraie app OpenScreen** : la preview D3D est
embarquée dans l'éditeur, pilotée par des contrôles React, et l'export natif conserve le débit
du bench dès qu'on désactive la preview pendant le rendu. L'archretenue (annexe D.6) tient bout
à bout, du binaire à l'app.

## La chaîne (prouvée vivante dans l'éditeur)

```
contrôle React (case/bouton)
  → IPC native-bridge (domaine "compositor")
  → service (charge compositor_view.node) → addon napi-rs
  → poc_d3d::live::LiveView (fenêtre D3D) / pipeline::run_composited (export)
```

- **Addon napi-rs** (`compositor-view-napi/`, membre du workspace) : `createView/setRect/
  setParam/setPlaying/destroyView/export`, enveloppe `LiveView` + `run_composited`.
- **Glue TS** : domaine `compositor` du native-bridge (service + IPC + client) + hook
  `useNativeCompositorView` (sync du rect DOM) + `NativeCompositorOverlay`.

  > **Périmé depuis.** À l'époque de S8, l'overlay était monté dans `Preview.tsx` derrière
  > un opt-in `VITE_NATIVE_COMPOSITOR=1`. Les deux ont disparu : `NativeCompositorOverlay`
  > est monté **inconditionnellement** par `PreviewCanvas` (« no more dual preview path »),
  > et **plus aucun code ne lit cette variable** — la passer n'a aucun effet. Lancer l'app
  > en dev, c'est `npm run dev`, rien de plus. Les `<video>` restent montés mais masqués en
  > CSS : ils servent au décodage, à l'horloge de lecture et aux métadonnées, pas à
  > l'affichage.

## Le point dur résolu : airspace Chromium

Une fenêtre **enfant** (`WS_CHILD`) dans la `BrowserWindow` est **occultée par le compositeur
GPU de Chromium** (créée + « visible » mais dessinée par-dessus). Solution : une fenêtre
**top-level owned** (`WS_POPUP`, `WS_EX_NOACTIVATE|TOOLWINDOW`), positionnée en coords écran par
le thread de rendu (`ClientToScreen(parent) + rect viewport`, suit le déplacement du parent). Une
fenêtre *sœur* n'est pas dans la surface Chromium → pas d'occultation. Confirmé à l'écran.

## Mesures d'export (C8, tous effets, 360 frames 1080p60)

| Contexte | fps | wall | note |
|---|---|---|---|
| Bench headless (isolé) | ~135 | 2.7 s | référence S6/S7 |
| Addon, app **fermée** (isolé) | **125** | 2.9 s | l'addon/napi/AsyncTask n'ajoute **aucun overhead** |
| Addon, app ouverte, **preview active** | **72–77** | ~4.8 s | contention GPU (moteur 3D partagé preview↔export) |
| Addon in-app, **preview auto-pausée** (mesuré UI) | **117** | ~3.1 s | ~94 % de l'isolé ; reste = compositing UI Chromium |

**Conclusion.** Le chemin d'export natif ne change rien (isolé = bench). La seule perte vient de
la **preview concurrente** (contention GPU pure, pas du code) ; on la récupère en **désactivant la
preview pendant le rendu** — `export()` met automatiquement `set_playing(false)` sur les previews
le temps du run (leur thread cesse de composer/présenter), puis les réactive. Résultat in-app :
**117 fps**, soit *les mêmes perfs que le bench* à la marge Chromium près.

Jumeau natif de l'annexe C.3 / §8 : « moteurs GPU en recouvrement, pas de gain à empiler des
charges 3D concurrentes » — ici, une preview 60 fps + un export plein régime se disputent le
moteur 3D, d'où le ×2 ; les séparer (preview off) rend le débit plein.

## Restes ouverts (vers Phase 2)

- Alignement rect / letterbox de l'overlay (preview plus haute que 16:9), transitoire au resize.
- **Paramétrage complet** : remplacer le `Cfg` C8 figé + `timeline()` figée par une **scène par
  frame** fournie par l'app (inspector : coins/ombre/zoom/padding/blur/fond ; timeline :
  `presentTime` pour seek/playhead ; multiclips ; position webcam ; annotations).
