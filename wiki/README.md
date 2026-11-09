# wiki

The Tokamak docs site: a landing page, the docs, and the SDK API reference.
It is a [Fumapress](https://press.fumadocs.dev) app (Fumadocs on Waku and Vite)
and builds to plain static files.

## Development

From the repo root:

```sh
moon run wiki:dev     # dev server: landing at /, docs at /docs
moon run wiki:build   # static site in wiki/dist/public
```

## Content sources

Edit package documentation beside its code, not in the wiki. Before dev or
build, `scripts/sync-content.mjs` combines authored pages in `content/docs` with
the original Markdown files listed in `content-sources.mjs`, adding frontmatter
only to the generated copies in gitignored `.generated/docs`. Fumapress reads
that folder. The Vite plugin updates changed files during development, including
optional docs added or removed when switching branches.

`packages/server/HOW_IT_WORKS.md` is the second sidebar page. Runtime plugins and
engine web APIs appear only when their optional source files exist. Required
sources fail clearly if missing; stale generated pages are removed. To add a
package doc, add its source path, destination page and metadata to the mapping,
then place it in the appropriate sidebar metadata. `remark-source-links.ts`
resolves relative Markdown links beside the original file: included docs link
to site routes, and other files link to GitHub on `dev`.

The SDK reference still reads declarations directly from `packages/sdk` at
build time; the landing page and search use the existing Fumapress setup.

## Toolchains

Moon runs the scripts through the repository's pinned Bun. The Fumapress CLI
runs through `proto run node`, pinned to Node 24.21.0 in `wiki/.prototools`.
Bun cannot run the complete build: `fumadocs-typescript`'s native TypeScript
bridge accesses Node's `child.stdout._handle.fd`, which Bun does not provide.
Node 24 also avoids the Node 26 dev-search compatibility issue noted in the pin.

The wiki checker uses the repository's TypeScript 5.9.3. Separately,
`fumadocs-typescript@5.6.0` declares its own exact `typescript@7.1.0-beta`
dependency and imports `typescript/sync` and `typescript/fs`. It uses that
native compiler's API, rather than the removed classic JavaScript compiler API;
changing the wiki checker does not replace the reference generator's compiler.

```sh
bun test wiki/scripts/content.test.ts  # source lifecycle and link resolution
```
