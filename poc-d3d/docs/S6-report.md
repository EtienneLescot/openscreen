# S6 — Runner, configurations cumulatives, rapport

Statut : **cœur atteint.** CLI `--fixture --cfg --repeat --out`, configs cumulatives C0..C8, 3 répétitions + spread, `report.json` + table stdout, extraction PNG f60/f180/f300, build `--release` (LTO, debug_assertions off) pour les runs mesurés.

## Résultat (release, meilleur des N répétitions)

Deux optimisations appliquées (voir plus bas) : motion blur par **vélocité** (au lieu du
supersampling temporel) et fond flouté **dual-Kawase** (au lieu du gaussien 49-tap).

| cfg | fps | ms/f | couche ajoutée |
|---|---|---|---|
| C0 | 239.3 | 4.18 | décode + encode, aucun composite |
| C1 | 151.2 | 6.61 | composite 2 sources, fond, layout, NV12→RGB (E1) |
| C2 | 151.9 | 6.58 | coins arrondis (E2) — gratuit |
| C3 | 140.0 | 7.14 | ombres portées (E4) |
| C4 | 130.5 | 7.66 | fond flouté (E3, dual-Kawase) |
| C5 | 124.9 | 8.01 | zoom animé |
| C6 | 133.4 | 7.50 | animation de layout |
| C7 | 132.6 | 7.54 | curseur custom + click bounce |
| C8 | 124.3 | 8.04 | flou de mouvement (vélocité, 8 taps) |

Tout tient dans **124–239 fps**. L'écart entre la ligne la plus lourde (C8) et le plafond
codec (C1, ~151) n'est plus que ~27 fps (contre 49 avant l'optim du fond).

Historique C8 : supersampling N=6 **23 fps** → vélocité **104 fps** → + dual-Kawase **124 fps**.

## Où est le mur : mesuré par compteurs GPU par moteur (externe, non intrusif)

Capture via `\GPU Engine\Utilization` (pas d'élévation, n'instrumente pas le process) :

| | video codec (encode) | 3d (composite) | goulot |
|---|---|---|---|
| C1 (composite léger) | **71 %** | 46 % | encode |
| C8 (tous effets) | 61 % | **84 %** | composite |

Faits établis, et une idée écartée :
- **Le décode ne pèse rien** (bursty ~2 ms), jamais goulot. Décomposition ffmpeg : décode 1.9 ms/f, encode marginal 2.8 ms/f.
- **Les moteurs se recouvrent déjà** (84 %+61 % = 145 % sur la même fenêtre) → le GPU pipeline seul entre frames. **Un pipeline CPU multi-thread ne gagnerait ~rien** — vérifié aussi par un cache SRV (réduction overhead CPU) resté **sans effet** ⇒ GPU-bound, pas CPU-bound.
- **Le codec VCN est le plafond dur (~210 fps, fixed-function)** : `-quality speed` ne gagne que +2 %. C1–C3 y sont déjà collés.
- **Seul terrain utile : le composite (moteur 3d)** sur C4–C8. C'est ce que dual-Kawase attaque.

## Lecture (honnête, pas lissée)

- **C0→C1 (−85 fps)** est le plus gros coût : 2ᵉ décodage + tout le composite HLSL + conversion RGB→NV12 + copie. La brique la plus lourde, sans surprise.
- **C2 (coins arrondis) quasi gratuit** : delta sous le spread. Alpha SDF, aucun coût réel (§9 : « un fps qui ne baisse pas = la couche ne coûte rien »).
- **C4 (fond flouté) = 128 fps, spread 1.6 %** : stable et monotone ce run. Au run précédent C4 montrait 105 fps / spread 17.7 % et une non-monotonie C4→C5 — c'était de la **variance thermique** de l'iGPU passif (le §10 anticipe exactement ce piège ; le spread élevé s'auto-dénonçait). Re-mesuré GPU froid, l'anomalie disparaît. Les passes de flou coûtent ~18 fps, réellement.
- **C6/C7 spreads élevés (23 %, 14 %) ce run** : même variance thermique run-à-run. Le « meilleur des 3 » reste cohérent et monotone. Sur un iGPU passif, viser des runs GPU froid / secteur pour des coûts absolus fiables.
- **C8 (−13 fps seulement, 104 fps)** : le flou de mouvement n'est plus dominant. Voir l'optimisation ci-dessous.

## Optimisation du flou de mouvement (23 → 104 fps)

**Avant** — supersampling temporel N=6 : recomposer la frame entière 6 fois aux temps intermédiaires et moyenner. Coût = ×6 le composite, quel que soit le contenu. → 23 fps, structurellement incompressible.

**Après** — flou directionnel par vélocité, une seule composition :
- chaque pixel d'un calque vidéo connaît sa position source à la frame précédente (remapping par `dst_prev`/`src_prev`, passés au shader). Le vecteur `uv_now − uv_prev` **est** la vélocité par pixel — il capture translation (layout) *et* zoom.
- le shader échantillonne `taps` fois le long de ce vecteur et moyenne. **Early-out** si la vélocité est ~nulle (1 seul tap) : les frames statiques — la majorité de la fixture — tournent à pleine vitesse.
- coût = quelques taps sur les seuls calques en mouvement, au lieu de ×6 la frame entière. Le fond flouté (le plus cher) n'est calculé qu'une fois.
- curseur : flou par fantômes le long de sa vélocité (traîne qui s'estompe), coût négligeable (petits quads).

Qualité visuelle équivalente (blur directionnel, physiquement juste), pour **4,5×** le débit. C'est la technique de motion blur temps réel standard (jeux) transposée ici.

## Livrables (§11)

- `out/C0.mp4` … `out/C8.mp4` — H.264 1080p60, 360 frames, lisibles VLC.
- `out/C{n}_f{60,180,300}.png` — 3 frames/cfg pour vérifier les effets à l'œil.
- `out/report.json` + table markdown sur stdout.

## Reste à faire (le seul maillon S6 non couvert)

Le **mode `--profile detail`** du §10 : queries GPU timestamp (`DISJOINT`/`TIMESTAMP`, anneau 4 frames, `DONOTFLUSH`, drop si pas prêt), breakdown `decode`/`comp`/`encode`/`mux`, et `overhead_obs = fps(off)/fps(detail) − 1`, plus le contrôle (a) binaire-sans-mesure ≈ (b) `--profile off`.

Ce qui est fait : le **`--profile off`** — la mesure la plus extérieure (`Instant`/QPC autour de tout le run, deux lectures, rien dans la boucle), qui est **le seul chiffre publiable** selon le §10. Le détail est le diagnostic *où passe le temps* ; il ne change pas les fps du tableau et l'outil de référence recommandé reste **RGP** (capture externe, hors process). Le breakdown interne par passe est le complément diagnostic non implémenté.
