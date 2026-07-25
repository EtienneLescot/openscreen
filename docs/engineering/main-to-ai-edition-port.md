# Portage `main` → `feat/ai-edition` (juillet 2026)

## Contexte

`feat/ai-edition` diverge lourdement de `main` : **273 commits** d'un côté
(compositeur natif poc-d3d, éditeur V4, timeline clip-anchored, export v2
multi-asset), **24 commits** de l'autre depuis le point de divergence
(`68d3a685`, 15 juil. 2026). Là où `main` a corrigé l'éditeur navigateur
legacy, `ai-edition` l'a **supprimé** — donc la plupart des correctifs `main`
patchent du code mort ici.

Stratégie retenue (au lieu d'un rebase brut des 273 commits) :

1. **Cherry-pick** ce qui est archi-compatible.
2. **Portage fonctionnel + revalidation** là où le même fichier a divergé mais
   reste vivant (export audio).
3. **Recensement** des features liées au code supprimé → décider, par feature,
   si c'est déjà couvert en V4/natif, obsolète, ou à ré-implémenter.

Un rebase littéral aurait rejoué `ai-edition` par-dessus ces 24 commits ; le
contenu **fonctionnel** net qu'il aurait apporté est exactement les 11 commits
ci-dessous (les 13 autres = bumps de version, workflow Discord, docs RC du
legacy, et patches de l'éditeur supprimé — no-ops ou bruit).

## 1. Cherry-pické (archi-compatible) — 11 commits

| Commit | Feature | Résolution de conflit |
|---|---|---|
| `e129e408`, `49338719` | Infra release (pin dispatch, nommage branche RC) | clean (workflows non touchés par ai-edition) |
| `d75cb57e` | WGC : ne plus tenir le mutex pendant `WriteSample` (#115) | **fusion** : timing webcam horloge-réelle CFR d'ai-edition **+** split capture-sous-mutex / submit-hors-mutex de `main`. `writeBgraFrame`→`captureBgraSample`. |
| `21828bfd` | WGC : dims capture arrondies au pair | clean |
| `90d9bf2f` | WGC : garde-fou anti-hang (`cv.wait`→`wait_for(100ms)`) | clean |
| `cd088673` | HUD : le drag ne dérive plus du curseur | garde `hudAllocatedSizeRef` d'ai-edition **+** ajoute `isDraggingHudRef` |
| `c6cd9436` | Test de régression drag HUD | garde `shrink-0` d'ai-edition **+** `data-testid` |
| `42ab20dc` | Packaging Microsoft Store (MSIX/appx) | `build:win:store` reflète les étapes natives d'ai-edition (compositor + ffmpeg), sinon le build Store livrerait sans compositeur natif |
| `282a617e` | Désactiver Vulkan sur Wayland (import DMA-BUF PipeWire) | clean — ai-edition **a** le bloc Wayland ciblé |

## 2. Portage fonctionnel — mixage audio multi-piste (`1c01a873`, `f65de972`)

**Bug (macOS)** : les captures natives macOS écrivent système + micro en 2 pistes
AAC ; l'exporteur ne prenait que la 1re (souvent silencieuse) → export muet
malgré un micro enregistré.

**Pourquoi c'était le point sensible** : `audioEncoder.ts` est **vivant** sur
ai-edition (l'export v2 `documentExporter`/`renderPlan`/`audioConcatPlan`
l'appelle encore) et `audioConcatPlan` est couplé à sa comptabilité
d'échantillons.

**Ce qui a rendu l'intégration safe** : le changement d'ai-edition sur
`audioEncoder.ts` est **purement additif** (+72/-0 : une nouvelle méthode
`encodePcmToMuxer` pour la boucle segment v2) et **disjoint** du chemin de
décodage que `main` réécrit → `audioEncoder.ts` s'est appliqué **clean**. Le
mixage est réellement câblé : `streamingDecoder.loadMetadata()` renvoie
`audioStreamCount` → passé au blocker source-copy qui refuse le multi-piste →
le chemin plein mixe via `mixPlanarSources`. Pas inerte.

Conflits résolus à la main dans `videoExporter.ts` / `.test.ts` en **conservant
les deux** familles de blockers (frame-rate/codec d'ai-edition + multi-piste
`#108` de `main`), `SourceCopyVideoInfo` enrichi de `audioStreamCount?`.

**Revalidation** : `tsc` clean, **118/118 tests** (les tests de mixage de `main`
+ les 4 tests d'export v2 d'ai-edition passent ensemble), biome clean. Le test
navigateur `audioMixExport.browser.test.ts` (fixture dual-audio) n'a pas été
exécuté ici (nécessite `npm run test:browser:install`) — à lancer via
`npm run test:browser`.

## 3. Recensement des features divergentes (code legacy supprimé)

| Feature `main` | Verdict | Détail |
|---|---|---|
| `e4ef4768` perf playhead découplé du re-render ancêtre (#111) | ✅ **Déjà couvert** | `V4Timeline` a `PlayheadOverlay` memoïsé + `rafSeekRef`/`pendingSeekTimeRef` (coalescing rAF) + `playheadElRef` (DOM direct). Archi découplée équivalente/supérieure. |
| `574b685c` ref écrit en render (anti-pattern React, #120) | ✅ **Déjà couvert** | `PlayheadOverlay` V4 est pur/memoïsé, `pct` en prop, aucune écriture de ref en render. |
| `9844c782` zoom auto suit le curseur (`focusMode:"auto"`, #72) | ✅ **Déjà couvert** | `src/lib/ai-edition/store/zoomSuggestions.ts` met déjà `focusMode:"auto"` par défaut sur les zooms auto-suggérés (+ `zoomSuggestions.test.ts`). Exactement le fix #72. |
| `5cfdeb3c`/`0884032f` #2 durée capée après reload | ✅ **Déjà couvert** | ai-edition remplace la durée provisoire (placeholder 60s) par la vraie durée média au probe : `applyProbedDuration.ts`, gardes `useTimeline.ts`, commit `49602a14`. La race legacy (`resetDurationResolution` clobbered) n'existe pas dans ce modèle. |
| `5cfdeb3c`/`0884032f` #1 annotation texte vide + placeholder | ⚠️ **Décision produit** | ai-edition crée le texte avec un défaut *baked* `content:"New annotation"` (`useTimeline.ts:259`), pas vide+placeholder. Pas le bug legacy exact (« Enter text… »), mais même friction UX possible. À trancher : garder « New annotation » (défaut sensé) ou aligner sur vide+placeholder. |
| Docs RC e2e (`1e572232`, `dacea226`, `7013b8bd`) | ⛔ **Obsolète** | `rc-e2e-checklist.md` supprimé sur ai-edition ; écrit contre l'UI de l'éditeur legacy. |
| Bumps de version + workflow Discord | ⛔ **Skip** | Chore de release ; ai-edition gère son propre versioning. |

## Seule décision ouverte

Le défaut de contenu des annotations texte (⚠️ ci-dessus) — choix UX à valider.
Tout le reste des features divergentes est déjà ré-implémenté nativement dans
ai-edition.

## Repères techniques

- Ref de sécurité avant cherry-picks : tag `rebase-safety-before-cherrypick`.
- `node_modules` du worktree = junction vers le repo principal (pour tsc/vitest).
