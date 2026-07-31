Pistes d'amélioration de l'agent d'édition, appuyées sur les mesures du workbench. **Rien à fusionner ici** — cette PR est un document de travail, à traiter plus tard.

Chaque piste porte la mesure qui la justifie et, quand elle existe, la contre-mesure qui la départagera. L'ordre est celui où je les traiterais.

---

## 1. Le poids du track fait échouer un tour sur deux

**Mesuré.** Sur la prise réelle de 66 s, `getCursorTrack` rend 356 points pour **24 238 caractères**. La requête suivante passe à ~45 000 caractères. Sur 5 répétitions du prompt wizard, **3 ont expiré** à 120 s, toujours au même endroit : juste après l'appel à l'outil. Les 2 qui aboutissent produisent un montage correct.

Ce n'est pas un défaut du modèle : lui donner la donnée le fait échouer.

**Pistes, de la moins à la plus intrusive :**

- **Supprimer `virtualSec` quand il est égal à `atSec`.** 28 % du payload, strictement redondant tant qu'aucune coupe n'existe. Un champ `virtualEqualsSource: true` en tête suffirait. Gain immédiat, aucune perte d'information.
- **Relever le timeout du banc.** Ne corrige rien, mais évite de confondre lenteur et refus.
- **Baisser la résolution à 2–3 Hz.** À tester *après* les deux précédentes, jamais avant : ça change ce que le modèle voit, donc on ne saurait plus attribuer une amélioration à la place gagnée ou à la lisibilité.

Le plafond de `buildCursorTrack` est par ailleurs mou : `DEFAULT_MAX_TRACK_POINTS` borne la grille, mais les points gardés pour un changement de forme s'ajoutent par-dessus sans que `truncated` le signale. Ici 356 pour 400, sans conséquence — une capture riche en changements de pointeur dépasserait silencieusement.

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
