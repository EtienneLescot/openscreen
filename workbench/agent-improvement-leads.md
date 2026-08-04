# Pistes d'amélioration de l'agent d'édition

Ce qui reste à faire sur l'agent, appuyé sur les mesures du banc. Chaque piste porte la mesure qui
la justifie et, quand elle existe, la contre-mesure qui la départagera. L'ordre est celui où je les
traiterais.

C'est un document de travail, et il vit ici plutôt que dans `technical-documentation/` pour cette
raison : ce tree-là est de la référence — « describe, don't narrate », pas de plans ni de
changelogs — et une piste est exactement ce qu'il ne veut pas héberger. Ce qui sera tranché ira
dans `technical-documentation/architecture/decisions.md`, la ligne de conduite qui en sort dans
[README.md](README.md).

**Provenance des chiffres.** Sauf renvoi explicite à un test, ils viennent de runs live locaux sur
la prise réelle décrite dans [README.md](README.md) § « La prise réelle ». Ni cette prise ni
`workbench/runs/` ne sont versionnés : ces mesures-là **ne sont pas rejouables** sans fournir sa
propre prise, qui donnera d'autres nombres. Quand une mesure est épinglée par une assertion, le
fichier est cité — c'est la seule forme qui survit à un refactor.

---

## 1. Le tour dure deux minutes, et ce n'est pas la faute du contexte

**Corrigé, et mon diagnostic initial était faux.** J'avais écrit que le track de 24 Ko faisait
échouer trois tours sur cinq. C'était une corrélation — les échecs tombaient juste après l'appel à
l'outil — servie comme une cause. Les durées disent autre chose :

| répétition | durée | verdict |
|---|---|---|
| rep-0 | 117,0 s | réussie, 19 appels |
| rep-2 | 112,5 s | réussie |
| rep-1, 3, 4 | 120,0 s | **timeout du banc** |

Le couperet était posé 3 à 7 secondes au-dessus de la durée normale d'un tour. Ce n'était pas le
modèle qui renonçait, c'était le banc qui mesurait son impatience et l'imputait au modèle. Porté à
300 s (`lib/harness.ts`), et `vitest.workbench.config.ts` importe désormais la même constante au
lieu d'en garder une copie à 120 s qui aurait tué le tour la première.

Une ligne « timeout » sous-compte d'ailleurs ce qui a été joué : `lib/runner.ts` rejoue une
répétition expirée jusqu'à `maxRetries = 2` et jette les tentatives. Trois lignes, c'est jusqu'à
neuf tours réellement partis.

Le contexte n'était de toute façon pas en cause : la requête complète tourne autour de 26 000
caractères, dont ~17 k de message système et de définitions d'outils avant qu'aucune donnée n'y
entre. C'est une estimation, pas une mesure : rien dans le banc ne compte les tokens, et le seul
plafond asserté est large (`l1/real-fixture-turn.wb.ts`).

**Ce qui reste acquis** : le track est passé de 24 238 à **7 797 caractères**, désormais sous le
transcript (10 496) au lieu de 2,3× au-dessus, et de 356 à **148 points sur 1521**. Deux gains —
`virtualSec` retiré des points quand il égale `atSec`, et une réduction en keyframes — dont le
second est sans perte **dans la tolérance** de 0,02 image, pas sans perte tout court : c'est un
budget d'erreur (`DEFAULT_TRACK_EPSILON`), et le test le dit mieux que moi (« lossless *within the
tolerance* »). Ce qui est réellement intouchable, c'est la classe de points que rien ne rejoue :
changement de forme du pointeur, événement autre qu'un déplacement, bornes d'un arrêt.

Une leçon d'implémentation à ne pas reperdre : simplifier la **trajectoire** au lieu des courbes
`x(t)` et `y(t)` semble équivalent et ne l'est pas. Un curseur qui part et revient par le même
chemin ne s'écarte pas de la corde, donc l'aller-retour disparaît et l'interpolation jure ensuite
qu'il n'a pas bougé. Mesuré : **0,380** d'image d'erreur pour une tolérance de 0,02, contre 0,084
par axe. La version fautive était la plus compacte (4,4 Ko) et la plus séduisante.

Elle est maintenant verrouillée : `src/lib/ai-edition/timeline/cursor-track.test.ts` porte un
aller-retour dont l'apex ne survit qu'à la simplification par axe. Vérifié en substituant la
version fautive — les treize autres tests du fichier passent, seul celui-là tombe. C'était le
trou : la leçon ne tenait que dans un commentaire.

Le plafond de `buildCursorTrack` reste **mou**, et le dit maintenant. `DEFAULT_MAX_TRACK_POINTS`
budgète le plancher d'écart et le débit ; les points obligatoires ci-dessus sont exemptés et
s'ajoutent par-dessus. Les faire entrer dans le budget reviendrait à jeter un changement de forme
pour tenir un chiffre, ce que ce track ne doit jamais faire — donc le dépassement est **rapporté**
(`overBudget`, absent quand le budget tient) plutôt qu'évité. Ici 148 pour 400, sans conséquence ;
une capture riche en changements de pointeur le dépasse, et le modèle l'apprend au lieu de le subir.

## 1 bis. Le vrai coût : 19 appels d'outils en série — RECOMMANDATION PRINCIPALE

**Mesuré.** Le tour wizard émet 19 appels : deux lectures de document, un transcript, un track,
puis **six `addTrim` et neuf `addZoom` un par un**. La sérialisation n'est pas qu'une observation
de ce run : `deep-agent/service.ts` la donne pour acquise là où il relève `recursionLimit`, « an
auto-enhance turn spends one step per silence » — un pas de graphe par coupe, donc un aller-retour
par coupe.

Six coupes décidées d'un seul raisonnement, sur des plages connues d'avance, coûtent six
allers-retours. Le propre texte du modèle planifie les six avant d'émettre le premier appel — la
décision est déjà prise, seule l'émission est fragmentée.

Deux précautions de lecture. La surface compte elle aussi **19 outils** (`service.test.ts`) : même
nombre, autre grandeur. Et ce qui coûte du temps, ce sont les **rounds**, que `lib/wire.ts`
distingue des `calls` ; le décompte ci-dessus est en appels. Une piste par lot promet donc « 19
appels → 6 appels », et le gain de latence n'est démontré qu'en citant `wire.rounds`, ce que ce
document ne fait pas encore.

**Pistes :**

- **Des outils par lot.** `addTrims(ranges[])` et `addZooms(regions[])` ramèneraient un tour de 19
  appels à 6. Le raisonnement du modèle n'y perd rien ; trois surfaces sont à refaire autour : le
  rapport de l'outil (une borne refusée sur dix doit se lire sans relire le document), le décompte
  du banc, et `diffMatches` — un outil par lot que ses `ID_KEYS` ignorent éteindrait silencieusement
  le seul check qui vérifie que l'outil ne ment pas sur ce qu'il a fait.
- **Vérifier au banc que le modèle sait s'en servir avant de généraliser.** Un outil par lot est
  plus difficile à appeler correctement qu'un outil unitaire — il faut un tableau bien formé du
  premier coup, là où l'unitaire pardonne une erreur à la fois. C'est exactement ce qu'un scénario
  dédié doit trancher.
- **Ne pas supprimer les outils unitaires.** Une correction ponctuelle (« déplace ce trim », qui
  est `setTrim`) n'a pas à passer par un tableau d'un élément. Et le refus d'un lot entier pour une
  borne fautive n'est pas une hypothèse : `replaceTimeline` est le précédent du dépôt sur « un
  appel, plusieurs coupes », et il refuse en bloc dès qu'un clip serait perdu — « Refused […]
  Nothing was modified ». Un `addTrims` qui hériterait de ce comportement rendrait au modèle six
  coupes annulées pour une borne mal posée.

## 2. Le modèle place ses zooms d'après le transcript, pas d'après la trajectoire

**Observé, pas mesuré par le banc** — et c'est le premier problème. Il appelle bien
`getCursorTrack`. Mais en comparant à la main le `focus` qu'il choisit à la position réelle du
curseur *dans sa propre fenêtre de zoom* : **7 sur 9 sont faux**, trois de plus d'un tiers d'image.
Le pire vise `(0.33, 0.09)` — haut de l'écran — quand le curseur est à `(0.38, 0.60)`.

Aucun oracle ne calcule cet écart. `lib/quality.ts` ne connaît des zooms que leurs secondes, et
l'`EvalContext` n'expose pas la trajectoire aux scénarios : `real-zoom-grounding` a six checks,
dont aucun sur la position. Tant qu'il manque, ce paragraphe est une anecdote et pas une mesure.

Son récit le trahit : il annonce un zoom sur des mots cinq secondes avant qu'ils soient prononcés.
Il raconte une lecture de la trajectoire qu'il n'a pas faite.

Rappel 6/6 zones annotées, mais précision 0,41 — il zoome une large part de la vidéo. Toucher
toutes les zones en arrosant n'est pas de la détection. (Ces deux nombres viennent d'un run non
versionné ; l'oracle qui les produit, lui, vient d'être corrigé — il sommait les secondes de zooms
empilés au dénominateur, ce que `addZoom` autorise en pratique.)

**Pistes :**

- **Écrire l'oracle d'ancrage.** `focusAccuracy(after, samples, zones)` dans `lib/quality.ts`,
  branché sur `real-zoom-grounding`. C'est la contre-mesure de tout ce qui précède : sans elle, on
  ne saura pas si une piste a amélioré quoi que ce soit.
- **Ancrer par le retour d'outil.** `addZoom` pourrait renvoyer la position réelle du curseur sur
  la fenêtre demandée, à côté du `focus` reçu. `options.cursorTelemetry.load` est déjà disponible
  dans `executeAgentTool` : c'est un appel de plus dans la branche `addZoom`, pas un câblage. Le
  modèle apprend l'écart au premier appel, sans qu'on lui impose quoi que ce soit — elle informe au
  lieu de contraindre. Prévoir le cas `available:false` : le retour ne doit pas mentir par omission.
- **La lisibilité n'est plus une excuse.** La piste 1 est faite : le track est à 148 points, pas
  356. Si le modèle ne corrèle toujours pas une fenêtre temporelle à la trajectoire, ce n'est plus
  le bruit.
- **Ne pas ajouter de détecteur.** Servir au modèle une liste de « moments d'intérêt » le
  plafonnerait au rappel de l'heuristique : `src/lib/ai-edition/timeline/zoom-suggestions.ts`
  produit 8 faux positifs sur 16, et rate la zone où l'auteur balaye lentement une image — non
  parce que le curseur y bouge trop, mais parce que le passage dure plus que
  `MAX_DWELL_DURATION_MS` (2,6 s) et sort du plafond. Aucun test ne tient ce 8/16 : il vient du même
  run non versionné.

## 3. `customScale` : ce que le modèle n'apprend qu'à moitié

**Mesuré.** `describe-zooms` est passé de 60 % à 98 % après correction de la **légende**
depth→échelle annoncée au modèle (la table de constantes, elle, n'a pas bougé : elle a été déplacée
à l'identique dans `zoom-scale.ts`). `describe-zooms-migrated` reste à **33 %** — soit exactement
2/6 sur l'axe comportemental si seul `beh.multiplier` échoue, ce qui est son `expectedFailure`
déclarée. Aucun baseline n'est versionné pour ces deux scénarios ; ce serait le premier à figer.

Ce que le modèle sait déjà, contrairement à ce que j'avais écrit : `depthIsOverridden` est bien émis
par le snapshot dès qu'un `customScale` existe, le `zoomNote` l'explique, et la description de
`setZoom` dit mot pour mot que passer `depth` efface le `customScale` — l'exécuteur le fait et le
retour porte `clearedCustomScale`.

**Ce qui manque, une fois l'audit fait.** Le champ atteint deux des quatre surfaces que voit le
modèle :

| surface | porte `depthIsOverridden` |
|---|---|
| snapshot document (`getCurrentDocument`) | oui |
| description d'outil `setZoom` | oui |
| retours d'outil `setZoom` / `addZoom` | **non** |
| message système | **non** |

Le trou est donc précis : une édition de span sur un zoom overridé, sans toucher au `depth`, rend
`{depth: 3, renderedScale: 1.1}` et aucun champ ne nomme l'override. Le modèle lit un `depth` qui ne
rend rien, dans un retour qui a l'air complet.

**Piste.** Ajouter `depthIsOverridden` (ou `customScale`) aux `resultJson` de `setZoom` et
`addZoom`. Accessoirement, la description de `getCurrentDocument` n'annonce ni `renderedScale` ni
`customScale` : le modèle doit deviner que le snapshot les porte.

## 4. Un patron récurrent : l'absence traitée comme un non-événement

Trois occurrences rencontrées en pilotant l'app, sans rapport entre elles :

- Un asset orphelin vidait tout le preview *(corrigé)* — mais le correctif a supprimé le mauvais
  état vide sans ajouter de message : quand toutes les sources échouent vraiment, l'éditeur affiche
  la même invitation à importer une vidéo. L'information existe (`videoError` porte l'assetId) et
  elle est jetée. Le patron s'applique à son propre correctif.
- Le modèle affirmait qu'aucune donnée curseur n'existait, parce qu'il inspectait un système de
  fichiers vide *(corrigé)*. C'est aujourd'hui l'exemple à imiter : `no-sidecar` et `unavailable`
  sont deux réponses distinctes, dites dans le type, dans la description d'outil, dans le message
  système, et épinglées dans les deux sens par les tests.
- Le bouton de transcription, binaire Whisper absent *(corrigé depuis, en deux temps)* : la
  plomberie d'échec a atterri avec la transcription automatique — un toast porte le message. Il
  manquait la trace côté main, `recordError` rangeait le message dans un champ que personne ne lit
  sur ce chemin ; c'est fait. Reste que le texte affiché est un message de développeur (« build it
  via `scripts/build-whisper-stt.sh` »), ce qui n'est pas une réponse pour qui a installé un paquet.
  Et rien ne rejoue « binaire absent » de bout en bout : `whisperServer.test.ts` couvre le modèle
  manquant, pas le binaire.

Le patron mérite d'être nommé quelque part : distinguer « je n'ai pas trouvé » de « il n'y a rien »
est la même discipline côté UI et côté agent. Le track de curseur vient d'en gagner un troisième
exemple, dans l'autre sens — `overBudget` dit « tu en as plus que le plafond », là où `truncated`
disait déjà « tu en as moins que demandé ».

## 5. Le banc : ce qui manque encore

- **Un juge LLM pour l'axe comportemental.** Il repose aujourd'hui sur des regex anglaises, dont
  `lib/language.ts` admet lui-même la fragilité — un `no` a déjà matché dans `cannot`, accusant de
  mensonge une réponse honnête (corrigé depuis, par des frontières de mot). Une réponse en français
  casse la mesure dans les **deux** sens : elle fait passer en silence tous les checks négatifs
  (aucun mensonge détectable) et échouer à tort les six checks qui exigent un match positif. Ce qui
  se calcule doit rester déterministe ; ce qui demande de lire du sens doit passer à un juge, sur
  les tours persistés, avec verdicts conforme / fautif / **indéterminé**.
- **Le surajustement au banc** a maintenant sa règle dans [README.md](README.md) § « Répondre à un
  échec sans surajuster au banc » — c'est là qu'elle sera lue au moment de toucher au prompt.
- **Les fixtures ne sont pas versionnées**, et le coût est plus lourd que « reproduire une mesure
  demande sa propre prise » : **44 tests L0 échouent dans un clone neuf**, tous sur le même
  fichier absent. Le CI ne lance ni le banc ni les e2e, donc rien ne le signale. Voir
  [README.md](README.md) § « La prise réelle ».
- **Les mesures live ne laissent aucune trace versionnée.** `workbench/runs/` et
  `workbench/reports/` sont gitignorés, et trois baselines seulement sont commitées. La moitié des
  chiffres de ce document en dépend. Le premier pas serait de figer les baselines des scénarios de
  la prise réelle (`--update-baseline`), puis de capturer l'`usage` du provider dans le proxy : le
  décompte de tokens qui manque à tout le §1 est déjà dans la réponse que le recorder voit passer.
