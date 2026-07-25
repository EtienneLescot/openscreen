# feat/ai-edition — spec de remédiation

Suite de [main-vs-ai-edition-audit.md](main-vs-ai-edition-audit.md). Ce document est la
spec d'implémentation : quatre lots à causes distinctes, à traiter sur une branche neuve
partant de `feat/ai-edition`.

Convention de statut :
**[C]** cherry-pick depuis la branche parquée · **[N]** à écrire · **[M]** à mesurer avant
de décider.

## État au 2026-07-25

Livré sur `claude/ai-edition-remediation` : **lot 1 en entier** (1.1 à 1.5), **lot 2 en
entier** (2.1 réordonnancement, 2.2 mixage audio natif, 2.3 annotation vide), **3.1**
vitesse libre et **3.2** bascule focus zoom. Validation : `tsc` propre, `biome` propre,
423 tests front + 25 tests Rust verts, dont 15 nouveaux.

Reste ouvert : **3.3** rotation de zoom, **3.4** zoom réactif webcam, **3.5** annotations
non-texte, le **lot 4** (arbitrage produit), et les trois différés — MSIX, #120 playhead,
#127 partie 2.

Deux points ne sont **pas** vérifiés en application, faute de projet enregistré sous la
main : le pane vitesse et le pane focus zoom (il faut une région sélectionnée), et l'export
d'un enregistrement multipiste réel. Le reste de la validation est statique + tests.

La branche parquée `claude/rebase-ai-edition-main-c65d0d` (PR #154) a été **vidée de ce
qu'on en voulait** : elle peut être fermée sans merge. Ses deux commits de portage #109
(exporteur navigateur) ne sont pas repris — 2.2 les remplace côté Rust.

---

## Lot 1 — Correctifs partagés venus de main (risque faible)

Cinq bugs corrigés sur main, toujours vivants chez nous. Le code concerné est quasi
identique entre les deux branches : ce sont des cherry-picks, déjà faits et compilés sur
`claude/rebase-ai-edition-main-c65d0d` (PR #154).

| # | Symptôme | Fix | Statut |
| --- | --- | --- | --- |
| 1.1 | Enregistrer une **fenêtre** aux dimensions client impaires → vidéo entièrement noire. H.264 exige des dimensions paires ; `CopyResource` no-op silencieusement sur écart de taille. | `roundUpToEven()` dans `WgcSession::createCaptureItem(HWND)`, utilisé pour le frame pool **et** `captureWidth/Height()`. Capture moniteur intouchée. | **[C]** PR #122 |
| 1.2 | Sous encodeur **logiciel**, l'arrêt de l'enregistrement peut ne jamais aboutir : `WriteSample` bloquant tenu sous le mutex partagé affame le thread principal qui attend `stopRequested`. | Scinder en `captureVideoSample` (sous mutex) / `submitVideoSample` (hors mutex). | **[C]** PR #119 |
| 1.3 | Filet de sécurité du précédent : l'attente par frame du writer n'a pas de timeout, une notification manquée fige le `join()`. | `wait_for(100ms)` dans la boucle frame. | **[C]** PR #123 |
| 1.4 | **Linux/Wayland** : l'enregistrement ne produit aucune frame exploitable (`EGL_BAD_MATCH`, renégociation DMA-BUF). Chromium initialise Vulkan, incompatible avec le backend Ozone Wayland. | `appendSwitch("disable-features", "Vulkan")` sous Wayland, dans `electron/main.ts`. | **[C]** PR #91 |
| 1.5 | Déplacer le HUD par sa poignée : la fenêtre **dérive** au lieu de suivre le curseur. Deux canaux IPC repositionnent la fenêtre (delta de drag + recalage d'ancre du `ResizeObserver`) et se composent. | Geler la mesure de taille pendant le drag (`isDraggingHudRef`), re-mesurer une fois au relâchement. | **[C]** PR #125 + son test |

**Point d'attention unique** : `main.cpp` (1.2/1.3) demande un merge à la main — ai-edition
a sa propre cadence CFR webcam sur horloge réelle, qu'il faut préserver en n'important que
le découpage capture/submit. Ce merge est déjà fait et compilé sur la branche parquée.

**Validation lot 1** : rebuild natif, puis enregistrement avec webcam (synchro A/V en fin de
vidéo, pause/reprise, stop immédiat) + capture d'une fenêtre redimensionnée en dimensions
impaires (vérifier l'absence de frames noires).

---

## Lot 2 — Bugs propres à ai-edition (le cœur du sujet)

### 2.1 — Le playhead revient en arrière à la jonction, après réordonnancement **[N]**

**Symptôme (rapporté).** En multi-clips le playback enchaîne sans pause. Après avoir changé
l'ordre des clips, la tête de lecture s'arrête à la jonction et revient au début du clip
qu'elle vient de parcourir. Reproduit avec **deux assets distincts**.

**Cause.** Staleness de closure dans `VirtualPreview.tsx`.

- `seekToVirtualTime` est un `useCallback` de deps `[clips, videoSources, sourceIndex, updateVirtualTime]`
  (ligne 440) : nouvelle identité **à chaque réordonnancement**.
- La boucle rAF (ligne 183) est délibérément re-créée **uniquement** sur
  `[activeSource?.id]`, avec un `biome-ignore useExhaustiveDependencies`.
- Tout ce que lit le `tick` passe par des refs tenues à jour (`clipsRef.current`,
  `virtualTimeSecRef.current`) — **sauf `seekToVirtualTime`**, appelé directement depuis
  la closure (lignes 289 et 315).

Enchaînement : le `tick` détecte correctement la fin de clip et calcule le bon clip suivant
via `findNextClipByTimelineOrder(clipsRef.current, …)` — données **fraîches**. Puis il
appelle un `seekToVirtualTime` **figé sur l'ordre d'avant le réordonnancement**, qui résout
`nextClip.timelineStartSec` contre l'**ancien** layout via `locateVirtualPosition(clips, …)`
et retombe donc sur le clip qui occupait cette position avant — celui qu'on vient de jouer.
D'où le retour au début.

Sans réordonnancement, ancien et nouveau tableau sont identiques : aucun symptôme. C'est
exactement le conditionnement observé. `sourceIndex` est stale lui aussi, mais s'auto-guérit
(un changement d'asset re-crée la rAF) ; l'ordre des clips, non.

**Pourquoi c'est intermittent.** Le handler `onEnded` (ligne 549) fait le même enchaînement
mais depuis le JSX, donc avec une closure **fraîche** — il est correct. Pour un clip **non
trimé**, la fin de fichier coïncide avec la fin de fenêtre timeline et `ended` gagne la
course contre le rAF → pas de bug. Pour un clip **trimé**, seul le rAF déclenche → bug.

**Fix.** `seekToVirtualTimeRef` **existe déjà** (ligne 462) mais n'est consommé que par
l'effet `seekTarget`. Remonter sa déclaration au-dessus de l'effet rAF et faire appeler
`seekToVirtualTimeRef.current(…)` par le `tick` (lignes 289 et 315). Cela préserve
l'intention d'origine — ne pas re-créer la rAF à chaque rendu — en supprimant la staleness.

**Non-régression.** Le commentaire ligne 451 documente pourquoi les deps avaient été
retirées : les remettre ferait rejouer un ancien `seekTarget` et figerait la lecture. Le
passage par ref est précisément la solution déjà retenue là-bas ; on l'étend au rAF.

**Statut de la preuve.** Mécanisme établi par lecture du code, **non reproduit en live**. À
confirmer avant de considérer le lot fermé.

**Validation** : deux clips **trimés** issus de deux assets → lire, vérifier l'enchaînement ;
réordonner → relire, vérifier l'enchaînement ; refaire avec des clips non trimés (chemin
`ended`, doit rester correct) ; scrub manuel puis lecture (chemin `seekTarget`, ne doit pas
régresser).

### 2.2 — Le micro est absent de l'export **[N]**

**Symptôme.** Les enregistrements natifs macOS écrivent audio système et micro en **deux
pistes AAC séparées**, toutes deux marquées `default`. Si rien ne joue sur le système, la
première piste est silencieuse — et c'est celle qui est exportée. Le micro est perdu.

**Cause chez nous.** `poc-d3d/src/audio.rs:177` — `decode_clip_audio_inner` appelle
`av_find_best_stream(…AVMEDIA_TYPE_AUDIO…)` et ne décode **qu'une seule** piste. C'est
exactement le bug #108, mais dans l'exporteur **natif**.

**Ce qui n'est pas la solution.** Le correctif de main (#109) vit dans l'exporteur
navigateur (`videoExporter` / `audioEncoder` / `streamingDecoder`), chemin que
`ExportDialog` n'emprunte plus (`ExportDialog.tsx:289` → `exportMultiNative`). Les deux
commits correspondants de la branche parquée sont **à jeter**.

**Fix.** Réimplémenter en Rust dans `audio.rs` : énumérer **toutes** les pistes audio du
conteneur, décoder chacune, les sommer alignées sur leur offset temporel, downmix vers le
format cible, clamp `[-1, 1]`. Miroir de `mixPlanarSources` côté main, dont la logique et
les cas de test sont réutilisables tels quels comme spec.

**Validation** : export d'un enregistrement natif macOS multipiste → le micro est audible.
Un enregistrement mono-piste doit rester bit-identique au comportement actuel. Test unitaire
Rust sur la sommation (piste silencieuse + tonalité → tonalité présente).

### 2.3 — L'annotation texte naît remplie **[C]**

**Symptôme.** Une nouvelle annotation texte est créée avec `"New annotation"` en dur
(`useTimeline.ts:259`). Le placeholder de l'inspecteur ne s'affiche jamais et la saisie
s'ajoute derrière le texte existant.

**Fix.** `content: ""` / `textContent: ""`, ajouter le `placeholder` sur le champ, et
sélectionner l'annotation fraîchement créée (une annotation vide ne rend rien : sans
sélection elle serait invisible et non cliquable). Déjà fait sur la branche parquée.

---

## Lot 3 — Capacités présentes mais non câblées au shell V4

Aucune ne vient de main. Ce sont des contrôles perdus au passage à l'éditeur V4 : la
logique est là, l'UX a disparu avec les conteneurs démontés (`RightPanelStack`,
`Bottombar`, `TimelinePane`, ~2600 lignes plus montées).

| # | Manque | Ce qui existe déjà | Effort |
| --- | --- | --- | --- |
| 3.1 | **Vitesse plafonnée à 3×** : `FloatingInspector.tsx:275` propose un `<select>` `[0.5 … 3]`. | `MAX_PLAYBACK_SPEED = 100` et `MAX_NATIVE_PLAYBACK_RATE = 16` (`types.ts:384/388`) ; l'UX select + champ libre + avertissement au-delà de 16× vit dans `RightPanelStack.tsx:672-696`, non monté. | faible — récupérer l'UX, la brancher sur l'inspecteur V4 |
| 3.2 | **Pas de bascule zoom auto / manuel** : `focusMode` n'est que *lu* (`ZoomFocusOverlay`), `"auto"` n'arrive que par les suggestions automatiques. | Le suivi curseur fonctionne (`zoomSuggestions.ts:63`). | faible — un contrôle dans le pane Zoom |
| 3.3 | Pas de preset de **rotation** de zoom. | Le shader de tilt 3D existe dans `compositor.rs`. | moyen |
| 3.4 | Pas de **zoom réactif** webcam. | — | moyen |
| 3.5 | Seules les annotations **texte** sont créables. | Image / figure / flou sont rendues par le compositeur, inatteignables faute de chemin de création. | moyen |

Ordre proposé : 3.1 d'abord (meilleur rapport valeur/effort, capacité complète, seul le
contrôle manque), puis 3.2. Le reste après arbitrage.

---

## Lot 4 — Robustesse (à arbitrer)

| # | Sujet | État | Remarque |
| --- | --- | --- | --- |
| 4.1 | `preferSoftwareEncoder` est lu au démarrage de l'enregistrement (`useScreenRecorder.ts:843`) mais **aucune UI ne le règle**. | non câblé | Repli utile sur machines dont l'encodeur matériel échoue. Lot 1.2/1.3 corrige justement les blocages propres à ce mode. |
| 4.2 | Le moteur D3D n'a **aucun repli logiciel** : `D3D_DRIVER_TYPE_HARDWARE` seul, `bail!` si le feature level n'est pas `11_1` (`poc-d3d/src/d3d.rs`). | absent | Échec sec sur machine sans GPU compatible. Un repli WARP est possible mais lent ; décision produit, pas technique. À trancher avant toute distribution large. |

---

## Différé, avec la raison

- **PR #142 (packaging MSIX / Microsoft Store)** — correct et prêt sur la branche parquée,
  mais sans objet tant qu'on ne release pas depuis cette branche. À reprendre au moment de
  la release.
- **PR #120 (playhead qui retarde)** — **[M]**. Sur main, la position venait d'un `useState`
  remonté en haut de l'arbre, forçant une cascade de rendu à 60 Hz. Chez nous
  l'architecture diffère (preview native), mais `V4Timeline` reçoit `currentTimeSec` en
  **prop** — donc le parent re-rend à chaque tick même si `PlayheadOverlay` est mémoïsé. À
  **mesurer** avant de décider : si le retard est réel, le remède est le même (le playhead
  lit l'horloge dans sa propre boucle rAF avec son état local).
- **PR #127 partie 2 (durée plafonnée après Save → Load)** — **[M]**. Le modèle document
  d'ai-edition n'a pas le `lastResolvedDurationRef` en cause. À reproduire avant de spécifier
  quoi que ce soit.
- **PR #126 (checklist RC end-to-end)** — à reprendre quand on stabilisera la branche.

---

## Exécution

Branche neuve depuis `feat/ai-edition`. Un commit par item, dans cet ordre :

1. **Lot 1** (1.1 → 1.5) — cherry-picks, puis rebuild natif et validation enregistrement.
2. **2.3** — annotation vide (cherry-pick, trivial).
3. **2.1** — bug de réordonnancement (le plus visible pour l'utilisateur).
4. **2.2** — mixage multipiste natif en Rust (le plus lourd du lot 2).
5. **3.1** puis **3.2** — recâblage UX.

Lot 4 et différés : après arbitrage.

PR #154 reste ouverte comme réserve jusqu'à ce que les cherry-picks aient été rejoués,
puis sera fermée sans merge. Ses deux commits de portage #109 (exporteur navigateur) ne
sont **pas** repris.
