# Publishing `@argentic/chest-mcp`

For maintainers. Releases are published to npm by GitHub Actions through npm
**trusted publishing** (OIDC): no npm token exists anywhere, and every version
carries a provenance attestation linking it to its commit and workflow. The
package has no runtime dependency; it ships `dist/*.js`, `README.md`,
`LICENSE` and `package.json` (15 files).

Requirements (npm documentation,
[Trusted publishing](https://docs.npmjs.com/trusted-publishers)): npm CLI
11.5.1 or later and Node 22.14.0 or later in the workflow, the
`id-token: write` permission, and `repository.url` in `package.json` matching
this GitHub repository exactly.

## Releasing a version

1. In a pull request, bump the package version and the version the server
   reports to clients (`src/version.ts`; a test checks they are equal):

   ```sh
   npm version 0.1.1 --no-git-tag-version
   # then set the same version in src/version.ts
   ```

   Before 1.0: `0.1.x` for a fix, `0.2.0` for an addition or a change.
2. Merge the pull request once CI is green.
3. Tag the merged `main` and push the tag:

   ```sh
   git switch main
   git pull --ff-only
   git tag v0.1.1
   git push origin v0.1.1
   ```

4. The **Publish MCP** workflow (`.github/workflows/publish-mcp.yml`) checks
   that the tag is `v` followed by the `package.json` version, runs the tests
   and the package check, then publishes with provenance.

A wrong tag is removed (`git tag -d v0.1.1`, then
`git push origin --delete v0.1.1`) before starting again. A published version
is never republished under the same number: publish the next one.

## Trusted publisher settings

On npmjs.com, package **Settings** → **Trusted Publisher** → **GitHub
Actions**:

- Organization or user: `chest-by-argentic`
- Repository: `Chest-MCP`
- Workflow filename: `publish-mcp.yml`
- Environment name: empty

Then, under **Publishing access**, choose **Require two-factor authentication
and disallow tokens**. The same connection can be set from the command line
with npm 11.15.0 or later:

```sh
npm trust github @argentic/chest-mcp --file publish-mcp.yml --repo chest-by-argentic/Chest-MCP --allow-publish
```

Trusted publishing can only be configured on a package that already exists;
the first version was published once by hand, with `--provenance=false`
(provenance can only be generated in CI).
