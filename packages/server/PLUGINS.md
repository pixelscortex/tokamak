# Native plugin installation (M1.2)

The server can load a directory of built plugin projects, or directories
containing their artifacts. This is a trusted personal-plugin system, not a
malicious-code sandbox.

## Build and run

Declare static metadata through `definePlugin` (or pass its descriptor to
`tokamak({ plugin: ..., ui: false })` in `vite.config.ts`). The maintained
Vite/Solid compiler and SDK builder generate `dist/manifest.json`, code, maps
and typed API references. Do not author the artifact manifest by hand.

```sh
proto run bun -- packages/build/src/build.ts path/to/plugins/notes
cargo build --locked -p server --bin tokamak-server --jobs 2
target/debug/tokamak-server --plugins path/to/plugins --local-dir path/to/private-server
```

The local directory requires the same private `server.token` as the desktop
launcher. Never pass the token in arguments. The launcher now uses the workspace `plugins/` installation, including Chat.
`--plugins` and legacy `--bundle` are mutually exclusive.

```sh
TOKAMAK_SERVER_DIR=path/to/private-server proto run bun -- run --silent tokamak plugin list --json
TOKAMAK_SERVER_DIR=path/to/private-server proto run bun -- run tokamak plugin add path/to/plugins/notes
TOKAMAK_SERVER_DIR=path/to/private-server proto run bun -- run tokamak plugin reload acme.notes
```

The control CLI validates loopback discovery, uses bearer authentication, disables
proxies and redirects, and does not replay requests. Control endpoints are only
registered in capability-protected local mode:

- `GET /plugins`: live manifest/function metadata and generation revision.
- `POST /plugin-index/reload`: validate and load the selected indexed builds and optionally apply index removals.
- `POST /plugins/{id}/reload`: validate and reload the configured installation.
- `GET /plugins/{id}/{build-id}/assets/{name}`: declared UI files from that verified build.
  Use the plugin's `revision` field for its build id. The catalog revision is for paging.
  Never arbitrary files, backend source, capability tokens or generated backend API.

## Loading and reload contract

Static validation resolves one version per ID, host API compatibility, required
and present optional dependencies, conflicts and cycles **before evaluating any
module**. Rust's maintained `semver` implements range semantics. A `depends`
target must exist; an absent `optional` target is fine, but a present incompatible
version is an error.

Tokamak has **no product limits**: installed plugins, dependencies, contributions,
capabilities, labels and artifact totals have no count or size quotas. Large
catalogs are paged and large UI assets are streamed, rather than refused.

Artifact SHA-256 hashes detect incomplete builds. Paths and asset symlinks cannot
escape the artifact directory. Declared files are hashed/copied with a 64 KiB
buffer into private temporary files, owned by the immutable generation and deleted
when its last reference retires. Snapshots consume disk rather than retaining all
artifact bytes or open file descriptors in RAM. HTTP UI downloads stream 64 KiB
chunks; native/WebSocket UI downloads use UTF-8-safe pages of at most 8 KiB.
Neither transfer has a total-size ceiling. These are corruption/mixed-build
checks, not signatures. The build id hashes the complete manifest, with no 128 KiB manifest limit. Catalog JSON is serialized once per generation and served
in 8 KiB pages, with no aggregate catalog ceiling. Metadata and evaluated modules
still require memory proportional to their contents; there is no fixed RSS promise.

**Backend engineering exception:** QuickJS must compile the whole backend module;
its API cannot stream compilation across independent chunks. Source maps likewise
build a complete in-memory index. Backend code and its source map each have a
512 MiB input safety bound, with a diagnostic explaining how to split the backend
into plugins. Other declared files (including backend API declarations and all UI
assets) have no per-file bound. The engine's configurable per-invocation heap and
time budgets still apply (`--heap-bytes`, `--load-ms`, `--call-ms`); large backends
may require raising them. Streaming UI transport does not make JavaScript
compilation itself incremental in the desktop engine. Desktop windows have no
fixed heap quota; the former 64 MiB window ceiling does not limit UI bundles.

Reload is serialized with admitted calls: old calls finish their commit/rollback
first. The full candidate installation resolves and is inspected before one
generation swap. Changed workers must start and import their bundles in temporary
working directories before the server commits grants and schemas. A failed index
backfill for an active plugin or a failed readiness check for its replacement
leaves the active catalog, workers, subscriptions and data in place. A successful
reload cancels only actions from retired builds and re-runs existing subscriptions
when builds change. Removed or changed-kind queries produce subscription errors
on the same id. The named ID must be present in the old or new installation.

A unique index backfill that finds duplicate rows at startup skips that plugin
and its required dependents. Every reload retries skipped plugins, even if their
builds are unchanged. The reload result lists any that still fail under
`skipped`, including artifact verification failures that can be traced to a
known skipped plugin. Verification errors for active or unidentified plugins
still refuse the reload. A reload also refuses to remove a still-installed active
plugin that requires a skipped plugin. Recovered plugins and their required
dependents rejoin the catalog in the same reload. Catalog order and revision
depend only on the active builds. A change to the catalog revision notifies
windows even if none of their views need to remount. Changing only an index
declaration changes the server bundle hash and therefore the plugin's build id.
On Unix, unchanged files reuse verified snapshots only when canonical path,
device/inode, size, mtime and ctime still match. Changed files are rehashed, so an
unchanged manifest cannot conceal an in-place write or atomic replacement.
Platforms without reliable change/identity metadata conservatively rehash all
files. This fast path trusts local filesystem metadata, not hostile build tools
with kernel-level ability to forge ctime. Unchanged parsed backend bundles, inspection results
and already validated permission grants are reused. Dependency ordering uses an
iterative graph walk, avoiding native stack depth proportional to plugin count.
Discovery's `bundleHash` identifies startup; `/plugins` reports the live revision.
Legacy `Server::descriptor()` is a startup snapshot; use `Server::plugins()` for
ordered live plugin metadata.

### Known reload limits

- The readiness check starts each changed worker in a temporary working folder
  and checks that the bundle imports and answers. It catches syntax errors,
  missing imports, and code that throws during import. A worker can still fail
  on its first real call if its import sees different files or settings in its
  real working folder.
- The readiness check runs the plugin's top-level code. Plugins are trusted,
  so that code runs without a sandbox. Writes to files or calls to outside
  services during import can happen even if the reload is refused. Keep side
  effects out of import time.

## Calls, data ownership and capabilities

Generated API references for explicitly declared plugins carry names such as
`acme.notes/notes:list`; references never import server handlers into the client.
Inside a handler, `ctx.use(otherApi).notes.list({})` invokes the host. A caller
must declare the target as a dependency, or consume an interface it provides.
Declare `exports: "./api.ts"` and re-export public backend definitions from that
module. The build records their backend names in the artifact; undeclared functions
are private to other plugins. Omitting `exports` exposes nothing. This check also
applies to calls through provider references; own calls and client calls are unchanged.
`ctx.providers<ProviderApi>("interface")` enumerates all matching installed
implementations, whose references can then be bound with `ctx.use`.

Every callee gets its own namespace and host-owned identity. Nested mutations
share the outer database transaction; all writes commit together or none do.
Native failures poison the whole transaction even if plugin code catches them.
Queries cannot call mutations, including queries invoked within a mutation.
Read dependencies accumulate transitively for subscription invalidation.

Backend queries and mutations fix one host timestamp and random seed per logical
invocation, before any conflict retries. `Date.now()`, `new Date()` and `Date()`
use that time; explicit date arguments still work. `Math.random()` uses a seeded
PRNG. Retries reuse both inputs, and nested calls share the timestamp with random
streams derived deterministically from their call order. The UI runtime keeps its
live clock and randomness. Clock-dependent queries do not automatically refresh
as time passes; subscriptions rerun when their data dependencies change.

Delegation evaluates self-contained modules in the same invocation world, heap
and time budget; it never awaits a second worker from a bounded worker pool.
One-worker operation is tested. Results cross as JSON-compatible values, not
JavaScript capabilities. Call-path cycles fail; engine limits also cap delegation
at 16 levels / 256 calls per root invocation. This shares a JS realm between
trusted plugins and is not a realm-isolation security guarantee.

Own-space data access is implicit. Foreign-space data access is denied; public
plugin APIs are the mediation boundary. Interface/dependency declarations mediate
calls. Declared capabilities are auto-granted and logged once per plugin version,
with records in the reserved `tokamak.host` namespace. Changing permissions
requires a version bump; the system does not silently extend an existing grant.
No user plugin can install as `tokamak.host`.
Grant records use deterministic native record keys, so version lookup does not
scan the ledger or execute SurrealQL predicates. The internal keyed CREATE is
not an upsert and is not exposed through the JavaScript database API.

**Network access belongs to actions only.** A `net:<host>` declaration is an
exact-host grant for `fetch` inside `action` functions; there is no `net:*`
wildcard (see `packages/engine/WEB_APIS.md`). Actions run on a separate worker
lane and reach data only through `ctx.runQuery` / `ctx.runMutation`, which apply
the same dependency, interface and export checks as nested calls. Queries and
mutations cannot call actions or `fetch`, so they gain no external effects that
could repeat during transaction retries. Reload cancels actions belonging to changed or removed plugin builds.
An action result is one wire response under the same inclusive 1 MiB limit: an
oversized result fails only that call. No Node/Bun runtime, plugin grant prompt,
marketplace, signing, Wasm or untrusted sandbox ships here.

## Evidence

`cargo test --locked -p server --test plugins --jobs 2` builds real SDK plugins
through the public artifact command. It tests one-worker nested calls, atomic
rollback after caught callee failure, scoped IDs, query-to-mutation denial, call
cycles, two interface providers, transitive subscriptions, edited-code reload,
failed-reload preservation, permission-change rejection and subscription refresh.
It also runs the real standalone binary/control CLI against isolated disk storage,
checking authentication, Origin rejection and backend-source non-exposure.

`plugins::tests` covers static resolver failures, traversal/symlink/hash checks
and immutable UI snapshots. Engine module tests cover shared-worker delegation
and caught/abandoned child error observation. These are self-authored tests,
not an independent review or proof of hybrid sync/long-running AI.

The connected UI session also exposes `plugins` and revision-checked,
UTF-8-chunked `pluginasset` requests. Successful generation swaps emit
`pluginchanged` with the new catalog before refreshing existing subscriptions.
See [the client host contract](../runtime/PLUGINS.md) for the wire shape and lazy
module lifecycle. The authenticated HTTP asset/control endpoints remain usable.

### Action environment grants

An installed plugin action can call `await ctx.env("NAME")` only with the exact
`env:NAME` permission in its manifest. An undeclared read is refused; a declared
but unset value returns `null`. Queries and mutations have no environment API.
The host resolves its process environment first, then `.env.local` beside the
installation directory (for the workspace `plugins/`, this is the workspace
root). Local values are read without changing the process environment or adding
secrets to catalog metadata. Malformed dotenv errors never include file contents.
Changing permissions on an installed plugin requires a version bump as usual.
