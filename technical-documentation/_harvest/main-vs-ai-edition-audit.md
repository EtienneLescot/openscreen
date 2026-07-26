# main vs feat/ai-edition — audit fonctionnel

Point de divergence : `68d3a685` (2026-07-15).
Comparaison faite entre `origin/main` et `origin/feat/ai-edition` **directement**, sans
passer par la branche de portage `claude/rebase-ai-edition-main-c65d0d` (PR #154), qui est
mise de côté.

Périmètre : les **15 PR mergées sur main après la divergence**. Sept autres PR portent la
date du 2026-07-15 (#87, #85, #81, #73, #66, #58, #19 — Full Camera, éditeur de dégradés,
encodeur logiciel, WebGL, capture parallèle) mais leur commit de merge est **ancêtre** de
`68d3a685` : elles sont déjà dans ai-edition. Vérifié par
`git merge-base --is-ancestor <mergeCommit> 68d3a685`.

Verdict global : **main n'a produit aucune nouvelle fonctionnalité produit depuis la
divergence.** Ce sont des correctifs et de l'outillage de release. Mais quatre de ces
correctifs couvrent des bugs qui sont **toujours vivants dans ai-edition**.

---

## A. Release / CI / packaging — aucun impact sur le produit édité

| PR | Sujet | Verdict |
| --- | --- | --- |
| #90 | Dispatch build sur le bon tag, nommage de la branche de release | hors périmètre branche |
| #134 | Release v1.7.0 dans main (bump de version) | hors périmètre branche |
| #137 / #138 | Workflow Discord ponctuel (ajouté puis retiré) | sans objet |
| #126 | Checklist de validation RC end-to-end (docs) | à reprendre au moment de stabiliser |
| #142 | Packaging Microsoft Store (MSIX) — `electron-builder.json5` + script `build:win:store` | à prendre **au moment de la release**, pas maintenant |

## B. Bugs du recorder natif — code partagé, **absents d'ai-edition**

Ces quatre correctifs touchent du code que les deux branches partagent presque à
l'identique. Les bugs sont donc reproductibles tels quels sur ai-edition.

| PR | Bug utilisateur | État dans ai-edition |
| --- | --- | --- |
| #122 | Enregistrer une **fenêtre** (pas l'écran entier) donne une vidéo **entièrement noire** quand ses dimensions client sont impaires (redimensionnement libre, arrondi DPI). H.264 exige des dimensions paires ; `CopyResource` no-op silencieusement sur un écart de taille. | **ABSENT** — `wgc_session.cpp` prend `item_.Size()` verbatim |
| #119 | Sous encodeur **logiciel**, l'arrêt de l'enregistrement peut ne jamais aboutir : `WriteSample` bloquant tenu sous le mutex partagé affame le thread principal qui attend `stopRequested`. | **ABSENT** — pas de `submitVideoSample` |
| #123 | Filet de sécurité pour #119 : l'attente par frame du writer n'a pas de timeout, une notification manquée fige le `join()`. | **ABSENT** — pas de `wait_for(100ms)` dans la boucle frame |
| #91 | **Linux/Wayland** : l'enregistrement d'écran ne produit aucune frame exploitable (`EGL_BAD_MATCH`, renégociation DMA-BUF) parce que Chromium initialise Vulkan, incompatible avec le backend Ozone Wayland. | **ABSENT** — `electron/main.ts` n'a que le switch macOS |

Ces quatre-là sont des **cherry-picks propres** (le seul point délicat est `main.cpp` sur
#119, où ai-edition a sa propre cadence CFR webcam à préserver).

## C. HUD — code partagé, bug présent

| PR | Bug utilisateur | État dans ai-edition |
| --- | --- | --- |
| #125 | Déplacer le HUD par sa poignée : la fenêtre **dérive** au lieu de suivre le curseur au pixel. Deux canaux IPC repositionnent la fenêtre (delta de drag + recalage d'ancre du `ResizeObserver`) et se composent. | **ABSENT** — `LaunchWindow.tsx` a bien `measureHudSize` + `ResizeObserver`, sans le gel pendant le drag |

## D. Éditeur — divergence forte, à traiter fonctionnellement

Ici le correctif de main vit dans l'ancien éditeur (`VideoEditor.tsx`, `TimelineEditor.tsx`,
exporteur navigateur), qui n'est plus le chemin d'exécution d'ai-edition. La question n'est
donc pas « le patch s'applique-t-il » mais « le bug existe-t-il chez nous, et où ».

| PR | Bug utilisateur | État dans ai-edition |
| --- | --- | --- |
| #118 | Les zooms auto-placés se calent sur le curseur au début de la région puis restent figés, au lieu de le suivre sur toute leur durée. | **DÉJÀ COUVERT** — `zoomSuggestions.ts:63` pose `focusMode: "auto"` à la création. *(Reste un manque UX distinct : aucun contrôle ne permet de basculer une région entre `auto` et `manual`.)* |
| #127 (1/2) | Une nouvelle annotation texte naît avec du texte en dur au lieu d'être vide : le placeholder ne s'affiche jamais et la saisie s'ajoute derrière. | **BUG PRÉSENT** — `useTimeline.ts:259` pose `content: "New annotation"` |
| #127 (2/2) | Après Save → Load, la durée du projet est plafonnée à la fin du dernier élément au lieu de la vraie durée d'enregistrement. | modèle document différent — **à vérifier en situation** |
| #120 | Le playhead de la timeline retarde sur la lecture, et le scrub pendant lecture est mou : la position vient d'un `useState` remonté tout en haut de l'arbre, forçant une cascade de rendu à 60 Hz. | architecture différente (preview native). `V4Timeline` reçoit `currentTimeSec` en **prop** et `PlayheadOverlay` est memo — donc le parent re-rend quand même à chaque tick. **À mesurer** avant de conclure |
| #109 | **Le micro est absent de l'export.** Les enregistrements natifs macOS écrivent audio système et micro en **deux pistes AAC séparées** ; l'exporteur n'en décodait qu'une (`av_find_best_stream`), la première, souvent silencieuse. | **BUG PRÉSENT, MAIS AILLEURS.** Le correctif de main est dans l'exporteur navigateur, qui est mort chez nous (l'export passe par `exportMultiNative`). Le même bug vit dans **`poc-d3d/src/audio.rs:177`**, qui appelle exactement `av_find_best_stream(…AVMEDIA_TYPE_AUDIO…)` et ne décode qu'une piste. **À réimplémenter en Rust**, pas à cherry-picker |

---

## Ce qui est réutilisable depuis la branche mise de côté

`claude/rebase-ai-edition-main-c65d0d` (PR #154) contient déjà, testés et compilés :

- #122, #119, #123, #91 (bloc B) — dont le merge à la main de `main.cpp` qui préserve la
  cadence CFR webcam d'ai-edition ;
- #125 + son test de non-régression (bloc C) ;
- #142 MSIX (bloc A, à différer) ;
- l'annotation vide + placeholder (#127 partie 1, bloc D) ;
- le portage #109 dans l'exporteur navigateur — **sans valeur**, puisque ce chemin est
  contourné par l'export natif ; c'est le portage Rust qu'il faut, pas celui-là.

## Manques UX propres à ai-edition (hors main)

Constatés en inspectant l'UI vivante, sans rapport avec la divergence — ce sont des
capacités présentes dans le code mais jamais câblées au shell V4 :

- vitesse plafonnée à 3× (`<select>` de `FloatingInspector`) alors que
  `MAX_PLAYBACK_SPEED = 100` existe et que l'UX champ libre vit dans `RightPanelStack`,
  qui n'est plus monté ;
- pas de bascule `focusMode` auto/manuel sur une région de zoom ;
- pas de preset de rotation de zoom ;
- pas de zoom réactif webcam ;
- seules les annotations **texte** sont créables (image / figure / flou sont rendues par le
  compositeur mais inatteignables) ;
- `preferSoftwareEncoder` est lu au démarrage de l'enregistrement, aucune UI ne le règle ;
- le moteur D3D n'a **aucun repli logiciel** (`D3D_DRIVER_TYPE_HARDWARE` seul, `bail!` si le
  feature level n'est pas 11_1) — échec sec sur machine sans GPU compatible.
