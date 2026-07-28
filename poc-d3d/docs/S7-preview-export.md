# S7 — Preview/playback + export (marche vers l'intégration app)

**Verdict.** Le POC n'est plus un batch qui écrit des MP4 : c'est une **app native**
qui *montre* le compositing en lecture temps réel et l'exporte sur un bouton, avec barre
de progression et bilan (**temps + fps**). Le compositeur et le pipeline mesurés (S2→S6)
sont réutilisés tels quels — la GUI est une couche autour, pas une réécriture.

## Ce que ça change (avant → après)

| | Avant (S6) | Après (S7) |
|---|---|---|
| Interface | CLI batch `--cfg C0..C8` | fenêtre native + CLI batch (conservée) |
| Voir le compositing | ouvrir les MP4/PNG produits | **preview bouclée temps réel** dans la fenêtre |
| Exporter | chaque run réencode tout | **bouton Export** → `out/export.mp4` |
| Retour d'export | table stdout | **barre de progression + bilan temps/fps** dans l'UI |
| Choix des effets | argument `--cfg` | **sélecteur C0→C8** (preview + export en direct) |

Lancement : `x.bat run --release` (défaut = GUI). Le bench headless reste `--cfg …`.

## Architecture (mono-thread, coopératif)

```
fenêtre hôte (Win32)
├─ enfant "preview"  ── swapchain DXGI flip (R8G8B8A8) sur le device D3D11 PARTAGÉ
│                        └─ chaque tick : compose_frame → blit_to(backbuffer) → Present(vsync)
└─ bande de contrôles natifs : combo preset · Play/Pause · Export · barre · label bilan
```

- **Un seul device D3D11**, celui de S2 : décodeurs, compositeur, encodeur ET la swapchain
  de preview le partagent. Le blit preview = une passe `ps_tex` (RT RGBA → backbuffer,
  letterboxé) — zéro conversion, zéro readback. Le backbuffer est en `R8G8B8A8_UNORM` pour
  matcher le RT (passthrough sans swizzle).
- **Contrôles Win32 natifs** (combo, boutons, `msctls_progress32`, label) : aucun rendu de
  texte maison. La swapchain vit sur un enfant dédié *sans* sous-fenêtre — condition du
  modèle flip (pas de contrôle par-dessus la surface flip).
- **Cadence playback** : `WM_TIMER` ~60 Hz, avance des frames source par **horloge murale**
  (accumulateur 1/60 s, garde anti-spirale). Boucle sur EOF par `av_seek_frame(0)` +
  `avcodec_flush_buffers` — zéro réallocation de décodeur (la fixture démarre sur un IDR, §11).

## Export : progression sans trahir la mesure (§10)

L'export réutilise `run_composited` (le chemin C1→C8 mesuré). Le fps affiché **reste la
mesure enveloppante** de §10 : une lecture d'horloge avant/après tout le run, rien
d'instrumenté dans la boucle. La barre est alimentée par une sonde `progress(frames)`
appelée par frame mais **throttlée au pourcent** — un `SendMessage(PBM_SETPOS)` (µs)
négligeable devant ~8 ms/frame GPU. Côté bench la sonde est un no-op → **chiffres identiques**
(vérifié : C0 237, C4 136, C8 135 fps, cf. S6).

L'export tourne sur le thread UI **sans re-pomper** le message-loop (pas de réentrance
wndproc → pas d'aliasing `&mut`). La barre et le label se rafraîchissent par
`UpdateWindow` sur *leur* contrôle (repaint synchrone, hors de notre wndproc). Sur la
fixture (~2,7 s en release) la fenêtre reste sous le seuil « Not Responding ».

Bilan affiché à la fin : `Done — C8 · 360 frames · 2.67s · 134.9 fps -> out/export.mp4`.

## Ce que ça démontre pour l'intégration app

L'app OpenScreen (Electron) a besoin, d'un module natif, exactement de ces deux surfaces :
**(1)** un flux de frames composées présentable dans un viewport (preview), **(2)** un export
piloté avec progression et bilan. S7 prouve que le fast-path D3D11 les sert *depuis le même
device*, sans copie CPU — le module natif exposerait `present()` / `export(on_progress)` en
miroir de `blit_to` / `run_composited(progress)`.

## Restes ouverts (hors périmètre POC)

- **Frontière FFI** vers l'hôte (Electron/N-API ou fenêtre embarquée) — ici la fenêtre est
  autonome Win32.
- **Preview redimensionnable / DPI** : fenêtre à taille fixe (letterbox déjà géré) ; un vrai
  intégrant ferait `ResizeBuffers` sur `WM_SIZE`.
- **Sources dynamiques** : la timeline reste celle, figée, de la fixture (S1) ; l'intégration
  brancherait les vraies pistes.
- **Export cancel/threadé** : suffisant en coopératif pour la fixture ; un export long
  voudrait un worker + `PostMessage` de progression.
