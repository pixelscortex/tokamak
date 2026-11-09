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
