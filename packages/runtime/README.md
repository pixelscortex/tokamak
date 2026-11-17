# Runtime support

The Rust crate is server-only. Its optional `server` feature re-exports the
server backend, storage, and engine types. The engine still runs server plugins.

The TypeScript package keeps reusable client lifecycle code:

- `@tokamak/runtime/plugins`: `createPluginLoader`, catalog lookup, paged asset
  retrieval, dependency invalidation, and generation retirement.
- `@tokamak/runtime/subscriptions`: the retained-query transport cache.

The loader accepts a `PluginModuleHost` interface. There is no evaluator or web
module host implementation. The next loader agent must connect server-provided
ES modules while preserving shared runtime identities and generation disposal.
The app skeleton does not instantiate this loader.

`tools/local-server.ts` and `tools/run-app.ts` retain independent local server
start, status, and stop operations. They do not launch a desktop client.
The app's disposable development server is separate; see `app/README.md`.
