Pistes d'amélioration de l'agent d'édition, appuyées sur les mesures du workbench. **Rien à fusionner ici** — cette PR est un document de travail, à traiter plus tard.

Chaque piste porte la mesure qui la justifie et, quand elle existe, la contre-mesure qui la départagera. L'ordre est celui où je les traiterais.

---

## 1. Le tour dure deux minutes, et ce n'est pas la faute du contexte

**Corrigé, et mon diagnostic initial était faux.** J'avais écrit que le track de 24 Ko faisait échouer trois tours sur cinq. C'était une corrélation — les échecs tombaient juste après l'appel à l'outil — servie comme une cause. Les durées disent autre chose :

| répétition | durée | verdict |
|---|---|---|
| rep-0 | 117,0 s | réussie, 19 appels |
| rep-2 | 112,5 s | réussie, 17 appels |
| rep-1, 3, 4 | 120,0 s | **timeout du banc** |

Le couperet était posé 3 à 7 secondes au-dessus de la durée normale d'un tour. Ce n'était pas le modèle qui renonçait, c'était le banc qui mesurait son impatience et l'imputait au modèle. Porté à 300 s.

Le contexte n'était de toute façon pas en cause : le tour entier fait ~26 000 caractères, soit ~6 500 tokens.

**Ce qui reste acquis** : le track est passé de 24 238 à 7 797 caractères, désormais **sous** le transcript (10 496) au lieu de 2,3× au-dessus. Deux gains sans perte d'information — `virtualSec` retiré des points quand il égale `atSec`, et une réduction en keyframes qui garde 148 points sur 1521.

Une leçon d'implémentation à ne pas reperdre : simplifier la **trajectoire** au lieu des courbes `x(t)` et `y(t)` semble équivalent et ne l'est pas. Un curseur qui part et revient par le même chemin ne s'écarte pas de la corde, donc l'aller-retour disparaît et l'interpolation jure ensuite qu'il n'a pas bougé. Mesuré : **0,380** d'image d'erreur pour une tolérance de 0,02, contre 0,084 par axe. La version fautive était la plus compacte (4,4 Ko) et la plus séduisante.

## 1 bis. Le vrai coût : 19 appels d'outils en série — RECOMMANDATION PRINCIPALE

**Mesuré.** Le tour wizard émet 19 appels : deux lectures de document, un transcript, un track, puis **six `addTrim` et neuf `addZoom` un par un**. Chacun est un aller-retour complet vers le provider. C'est là que passent les deux minutes, pas dans la lecture du contexte.

Six coupes décidées d'un seul raisonnement, sur des plages connues d'avance, coûtent six allers-retours. Le propre texte du modèle planifie les six avant d'émettre le premier appel — la décision est déjà prise, seule l'émission est fragmentée.

**Pistes :**

- **Des outils par lot.** `addTrims(ranges[])` et `addZooms(regions[])` ramèneraient un tour de 19 appels à 6. Gain linéaire, sans contrepartie côté raisonnement.
- **Vérifier au banc que le modèle sait s'en servir avant de généraliser.** Un outil par lot est plus difficile à appeler correctement qu'un outil unitaire — il faut un tableau bien formé du premier coup, là où l'unitaire pardonne une erreur à la fois. C'est exactement ce qu'un scénario dédié doit trancher.
- **Ne pas supprimer les outils unitaires.** Une correction ponctuelle (« déplace ce trim ») n'a pas à passer par un tableau d'un élément, et le refus d'un lot entier pour une borne fautive serait une régression.

## 2. Le modèle place ses zooms d'après le transcript, pas d'après la trajectoire

**Mesuré.** Il appelle bien `getCursorTrack`. Mais en comparant le `focus` qu'il choisit à la position réelle du curseur *dans sa propre fenêtre de zoom* : **7 sur 9 sont faux**, trois de plus d'un tiers d'image. Le pire vise `(0.33, 0.09)` — haut de l'écran — quand le curseur est à `(0.38, 0.60)`.

Son récit le trahit : il annonce un zoom sur « Iceman, Views » cinq secondes avant que ces mots soient prononcés. Il raconte une lecture de la trajectoire qu'il n'a pas faite.

Rappel 6/6 zones annotées, mais précision 0,41 — il zoome 38 % de la vidéo. Toucher toutes les zones en arrosant n'est pas de la détection.

**Pistes :**

- **Ancrer par le retour d'outil.** `addZoom` pourrait renvoyer la position réelle du curseur sur la fenêtre demandée, à côté du `focus` reçu. Le modèle apprend l'écart au premier appel, sans qu'on lui impose quoi que ce soit. C'est la piste que je préfère : elle informe au lieu de contraindre.
- **Vérifier la lisibilité avant d'accuser la capacité.** 356 lignes de `{atSec, cx, cy}` sont peut-être trop plates pour qu'il y corrèle une fenêtre temporelle. À tester en réduisant d'abord le bruit (piste 1), pas en changeant la forme.
- **Ne pas ajouter de détecteur.** Servir au modèle une liste de « moments d'intérêt » le plafonnerait au rappel de l'heuristique — mesuré : le détecteur d'immobilité produit 8 faux positifs sur 16 et rate par construction la zone où l'auteur balaye lentement une image.

## 3. `customScale` rend `depth` inopérant en silence

**Mesuré.** `describe-zooms` est passé de 60 % à 98 % après correction de la table depth→échelle. `describe-zooms-migrated` reste à **33 %** : quand un zoom porte un `customScale`, le `depth` ne rend plus rien et aucun champ ne le dit au modèle.

**Piste.** Le snapshot expose déjà `depthIsOverridden`. Reste à vérifier qu'il atteint le modèle dans tous les chemins, et que `setZoom` dit clairement que passer `depth` efface le `customScale`.

## 4. Un patron récurrent : l'absence traitée comme un non-événement

Trois occurrences rencontrées en pilotant l'app, sans rapport entre elles :

- Un asset orphelin vidait tout le preview, sans message *(corrigé)*.
- Le modèle affirmait qu'aucune donnée curseur n'existait, parce qu'il inspectait un système de fichiers vide *(corrigé)*.
- Le bouton de transcription ne produit **rien** quand le binaire Whisper est absent : ni message, ni état d'échec, ni une ligne de log *(non corrigé)*.

Le troisième mérite un correctif, et le patron mérite d'être nommé quelque part : distinguer « je n'ai pas trouvé » de « il n'y a rien » est la même discipline côté UI et côté agent.

## 5. Le banc : ce qui manque encore

- **Un juge LLM pour l'axe comportemental.** Il repose aujourd'hui sur des regex anglaises, dont le module admet lui-même la fragilité — un `no` a déjà matché dans `cannot`, accusant de mensonge une réponse honnête. Et « pas de signal » compte comme une réussite, donc une réponse en français passerait au vert sans rien vérifier. Ce qui se calcule doit rester déterministe ; ce qui demande de lire du sens doit passer à un juge, sur les tours persistés, avec verdicts conforme / fautif / **indéterminé**.
- **Le surajustement au banc.** Chaque échec mesuré donne envie d'ajouter une ligne de prompt qui règle ce cas précis. Fait huit fois, le prompt devient la liste des réponses au jeu de tests. Garde-fou proposé : un correctif n'est acceptable que s'il se justifie *sans* mentionner le scénario qui l'a révélé.
- **Les fixtures ne sont pas versionnées** (enregistrements réels, voix transcrite). Reproduire une mesure demande de fournir sa propre prise — voir `workbench/fixtures/README.md`.
