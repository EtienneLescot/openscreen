# Timeline coordinate refactor — clip-anchored modifiers

**Statut :** planifié (2026-07-22). Corrige le désync zoom/trim (offsets audio/vidéo, couples
caméra/record mélangés) en preview **et** au rendu. Aligne le code sur le diagramme
`ai-edition-data-flow` : *« modifiers represented above the timeline UX-wise but flowed down to
clip data-wise »*.

## 1. Cause racine (diagnostic)

Le code mélange **deux référentiels de temps timeline** :

| Référentiel | Définition | Qui l'utilise |
|---|---|---|
| **RAW / document** | les trims occupent encore leur place sur la règle | `currentTimeSec`, playhead, règle V4, authoring des régions, nav clip (`NewEditorShell`) |
| **COMPRESSÉ / playback** | trims retirés, clips recollés depuis 0 (`resolvePlaybackSegments`) | `buildSceneDescription` → natif (preview+export), `resolveNativePlaybackPosition` |

Les régions (zoom/speed/annotation) sont stockées en **virtual-ms RAW** au niveau *document*, mais
`buildSceneDescription` les ventile contre des clips **COMPRESSÉS** (`resolveVisibleClips`). Dès
qu'un trim retire `Δ` s avant une région, la coordonnée RAW dépasse la position compressée de `Δ`
→ mauvais clip / mauvais offset source → la région se déclenche `Δ` trop tôt, l'active-clip est
mal résolu → mauvaise caméra + décalage écran/cam. Contradiction visible :
`NativeCompositorOverlay.tsx:56-67` (le commentaire dit « currentTimeSec est RAW, ne pas utiliser
resolveVisibleClips » mais le code utilise resolveVisibleClips). 3ᵉ traitement divergent :
`reprojectDocumentRegions` reprojette RAW→RAW (correct seulement sans trim).

## 2. Modèle cible

- **`currentTimeSec` / règle / playhead = RAW virtual time** (inchangé, = ce que l'utilisateur voit).
- **Un modifier est ancré à un clip, en source-time** : `{ clipId, sourceStartSec, sourceEndSec, …payload }`.
  Unifie trims (`{assetId, sourceStart, sourceEnd}`) et modifiers.
  - Trim → soustrait la fenêtre source du clip : le modifier ancré est masqué/découpé par la même
    math d'intervalles, **sans reprojection**.
  - Reorder / move / duplicate → le modifier voyage avec son `clipId`, **sans reprojection**.
  - Natif → le modifier porte déjà `clipId` (→ `clipIndex`) + range source = exactement ce que
    `SceneZoomRegion`/`setActiveClip` consomment. `projectRegionsToSourceTime` devient un simple
    lookup par segment.
  - UI → pill placée par map avant unique : `clip.timelineStartSec + (mod.sourceStartSec − clip.sourceStartSec)`
    (= `trimToTimelineSpan`, déjà éprouvé).
- **Un seul module de mapping** `src/lib/ai-edition/timeline/timelineMap.ts`, pur, seul endroit qui
  connaît RAW ↔ source ↔ compressé.

### Contrat `timelineMap.ts`

| Fonction | Rôle | Remplace |
|---|---|---|
| `rawVirtualToSource(rawClips, rawSec)` → `{clip, sourceSec}` | playhead RAW → source (clips RAW) | version honnête de `locateVirtualPosition`/`resolveNativePlaybackPosition` |
| `sourceToRawSpan(clip, srcStart, srcEnd)` → `{start,end}` | range source clip → span RAW (pill) | `trimToTimelineSpan` |
| `resolveRawSpanToClipSource(rawStart, rawEnd, rawClips)` → `{clipId, srcStart, srcEnd}` | span RAW → ancre clip (authoring) | `resolveTimelineSpanToTrim` |
| `projectModifierToScene(mod, visibleSegments)` → `SceneRegion[]` | ancre clip → régions source + `clipIndex` (gère trim qui coupe en 2 segments) | `projectRegionsToSourceTime` |
| `resolveNativePosition(rawSec, rawClips, visibleSegments)` → `{clipIndex, sourceSec}` | playhead RAW → (index compressé, source) pour natif | `resolveNativePlaybackPosition` |

## 3. Stages

| # | Stage | Livrable | Risque | Désync corrigé ? | État |
|---|---|---|---|---|---|
| A0 | Test rouge | `sceneDescription.test.ts` : trim + zoom → source time attendu | nul | prouve le bug | ✅ fait |
| A1 | Module de mapping | `timelineMap.ts` (`projectRawRegionsToSource`, `resolveNativePosition`, `segmentRawSpanSec`) + `timelineMap.test.ts` | nul | — | ✅ fait |
| A2 | Corriger la projection runtime (schéma actuel) | `buildSceneDescription` (3 projections) + résolution du clip actif (`resolveNativePosition` remplace `resolveNativePlaybackPosition` dans `useNativePlaybackSync` + `NativeCompositorOverlay`) ; contradiction `NativeCompositorOverlay:56-67` levée ; ancien `nativePlaybackPosition.ts` supprimé | moyen | **oui (preview + export natif)** | ✅ fait |
| A3 | ~~Aligner l'export legacy~~ | **Non nécessaire** : `documentExporter.ts:216` ventile déjà contre les clips **RAW** (`document.timeline.clips`) + coupe les trims séparément → déjà correct. Seul le chemin natif mélangeait RAW/compressé. | — | déjà correct | ⏭️ écarté |
| B1 | Schéma clip-ancré | `schema` v5 : zoom/annotation portent `{clipId, sourceStartSec, sourceEndSec}` (anchor **optionnel** pendant la transition) + `startMs/endMs` **dérivés** ; migration v4→v5 dans le préprocess via `anchorRegionsWithDerivedMs` (couvre aussi `legacyEditor.speedRegions`/`cameraFullscreenRegions`) ; `migrate.ts` émet la forme v4 → la logique de migration vit à UN seul endroit | élevé | verrouille | ✅ fait |
| B2 | Supprimer la reprojection hot-path | `reprojectDocumentRegions` + `reprojectRegionsForReorder` + `reprojectSpanForReorder` **supprimés**. Remplacés par `rederiveRegionMs` (ops qui PRÉSERVENT l'identité des clips : move/duplicate/trim/`update_clip_range` → seul le cache ms bouge) et `reanchorRegions` (rebuild d'identités : `replaceTimeline` → ré-ancrage depuis les ms). Câblé dans `document/timeline.ts`, `document/operations.ts`, `store/useTimeline.ts` | moyen | verrouille | ✅ fait |
| B3.1 | Authoring ancré (`useTimeline`) | `addZoom`/`addZoomsBulk`/`addAnnotation`/`addSpeed`/`addCameraFullscreen` **ancrent à la création** (`anchorRegionsWithDerivedMs`) ; les 4 `update*Span` passent par `replacePillSpan` (clamp + ré-ancrage : re-split au franchissement, collapse au retour) ; `removeRegion`/`removeRegions` suppriment **toute la pill** (`dropPillById`/`dropPillsByIds`, résolue par `resolvePillIds`). **Ferme le trou de B2.** | moyen | verrouille | ✅ fait |
| B3.2 | Authoring ancré (agent LLM) | `agent-tools.ts` : `addZoom`/`addSpeed`/`addAnnotation` + updates ancrent aussi ; interface **secondes-virtuelles** conservée côté LLM, conversion à l'intérieur : `anchorForAgent` sur add*, `replacePillSpan` sur set*, et `coalesceForAgent` pour que le snapshot présente **une** entrée par région logique | moyen | verrouille | ✅ fait |
| B3.3 | Pills par identité | `V4Timeline` via `coalesceRegionsForRuler` (règle 1) ; clé de pill = `ids[0]` (unique — voir révision) ; payload edits sur toute la pill (`patchPillById`) ; `coalescedTrimGroups` délègue à `coalesceByIdentity` → **duplication supprimée** | moyen | verrouille | ✅ fait |
| B4 | Nettoyage final | natif/export/overlays lisent l'ancre directement ; retirer `startMs`/`endMs` | faible | — | ⬜ à faire |

**Le désync utilisateur est corrigé dès A2** (preview + export natif), prouvé par
`timelineMap.test.ts` + `sceneDescription.test.ts` (trim + zoom → bon temps source). **B*** paie la
dette pour qu'il ne puisse plus revenir (élimine le double référentiel et la reprojection à chaque
reorder). La conversion « virtual-ms RAW → source » de A2 devient le code de migration en B1, pas du
throwaway.

### Découverte (2026-07-22)
- Le bug était **localisé au chemin natif** (preview + export MP4), pas généralisé : `documentExporter`
  (WebCodecs) projetait déjà contre les clips RAW. La confusion RAW/compressé vivait uniquement dans
  `buildSceneDescription` (clips compressés utilisés pour le mapping source) et
  `resolveNativePlaybackPosition` (horloge RAW lue contre clips compressés → mauvaise caméra après trim).
- **Caveat env. worktree** : les tests qui *montent* des composants React (`EditorEmptyState`,
  `CursorPreviewLayer`, `WebcamOverlay`, `useTimeline`) échouent AVANT/APRÈS ce changement (React nul :
  `react`/`zustand` résolus depuis le repo racine, `react-dom` depuis le worktree → double React).
  Vérifié par `git stash` : 14 échecs identiques sur le commit de base. Non causé par ce refactor ;
  cf. `desktop-app-testing-worktree` / `cc-delegate-worker-env`. Tous les tests **pure-logic** passent.

## 4. Invariants de validation

- Un projet `1 clip + trim de 2 s au début + zoom 5 s plus loin` : le zoom se déclenche au **même**
  frame source en preview et à l'export ; playhead RAW ↔ frame affichée cohérents après le trim.
- 2 assets, chacun sa caméra : le clip actif (donc la caméra) résolu à un temps RAW donné reste le
  bon après trim/reorder ; `sourceTime − offset` webcam correct.
- `biome` + `tsc` + `vitest` verts à chaque stage (commandes : voir `os-editor-verify-commands`).

## 5. Blast radius (fichiers)

- **Core** : `timeline/timelineMap.ts` (neuf), `native/sceneDescription.ts`,
  `native/nativePlaybackPosition.ts`, `native/useNativePlaybackSync.ts`,
  `components/ai-edition/NativeCompositorOverlay.tsx`.
- **Export** : `exporter/renderPlan.ts`, `exporter/documentExporter.ts`, `ExportDialog.tsx`.
- **Schéma/migration (B)** : `schema/index.ts`, `document/migrate.ts`, `document/timeline.ts`
  (suppr. `reprojectDocumentRegions`), `timeline/region-ventilation.ts` (élaguer).
- **UI (B)** : `store/useTimeline.ts`, `v4/V4Timeline.tsx`, `v4/FloatingInspector.tsx`,
  `AnnotationOverlay.tsx`, `RightPanelStack.tsx`/gimbal, `CursorPreviewLayer.tsx`.
- **Tests** : `timelineMap.test.ts` (neuf), `sceneDescription.test.ts`, `region-ventilation.test.ts`,
  `document/timeline.test.ts`, `useTimeline.test.ts`, `migrate.test.ts`, `renderPlan.test.ts`.

## 6. Stage B — modèle retenu : fragments clip-ancrés + règles universelles

Décidé 2026-07-22, **révisé 2026-07-23** après test in-app (voir « révision » plus bas).

**Stockage.** Une région = un ou plusieurs **fragments**, chacun ancré à UN clip en temps
source : `{ id, clipId, sourceStartSec, sourceEndSec, …propriétés }`. Une région dessinée à
cheval sur une frontière est stockée en un fragment par clip couvert. **Aucun marqueur ne
relie les fragments entre eux.**

- Trim d'un clip → rétrécit sa fenêtre source → le fragment est coupé par la même math
  d'intervalles. Reorder/move → le fragment voyage avec son `clipId`. **Zéro reprojection.**

**Les deux règles universelles** (`timelineMap`), valables pour TOUS les types de région :

| Règle | Énoncé | Primitive |
|---|---|---|
| **1. Fusion** | deux régions de même type, aux **propriétés égales**, qui se touchent → **une** pill. Peu importe comment elles sont devenues voisines. | `coalesceByIdentity` |
| **2. Répulsion** | deux régions de même type aux **propriétés différentes** ne peuvent pas se chevaucher : l'edit **bute** sur le bord du voisin, qui ne bouge jamais (pas de cascade). | `clampSpanAgainstNeighbours` |

L'**identité** (`regionIdentityKey`) = toutes les propriétés qui affectent le rendu,
sérialisées canoniquement ; **position** (`clipId`, source, ms) et **provenance** (`id`,
`origin`, `reason`, `source`) exclues. Une nouvelle propriété participe automatiquement.

**Conséquences (toutes dérivées, aucune codée en dur) :**
- Un **trim** n'a aucune propriété → identité constante → les trims fusionnent toujours.
  Le comportement historique des trims devient un **cas particulier de la règle 1** :
  `coalescedTrimGroups` délègue désormais à `coalesceByIdentity`. **La duplication de logique
  signalée en test est supprimée.**
- Deux régions **autorées indépendamment**, adjacentes et de mêmes propriétés → fusionnent
  (ce que le modèle par provenance ne savait pas faire).
- Split par reorder → on change une propriété d'un morceau → on recolle les clips →
  **pas de fusion** (mismatch). On remet la propriété → fusion. Sans mémoire du split.
- Les mutations (resize, suppression, edit de propriété) portent sur **la pill telle qu'elle
  est vue**, résolue à la volée par `resolvePillIds` — pas sur un groupe mémorisé.

### Révision du 2026-07-23 — pourquoi `groupId` a été supprimé
La 1ʳᵉ version reliait les fragments par un `groupId` (leur *provenance*). Deux défauts, tous
deux constatés en test réel :
1. **Duplication** — les trims fusionnaient par adjacence, les modifiers par provenance : deux
   mécaniques pour une seule règle, et des voisins identiques qui refusaient de fusionner.
2. **Collision de clés** — keyer une pill par `groupId` casse dès qu'un groupe se scinde
   légitimement (deux pills, même clé) : React « duplicates and/or omits » les enfants, l'UI
   devient non fiable (des régions de goodtest ont été perdues ainsi). **Clé = `ids[0]`.**

L'identité (ce que la région EST) remplace la provenance (d'où elle vient) : plus simple, sans
bookkeeping, et correcte quelle que soit l'histoire des régions.

### Façades SSOT à ne pas oublier (au-delà de timeline/preview/export)
La forme des régions zoom/speed/annotation est aussi lue/écrite par d'autres façades :
- **Chat LLM — `electron/ai-edition/agent-tools.ts` (IMPACT FORT)** : `getCurrentDocument` présente
  les effets au LLM en **secondes virtuelles (timeline éditée)** (`:425-441`, `:144`) et des tools
  d'écriture (`addZoom`/`addSpeed`/`addAnnotation` + updates, `:646/:698/:775`) prennent des
  **secondes virtuelles** et écrivent `startMs/endMs`. **Stratégie** : garder l'interface
  secondes-virtuelles côté LLM (il raisonne dans le référentiel de la règle, pas en fragments) ; les
  tools convertissent virtuel↔fragments (`anchorRawRegionsToClips`) et `getCurrentDocument` dérive le
  span virtuel depuis les fragments. C'est un argument de plus pour la transition additive (ms dérivés).
- **Transcript agrégé — `aggregated-transcript.ts` + modale (IMPACT MINIMAL)** : consomme clips +
  mots + trims, PAS la forme des régions ; entêtes = clips (inchangés). Revalider seulement : cuts de
  mots + annotations `auto-caption` après le flip.
- **B3 « group-aware »** : pills coalescées par `groupId` (fragments dont les spans ruler se touchent
  → 1 pill) ; parts sur clips séparés = pills distinctes mais **liées par `groupId`** pour
  sélection/suppression/resize groupés (calqué sur `coalescedTrimGroups`). Exposer
  `anchoredToRawSpanSec(fragment, clips)` (le mapping fragment→span ruler qu'utilise
  `coalesceAnchoredFragments`) pour V4Timeline / FloatingInspector / overlays. **Invariant : un edit
  cross-clip reste un seul edit côté utilisateur.**
