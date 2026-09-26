# Publier `@argentic/chest-mcp` sur npm

Pour Paul. Le paquet se publie depuis le compte npm `paulwcz`, propriétaire de
l’organisation npm `argentic`, comme `@argentic/chest-sdk` (le `PUBLISHING.md`
du dépôt Chest-SDK détaille la connexion `npm login` et le code 2FA). Trois
temps :

1. **la première version (0.1.0) à la main**, une seule fois : npm ne permet de
   régler la publication de confiance (« trusted publishing ») que sur un
   paquet qui existe déjà ;
2. **brancher GitHub Actions** sur le paquet, sur npmjs.com ;
3. **ensuite, chaque version part d’un tag** `vX.Y.Z`, sans jeton ni mot de
   passe : GitHub prouve à npm que c’est bien `publish-mcp.yml` de ce dépôt
   qui publie, et npm attache au paquet la preuve de provenance.

Aucun jeton npm (`NPM_TOKEN`) n’est créé ni rangé nulle part. Le paquet n’a
aucune dépendance d’exécution ; il livre `dist/*.js`, `README.md`, `LICENSE` et
`package.json`.

## 1. Première publication (0.1.0), à la main

```sh
cd ~/Documents/Chest-by-Argentic/03_code/03_chest-mcp
git switch main
git pull --ff-only
git status          # doit dire : nothing to commit, working tree clean
node -p "require('./package.json').name+'@'+require('./package.json').version"
                    # doit afficher exactement : @argentic/chest-mcp@0.1.0
npm whoami          # doit répondre : paulwcz (sinon : npm login)
npm ci
npm test
npm publish --dry-run --provenance=false   # répétition : 15 fichiers, n’envoie rien
npm publish --access public --provenance=false
```

La répétition doit lister 15 fichiers : `LICENSE`, `README.md`,
`package.json` et les douze modules de `dist/` (`chest.js`, `cli.js`,
`config.js`, `confirm.js`, `results.js`, `rpc.js`, `rules.js`, `schema.js`,
`server.js`, `tools.js`, `untrusted.js`, `version.js`). `npm publish` relance
d’abord les tests et la vérification du paquet (`prepublishOnly`), puis
demande le code 2FA (`Enter OTP:`, ou une page à confirmer dans le
navigateur). `--provenance=false` : la provenance est une attestation signée
par GitHub Actions, impossible depuis un Mac ; les versions suivantes l’auront.
Le terminal finit par `+ @argentic/chest-mcp@0.1.0`. Vérifier :

```sh
npm view @argentic/chest-mcp
npx -y @argentic/chest-mcp   # doit répondre : chest-mcp: CHEST_URL is not set…
```

et la page <https://www.npmjs.com/package/@argentic/chest-mcp>.

## 2. Brancher GitHub Actions

Sur npmjs.com, connecté en `paulwcz` : ouvrir
<https://www.npmjs.com/package/@argentic/chest-mcp> → onglet **Settings** →
section **Trusted Publisher** → **GitHub Actions**, et remplir exactement (la
casse compte) :

- **Organization or user** : `chest-by-argentic`
- **Repository** : `Chest-MCP`
- **Workflow filename** : `publish-mcp.yml` (le nom seul, sans
  `.github/workflows/`)
- **Environment name** : laisser vide
- **Allowed actions**, si la ligne apparaît : cocher la publication directe.

Valider, puis dans **Publishing access** choisir **Require two-factor
authentication and disallow tokens** → **Update Package Settings**.

Ou, en ligne de commande (npm 11.15.0 ou plus) :

```sh
npm trust github @argentic/chest-mcp --file publish-mcp.yml --repo chest-by-argentic/Chest-MCP --allow-publish
```

## 3. Les versions suivantes

1. Dans une PR, changer la version du paquet et celle que le code dit au
   client (`src/version.ts` ; un test vérifie que les deux sont égales) :

   ```sh
   npm version 0.1.1 --no-git-tag-version
   # puis mettre la même version dans src/version.ts
   ```

   Règle : `0.1.x` pour une correction, `0.2.0` pour un ajout ou un changement
   tant qu’on est avant la 1.0.
2. Fusionner la PR (la CI « CI » doit être verte).
3. Poser le tag sur `main` fusionné et le pousser :

   ```sh
   git switch main
   git pull --ff-only
   git tag v0.1.1
   git push origin v0.1.1
   ```

   — ou demander à Claude : « publie la 0.1.1 du serveur MCP ».
4. Suivre sur GitHub : dépôt `chest-by-argentic/Chest-MCP` → onglet
   **Actions** → workflow **Publish MCP**. Il vérifie que le tag est `v` suivi
   de la version de `package.json`, lance les tests et la vérification du
   paquet, puis publie avec provenance.

Un mauvais tag se retire (`git tag -d v0.1.1` puis
`git push origin --delete v0.1.1`) avant de recommencer. Une version publiée ne
se republie jamais sous le même numéro : en cas d’erreur, publier la suivante.
