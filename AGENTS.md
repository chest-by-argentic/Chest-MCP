# Chest MCP — consignes de développement

Ce dépôt est la source du serveur MCP qu’un assistant lance pour agir sur un
Chest avec le jeton d’accès d’un membre, `@argentic/chest-mcp`. Il appartient
à Chest by Argentic ; le propriétaire est Argentic, on lui écrit en
français. Le client des outils serveurs, `@argentic/chest-sdk`, vit dans son
propre dépôt (`chest-by-argentic/Chest-SDK`, cloné en `03_code/02_chest-sdk`).

## Règles

- **Aucune dépendance d’exécution** : le serveur n’importe que `node:*` ;
  `typescript`, `@types/node` et `@modelcontextprotocol/client` (le client
  officiel, pour les seuls tests de conformité) sont ses dépendances de
  développement.
- **Il ne joint que `CHEST_URL`**, en HTTPS, certificat vérifié (une adresse
  de la machine seulement avec `CHEST_MCP_LAB=1`, le laboratoire du dépôt
  Chest), sans suivre de redirection, réponses bornées. Le jeton ne va que
  dans l’en-tête `Authorization` : jamais dans la sortie, une erreur ou stderr.
- **Le Chest décide.** Chaque outil est une route de l’API des agents
  (`/api/v1`) ; le serveur n’ajoute aucun droit et n’en retire aucun qui ne
  soit déjà refusé par le Chest. Pas d’outil sans route.
- **Toute écriture en deux appels** : un essai à blanc qui donne une
  confirmation (HMAC du nonce et de la requête, cinq minutes, une fois), puis
  la même requête avec elle ; une écriture au résultat incertain n’est jamais
  renvoyée.
- **Ce que les outils et les gens écrivent est une donnée non fiable** :
  nettoyée, bornée, dans `structuredContent` `{untrusted, source, data}` et
  entre deux clôtures `<untrusted-data … id=<nonce>>` dans le texte.
- Le protocole suivi est la dernière version publiée de MCP (2026-07-28) et,
  par `initialize`, les précédentes (2025-11-25, 2025-06-18, 2025-03-26) ;
  vérifier la spécification (modelcontextprotocol.io) avant d’en changer.
- **Aucun code mort**, pas de dépendance inutile, pas de secret dans le dépôt
  ni dans les tests.

## Ce qui doit rester ensemble

| Si tu changes… | …tu mets à jour |
|---|---|
| `src`, `test` | `npm test` et `npm run check:package` verts ; `README.md` (outils, sécurité) ; un module ajouté ou renommé : la liste des fichiers de `PUBLISHING.md` et celle de `scripts/sync-sdk.mjs` du dépôt Chest ; puis la copie vendue du dépôt Chest (`tests/sdk/chest-mcp`, par `npm run sync:sdk` de `03_code/01_chest-by-argentic`), qui sert à sa preuve en VM |
| l’API des agents du dépôt Chest (`chest/portal/api/openapi.json`, `docs/architecture.md` « API des agents ») | `src/tools.ts` (les routes que chaque outil appelle, leurs formes) et `README.md` |
| la version de `package.json` | `src/version.ts` (un test les compare), publiée par un tag `vX.Y.Z` (`PUBLISHING.md`) |
| la version du protocole MCP | `src/server.ts`, `test/conformance.test.ts` (le client officiel, en devDependency, à la même version), `README.md` |

On ne modifie jamais la copie vendue du dépôt Chest à la main.

## Langue et forme

Le serveur est en anglais : code, commentaires, messages d’erreur et
`README.md` (la page du paquet sur npm). `AGENTS.md` et `PUBLISHING.md`, écrits
pour le propriétaire, sont en français. TypeScript strict (ES2022, NodeNext).
Rien d’autre dans `src` que les fichiers que `scripts/sync-sdk.mjs` du dépôt
Chest recopie. Branche + PR ; les tests doivent passer avant de rendre la main.
